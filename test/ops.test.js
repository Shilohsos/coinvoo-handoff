// Phase 6 — ops hardening: snapshot sync + staleness, backup on by default, alert calibration, click smoke.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp, makeSnapshot, testEnv, captureLogs, seedDashFixture, syncOpens } from './helpers.js';
import { loadConfig, DEFAULT_BACKUP_DIR } from '../src/config.js';
import { loadReportConfig } from '../src/report.js';
import { runAlerts } from '../src/alerts.js';
import { createWorker } from '../src/worker.js';
import { fmtAge } from '../src/botdb.js';
import { openDb, migrate } from '../src/db.js';
import { createApp } from '../src/server.js';

const run = promisify(execFile);
const H = 3600 * 1000;
const MIN = 60000;
const AT_0305 = Date.parse('2026-11-15T02:05:00Z'); // 03:05 Lagos
const ALERT_ENV = { REPORT_BOT_TOKEN: '111222:FAKE_TOKEN_FOR_TESTS_ONLY', ALERT_CHAT_ID: '-1002222' };
const SYNC = new URL('../ops/sync-botdb.sh', import.meta.url).pathname;
const SMOKE = new URL('../ops/click-smoke.sh', import.meta.url).pathname;
const tmp = (p) => mkdtempSync(join(tmpdir(), p));

function fakeTelegram() {
  const texts = [];
  const fetchImpl = async (url, init) => { texts.push(JSON.parse(init.body).text); return new Response('{"ok":true,"result":{"message_id":1}}'); };
  return { fetchImpl, texts };
}

// A worker whose only live alert inputs are the database and the snapshot: disk and memory are pinned healthy.
async function alertApp(env = {}, { now = Date.now(), snap = null } = {}) {
  const clock = { now };
  const tg = fakeTelegram();
  const app = await startApp({ BOTDB_SNAPSHOT: snap ? snap.path : '/nonexistent/botdb-snapshot.db', ...env }, { now: () => clock.now, fetchImpl: tg.fetchImpl });
  app.deps.reportConfig = Object.assign({}, loadReportConfig({ ...ALERT_ENV, ...env }), { retryDelayMs: 0 });
  app.deps.diskFreePct = () => 50;
  app.deps.rssMb = () => 100;
  const worker = createWorker(app.deps);
  const tick = async () => { await worker.tick(); await worker.flush(); };
  const health = async () => (await fetch(`${app.base}/api/aff/health`)).json();
  return { app, clock, tg, worker, tick, health };
}

// ---------- Part 2: snapshot staleness ----------

test('fmtAge: minutes, hours, days', () => {
  assert.deepEqual([0, 59, 60, 47 * 60, 3600, 3 * 3600 + 12 * 60, 47 * 3600 + 59 * 60, 50 * 3600, 48 * 3600].map(fmtAge),
    ['under 1 min', 'under 1 min', '1 min', '47 min', '1 h', '3 h 12 min', '47 h 59 min', '2 d 2 h', '2 d']);
  assert.equal(fmtAge(null), 'unknown');
});

test('health: snapshot { rows, synced_at, age_s, stale }; the other fields are unchanged', async () => {
  const synced = Date.parse('2026-11-16T10:00:00Z');
  const snap = makeSnapshot([{ telegram_id: 1, iq_user_id: '197000001' }, { telegram_id: 2, iq_user_id: '197000002' }, { telegram_id: 3, iq_user_id: '197000003' }], new Date(synced).toISOString());
  const { app, clock, health } = await alertApp({}, { now: synced + 5 * MIN, snap });
  try {
    const h = await health();
    assert.deepEqual(Object.keys(h), ['ok', 'service', 'version', 'db', 'uptime_s', 'last_event_at', 'worker_last_run_at', 'snapshot',
      'snapshot_age_s', 'snapshot_stale', 'backup_enabled', 'backup_age_s', 'postback_key']); // Phase 7 Parts B and C; postback_key: Phase 10
    assert.deepEqual(h.postback_key, { set: false, enforced: false, ok: 0, missing: 0, bad: 0, last_refused_at: null });
    assert.deepEqual(h.snapshot, { rows: 3, synced_at: synced, age_s: 300, stale: false });
    clock.now = synced + 30 * MIN;
    assert.equal((await health()).snapshot.stale, false, 'exactly 30 min is not above the threshold');
    clock.now = synced + 31 * MIN;
    assert.deepEqual((await health()).snapshot, { rows: 3, synced_at: synced, age_s: 1860, stale: true });
  } finally { await app.close(); snap.cleanup(); }
});

test('health: SNAPSHOT_STALE_MINUTES moves the threshold (env only)', async () => {
  const synced = Date.parse('2026-11-16T10:00:00Z');
  const snap = makeSnapshot([{ telegram_id: 1, iq_user_id: '197000001' }], new Date(synced).toISOString());
  const { app, health } = await alertApp({ SNAPSHOT_STALE_MINUTES: '90' }, { now: synced + 60 * MIN, snap });
  try {
    assert.equal(loadConfig(testEnv()).snapshotStaleMinutes, 30, 'default');
    assert.deepEqual((await health()).snapshot, { rows: 1, synced_at: synced, age_s: 3600, stale: false });
  } finally { await app.close(); snap.cleanup(); }
});

test('health: a missing snapshot is stale; after a rename the age keeps counting from the last sync seen', async () => {
  const synced = Date.parse('2026-11-16T10:00:00Z');
  const snap = makeSnapshot([{ telegram_id: 1, iq_user_id: '197000001' }], new Date(synced).toISOString());
  const { app, clock, health } = await alertApp({}, { now: synced + 2 * MIN, snap });
  try {
    assert.equal((await health()).snapshot.stale, false);
    renameSync(snap.path, `${snap.path}.away`);
    clock.now = synced + 3 * MIN;
    assert.deepEqual((await health()).snapshot, { rows: null, synced_at: synced, age_s: 180, stale: true });
  } finally { await app.close(); snap.cleanup(); }
  const never = await alertApp();
  try {
    assert.deepEqual((await never.health()).snapshot, { rows: null, synced_at: null, age_s: null, stale: true });
  } finally { await never.app.close(); }
});

test('snapshot alert: rename -> stale and ONE alert; restore -> cleared once, never a second firing', async () => {
  const synced = Date.parse('2026-11-16T10:00:00Z');
  const snap = makeSnapshot([{ telegram_id: 1, iq_user_id: '197000001' }], new Date(synced).toISOString());
  const { app, clock, tg, tick, health } = await alertApp({}, { now: synced + 5 * MIN, snap });
  try {
    await tick();
    assert.deepEqual(tg.texts, [], 'fresh: nothing to say');
    renameSync(snap.path, `${snap.path}.away`);
    for (let i = 1; i <= 5; i++) { clock.now += MIN; await tick(); }
    assert.equal((await health()).snapshot.stale, true);
    assert.deepEqual(tg.texts, ['COINVOO — bot snapshot unavailable, last sync 6 min ago (threshold 30 min)'], 'five ticks, one alert');
    renameSync(`${snap.path}.away`, snap.path);
    for (let i = 1; i <= 5; i++) { clock.now += MIN; await tick(); }
    assert.equal((await health()).snapshot.stale, false);
    assert.deepEqual(tg.texts, ['COINVOO — bot snapshot unavailable, last sync 6 min ago (threshold 30 min)', 'COINVOO — bot snapshot cleared']);
    assert.equal(tg.texts.filter((t) => !t.endsWith('cleared')).length, 1, 'one alert; the recovery notice is not a second alert');
  } finally { await app.close(); snap.cleanup(); }
});

test('snapshot alert: an old synced_at fires with the age and the threshold', async () => {
  const synced = Date.parse('2026-11-16T10:00:00Z');
  const snap = makeSnapshot([{ telegram_id: 1, iq_user_id: '197000001' }], new Date(synced).toISOString());
  const { app, clock, tg, tick } = await alertApp({}, { now: synced + 30 * MIN, snap });
  try {
    await tick();
    clock.now = synced + 45 * MIN;
    await tick();
    clock.now = synced + 3 * H;
    await tick();
    // Phase 7 Part B2: while still stale, a reminder goes out at most once an hour
    assert.deepEqual(tg.texts, ['COINVOO — bot snapshot 45 min old (threshold 30 min)', 'COINVOO — bot snapshot 3 h old (threshold 30 min) — still firing']);
  } finally { await app.close(); snap.cleanup(); }
});

test('Overview strip: shown on the Overview only, only while stale, naming the age', async () => {
  const synced = Date.parse('2026-11-16T10:00:00Z');
  const snap = makeSnapshot([{ telegram_id: 1, iq_user_id: '197000001' }], new Date(synced).toISOString());
  const { app, clock } = await alertApp({}, { now: synced + 5 * MIN, snap });
  const page = async (p) => (await fetch(`${app.base}${p}`, { headers: { authorization: app.auth } })).text();
  const SCREENS = ['/dash/members', '/dash/events', '/dash/campaigns', '/dash/links'];
  try {
    assert.ok(!(await page('/dash')).includes('data-snapshot-stale'), 'fresh: no strip');
    clock.now = synced + 3 * H + 12 * MIN;
    const ov = await page('/dash');
    // Phase 11: a warning banner; the marker sits on the text itself.
    assert.match(ov, /<div class="banner warn">[\s\S]{0,600}?<span data-snapshot-stale="1">Bot snapshot is 3 h 12 min old \(limit 30 min\)\./);
    for (const p of SCREENS) assert.ok(!(await page(p)).includes('data-snapshot-stale'), p);
    renameSync(snap.path, `${snap.path}.away`);
    assert.match(await page('/dash'), /data-snapshot-stale="1">Bot snapshot unavailable — last sync 3 h 12 min ago\./);
    renameSync(`${snap.path}.away`, snap.path);
    clock.now = synced + 10 * MIN;
    assert.ok(!(await page('/dash')).includes('data-snapshot-stale'), 'restored: the strip clears');
  } finally { await app.close(); snap.cleanup(); }
});

// ---------- Part 3: backup on by default ----------

test('config: BACKUP_DIR defaults to /srv/coinvoo/backups (Phase 7), BACKUP_KEEP to 14; only "off" disables', () => {
  const env = testEnv();
  delete env.BACKUP_DIR;
  const c = loadConfig(env);
  assert.equal(c.backupDir, '/srv/coinvoo/backups');
  assert.equal(DEFAULT_BACKUP_DIR, '/srv/coinvoo/backups');
  assert.equal(c.backupKeep, 14);
  assert.equal(loadConfig(testEnv({ BACKUP_DIR: 'off' })).backupDir, null);
  assert.equal(loadConfig(testEnv({ BACKUP_DIR: ' /srv/bk ' })).backupDir, '/srv/bk');
});

test('backup: the scheduled run writes one self-contained dump (journal_mode delete, no .part left) with the same rows', async () => {
  const dir = tmp('coinvoo-bk6-');
  const target = join(dir, 'missing', 'coinvoo'); // created on demand
  const { app, worker, tick } = await alertApp({ BACKUP_DIR: target }, { now: AT_0305 });
  try {
    seedDashFixture(app.db, AT_0305);
    syncOpens(app.db);
    const lines = await captureLogs(async () => { worker.start(); worker.stop(); await tick(); });
    assert.ok(lines.includes(`[coinvoo] backup enabled dir=${target} keep=14`), lines.join('|'));
    assert.deepEqual(readdirSync(target), ['coinvoo-2026-11-15.db']);
    const file = join(target, 'coinvoo-2026-11-15.db');
    const line = lines.find((l) => l.startsWith('[coinvoo] backup file='));
    assert.equal(line, `[coinvoo] backup file=coinvoo-2026-11-15.db bytes=${statSync(file).size} kept=1 removed=0`);
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(copy.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
      assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      for (const t of ['members', 'events', 'clicks']) {
        assert.equal(copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, app.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, t);
      }
      assert.deepEqual([6, 9, 3], ['members', 'events', 'clicks'].map((t) => copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n));
    } finally { copy.close(); }
    assert.ok(!existsSync(`${file}-wal`) && !existsSync(`${file}.part`));
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('backup: a directory that cannot be written is logged at boot AND alerted once; fixed -> next backup clears it', async () => {
  const dir = tmp('coinvoo-bk6-');
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'a file where a directory should be');
  const target = join(blocker, 'coinvoo');
  const { app, clock, tg, worker, tick } = await alertApp({ BACKUP_DIR: target }, { now: AT_0305 - 2 * H });
  app.deps.snapshotHealth = () => ({ rows: 1, synced_at: clock.now, age_s: 0, stale: false, available: true });
  try {
    const boot = await captureLogs(async () => { worker.start(); worker.stop(); });
    assert.ok(boot.some((l) => l.startsWith('[coinvoo] ERROR backup: Error: ENOTDIR')), boot.join('|'));
    assert.ok(!boot.some((l) => l.startsWith('[coinvoo] backup enabled')));
    await tick();
    assert.equal(tg.texts.length, 1);
    assert.match(tg.texts[0], /^COINVOO — backup failing: ENOTDIR: not a directory, mkdir '.+\/blocker\/coinvoo' \(threshold: any failure\)$/);
    clock.now = AT_0305; // the scheduled run fails too: logged, no second alert
    const night = await captureLogs(tick);
    assert.ok(night.some((l) => l.startsWith('[coinvoo] ERROR backup:')));
    await tick();
    assert.equal(tg.texts.length, 1, 'still one alert');
    rmSync(blocker); // the operator fixes it
    clock.now = AT_0305 + 24 * H;
    await tick(); await tick();
    assert.deepEqual(readdirSync(target), ['coinvoo-2026-11-16.db']);
    assert.deepEqual(tg.texts.slice(1), ['COINVOO — backup cleared']);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ---------- Part 4: thresholds from env only ----------

test('thresholds: PARKED_ALERT_PCT 50 and POSTBACK_SILENCE_HOURS 6 by default; env changes them, no code edit', async () => {
  const d = loadReportConfig({});
  assert.equal(d.parkedPct, 50);
  assert.equal(d.silenceHours, 6);
  const BASE = Date.parse('2026-11-15T10:00:00Z');
  const scenario = async (env) => {
    const sent = [];
    const app = await startApp({}, { now: () => BASE, fetchImpl: async (u, init) => { sent.push(JSON.parse(init.body).text); return new Response('{"ok":true,"result":{"message_id":1}}'); } });
    try {
      const ev = app.db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, forward_state)
                                 VALUES (?, 1, 'affstore', 'dep', 'dep', '197000001', 10, 'USD', '{}', ?, ?, 'sent')`);
      // 7 h of silence after a 24 h with 6 parked of 10 decided (60 %), while links are being opened
      for (let i = 0; i < 6; i++) ev.run(`p${i}`, BASE - 7 * H, 'parked');
      for (let i = 0; i < 4; i++) ev.run(`m${i}`, BASE - 8 * H, 'matched');
      app.db.prepare("INSERT INTO clicks (click_id, brand_id, campaign, created_at, clicked_at) VALUES ('CK00000001', 1, 'C', ?, ?)").run(BASE - H, BASE - H);
      syncOpens(app.db);
      await runAlerts(app.deps, Object.assign({}, loadReportConfig({ ...ALERT_ENV, ...env }), { retryDelayMs: 0 }), {});
      return sent;
    } finally { await app.close(); }
  };
  assert.deepEqual(await scenario({}), [
    'COINVOO — no postbacks for 7 h (last: 04:00; threshold 6 h)',
    'COINVOO — 60% of events unmatched in the last 24 h (6 of 10; threshold 50%)'
  ]);
  assert.deepEqual(await scenario({ POSTBACK_SILENCE_HOURS: '8', PARKED_ALERT_PCT: '65' }), [], 'raised by env: both quiet');
  assert.deepEqual(await scenario({ POSTBACK_SILENCE_HOURS: '3', PARKED_ALERT_PCT: '55' }), [
    'COINVOO — no postbacks for 7 h (last: 04:00; threshold 3 h)',
    'COINVOO — 60% of events unmatched in the last 24 h (6 of 10; threshold 55%)'
  ]);
});

// ---------- Part 1: ops/sync-botdb.sh ----------

function botDb(dir, n) {
  const path = join(dir, 'iqbot.db');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL;
           CREATE TABLE user_accounts (id INTEGER PRIMARY KEY, telegram_id INTEGER, iq_user_id TEXT, username TEXT, currency TEXT,
                                       approval_status TEXT, created_at TEXT, api_secret TEXT);
           CREATE TABLE trades (id INTEGER PRIMARY KEY, amount REAL);`);
  const ins = db.prepare("INSERT INTO user_accounts (telegram_id, iq_user_id, username, currency, approval_status, created_at, api_secret) VALUES (?, ?, ?, 'USD', 'approved', '2026-11-01T00:00:00Z', 'not-copied')");
  for (let i = 1; i <= n; i++) ins.run(5000 + i, String(197000000 + i), `u${i}`);
  db.prepare('INSERT INTO trades (amount) VALUES (1)').run();
  return { path, db };
}
const syncEnv = (dir, extra = {}) => ({ PATH: process.env.PATH, TMPDIR: dir, BOT_DB: join(dir, 'iqbot.db'), BOTDB_SNAPSHOT: join(dir, 'out', 'botdb-snapshot.db'), SYNC_LOCK: join(dir, 'sync.lock'), ...extra });

test('sync-botdb.sh: writes the snapshot atomically with meta.synced_at, one stdout line, only user_accounts', async () => {
  const dir = tmp('coinvoo-sync-');
  const src = botDb(dir, 25); // left open in WAL mode, as the live bot keeps it
  try {
    const t0 = Date.now();
    await run('mkdir', ['-p', join(dir, 'out')]);
    const r = await run('bash', [SYNC], { env: syncEnv(dir) });
    const out = join(dir, 'out', 'botdb-snapshot.db');
    assert.equal(r.stdout, `[coinvoo] synced rows=25 size=${statSync(out).size} bytes\n`);
    assert.equal(r.stderr, '');
    const s = new DatabaseSync(out, { readOnly: true });
    try {
      const synced = Date.parse(s.prepare("SELECT value FROM meta WHERE key = 'synced_at'").get().value);
      assert.ok(synced >= t0 - 1000 && synced <= Date.now(), 'synced_at is now');
      assert.equal(s.prepare('SELECT COUNT(*) AS n FROM user_accounts').get().n, 25);
      assert.deepEqual(s.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((x) => x.name), ['meta', 'user_accounts']);
      assert.deepEqual(Object.keys(s.prepare('SELECT * FROM user_accounts LIMIT 1').get()), ['telegram_id', 'iq_user_id', 'username', 'currency', 'approval_status', 'created_at'], 'no other column leaves the bot host');
      assert.equal(s.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    } finally { s.close(); }
    assert.deepEqual(readdirSync(join(dir, 'out')), ['botdb-snapshot.db'], 'no .tmp left behind');
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('coinvoo-sync.')).length, 0, 'work dir removed');
  } finally { src.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('sync-botdb.sh: every failure exits non-zero with one ERROR line and leaves the old snapshot alone', async () => {
  const dir = tmp('coinvoo-sync-');
  try {
    await run('mkdir', ['-p', join(dir, 'out')]);
    writeFileSync(join(dir, 'out', 'botdb-snapshot.db'), 'previous snapshot');
    const fails = async (env, re) => {
      const e = await run('bash', [SYNC], { env: syncEnv(dir, env) }).then(() => null, (x) => x);
      assert.ok(e, 'must fail');
      assert.equal(e.code, 1);
      assert.equal(e.stdout, '');
      assert.match(e.stderr, re);
      assert.equal(e.stderr.trim().split('\n').length, 1, 'one line');
    };
    await fails({}, /^\[coinvoo\] ERROR sync-botdb: source database not found: .*iqbot\.db$/m);
    const empty = botDb(dir, 0); empty.db.close();
    await fails({}, /ERROR sync-botdb: build from .* failed: source user_accounts has 0 rows; refusing to publish an empty snapshot/);
    rmSync(join(dir, 'iqbot.db'));
    const noTable = new DatabaseSync(join(dir, 'iqbot.db')); noTable.exec('CREATE TABLE other (x)'); noTable.close();
    await fails({}, /ERROR sync-botdb: build from .* failed: no such table: user_accounts/);
    rmSync(join(dir, 'iqbot.db'));
    botDb(dir, 3).db.close();
    await fails({ BOTDB_SNAPSHOT: join(dir, 'nowhere', 'botdb-snapshot.db') }, /ERROR sync-botdb: destination directory not found: .*nowhere$/m);
    await fails({ SYNC_LOCK: join(dir, 'no-such-dir', 'x.lock') }, /ERROR sync-botdb: cannot open lock file/);
    await fails({ NODE: 'no-such-node-binary' }, /ERROR sync-botdb: node not found/);
    assert.equal(String(await import('node:fs').then((fs) => fs.readFileSync(join(dir, 'out', 'botdb-snapshot.db')))), 'previous snapshot');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sync-botdb.sh: an overlapping run exits 0 silently while the lock is held', async () => {
  const dir = tmp('coinvoo-sync-');
  const src = botDb(dir, 2); src.db.close();
  try {
    await run('mkdir', ['-p', join(dir, 'out')]);
    const holder = run('flock', [join(dir, 'sync.lock'), 'sleep', '1.5']);
    await new Promise((r) => setTimeout(r, 300));
    const r = await run('bash', [SYNC], { env: syncEnv(dir) });
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.ok(!existsSync(join(dir, 'out', 'botdb-snapshot.db')), 'it did nothing');
    await holder;
    const r2 = await run('bash', [SYNC], { env: syncEnv(dir) });
    assert.match(r2.stdout, /^\[coinvoo\] synced rows=2 size=\d+ bytes\n$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sync-botdb.sh + reader: the running service picks up a re-synced file (new inode) and health turns fresh', async () => {
  const dir = tmp('coinvoo-sync-');
  const src = botDb(dir, 4);
  await run('mkdir', ['-p', join(dir, 'out')]);
  const snapPath = join(dir, 'out', 'botdb-snapshot.db');
  writeFileSync(join(dir, 'placeholder'), '');
  const app = await startApp({ BOTDB_SNAPSHOT: snapPath });
  try {
    const h = async () => (await (await fetch(`${app.base}/api/aff/health`)).json()).snapshot;
    assert.equal((await h()).stale, true, 'nothing synced yet');
    await run('bash', [SYNC], { env: syncEnv(dir) });
    const a = await h();
    assert.equal(a.rows, 4);
    assert.equal(a.stale, false);
    assert.ok(a.age_s <= 60, `age ${a.age_s}s`);
    src.db.prepare("INSERT INTO user_accounts (telegram_id, iq_user_id) VALUES (9999, '197999999')").run();
    await run('bash', [SYNC], { env: syncEnv(dir) });
    assert.equal((await h()).rows, 5, 'reopened after the rename');
    assert.equal(app.deps.snapshot.lookupByTrader('197999999').length, 1);
  } finally { await app.close(); src.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ---------- Part 5: ops/click-smoke.sh ----------

test('click-smoke.sh: passes twice in a row against a running service and leaves nothing behind', async () => {
  const dir = tmp('coinvoo-smoke-');
  const dbPath = join(dir, 'coinvoo.db');
  const config = loadConfig(testEnv({ DB_PATH: dbPath }));
  const db = openDb(dbPath);
  migrate(db, { env: config.brandSeed });
  const server = createApp({ config, db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = { PATH: process.env.PATH, TMPDIR: dir, COINVOO_BASE: `http://127.0.0.1:${server.address().port}`, ADMIN_USER: 'admin', ADMIN_PASS: 'pass', DB_PATH: dbPath };
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  try {
    for (const round of [1, 2]) {
      const r = await run('bash', [SMOKE], { env });
      const lines = r.stdout.trim().split('\n');
      assert.equal(lines.length, 5, r.stdout);
      assert.match(lines[0], /^\[coinvoo\] click-smoke minted token=[0-9A-Z]{10} campaign=SMOKE_\d{8}T\d{6}Z_\d+$/);
      assert.match(lines[1], /^\[coinvoo\] click-smoke opened status=302 location=https:\/\/t\.me\/coinvoo_test_bot\?start=c_[0-9A-Z]{10}$/);
      assert.match(lines[2], /^\[coinvoo\] click-smoke joined telegram_id=99\d{10} member=\d+$/);
      assert.match(lines[3], /^\[coinvoo\] click-smoke PASS clicks=1 opens=1 members=1 click_id=[0-9A-Z]{10}$/);
      assert.match(lines[4], /^\[coinvoo\] click-smoke discarded token=[0-9A-Z]{10} clicks=1 opens=1 members=1$/);
      assert.equal(r.stderr, '', `round ${round}`);
      for (const t of ['clicks', 'click_opens', 'members']) assert.equal(count(t), 0, `${t} after round ${round}`);
    }
  } finally {
    server.deps.snapshot.close(); server.closeAllConnections();
    await new Promise((r) => server.close(r)); db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('click-smoke.sh: a mismatch exits 1 and still discards the token', async () => {
  const dir = tmp('coinvoo-smoke-');
  const dbPath = join(dir, 'coinvoo.db');
  // JOIN_KEY on the service but not given to the script: the join is refused -> failure path
  const config = loadConfig(testEnv({ DB_PATH: dbPath, JOIN_KEY: 'k-test-only' }));
  const db = openDb(dbPath);
  migrate(db, { env: config.brandSeed });
  const server = createApp({ config, db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = { PATH: process.env.PATH, TMPDIR: dir, COINVOO_BASE: `http://127.0.0.1:${server.address().port}`, ADMIN_USER: 'admin', ADMIN_PASS: 'pass', DB_PATH: dbPath };
  try {
    const e = await run('bash', [SMOKE], { env }).then(() => null, (x) => x);
    assert.ok(e);
    assert.equal(e.code, 1);
    assert.match(e.stderr, /^\[coinvoo\] ERROR click-smoke: POST \/api\/join: HTTP 401 /m);
    assert.match(e.stdout, /click-smoke discarded token=[0-9A-Z]{10} clicks=1 opens=1 members=0/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clicks').get().n, 0);
    const bad = await run('bash', [SMOKE], { env: { ...env, ADMIN_PASS: 'wrong' } }).then(() => null, (x) => x);
    assert.match(bad.stderr, /ERROR click-smoke: POST \/api\/links: HTTP 401/);
    const ok = await run('bash', [SMOKE], { env: { ...env, JOIN_KEY: 'k-test-only' } });
    assert.match(ok.stdout, /PASS clicks=1 opens=1 members=1/);
  } finally {
    server.deps.snapshot.close(); server.closeAllConnections();
    await new Promise((r) => server.close(r)); db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
