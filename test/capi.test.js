// Phase 8 — Meta Conversions API: config, queue, payload, state machine, wiring. No network: every request goes
// to an injected fetchImpl. The token below is a placeholder, not token-shaped, used only to prove scrubbing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { startApp, testEnv, captureLogs, until } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { externalId, fbcFor, buildEvent, metaEventId, META_EVENTS, KIND_FOR_EVENT } from '../src/capi.js';

const J = (tg, brand = 1) => `join:${brand}:${externalId(tg).slice(0, 32)}`; // a join's Meta event_id
import { recordJoin } from '../src/routes/join.js';
import { createWorker } from '../src/worker.js';
import { loadReportConfig } from '../src/report.js';

const TOKEN = 'PLACEHOLDER-NOT-A-REAL-META-TOKEN';
const DATASET = '1000000000000001';
const META_ENV = { META_CAPI_ENABLED: '1', META_DATASET_ID: DATASET, META_CAPI_TOKEN: TOKEN };
const CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const MIN = 60000;

const ok200 = (init) => new Response(JSON.stringify({ events_received: JSON.parse(init.body).data.length, messages: [], fbtrace_id: 'AbC' }), { status: 200 });

async function capiApp(env = {}, script = []) {
  const clock = { now: Date.now() };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const step = script.length ? script.shift() : 'ok';
    if (step === 'throw') throw new Error(`connect ECONNRESET ${String(url)}`);
    if (step === 'ok') return ok200(init);
    return typeof step === 'function' ? step(url, init) : step;
  };
  const app = await startApp({ ...META_ENV, ...env }, { now: () => clock.now, fetchImpl });
  return { app, clock, calls, capi: app.deps.capi, rows: () => app.db.prepare('SELECT * FROM meta_sends ORDER BY created_at, send_id').all().map((r) => ({ ...r })) };
}

// An ad click opened from a phone (fbclid, UA, referer, client IP through the proxy), then the join that carries it.
async function clickAndJoin(app, tg, { fbclid = 'IwAR0launch', ip = '203.0.113.77' } = {}) {
  const { token } = await app.mint({ brand: 'brand-one', campaign: 'META_LAUNCH', adset: 'broad', ad: 'v1' });
  await fetch(`${app.base}/c/${token}${fbclid ? `?fbclid=${fbclid}` : ''}`, { redirect: 'manual', headers: { 'user-agent': CHROME, 'x-forwarded-for': ip, referer: 'https://m.facebook.com/' } });
  const r = await (await app.join({ brand: 'brand-one', telegram_id: tg, click_id: token })).json();
  return { token, memberId: r.member_id };
}

// ---------- Part A: configuration ----------

test('A config: enabled with nothing else throws naming both variables; defaults; bounds', () => {
  assert.throws(() => loadConfig(testEnv({ META_CAPI_ENABLED: '1' })), /META_CAPI_ENABLED=1 requires META_DATASET_ID, META_CAPI_TOKEN/);
  assert.throws(() => loadConfig(testEnv({ META_CAPI_ENABLED: '1', META_DATASET_ID: DATASET })), /requires META_CAPI_TOKEN$/);
  const off = loadConfig(testEnv());
  assert.deepEqual({ ...off.meta }, { enabled: false, datasetId: null, token: null, version: 'v22.0', testEventCode: null, timeoutMs: 8000, maxTries: 5, batch: 50 });
  assert.ok(Object.isFrozen(off.meta));
  assert.equal(loadConfig(testEnv({ META_CAPI_TOKEN: TOKEN })).meta.token, null, 'disabled: the token is not even kept in config');
  assert.throws(() => loadConfig(testEnv({ META_API_VERSION: '22.0' })), /META_API_VERSION must look like v22.0/);
  assert.throws(() => loadConfig(testEnv({ META_API_VERSION: 'v22' })), /META_API_VERSION/);
  assert.equal(loadConfig(testEnv({ META_API_VERSION: 'v23.1' })).meta.version, 'v23.1');
  for (const bad of ['0', '1001', '2.5', 'x']) assert.throws(() => loadConfig(testEnv({ META_CAPI_BATCH: bad })), /META_CAPI_BATCH must be an integer 1-1000/, bad);
  assert.equal(loadConfig(testEnv({ META_CAPI_BATCH: '1000' })).meta.batch, 1000);
  assert.throws(() => loadConfig(testEnv({ META_CAPI_TIMEOUT_MS: '999' })), /META_CAPI_TIMEOUT_MS must be an integer >= 1000/);
  assert.throws(() => loadConfig(testEnv({ META_CAPI_MAX_TRIES: '0' })), /META_CAPI_MAX_TRIES must be an integer >= 1/);
  assert.throws(() => loadConfig(testEnv({ META_CAPI_ENABLED: 'yes' })), /META_CAPI_ENABLED must be 0 or 1/);
  const on = loadConfig(testEnv({ ...META_ENV, META_TEST_EVENT_CODE: 'TEST123' })).meta;
  assert.deepEqual([on.enabled, on.datasetId, on.testEventCode], [true, DATASET, 'TEST123']);
});

test('5 disabled: zero fetchImpl calls even with due rows in the table, and enqueue writes nothing', async () => {
  const { app, calls, capi, rows } = await capiApp({ META_CAPI_ENABLED: '0' });
  try {
    await clickAndJoin(app, 7000000001);
    await app.pb({ status: 'ftd', trader_id: '197000501', amount: '50', afftrack: '7000000001', event_id: 'ev-off' });
    assert.deepEqual(rows(), [], 'no invisible backlog');
    app.db.prepare("INSERT INTO meta_sends (send_id, kind, ref, brand_id, created_at) VALUES ('join:1:7000000001', 'lead', '1', 1, 0)").run();
    assert.deepEqual(await capi.drain(1000), { sent: 0, failed: 0, retry: 0, skipped: 0 });
    const worker = createWorker(Object.assign(app.deps, { reportConfig: loadReportConfig({}) }));
    await worker.tick();
    assert.equal(calls.length, 0);
    assert.equal(rows()[0].state, 'pending', 'untouched');
  } finally { await app.close(); }
});

// ---------- Part C: mapping and payload ----------

test('1 mapping: join -> Lead/chat, reg -> CompleteRegistration, ftd/dep -> Purchase (website); ignored -> no row', async () => {
  assert.deepEqual(KIND_FOR_EVENT, { reg: 'registration', ftd: 'purchase', dep: 'purchase' });
  const { app, calls, capi, rows } = await capiApp();
  try {
    await clickAndJoin(app, 7000000001);
    await app.pb({ status: 'reg', trader_id: '197000501', afftrack: '7000000001', event_id: 'ev-reg' });
    await app.pb({ status: 'ftd', trader_id: '197000501', amount: '50', currency: 'USD', afftrack: '7000000001', event_id: 'ev-ftd' });
    await app.pb({ status: 'dep', trader_id: '197000501', amount: '20.5', afftrack: '7000000001', event_id: 'ev-dep' });
    await app.pb({ status: 'ftd', trader_id: '1', amount: '10', event_id: 'ev-stub' }); // stub guard -> ignored
    await app.pb({ status: 'bonus', trader_id: '197000501', event_id: 'ev-bad' }); // unknown status -> ignored
    assert.deepEqual(rows().map((r) => [r.send_id, r.kind, r.state]).sort(), [
      ['evt:ev-dep', 'purchase', 'pending'], ['evt:ev-ftd', 'purchase', 'pending'], ['evt:ev-reg', 'registration', 'pending'],
      ['join:1:7000000001', 'lead', 'pending'], ['join_sub:1:7000000001', 'subscribe', 'pending']
    ]);
    const r = await capi.drain(1000);
    assert.deepEqual(r, { sent: 5, failed: 0, retry: 0, skipped: 0 });
    assert.equal(calls.length, 1);
    const byId = Object.fromEntries(calls[0].body.data.map((e) => [e.event_id, e]));
    assert.deepEqual(Object.values(byId).map((e) => [e.event_id, e.event_name, e.action_source]).sort(), [
      ['evt:ev-dep', 'Purchase', 'website'], ['evt:ev-ftd', 'Purchase', 'website'], ['evt:ev-reg', 'CompleteRegistration', 'website'],
      [J(7000000001), 'Lead', 'chat'], [J(7000000001).replace('join:', 'join_sub:'), 'Subscribe', 'website']
    ]);
    assert.deepEqual(byId['evt:ev-ftd'].custom_data, { value: 50, currency: 'USD' });
    assert.deepEqual(byId['evt:ev-dep'].custom_data, { value: 20.5, currency: 'USD' });
    assert.equal(byId['evt:ev-reg'].custom_data, undefined);
    assert.equal(byId[J(7000000001)].custom_data, undefined);
    assert.deepEqual(Object.keys(META_EVENTS), ['lead', 'registration', 'purchase', 'subscribe']);
  } finally { await app.close(); }
});

test('event_time is joined_at / received_at in seconds (never now); event_id is the send_id; URL, version and test_event_code', async () => {
  const { app, clock, calls, capi } = await capiApp({ META_TEST_EVENT_CODE: 'TEST77', META_API_VERSION: 'v21.0' });
  try {
    const { memberId } = await clickAndJoin(app, 7000000001);
    await app.pb({ status: 'ftd', trader_id: '197000501', amount: '50', afftrack: '7000000001', event_id: 'ev-ftd' });
    const joinedAt = app.db.prepare('SELECT joined_at FROM members WHERE id = ?').get(memberId).joined_at;
    const receivedAt = app.db.prepare("SELECT received_at FROM events WHERE event_id = 'ev-ftd'").get().received_at;
    clock.now += 3 * 3600 * 1000; // sent three hours later: times do not move
    await capi.drain(1000);
    const ev = Object.fromEntries(calls[0].body.data.map((e) => [e.event_id, e]));
    assert.equal(ev[J(7000000001)].event_time, Math.floor(joinedAt / 1000));
    assert.equal(ev['evt:ev-ftd'].event_time, Math.floor(receivedAt / 1000));
    assert.equal(calls[0].body.test_event_code, 'TEST77');
    assert.equal(calls[0].url, `https://graph.facebook.com/v21.0/${DATASET}/events?access_token=${TOKEN}`);
  } finally { await app.close(); }
});

test('2 fbc = fb.1.<clicks.created_at ms>.<fbclid> from the bound click; absent when the click has no fbclid', async () => {
  const { app, calls, capi } = await capiApp();
  try {
    const a = await clickAndJoin(app, 7000000001, { fbclid: 'IwAR0abc' });
    await clickAndJoin(app, 6622587978, { fbclid: null });
    const createdAt = app.db.prepare('SELECT created_at FROM clicks WHERE click_id = ?').get(a.token).created_at;
    await capi.drain(1000);
    const ev = Object.fromEntries(calls[0].body.data.map((e) => [e.event_id, e]));
    assert.equal(ev[J(7000000001)].user_data.fbc, `fb.1.${createdAt}.IwAR0abc`);
    assert.ok(!('fbc' in ev[J(6622587978)].user_data));
    assert.equal(fbcFor({ created_at: 1763387171000, fbclid: 'X' }), 'fb.1.1763387171000.X');
    assert.equal(fbcFor({ created_at: 1, fbclid: null }), null);
    assert.equal(fbcFor(null), null);
    assert.ok(!('fbp' in ev[J(7000000001)].user_data), 'fbp is never invented');
  } finally { await app.close(); }
});

test('3 external_id: sha256("coinvoo:" + telegram id) — same across runs, different for another id, never the raw id', async () => {
  const first = externalId(7000000001);
  assert.equal(first, externalId('7000000001'));
  assert.notEqual(first, externalId(6622587978));
  assert.match(first, /^[0-9a-f]{64}$/);
  const seen = [];
  for (let run = 0; run < 2; run++) {
    const { app, calls, capi } = await capiApp();
    try {
      await clickAndJoin(app, 7000000001);
      await capi.drain(1000);
      seen.push(calls[0].body.data[0].user_data.external_id);
      assert.ok(!JSON.stringify(calls[0].body).includes('7000000001'), 'the Telegram id itself never leaves');
    } finally { await app.close(); }
  }
  assert.deepEqual(seen, [first, first]);
  assert.equal(metaEventId({ kind: 'lead', send_id: 'join:1:7000000001' }, { telegram_id: 7000000001 }), J(7000000001), 'a join goes out under a hashed event_id');
  assert.equal(metaEventId({ kind: 'purchase', send_id: 'evt:ev-1' }, null), 'evt:ev-1', 'an event goes out under its send_id');
});

test('4 ip_hash never appears in any payload; ip_raw is sent when set and omitted when not', async () => {
  const { app, calls, capi } = await capiApp();
  try {
    const a = await clickAndJoin(app, 7000000001, { ip: '198.51.100.23' });
    const b = await clickAndJoin(app, 6622587978);
    app.db.prepare('UPDATE clicks SET ip_raw = NULL WHERE click_id = ?').run(b.token);
    await app.pb({ status: 'ftd', trader_id: '197000501', amount: '50', afftrack: '7000000001', event_id: 'ev-ftd', country_code: 'ng' });
    await capi.drain(1000);
    const hashes = app.db.prepare('SELECT ip_hash FROM clicks').all().map((r) => r.ip_hash);
    const body = JSON.stringify(calls[0].body);
    for (const h of hashes) assert.ok(!body.includes(h), 'ip_hash value not in the payload');
    assert.ok(!/ip_hash/.test(body));
    const ev = Object.fromEntries(calls[0].body.data.map((e) => [e.event_id, e]));
    assert.equal(ev[J(7000000001)].user_data.client_ip_address, '198.51.100.23');
    assert.ok(!('client_ip_address' in ev[J(6622587978)].user_data));
    assert.deepEqual(Object.keys(ev['evt:ev-ftd'].user_data), ['external_id', 'fbc', 'client_user_agent', 'client_ip_address', 'country']);
    assert.equal(ev['evt:ev-ftd'].user_data.client_user_agent, CHROME);
    assert.match(ev['evt:ev-ftd'].user_data.country, /^[0-9a-f]{64}$/, 'country hashed per Meta spec');
    assert.equal(ev['evt:ev-ftd'].event_source_url, 'https://m.facebook.com/');
    void a;
  } finally { await app.close(); }
});

test('skips: no user data, non-positive amount, older than 7 days; click-less goes out as system_generated', async () => {
  const { app, capi, calls, rows } = await capiApp();
  try {
    const now = Date.now();
    const db = app.db;
    // a purchase whose member has no click: no UA -> skipped rather than failing the whole batch
    const mid = app.member(5001);
    const ev = db.prepare("INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, matched_member_id, matched_at, forward_state) VALUES (?, 1, 'affstore', ?, ?, '197000900', ?, 'USD', '{}', ?, 'matched', ?, ?, 'skipped')");
    ev.run('noua', 'ftd', 'ftd', 10, now, mid, now);
    ev.run('zero', 'dep', 'dep', 0, now, mid, now);
    ev.run('nomember', 'reg', 'reg', null, now, null, now);
    const q = db.prepare("INSERT INTO meta_sends (send_id, kind, ref, brand_id, created_at) VALUES (?, ?, ?, 1, ?)");
    q.run('evt:noua', 'purchase', 'noua', now); q.run('evt:zero', 'purchase', 'zero', now); q.run('evt:nomember', 'registration', 'nomember', now);
    db.prepare("UPDATE members SET joined_at = ? WHERE id = ?").run(now - 8 * 86400000, mid);
    q.run(`join:1:5001`, 'lead', String(mid), now);
    // A click-less conversion is still real: it goes out as system_generated rather than being dropped.
    assert.deepEqual(await capi.drain(1000), { sent: 1, failed: 0, retry: 0, skipped: 3 });
    assert.equal(calls.length, 1);
    const [sent] = calls[0].body.data;
    assert.equal(sent.event_id, 'evt:noua');
    assert.equal(sent.action_source, 'system_generated', 'no user agent -> system_generated');
    assert.ok(sent.user_data.external_id, 'still identified by external_id');
    assert.ok(!('client_user_agent' in sent.user_data));
    assert.ok(!('event_source_url' in sent), 'no click -> no source url');
    assert.deepEqual(Object.fromEntries(rows().map((r) => [r.send_id, r.state])), {
      'evt:noua': 'sent', 'evt:zero': 'skipped', 'evt:nomember': 'skipped', 'join:1:5001': 'skipped'
    });
    assert.deepEqual(Object.fromEntries(rows().filter((r) => r.state === 'skipped').map((r) => [r.send_id, r.resp])), {
      'evt:zero': 'bad_amount', 'evt:nomember': 'no_user_data', 'join:1:5001': 'too_old'
    });
    assert.deepEqual(buildEvent(db, { kind: 'purchase', ref: 'missing', send_id: 'evt:missing' }, { now }), { skip: 'no_event' });
  } finally { await app.close(); }
});

// ---------- Part C4: the state machine ----------

test('6 200 marks sent with sent_at; a second drain sends nothing (dedup by send_id)', async () => {
  const { app, clock, calls, capi, rows } = await capiApp();
  try {
    await clickAndJoin(app, 7000000001);
    assert.deepEqual(await capi.drain(1000), { sent: 2, failed: 0, retry: 0, skipped: 0 });
    const r = rows()[0];
    assert.deepEqual([r.state, r.sent_at, r.tries], ['sent', clock.now, 1]);
    assert.match(r.resp, /"events_received":\d+/);
    clock.now += 2 * 3600 * 1000;
    assert.deepEqual(await capi.drain(1000), { sent: 0, failed: 0, retry: 0, skipped: 0 });
    // the same member joining again, and the same event re-matched, cannot queue a second send
    await app.join({ brand: 'brand-one', telegram_id: 7000000001 });
    app.deps.capi.enqueueJoin(app.db, { id: 1, brand_id: 1, telegram_id: 7000000001 }, clock.now);
    assert.equal(rows().length, 2);
    assert.equal(calls.length, 1);
    assert.equal(app.db.prepare('SELECT COUNT(DISTINCT send_id) AS d, COUNT(*) AS n FROM meta_sends').get().n, 2);
  } finally { await app.close(); }
});

test('7 500 -> tries=1, next_at in the future, still pending; at META_CAPI_MAX_TRIES -> failed', async () => {
  const fail = () => new Response('{"error":{"message":"Service temporarily unavailable","code":2}}', { status: 500 });
  const { app, clock, calls, capi, rows } = await capiApp({ META_CAPI_MAX_TRIES: '3' }, [fail(), fail(), fail()]);
  try {
    await clickAndJoin(app, 7000000001);
    const t0 = clock.now;
    assert.deepEqual(await capi.drain(1000), { sent: 0, failed: 0, retry: 2, skipped: 0 });
    let r = rows()[0];
    assert.deepEqual([r.state, r.tries, r.next_at], ['pending', 1, t0 + MIN], '1 minute');
    assert.match(r.resp, /^500 /);
    assert.deepEqual(await capi.drain(1000), { sent: 0, failed: 0, retry: 0, skipped: 0 }, 'not due yet');
    assert.equal(calls.length, 1);
    clock.now = t0 + MIN;
    await capi.drain(1000);
    r = rows()[0];
    assert.deepEqual([r.state, r.tries, r.next_at], ['pending', 2, clock.now + 2 * MIN], '2 minutes');
    clock.now += 2 * MIN;
    assert.deepEqual(await capi.drain(1000), { sent: 0, failed: 2, retry: 0, skipped: 0 });
    r = rows()[0];
    assert.deepEqual([r.state, r.tries, r.next_at], ['failed', 3, null]);
    clock.now += 3600 * 1000;
    await capi.drain(1000);
    assert.equal(calls.length, 3, 'a failed row is never retried');
  } finally { await app.close(); }
});

test('7b 429 retries; a 200 that did not take every event retries too', async () => {
  const { app, clock, capi, rows } = await capiApp({}, [
    new Response('{"error":{"message":"rate"}}', { status: 429 }),
    new Response('{"events_received":0}', { status: 200 }),
    'ok'
  ]);
  try {
    await clickAndJoin(app, 7000000001);
    await capi.drain(1000);
    assert.equal(rows()[0].tries, 1);
    clock.now += MIN; await capi.drain(1000);
    assert.deepEqual([rows()[0].state, rows()[0].tries], ['pending', 2]);
    clock.now += 2 * MIN; await capi.drain(1000);
    assert.equal(rows()[0].state, 'sent');
  } finally { await app.close(); }
});

test('8 400 with error_user_msg -> failed at once, message stored, token absent from resp and logs', async () => {
  const bad = () => new Response(JSON.stringify({ error: {
    message: `Invalid parameter (token ${TOKEN})`, type: 'OAuthException', code: 100, error_subcode: 2804003,
    error_user_msg: `The event time is too old. Request was /events?access_token=${TOKEN}`
  } }), { status: 400 });
  const { app, calls, capi, rows } = await capiApp({}, [bad()]);
  try {
    await clickAndJoin(app, 7000000001);
    const lines = await captureLogs(async () => {
      assert.deepEqual(await capi.drain(1000), { sent: 0, failed: 2, retry: 0, skipped: 0 });
    });
    const r = rows()[0];
    assert.equal(r.state, 'failed');
    assert.equal(r.tries, 1);
    assert.equal(r.resp, '400 The event time is too old. Request was /events?access_token=[redacted]');
    assert.ok(!r.resp.includes(TOKEN));
    assert.ok(!lines.join('\n').includes(TOKEN), lines.join('\n'));
    await capi.drain(1000);
    assert.equal(calls.length, 1, 'not retried');
  } finally { await app.close(); }
});

test('9 a throwing fetchImpl never rejects drain (and the error text is scrubbed)', async () => {
  const { app, capi, rows } = await capiApp({}, ['throw']);
  try {
    await clickAndJoin(app, 7000000001);
    const r = await capi.drain(1000);
    assert.deepEqual(r, { sent: 0, failed: 0, retry: 2, skipped: 0 });
    assert.equal(rows()[0].state, 'pending');
    assert.ok(!rows()[0].resp.includes(TOKEN));
    assert.match(rows()[0].resp, /^error: connect ECONNRESET .*access_token=\[redacted\]/);
    // a database failure inside drain does not reject either
    const real = app.db.prepare.bind(app.db);
    app.db.prepare = (sql) => { if (/meta_sends/.test(sql)) throw new Error('database is locked'); return real(sql); };
    const lines = await captureLogs(async () => { assert.deepEqual(await capi.drain(1000), { sent: 0, failed: 0, retry: 0, skipped: 0 }); });
    assert.ok(lines.some((l) => l.startsWith('[coinvoo] ERROR meta drain:')));
    app.db.prepare = real;
  } finally { await app.close(); }
});

test('10 batch: 120 pending rows with META_CAPI_BATCH=50 -> three calls of 50, 50, 20', async () => {
  const { app, calls, capi, rows } = await capiApp({ META_CAPI_BATCH: '50' });
  try {
    const now = Date.now();
    for (let i = 0; i < 120; i++) {
      const tg = 700000 + i;
      const id = app.member(tg);
      app.deps.capi.enqueueJoin(app.db, { id, brand_id: 1, telegram_id: tg }, now + i);
    }
    assert.deepEqual(await capi.drain(1000), { sent: 240, failed: 0, retry: 0, skipped: 0 });
    assert.deepEqual(calls.map((c) => c.body.data.length), [50, 50, 50, 50, 40]);
    assert.equal(calls[0].body.data[0].event_id, J(700000), 'oldest first');
    assert.equal(rows().filter((r) => r.state === 'sent').length, 240);
  } finally { await app.close(); }
});

test('the worker drains one batch per tick and logs meta=<sent> in its summary', async () => {
  const { app, calls } = await capiApp({ META_CAPI_BATCH: '2' });
  try {
    for (const tg of [801, 802, 803]) app.deps.capi.enqueueJoin(app.db, { id: app.member(tg), brand_id: 1, telegram_id: tg }, Date.now());
    app.deps.reportConfig = loadReportConfig({});
    const w = createWorker(app.deps);
    const lines = await captureLogs(async () => { await w.tick(); await w.flush(); });
    assert.equal(calls.length, 1);
    assert.ok(lines.some((l) => /^\[coinvoo\] worker tick .* meta=2 rolled_up=/.test(l)), lines.join('|'));
    assert.ok(lines.includes('[coinvoo] meta drain sent=2 failed=0 retry=0 skipped=0'));
    await w.tick(); await w.flush();
    assert.equal(calls.length, 2);
  } finally { await app.close(); }
});

// ---------- Part D: wiring ----------

test('11 a postback for an unmatched event creates no row; the re-match after the join creates exactly one', async () => {
  const { app, capi, calls, rows } = await capiApp();
  try {
    const r = await app.pb({ status: 'ftd', trader_id: '197000777', amount: '40', afftrack: '6622587999', event_id: 'ev-late' });
    assert.equal(r.matched, false);
    assert.deepEqual(rows(), []);
    await clickAndJoin(app, 6622587999); // the member arrives; onMemberSeen re-runs the parked event
    assert.ok(await until(() => rows().some((x) => x.send_id === 'evt:ev-late')), 'queued on the matched transition');
    assert.deepEqual(rows().map((x) => x.send_id).sort(), ['evt:ev-late', 'join:1:6622587999', 'join_sub:1:6622587999']);
    await capi.drain(1000);
    assert.equal(calls[0].body.data.length, 3);
  } finally { await app.close(); }
});

test('12 recordJoin returns its normal result when the enqueue throws', async () => {
  const app = await startApp();
  try {
    const capi = { enqueueJoin() { throw new Error('meta_sends is gone'); } };
    let r;
    const lines = await captureLogs(() => { r = recordJoin(app.db, { brandId: 1, telegramId: 9123, source: 'bot:start', capi }); });
    assert.deepEqual(r, { memberId: r.memberId, created: true, clickId: null, rejoin: false });
    assert.ok(Number.isInteger(r.memberId));
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM members WHERE telegram_id = 9123').get().n, 1);
    assert.ok(lines.some((l) => l.startsWith('[coinvoo] ERROR join meta enqueue: Error: meta_sends is gone')));
    // and over HTTP: the join still answers 200 when the queue table is missing
    const meta = await capiApp();
    try {
      meta.app.db.exec('DROP TABLE meta_sends');
      const res = await captureLogs(async () => { const x = await meta.app.join({ brand: 'brand-one', telegram_id: 9124 }); assert.equal(x.status, 200); });
      assert.ok(res.some((l) => l.startsWith('[coinvoo] ERROR join meta enqueue')));
      const pb = await captureLogs(async () => { const x = await meta.app.pb({ status: 'reg', trader_id: '197000555', afftrack: '9124', event_id: 'ev-x' }); assert.equal(x.matched, true); });
      assert.ok(pb.some((l) => l.startsWith('[coinvoo] ERROR match meta enqueue')), 'the match stands');
    } finally { await meta.app.close(); }
  } finally { await app.close(); }
});

// ---------- acceptance: no other path builds a Meta URL; the token is never logged ----------

test('only src/capi.js builds a Meta URL, and nothing in src logs config.meta.token', () => {
  const dir = new URL('../src/', import.meta.url);
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const u = new URL(e.name + (e.isDirectory() ? '/' : ''), d); if (e.isDirectory()) walk(u); else if (e.name.endsWith('.js')) files.push(u); } };
  walk(dir);
  const withGraph = files.filter((f) => readFileSync(f, 'utf8').includes('graph.facebook.com')).map((f) => f.pathname.split('/src/')[1]);
  assert.deepEqual(withGraph, ['capi.js']);
  // The token is read in exactly one place, and no log call in that file mentions it.
  const readers = files.filter((f) => /(cfg|meta)\.token/.test(readFileSync(f, 'utf8'))).map((f) => f.pathname.split('/src/')[1]);
  assert.deepEqual(readers, ['capi.js']);
  const capiSrc = readFileSync(new URL('../src/capi.js', import.meta.url), 'utf8');
  for (const line of capiSrc.split('\n').filter((l) => /log\.(info|error)\(/.test(l))) assert.ok(!/token/i.test(line), line);
});

// ---------- acceptance 4: restart mid-queue resumes; nothing is sent twice ----------

test('restart mid-queue resumes; two drains at once (service + backfill) never send a row twice', async () => {
  const { createCapi } = await import('../src/capi.js');
  const { app, clock, calls, rows } = await capiApp({ META_CAPI_BATCH: '10' });
  try {
    for (let i = 0; i < 25; i++) app.deps.capi.enqueueJoin(app.db, { id: app.member(900 + i), brand_id: 1, telegram_id: 900 + i }, Date.now() + i);
    const other = createCapi(app.deps); // a second process on the same database
    const [a, b] = await Promise.all([app.deps.capi.drain(15), other.drain(15)]);
    assert.equal(a.sent + b.sent, 30);
    const sentIds = calls.flatMap((c) => c.body.data.map((e) => e.event_id));
    assert.equal(sentIds.length, 30);
    assert.equal(new Set(sentIds).size, 30, 'no event_id sent twice');
    await app.deps.capi.drain(100); // flush the rest so only the leased pair is left to consider
    // a row claimed by a process that died before the POST: untouched until the lease runs out, then sent once
    app.deps.capi.enqueueJoin(app.db, { id: app.member(990), brand_id: 1, telegram_id: 990 }, Date.now());
    app.db.prepare("UPDATE meta_sends SET next_at = ? WHERE send_id IN ('join:1:990','join_sub:1:990')").run(clock.now + 68000);
    const restarted = createCapi(app.deps);
    assert.equal((await restarted.drain(100)).sent, 0, 'still leased');
    clock.now += 69000;
    assert.equal((await restarted.drain(100)).sent, 2);
    assert.equal(rows().filter((r) => r.state === 'sent').length, 52);
    assert.equal(calls.reduce((n, c) => n + c.body.data.length, 0), 52);
  } finally { await app.close(); }
});

// ---------- Part G: scripts/meta-backfill.js ----------

test('G meta-backfill: dry run by default (counts, no writes, no network); --send enqueues, drains, never repeats', async () => {
  const { metaBackfill, formatResult } = await import('../scripts/meta-backfill.js');
  const { app, calls, rows } = await capiApp({ META_CAPI_ENABLED: '0' }); // the service had it off: nothing queued
  try {
    await clickAndJoin(app, 7000000001);
    for (const [id, kind, amt] of [['b-reg', 'reg', null], ['b-ftd', 'ftd', '50'], ['b-dep', 'dep', '25']]) {
      await app.pb({ status: kind, trader_id: '197000501', afftrack: '7000000001', event_id: id, ...(amt ? { amount: amt } : {}) });
    }
    await app.pb({ status: 'dep', trader_id: '197000999', amount: '9', event_id: 'b-parked' }); // not matched: never sent
    assert.deepEqual(rows(), []);
    const today = new Date(Date.now() + 3600000).toISOString().slice(0, 10);
    const offCfg = app.deps.config;
    const dry = await metaBackfill({ db: app.db, config: offCfg, since: today });
    assert.deepEqual(dry, { would_send: 3, sent: 0, failed: 0, skipped: 0, already_queued: 0, retry_pending: 0, reasons: {} });
    assert.deepEqual(rows(), [], 'dry run writes nothing');
    assert.equal(calls.length, 0, 'dry run sends nothing');
    assert.match(formatResult(dry, { send: false }), /^\[coinvoo\] meta backfill mode=dry-run would_send=3 sent=0 failed=0 skipped=0 /);
    await assert.rejects(metaBackfill({ db: app.db, config: offCfg, since: today, send: true }), /--send needs META_CAPI_ENABLED=1/);
    const onCfg = loadConfig(testEnv(META_ENV));
    const fetchImpl = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return ok200(init); };
    const sent = await metaBackfill({ db: app.db, config: onCfg, since: today, send: true, fetchImpl });
    assert.deepEqual([sent.would_send, sent.sent, sent.failed], [3, 3, 0]);
    assert.deepEqual(calls[0].body.data.map((e) => e.event_id).sort(), ['evt:b-dep', 'evt:b-ftd', 'evt:b-reg']);
    const again = await metaBackfill({ db: app.db, config: onCfg, since: today, send: true, fetchImpl });
    assert.deepEqual([again.would_send, again.sent, again.already_queued], [0, 0, 3], 'a second run sends nothing');
    assert.equal(calls.length, 1);
    await assert.rejects(metaBackfill({ db: app.db, config: onCfg, since: '16-11-2026' }), /--since must be YYYY-MM-DD/);
  } finally { await app.close(); }
});
