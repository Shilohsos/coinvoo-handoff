import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, syncOpens } from './helpers.js';
import { runAlerts, ALERTS } from '../src/alerts.js';
import { loadReportConfig } from '../src/report.js';
import { createWorker, dfFreePct, hostProbes } from '../src/worker.js';
import { readFileSync } from 'node:fs';

const H = 3600 * 1000;
const MIN = 60000;
const TOKEN = '111222:FAKE_TOKEN_FOR_TESTS_ONLY';
const ALERT_CHAT = '-1002222';
const AENV = { REPORT_BOT_TOKEN: TOKEN, REPORT_CHAT_ID: '-1001111', ALERT_CHAT_ID: ALERT_CHAT };
const BASE = Date.parse('2026-11-15T10:00:00Z'); // 11:00 Lagos
const lagos = (hhmm, day = '2026-11-15') => Date.parse(`${day}T${hhmm}:00Z`) - H;

function fakeTelegram(script = []) {
  const calls = [];
  let id = 500;
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const step = script.shift();
    if (step === 'throw') throw new Error('ECONNRESET');
    if (typeof step === 'number') return new Response(JSON.stringify({ ok: false, description: 'no' }), { status: step });
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++id } }), { status: 200 });
  };
  return { fetchImpl, calls, texts: () => calls.map((c) => c.body.text) };
}

async function setup({ env = AENV, script = [], extra = {} } = {}) {
  const clock = { now: BASE };
  const tg = fakeTelegram(script);
  const app = await startApp({}, { now: () => clock.now, fetchImpl: tg.fetchImpl, ...extra });
  const rc = Object.assign({}, loadReportConfig(env), { retryDelayMs: 0 });
  const st = {};
  // one evaluation pass at a given instant; resolves to the messages it sent
  const pass = async (now = clock.now) => {
    clock.now = now;
    const before = tg.calls.length;
    await runAlerts(app.deps, rc, st);
    return tg.texts().slice(before);
  };
  return { app, clock, tg, rc, st, pass };
}

const addEvent = (app, id, { state = 'matched', at, forward = 'sent', matchedAt = at, kind = 'dep' }) =>
  app.db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, matched_at, forward_state)
                  VALUES (?, 1, 'affstore', ?, ?, ?, 10, 'USD', '{}', ?, ?, ?, ?)`).run(id, kind, kind, `19700${id}`.slice(0, 12), at, state, state === 'matched' ? matchedAt : null, forward);
const addClick = (app, id, at) => {
  app.db.prepare("INSERT INTO clicks (click_id, brand_id, campaign, created_at, clicked_at) VALUES (?, 1, 'C', ?, ?)").run(id.padEnd(10, '0'), at, at);
  syncOpens(app.db);
};
const stateOf = (app, name) => { const r = app.db.prepare('SELECT value FROM settings WHERE key = ?').get(`alert_state_${name}`); return r ? r.value : null; };

// ---------------------------------------------------------------------------------------------------------------

test('silence: quiet, fires once, stays silent, clears once, fires again after a new silence (mocked clock)', async () => {
  const { app, tg, pass } = await setup();
  try {
    addEvent(app, 'e1', { at: lagos('12:14') });
    addClick(app, 'ck1', lagos('13:00'));
    const log = [];
    const step = async (hhmm, label, day = '2026-11-15') => { const sent = await pass(lagos(hhmm, day)); log.push(`${day.slice(5)} ${hhmm} ${label}: ${sent.length ? sent.join(' | ') : '(silent)'}`); return sent; };

    assert.deepEqual(await step('17:14', '5 h since the last postback'), []);
    assert.deepEqual(await step('18:14', 'exactly 6 h (the threshold is strict)'), []);
    assert.deepEqual(await step('19:20', '7 h 6 min'), ['COINVOO — no postbacks for 7 h (last: 12:14; threshold 6 h)']);
    for (const t of ['19:21', '20:00', '23:30']) assert.deepEqual(await step(t, 'still silent'), [], t);
    assert.equal(stateOf(app, 'silence'), 'firing');

    addEvent(app, 'e2', { at: lagos('23:40') }); // a postback arrives
    assert.deepEqual(await step('23:41', 'postback arrived'), ['COINVOO — postback silence cleared']);
    assert.deepEqual(await step('23:42', 'after clearing'), []);
    assert.equal(stateOf(app, 'silence'), 'clear');

    // 7 h after e2 (and links are still being opened): it fires again, once
    addClick(app, 'ck2', lagos('05:00', '2026-11-16'));
    assert.deepEqual(await step('06:50', 'second silence', '2026-11-16'), ['COINVOO — no postbacks for 7 h (last: 23:40; threshold 6 h)']);
    assert.deepEqual(await step('07:50', 'still the same silence', '2026-11-16'), []);
    assert.equal(tg.calls.length, 3, 'fire, clear, fire: three messages in all, no repeats');
    console.log(`# silence timeline\n${log.map((l) => `#   ${l}`).join('\n')}`);
  } finally { await app.close(); }
});

test('silence: only while links are being opened; no alert at 3 a.m. on a quiet day', async () => {
  const { app, pass } = await setup();
  try {
    addEvent(app, 'e1', { at: lagos('18:00') });
    // 20 h with no postbacks, but no link opened in the last 24 h: a quiet day, not an outage
    assert.deepEqual(await pass(lagos('14:00', '2026-11-16')), []);
    // a link opened 25 h ago does not count
    addClick(app, 'old', lagos('12:00'));
    assert.deepEqual(await pass(lagos('14:00', '2026-11-16')), []);
    // a link opened an hour ago does
    addClick(app, 'live', lagos('13:00', '2026-11-16'));
    assert.deepEqual(await pass(lagos('14:00', '2026-11-16')), ['COINVOO — no postbacks for 20 h (last: 18:00; threshold 6 h)']);
  } finally { await app.close(); }
});

test('silence: with no postback ever recorded there is nothing to be silent about', async () => {
  const { app, pass } = await setup();
  try {
    addClick(app, 'ck', BASE - H);
    assert.deepEqual(await pass(BASE + 9 * H), []);
  } finally { await app.close(); }
});

test('parked: fires above 50 % (the default) of the last 24 h, once, and clears; thresholds and the sample floor hold', async () => {
  const { app, pass } = await setup();
  try {
    const add = (prefix, n, state, at) => { for (let i = 0; i < n; i++) addEvent(app, `${prefix}${i}`, { state, at, forward: state === 'parked' ? 'none' : 'sent' }); };
    add('m', 5, 'matched', BASE - 2 * H);
    add('p', 5, 'parked', BASE - 2 * H);
    assert.deepEqual(await pass(BASE), [], '5 of 10 is exactly 50 %: not above it');
    add('p2', 1, 'parked', BASE - H);
    assert.deepEqual(await pass(BASE), ['COINVOO — 55% of events unmatched in the last 24 h (6 of 11; threshold 50%)'], '6 of 11');
    add('p3', 1, 'parked', BASE - H);
    assert.deepEqual(await pass(BASE + MIN), [], 'stays silent while it stays firing (now 7 of 12)');
    add('m2', 8, 'matched', BASE - H);
    assert.deepEqual(await pass(BASE + 2 * MIN), ['COINVOO — unmatched ratio cleared'], '7 of 20 = 35 %');
    assert.deepEqual(await pass(BASE + 3 * MIN), []);
  } finally { await app.close(); }
});

test('parked: rounds the percentage, needs a minimum of 10 decided events, ignores events older than 24 h', async () => {
  const { app, pass } = await setup();
  try {
    for (let i = 0; i < 8; i++) addEvent(app, `p${i}`, { state: 'parked', at: BASE - H, forward: 'none' });
    for (let i = 0; i < 1; i++) addEvent(app, `m${i}`, { state: 'matched', at: BASE - H });
    assert.deepEqual(await pass(BASE), [], '9 decided events: below the floor, 89 % parked does not alert');
    addEvent(app, 'm9', { state: 'matched', at: BASE - H });
    // 10 decided: 8 parked = 80 %
    assert.deepEqual(await pass(BASE), ['COINVOO — 80% of events unmatched in the last 24 h (8 of 10; threshold 50%)']);
    // a day later those events are outside the window: ratio cannot be computed, it clears
    assert.deepEqual(await pass(BASE + 26 * H), ['COINVOO — unmatched ratio cleared']);
  } finally { await app.close(); }
});

test('parked: 47 % renders as 47%; silent at the default 50 %, fires when PARKED_ALERT_PCT=40 (env only)', async () => {
  for (const [env, want] of [
    [AENV, []],
    [{ ...AENV, PARKED_ALERT_PCT: '40' }, ['COINVOO — 47% of events unmatched in the last 24 h (9 of 19; threshold 40%)']]
  ]) {
    const { app, pass } = await setup({ env });
    try {
      for (let i = 0; i < 9; i++) addEvent(app, `p${i}`, { state: 'parked', at: BASE - H, forward: 'none' });
      for (let i = 0; i < 10; i++) addEvent(app, `m${i}`, { state: 'matched', at: BASE - H });
      assert.deepEqual(await pass(BASE), want, JSON.stringify(env.PARKED_ALERT_PCT)); // 9 / 19
    } finally { await app.close(); }
  }
});

test('forward: any postback failing to forward for more than 15 minutes fires once, then clears', async () => {
  const { app, pass } = await setup();
  try {
    addEvent(app, 'f1', { at: BASE - 40 * MIN, matchedAt: BASE - 20 * MIN, forward: 'failed' });
    assert.deepEqual(await pass(BASE), ['COINVOO — 1 postback failing to forward to Joinvoo (threshold: any failed for over 15 min)'], 'singular');
    addEvent(app, 'f2', { at: BASE - 40 * MIN, matchedAt: BASE - 30 * MIN, forward: 'failed' });
    addEvent(app, 'f3', { at: BASE - 40 * MIN, matchedAt: BASE - 25 * MIN, forward: 'failed' });
    assert.deepEqual(await pass(BASE + MIN), [], 'the count went up but the condition is the same: no second alert');
    app.db.prepare("UPDATE events SET forward_state = 'sent'").run();
    assert.deepEqual(await pass(BASE + 2 * MIN), ['COINVOO — forward failures cleared']);
    // plural wording, and only failures older than 15 minutes count
    for (const id of ['g1', 'g2', 'g3']) addEvent(app, id, { at: BASE - H, matchedAt: BASE + 2 * MIN - 16 * MIN, forward: 'failed' });
    addEvent(app, 'fresh', { at: BASE, matchedAt: BASE + 2 * MIN - 5 * MIN, forward: 'failed' });
    assert.deepEqual(await pass(BASE + 3 * MIN), ['COINVOO — 3 postbacks failing to forward to Joinvoo (threshold: any failed for over 15 min)'], 'the 5-minute-old failure is not counted yet');
  } finally { await app.close(); }
});

test('forward: the clock starts when the forward started, not when the postback arrived', async () => {
  const { app, pass } = await setup();
  try {
    // arrived 3 h ago, parked, matched 2 minutes ago, forward failed straight away
    addEvent(app, 'late', { at: BASE - 3 * H, matchedAt: BASE - 2 * MIN, forward: 'failed' });
    assert.deepEqual(await pass(BASE), []);
    assert.deepEqual(await pass(BASE + 12 * MIN), [], 'failing for 14 minutes');
    assert.deepEqual(await pass(BASE + 20 * MIN), ['COINVOO — 1 postback failing to forward to Joinvoo (threshold: any failed for over 15 min)'], 'failing for 22 minutes, although the postback arrived 3 h ago');
    // an expired event is forwarded at expiry: its attribution row carries that time
    addEvent(app, 'exp', { state: 'expired', at: BASE - 60 * H, forward: 'failed' });
    app.db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at) VALUES ('exp', NULL, 'none', 0, ?)").run(BASE + 20 * MIN - 30 * MIN);
    assert.deepEqual(await pass(BASE + 21 * MIN), [], 'already firing');
    app.db.prepare("UPDATE events SET forward_state = 'sent' WHERE event_id = 'late'").run();
    assert.deepEqual(await pass(BASE + 22 * MIN), [], 'the expired one is still failing, so it has not cleared');
  } finally { await app.close(); }
});

test('disk: fires below 10 % free (above 90 % full), once; clears above it', async () => {
  const disk = { free: 15 };
  const { app, pass } = await setup();
  app.deps.diskFreePct = () => disk.free;
  try {
    assert.deepEqual(await pass(BASE), [], '85 % used');
    disk.free = 10;
    assert.deepEqual(await pass(BASE + MIN), [], 'exactly 10 % free is not below 10 %');
    disk.free = 9;
    assert.deepEqual(await pass(BASE + 2 * MIN), ['COINVOO — disk 91% full, 9.0% free (threshold: under 10% free)']);
    disk.free = 3;
    assert.deepEqual(await pass(BASE + 3 * MIN), [], 'worse, but already firing');
    disk.free = 20;
    assert.deepEqual(await pass(BASE + 4 * MIN), ['COINVOO — disk usage cleared']);
    assert.deepEqual(await pass(BASE + 5 * MIN), []);
  } finally { await app.close(); }
});

test('disk probe (production): free % as df prints it; reserved blocks count as neither used nor free', () => {
  // 1000 blocks: 600 used, 300 reserved, 100 available. df: 600 / (600 + 100) = 85.7 % used, 14.3 % free.
  assert.equal(Math.round(dfFreePct({ blocks: 1000, bsize: 4096, bfree: 400, bavail: 100 }) * 10) / 10, 14.3);
  assert.ok(dfFreePct({ blocks: 1000, bsize: 4096, bfree: 400, bavail: 100 }) >= 10, 'so no alert; the naive 1 - bavail/blocks would read 90 % used');
  assert.equal(Math.round(100 - dfFreePct({ blocks: 1000, bsize: 4096, bfree: 280, bavail: 60 })), 92, '720 used, 60 available');
  assert.equal(dfFreePct({ blocks: 0, bsize: 4096, bfree: 0, bavail: 0 }), 100, 'an empty report is not an alarm');
  const p = hostProbes('.');
  assert.equal(typeof p.diskFreePct(), 'number');
  assert.ok(p.rssMb() > 0);
});

test('memory: RSS above 250 MB for 10 minutes fires once; a short spike never does', async () => {
  const mem = { mb: 200 };
  const { app, pass } = await setup();
  app.deps.rssMb = () => mem.mb;
  try {
    assert.deepEqual(await pass(BASE), []);
    mem.mb = 268;
    assert.deepEqual(await pass(BASE + MIN), [], 'over 250 MB, the 10 minutes start now');
    assert.deepEqual(await pass(BASE + 10 * MIN + 59000), [], '9 min 59 s: not yet');
    assert.deepEqual(await pass(BASE + 11 * MIN), ['COINVOO — memory 268 MB for 10 min (threshold 250 MB)']);
    mem.mb = 290;
    assert.deepEqual(await pass(BASE + 12 * MIN), [], 'still firing: silent');
    mem.mb = 240;
    assert.deepEqual(await pass(BASE + 13 * MIN), ['COINVOO — memory cleared']);
    // a 9-minute spike twice, with a dip between: never 10 minutes in a row
    mem.mb = 260;
    await pass(BASE + 20 * MIN);
    assert.deepEqual(await pass(BASE + 29 * MIN), []);
    mem.mb = 200;
    await pass(BASE + 30 * MIN);
    mem.mb = 260;
    await pass(BASE + 31 * MIN);
    assert.deepEqual(await pass(BASE + 40 * MIN), [], 'the dip reset the clock');
  } finally { await app.close(); }
});

test('health: a failing database check fires once and clears; the state survives the database being the broken part', async () => {
  const { app, pass } = await setup();
  try {
    const realPrepare = app.db.prepare.bind(app.db);
    // the check query fails AND the settings table cannot be read or written
    app.db.prepare = (sql) => { if (/SELECT 1\b/.test(sql) || /settings/.test(sql)) throw new Error('database disk image is malformed'); return realPrepare(sql); };
    assert.deepEqual(await pass(BASE), ['COINVOO — database check failing (SELECT 1 errored; threshold: any error)']);
    assert.deepEqual(await pass(BASE + MIN), [], 'not repeated, although it could not persist the state');
    assert.deepEqual(await pass(BASE + 2 * MIN), []);
    app.db.prepare = realPrepare;
    assert.deepEqual(await pass(BASE + 3 * MIN), ['COINVOO — database check cleared'], 'and the recovery is reported');
    assert.deepEqual(await pass(BASE + 4 * MIN), []);
  } finally { await app.close(); }
});

test('delivery: one plain-text message per transition, to ALERT_CHAT_ID only, token in the URL, no parse_mode', async () => {
  const { app, tg, pass } = await setup();
  try {
    addEvent(app, 'e1', { at: BASE - 8 * H });
    addClick(app, 'ck', BASE - H);
    await pass(BASE);
    assert.equal(tg.calls.length, 1);
    const c = tg.calls[0];
    assert.equal(c.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    assert.deepEqual(Object.keys(c.body).sort(), ['chat_id', 'disable_web_page_preview', 'text']);
    assert.ok(!('parse_mode' in c.body));
    assert.equal(c.body.chat_id, ALERT_CHAT);
    assert.notEqual(c.body.chat_id, '-1001111', 'never the report chat');
    assert.match(c.body.text, /^COINVOO — [\x20-\x7e—·]+$/, 'plain text');
  } finally { await app.close(); }
});

test('several alerts in one pass: one message each, in the fixed order', async () => {
  const { app, pass } = await setup();
  app.deps.diskFreePct = () => 5;
  app.deps.rssMb = () => 300;
  try {
    addEvent(app, 'e1', { at: BASE - 8 * H });
    addClick(app, 'ck', BASE - H);
    addEvent(app, 'f1', { at: BASE - H, matchedAt: BASE - 30 * MIN, forward: 'failed' });
    await pass(BASE - 11 * MIN); // starts the memory clock (and fires the others)
    const sent = await pass(BASE);
    assert.deepEqual(sent, ['COINVOO — memory 300 MB for 10 min (threshold 250 MB)'], 'the others fired on the first pass; memory crosses 10 minutes on this one');
    assert.deepEqual(ALERTS.map((a) => a.name), ['health', 'silence', 'parked', 'forward', 'disk', 'memory', 'snapshot', 'backup']);
  } finally { await app.close(); }
});

test('restart: the persisted state means a restarted process does not repeat a firing alert, and still clears it', async () => {
  const { app, tg, pass, rc } = await setup();
  try {
    addEvent(app, 'e1', { at: BASE - 8 * H });
    addClick(app, 'ck', BASE - H);
    assert.equal((await pass(BASE)).length, 1);
    // a new process: no in-memory state at all, same database
    const fresh = {};
    await runAlerts(app.deps, rc, fresh);
    await runAlerts(app.deps, rc, fresh);
    assert.equal(tg.calls.length, 1, 'no repeat after the restart');
    addEvent(app, 'e2', { at: BASE + MIN });
    await runAlerts(app.deps, rc, fresh);
    assert.equal(tg.calls.length, 2);
    assert.equal(tg.calls[1].body.text, 'COINVOO — postback silence cleared', 'the restarted process cleared what the old one fired');
  } finally { await app.close(); }
});

test('a failed send is logged and not repeated: the alert stays fired, no storm', async () => {
  const { app, tg, pass } = await setup({ script: [500, 500] });
  try {
    addEvent(app, 'e1', { at: BASE - 8 * H });
    addClick(app, 'ck', BASE - H);
    await pass(BASE);
    assert.equal(tg.calls.length, 2, 'the request and the client retry, both 500');
    for (let i = 1; i <= 5; i++) await pass(BASE + i * MIN);
    assert.equal(tg.calls.length, 2, 'later passes send nothing');
    assert.equal(stateOf(app, 'silence'), 'firing');
  } finally { await app.close(); }
});

test('a refused send (400) is not retried either', async () => {
  const { app, tg, pass } = await setup({ script: [400] });
  try {
    addEvent(app, 'e1', { at: BASE - 8 * H });
    addClick(app, 'ck', BASE - H);
    await pass(BASE);
    assert.equal(tg.calls.length, 1);
  } finally { await app.close(); }
});

test('disabled: without the token or ALERT_CHAT_ID nothing is evaluated, sent or stored', async () => {
  for (const env of [{}, { REPORT_BOT_TOKEN: TOKEN }, { ALERT_CHAT_ID: ALERT_CHAT }, { REPORT_BOT_TOKEN: TOKEN, REPORT_CHAT_ID: '-1' }]) {
    const { app, tg, pass } = await setup({ env });
    try {
      addEvent(app, 'e1', { at: BASE - 8 * H });
      addClick(app, 'ck', BASE - H);
      assert.deepEqual(await pass(BASE), [], JSON.stringify(Object.keys(env)));
      assert.equal(tg.calls.length, 0);
      assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'alert_state_%'").get().n, 0, 'no state is written, so the alert is not lost when the env arrives');
    } finally { await app.close(); }
  }
});

test('worker: the alert pass runs on the tick, in the background, and fires once across ticks', async () => {
  const clock = { now: BASE };
  const tg = fakeTelegram();
  const app = await startApp({}, { now: () => clock.now, fetchImpl: tg.fetchImpl });
  try {
    addEvent(app, 'e1', { at: BASE - 8 * H });
    addClick(app, 'ck', BASE - H);
    app.deps.reportConfig = loadReportConfig(AENV);
    const disk = () => 50;
    const mem = () => 100;
    app.deps.diskFreePct = disk;
    app.deps.rssMb = mem;
    app.deps.snapshotHealth = () => ({ rows: 1, synced_at: BASE, age_s: 0, stale: false, available: true });
    const w = createWorker(app.deps);
    assert.equal(app.deps.diskFreePct, disk, 'the worker keeps injected probes');
    assert.equal(app.deps.rssMb, mem);
    await w.tick(); await w.flush();
    clock.now += MIN;
    await w.tick(); await w.flush();
    await w.tick(); await w.flush();
    assert.equal(tg.calls.length, 1);
    assert.match(tg.calls[0].body.text, /^COINVOO — no postbacks for 8 h \(last: \d\d:\d\d; threshold 6 h\)$/);
    assert.equal(tg.calls[0].body.chat_id, ALERT_CHAT);
  } finally { await app.close(); }
});

test('no host reads: alerts.js never touches the filesystem or the process for disk/memory', () => {
  const src = readFileSync(new URL('../src/alerts.js', import.meta.url), 'utf8');
  for (const call of ['statfsSync(', 'memoryUsage(', 'statfs(', "from 'node:fs'", "from 'node:os'"]) assert.ok(!src.includes(call), `alerts.js contains ${call}`);
});

test('without probes the disk and memory conditions are not evaluated: no message, no state', async () => {
  const { app, tg, pass } = await setup();
  try {
    assert.equal(typeof app.deps.diskFreePct, 'undefined', 'the test app has no host probes');
    assert.deepEqual(await pass(BASE), []);
    assert.deepEqual(await pass(BASE + 20 * MIN), []);
    assert.equal(tg.calls.length, 0);
    assert.equal(stateOf(app, 'disk'), null);
    assert.equal(stateOf(app, 'memory'), null);
  } finally { await app.close(); }
});

test('the worker wires real host probes only when none are injected', async () => {
  const app = await startApp({}, { now: () => BASE });
  try {
    app.deps.reportConfig = loadReportConfig({});
    createWorker(app.deps);
    assert.equal(typeof app.deps.diskFreePct, 'function');
    assert.equal(typeof app.deps.rssMb, 'function');
    const free = app.deps.diskFreePct();
    assert.ok(free >= 0 && free <= 100, `free ${free} %`);
    assert.ok(app.deps.rssMb() > 1);
  } finally { await app.close(); }
});
