import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, captureLogs, syncOpens } from './helpers.js';
import { createWorker, PRUNED_PAYLOAD } from '../src/worker.js';
import { loadReportConfig, buildDailyReport, renderCard, reportDayFor } from '../src/report.js';
import { campaignPerf } from '../src/queries.js';
import { sendMessage, TELEGRAM_TIMEOUT_MS } from '../src/telegram.js';

const H = 3600 * 1000;
const DAY = 24 * H;
const TOKEN = '111222:FAKE_TOKEN_FOR_TESTS_ONLY';
const ENV = { REPORT_BOT_TOKEN: TOKEN, REPORT_CHAT_ID: '-1001111', ALERT_CHAT_ID: '-1002222' };
// The fixture day genuinely trips the silence alert, so scheduler tests run report-only and count report messages.
const RENV = { REPORT_BOT_TOKEN: TOKEN, REPORT_CHAT_ID: '-1001111' };
const NOW = Date.parse('2026-11-15T07:30:00Z');            // Sun 15 Nov 08:30 Lagos
const D = '2026-11-14';                                    // the day that card covers (a Saturday)
const lagos = (day, hhmm) => Date.parse(`${day}T${hhmm}:00Z`) - H; // an instant given as Lagos wall time

// A stand-in for api.telegram.org: records every call, answers from an optional script.
function fakeTelegram(script = []) {
  const calls = [];
  let id = 1000;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, signal: init.signal });
    const step = script.shift();
    if (step === 'throw') throw new Error(`socket hang up (${url})`);
    if (typeof step === 'number') return new Response(JSON.stringify({ ok: false, description: `fail ${step}` }), { status: step });
    return new Response(JSON.stringify({ ok: true, result: { message_id: ++id } }), { status: 200 });
  };
  return { fetchImpl, calls };
}

async function get(app, path, auth = true) {
  const r = await fetch(`${app.base}${path}`, { headers: auth ? { authorization: app.auth } : {} });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
const metrics = (html) => Object.fromEntries([...html.matchAll(/data-metric="([a-z_]+)" data-value="([^"]*)"/g)].map((m) => [m[1], m[2] === '' ? null : Number(m[2])]));

// Fixture day D, hand-computed (brand-one): 4 links opened (3 NG_Broad, 1 NG_Other), 3 joins, events:
//   reg x2 matched · ftd $50 + $70 matched · dep $30 matched · dep $25 parked · ftd $40 expired · ftd $100 ignored (stub)
//   spend $60 on NG_Broad.   The newest event is at 23:00 Lagos.
function seedDay(app) {
  const db = app.db;
  const click = db.prepare('INSERT INTO clicks (click_id, brand_id, campaign, adset, ad, created_at, clicked_at) VALUES (?, 1, ?, ?, ?, ?, ?)');
  for (let i = 1; i <= 3; i++) click.run(`RB${i}`.padEnd(10, '0'), 'NG_Broad', '18-34', 'vid_03', lagos(D, '08:00'), lagos(D, '10:00'));
  click.run('RO1'.padEnd(10, '0'), 'NG_Other', 'x', 'y', lagos(D, '08:00'), lagos(D, '10:30'));
  const mem = db.prepare("INSERT INTO members (brand_id, telegram_id, username, joined_at, click_id, join_source) VALUES (1, ?, ?, ?, ?, 'bot:start')");
  mem.run(7001, 'one', lagos(D, '11:00'), 'RB1'.padEnd(10, '0'));
  mem.run(7002, 'two', lagos(D, '11:05'), 'RB2'.padEnd(10, '0'));
  mem.run(7003, 'three', lagos(D, '11:10'), null);
  const id = (tg) => db.prepare('SELECT id FROM members WHERE telegram_id = ?').get(tg).id;
  const ev = db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, ignore_reason, matched_member_id, matched_at, forward_state)
                         VALUES (?, 1, 'affstore', ?, ?, ?, ?, 'USD', '{"net":"affstore"}', ?, ?, ?, ?, ?, 'sent')`);
  const att = db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at) VALUES (?, ?, ?, ?, ?)");
  const rows = [
    ['r1', 'reg', null, '17:00', 'matched', 7001], ['r2', 'reg', null, '17:05', 'matched', 7002],
    ['f1', 'ftd', 50, '18:00', 'matched', 7001], ['f2', 'ftd', 70, '19:00', 'matched', 7002], ['d1', 'dep', 30, '20:00', 'matched', 7001]
  ];
  for (const [eid, kind, amt, at, st, tg] of rows) {
    ev.run(eid, kind, kind, `19710${eid}`, amt, lagos(D, at), st, null, id(tg), lagos(D, at));
    att.run(eid, id(tg), 'afftrack', 100, lagos(D, at));
  }
  ev.run('p1', 'dep', 'dep', '197999999', 25, lagos(D, '21:00'), 'parked', null, null, null);
  db.prepare("UPDATE events SET forward_state = 'none' WHERE event_id = 'p1'").run();
  ev.run('x1', 'ftd', 'ftd', '197888888', 40, lagos(D, '22:00'), 'expired', null, null, null);
  att.run('x1', null, 'none', 0, lagos(D, '22:00'));
  ev.run('s1', 'ftd', 'ftd', '1', 100, lagos(D, '22:30'), 'ignored', 'stub_guard', null, null);
  att.run('s1', null, 'none', 0, lagos(D, '22:30'));
  ev.run('z1', 'reg', 'reg', '197777777', null, lagos(D, '23:00'), 'matched', null, id(7003), lagos(D, '23:00'));
  att.run('z1', id(7003), 'trader_id', 90, lagos(D, '23:00'));
  db.prepare("INSERT INTO costs (brand_id, day, campaign, adset, ad, spend, currency, created_at) VALUES (1, ?, 'NG_Broad', '18-34', 'vid_03', 60, 'USD', ?)").run(D, NOW);
  syncOpens(db);
}
// (z1 is a third matched reg, so regs = 3 and matched = 6 below.)

const GOLDEN = [
  'COINVOO — brand-one — Sat 14 Nov 2026',
  '',
  'Clicks 4 · Joins 3 · Regs 3 · FTDs 3 · Re-deps 2',
  'Revenue $150.00 · Spend $60.00 · ROI +150.0% (USD)',
  'Cost/join $20.00 · Cost/FTD (USD) $20.00',
  '',
  'Matched 75.0% · Parked 12.5% · Expired 12.5% · Ignored 1',
  'Unattributed revenue $65.00',
  '',
  'Top campaign: NG_Broad / 18-34 / vid_03 — 2 FTDs, $150.00',
  'Last event: 9 h ago (silence)',
  '',
  'ALL BRANDS — revenue $150.00 · spend $60.00 · FTDs 3'
].join('\n');

async function fixtureApp(extraOpts = {}) {
  const t = { now: NOW };
  const tg = fakeTelegram();
  const app = await startApp({}, { now: () => t.now, fetchImpl: tg.fetchImpl, ...extraOpts });
  seedDay(app);
  return { app, t, tg };
}

// ---------------------------------------------------------------------------------------------------------------

test('card: the fixture day renders the exact fixed shape (hand-computed golden text)', async () => {
  const { app } = await fixtureApp();
  try {
    const r = buildDailyReport(app.db, { day: D, now: NOW });
    assert.equal(r.text, GOLDEN);
    assert.equal(r.brands.length, 1, 'brand-two is inactive: one card');
    assert.equal(reportDayFor(NOW), D, 'a card sent at 08:30 covers yesterday');
  } finally { await app.close(); }
});

// Money outside USD must be visible on the card and must never leak into the USD figures or their ratios.
function addNonUsd(app) {
  const db = app.db;
  const m = db.prepare('SELECT id FROM members WHERE telegram_id = 7003').get().id;
  const ev = db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, matched_member_id, matched_at, forward_state)
                         VALUES (?, 1, 'affstore', ?, ?, ?, ?, ?, '{"net":"affstore"}', ?, ?, ?, ?, 'none')`);
  ev.run('n1', 'ftd', 'ftd', '197555551', 150000, 'NGN', lagos(D, '12:00'), 'matched', m, lagos(D, '12:00'));
  db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at) VALUES ('n1', ?, 'trader_id', 90, ?)").run(m, lagos(D, '12:00'));
  ev.run('n2', 'dep', 'dep', '197555552', 20000, 'NGN', lagos(D, '13:00'), 'parked', null, null);
}

test('card: NGN deposits are shown on their own line, and Cost/FTD divides USD spend by USD first deposits only', async () => {
  const { app } = await fixtureApp();
  try {
    addNonUsd(app);
    const r = buildDailyReport(app.db, { day: D, now: NOW });
    const c = r.brands[0];
    assert.deepEqual([c.ftds, c.ftds_usd], [4, 3], 'the NGN first deposit counts as an FTD, but not as a USD one');
    assert.equal(c.cost_per_ftd, 20, '$60 spend / 3 USD FTDs, not / 4');
    assert.deepEqual([c.revenue, c.roi, c.unattributed], [150, 150, 65], 'the USD figures do not move');
    assert.deepEqual([c.revenue_other, c.unattributed_other], [{ NGN: 150000 }, { NGN: 20000 }]);
    assert.match(r.text, /FTDs 4 · Re-deps 3/, 'received events count whatever their state: the parked NGN deposit is a re-deposit');
    assert.match(r.text, /ROI \+150\.0% \(USD\)\nCost\/join \$20\.00 · Cost\/FTD \(USD\) \$20\.00/);
    assert.match(r.text, /Unattributed revenue \$65\.00\nNot in the USD figures: revenue ₦150,000 · unattributed ₦20,000\n/);
    assert.match(r.text, /ALL BRANDS — revenue \$150\.00 · other revenue ₦150,000 · spend \$60\.00 · FTDs 4/);
    assert.deepEqual(r.total.revenue_other, { NGN: 150000 });
  } finally { await app.close(); }
});

test('card: with no non-USD money there is no extra line, and other currencies sort and use fmtMoney', async () => {
  const { app } = await fixtureApp();
  try {
    assert.doesNotMatch(buildDailyReport(app.db, { day: D, now: NOW }).text, /Not in the USD figures|other revenue/);
    const text = renderCard({ brand: 'brand-one', day: D, generated_at: NOW, clicks: 0, joins: 0, regs: 0, ftds: 0, redeps: 0, revenue: 0, spend: null, roi: null,
      cost_per_join: null, cost_per_ftd: null, unattributed: 0, revenue_other: { NGN: 1204500, EUR: 20 }, unattributed_other: {},
      states: { matched: 0, parked: 0, expired: 0, ignored: 0 }, top_campaign: null, last_event_at: null, silence: false });
    assert.match(text, /\nNot in the USD figures: revenue EUR 20\.00 \+ ₦1,204,500\n/);
  } finally { await app.close(); }
});

test('card: Cost/FTD is USD-only on the card, the Overview and the campaign totals', async () => {
  const { app } = await fixtureApp();
  try {
    addNonUsd(app);
    const card = buildDailyReport(app.db, { day: D, now: NOW, brandCode: 'brand-one' }).brands[0];
    const dash = metrics((await get(app, `/dash?from=${D}&to=${D}&brand=brand-one`)).text);
    const start = lagos(D, '00:00');
    const camp = campaignPerf(app.db, { brandId: 1, start, end: start + DAY, fromDay: D, toDay: D }).totals;
    assert.equal(card.cost_per_ftd, 20, 'card: $60 / 3 USD first-deposit events');
    assert.equal(dash.cost_per_ftd, 20, 'Overview shares the card numbers');
    // The campaign screen counts matched FTDs only (the expired $40 FTD is not in it), which is an older
    // difference from the Overview and not part of this change. What is asserted here is the currency basis.
    assert.equal(camp.ftds, 3, 'the campaign FTD column still counts every currency: f1, f2 and the NGN n1');
    assert.equal(camp.ftds_usd, 2, 'but only the USD ones are divided into USD spend');
    assert.equal(camp.cost_per_ftd, 30, '$60 / 2, not $60 / 3');
  } finally { await app.close(); }
});

test('card: the report payload equals the dashboard numbers for the same day, programmatically', async () => {
  const { app } = await fixtureApp();
  try {
    const dash = metrics((await get(app, `/dash?from=${D}&to=${D}&brand=brand-one`)).text);
    const card = buildDailyReport(app.db, { day: D, now: NOW, brandCode: 'brand-one' }).brands[0];
    const api = JSON.parse((await get(app, `/api/report/daily?day=${D}&brand=brand-one`)).text).brands[0];
    for (const p of [card, api]) {
      assert.deepEqual([p.clicks, p.joins, p.regs, p.ftds, p.redeps], [dash.clicks, dash.joins, dash.regs, dash.ftds, dash.redeps]);
      assert.deepEqual([p.revenue, p.spend, p.cost_per_join, p.cost_per_ftd, p.roi, p.unattributed],
        [dash.revenue, dash.spend, dash.cost_per_join, dash.cost_per_ftd, dash.roi, dash.unattributed]);
      assert.deepEqual([p.states.matched, p.states.parked, p.states.expired, p.states.ignored], [dash.matched, dash.parked, dash.expired, dash.ignored]);
    }
    assert.deepEqual([card.clicks, card.joins, card.ftds, card.revenue, card.spend, card.roi], [4, 3, 3, 150, 60, 150], 'and they are the hand-computed values');
  } finally { await app.close(); }
});

test('card: numbers that cannot be computed print an em dash; big numbers get thousands separators', async () => {
  const app = await startApp({}, { now: () => NOW });
  try {
    const t = buildDailyReport(app.db, { day: D, now: NOW }).text;
    assert.match(t, /Revenue \$0\.00 · Spend — · ROI — \(USD\)/);
    assert.match(t, /Cost\/join — · Cost\/FTD \(USD\) —/);
    assert.match(t, /Matched — · Parked — · Expired — · Ignored 0/);
    assert.match(t, /Top campaign: —\nLast event: never/);
    const big = renderCard({ brand: 'brand-one', day: D, generated_at: NOW, clicks: 12345, joins: 1234, regs: 41, ftds: 12, redeps: 19, revenue: 1240.5, spend: 600, roi: 106.75,
      cost_per_join: 6.25, cost_per_ftd: 50, unattributed: 180, states: { matched: 84, parked: 9, expired: 4, ignored: 2 }, matched_pct: 84.1, parked_pct: 9.2, expired_pct: 4.4,
      top_campaign: { label: 'NG_Broad / 18-34 / vid_03', ftds: 5, revenue: 310 }, last_event_at: NOW - 4 * 60000, silence: false });
    assert.equal(big, [
      'COINVOO — brand-one — Sat 14 Nov 2026', '',
      'Clicks 12,345 · Joins 1,234 · Regs 41 · FTDs 12 · Re-deps 19',
      'Revenue $1,240.50 · Spend $600.00 · ROI +106.8% (USD)',
      'Cost/join $6.25 · Cost/FTD (USD) $50.00', '',
      'Matched 84.1% · Parked 9.2% · Expired 4.4% · Ignored 2',
      'Unattributed revenue $180.00', '',
      'Top campaign: NG_Broad / 18-34 / vid_03 — 5 FTDs, $310.00',
      'Last event: 4 min ago'].join('\n'), 'the directive example, character for character');
  } finally { await app.close(); }
});

test('card: one card per active brand, then the combined line; brand=brand-two is one card without it', async () => {
  const { app } = await fixtureApp();
  try {
    app.db.prepare("UPDATE brands SET active = 1 WHERE code = 'brand-two'").run();
    app.db.prepare("INSERT INTO members (brand_id, telegram_id, username, joined_at, join_source) VALUES (2, 8001, 'e', ?, 'bot:start')").run(lagos(D, '12:00'));
    app.db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, matched_member_id, matched_at, forward_state)
                    VALUES ('e1', 2, 'affstore', 'ftd', 'ftd', '197123456', 1000, 'USD', '{}', ?, 'matched', (SELECT id FROM members WHERE telegram_id = 8001), ?, 'sent')`).run(lagos(D, '13:00'), lagos(D, '13:00'));
    app.db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at) VALUES ('e1', (SELECT id FROM members WHERE telegram_id = 8001), 'afftrack', 100, ?)").run(lagos(D, '13:00'));
    const all = buildDailyReport(app.db, { day: D, now: NOW });
    assert.deepEqual(all.brands.map((b) => b.brand), ['brand-one', 'brand-two']);
    assert.ok(all.text.includes('COINVOO — brand-two — Sat 14 Nov 2026'));
    assert.ok(all.text.endsWith('ALL BRANDS — revenue $1,150.00 · spend $60.00 · FTDs 4'), all.text.split('\n').pop());
    const one = buildDailyReport(app.db, { day: D, now: NOW, brandCode: 'brand-two' });
    assert.equal(one.brands.length, 1);
    assert.ok(!one.text.includes('ALL BRANDS'));
    assert.equal(one.total, null);
    assert.ok(all.text.length < 4096);
  } finally { await app.close(); }
});

test('card: Last event over the silence threshold says so; under it does not', async () => {
  const { app } = await fixtureApp();
  try {
    const at = (now, silenceHours = 6) => buildDailyReport(app.db, { day: D, now, silenceHours }).brands[0].text.split('\n').pop();
    const last = lagos(D, '23:00');
    assert.equal(at(last + 4 * 60000), 'Last event: 4 min ago');
    assert.equal(at(last + 6 * H), 'Last event: 6 h ago', 'exactly 6 h is not yet silence');
    assert.equal(at(last + 7 * H), 'Last event: 7 h ago (silence)');
    assert.equal(at(last + 7 * H, 12), 'Last event: 7 h ago', 'the threshold is POSTBACK_SILENCE_HOURS');
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Scheduler

async function schedulerApp(envExtra = {}, script = [], nowAt = '2026-11-15T07:00:00Z') {
  const t = { now: Date.parse(nowAt) };
  const tg = fakeTelegram(script);
  const app = await startApp({}, { now: () => t.now, fetchImpl: tg.fetchImpl });
  seedDay(app);
  const rc = loadReportConfig({ ...RENV, ...envExtra });
  app.deps.reportConfig = rc;
  const worker = createWorker(app.deps);
  return { app, t, tg, rc, worker };
}
const tick = async (w) => { await w.tick(); await w.flush(); };

test('scheduler: fires at REPORT_HOUR (Lagos), not before it or after it', async () => {
  const { app, t, tg, worker } = await schedulerApp({}, [], '2026-11-15T05:59:00Z'); // 06:59 Lagos
  try {
    await tick(worker);
    assert.equal(tg.calls.length, 0, '06:59: too early');
    t.now = Date.parse('2026-11-15T06:59:00Z'); // 07:59 Lagos
    await tick(worker);
    assert.equal(tg.calls.length, 0, '07:59: still early');
    t.now = Date.parse('2026-11-15T07:00:00Z'); // 08:00 Lagos
    await tick(worker);
    assert.equal(tg.calls.length, 1, '08:00: sent');
    t.now = Date.parse('2026-11-15T08:00:00Z'); // 09:00 Lagos
    await tick(worker);
    assert.equal(tg.calls.length, 1, '09:00: the hour has passed and today is done');
  } finally { await app.close(); }
});

test('scheduler: two ticks in the same hour send once; the next day sends again', async () => {
  const { app, t, tg, worker } = await schedulerApp();
  try {
    await tick(worker);
    t.now += 60000;
    await tick(worker);
    t.now += 25 * 60000;
    await tick(worker);
    assert.equal(tg.calls.length, 1);
    assert.equal(app.db.prepare("SELECT value FROM settings WHERE key = 'last_report_day'").get().value, '2026-11-15');
    t.now = Date.parse('2026-11-16T07:00:00Z');
    await tick(worker);
    assert.equal(tg.calls.length, 2, 'a new Lagos day, a new card');
    assert.ok(tg.calls[1].body.text.includes('Sun 15 Nov 2026'), 'and it covers the day that just ended');
  } finally { await app.close(); }
});

test('scheduler: REPORT_HOUR is configurable', async () => {
  const { app, t, tg, worker } = await schedulerApp({ REPORT_HOUR: '21' });
  try {
    await tick(worker);
    assert.equal(tg.calls.length, 0, '08:00 is not 21:00');
    t.now = Date.parse('2026-11-15T20:10:00Z'); // 21:10 Lagos
    await tick(worker);
    assert.equal(tg.calls.length, 1);
  } finally { await app.close(); }
});

test('scheduler: a restart during the report hour does not send again (state is written before the send)', async () => {
  const { app, t, tg, rc, worker } = await schedulerApp();
  try {
    await tick(worker);
    assert.equal(tg.calls.length, 1);
    t.now += 10 * 60000;
    const restarted = createWorker({ ...app.deps, reportConfig: rc }); // a fresh process: new in-memory state, same database
    await tick(restarted);
    await tick(restarted);
    assert.equal(tg.calls.length, 1, 'no duplicate');
  } finally { await app.close(); }
});

test('scheduler: last_report_day is already written at the moment the request goes out', async () => {
  let seen = null;
  const t = { now: Date.parse('2026-11-15T07:00:00Z') };
  let app;
  const fetchImpl = async () => {
    seen = app.db.prepare("SELECT value FROM settings WHERE key = 'last_report_day'").get();
    throw new Error('connection reset');
  };
  app = await startApp({}, { now: () => t.now, fetchImpl });
  try {
    seedDay(app);
    app.deps.reportConfig = loadReportConfig(RENV);
    const w = createWorker(app.deps);
    await tick(w);
    assert.equal(seen && seen.value, '2026-11-15', 'written before the send, so a crash mid-send cannot double-send');
  } finally { await app.close(); }
});

test('scheduler: a refusal (400) is not retried that day; the next day sends normally', async () => {
  const { app, t, tg, worker } = await schedulerApp({}, [400]);
  try {
    const lines = await captureLogs(async () => { await tick(worker); });
    assert.equal(tg.calls.length, 1, 'one request: the client does not retry a 400');
    assert.ok(lines.some((l) => /\[coinvoo\] report day=2026-11-14 sent=failed/.test(l)));
    for (let i = 0; i < 12; i++) { t.now += 5 * 60000; await tick(worker); }
    assert.equal(tg.calls.length, 1, 'nothing more that day, however many ticks');
    t.now = Date.parse('2026-11-16T07:00:00Z');
    await tick(worker);
    assert.equal(tg.calls.length, 2);
  } finally { await app.close(); }
});

test('scheduler: network errors are retried up to 3 times, 3 minutes apart, then dropped for the day', async () => {
  // each failed attempt costs 2 requests: the client's own try and its one retry
  const { app, t, tg } = await schedulerApp({}, Array(20).fill('throw'));
  try {
    const rc = Object.assign({}, app.deps.reportConfig, { retryDelayMs: 0 });
    const w = createWorker({ ...app.deps, reportConfig: rc });
    await tick(w);
    assert.equal(tg.calls.length, 2, 'attempt 1: request + the client retry');
    t.now += 2 * 60000;
    await tick(w);
    assert.equal(tg.calls.length, 2, 'before 3 minutes: waiting');
    t.now += 61000;
    await tick(w);
    assert.equal(tg.calls.length, 4, 'retry 1');
    t.now += 3 * 60000;
    await tick(w);
    assert.equal(tg.calls.length, 6, 'retry 2');
    t.now += 3 * 60000;
    await tick(w);
    assert.equal(tg.calls.length, 8, 'retry 3');
    const spent = t.now - Date.parse('2026-11-15T07:00:00Z');
    t.now += 3 * 60000;
    await tick(w);
    assert.equal(tg.calls.length, 8, 'then it gives up for the day');
    assert.ok(spent <= 10 * 60000 + 5000, `all retries fell inside 10 minutes (${spent} ms)`);
  } finally { await app.close(); }
});

test('scheduler: a network error followed by success stops retrying; the retry survives a restart', async () => {
  const { app, t, tg } = await schedulerApp({}, ['throw', 'throw', 'throw', 'throw']);
  try {
    const rc = Object.assign({}, app.deps.reportConfig, { retryDelayMs: 0 });
    let w = createWorker({ ...app.deps, reportConfig: rc });
    await tick(w);
    assert.equal(tg.calls.length, 2);
    t.now += 3 * 60000 + 1000;
    w = createWorker({ ...app.deps, reportConfig: rc }); // restart while a retry is pending
    await tick(w);
    assert.equal(tg.calls.length, 4, 'the pending retry was picked up after the restart (and failed again)');
    t.now += 3 * 60000 + 1000;
    await tick(w);
    assert.equal(tg.calls.length, 5, 'next retry succeeds (script exhausted)');
    t.now += 10 * 60000;
    await tick(w);
    assert.equal(tg.calls.length, 5, 'and that is the end of it');
  } finally { await app.close(); }
});

test('scheduler: a slow or hanging send never blocks the worker tick', async () => {
  const t = { now: Date.parse('2026-11-15T07:00:00Z') };
  let calls = 0;
  const app = await startApp({}, { now: () => t.now, fetchImpl: () => { calls++; return new Promise(() => {}); } });
  try {
    seedDay(app);
    app.deps.reportConfig = loadReportConfig(RENV);
    const w = createWorker(app.deps);
    const t0 = Date.now();
    const s = await w.tick();
    assert.ok(Date.now() - t0 < 1000, 'the tick returned');
    assert.equal(typeof s.parked, 'number', 'and still returned its normal summary');
    t.now += 60000;
    await w.tick();
    await w.tick();
    assert.equal(calls, 1, 'one request in flight; later ticks do not pile on');
  } finally { await app.close(); }
});

test('missing environment: report and alerts no-op cleanly, say so once at boot, never throw', async () => {
  for (const [env, reportOn, alertsOn, repMissing, alMissing] of [
    [{}, false, false, 'REPORT_BOT_TOKEN,REPORT_CHAT_ID', 'REPORT_BOT_TOKEN,ALERT_CHAT_ID'],
    [{ REPORT_BOT_TOKEN: TOKEN }, false, false, 'REPORT_CHAT_ID', 'ALERT_CHAT_ID'],
    [{ REPORT_BOT_TOKEN: TOKEN, REPORT_CHAT_ID: '-1' }, true, false, '', 'ALERT_CHAT_ID'],
    [{ REPORT_CHAT_ID: '-1', ALERT_CHAT_ID: '-2' }, false, false, 'REPORT_BOT_TOKEN', 'REPORT_BOT_TOKEN']
  ]) {
    const t = { now: Date.parse('2026-11-15T07:00:00Z') };
    const tg = fakeTelegram();
    const app = await startApp({}, { now: () => t.now, fetchImpl: tg.fetchImpl });
    try {
      seedDay(app);
      app.deps.reportConfig = loadReportConfig(env);
      const w = createWorker(app.deps);
      const lines = await captureLogs(async () => {
        w.start();
        await w.tick(); await w.flush();
        t.now += 60000;
        await w.tick(); await w.flush();
        w.stop();
      });
      assert.equal(tg.calls.length, reportOn ? 1 : 0, JSON.stringify(Object.keys(env)));
      const boot = lines.filter((l) => /^\[coinvoo\] (report|alerts) (enabled|disabled)/.test(l));
      assert.equal(boot.length, 2, 'one line for the report and one for the alerts, once');
      assert.equal(boot[0], reportOn ? '[coinvoo] report enabled hour=8' : `[coinvoo] report disabled missing=${repMissing}`);
      assert.equal(boot[1], alertsOn ? '[coinvoo] alerts enabled' : `[coinvoo] alerts disabled missing=${alMissing}`);
      assert.ok(!lines.some((l) => l.includes(TOKEN) || l.includes('-1001')), 'neither token nor chat id is logged');
      assert.ok(!lines.some((l) => /ERROR/.test(l)), 'no error');
      if (!reportOn) {
        assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key IN ('last_report_day', 'report_retry')").get().n, 0, 'no state is written while disabled, so the day is not burned');
      }
    } finally { await app.close(); }
  }
});

test('delivery: plain text only, to REPORT_CHAT_ID, with the token in the URL; one message holds every card', async () => {
  const { app, tg, worker } = await schedulerApp();
  try {
    app.db.prepare("UPDATE brands SET active = 1 WHERE code = 'brand-two'").run();
    await tick(worker);
    assert.equal(tg.calls.length, 1);
    const c = tg.calls[0];
    assert.equal(c.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
    assert.deepEqual(Object.keys(c.body).sort(), ['chat_id', 'disable_web_page_preview', 'text']);
    assert.ok(!('parse_mode' in c.body), 'parse_mode is omitted entirely');
    assert.equal(c.body.chat_id, '-1001111');
    assert.notEqual(c.body.chat_id, '-1002222', 'never the alert chat');
    assert.ok(c.body.text.startsWith('COINVOO — brand-one — Sat 14 Nov 2026'));
    assert.ok(c.body.text.includes('COINVOO — brand-two — '));
    assert.ok(c.body.text.includes('ALL BRANDS — '));
    assert.ok(!/[*`]|<[a-z]|&[a-z]+;/i.test(c.body.text), 'no markdown or HTML');
    assert.ok(c.body.text.length <= 4096);
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Telegram client (§7.8)

const OKRES = () => new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
const errRes = (status, extra = {}) => new Response(JSON.stringify({ ok: false, description: `Bad Request: nope ${TOKEN}`, ...extra }), { status });
const quick = { retryDelayMs: 0 };

test('telegram: the timeout is 10 s and is handed to fetch as an abort signal', async () => {
  assert.equal(TELEGRAM_TIMEOUT_MS, 10000);
  let signal;
  const r = await sendMessage({ token: TOKEN, chatId: '1', text: 'hi', ...quick, fetchImpl: async (u, init) => { signal = init.signal; return OKRES(); } });
  assert.equal(r.ok, true);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

test('telegram: a hung request is aborted at the timeout and retried once', async () => {
  let calls = 0;
  const fetchImpl = (u, init) => { calls++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted due to timeout')))); };
  const t0 = Date.now();
  // AbortSignal.timeout() timers are unref'd, and a fake fetch has no socket to hold the loop open.
  const keepAlive = setInterval(() => {}, 20);
  let r;
  try { r = await sendMessage({ token: TOKEN, chatId: '1', text: 'hi', fetchImpl, timeoutMs: 40, ...quick }); } finally { clearInterval(keepAlive); }
  assert.equal(calls, 2, 'one try and exactly one retry');
  assert.deepEqual([r.ok, r.transient, r.attempts], [false, true, 2]);
  assert.match(r.error, /timeout/);
  assert.ok(Date.now() - t0 < 1500);
});

test('telegram: one retry on 5xx and on a network error; success on the retry is success', async () => {
  for (const first of [() => errRes(500), () => errRes(502), () => errRes(503), () => { throw new Error('ECONNRESET'); }]) {
    let n = 0;
    const r = await sendMessage({ token: TOKEN, chatId: '1', text: 'x', ...quick, fetchImpl: async () => { n++; return n === 1 ? first() : OKRES(); } });
    assert.deepEqual([r.ok, r.attempts, r.messageId], [true, 2, 7]);
  }
  let n = 0;
  const r = await sendMessage({ token: TOKEN, chatId: '1', text: 'x', ...quick, fetchImpl: async () => { n++; return errRes(500); } });
  assert.deepEqual([n, r.ok, r.transient, r.status], [2, false, true, 500], 'two 5xx in a row: failed, transient, never a third request');
});

test('telegram: never retries a 400 (or any other refusal)', async () => {
  for (const status of [400, 401, 403, 404]) {
    let n = 0;
    const r = await sendMessage({ token: TOKEN, chatId: '1', text: 'x', ...quick, fetchImpl: async () => { n++; return errRes(status); } });
    assert.deepEqual([n, r.ok, r.transient, r.status, r.attempts], [1, false, false, status, 1], `HTTP ${status}`);
  }
});

test('telegram: 429 is retried once; the token never appears in an error or a log', async () => {
  let n = 0;
  const r = await sendMessage({ token: TOKEN, chatId: '1', text: 'x', ...quick, fetchImpl: async () => { n++; return n === 1 ? errRes(429, { parameters: { retry_after: 0 } }) : OKRES(); } });
  assert.deepEqual([r.ok, n], [true, 2]);
  const bad = await sendMessage({ token: TOKEN, chatId: '1', text: 'x', ...quick, fetchImpl: async () => errRes(400) });
  assert.ok(!bad.error.includes(TOKEN), 'the description echoed the token and it was redacted');
  assert.match(bad.error, /\*\*\*/);
  const net = await sendMessage({ token: TOKEN, chatId: '1', text: 'x', ...quick, fetchImpl: async (u) => { throw new Error(`getaddrinfo ENOTFOUND ${u}`); } });
  assert.ok(!net.error.includes(TOKEN));
});

test('telegram: never throws; bad inputs and odd responses come back as failures', async () => {
  assert.equal((await sendMessage({ token: null, chatId: '1', text: 'x' })).ok, false);
  assert.equal((await sendMessage({ token: TOKEN, chatId: '', text: 'x' })).ok, false);
  let called = false;
  await sendMessage({ token: null, chatId: '1', text: 'x', fetchImpl: async () => { called = true; return OKRES(); } });
  assert.equal(called, false, 'nothing is sent without a token');
  const weird = await sendMessage({ token: TOKEN, chatId: '1', text: 'x', ...quick, fetchImpl: async () => new Response('not json', { status: 200 }) });
  assert.equal(weird.ok, false);
  const nothing = await sendMessage({ token: TOKEN, chatId: '1', text: 'x', ...quick, fetchImpl: async () => undefined });
  assert.equal(nothing.ok, false);
  let sent;
  await sendMessage({ token: TOKEN, chatId: '1', text: 'y'.repeat(9000), fetchImpl: async (u, init) => { sent = JSON.parse(init.body); return OKRES(); } });
  assert.equal(sent.text.length, 4096, 'Telegram rejects longer messages, so they are cut');
});

// ---------------------------------------------------------------------------------------------------------------
// Read API (§5)

test('read API: needs credentials, validates input, answers with generated_at and no-store', async () => {
  const { app } = await fixtureApp();
  try {
    for (const p of [`/api/report/daily?day=${D}`, '/api/summary', '/api/member/7001']) assert.equal((await get(app, p, false)).status, 401, p);
    assert.equal((await get(app, '/api/report/daily?day=2026-02-30')).status, 400);
    assert.equal((await get(app, `/api/report/daily?day=${D}&brand=nope`)).status, 400);
    assert.equal((await get(app, '/api/summary?period=1y')).status, 400);
    assert.equal((await get(app, '/api/member/abc')).status, 400);
    assert.equal((await get(app, '/api/member/99999')).status, 404);
    const r = await get(app, `/api/report/daily?day=${D}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const j = JSON.parse(r.text);
    assert.equal(j.ok, true);
    assert.equal(j.generated_at, NOW);
    assert.equal(j.text, GOLDEN, 'the JSON carries the very text the bot sends');
    assert.equal(JSON.parse((await get(app, '/api/report/daily')).text).day, D, 'no day = yesterday');
    assert.equal(JSON.parse((await get(app, '/api/summary')).text).generated_at, NOW);
  } finally { await app.close(); }
});

test('read API: /api/summary equals the /dash Overview for the same period and brand', async () => {
  const { app } = await fixtureApp();
  try {
    for (const q of ['period=7d&brand=brand-one', 'period=30d', `from=${D}&to=${D}&brand=brand-one`, 'period=today', 'period=7d&brand=brand-two']) {
      const dash = metrics((await get(app, `/dash?${q}`)).text);
      const api = JSON.parse((await get(app, `/api/summary?${q}`)).text);
      assert.deepEqual([api.clicks, api.joins, api.regs, api.ftds, api.redeps, api.revenue, api.unattributed],
        [dash.clicks, dash.joins, dash.regs, dash.ftds, dash.redeps, dash.revenue, dash.unattributed], q);
      assert.deepEqual([api.spend, api.cost_per_join, api.cost_per_ftd, api.roi], [dash.spend, dash.cost_per_join, dash.cost_per_ftd, dash.roi], q);
      assert.deepEqual([api.states.matched, api.states.parked, api.states.expired, api.states.ignored], [dash.matched, dash.parked, dash.expired, dash.ignored], q);
    }
    const day = JSON.parse((await get(app, `/api/summary?from=${D}&to=${D}&brand=brand-one`)).text);
    assert.deepEqual([day.period.key, day.period.from, day.period.to], ['custom', D, D]);
    assert.equal(day.top_campaign.label, 'NG_Broad / 18-34 / vid_03');
    assert.ok(day.previous && 'revenue' in day.previous);
    assert.equal(day.last_event_at, lagos(D, '23:00'));
  } finally { await app.close(); }
});

test('read API: /api/member/:telegram_id gives the value and the last five events, nothing else sensitive', async () => {
  const { app } = await fixtureApp();
  try {
    const mid = app.db.prepare('SELECT id FROM members WHERE telegram_id = 7001').get().id;
    const ev = app.db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, matched_member_id, matched_at, forward_state)
                               VALUES (?, 1, 'affstore', 'dep', 'dep', '19710f1', ?, 'USD', '{"ip":"203.0.113.9"}', ?, 'matched', ?, ?, 'sent')`);
    for (let i = 1; i <= 5; i++) ev.run(`m${i}`, i, lagos(D, `0${i}:00`), mid, NOW);
    const j = JSON.parse((await get(app, '/api/member/7001')).text);
    assert.equal(j.member.telegram_id, 7001);
    assert.equal(j.member.username, 'one');
    assert.equal(j.member.campaign, 'NG_Broad');
    assert.equal(j.events.length, 5, 'the last five');
    assert.deepEqual(j.events.map((e) => e.event_id).slice(0, 2), ['d1', 'f1'], 'newest first');
    assert.deepEqual(j.value.map((v) => [v.currency, v.ftd, v.redep, v.total]), [['USD', 50, 30 + 1 + 2 + 3 + 4 + 5, 50 + 30 + 15]]);
    assert.deepEqual(j.accounts, []);
    assert.ok(!JSON.stringify(j).includes('203.0.113.9') && !('offer_link_tpl' in j.member));
    assert.equal(j.generated_at, NOW);
    // the same Telegram id in two brands needs ?brand=
    app.db.prepare("UPDATE brands SET active = 1 WHERE code = 'brand-two'").run();
    app.db.prepare("INSERT INTO members (brand_id, telegram_id, joined_at, join_source) VALUES (2, 7001, ?, 'bot:start')").run(NOW);
    assert.equal((await get(app, '/api/member/7001')).status, 409);
    assert.equal((await get(app, '/api/member/7001?brand=brand-two')).status, 200);
    assert.equal(JSON.parse((await get(app, '/api/member/7001?brand=brand-one')).text).member.brand, 'brand-one');
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Maintenance: prune payload_json at 12 months, rebuild the last 7 days of rollup

function seedOld(app) {
  const ev = app.db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, country, payload_json, received_at, state, matched_member_id, matched_at, forward_state)
                             VALUES (?, 1, 'affstore', 'ftd', 'ftd', ?, ?, 'USD', 'NG', ?, ?, 'matched', (SELECT id FROM members WHERE telegram_id = 7001), ?, 'sent')`);
  const att = app.db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at) VALUES (?, (SELECT id FROM members WHERE telegram_id = 7001), 'afftrack', 100, ?)");
  const mk = (id, daysAgo, amt) => { const t = NOW - daysAgo * DAY; ev.run(id, `1977${id}`, amt, JSON.stringify({ event_id: id, ip: '203.0.113.9', big: 'x'.repeat(50) }), t, t); att.run(id, t); };
  mk('old1', 400, 11);
  mk('old2', 366, 22);
  mk('edge', 364, 33); // inside the 12 months
  mk('new1', 3, 44);
}

test('maintenance: payloads older than 365 days are blanked; the row, amount and attribution stay', async () => {
  const t = { now: Date.parse('2026-11-15T02:30:00Z') }; // 03:30 Lagos
  const app = await startApp({}, { now: () => t.now });
  try {
    seedDay(app);
    seedOld(app);
    app.deps.reportConfig = loadReportConfig({}); // report off: only the maintenance runs
    const w = createWorker(app.deps);
    const before = Object.fromEntries(app.db.prepare('SELECT event_id, payload_json, amount, state, kind, matched_member_id FROM events').all().map((r) => [r.event_id, { ...r }]));
    assert.ok(before.old1.payload_json.includes('203.0.113.9'));

    const lines = await captureLogs(async () => { await w.tick(); await w.flush(); });
    const after = Object.fromEntries(app.db.prepare('SELECT event_id, payload_json, amount, state, kind, matched_member_id FROM events').all().map((r) => [r.event_id, { ...r }]));
    for (const id of ['old1', 'old2']) {
      assert.equal(after[id].payload_json, PRUNED_PAYLOAD, `${id} blanked`);
      assert.deepEqual([after[id].amount, after[id].state, after[id].kind, after[id].matched_member_id], [before[id].amount, before[id].state, before[id].kind, before[id].matched_member_id], `${id}: row intact`);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM attributions WHERE event_id = ? AND confidence = 100').get(id).n, 1, `${id}: attribution intact`);
    }
    for (const id of ['edge', 'new1', 'f1', 'r1']) assert.equal(after[id].payload_json, before[id].payload_json, `${id} untouched`);
    assert.deepEqual(JSON.parse(PRUNED_PAYLOAD), { pruned: true });
    assert.equal(w.lastMaintenance.pruned, 2);
    assert.ok(lines.includes('[coinvoo] maintenance day=2026-11-15 pruned_payloads=2 ip_raw_blanked=0 rolled_up=7'), lines.filter((l) => l.includes('maintenance')).join('|'));
    assert.equal(app.db.prepare("SELECT value FROM settings WHERE key = 'last_maintenance_day'").get().value, '2026-11-15');

    // the dashboard still renders a pruned event instead of failing
    assert.equal((await get(app, '/dash/events/old1')).status, 200);
    assert.equal(JSON.parse((await get(app, '/api/events/old1')).text).event.payload.pruned, true);
  } finally { await app.close(); }
});

test('maintenance: runs once a day, only after 03:00 Lagos, and is idempotent', async () => {
  const t = { now: Date.parse('2026-11-15T01:30:00Z') }; // 02:30 Lagos
  const app = await startApp({}, { now: () => t.now });
  try {
    seedDay(app);
    seedOld(app);
    app.deps.reportConfig = loadReportConfig({});
    const w = createWorker(app.deps);
    const pruned = () => app.db.prepare("SELECT COUNT(*) AS n FROM events WHERE payload_json = ?").get(PRUNED_PAYLOAD).n;
    await w.tick(); await w.flush();
    assert.equal(pruned(), 0, '02:30: too early');
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'last_maintenance_day'").get().n, 0);
    t.now = Date.parse('2026-11-15T02:00:00Z'); // 03:00 Lagos
    await w.tick(); await w.flush();
    assert.equal(pruned(), 2);
    // a later event aged past a year does not matter until tomorrow
    app.db.prepare("UPDATE events SET received_at = ? WHERE event_id = 'edge'").run(t.now - 400 * DAY);
    t.now += 5 * H;
    await w.tick(); await w.flush();
    assert.equal(pruned(), 2, 'already ran today');
    t.now = Date.parse('2026-11-16T05:00:00Z');
    await w.tick(); await w.flush();
    assert.equal(pruned(), 3, 'next day it runs again and picks up the newly old row');
    t.now = Date.parse('2026-11-17T05:00:00Z');
    const lines = await captureLogs(async () => { await w.tick(); await w.flush(); });
    assert.equal(pruned(), 3, 'running again changes nothing');
    assert.ok(lines.some((l) => /maintenance day=2026-11-17 pruned_payloads=0/.test(l)));
  } finally { await app.close(); }
});

test('maintenance: the previous 7 days of daily_rollup are rebuilt (a missed tick is repaired)', async () => {
  const t = { now: Date.parse('2026-11-15T02:30:00Z') };
  const app = await startApp({}, { now: () => t.now });
  try {
    seedDay(app); // events on 2026-11-14
    app.deps.reportConfig = loadReportConfig({});
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM daily_rollup').get().n, 0);
    const w = createWorker(app.deps);
    await w.tick(); await w.flush();
    const rows = app.db.prepare("SELECT day FROM daily_rollup WHERE brand_id = 1 ORDER BY day").all().map((r) => r.day);
    for (const d of ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']) assert.ok(rows.includes(d), d);
    const r = app.db.prepare("SELECT * FROM daily_rollup WHERE brand_id = 1 AND day = '2026-11-14'").get();
    assert.deepEqual([r.clicks, r.joins, r.ftds, r.redeps, r.revenue, r.spend], [4, 3, 3, 2, 150, 60]);
  } finally { await app.close(); }
});


test('config: the disk alert watches the directory that holds the database', () => {
  assert.equal(loadReportConfig({}, { dbPath: '/srv/coinvoo/coinvoo.db' }).diskPath, '/srv/coinvoo');
  assert.equal(loadReportConfig({}, { dbPath: '/coinvoo.db' }).diskPath, '/', 'a database at the root lives in /, not the working directory');
  assert.equal(loadReportConfig({}, { dbPath: 'coinvoo.db' }).diskPath, '.');
  assert.equal(loadReportConfig({}, { dbPath: ':memory:' }).diskPath, '.');
});
