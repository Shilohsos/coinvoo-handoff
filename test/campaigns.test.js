import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { startApp, seedBulk, until, syncOpens } from './helpers.js';

const H = 3600 * 1000;
const lagosDay = (ms) => new Date(ms + H).toISOString().slice(0, 10);
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

async function get(app, path, { auth = true, headers = {} } = {}) {
  syncOpens(app.db); // fixture links inserted by hand get the open they imply
  const r = await fetch(`${app.base}${path}`, { redirect: 'manual', headers: { ...(auth ? { authorization: app.auth } : {}), ...headers } });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
const post = (app, path, body, { json = true, headers = {} } = {}) => fetch(`${app.base}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { authorization: app.auth, 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded', ...headers },
  body: json ? JSON.stringify(body) : new URLSearchParams(body)
});

// <tr data-row="k"> ... <td data-col="c" data-value="v"> -> { k: { c: v } }
function parseRows(html) {
  const out = {};
  for (const m of html.matchAll(/<tr data-row="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g)) {
    out[decode(m[1])] = Object.fromEntries([...m[2].matchAll(/data-col="([a-z_]+)" data-value="([^"]*)"/g)].map((c) => [c[1], decode(c[2])]));
  }
  return out;
}
const metrics = (html) => Object.fromEntries([...html.matchAll(/data-metric="([a-z_]+)" data-value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const num = (v) => (v === '' ? null : Number(v));

// The directive's fixture (§6.1). 10 opened links in 3 campaigns + 1 null-campaign group, 4 joins,
// 2 FTDs of $50, 1 re-deposit of $10, $100 spend on NG_A. Hand-computed expectations below.
function seedFixture(app) {
  const db = app.db;
  const now = app.deps.now();
  const click = db.prepare('INSERT INTO clicks (click_id, brand_id, campaign, adset, ad, created_at, clicked_at) VALUES (?, 1, ?, ?, ?, ?, ?)');
  const mk = (prefix, n, camp, adset, ad) => { for (let i = 1; i <= n; i++) click.run(`${prefix}${i}`.padEnd(10, '0'), camp, adset, ad, now - 5 * H, now - H); };
  mk('LA', 3, 'NG_A', 'a1', 'ad_a');
  mk('LB', 3, 'NG_B', 'b1', 'ad_b');
  mk('LC', 2, 'NG_C', 'c1', 'ad_c');
  mk('LN', 2, null, null, null);
  const mem = db.prepare("INSERT INTO members (brand_id, telegram_id, username, first_name, joined_at, click_id, join_source) VALUES (1, ?, ?, ?, ?, ?, 'bot:start')");
  mem.run(9001, 'm1', 'One', now - 2 * H, 'LA1'.padEnd(10, '0'));
  mem.run(9002, 'm2', 'Two', now - 2 * H, 'LA2'.padEnd(10, '0'));
  mem.run(9003, 'm3', 'Three', now - 2 * H, 'LB1'.padEnd(10, '0'));
  mem.run(9004, 'm4', 'Four', now - 2 * H, 'LN1'.padEnd(10, '0'));
  const mid = (tg) => db.prepare('SELECT id FROM members WHERE telegram_id = ?').get(tg).id;
  const ev = db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, country, payload_json, received_at, state, matched_member_id, matched_at, forward_state)
                         VALUES (?, 1, 'affstore', ?, ?, ?, ?, 'USD', 'NG', '{}', ?, 'matched', ?, ?, 'skipped')`);
  const att = db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at) VALUES (?, ?, 'afftrack', 100, ?)");
  for (const [id, kind, trader, amount, tg] of [['f1', 'ftd', '197100001', 50, 9001], ['f2', 'ftd', '197100003', 50, 9003], ['f3', 'dep', '197100001', 10, 9001]]) {
    ev.run(id, kind, kind, trader, amount, now - H, mid(tg), now - H);
    att.run(id, mid(tg), now - H);
  }
  db.prepare("INSERT INTO costs (brand_id, day, campaign, adset, ad, spend, currency, created_at) VALUES (1, ?, 'NG_A', 'a1', 'ad_a', 100, 'USD', ?)").run(lagosDay(now), now);
}

const EXPECT = {
  'NG_A|a1|ad_a': { clicks: 3, joins: 2, ftds: 1, revenue: 60, spend: 100, clicks_per_join: 1.5, cost_per_ftd: 100, roi: -40 },
  'NG_B|b1|ad_b': { clicks: 3, joins: 1, ftds: 1, revenue: 50, spend: null, clicks_per_join: 3, cost_per_ftd: null, roi: null },
  'NG_C|c1|ad_c': { clicks: 2, joins: 0, ftds: 0, revenue: 0, spend: null, clicks_per_join: null, cost_per_ftd: null, roi: null },
  '(none)||': { clicks: 2, joins: 1, ftds: 0, revenue: 0, spend: null, clicks_per_join: 2, cost_per_ftd: null, roi: null },
  total: { clicks: 10, joins: 4, ftds: 2, revenue: 110, spend: 100, clicks_per_join: 2.5, cost_per_ftd: 50, roi: 10 }
};

test('campaigns: every row and the totals row match hand-computed values', async () => {
  const app = await startApp();
  try {
    seedFixture(app);
    const r = await get(app, '/dash/campaigns?period=7d&brand=brand-one');
    assert.equal(r.status, 200);
    const rows = parseRows(r.text);
    assert.deepEqual(Object.keys(rows).sort(), Object.keys(EXPECT).sort());
    for (const [key, want] of Object.entries(EXPECT)) {
      for (const [col, v] of Object.entries(want)) {
        assert.equal(num(rows[key][col]), v, `${key}.${col}`);
      }
    }
    // The column order and labels are the directive's.
    assert.match(r.text, /<th>Campaign<\/th><th>Ad set<\/th><th>Ad<\/th><th class="n">Clicks<\/th><th class="n">Joins<\/th><th class="n">Clicks\/Join<\/th><th class="n">FTDs<\/th><th class="n">Revenue<\/th><th class="n">Spend<\/th><th class="n">Cost\/FTD<\/th><th class="n">ROI<\/th>/);
    // Not-computable cells render a dash, not 0 and not infinity.
    const b = r.text.match(/<tr data-row="NG_B\|b1\|ad_b"[\s\S]*?<\/tr>/)[0];
    assert.equal((b.match(/>—</g) || []).length, 3, 'spend, cost/FTD and ROI are — on the row with no spend');
    assert.ok(!/NaN|Infinity/.test(r.text));
  } finally { await app.close(); }
});

test('totals row recomputes ratios from the totals; it is not a sum or average of the row ratios', async () => {
  const app = await startApp();
  try {
    seedFixture(app);
    const rows = parseRows((await get(app, '/dash/campaigns?period=7d&brand=brand-one')).text);
    const perRow = Object.entries(rows).filter(([k]) => k !== 'total');
    const sumOfRatios = perRow.reduce((a, [, r]) => a + (num(r.clicks_per_join) || 0), 0);
    const meanOfRoi = perRow.map(([, r]) => num(r.roi)).filter((v) => v !== null);
    assert.equal(num(rows.total.clicks_per_join), 10 / 4);
    assert.notEqual(num(rows.total.clicks_per_join), sumOfRatios, 'not the sum of per-row clicks/join');
    assert.equal(num(rows.total.roi), ((110 - 100) / 100) * 100);
    assert.notEqual(num(rows.total.roi), meanOfRoi.reduce((a, v) => a + v, 0) / meanOfRoi.length, 'not the mean of per-row ROI');
    assert.equal(num(rows.total.cost_per_ftd), 100 / 2);
  } finally { await app.close(); }
});

test('cost per join, cost per FTD and ROI on the Overview agree with the campaign totals', async () => {
  const app = await startApp();
  try {
    seedFixture(app);
    const m = metrics((await get(app, '/dash?period=7d&brand=brand-one')).text);
    assert.equal(Number(m.spend), 100);
    assert.equal(Number(m.cost_per_join), 100 / 4);
    assert.equal(Number(m.cost_per_ftd), 100 / 2);
    assert.equal(Number(m.roi), 10);
    assert.equal(Number(m.revenue), 110);
  } finally { await app.close(); }
});

test('totals row equals independent SQL sums (written without the app queries)', async () => {
  const app = await startApp();
  try {
    seedFixture(app);
    const now = app.deps.now();
    const start = Math.floor((now + H) / 86400000) * 86400000 - H - 6 * 86400000;
    const end = start + 7 * 86400000;
    const one = (q, ...p) => Object.values(app.db.prepare(q).get(...p))[0];
    const sql = {
      clicks: one('SELECT COUNT(*) FROM clicks WHERE brand_id = 1 AND clicked_at >= ? AND clicked_at < ?', start, end),
      joins: one('SELECT COUNT(*) FROM members WHERE brand_id = 1 AND joined_at >= ? AND joined_at < ?', start, end),
      ftds: one("SELECT COUNT(*) FROM events WHERE brand_id = 1 AND state = 'matched' AND kind = 'ftd' AND received_at >= ? AND received_at < ?", start, end),
      revenue: one("SELECT COALESCE(SUM(amount), 0) FROM events WHERE brand_id = 1 AND state = 'matched' AND kind IN ('ftd','dep') AND currency = 'USD' AND received_at >= ? AND received_at < ?", start, end),
      spend: one("SELECT COALESCE(SUM(spend), 0) FROM costs WHERE brand_id = 1 AND currency = 'USD' AND day >= ? AND day <= ?", lagosDay(start), lagosDay(end - 1))
    };
    const t = parseRows((await get(app, '/dash/campaigns?period=7d&brand=brand-one')).text).total;
    for (const [k, v] of Object.entries(sql)) assert.equal(Number(t[k]), v, k);
    assert.deepEqual(sql, { clicks: 10, joins: 4, ftds: 2, revenue: 110, spend: 100 });
  } finally { await app.close(); }
});

test('(none) row: null-campaign links AND members who never had a link; totals reconcile with the Overview', async () => {
  const app = await startApp();
  try {
    seedFixture(app);
    const now = app.deps.now();
    // An organic member (no link) who deposited $20, and a $15 deposit in another currency.
    app.db.prepare("INSERT INTO members (brand_id, telegram_id, username, joined_at, join_source) VALUES (1, 9005, 'organic', ?, 'organic:bot')").run(now - 2 * H);
    const mid = app.db.prepare('SELECT id FROM members WHERE telegram_id = 9005').get().id;
    for (const [id, amount, cur] of [['o1', 20, 'USD'], ['o2', 150000, 'NGN']]) {
      app.db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, matched_member_id, matched_at, forward_state)
                      VALUES (?, 1, 'affstore', 'ftd', 'ftd', '197100009', ?, ?, '{}', ?, 'matched', ?, ?, 'skipped')`).run(id, amount, cur, now - H, mid, now - H);
      app.db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at) VALUES (?, ?, 'trader_id', 90, ?)").run(id, mid, now);
    }
    const r = await get(app, '/dash/campaigns?period=7d&brand=brand-one');
    const rows = parseRows(r.text);
    assert.deepEqual([rows['(none)||'].clicks, rows['(none)||'].joins, rows['(none)||'].revenue], ['2', '2', '20']);
    assert.equal(rows['(none)||'].ftds, '2', 'the USD and the NGN first deposit both count as FTD events');
    // Revenue is USD only; the NGN deposit is reported beside it, never added in.
    assert.match(r.text, /Not included in Revenue[^<]*₦150,000/);
    const ov = metrics((await get(app, '/dash?period=7d&brand=brand-one')).text);
    assert.equal(Number(rows.total.revenue), Number(ov.revenue), 'campaign totals = Overview revenue');
    assert.equal(Number(rows.total.joins), Number(ov.joins));
    assert.equal(Number(rows.total.clicks), Number(ov.clicks));
    assert.equal(Number(rows.total.revenue), 130);
  } finally { await app.close(); }
});

test('the (none) row is always rendered, also with no data; empty-spend state shows', async () => {
  const app = await startApp();
  try {
    const r = await get(app, '/dash/campaigns');
    assert.equal(r.status, 200);
    const rows = parseRows(r.text);
    assert.deepEqual(Object.keys(rows).sort(), ['(none)||', 'total']);
    assert.deepEqual([rows.total.clicks, rows.total.joins, rows.total.ftds, rows.total.revenue], ['0', '0', '0', '0']);
    assert.equal(rows.total.spend, '', 'no spend entered is a dash, not 0');
    assert.match(r.text, /No spend entered for \d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}/);
    for (const k of ['matched', 'parked', 'expired', 'ignored']) assert.match(r.text, new RegExp(`data-metric="${k}" data-value="0"`));
  } finally { await app.close(); }
});

test('spend with no matching links still shows (its own row, and on (none)) and counts in the totals', async () => {
  const app = await startApp();
  try {
    seedFixture(app);
    const day = lagosDay(app.deps.now());
    await post(app, '/api/spend', { brand: 'brand-one', day, campaign: 'NG_Z', adset: 'z1', ad: 'ad_z', spend: 40 });
    await post(app, '/api/spend', { brand: 'brand-one', day, spend: 15, note: 'no campaign' });
    const rows = parseRows((await get(app, '/dash/campaigns?period=7d&brand=brand-one')).text);
    const z = rows['NG_Z|z1|ad_z'];
    assert.deepEqual([z.clicks, z.joins, z.ftds, z.revenue, z.spend], ['0', '0', '0', '0', '40']);
    assert.equal(num(z.roi), -100, 'spend 40, revenue 0: (0 - 40) / 40');
    assert.equal(z.cost_per_ftd, '', 'no FTDs: dash');
    assert.equal(rows['(none)||'].spend, '15', 'spend with no campaign lands on (none)');
    assert.equal(num(rows.total.spend), 100 + 40 + 15);
    assert.equal(num(rows.total.roi), ((110 - 155) / 155) * 100);
    assert.equal(num(rows.total.cost_per_ftd), 155 / 2);
  } finally { await app.close(); }
});

test('period and brand filters: out-of-period links and spend are excluded; brand-two has its own rows', async () => {
  const app = await startApp();
  try {
    seedFixture(app);
    const now = app.deps.now();
    app.db.prepare("INSERT INTO clicks (click_id, brand_id, campaign, adset, ad, created_at, clicked_at) VALUES ('OLD0000001', 1, 'NG_OLD', 'o', 'o', ?, ?)").run(now - 45 * 86400000, now - 40 * 86400000);
    app.db.prepare("INSERT INTO costs (brand_id, day, campaign, adset, ad, spend, currency, created_at) VALUES (1, ?, 'NG_A', 'a1', 'ad_a', 999, 'USD', 1)").run(lagosDay(now - 40 * 86400000));
    app.db.prepare("INSERT INTO clicks (click_id, brand_id, campaign, adset, ad, created_at, clicked_at) VALUES ('ECHO000001', 2, 'BrandTwoCamp', 'e', 'e', ?, ?)").run(now - 5 * H, now - H);
    let rows = parseRows((await get(app, '/dash/campaigns?period=7d&brand=brand-one')).text);
    assert.ok(!('NG_OLD|o|o' in rows), 'a link opened 40 days ago is not in the 7-day view');
    assert.equal(rows['NG_A|a1|ad_a'].spend, '100', 'spend from 40 days ago is not in the 7-day view');
    rows = parseRows((await get(app, '/dash/campaigns?period=30d&brand=brand-one')).text);
    assert.ok(!('NG_OLD|o|o' in rows), '40 days is outside 30d too');
    rows = parseRows((await get(app, '/dash/campaigns?period=7d&brand=brand-two')).text);
    assert.deepEqual(Object.keys(rows).sort(), ['(none)||', 'BrandTwoCamp|e|e', 'total']);
    assert.equal(rows['BrandTwoCamp|e|e'].clicks, '1');
    rows = parseRows((await get(app, '/dash/campaigns?period=7d')).text);
    assert.ok('NG_A|a1|ad_a|brand-one' in rows && 'BrandTwoCamp|e|e|brand-two' in rows, 'all-brands view tells identical keys apart by brand');
    const day = lagosDay(now);
    rows = parseRows((await get(app, `/dash/campaigns?from=${day}&to=${day}&brand=brand-one`)).text);
    assert.equal(rows.total.clicks, '10');
    assert.equal((await get(app, '/dash/campaigns?period=1y')).status, 400);
    assert.equal((await get(app, '/dash/campaigns?brand=nope')).status, 400);
  } finally { await app.close(); }
});

test('spend upsert: posting twice for the same key leaves one row holding the latest amount', async () => {
  const app = await startApp();
  try {
    const body = { brand: 'brand-one', day: '2026-11-15', campaign: 'NG_Broad', adset: '18-34', ad: 'vid_03', spend: 120.5, currency: 'USD', note: 'TikTok' };
    let r = await post(app, '/api/spend', body);
    assert.equal(r.status, 200);
    const first = (await r.json()).spend;
    assert.deepEqual([first.brand, first.day, first.campaign, first.adset, first.ad, first.spend, first.currency, first.note],
      ['brand-one', '2026-11-15', 'NG_Broad', '18-34', 'vid_03', 120.5, 'USD', 'TikTok']);
    r = await post(app, '/api/spend', { ...body, spend: 80, note: 'corrected' });
    const second = (await r.json()).spend;
    assert.equal(second.id, first.id, 'same row');
    assert.equal(second.spend, 80, 'replaced, not 200.5');
    assert.equal(second.note, 'corrected');
    assert.equal(second.created_at, first.created_at);
    await post(app, '/api/spend', { ...body, spend: 80 });
    await post(app, '/api/spend', { ...body, spend: 120.5 });
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM costs').get().n, 1);
    assert.equal(app.db.prepare('SELECT spend FROM costs').get().spend, 120.5, '120.5 entered twice is 120.5, not 241');
    // a different ad, ad set, campaign or day is another row
    await post(app, '/api/spend', { ...body, ad: 'vid_04' });
    await post(app, '/api/spend', { ...body, day: '2026-11-14' });
    await post(app, '/api/spend', { brand: 'brand-one', day: '2026-11-15', spend: 5 });
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM costs').get().n, 4);
    // GET: newest day first, filters
    const all = (await (await get(app, '/api/spend')).text);
    const rows = JSON.parse(all).spend;
    assert.deepEqual(rows.map((x) => x.day), ['2026-11-15', '2026-11-15', '2026-11-15', '2026-11-14']);
    assert.equal(JSON.parse((await get(app, '/api/spend?from=2026-11-15&to=2026-11-15')).text).count, 3);
    assert.equal(JSON.parse((await get(app, '/api/spend?brand=brand-two')).text).count, 0);
    assert.equal(JSON.parse((await get(app, '/api/spend?limit=2')).text).count, 2);
    assert.equal((await get(app, '/api/spend?from=nope')).status, 400);
  } finally { await app.close(); }
});

test('spend validation: negative -> 422; malformed -> 400; brand and currency rules', async () => {
  const app = await startApp();
  try {
    const ok = { brand: 'brand-one', day: '2026-11-15', spend: 10 };
    let r = await post(app, '/api/spend', { ...ok, spend: -5 });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error, 'negative_spend');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM costs').get().n, 0, 'nothing stored');
    for (const bad of [{ day: '2026-02-30' }, { day: '15/11/2026' }, { day: undefined }, { spend: 'abc' }, { spend: undefined }, { spend: null }, { spend: 1e12 },
      { brand: undefined }, { brand: '' }, { currency: 'US' }, { currency: 'USDX' }, { campaign: 5 }, { note: 'x'.repeat(501) }, { ad: 'y'.repeat(201) }]) {
      r = await post(app, '/api/spend', { ...ok, ...bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await post(app, '/api/spend', { ...ok, brand: 'nope' })).status, 422);
    assert.equal((await post(app, '/api/spend', { ...ok, brand: 'brand-two' })).status, 422, 'brand-two is inactive');
    assert.equal((await fetch(`${app.base}/api/spend`, { method: 'POST', headers: { authorization: app.auth, 'content-type': 'application/json' }, body: '{nope' })).status, 400);
    r = await post(app, '/api/spend', { ...ok, spend: 0 });
    assert.equal(r.status, 200, 'zero spend is a legitimate entry');
    r = await post(app, '/api/spend', { ...ok, day: '2026-11-16', spend: '12.5', currency: 'usd' });
    const row = (await r.json()).spend;
    assert.deepEqual([row.spend, row.currency, row.note], [12.5, 'USD', null], 'numeric strings (form posts) and lower-case codes are normalised');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM costs').get().n, 2);
  } finally { await app.close(); }
});

test('spend: zero spend entered is $0.00 with Cost/FTD $0.00; ROI stays — (no spend to divide by)', async () => {
  const app = await startApp();
  try {
    seedFixture(app);
    app.db.prepare('DELETE FROM costs').run();
    await post(app, '/api/spend', { brand: 'brand-one', day: lagosDay(app.deps.now()), campaign: 'NG_B', adset: 'b1', ad: 'ad_b', spend: 0 });
    const rows = parseRows((await get(app, '/dash/campaigns?period=7d&brand=brand-one')).text);
    assert.equal(rows['NG_B|b1|ad_b'].spend, '0');
    assert.equal(rows['NG_B|b1|ad_b'].cost_per_ftd, '0');
    assert.equal(rows['NG_B|b1|ad_b'].roi, '', 'ROI is — when spend is 0');
  } finally { await app.close(); }
});

test('spend API and screens need credentials; cross-site posts are refused', async () => {
  const app = await startApp();
  try {
    for (const p of ['/dash/campaigns', '/api/spend', '/api/export/members.csv', '/api/export/events.csv', '/api/export/campaigns.csv']) {
      const r = await get(app, p, { auth: false });
      assert.equal(r.status, 401, p);
      assert.equal(r.headers.get('www-authenticate'), 'Basic realm="coinvoo"');
    }
    for (const p of ['/api/spend', '/dash/spend']) assert.equal((await fetch(`${app.base}${p}`, { method: 'POST', body: '{}' })).status, 401, p);
    const body = { brand: 'brand-one', day: '2026-11-15', spend: 1 };
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await post(app, '/api/spend', body, { headers })).status, 403);
      assert.equal((await post(app, '/dash/spend', { ...body, day: '2026-11-15' }, { json: false, headers })).status, 403);
    }
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM costs').get().n, 0);
  } finally { await app.close(); }
});

test('dashboard spend form: saves, replaces, and reports problems through a fixed notice code', async () => {
  const app = await startApp();
  try {
    const day = lagosDay(app.deps.now());
    const form = { brand: 'brand-one', day, campaign: 'NG_Form', adset: 'f1', ad: 'ad_f', spend: '70', currency: 'USD', note: 'from the form', back: '/dash/campaigns?period=7d' };
    let r = await post(app, '/dash/spend', form, { json: false });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/dash/campaigns?period=7d&notice=spend_saved');
    r = await post(app, '/dash/spend', { ...form, spend: '55' }, { json: false });
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM costs').get().n, 1);
    assert.equal(app.db.prepare('SELECT spend FROM costs').get().spend, 55);
    const page = (await get(app, '/dash/campaigns?period=7d&notice=spend_saved')).text;
    assert.match(page, /Spend saved\./);
    assert.match(page, /NG_Form/);
    assert.match(page, /from the form/);
    assert.match((await post(app, '/dash/spend', { ...form, spend: '-3' }, { json: false })).headers.get('location'), /notice=spend_negative/);
    assert.match((await post(app, '/dash/spend', { ...form, day: 'x' }, { json: false })).headers.get('location'), /notice=spend_bad/);
    assert.match((await post(app, '/dash/spend', { ...form, brand: 'brand-two' }, { json: false })).headers.get('location'), /notice=spend_brand/);
    assert.match((await post(app, '/dash/spend', { ...form, back: 'https://evil.example/x' }, { json: false })).headers.get('location'), /^\/dash\/campaigns\?notice=spend_saved$/, 'back is only honoured inside /dash/campaigns');
    const html = (await get(app, '/dash/campaigns?notice=%3Cscript%3E')).text;
    assert.ok(!html.includes('<script>alert') && !/<div class="flash/.test(html), 'unknown notice codes render nothing');
  } finally { await app.close(); }
});

test('escaping: campaign, ad and spend-note text render as text on the campaigns screen', async () => {
  const app = await startApp();
  try {
    const evil = '<script>alert(1)</script>';
    app.db.prepare("INSERT INTO clicks (click_id, brand_id, campaign, adset, ad, created_at, clicked_at) VALUES ('XSS0000001', 1, ?, '\"><img src=x onerror=alert(2)>', ?, ?, ?)").run(evil, evil, app.deps.now(), app.deps.now());
    await post(app, '/api/spend', { brand: 'brand-one', day: lagosDay(app.deps.now()), campaign: evil, spend: 3, note: evil });
    const html = (await get(app, '/dash/campaigns?period=7d')).text;
    assert.ok(!html.includes('<script>alert(1)'));
    assert.ok(!html.includes('<img src=x'));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  } finally { await app.close(); }
});

test('Campaigns appears in the nav on every screen and is highlighted on its own', async () => {
  const app = await startApp();
  try {
    // Phase 11: the sidebar groups the screens (Analytics: ... Campaigns; Operations: Spend, Links, System). Each
    // screen is in the nav everywhere and marked current (class "on", aria-current) only on itself.
    const navLink = (path, label) => new RegExp(`<a href="${path.replace(/\//g, '\\/')}"( class="on" aria-current="page")?><svg[^>]*>[\\s\\S]*?<\\/svg><span>${label}<\\/span>`);
    for (const p of ['/dash', '/dash/members', '/dash/events', '/dash/links', '/dash/campaigns', '/dash/spend', '/dash/system']) {
      const h = (await get(app, p)).text;
      assert.match(h, navLink('/dash/campaigns', 'Campaigns'), p);
      assert.match(h, navLink('/dash/links', 'Links'), p);
      assert.equal((h.match(/aria-current="page"/g) || []).length, 1, `${p}: exactly one current screen`);
    }
    assert.match((await get(app, '/dash/campaigns')).text, /<a href="\/dash\/campaigns" class="on" aria-current="page">/);
    assert.match((await get(app, '/dash/links')).text, /<a href="\/dash\/links" class="on" aria-current="page">/);
    assert.ok(!/<a href="\/dash\/campaigns" class="on"/.test((await get(app, '/dash/links')).text));
  } finally { await app.close(); }
});

test('the campaigns screen carries the attribution-quality block and the unattributed money line', async () => {
  const app = await startApp();
  try {
    seedFixture(app);
    const now = app.deps.now();
    const ev = app.db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, forward_state)
                               VALUES (?, 1, 'affstore', 'ftd', 'ftd', ?, ?, 'USD', '{}', ?, ?, 'none')`);
    ev.run('p1', '197200001', 70, now - H, 'parked');
    ev.run('x1', '197200002', 40, now - 3 * H, 'expired');
    const html = (await get(app, '/dash/campaigns?period=7d&brand=brand-one')).text;
    const m = metrics(html);
    assert.deepEqual([m.matched, m.parked, m.expired, m.ignored], ['3', '1', '1', '0']);
    assert.match(html, /Matched<\/span><span class="pc">60\.0 %<\/span><span class="muted">\(3 \/ 5\)/);
    assert.equal(Number(m.unattributed), 110, 'parked + expired money is reported separately, not in any row');
    assert.equal(Number(parseRows(html).total.revenue), 110, 'and is not added to revenue');
    assert.match(html, /<h2>Attribution quality<\/h2>/);
  } finally { await app.close(); }
});

test('live shape: one real link (LIVE_SMOKE), 3,408 backfilled members, 168 events, zero spend', async () => {
  const app = await startApp();
  try {
    const now = app.deps.now();
    app.db.prepare("INSERT INTO clicks (click_id, brand_id, campaign, adset, ad, created_at, clicked_at) VALUES ('LIVESMOKE1', 1, 'LIVE_SMOKE', 'master_tap', 'v1', ?, ?)").run(now - 20 * 3600000, now - 3600000);
    db_seed_live(app.db, now);
    const r = await get(app, '/dash/campaigns?period=30d&brand=brand-one');
    assert.equal(r.status, 200);
    const rows = parseRows(r.text);
    assert.deepEqual(Object.keys(rows).sort(), ['(none)||', 'LIVE_SMOKE|master_tap|v1', 'total']);
    assert.deepEqual([rows['LIVE_SMOKE|master_tap|v1'].clicks, rows['LIVE_SMOKE|master_tap|v1'].joins], ['1', '0']);
    assert.equal(rows['LIVE_SMOKE|master_tap|v1'].clicks_per_join, '', 'no joins: —');
    assert.ok(Number(rows['(none)||'].joins) > 0 && Number(rows['(none)||'].revenue) > 0, 'organic/backfill members and their revenue sit on (none)');
    assert.equal(rows.total.spend, '');
    assert.match(r.text, /No spend entered/);
    assert.match(r.text, /No spend entered in this period\./);
    const ov = metrics((await get(app, '/dash?period=30d&brand=brand-one')).text);
    assert.equal(Number(rows.total.revenue), Number(ov.revenue), 'reconciles with the Overview');
    const m = metrics(r.text);
    assert.deepEqual([m.matched, m.parked, m.expired, m.ignored], ['89', '40', '37', '2']);
    assert.match(r.text, /Matched<\/span><span class="pc">53\.6 %<\/span>/);
    assert.ok(!/NaN|Infinity|undefined/.test(r.text));
  } finally { await app.close(); }
});

function db_seed_live(db, now) {
  db.exec('BEGIN');
  const mem = db.prepare("INSERT INTO members (brand_id, telegram_id, username, joined_at, join_source) VALUES (1, ?, ?, ?, 'backfill:botdb')");
  const ids = [];
  for (let i = 0; i < 3408; i++) ids.push(Number(mem.run(6_000_000_000 + i, `u${i}`, now - (i % 25) * 86400000).lastInsertRowid));
  const ev = db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, ignore_reason, matched_member_id, matched_at, forward_state)
                         VALUES (?, 1, 'affstore', ?, ?, ?, ?, 'USD', '{}', ?, ?, ?, ?, ?, 'sent')`);
  const att = db.prepare('INSERT INTO attributions (event_id, member_id, path, confidence, decided_at) VALUES (?, ?, ?, ?, ?)');
  const states = [...Array(89).fill('matched'), ...Array(40).fill('parked'), ...Array(37).fill('expired'), ...Array(2).fill('ignored')];
  states.forEach((state, i) => {
    const kind = ['reg', 'ftd', 'dep'][i % 3];
    const t = now - Math.floor((i / 168) * 20 * 86400000);
    const mid = state === 'matched' ? ids[i * 5] : null;
    ev.run(`live-${i}`, kind, kind, state === 'ignored' ? '1' : String(197400000 + i), kind === 'reg' ? null : 20 + i, t, state, state === 'ignored' ? 'stub_guard' : null, mid, mid ? t : null);
    if (state === 'matched') att.run(`live-${i}`, mid, 'trader_id', 90, t);
    else if (state !== 'parked') att.run(`live-${i}`, null, 'none', 0, t);
  });
  db.exec("UPDATE events SET forward_state = 'none' WHERE state = 'parked'");
  db.exec('COMMIT');
}

test('performance: /dash/campaigns renders in < 600 ms on the fixture and on 5,000 events', async () => {
  const app = await startApp();
  try {
    seedFixture(app);
    await get(app, '/dash/campaigns');
    const timed = async (p) => { const t0 = performance.now(); const r = await get(app, p); const ms = performance.now() - t0; assert.equal(r.status, 200); return ms; };
    const small = await timed('/dash/campaigns?period=7d');
    seedBulk(app.db, { events: 5000, members: 3181 });
    for (let i = 0; i < 200; i++) {
      app.db.prepare("INSERT INTO clicks (click_id, brand_id, campaign, adset, ad, created_at, clicked_at) VALUES (?, 1, ?, ?, ?, ?, ?)")
        .run(`BULK${String(i).padStart(6, '0')}`, `C${i % 40}`, `S${i % 7}`, `A${i}`, app.deps.now() - H, app.deps.now() - H);
    }
    await get(app, '/dash/campaigns?period=30d');
    const big = await timed('/dash/campaigns?period=30d');
    console.log(`# perf campaigns fixture=${small.toFixed(0)}ms bulk(5000 events, 200 links)=${big.toFixed(0)}ms`);
    assert.ok(small < 600 && big < 600, `${small} / ${big}`);
  } finally { await app.close(); }
});

void until;
