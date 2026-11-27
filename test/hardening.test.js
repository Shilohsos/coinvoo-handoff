// Phase 10 — hardening. Each test reproduces a hole found in review and proves it closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, testEnv, captureLogs } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { authGuardFor, AUTH_MAX_FAILS, AUTH_WINDOW_MS, AUTH_BLOCK_MS } from '../src/auth.js';
import { safeBack } from '../src/routes/dash.js';
import { createWorker } from '../src/worker.js';
import { loadReportConfig } from '../src/report.js';

// A placeholder, not a credential: it only has to be long enough to pass the config check.
const KEY = 'placeholder-postback-key-for-tests';
const META = { META_CAPI_ENABLED: '1', META_DATASET_ID: '1234567890', META_CAPI_TOKEN: 'placeholder-not-a-token' };
const okMeta = async () => new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const pbUrl = (app, params) => `${app.base}/api/aff?${new URLSearchParams(params)}`;
const count = (app, sql, ...p) => app.db.prepare(sql).get(...p).n;

// ---------------------------------------------------------------------------------------------------------------
// A1b — the key in the path, for trackers that drop unknown query parameters

test('A1b: /api/aff/k/<key> authenticates the same as ?key=', async () => {
  const app = await startApp({ AFF_KEY: KEY, ...META }, { fetchImpl: okMeta });
  try {
    const p = new URLSearchParams({ status: 'reg', trader_id: '197123999', afftrack: '', event_id: 'pathkey-1' });
    const r = await fetch(`${app.base}/api/aff/k/${KEY}?${p}`);
    assert.equal(r.status, 200, 'the key in the path is accepted');
    assert.equal(count(app, 'SELECT COUNT(*) AS n FROM events'), 1, 'stored');

    const bad = await fetch(`${app.base}/api/aff/k/wrong-key-wrong-key?${p}`);
    assert.equal(bad.status, 401, 'a wrong key in the path is refused');

    const none = await fetch(`${app.base}/api/aff/k/?${p}`);
    assert.equal(none.status, 401, 'an empty path key counts as missing, so it is refused');
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// A1 — postback key

test('A1 forged postback: with AFF_KEY enforced, a postback without the key is refused and leaves nothing behind', async () => {
  const app = await startApp({ AFF_KEY: KEY, ...META }, { fetchImpl: okMeta });
  try {
    app.member(6600000001);
    const forged = { status: 'ftd', trader_id: '197123456', amount: '99999', afftrack: '6600000001', event_id: 'forged-1' };
    let r;
    const lines = await captureLogs(async () => { r = await fetch(pbUrl(app, forged)); });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { ok: false, error: 'unauthorized', detail: 'missing or invalid postback key' });
    assert.equal(count(app, 'SELECT COUNT(*) AS n FROM events'), 0, 'not stored');
    assert.equal(count(app, 'SELECT COUNT(*) AS n FROM meta_sends'), 0, 'not sent to Meta');
    assert.equal((await fetch(pbUrl(app, { ...forged, key: 'wrong-key-wrong-key' }))).status, 401, 'a wrong key is refused too');
    assert.ok(lines.some((l) => /^\[coinvoo\] postback refused reason=key_missing ip=[0-9a-f]{12}$/.test(l)), lines.join('|'));
    // and the forged event id is not squatted: the real postback with that id still lands
    const real = await (await fetch(pbUrl(app, { ...forged, amount: '50', key: KEY }))).json();
    assert.deepEqual([real.matched, real.path, real.confidence], [true, 'afftrack', 100]);
  } finally { await app.close(); }
});

test('A1 the key is accepted from the query, a form body, JSON body or X-Coinvoo-Key, and is never stored', async () => {
  const app = await startApp({ AFF_KEY: KEY });
  try {
    const base = { status: 'reg', trader_id: '197100200' };
    assert.equal((await fetch(pbUrl(app, { ...base, event_id: 'k-query', key: KEY }))).status, 200);
    assert.equal((await fetch(pbUrl(app, { ...base, event_id: 'k-alias', aff_key: KEY }))).status, 200);
    assert.equal((await fetch(`${app.base}/api/aff`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...base, event_id: 'k-form', key: KEY }) })).status, 200);
    assert.equal((await fetch(`${app.base}/api/aff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, event_id: 'k-json', key: KEY }) })).status, 200);
    assert.equal((await fetch(pbUrl(app, { ...base, event_id: 'k-header' }), { headers: { 'x-coinvoo-key': KEY } })).status, 200);
    const stored = app.db.prepare('SELECT event_id, payload_json FROM events ORDER BY event_id').all();
    assert.deepEqual(stored.map((e) => e.event_id), ['k-alias', 'k-form', 'k-header', 'k-json', 'k-query']);
    for (const e of stored) {
      assert.ok(!e.payload_json.includes(KEY), `${e.event_id}: the key is not in the stored payload`);
      assert.ok(!/"(key|aff_key)"/.test(e.payload_json), `${e.event_id}: nor the parameter name`);
    }
    const h = await (await fetch(`${app.base}/api/aff/health`)).json();
    assert.deepEqual(h.postback_key, { set: true, enforced: true, ok: 5, missing: 0, bad: 0, last_refused_at: null });
    assert.ok(!JSON.stringify(h).includes(KEY), 'health never echoes the key');
    await fetch(pbUrl(app, { ...base, event_id: 'k-none' }));
    await fetch(pbUrl(app, { ...base, event_id: 'k-bad', key: 'x'.repeat(20) }));
    const h2 = await (await fetch(`${app.base}/api/aff/health`)).json();
    assert.deepEqual([h2.postback_key.ok, h2.postback_key.missing, h2.postback_key.bad], [5, 1, 1]);
    assert.equal(typeof h2.postback_key.last_refused_at, 'number');
  } finally { await app.close(); }
});

test('A1 without AFF_KEY nothing changes for the network, but a key parameter is still never stored', async () => {
  const app = await startApp();
  try {
    const r = await (await fetch(pbUrl(app, { status: 'reg', trader_id: '197100300', event_id: 'nk1', key: 'anything-at-all' }))).json();
    assert.equal(r.ok, true);
    assert.equal((await fetch(pbUrl(app, { status: 'reg', trader_id: '197100301', event_id: 'nk2' }))).status, 200, 'no key needed');
    assert.ok(!app.db.prepare("SELECT payload_json FROM events WHERE event_id = 'nk1'").get().payload_json.includes('anything-at-all'));
    const ready = await (await fetch(`${app.base}/api/health/ready`)).json();
    assert.deepEqual([ready.aff_key_set, ready.aff_key_enforced], [false, false]);
  } finally { await app.close(); }
});

test('A1 AFF_KEY_ENFORCE=0 is the rollout mode: keys are checked and counted, every postback is still accepted', async () => {
  const app = await startApp({ AFF_KEY: KEY, AFF_KEY_ENFORCE: '0' });
  try {
    assert.equal((await fetch(pbUrl(app, { status: 'reg', trader_id: '197100400', event_id: 'ro1' }))).status, 200);
    assert.equal((await fetch(pbUrl(app, { status: 'reg', trader_id: '197100401', event_id: 'ro2', key: 'not-the-key-at-all' }))).status, 200);
    assert.equal((await fetch(pbUrl(app, { status: 'reg', trader_id: '197100402', event_id: 'ro3', key: KEY }))).status, 200);
    assert.equal(count(app, 'SELECT COUNT(*) AS n FROM events'), 3);
    const h = await (await fetch(`${app.base}/api/aff/health`)).json();
    assert.deepEqual(h.postback_key, { set: true, enforced: false, ok: 1, missing: 1, bad: 1, last_refused_at: null });
    const ready = await (await fetch(`${app.base}/api/health/ready`)).json();
    assert.deepEqual([ready.aff_key_set, ready.aff_key_enforced], [true, false]);
  } finally { await app.close(); }
});

test('A1 config: AFF_KEY must be 16+ characters without spaces; AFF_KEY_ENFORCE is 0 or 1', () => {
  assert.throws(() => loadConfig(testEnv({ AFF_KEY: 'short' })), /AFF_KEY must be at least 16 characters/);
  assert.throws(() => loadConfig(testEnv({ AFF_KEY: 'has a space in the middle' })), /AFF_KEY must be at least 16 characters, with no spaces/);
  assert.throws(() => loadConfig(testEnv({ AFF_KEY: KEY, AFF_KEY_ENFORCE: 'yes' })), /AFF_KEY_ENFORCE must be 0 or 1/);
  const c = loadConfig(testEnv({ AFF_KEY: `  ${KEY}  ` }));
  assert.deepEqual([c.affKey, c.affKeyEnforce], [KEY, true]);
  assert.deepEqual([loadConfig(testEnv()).affKey, loadConfig(testEnv()).affKeyEnforce], [null, false]);
});

// ---------------------------------------------------------------------------------------------------------------
// A2 — failed sign-in limit

test('A2 after 10 wrong passwords an address is blocked for 15 min, the right password included; others are not', async () => {
  const app = await startApp();
  try {
    const g = authGuardFor(app.config);
    const t = { now: Date.parse('2026-11-20T10:00:00Z') };
    g.now = () => t.now;
    const from = (ip, auth) => fetch(`${app.base}/dash`, { headers: { 'x-forwarded-for': ip, ...(auth ? { authorization: auth } : {}) } });
    const codes = [];
    let lines = await captureLogs(async () => {
      for (let i = 0; i < AUTH_MAX_FAILS; i++) codes.push((await from('198.51.100.10', basic('admin', `guess${i}`))).status);
    });
    assert.deepEqual(codes, new Array(AUTH_MAX_FAILS).fill(401));
    assert.ok(lines.some((l) => /^\[coinvoo\] auth_blocked ip=[0-9a-f]{12} fails=10 minutes=15$/.test(l)), lines.join('|'));
    assert.ok(!lines.join('\n').includes('198.51.100.10'), 'the address itself is never logged');
    const blocked = await from('198.51.100.10', app.auth);
    assert.equal(blocked.status, 429, 'blocked even with the right password');
    assert.equal(blocked.headers.get('retry-after'), String(AUTH_BLOCK_MS / 1000));
    assert.equal((await blocked.json()).error, 'too_many_attempts');
    assert.equal((await from('198.51.100.11', app.auth)).status, 200, 'another address is not affected');
    assert.equal((await fetch(`${app.base}/api/members`, { headers: { 'x-forwarded-for': '198.51.100.10', authorization: app.auth } })).status, 429, 'every admin route shares the block');
    t.now += AUTH_BLOCK_MS + 1000;
    assert.equal((await from('198.51.100.10', app.auth)).status, 200, 'the block expires');
    // requests without credentials (a browser's first request) are never counted
    for (let i = 0; i < 30; i++) assert.equal((await from('198.51.100.12')).status, 401);
    assert.equal((await from('198.51.100.12', app.auth)).status, 200);
    lines = null;
  } finally { await app.close(); }
});

test('A2 a correct sign-in resets the count; failures older than the window do not add up', async () => {
  const app = await startApp();
  try {
    const g = authGuardFor(app.config);
    const t = { now: Date.parse('2026-11-20T10:00:00Z') };
    g.now = () => t.now;
    const from = (auth) => fetch(`${app.base}/api/members`, { headers: { 'x-forwarded-for': '203.0.113.20', authorization: auth } });
    for (let i = 0; i < AUTH_MAX_FAILS - 1; i++) await from(basic('admin', 'x'));
    assert.equal((await from(app.auth)).status, 200, 'nine misses, then the right password');
    for (let i = 0; i < AUTH_MAX_FAILS - 1; i++) await from(basic('admin', 'x'));
    assert.equal((await from(basic('admin', 'x'))).status, 401, 'the count restarted at the success: this is miss ten');
    assert.equal((await from(app.auth)).status, 429, 'ten misses since the success make a block');
    g.reset();
    for (let i = 0; i < AUTH_MAX_FAILS - 1; i++) await from(basic('admin', 'x'));
    t.now += AUTH_WINDOW_MS + 1;
    assert.equal((await from(basic('admin', 'x'))).status, 401, 'the old nine fell out of the window');
  } finally { await app.close(); }
});

test('A2 POST /api/links and the revenue block of /api/aff/stats share the limit (no side door for guessing)', async () => {
  const app = await startApp();
  try {
    authGuardFor(app.config).now = () => Date.parse('2026-11-20T10:00:00Z');
    const stats = (auth) => fetch(`${app.base}/api/aff/stats`, { headers: { 'x-forwarded-for': '203.0.113.30', authorization: auth } }).then((r) => r.json());
    for (let i = 0; i < AUTH_MAX_FAILS; i++) assert.equal((await stats(basic('admin', `g${i}`))).revenue, undefined);
    assert.equal((await stats(app.auth)).revenue, undefined, 'blocked: the right password no longer reveals money here either');
    const links = await fetch(`${app.base}/api/links`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.30', authorization: app.auth, 'content-type': 'application/json' }, body: JSON.stringify({ brand: 'brand-one' }) });
    assert.equal(links.status, 429);
    assert.equal(count(app, 'SELECT COUNT(*) AS n FROM clicks'), 0);
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// A3 — a manual attach is reported to Meta like any other match

test('A3 manual attach queues the conversion for Meta (a Purchase for an FTD); with Meta off nothing is queued', async () => {
  const app = await startApp(META, { fetchImpl: okMeta });
  try {
    const mid = app.member(6600000002);
    await app.pb({ status: 'ftd', trader_id: '197654321', amount: '50', event_id: 'park-1' });
    assert.equal(app.db.prepare("SELECT state FROM events WHERE event_id = 'park-1'").get().state, 'parked');
    const r = await fetch(`${app.base}/api/events/park-1/attach`, { method: 'POST', headers: { authorization: app.auth, 'content-type': 'application/json' }, body: JSON.stringify({ member_id: mid, note: 'operator matched by phone' }) });
    assert.equal(r.status, 200);
    assert.deepEqual({ ...app.db.prepare("SELECT send_id, kind, ref, state FROM meta_sends WHERE ref = 'park-1'").get() },
      { send_id: 'evt:park-1', kind: 'purchase', ref: 'park-1', state: 'pending' });
  } finally { await app.close(); }
  const off = await startApp();
  try {
    const mid = off.member(6600000003);
    await off.pb({ status: 'reg', trader_id: '197654322', event_id: 'park-2' });
    await fetch(`${off.base}/api/events/park-2/attach`, { method: 'POST', headers: { authorization: off.auth, 'content-type': 'application/json' }, body: JSON.stringify({ member_id: mid, note: 'n' }) });
    assert.equal(off.db.prepare("SELECT state FROM events WHERE event_id = 'park-2'").get().state, 'matched');
    assert.equal(count(off, 'SELECT COUNT(*) AS n FROM meta_sends'), 0);
  } finally { await off.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// A4 — the redirect after a form post stays on the site

test('A4 safeBack: dot segments, backslashes and absolute URLs cannot leave the site or the screen', () => {
  const cases = [
    ['/dash/campaigns?period=30d', '/dash/campaigns?period=30d'],
    ['/dash/campaigns', '/dash/campaigns'],
    ['/dash/campaigns/../..//evil.example/x', '/F'],
    ['/dash/campaigns\\..\\..\\evil.example', '/F'],
    ['//evil.example/dash/campaigns', '/F'],
    ['https://evil.example/dash/campaigns', '/F'],
    ['/dash/campaignsX', '/F'],
    ['/dash/members', '/F'],
    ['', '/F'],
    [null, '/F']
  ];
  for (const [back, want] of cases) assert.equal(safeBack(back, '/dash/campaigns', '/F'), want, String(back));
});

test('A4 the spend form no longer redirects off-site', async () => {
  const app = await startApp();
  try {
    const r = await fetch(`${app.base}/dash/spend`, { method: 'POST', redirect: 'manual',
      headers: { authorization: app.auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ brand: 'brand-one', day: '2026-11-19', spend: '1', back: '/dash/campaigns/../..//evil.example/x' }) });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/dash/campaigns?notice=spend_saved');
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// A6 — backfill keeps names

test('A6 a backfill row without names keeps the names a live join recorded; a live join still reports the latest', async () => {
  const app = await startApp();
  try {
    await app.join({ brand: 'brand-one', telegram_id: 6600000004, username: 'real_name', first_name: 'Ada' });
    const batch = (joins) => fetch(`${app.base}/api/join/batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brand: 'brand-one', joins }) });
    assert.equal((await batch([{ telegram_id: 6600000004 }])).status, 200);
    const names = () => ({ ...app.db.prepare('SELECT username, first_name FROM members WHERE telegram_id = 6600000004').get() });
    assert.deepEqual(names(), { username: 'real_name', first_name: 'Ada' });
    await batch([{ telegram_id: 6600000004, username: 'renamed' }]);
    assert.deepEqual(names(), { username: 'renamed', first_name: 'Ada' }, 'a backfill value that is present still wins');
    await app.join({ brand: 'brand-one', telegram_id: 6600000004 });
    assert.deepEqual(names(), { username: null, first_name: null }, 'a live join is the truth now, as before');
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// A7 — raw IP retention

test('A7 maintenance blanks clicks.ip_raw older than IP_RAW_RETENTION_DAYS; ip_hash stays; 0 keeps everything', async () => {
  for (const [env, want] of [[{}, ['NEW', 'OLD-hash']], [{ IP_RAW_RETENTION_DAYS: '0' }, ['NEW', 'OLD']], [{ IP_RAW_RETENTION_DAYS: '10' }, ['NEW', 'OLD-hash']]]) {
    const t = { now: Date.parse('2026-11-15T02:30:00Z') }; // 03:30 Lagos: the maintenance runs on the first tick
    const app = await startApp(env, { now: () => t.now });
    try {
      const ins = app.db.prepare('INSERT INTO clicks (click_id, brand_id, created_at, clicked_at, ip_hash, ip_raw) VALUES (?, 1, ?, ?, ?, ?)');
      ins.run('NEWCLICK01', t.now - 5 * 86400000, t.now - 5 * 86400000, 'h-new', '203.0.113.1');
      ins.run('OLDCLICK01', t.now - 120 * 86400000, t.now - 120 * 86400000, 'h-old', '203.0.113.2');
      app.deps.reportConfig = loadReportConfig({});
      const w = createWorker(app.deps);
      await captureLogs(async () => { await w.tick(); await w.flush(); });
      const rows = app.db.prepare('SELECT click_id, ip_raw, ip_hash FROM clicks ORDER BY click_id').all();
      const seen = rows.map((r) => (r.ip_raw ? (r.click_id.startsWith('NEW') ? 'NEW' : 'OLD') : `${r.click_id.startsWith('NEW') ? 'NEW' : 'OLD'}-hash`)).sort();
      assert.deepEqual(seen, want, JSON.stringify(env));
      assert.deepEqual(rows.map((r) => r.ip_hash), ['h-new', 'h-old'], 'the hash is never touched');
      assert.equal(w.lastMaintenance.ip_raw_blanked, want.includes('OLD-hash') ? 1 : 0);
    } finally { await app.close(); }
  }
  assert.equal(loadConfig(testEnv()).ipRawRetentionDays, 90, 'default');
  assert.throws(() => loadConfig(testEnv({ IP_RAW_RETENTION_DAYS: '-1' })), /IP_RAW_RETENTION_DAYS must be a number >= 0/);
});

// ---------------------------------------------------------------------------------------------------------------
// A8 — the member index

test('A8 events are looked up by member through an index', async () => {
  const app = await startApp();
  try {
    const plan = app.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM events WHERE matched_member_id = ?').all(1).map((r) => r.detail).join(' ');
    assert.match(plan, /USING INDEX idx_events_member/);
  } finally { await app.close(); }
});
