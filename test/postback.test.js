import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, makeSnapshot, invariants, allZero, captureLogs, until } from './helpers.js';
import { createWorker } from '../src/worker.js';
import { classify } from '../src/routes/postback.js';

const ev = (app, id) => app.db.prepare('SELECT * FROM events WHERE event_id = ?').get(id);

test('status mapping: every synonym -> its kind; anything else -> ignored/bad_kind', () => {
  const base = { trader_id: '197000001', amount: 10 };
  const kinds = {
    reg: 'reg', registration: 'reg', register: 'reg', signup: 'reg', SignUp: 'reg',
    ftd: 'ftd', first_deposit: 'ftd', firstdeposit: 'ftd',
    dep: 'dep', redep: 'dep', deposit: 'dep', repeat_deposit: 'dep', redeposit: 'dep'
  };
  for (const [status, kind] of Object.entries(kinds)) assert.deepEqual(classify({ ...base, status }), { kind, reason: null }, status);
  for (const status of ['', 'refund', 'chargeback', undefined, null]) {
    assert.deepEqual(classify({ ...base, status }), { kind: 'ignored', reason: 'bad_kind' }, String(status));
  }
});

test('receiver: GET, POST form and POST JSON land as the same event shape; raw payload preserved verbatim', async () => {
  const app = await startApp();
  try {
    app.member(8001);
    const q = { status: 'ftd', net: 'affstore', trader_id: '197100001', amount: '50.5', currency: 'usd', country_code: 'NG', event_id: 'g1', afftrack: '8001', aff_model: 'revenue', weird_param: 'keep me' };
    let r = await app.pb(q);
    assert.deepEqual([r.ok, r.duplicate, r.matched, r.path], [true, false, true, 'afftrack']);

    // Distinct traders: identical trader/kind/amount inside 120 s would (correctly) be a soft duplicate.
    r = await (await fetch(`${app.base}/api/aff`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...q, event_id: 'g2', trader_id: '197100002' }) })).json();
    assert.equal(r.matched, true);
    r = await (await fetch(`${app.base}/api/aff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...q, event_id: 'g3', trader_id: 197100003, amount: 50.5, nested: { a: 1 } }) })).json();
    assert.equal(r.matched, true);

    for (const id of ['g1', 'g2', 'g3']) {
      const row = ev(app, id);
      assert.deepEqual([row.kind, row.amount, row.currency, row.country, row.network, row.state, row.status_raw],
        ['ftd', 50.5, 'USD', 'NG', 'affstore', 'matched', 'ftd'], id);
      assert.equal(JSON.parse(row.payload_json).weird_param, 'keep me', 'unknown parameters are preserved');
    }
    assert.deepEqual(JSON.parse(ev(app, 'g3').payload_json).nested, { a: 1 });
    assert.equal(JSON.parse(ev(app, 'g1').payload_json).aff_model, 'revenue');
  } finally {
    await app.close();
  }
});

test('receiver: missing event_id is generated; an empty request is 400; bad status is stored as ignored/bad_kind', async () => {
  const app = await startApp();
  try {
    const r = await app.pb({ status: 'dep', trader_id: '197100002', amount: '5' });
    assert.match(r.event_id, /^[0-9a-f-]{36}$/);
    assert.equal(ev(app, r.event_id).state, 'parked');

    const empty = await fetch(`${app.base}/api/aff`);
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, 'bad_params');
    const bad = await fetch(`${app.base}/api/aff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);

    assert.deepEqual(await app.pb({ status: 'refund', trader_id: '197100003', event_id: 'bk1' }), { ok: true, ignored: 'bad_kind' });
    const row = ev(app, 'bk1');
    assert.deepEqual([row.state, row.ignore_reason, row.kind], ['ignored', 'bad_kind', 'ignored']);
    assert.deepEqual(await app.pb({ trader_id: '197100003', event_id: 'bk2' }), { ok: true, ignored: 'bad_kind' }, 'no status at all');
  } finally {
    await app.close();
  }
});

test('hard duplicate: same event_id twice -> duplicate:true, one row, no second decision or forward', async () => {
  const sent = [];
  const app = await startApp({ PARALLEL_FORWARD: '1', JOINVOO_PB: 'https://joinvoo.example/pb/x' }, { fetchImpl: async (u) => { sent.push(u); return new Response('ok'); } });
  try {
    app.member(8100);
    const q = { status: 'ftd', trader_id: '197100010', amount: '50', event_id: 'hd1', afftrack: '8100' };
    assert.equal((await app.pb(q)).matched, true);
    assert.deepEqual(await app.pb(q), { ok: true, event_id: 'hd1', duplicate: true });
    assert.deepEqual(await app.pb(q), { ok: true, event_id: 'hd1', duplicate: true });
    await until(() => ev(app, 'hd1').forward_state === 'sent');
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_id = 'hd1'").get().n, 1);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM attributions WHERE event_id = 'hd1'").get().n, 1);
    assert.equal(sent.length, 1);
  } finally {
    await app.close();
  }
});

test('soft duplicate: same trader/kind/amount within 120 s under another event_id is stored as ignored/duplicate_soft', async () => {
  let t = Date.now();
  const app = await startApp({}, { now: () => t });
  try {
    app.member(8200);
    const base = { status: 'dep', trader_id: '197100020', amount: '10', afftrack: '8200' };
    assert.equal((await app.pb({ ...base, event_id: 'sd1' })).matched, true);
    t += 60 * 1000;
    assert.deepEqual(await app.pb({ ...base, event_id: 'sd2' }), { ok: true, ignored: 'duplicate_soft' });
    assert.equal(ev(app, 'sd2').state, 'ignored');
    assert.equal(ev(app, 'sd2').matched_member_id, null);
    t += 61 * 1000; // 121 s after the first
    assert.equal((await app.pb({ ...base, event_id: 'sd3' })).matched, true, 'a genuine second deposit later is kept');
    assert.equal((await app.pb({ ...base, amount: '11', event_id: 'sd4' })).matched, true, 'a different amount is not a duplicate');
    const s = await (await fetch(`${app.base}/api/aff/stats`)).json();
    assert.equal(s.events.dep, 3);
    assert.equal(s.events.ignored, 1);
    assert.ok(allZero(invariants(app.db)));
  } finally {
    await app.close();
  }
});

test('matcher failure: the raw event is already stored, the network still gets 200, the worker decides it later', async () => {
  let broken = true;
  const snapshot = {
    lookupByTrader() { if (broken) throw new Error('snapshot exploded'); return []; },
    lookupByTelegram() { return []; }, checkFreshness() { return {}; }, close() {}
  };
  const app = await startApp({}, { snapshot });
  const worker = createWorker(app.deps);
  try {
    let r;
    await captureLogs(async (lines) => {
      r = await app.pb({ status: 'ftd', trader_id: '197100030', amount: '5', event_id: 'mf1' });
      assert.ok(lines.some((l) => l.startsWith('[coinvoo] ERROR POST /api/aff match')), 'logged loudly');
    });
    assert.deepEqual([r.ok, r.matched, r.path], [true, false, 'deferred']);
    assert.equal(ev(app, 'mf1').state, 'new', 'row survives, undecided');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM attributions').get().n, 0);

    broken = false;
    const s = await worker.tick();
    assert.equal(ev(app, 'mf1').state, 'parked');
    assert.equal(s.parked, 1);
  } finally {
    await app.close();
  }
});

test('forward: params are the resolved Telegram id and the event fields; failure never touches the attribution; retry with backoff', async () => {
  let t = Date.now();
  let up = false;
  const urls = [];
  const fetchImpl = async (u) => {
    urls.push(new URL(u));
    if (!up) throw new Error('network down');
    return new Response('OK', { status: 200 });
  };
  const app = await startApp({ PARALLEL_FORWARD: '1', JOINVOO_PB: 'https://joinvoo.example/pb/placeholder?k=v' }, { now: () => t, fetchImpl });
  const worker = createWorker(app.deps);
  try {
    const m = app.member(8300);
    await app.pb({ status: 'ftd', net: 'affstore', trader_id: '197100040', amount: '50', country_code: 'NG', event_id: 'fw1', afftrack: '8300', clickid: 'ignored_by_us' });
    // clickid 'ignored_by_us' is not a member click id, so afftrack decides.
    assert.equal(await until(() => ev(app, 'fw1').forward_state === 'failed'), true);
    let row = ev(app, 'fw1');
    assert.deepEqual([row.state, row.matched_member_id, row.forward_tries], ['matched', m, 1], 'the attribution is untouched by the failure');
    assert.equal(row.forward_next_at, t + 60 * 1000, 'first backoff step is 1 minute');
    assert.match(row.forward_resp, /network down/);
    const u = urls[0];
    assert.equal(u.origin + u.pathname, 'https://joinvoo.example/pb/placeholder');
    assert.equal(u.searchParams.get('k'), 'v');
    assert.deepEqual(['status', 'net', 'afftrack', 'event_id', 'trader_id', 'amount', 'country_code'].map((k) => u.searchParams.get(k)),
      ['ftd', 'affstore', '8300', 'fw1', '197100040', '50', 'NG']);
    assert.equal(u.searchParams.get('clickid'), null);

    // Not due yet: a tick does nothing.
    let s = await worker.tick();
    assert.equal(s.forwards, 0);
    // Due, still down: failed again, 2 minute wait.
    t += 61 * 1000;
    s = await worker.tick();
    assert.equal(s.forwards, 1);
    row = ev(app, 'fw1');
    assert.deepEqual([row.forward_state, row.forward_tries, row.forward_next_at], ['failed', 2, t + 120 * 1000]);
    // Network back, due: sent.
    up = true;
    t += 121 * 1000;
    s = await worker.tick();
    row = ev(app, 'fw1');
    assert.deepEqual([row.forward_state, row.forward_tries, row.forward_next_at], ['sent', 3, null]);
    assert.match(row.forward_resp, /^200 OK/);
    // Sent is final.
    t += 3600 * 1000;
    assert.equal((await worker.tick()).forwards, 0);
  } finally {
    await app.close();
  }
});

test('forward: PARALLEL_FORWARD off -> events are marked skipped and nothing is sent', async () => {
  const sent = [];
  const app = await startApp({}, { fetchImpl: async (u) => { sent.push(u); return new Response('ok'); } });
  try {
    app.member(8400);
    await app.pb({ status: 'ftd', trader_id: '197100050', amount: '5', event_id: 'off1', afftrack: '8400' });
    assert.equal(ev(app, 'off1').forward_state, 'skipped');
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 0);
  } finally {
    await app.close();
  }
});

test('join hook: a parked event is decided as soon as the member joins, and a bot-snapshot account is linked', async () => {
  const snap = makeSnapshot([{ telegram_id: 8500, iq_user_id: '197100060' }, { telegram_id: 8501, iq_user_id: '197100061' }]);
  const app = await startApp({ BOTDB_SNAPSHOT: snap.path });
  try {
    // Parked first: neither the afftrack member nor the account exists in `members` yet... the snapshot knows 8501 only via trader id.
    const r1 = await app.pb({ status: 'ftd', trader_id: '197100099', amount: '5', event_id: 'jh1', afftrack: '8500' });
    const r2 = await app.pb({ status: 'dep', trader_id: '197100061', amount: '7', event_id: 'jh2' });
    assert.deepEqual([r1.path, r2.path], ['parked', 'parked']);

    assert.equal((await app.join({ brand: 'brand-one', telegram_id: 8500, source: 'bot:start' })).status, 200);
    assert.equal(await until(() => ev(app, 'jh1').state === 'matched'), true, 'afftrack event decided on join');
    assert.equal(ev(app, 'jh2').state, 'parked');
    assert.equal(app.db.prepare("SELECT source FROM accounts WHERE iq_user_id = '197100060'").get().source, 'bot_db', 'account linked from the snapshot');

    assert.equal((await app.join({ brand: 'brand-one', telegram_id: 8501, source: 'bot:start' })).status, 200);
    assert.equal(await until(() => ev(app, 'jh2').state === 'matched'), true, 'trader_id event decided via the linked account');
    assert.equal(app.db.prepare("SELECT path FROM attributions WHERE event_id = 'jh2'").get().path, 'trader_id');
    assert.ok(allZero(invariants(app.db)), JSON.stringify(invariants(app.db)));
  } finally {
    await app.close();
    snap.cleanup();
  }
});

test('stats and health expose event counters', async () => {
  const app = await startApp();
  try {
    app.member(8600);
    await app.pb({ status: 'reg', trader_id: '197100070', event_id: 'st1', afftrack: '8600' });
    await app.pb({ status: 'ftd', trader_id: '197100070', amount: '40', event_id: 'st2', afftrack: '8600' });
    await app.pb({ status: 'dep', trader_id: '197100071', amount: '15', event_id: 'st3' });
    await app.pb({ status: 'ftd', trader_id: '1', amount: '99', event_id: 'st4' });
    const s = await (await fetch(`${app.base}/api/aff/stats`, { headers: { authorization: app.auth } })).json();
    assert.deepEqual(s.events, { total: 4, reg: 1, ftd: 1, dep: 1, matched: 2, parked: 1, expired: 0, ignored: 1 });
    assert.deepEqual(s.revenue, { matched_usd: 40, unattributed_usd: 15 });
    // Phase 10: money is not a public counter. Anonymous (or wrong-password) callers get the counters, no revenue.
    const anon = await (await fetch(`${app.base}/api/aff/stats`)).json();
    assert.deepEqual(anon.events, s.events);
    assert.equal(anon.revenue, undefined);
    const wrong = await (await fetch(`${app.base}/api/aff/stats`, { headers: { authorization: 'Basic ' + Buffer.from('admin:nope').toString('base64') } })).json();
    assert.equal(wrong.revenue, undefined);
    assert.equal(s.members.total, 1, 'phase 1 counters are still there');
    const h = await (await fetch(`${app.base}/api/aff/health`)).json();
    assert.equal(typeof h.last_event_at, 'number');
  } finally {
    await app.close();
  }
});

test('stub guard: a real click token that happens to contain TEST is not a test postback', async () => {
  const app = await startApp();
  try {
    app.db.prepare("INSERT INTO clicks (click_id, brand_id, created_at) VALUES ('X9TEST2QAB', 1, 1)").run();
    const mid = app.member(9100);
    app.db.prepare("UPDATE members SET click_id = 'X9TEST2QAB' WHERE id = ?").run(mid);
    const r = await app.pb({ status: 'ftd', trader_id: '197000123', amount: '50', clickid: 'X9TEST2QAB', event_id: 'tok1' });
    assert.deepEqual([r.matched, r.path, r.member_id], [true, 'click', mid], 'counted and attributed');
    // the broker's own test markers are still caught
    for (const clickid of ['test', 'TEST-RECON-1', 'myTestClick', 'x9test2qab']) {
      assert.deepEqual(await app.pb({ status: 'ftd', trader_id: '197000124', amount: '5', clickid, event_id: `t-${clickid}` }), { ok: true, ignored: 'stub_guard' }, clickid);
    }
  } finally { await app.close(); }
});

test('rate limit: more than AFF_RATE_LIMIT_PER_SEC postbacks a second from one address get 429; nothing is stored', async () => {
  let t = Date.parse('2026-11-16T10:00:00.100Z');
  const app = await startApp({ AFF_RATE_LIMIT_PER_SEC: '5' }, { now: () => t });
  try {
    const hit = (i, ip = '198.51.100.7') => fetch(`${app.base}/api/aff?status=reg&trader_id=19750000${i}&event_id=rl-${ip}-${i}`, { headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < 5; i++) assert.equal((await hit(i)).status, 200, `request ${i + 1}`);
    const r = await hit(5);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '1');
    assert.equal((await r.json()).error, 'rate_limited');
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_id = 'rl-198.51.100.7-5'").get().n, 0, 'the refused postback was not stored');
    assert.equal((await hit(6, '198.51.100.8')).status, 200, 'another address has its own allowance');
    t += 1000;
    assert.equal((await hit(7)).status, 200, 'the next second starts fresh');
    assert.equal((await fetch(`${app.base}/api/aff/health`)).status, 200, 'health is not limited');
  } finally { await app.close(); }
});

test('rate limit: 0 switches it off; the default is 100 a second', async () => {
  const app = await startApp({ AFF_RATE_LIMIT_PER_SEC: '0' }, { now: () => 1000 });
  try {
    for (let i = 0; i < 30; i++) assert.equal((await app.pb({ status: 'reg', trader_id: `19760000${i}`, event_id: `off-${i}` })).ok, true);
    assert.equal(app.config.affRatePerSec, 0);
  } finally { await app.close(); }
  const dflt = await startApp();
  try { assert.equal(dflt.config.affRatePerSec, 100); } finally { await dflt.close(); }
});
