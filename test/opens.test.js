import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, testEnv } from './helpers.js';
import * as Q from '../src/queries.js';
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db.js';
import { createWorker } from '../src/worker.js';
import { loadReportConfig } from '../src/report.js';
import { CRAWLER_UA_RE } from '../src/routes/click.js';

const DAY = 86400000;
const BROWSER = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const open = (app, token, { ip = '203.0.113.10', ua = BROWSER, method = 'GET' } = {}) =>
  fetch(`${app.base}/c/${token}`, { method, redirect: 'manual', headers: { 'x-forwarded-for': ip, 'user-agent': ua } });
const clicksIn = (app, startMs, endMs, brandId = null) => Q.funnel(app.db, { brandId, start: startMs, end: endMs }).clicks;
const dayOf = (ms) => Q.periodRange({ period: 'today' }, ms);

test('history is stable: opening a link today no longer erases yesterday\'s click', async () => {
  const app = await startApp();
  try {
    const { token } = await app.mint();
    await open(app, token);
    app.db.prepare('UPDATE click_opens SET opened_at = opened_at - ?').run(DAY); // that open happened yesterday
    app.db.prepare('UPDATE clicks SET clicked_at = clicked_at - ?').run(DAY);
    const y = dayOf(Date.now() - DAY);
    const t = dayOf(Date.now());
    assert.equal(clicksIn(app, y.start, y.end), 1);
    await open(app, token, { ip: '203.0.113.11' }); // the same ad link, opened again today by someone else
    assert.equal(clicksIn(app, y.start, y.end), 1, 'yesterday still has its click');
    assert.equal(clicksIn(app, t.start, t.end), 1, 'and today has its own');
  } finally { await app.close(); }
});

test('every person opening the link is a click; the same person within a minute counts once', async () => {
  const app = await startApp();
  try {
    const { token } = await app.mint();
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) assert.equal((await open(app, token, { ip })).status, 302);
    await open(app, token, { ip: '203.0.113.1' }); // a double tap / refresh
    const t = dayOf(Date.now());
    assert.equal(clicksIn(app, t.start, t.end), 3);
    app.db.prepare("UPDATE click_opens SET opened_at = opened_at - 61000").run(); // over a minute later
    await open(app, token, { ip: '203.0.113.1' });
    assert.equal(clicksIn(app, t.start - DAY, t.end), 4, 'a return visit after the window is a new click');
    // the link row itself still carries the latest open, as before
    assert.ok(app.db.prepare('SELECT clicked_at FROM clicks WHERE click_id = ?').get(token).clicked_at > 0);
  } finally { await app.close(); }
});

test('link-preview crawlers are recorded but never counted; HEAD records nothing', async () => {
  const app = await startApp();
  try {
    const { token } = await app.mint();
    const crawlers = ['TelegramBot (like TwitterBot)', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'WhatsApp/2.23.20.0', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Slackbot-LinkExpanding 1.0'];
    for (const [i, ua] of crawlers.entries()) {
      assert.ok(CRAWLER_UA_RE.test(ua), ua);
      assert.equal((await open(app, token, { ip: `198.51.100.${i}`, ua })).status, 302, 'crawlers are still redirected');
    }
    for (const ua of [BROWSER, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 300.0', 'CUBOT_X30 Build/QP1A']) assert.ok(!CRAWLER_UA_RE.test(ua), ua);
    await fetch(`${app.base}/c/${token}`, { method: 'HEAD', redirect: 'manual' });
    const t = dayOf(Date.now());
    assert.equal(clicksIn(app, t.start, t.end), 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM click_opens WHERE is_bot = 1').get().n, crawlers.length, 'kept for the record');
    await open(app, token);
    assert.equal(clicksIn(app, t.start, t.end), 1);
  } finally { await app.close(); }
});

test('Clicks/Join is now a real click-to-join rate on the campaigns screen; the links screen shows opens', async () => {
  const app = await startApp();
  try {
    const { token } = await app.mint({ brand: 'brand-one', campaign: 'NG_Rate', adset: 'a', ad: 'v1' });
    for (let i = 1; i <= 4; i++) await open(app, token, { ip: `203.0.113.${i}` });
    await app.join({ brand: 'brand-one', telegram_id: 9301, click_id: token, source: 'bot:start' });
    await app.join({ brand: 'brand-one', telegram_id: 9302, click_id: token, source: 'bot:start' });
    const t = dayOf(Date.now());
    const perf = Q.campaignPerf(app.db, { brandId: 1, start: t.start, end: t.end, fromDay: t.fromDay, toDay: t.toDay });
    const row = perf.rows.find((r) => r.campaign === 'NG_Rate');
    assert.deepEqual([row.clicks, row.joins, row.clicks_per_join], [4, 2, 2]);
    const html = await (await fetch(`${app.base}/dash/links`, { headers: { authorization: app.auth } })).text();
    assert.match(html, /<th class="n">Opens<\/th>/);
    const j = await (await fetch(`${app.base}/api/clicks`, { headers: { authorization: app.auth } })).json();
    assert.equal(j.clicks.find((c) => c.click_id === token).opens, 4);
  } finally { await app.close(); }
});

test('migration 005 backfills one open per link that was opened, so deploy-day numbers do not move', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coinvoo-opens-'));
  try {
    const migs = join(dir, 'migs');
    mkdirSync(migs);
    const src = new URL('../migrations/', import.meta.url).pathname;
    for (const f of readdirSync(src)) if (f < '005') copyFileSync(join(src, f), join(migs, f));
    const cfg = loadConfig(testEnv({ DB_PATH: join(dir, 'p4.db') }));
    const db = openDb(cfg.dbPath);
    migrate(db, { dir: migs, env: cfg.brandSeed }); // a Phase 4 database
    const now = Date.now();
    const ins = db.prepare('INSERT INTO clicks (click_id, brand_id, campaign, created_at, clicked_at, ip_hash) VALUES (?, 1, ?, ?, ?, ?)');
    ins.run('OPENED0001', 'A', now - 3 * DAY, now - 2 * DAY, 'h1');
    ins.run('OPENED0002', 'A', now - 3 * DAY, now - DAY, 'h2');
    ins.run('NEVER00001', 'B', now - 3 * DAY, null, null);
    const before = db.prepare('SELECT COUNT(*) AS n FROM clicks WHERE clicked_at >= ?').get(now - 7 * DAY).n;
    const m = migrate(db, { env: cfg.brandSeed }); // the real directory: 005 applies
    assert.deepEqual([m.newlyApplied, m.latest], [8, '012_click_ad_ids']); // 005, then the additive 006 to 012
    const opens = db.prepare('SELECT click_id, opened_at, ip_hash, is_bot FROM click_opens ORDER BY click_id').all().map((r) => ({ ...r }));
    assert.deepEqual(opens, [
      { click_id: 'OPENED0001', opened_at: now - 2 * DAY, ip_hash: 'h1', is_bot: 0 },
      { click_id: 'OPENED0002', opened_at: now - DAY, ip_hash: 'h2', is_bot: 0 }
    ]);
    assert.equal(Q.funnel(db, { brandId: null, start: now - 7 * DAY, end: now + 1 }).clicks, before, 'same number as the old definition on the day of the deploy');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('daily_rollup counts the same clicks as the dashboard', async () => {
  const app = await startApp();
  try {
    const { token } = await app.mint();
    for (const ip of ['203.0.113.1', '203.0.113.2']) await open(app, token, { ip });
    await open(app, token, { ip: '198.51.100.9', ua: 'TelegramBot (like TwitterBot)' });
    app.deps.reportConfig = loadReportConfig({});
    await createWorker(app.deps).tick();
    const t = dayOf(Date.now());
    const r = app.db.prepare('SELECT clicks FROM daily_rollup WHERE brand_id = 1 AND day = ?').get(t.fromDay);
    assert.equal(r.clicks, 2);
    assert.equal(r.clicks, clicksIn(app, t.start, t.end, 1));
  } finally { await app.close(); }
});

test('silence alert: a crawler unfurling a link is not people opening links', async () => {
  const { runAlerts } = await import('../src/alerts.js');
  const now = Date.now();
  const sent = [];
  const app = await startApp({}, { now: () => now, fetchImpl: async (u, init) => { sent.push(JSON.parse(init.body).text); return new Response('{"ok":true,"result":{"message_id":1}}'); } });
  try {
    const rc = Object.assign({}, loadReportConfig({ REPORT_BOT_TOKEN: '1:fake', ALERT_CHAT_ID: '-2' }), { retryDelayMs: 0 });
    app.db.prepare("INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, forward_state) VALUES ('e1', 1, 'affstore', 'reg', 'reg', '197000001', NULL, 'USD', '{}', ?, 'parked', 'none')").run(now - 9 * 3600000);
    const { token } = await app.mint();
    await open(app, token, { ua: 'TelegramBot (like TwitterBot)' });
    await runAlerts(app.deps, rc, {});
    assert.deepEqual(sent, [], 'only a crawler opened a link: no silence alert');
    await open(app, token, { ip: '203.0.113.50' });
    await runAlerts(app.deps, rc, {});
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^COINVOO — no postbacks for 9 h/);
  } finally { await app.close(); }
});
