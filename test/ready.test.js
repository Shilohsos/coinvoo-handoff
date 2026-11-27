// Phase 7 Parts B, C, F, G — snapshot staleness by mtime + hourly alert, backups on by default,
// click_opens end to end, and GET /api/health/ready.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync, utimesSync, existsSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startApp, makeSnapshot, testEnv, captureLogs, seedDashFixture } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { loadReportConfig } from '../src/report.js';
import { createWorker } from '../src/worker.js';

const run = promisify(execFile);
const MIN = 60000;
const H = 60 * MIN;
const AT_0305 = Date.parse('2026-11-15T02:05:00Z'); // 03:05 Lagos: the daily maintenance (and backup) runs
const ALERT_ENV = { REPORT_BOT_TOKEN: '111222:FAKE_TOKEN_FOR_TESTS_ONLY', ALERT_CHAT_ID: '-1002222' };
const SYNC = new URL('../scripts/sync-botdb.sh', import.meta.url).pathname;
const CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const setMtime = (path, ms) => utimesSync(path, new Date(ms), new Date(ms));

async function app7(env = {}, { now = Date.now(), snap = null, alerts = false } = {}) {
  const clock = { now };
  const texts = [];
  const fetchImpl = async (u, init) => { texts.push(JSON.parse(init.body).text); return new Response('{"ok":true,"result":{"message_id":1}}'); };
  const app = await startApp({ BOTDB_SNAPSHOT: snap ? snap.path : '/nonexistent/botdb-snapshot.db', ...env }, { now: () => clock.now, fetchImpl });
  app.deps.reportConfig = Object.assign({}, loadReportConfig(alerts ? ALERT_ENV : {}), { retryDelayMs: 0 });
  app.deps.diskFreePct = () => 50;
  app.deps.rssMb = () => 100;
  const worker = createWorker(app.deps);
  const tick = async () => { await worker.tick(); await worker.flush(); };
  const get = async (p) => { const r = await fetch(`${app.base}${p}`); return { status: r.status, body: await r.json() }; };
  return { app, clock, texts, worker, tick, get };
}

// ---------- Part B ----------

test('B2 config: SNAPSHOT_STALE_MIN (default 30), SNAPSHOT_STALE_MINUTES still read when it is unset', () => {
  assert.equal(loadConfig(testEnv()).snapshotStaleMinutes, 30);
  assert.equal(loadConfig(testEnv({ SNAPSHOT_STALE_MIN: '45' })).snapshotStaleMinutes, 45);
  assert.equal(loadConfig(testEnv({ SNAPSHOT_STALE_MINUTES: '20' })).snapshotStaleMinutes, 20);
  assert.equal(loadConfig(testEnv({ SNAPSHOT_STALE_MIN: '45', SNAPSHOT_STALE_MINUTES: '20' })).snapshotStaleMinutes, 45, 'the Phase 7 name wins');
  assert.throws(() => loadConfig(testEnv({ SNAPSHOT_STALE_MIN: 'x' })), /SNAPSHOT_STALE_MIN must be a number/);
});

test('B2 health: a fresh snapshot is not stale; snapshot_age_s and snapshot_stale are top-level fields', async () => {
  const t = Date.now();
  const snap = makeSnapshot([{ telegram_id: 1, iq_user_id: '197000001' }], new Date(t - 2 * MIN).toISOString());
  setMtime(snap.path, t - 2 * MIN);
  const { app, get } = await app7({}, { now: t, snap });
  try {
    const { body } = await get('/api/aff/health');
    assert.equal(body.snapshot_age_s, 120);
    assert.equal(body.snapshot_stale, false);
    assert.deepEqual(body.snapshot, { rows: 1, synced_at: t - 2 * MIN, age_s: 120, stale: false });
  } finally { await app.close(); snap.cleanup(); }
});

test('B2 backdated mtime -> stale and ONE alert; no re-alert within the hour; one reminder after it; cleared once', async () => {
  const t = Date.now();
  const snap = makeSnapshot([{ telegram_id: 1, iq_user_id: '197000001' }], new Date(t).toISOString()); // synced_at says fresh
  setMtime(snap.path, t - 2 * H); // ...but the file has not been replaced for 2 h
  const { app, clock, texts, tick, get } = await app7({}, { now: t, snap, alerts: true });
  try {
    const h = (await get('/api/aff/health')).body;
    assert.equal(h.snapshot_stale, true);
    assert.equal(h.snapshot_age_s, 7200, 'the older of synced_at and mtime');
    await tick();
    assert.deepEqual(texts, ['COINVOO — bot snapshot 2 h old (threshold 30 min)']);
    for (const m of [1, 10, 30, 59]) { clock.now = t + m * MIN; await tick(); }
    assert.equal(texts.length, 1, 'no second alert within the hour');
    assert.ok(Number(app.db.prepare("SELECT value FROM settings WHERE key = 'alert_sent_at_snapshot'").get().value) === t, 'dedupe key in settings');
    clock.now = t + 60 * MIN;
    await tick();
    assert.deepEqual(texts.slice(1), ['COINVOO — bot snapshot 3 h old (threshold 30 min) — still firing'], 'one reminder an hour later');
    clock.now = t + 61 * MIN; await tick();
    assert.equal(texts.length, 2);
    // a sync lands (new file, fresh mtime and synced_at)
    const fresh = makeSnapshot([{ telegram_id: 1, iq_user_id: '197000001' }], new Date(t + 62 * MIN).toISOString());
    setMtime(fresh.path, t + 62 * MIN);
    renameSync(fresh.path, snap.path); fresh.cleanup();
    clock.now = t + 63 * MIN; await tick();
    clock.now = t + 64 * MIN; await tick();
    assert.deepEqual(texts.slice(2), ['COINVOO — bot snapshot cleared']);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'alert_sent_at_snapshot'").get().n, 0);
  } finally { await app.close(); snap.cleanup(); }
});

test('B2 the hourly dedupe survives a restart (persisted, not only in memory)', async () => {
  const t = Date.now();
  const snap = makeSnapshot([{ telegram_id: 1, iq_user_id: '197000001' }], new Date(t - 2 * H).toISOString());
  const { app, clock, texts, tick } = await app7({}, { now: t, snap, alerts: true });
  try {
    await tick();
    assert.equal(texts.length, 1);
    clock.now = t + 20 * MIN;
    await createWorker(app.deps).tick(); // a new worker = a restarted process, same database
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(texts.length, 1);
  } finally { await app.close(); snap.cleanup(); }
});

test('B1 scripts/sync-botdb.sh: writes /srv/coinvoo-style target atomically; unreadable source -> exit 1 + log line', async () => {
  const dir = tmp('coinvoo-b1-');
  try {
    mkdirSync(join(dir, 'coinvoo'));
    const env = { PATH: process.env.PATH, TMPDIR: dir, SYNC_LOCK: join(dir, 'lock'), BOTDB_SNAPSHOT: join(dir, 'coinvoo', 'botdb-snapshot.db') };
    const bad = await run('bash', [SYNC], { env: { ...env, BOT_DB: join(dir, 'missing.db') } }).then(() => null, (e) => e);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /^\[coinvoo\] ERROR sync-botdb: source database not found: .*missing\.db\n$/);
    mkdirSync(join(dir, 'a-directory.db'));
    const unreadable = await run('bash', [SYNC], { env: { ...env, BOT_DB: join(dir, 'a-directory.db') } }).then(() => null, (e) => e);
    assert.equal(unreadable.code, 1);
    assert.match(unreadable.stderr, /ERROR sync-botdb: source database not found/);
    const src = new DatabaseSync(join(dir, 'bot.db'));
    src.exec("CREATE TABLE user_accounts (telegram_id INTEGER, iq_user_id TEXT, username TEXT, currency TEXT, approval_status TEXT, created_at TEXT); INSERT INTO user_accounts VALUES (1, '197000001', 'a', 'USD', 'approved', '2026-11-01');");
    src.close();
    const ok = await run('bash', [SYNC], { env: { ...env, BOT_DB: join(dir, 'bot.db') } });
    assert.match(ok.stdout, /^\[coinvoo\] synced rows=1 size=\d+ bytes\n$/);
    assert.deepEqual(readdirSync(join(dir, 'coinvoo')), ['botdb-snapshot.db'], 'no .tmp left');
    const defaults = (await run('grep', ['-c', '/srv/coinvoo/botdb-snapshot.db', new URL('../ops/sync-botdb.sh', import.meta.url).pathname])).stdout.trim();
    assert.ok(Number(defaults) >= 1, 'default target is /srv/coinvoo/botdb-snapshot.db');
    assert.equal((await run('grep', ['-c', 'tribute', SYNC]).catch((e) => e)).code, 1, 'no tribute path in the script');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- Part C ----------

test('C config: BACKUP_DIR resolves to /srv/coinvoo/backups when unset; BACKUP_KEEP stays 14', () => {
  const env = testEnv();
  delete env.BACKUP_DIR;
  const c = loadConfig(env);
  assert.equal(c.backupDir, '/srv/coinvoo/backups');
  assert.equal(c.backupKeep, 14);
  assert.equal(loadConfig(testEnv({ BACKUP_DIR: '/srv/elsewhere' })).backupDir, '/srv/elsewhere', 'still overridable');
});

test('C boot creates the directory and logs it; the nightly run writes a file; prune keeps exactly BACKUP_KEEP; health reports it', async () => {
  const dir = tmp('coinvoo-c-');
  const target = join(dir, 'root', 'coinvoo', 'backups'); // three levels missing
  for (let d = 1; d <= 9; d++) { mkdirSync(target, { recursive: true }); writeFileSync(join(target, `coinvoo-2026-10-0${d}.db`), 'old'); }
  rmSync(target, { recursive: true }); // start from nothing, then let boot create it
  const { app, worker, tick, get } = await app7({ BACKUP_DIR: target, BACKUP_KEEP: '4' }, { now: AT_0305 });
  try {
    seedDashFixture(app.db, AT_0305);
    let h = (await get('/api/aff/health')).body;
    assert.deepEqual([h.backup_enabled, h.backup_age_s], [true, null], 'no backup yet');
    const boot = await captureLogs(async () => { worker.start(); worker.stop(); });
    assert.ok(existsSync(target), 'created at boot');
    assert.ok(boot.includes(`[coinvoo] backup enabled dir=${target} keep=4`), boot.join('|'));
    for (let d = 1; d <= 9; d++) writeFileSync(join(target, `coinvoo-2026-10-0${d}.db`), 'old');
    await tick();
    const files = readdirSync(target).sort();
    assert.equal(files.length, 4, 'exactly BACKUP_KEEP');
    assert.deepEqual(files, ['coinvoo-2026-10-07.db', 'coinvoo-2026-10-08.db', 'coinvoo-2026-10-09.db', 'coinvoo-2026-11-15.db']);
    const copy = new DatabaseSync(join(target, 'coinvoo-2026-11-15.db'), { readOnly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM members').get().n, 6);
    copy.close();
    h = (await get('/api/aff/health')).body;
    assert.equal(h.backup_enabled, true);
    const age = Math.floor((AT_0305 - statSync(join(target, 'coinvoo-2026-11-15.db')).mtimeMs) / 1000);
    assert.equal(h.backup_age_s, Math.max(0, age));
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  const off = await app7({ BACKUP_DIR: 'off' });
  try {
    const h = (await off.get('/api/aff/health')).body;
    assert.deepEqual([h.backup_enabled, h.backup_age_s], [false, null]);
  } finally { await off.app.close(); }
});

// ---------- Part F ----------

test('F GET /c/<id>: one click_opens row per open, same click_id; immediate repeat -> still one; params persisted', async () => {
  const app = await startApp();
  try {
    const { token } = await app.mint({ brand: 'brand-one', campaign: 'META_LAUNCH', adset: 'broad', ad: 'v1' });
    const qs = 'fbclid=IwAR0abc&ttclid=E.C.P.tt&gclid=Cj0gc&sub1=s1&sub2=s2&sub3=s3&utm_source=facebook&utm_medium=paid&utm_campaign=meta_launch&utm_content=v1&utm_term=broad';
    const open = (ua = CHROME, ip = '203.0.113.10') => fetch(`${app.base}/c/${token}?${qs}`, { redirect: 'manual', headers: { 'user-agent': ua, 'x-forwarded-for': ip } });
    const r = await open();
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `https://t.me/coinvoo_test_bot?start=c_${token}`);
    const opens = () => app.db.prepare('SELECT click_id, is_bot FROM click_opens ORDER BY id').all().map((x) => ({ ...x }));
    assert.deepEqual(opens(), [{ click_id: token, is_bot: 0 }], 'exactly one row, referencing the minted click');
    await open();
    assert.equal(opens().length, 1, 'the same visitor again within 60 s: still one');
    const c = app.db.prepare('SELECT fbclid, ttclid, gclid, sub1, sub2, sub3, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign, clicked_at FROM clicks WHERE click_id = ?').get(token);
    assert.deepEqual({ ...c, clicked_at: c.clicked_at > 0 }, {
      fbclid: 'IwAR0abc', ttclid: 'E.C.P.tt', gclid: 'Cj0gc', sub1: 's1', sub2: 's2', sub3: 's3',
      utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'meta_launch', utm_content: 'v1', utm_term: 'broad',
      campaign: 'META_LAUNCH', clicked_at: true
    });
  } finally { await app.close(); }
});

test('F bot user-agents get is_bot = 1 and are excluded from the dashboard and admin counts', async () => {
  const app = await startApp();
  try {
    const { token } = await app.mint({ brand: 'brand-one', campaign: 'META_LAUNCH' });
    const hit = (ua, ip) => fetch(`${app.base}/c/${token}`, { redirect: 'manual', headers: { 'user-agent': ua, 'x-forwarded-for': ip } });
    await hit('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', '69.171.250.1');
    await hit('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', '66.249.66.1');
    await hit(CHROME, '203.0.113.20');
    await hit(CHROME, '203.0.113.21'); // a different person within 60 s is a second click
    assert.deepEqual(app.db.prepare('SELECT is_bot FROM click_opens ORDER BY id').all().map((x) => x.is_bot), [1, 1, 0, 0]);
    const api = await (await fetch(`${app.base}/api/clicks?campaign=META_LAUNCH`, { headers: { authorization: app.auth } })).json();
    assert.equal(api.clicks[0].opens, 2, 'bots are not counted');
    const dash = await (await fetch(`${app.base}/dash?period=today`, { headers: { authorization: app.auth } })).text();
    assert.match(dash, /data-metric="clicks" data-value="2"/);
  } finally { await app.close(); }
});

// ---------- Part G ----------

test('G /api/health/ready: healthy fixture -> 200 ok:true with every field', async () => {
  const t = Date.now();
  const snap = makeSnapshot([{ telegram_id: 1, iq_user_id: '197000001' }], new Date(t - 42000).toISOString());
  setMtime(snap.path, t - 42000);
  const dir = tmp('coinvoo-g-');
  writeFileSync(join(dir, 'coinvoo-2026-11-17.db'), 'x');
  setMtime(join(dir, 'coinvoo-2026-11-17.db'), t - 3600000);
  const { app, get } = await app7({ JOIN_KEY: 'k-test-only', BACKUP_DIR: dir }, { now: t, snap });
  try {
    app.db.prepare("INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, payload_json, received_at, state, forward_state) VALUES ('e1', 1, 'affstore', 'reg', 'reg', '197000001', '{}', ?, 'parked', 'none')").run(t - 12000);
    const r = await get('/api/health/ready');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      ok: true, db: 'ok', migrations: '012_click_ad_ids', join_key_set: true, aff_key_set: false, aff_key_enforced: false,
      snapshot_age_s: 42, snapshot_stale: false, backup_enabled: true, backup_age_s: 3600,
      last_event_age_s: 12, click_tracking: 'ok'
    });
  } finally { await app.close(); snap.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test('G /api/health/ready: stale beyond 3x the threshold -> 503 ok:false; stale but within 3x is still ok', async () => {
  const t = Date.now();
  const snap = makeSnapshot([{ telegram_id: 1, iq_user_id: '197000001' }], new Date(t - 45 * MIN).toISOString());
  setMtime(snap.path, t - 45 * MIN);
  const { app, clock, get } = await app7({}, { now: t, snap });
  try {
    let r = await get('/api/health/ready');
    assert.deepEqual([r.status, r.body.ok, r.body.snapshot_stale, r.body.snapshot_age_s], [200, true, true, 2700], '45 min: stale, not beyond 90');
    clock.now = t + 46 * MIN; // 91 min old
    r = await get('/api/health/ready');
    assert.deepEqual([r.status, r.body.ok, r.body.snapshot_age_s], [503, false, 5460]);
    assert.deepEqual(r.body.reasons, ['snapshot older than 5400 s']);
  } finally { await app.close(); snap.cleanup(); }
  const missing = await app7();
  try {
    const r = await missing.get('/api/health/ready');
    assert.deepEqual([r.status, r.body.ok, r.body.snapshot_age_s, r.body.reasons], [503, false, null, ['snapshot unreadable']]);
    assert.equal(r.body.join_key_set, false);
    assert.equal(r.body.backup_enabled, false);
  } finally { await missing.app.close(); }
});

test('G /api/health/ready: a migration not applied, or a failing database -> 503 ok:false', async () => {
  const t = Date.now();
  const snap = makeSnapshot([{ telegram_id: 1, iq_user_id: '197000001' }], new Date(t).toISOString());
  const { app, get } = await app7({}, { now: t, snap });
  try {
    app.db.prepare("DELETE FROM schema_migrations WHERE name = '006_click_utm'").run();
    let r = await get('/api/health/ready');
    assert.deepEqual([r.status, r.body.ok, r.body.migrations, r.body.reasons], [503, false, 'missing:006_click_utm', ['migrations']]);
    const real = app.db.prepare.bind(app.db);
    app.db.prepare = (sql) => { if (/SELECT 1\b/.test(sql)) throw new Error('disk I/O error'); return real(sql); };
    r = await get('/api/health/ready');
    assert.deepEqual([r.status, r.body.ok, r.body.db, r.body.reasons], [503, false, 'fail', ['db']]);
    app.db.prepare = real;
  } finally { await app.close(); snap.cleanup(); }
});
