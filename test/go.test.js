// Phase 9 — GET /go/<brand>: one click minted per visit, for landing-page CTAs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, captureLogs } from './helpers.js';

const CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const BOT = 'coinvoo_test_bot';

const go = (app, path, headers = {}, method = 'GET') =>
  fetch(`${app.base}${path}`, { method, redirect: 'manual', headers: { 'user-agent': CHROME, ...headers } });
const count = (app, table) => app.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const tokenOf = (r) => /^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=c_([0-9A-Z]{10})$/.exec(r.headers.get('location'))[1];

test('1 GET /go/brand-one -> 302 to the gate bot with c_<token>, and exactly one clicks row', async () => {
  const app = await startApp();
  try {
    const r = await go(app, '/go/brand-one');
    assert.equal(r.status, 302);
    const token = tokenOf(r);
    assert.equal(r.headers.get('location'), `https://t.me/${BOT}?start=c_${token}`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-coinvoo-click'), token);
    assert.equal(count(app, 'clicks'), 1);
    assert.equal(count(app, 'click_opens'), 1, 'and exactly one open');
    const row = app.db.prepare('SELECT click_id, brand_id, clicked_at, ua FROM clicks').get();
    assert.equal(row.click_id, token);
    assert.equal(row.brand_id, app.db.prepare("SELECT id FROM brands WHERE code = 'brand-one'").get().id);
    assert.equal(row.ua, CHROME);
    assert.ok(row.clicked_at > 0);
  } finally { await app.close(); }
});

test('2 two consecutive requests mint two different tokens and two rows, with two opens', async () => {
  const app = await startApp();
  try {
    const a = tokenOf(await go(app, '/go/brand-one', { 'x-forwarded-for': '203.0.113.9' }));
    const b = tokenOf(await go(app, '/go/brand-one', { 'x-forwarded-for': '203.0.113.9' }));
    assert.notEqual(a, b);
    assert.equal(count(app, 'clicks'), 2);
    assert.equal(count(app, 'click_opens'), 2, 'same visitor, same IP, seconds apart: still two clicks (no open-dedupe)');
  } finally { await app.close(); }
});

test('3 the ad platform names land in the right columns', async () => {
  const app = await startApp();
  try {
    const q = '?campaign_name=A&adset_name=B&ad_name=C&placement=P&site_source_name=S&fbclid=F&utm_term=T';
    const token = tokenOf(await go(app, `/go/brand-one${q}`));
    const row = app.db.prepare('SELECT campaign, adset, ad, sub1, sub2, fbclid, sub3 FROM clicks WHERE click_id = ?').get(token);
    assert.deepEqual({ ...row }, { campaign: 'A', adset: 'B', ad: 'C', sub1: 'P', sub2: 'S', fbclid: 'F', sub3: 'T' });
  } finally { await app.close(); }
});

test('3b every utm_*, ttclid, gclid and creative is stamped; the first non-empty name wins; values are trimmed and capped', async () => {
  const app = await startApp();
  try {
    const long = 'x'.repeat(300);
    const q = new URLSearchParams({
      utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'UC', utm_content: 'UCON', utm_term: 'UT',
      campaign_name: '  A  ', campaign_id: '999', adset_name: '', adset_id: '555', ad_name: long, creative: 'CR', ttclid: 'TT', gclid: 'GG'
    });
    const token = tokenOf(await go(app, `/go/brand-one?${q}`));
    const row = app.db.prepare('SELECT * FROM clicks WHERE click_id = ?').get(token);
    assert.equal(row.campaign, 'A', 'campaign_name beats campaign_id and utm_campaign, and is trimmed');
    assert.equal(row.adset, '555', 'an empty adset_name falls through to adset_id (utm_medium is lower still)');
    assert.equal(row.ad.length, 200, 'capped at 200 characters');
    assert.equal(row.creative, 'CR');
    assert.deepEqual([row.utm_source, row.utm_medium, row.utm_campaign, row.utm_content, row.utm_term], ['facebook', 'cpc', 'UC', 'UCON', 'UT'],
      'the utm columns keep the raw values even when a utm_ value also fed campaign/adset/ad');
    assert.deepEqual([row.ttclid, row.gclid, row.sub3], ['TT', 'GG', 'UT']);
    // nothing passed: the fields stay empty, nothing is invented
    const bare = app.db.prepare('SELECT * FROM clicks WHERE click_id = ?').get(tokenOf(await go(app, '/go/brand-one')));
    assert.deepEqual([bare.campaign, bare.adset, bare.ad, bare.creative, bare.fbclid, bare.sub1], [null, null, null, null, null, null]);
  } finally { await app.close(); }
});

test('3c the fallbacks: utm_campaign / utm_medium / utm_content feed campaign / adset / ad when nothing earlier is given', async () => {
  const app = await startApp();
  try {
    const token = tokenOf(await go(app, '/go/brand-one?utm_campaign=UC&utm_medium=UM&utm_content=UCON'));
    const row = app.db.prepare('SELECT campaign, adset, ad FROM clicks WHERE click_id = ?').get(token);
    assert.deepEqual({ ...row }, { campaign: 'UC', adset: 'UM', ad: 'UCON' });
  } finally { await app.close(); }
});

test('4 campaign_id is used when campaign_name is absent', async () => {
  const app = await startApp();
  try {
    const token = tokenOf(await go(app, '/go/brand-one?campaign_id=12345'));
    assert.equal(app.db.prepare('SELECT campaign FROM clicks WHERE click_id = ?').get(token).campaign, '12345');
  } finally { await app.close(); }
});

test('5 unknown brand -> 404 "link not found", no row, no open; there is no default brand', async () => {
  const app = await startApp();
  try {
    const r = await go(app, '/go/nope?campaign_name=A');
    assert.equal(r.status, 404);
    assert.equal(await r.text(), 'link not found');
    assert.deepEqual([count(app, 'clicks'), count(app, 'click_opens')], [0, 0]);
    assert.equal((await go(app, '/go/%00')).status, 404, 'odd input is a 404, not a crash');
  } finally { await app.close(); }
});

test('6 inactive brand -> 404, no row', async () => {
  const app = await startApp();
  try {
    app.db.prepare("UPDATE brands SET active = 0 WHERE code = 'brand-one'").run();
    const r = await go(app, '/go/brand-one');
    assert.equal(r.status, 404);
    assert.deepEqual([count(app, 'clicks'), count(app, 'click_opens')], [0, 0]);
  } finally { await app.close(); }
});

test('7 HEAD /go/brand-one -> 302, and no click row and no open', async () => {
  const app = await startApp();
  try {
    const r = await go(app, '/go/brand-one?campaign_name=A', {}, 'HEAD');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `https://t.me/${BOT}`, 'a check carries no token');
    assert.equal(r.headers.get('x-coinvoo-click'), null);
    assert.deepEqual([count(app, 'clicks'), count(app, 'click_opens')], [0, 0]);
    assert.equal((await go(app, '/go/nope', {}, 'HEAD')).status, 404);
    assert.equal(count(app, 'clicks'), 0);
  } finally { await app.close(); }
});

test('8 a crawler user agent still creates the row, flagged is_bot = 1', async () => {
  const app = await startApp();
  try {
    const r = await go(app, '/go/brand-one', { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' });
    assert.equal(r.status, 302);
    assert.equal(count(app, 'clicks'), 1);
    assert.deepEqual(app.db.prepare('SELECT is_bot FROM click_opens').all().map((o) => o.is_bot), [1]);
    await go(app, '/go/brand-one');
    assert.deepEqual(app.db.prepare('SELECT is_bot FROM click_opens ORDER BY id').all().map((o) => o.is_bot), [1, 0], 'a person is is_bot = 0');
  } finally { await app.close(); }
});

test('9 ip_raw is stored beside ip_hash, and appears in no response and no log line', async () => {
  const app = await startApp();
  try {
    const RAW = '198.51.100.77';
    let r;
    const lines = await captureLogs(async () => {
      r = await go(app, '/go/brand-one?campaign_name=A&fbclid=F', { 'x-forwarded-for': RAW });
      await go(app, '/go/nope', { 'x-forwarded-for': RAW });
      await go(app, '/go/brand-one', { 'x-forwarded-for': RAW }, 'HEAD');
    });
    const row = app.db.prepare('SELECT ip_raw, ip_hash FROM clicks').get();
    assert.equal(row.ip_raw, RAW);
    assert.match(row.ip_hash, /^[0-9a-f]{32}$/);
    assert.ok(!(await r.text()).includes(RAW));
    assert.ok(![...r.headers].some(([k, v]) => `${k}${v}`.includes(RAW)), 'no response header carries it');
    assert.ok(lines.length > 0 && !lines.join('\n').includes(RAW), 'no log line carries it');
    assert.ok(lines.some((l) => /^\[coinvoo\] go token=[0-9A-Z]{10} brand=brand-one campaign=A$/.test(l)), 'one log line per visit');
  } finally { await app.close(); }
});

test('10 rate limit: with GO_RATE_PER_SEC=2 the third request in the same second is a 429 and mints nothing', async () => {
  const NOW = Date.parse('2026-11-20T10:00:00Z');
  const app = await startApp({ GO_RATE_PER_SEC: '2' }, { now: () => NOW });
  try {
    assert.equal((await go(app, '/go/brand-one', { 'x-forwarded-for': '203.0.113.5' })).status, 302);
    assert.equal((await go(app, '/go/brand-one', { 'x-forwarded-for': '203.0.113.5' })).status, 302);
    const r = await go(app, '/go/brand-one', { 'x-forwarded-for': '203.0.113.5' });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '1');
    assert.equal(await r.text(), 'rate limited');
    assert.equal(count(app, 'clicks'), 2, 'the refused request left nothing behind');
    assert.equal((await go(app, '/go/brand-one', { 'x-forwarded-for': '203.0.113.6' })).status, 302, 'the limit is per IP');
  } finally { await app.close(); }
});

test('10b GO_RATE_PER_SEC=0 switches the limit off; the default is 20', async () => {
  const off = await startApp({ GO_RATE_PER_SEC: '0' }, { now: () => 1_700_000_000_000 });
  try {
    for (let i = 0; i < 40; i++) assert.equal((await go(off, '/go/brand-one')).status, 302);
    assert.equal(count(off, 'clicks'), 40);
  } finally { await off.close(); }
  const dflt = await startApp({}, { now: () => 1_700_000_000_000 });
  try {
    assert.equal(dflt.config.goRatePerSec, 20);
    const codes = [];
    for (let i = 0; i < 22; i++) codes.push((await go(dflt, '/go/brand-one')).status);
    assert.deepEqual(codes.slice(0, 20), new Array(20).fill(302));
    assert.deepEqual(codes.slice(20), [429, 429]);
  } finally { await dflt.close(); }
});

test('10c GO_RATE_PER_SEC must be a number >= 0', async () => {
  const { loadConfig } = await import('../src/config.js');
  const { testEnv } = await import('./helpers.js');
  assert.throws(() => loadConfig(testEnv({ GO_RATE_PER_SEC: '-1' })), /GO_RATE_PER_SEC must be a number >= 0/);
  assert.throws(() => loadConfig(testEnv({ GO_RATE_PER_SEC: 'lots' })), /GO_RATE_PER_SEC/);
});

test('11 a brand whose bot_username is invalid fails like /c/ does: 500 JSON, no row, the server lives', async () => {
  const app = await startApp();
  try {
    app.db.prepare("UPDATE brands SET bot_username = 'not a bot!' WHERE code = 'brand-one'").run();
    let r;
    await captureLogs(async () => { r = await go(app, '/go/brand-one'); });
    assert.equal(r.status, 500);
    assert.equal((await r.json()).error, 'internal');
    assert.deepEqual([count(app, 'clicks'), count(app, 'click_opens')], [0, 0]);
    app.db.prepare("UPDATE brands SET bot_username = ? WHERE code = 'brand-one'").run(BOT);
    assert.equal((await go(app, '/go/brand-one')).status, 302, 'and it recovers');
  } finally { await app.close(); }
});

test('12 /go/<brand> serves brand-two with its own bot, and /c/:token is untouched', async () => {
  const app = await startApp();
  try {
    assert.equal((await go(app, '/go/brand-two')).status, 404, 'seeded inactive in the test environment, so it is refused');
    app.db.prepare("UPDATE brands SET active = 1 WHERE code = 'brand-two'").run();
    const r = await go(app, '/go/brand-two?campaign_name=E');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `https://t.me/coinvoo_echo_bot?start=c_${tokenOf(r)}`);
    assert.equal(app.db.prepare('SELECT b.code FROM clicks c JOIN brands b ON b.id = c.brand_id').get().code, 'brand-two');
    const { token } = await app.mint({ brand: 'brand-one', campaign: 'LINK' });
    const c = await go(app, `/c/${token}?fbclid=ONE`);
    assert.equal(c.headers.get('location'), `https://t.me/${BOT}?start=c_${token}`);
    assert.equal(app.db.prepare('SELECT campaign, fbclid FROM clicks WHERE click_id = ?').get(token).fbclid, 'ONE');
  } finally { await app.close(); }
});

test('13 end to end: each visitor joins on their own click_id and a deposit matches by click, never click_ambiguous', async () => {
  const app = await startApp();
  try {
    const t1 = tokenOf(await go(app, '/go/brand-one?campaign_name=C&fbclid=FB_ONE', { 'x-forwarded-for': '203.0.113.1' }));
    const t2 = tokenOf(await go(app, '/go/brand-one?campaign_name=C&fbclid=FB_TWO', { 'x-forwarded-for': '203.0.113.2' }));
    assert.notEqual(t1, t2);
    assert.deepEqual(app.db.prepare('SELECT click_id, fbclid FROM clicks ORDER BY created_at, click_id').all().map((c) => c.fbclid).sort(), ['FB_ONE', 'FB_TWO'],
      'each visitor keeps their own fbclid; nobody overwrites anybody');
    assert.equal((await app.join({ brand: 'brand-one', telegram_id: 7100001, click_id: t1 })).status, 200);
    assert.equal((await app.join({ brand: 'brand-one', telegram_id: 7100002, click_id: t2 })).status, 200);
    const bound = (tg) => app.db.prepare('SELECT click_id FROM members WHERE telegram_id = ?').get(tg).click_id;
    assert.deepEqual([bound(7100001), bound(7100002)], [t1, t2], 'members.click_id is the minted token');
    await app.pb({ status: 'ftd', trader_id: '197100001', amount: '50', clickid: t1, event_id: 'go-e1' });
    await app.pb({ status: 'ftd', trader_id: '197100002', amount: '70', clickid: t2, event_id: 'go-e2' });
    const ev = app.db.prepare("SELECT e.event_id, e.state, a.path, a.confidence, m.telegram_id FROM events e JOIN attributions a ON a.event_id = e.event_id JOIN members m ON m.id = a.member_id ORDER BY e.event_id").all();
    assert.deepEqual(ev.map((e) => [e.event_id, e.state, e.path, e.confidence, e.telegram_id]),
      [['go-e1', 'matched', 'click', 85, 7100001], ['go-e2', 'matched', 'click', 85, 7100002]]);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM attribution_log WHERE reason = 'click_ambiguous'").get().n, 0);
  } finally { await app.close(); }
});
