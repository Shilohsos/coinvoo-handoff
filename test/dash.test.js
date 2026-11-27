import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { startApp, makeSnapshot, seedDashFixture, seedBulk, invariants, allZero, until } from './helpers.js';
import { fmtTime, fmtMoney, fmtPct, fmtDelta, fmtAgo } from '../src/render.js';
import { createWorker } from '../src/worker.js';

const DAY = 86400000;
const todayStart = (now) => Math.floor((now + 3600000) / DAY) * DAY - 3600000;

async function get(app, path, { auth = true, headers = {} } = {}) {
  const r = await fetch(`${app.base}${path}`, { redirect: 'manual', headers: { ...(auth ? { authorization: app.auth } : {}), ...headers } });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
const post = (app, path, body, { json = false, headers = {} } = {}) => fetch(`${app.base}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { authorization: app.auth, 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded', ...headers },
  body: json ? JSON.stringify(body) : new URLSearchParams(body)
});
const metrics = (html) => Object.fromEntries([...html.matchAll(/data-metric="([a-z_]+)" data-value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const rowsIn = (html) => (html.match(/<tbody>[\s\S]*<\/tbody>/) || [''])[0].split('<tr').length - 1;

async function fixtureApp(extra = {}, opts = {}) {
  const app = await startApp(extra, opts);
  seedDashFixture(app.db, app.deps.now());
  return app;
}

test('401 without credentials on every protected path; public paths stay public', async () => {
  const app = await fixtureApp();
  try {
    const protectedGet = ['/dash', '/dash/members', '/dash/members/1', '/dash/events', '/dash/events/e1', '/dash/links',
      '/api/members', '/api/members/1', '/api/events', '/api/events/e1', '/api/clicks'];
    for (const p of protectedGet) {
      const r = await get(app, p, { auth: false });
      assert.equal(r.status, 401, p);
      assert.equal(r.headers.get('www-authenticate'), 'Basic realm="coinvoo"', p);
    }
    for (const p of ['/dash/links', '/dash/events/e5/attach', '/api/events/e5/attach']) {
      const r = await fetch(`${app.base}${p}`, { method: 'POST', body: '{}' });
      assert.equal(r.status, 401, p);
    }
    const wrong = await get(app, '/dash', { auth: false, headers: { authorization: 'Basic ' + Buffer.from('admin:nope').toString('base64') } });
    assert.equal(wrong.status, 401);
    // public surface is unchanged
    assert.equal((await get(app, '/api/aff/health', { auth: false })).status, 200);
    assert.equal((await get(app, '/api/aff/stats', { auth: false })).status, 200);
    assert.equal((await get(app, '/c/ZZZZZZZZZZ', { auth: false })).status, 404);
    assert.equal((await get(app, '/api/aff?status=reg&trader_id=197000999&event_id=pub1', { auth: false })).status, 200);
    assert.notEqual((await app.join({ brand: 'brand-one', telegram_id: 4242 })).status, 401);
    // raw payloads are never on a public route
    assert.ok(!(await get(app, '/api/aff/stats', { auth: false })).text.includes('payload'));
  } finally { await app.close(); }
});

test('overview numbers equal direct SQL for the same period (7d, brand filter, today)', async () => {
  const app = await fixtureApp();
  try {
    const now = app.deps.now();
    const sql = (q, ...p) => app.db.prepare(q).get(...p).n;
    for (const [period, brand] of [['7d', 'all'], ['30d', 'all'], ['today', 'all'], ['7d', 'brand-one'], ['7d', 'brand-two']]) {
      const start = todayStart(now) - (period === '7d' ? 6 : period === '30d' ? 29 : 0) * DAY;
      const end = todayStart(now) + DAY;
      const bid = brand === 'all' ? null : app.db.prepare('SELECT id FROM brands WHERE code = ?').get(brand).id;
      const ev = (where, ...p) => sql(`SELECT COUNT(*) AS n FROM events WHERE (? IS NULL OR brand_id = ?) AND received_at >= ? AND received_at < ? AND ${where}`, bid, bid, start, end, ...p);
      const usd = (state) => sql(`SELECT COALESCE(SUM(amount),0) AS n FROM events WHERE (? IS NULL OR brand_id = ?) AND received_at >= ? AND received_at < ? AND currency = 'USD' AND kind IN ('ftd','dep') AND state IN (${state})`, bid, bid, start, end);
      const expected = {
        clicks: sql('SELECT COUNT(*) AS n FROM click_opens WHERE (? IS NULL OR brand_id = ?) AND is_bot = 0 AND opened_at >= ? AND opened_at < ?', bid, bid, start, end),
        joins: sql('SELECT COUNT(*) AS n FROM members WHERE (? IS NULL OR brand_id = ?) AND joined_at >= ? AND joined_at < ?', bid, bid, start, end),
        regs: ev("kind = 'reg' AND state <> 'ignored'"),
        ftds: ev("kind = 'ftd' AND state <> 'ignored'"),
        redeps: ev("kind = 'dep' AND state <> 'ignored'"),
        revenue: usd("'matched'"),
        unattributed: usd("'parked','expired'"),
        matched: ev("state = 'matched'"), parked: ev("state = 'parked'"), expired: ev("state = 'expired'"), ignored: ev("state = 'ignored'")
      };
      const q = period === 'today' ? 'period=today' : `period=${period}`;
      const m = metrics((await get(app, `/dash?${q}&brand=${brand}`)).text);
      for (const [k, v] of Object.entries(expected)) assert.equal(Number(m[k]), v, `${period}/${brand}/${k}`);
    }
    // spot-check the fixture by hand so the SQL above is not the only oracle
    const m = metrics((await get(app, '/dash?period=7d&brand=brand-one')).text);
    assert.deepEqual([m.ftds, m.redeps, m.regs, m.revenue, m.unattributed, m.matched, m.parked, m.expired, m.ignored],
      ['4', '3', '1', '350', '135', '5', '2', '1', '1']);
  } finally { await app.close(); }
});

test('overview: percentages follow docs/03 §8, spend/ROI are — until spend exists, then computed', async () => {
  const app = await fixtureApp();
  try {
    let html = (await get(app, '/dash?period=7d&brand=brand-one')).text;
    // matched 5 / (5 + 2 + 1) = 62.5 %
    assert.match(html, /Matched<\/span><span class="pc">62\.5 %<\/span><span class="muted">\(5 \/ 8\)/);
    assert.match(html, /Parked<\/span><span class="pc">25\.0 %/);
    assert.match(html, /Expired<\/span><span class="pc">12\.5 %/);
    assert.match(html, /Ignored<\/span><span class="pc">1</);
    const m0 = metrics(html);
    assert.equal(m0.spend, '');
    assert.equal(m0.roi, '');
    assert.match(html, /ROI<\/div><div class="tv">—/);

    const day = new Date(app.deps.now() + 3600000).toISOString().slice(0, 10);
    app.db.prepare("INSERT INTO costs (brand_id, day, spend, currency, created_at) VALUES (1, ?, 175, 'USD', 1)").run(day);
    html = (await get(app, '/dash?period=7d&brand=brand-one')).text;
    const m = metrics(html);
    assert.equal(Number(m.spend), 175);
    assert.equal(Number(m.roi), ((350 - 175) / 175) * 100);
    assert.equal(Number(m.cost_per_ftd), 175 / 4, '4 ftd events in the period (matched, parked, expired)');
    assert.match(html, /\+100\.0 %/);
  } finally { await app.close(); }
});

test('overview: the quality block is always rendered, empty database shows the empty state and dashes', async () => {
  const app = await startApp();
  try {
    const html = (await get(app, '/dash')).text;
    assert.match(html, /No traffic recorded yet\. Create a link on the Links screen\./);
    for (const k of ['matched', 'parked', 'expired', 'ignored']) assert.match(html, new RegExp(`data-metric="${k}" data-value="0"`));
    assert.match(html, /Matched<\/span><span class="pc">—/);
    assert.match(html, /Spend<\/div><div class="tv">—/);
  } finally { await app.close(); }
});

test('overview: unknown period or brand -> 400, custom range works, deltas are — without a previous period', async () => {
  const app = await fixtureApp();
  try {
    assert.equal((await get(app, '/dash?period=1y')).status, 400);
    assert.equal((await get(app, '/dash?brand=nope')).status, 400);
    assert.equal((await get(app, '/dash?from=2026-02-30x&to=2026-03-01')).status, 400);
    const day = new Date(app.deps.now() + 3600000).toISOString().slice(0, 10);
    const r = await get(app, `/dash?from=${day}&to=${day}`);
    assert.equal(r.status, 200);
    assert.equal(fmtDelta(5, 0), '—');
    assert.equal(fmtDelta(15, 10), '+50.0 %');
    assert.equal(fmtDelta(5, 10), '-50.0 %');
  } finally { await app.close(); }
});

test('members: search matches telegram id, username, first name, broker id (accounts and bot snapshot)', async () => {
  const snap = makeSnapshot([{ telegram_id: 1002, iq_user_id: '197555555' }]);
  const app = await startApp({ BOTDB_SNAPSHOT: snap.path });
  seedDashFixture(app.db, app.deps.now());
  try {
    const find = async (q) => {
      const r = await get(app, `/api/members?q=${encodeURIComponent(q)}`);
      assert.equal(r.status, 200);
      return JSON.parse(r.text).members.map((m) => m.telegram_id).sort();
    };
    assert.deepEqual(await find('1003'), [1003], 'telegram id');
    assert.deepEqual(await find('camp_chidi'), [1003], 'username');
    assert.deepEqual(await find('@camp_chi'), [1003], '@ prefix and partial username');
    assert.deepEqual(await find('Ngozi'), [1004], 'first name');
    assert.deepEqual(await find('197000003'), [1003], 'broker id linked in accounts');
    assert.deepEqual(await find('197555555'), [1002], 'broker id known only to the bot snapshot');
    app.db.prepare("INSERT INTO members (brand_id, telegram_id, username, first_name, joined_at, join_source) VALUES (1, 7777, 'user1003x', '1003 Club', 1, 'organic:bot')").run();
    assert.deepEqual(await find('1003'), [1003], 'an all-digit query is an id, not a substring of names');
    assert.deepEqual(await find('user1003'), [7777], 'a text query still substring-matches usernames');
    assert.deepEqual(await find('nobody'), []);
    assert.deepEqual(await find('%'), [], 'LIKE wildcards are escaped');
    const html = (await get(app, '/dash/members?q=197000003')).text;
    assert.match(html, />1003</);
    assert.ok(!html.includes('>1004<'));
  } finally { await app.close(); snap.cleanup(); }
});

test('members: columns, source, path, value, sorting, filters', async () => {
  const app = await fixtureApp();
  try {
    const r = JSON.parse((await get(app, '/api/members?brand=brand-one')).text);
    const by = Object.fromEntries(r.members.map((m) => [m.telegram_id, m]));
    assert.equal(r.total, 5);
    assert.deepEqual([by[1001].ftd, by[1001].redep, by[1001].total, by[1001].path], [100, 50, 150, 'afftrack']);
    assert.equal(by[1003].path, 'click');
    assert.equal(by[1003].total, 200);
    assert.deepEqual(by[1005].other_currencies, [{ currency: 'NGN', amount: 150000 }]);
    assert.equal(by[1005].total, 0, 'USD columns never include other currencies');
    assert.deepEqual(r.members.map((m) => m.telegram_id).slice(0, 2), [1003, 1001], 'default sort: total desc');

    const html = (await get(app, '/dash/members?brand=brand-one')).text;
    assert.match(html, /NG_Broad \/ vid_03/, 'source = campaign / ad of the bound click');
    assert.match(html, />channel</);
    assert.match(html, />organic</);
    assert.match(html, />backfill</);
    assert.match(html, /\+₦150,000/, 'non-USD value is labelled, not summed');

    const asc = JSON.parse((await get(app, '/api/members?brand=brand-one&sort=joined&dir=asc')).text).members.map((m) => m.telegram_id);
    assert.equal(asc[0], 1005);
    assert.equal(JSON.parse((await get(app, '/api/members?ftd=has')).text).total, 2);
    assert.equal(JSON.parse((await get(app, '/api/members?ftd=no&brand=brand-one')).text).total, 3);
    assert.equal(JSON.parse((await get(app, '/api/members?brand=brand-two')).text).total, 1);
    const day = new Date(app.deps.now() + 3600000).toISOString().slice(0, 10);
    assert.equal(JSON.parse((await get(app, `/api/members?from=${day}&to=${day}&brand=brand-one`)).text).total >= 1, true);
    assert.equal((await get(app, '/api/members?from=bad')).status, 400);
    // sort keys outside the allow-list are ignored, never interpolated
    assert.equal((await get(app, '/dash/members?sort=1;DROP TABLE members')).status, 200);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM members').get().n, 6);
  } finally { await app.close(); }
});

test('member detail: identity, value, click context, trail, actions; organic member says so', async () => {
  const app = await fixtureApp();
  try {
    app.db.prepare("UPDATE brands SET offer_link_tpl = 'https://broker.example/lp/?aff=AFF&afftrack={AFFTRACK}' WHERE code = 'brand-one'").run();
    const id = app.db.prepare('SELECT id FROM members WHERE telegram_id = 1001').get().id;
    const html = (await get(app, `/dash/members/${id}`)).text;
    assert.match(html, /NG_Broad/);
    assert.match(html, /ttclid yes · fbclid no · gclid no/);
    assert.match(html, /\$100\.00/);
    assert.match(html, /\$150\.00/);
    assert.match(html, /afftrack/);
    assert.match(html, /afftrack=1001/, 'offer link has the member Telegram id filled in');
    assert.match(html, /Open raw events/);
    assert.match(html, /per ad, not per person/);
    // Phase 11: the trail is a timeline, one <li> per event, kind as its class.
    const trailKinds = [...html.matchAll(/<li class="(ftd|dep|reg)"><span class="kind \1">(FTD|DEP|REG)<\/span>/g)].map((m) => m[2]);
    assert.deepEqual(trailKinds, ['DEP', 'FTD'], 'newest first');

    const organic = app.db.prepare('SELECT id FROM members WHERE telegram_id = 1002').get().id;
    assert.match((await get(app, `/dash/members/${organic}`)).text, /organic — no ad link/);
    assert.equal((await get(app, '/dash/members/99999')).status, 404);
    assert.equal((await get(app, '/dash/members/abc')).status, 404);
    const j = JSON.parse((await get(app, `/api/members/${id}`)).text);
    assert.equal(j.events.length, 2);
    assert.ok(!('offer_link_tpl' in j.member));
  } finally { await app.close(); }
});

test('events: tabs show only their state; parked rows carry a reason and an Attach form', async () => {
  const app = await fixtureApp();
  try {
    const states = async (tab) => JSON.parse((await get(app, `/api/events?state=${tab}`)).text).events.map((e) => e.event_id).sort();
    assert.deepEqual(await states('parked'), ['e5', 'e6']);
    assert.deepEqual(await states('ignored'), ['e8']);
    const parkedHtml = (await get(app, '/dash/events?tab=parked')).text;
    assert.equal((parkedHtml.match(/class="tag t-parked"/g) || []).length, 2);
    assert.ok(!/t-matched|t-ignored|t-expired/.test(parkedHtml.replace(/<style>[\s\S]*?<\/style>/, '')));
    assert.match(parkedHtml, /no member for trader_id/);
    assert.match(parkedHtml, /afftrack_unknown/);
    assert.match(parkedHtml, />Attach to a member<\/summary>/);
    assert.match(parkedHtml, /<form class="attach" method="post" action="\/dash\/events\/e5\/attach">/);
    const ignoredHtml = (await get(app, '/dash/events?tab=ignored')).text;
    assert.match(ignoredHtml, /stub_guard/);
    assert.ok(!/Attach to a member<\/summary>/.test(ignoredHtml));
    assert.equal(rowsIn((await get(app, '/dash/events?tab=all')).text) >= 9, true);
    assert.equal((await get(app, '/api/events?state=bogus')).status, 400);
    assert.equal(JSON.parse((await get(app, '/api/events?q=197000001')).text).total, 2);
    assert.equal(JSON.parse((await get(app, '/api/events?member=' + app.db.prepare('SELECT id FROM members WHERE telegram_id = 1001').get().id)).text).total, 2);
  } finally { await app.close(); }
});

test('raw viewer: pretty payload and attribution log lines; secrets and IPs are redacted', async () => {
  const app = await fixtureApp();
  try {
    const page = (await get(app, '/dash/events/e6')).text;
    assert.match(page, /afftrack_unknown\s+\[9999999999\]/);
    assert.match(page, /parked:no_member/);
    assert.match(page, /&quot;trader_id&quot;: &quot;197888888&quot;/);
    for (const html of [page, (await get(app, '/dash/events?tab=parked')).text, (await get(app, '/dash/events/e1')).text]) {
      assert.ok(!html.includes('203.0.113.9'), 'no raw IP on any screen');
      assert.ok(!html.includes('sekret-token'), 'no token on any screen');
      assert.match(html, /\[redacted\]/);
    }
    const j = JSON.parse((await get(app, '/api/events/e6')).text);
    assert.equal(j.event.payload.trader_id, '197888888');
    assert.equal(j.event.log.length, 2);
    assert.equal((await get(app, '/dash/events/nope')).status, 404);
  } finally { await app.close(); }
});

test('manual attach: moves the event out of the park, writes attribution and log; invariants hold', async () => {
  const sent = [];
  const app = await startApp({ PARALLEL_FORWARD: '1', JOINVOO_PB: 'https://joinvoo.example/pb/x' }, { fetchImpl: async (u) => { sent.push(u); return new Response('ok'); } });
  seedDashFixture(app.db, app.deps.now());
  try {
    const mid = app.db.prepare('SELECT id FROM members WHERE telegram_id = 1004').get().id;
    // HTML form path: resolve by Telegram id, note required
    let r = await post(app, '/dash/events/e5/attach', { member: '1004', note: '', back: '/dash/events?tab=parked' });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('location'), /notice=note_required/);
    assert.equal(app.db.prepare("SELECT state FROM events WHERE event_id = 'e5'").get().state, 'parked');

    r = await post(app, '/dash/events/e5/attach', { member: '@nobody_here', note: 'x', back: '/dash/events?tab=parked' });
    assert.match(r.headers.get('location'), /notice=no_member/);

    r = await post(app, '/dash/events/e5/attach', { member: '@Chan_Ngozi', note: 'confirmed by DM', back: '/dash/events?tab=parked&page=2' });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('location'), /^\/dash\/events\?tab=parked&page=2&notice=attached$/);

    const e = app.db.prepare("SELECT state, matched_member_id, forward_state FROM events WHERE event_id = 'e5'").get();
    assert.deepEqual([e.state, e.matched_member_id], ['matched', mid]);
    assert.ok(['pending', 'sent'].includes(e.forward_state), 'queued for the Joinvoo forward (already sent if the stub answered first)');
    const a = app.db.prepare("SELECT member_id, path, confidence, note FROM attributions WHERE event_id = 'e5'").get();
    assert.deepEqual({ ...a }, { member_id: mid, path: 'manual', confidence: 100, note: 'confirmed by DM' });
    const l = app.db.prepare("SELECT candidate, reason FROM attribution_log WHERE event_id = 'e5' AND reason LIKE 'manual_attach%'").get();
    assert.deepEqual({ ...l }, { candidate: '1004', reason: 'manual_attach: confirmed by DM' });
    assert.equal(JSON.parse((await get(app, '/api/events?state=parked')).text).total, 1, 'out of the park');
    assert.match((await get(app, '/dash/events?tab=matched')).text, /manual/);
    assert.equal(await until(() => app.db.prepare("SELECT forward_state FROM events WHERE event_id = 'e5'").get().forward_state === 'sent'), true);
    assert.equal(sent.length, 1, 'the attached event is forwarded like any matched event');

    // a second attach is refused, JSON path
    r = await post(app, '/api/events/e5/attach', { member_id: mid, note: 'again' }, { json: true });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'not_parked');
    // JSON path, other errors
    assert.equal((await post(app, '/api/events/e6/attach', { member_id: mid }, { json: true })).status, 400);
    assert.equal((await post(app, '/api/events/e6/attach', { member_id: 99999, note: 'n' }, { json: true })).status, 422);
    assert.equal((await post(app, '/api/events/zzz/attach', { member_id: mid, note: 'n' }, { json: true })).status, 404);
    const echoMember = app.db.prepare('SELECT id FROM members WHERE telegram_id = 2001').get().id;
    const bm = await post(app, '/api/events/e6/attach', { member_id: echoMember, note: 'n' }, { json: true });
    assert.equal(bm.status, 422);
    assert.equal((await bm.json()).error, 'brand_mismatch');
    // JSON happy path
    r = await post(app, '/api/events/e6/attach', { member_id: mid, note: 'api attach' }, { json: true });
    assert.deepEqual(await r.json(), { ok: true, event_id: 'e6', member_id: mid, path: 'manual', confidence: 100, linked: false, rematched: 0 });
    assert.ok(allZero(invariants(app.db)), JSON.stringify(invariants(app.db)));
  } finally { await app.close(); }
});

test('state-changing requests from another site are refused (CSRF)', async () => {
  const app = await fixtureApp();
  try {
    const form = { member: '1004', note: 'n', back: '/dash/events?tab=parked' };
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'null' }]) {
      assert.equal((await post(app, '/dash/events/e5/attach', form, { headers })).status, 403, JSON.stringify(headers));
      assert.equal((await post(app, '/dash/links', { brand: 'brand-one' }, { headers })).status, 403);
      assert.equal((await post(app, '/api/events/e5/attach', { member_id: 1, note: 'n' }, { json: true, headers })).status, 403);
    }
    assert.equal(app.db.prepare("SELECT state FROM events WHERE event_id = 'e5'").get().state, 'parked');
    const host = new URL(app.base).host;
    assert.equal((await post(app, '/dash/events/e5/attach', form, { headers: { origin: `http://${host}`, 'sec-fetch-site': 'same-origin' } })).status, 303);
  } finally { await app.close(); }
});

test('escaping: a <script> first name renders as text on every screen', async () => {
  const app = await fixtureApp();
  try {
    const id = app.db.prepare('SELECT id FROM members WHERE telegram_id = 1001').get().id;
    app.db.prepare("UPDATE members SET username = 'x\"><img src=x onerror=alert(2)>' WHERE id = ?").run(id);
    const pages = ['/dash/members?q=1001', `/dash/members/${id}`, '/dash/events?tab=matched', '/dash', `/dash/members?q=${encodeURIComponent('"><svg onload=1>')}`, '/dash/events?q=%3Cscript%3E'];
    for (const p of pages) {
      const html = (await get(app, p)).text;
      assert.ok(!html.includes('<script>alert(1)'), p);
      assert.ok(!html.includes('<img src=x'), p);
      assert.ok(!html.includes('<svg onload'), p);
    }
    const html = (await get(app, `/dash/members/${id}`)).text;
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'first name shown escaped on the member page');
    assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/, 'username escaped too');
    const list = JSON.parse((await get(app, '/api/members?q=1001')).text);
    assert.equal(list.members[0].first_name, '<script>alert(1)</script>', 'JSON is data, not markup');
    assert.match((await get(app, '/dash/members?q=script')).text, /xss_user|&lt;img/);
    // CSP: scripts need the per-response nonce
    const r = await get(app, '/dash');
    const nonce = /nonce="([^"]+)"/.exec(r.text)[1];
    assert.ok(r.headers.get('content-security-policy').includes(`script-src 'nonce-${nonce}'`));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  } finally { await app.close(); }
});

test('the first name is escaped where it is rendered (members list name search + event member label)', async () => {
  const app = await fixtureApp();
  try {
    app.db.prepare("UPDATE members SET username = NULL WHERE telegram_id = 1001").run();
    const html = (await get(app, '/dash/events?tab=matched')).text;
    assert.ok(!html.includes('<script>alert(1)'));
    const m = (await get(app, '/dash/members?q=alert')).text;
    assert.match(m, />1001</);
    assert.ok(!m.includes('<script>alert(1)'));
  } finally { await app.close(); }
});

test('pagination: 50 rows per page, stable page 2, filters preserved in the links', async () => {
  const app = await startApp();
  try {
    seedBulk(app.db, { events: 130, members: 130 });
    const ids = async (p) => JSON.parse((await get(app, `/api/members?limit=50&page=${p}&sort=joined&dir=desc`)).text).members.map((m) => m.id);
    const [p1, p2, p3] = [await ids(1), await ids(2), await ids(3)];
    assert.deepEqual([p1.length, p2.length, p3.length], [50, 50, 30]);
    assert.equal(new Set([...p1, ...p2, ...p3]).size, 130, 'no overlap, no gaps');
    assert.deepEqual(await ids(2), p2, 'page 2 is stable across requests');

    const html1 = (await get(app, '/dash/members?q=bulk&sort=joined&dir=desc')).text;
    assert.equal(rowsIn(html1), 50);
    assert.match(html1, /1&ndash;50 of 130 &middot; page 1 \/ 3/);
    assert.match(html1, /rel="next" href="\/dash\/members\?q=bulk&amp;sort=joined&amp;dir=desc&amp;page=2"/);
    const html2 = (await get(app, '/dash/members?q=bulk&sort=joined&dir=desc&page=2')).text;
    assert.equal(rowsIn(html2), 50);
    assert.match(html2, /rel="prev"/);
    assert.equal(rowsIn((await get(app, '/dash/members?q=bulk&sort=joined&dir=desc&page=3')).text), 30);
    assert.equal((await get(app, '/dash/members?page=-4')).status, 200, 'bad page falls back to 1');
    const ev = (await get(app, '/dash/events?tab=matched&page=2')).text;
    assert.match(ev, /rel="prev" href="\/dash\/events\?tab=matched"/);
  } finally { await app.close(); }
});

test('no N+1: statement count does not grow with the number of rows rendered', async () => {
  const app = await startApp();
  try {
    seedBulk(app.db, { events: 300, members: 200 });
    let n = 0;
    const orig = app.db.prepare.bind(app.db);
    app.db.prepare = (sql) => { n++; return orig(sql); };
    const count = async (path) => { n = 0; const r = await get(app, path); assert.equal(r.status, 200, path); return n; };
    const small = await count('/dash/members?q=bulk_19');          // a handful of rows
    const full = await count('/dash/members');                      // 50 rows
    assert.ok(full <= small + 1, `members: ${small} vs ${full} statements`);
    const e1 = await count('/dash/events?q=bulk-1');
    const e50 = await count('/dash/events');
    assert.ok(e50 <= e1 + 1, `events: ${e1} vs ${e50} statements`);
    const id = app.db.prepare("SELECT matched_member_id AS id FROM events WHERE state = 'matched' LIMIT 1").get().id;
    n = 0; await get(app, `/dash/members/${id}`);
    assert.ok(n <= 4, `member detail used ${n} statements`);
    assert.ok(full <= 4, `member list used ${full} statements`);
  } finally { await app.close(); }
});

test('performance: 5,000 events — /dash/events < 800 ms, /dash < 400 ms (3,181 members)', async () => {
  const app = await startApp();
  try {
    seedBulk(app.db, { events: 5000, members: 3181 });
    await get(app, '/dash/events'); // warm the statement cache like a running service
    const timed = async (path) => { const t0 = performance.now(); const r = await get(app, path); const ms = performance.now() - t0; assert.equal(r.status, 200, path); return ms; };
    const ev = await timed('/dash/events');
    const evTab = await timed('/dash/events?tab=parked&page=3');
    const ov = await timed('/dash?period=30d');
    const mem = await timed('/dash/members');
    const memSearch = await timed('/dash/members?q=bulk_17');
    console.log(`# perf events=${ev.toFixed(0)}ms events_parked=${evTab.toFixed(0)}ms overview=${ov.toFixed(0)}ms members=${mem.toFixed(0)}ms members_search=${memSearch.toFixed(0)}ms`);
    assert.ok(ev < 800, `/dash/events took ${ev}`);
    assert.ok(evTab < 800, `/dash/events?tab=parked took ${evTab}`);
    assert.ok(ov < 400, `/dash took ${ov}`);
    assert.ok(mem < 800, `/dash/members took ${mem}`);
  } finally { await app.close(); }
});

test('links: create through the form, see both URLs, recent clicks list; JSON parity', async () => {
  const app = await fixtureApp();
  try {
    const r = await post(app, '/dash/links', { brand: 'brand-one', campaign: 'NG_Test', adset: '18-34', ad: 'vid_09', creative: '' });
    assert.equal(r.status, 303);
    const loc = r.headers.get('location');
    const token = /minted=([0-9A-Z]{10})/.exec(loc)[1];
    const html = (await get(app, loc)).text;
    assert.match(html, new RegExp(`https://coinvoo\\.example/c/${token}`));
    assert.match(html, new RegExp(`https://t\\.me/coinvoo_test_bot\\?start=c_${token}`));
    assert.match(html, /data-copy=/);
    assert.match(html, /NG_Test \/ 18-34 \/ vid_09/);
    assert.match(html, /never/, 'not opened yet');
    assert.equal((await post(app, '/dash/links', { brand: 'brand-two' })).status, 422, 'inactive brand');
    assert.equal((await post(app, '/dash/links', { brand: 'brand-one', campaign: 'x'.repeat(201) })).status, 400);
    const j = JSON.parse((await get(app, '/api/clicks?campaign=NG_Test')).text);
    assert.equal(j.total, 1);
    assert.equal(j.clicks[0].click_id, token);
    assert.ok(!('ip_hash' in j.clicks[0]) && !('ua' in j.clicks[0]));
    assert.equal((await get(app, '/dash/links?minted=ZZZZZZZZZZ')).status, 200, 'unknown token is ignored, not echoed');
    const ids = (await get(app, '/dash/links')).text;
    assert.match(ids, /ttclid/);
  } finally { await app.close(); }
});

test('formatting: Lagos time, money per currency, one-decimal percentages, relative age', () => {
  assert.equal(fmtTime(Date.parse('2026-11-15T17:29:00Z')), '15 Nov 18:29');
  assert.equal(fmtTime(Date.parse('2026-12-31T23:30:00Z')), '01 Jan 00:30', 'UTC+1 crosses the day boundary');
  assert.equal(fmtMoney(1204.5), '$1,204.50');
  assert.equal(fmtMoney(1204500, 'NGN'), '₦1,204,500');
  assert.equal(fmtMoney(12.5, 'EUR'), 'EUR 12.50');
  assert.equal(fmtMoney(null), '—');
  assert.equal(fmtMoney(0), '$0.00');
  assert.equal(fmtPct(84.26), '84.3 %');
  assert.equal(fmtPct(null), '—');
  assert.equal(fmtAgo(1000, 1000 + 4 * 60000), '4 min ago');
  assert.equal(fmtAgo(null, 5), 'never');
});

test('rollup agrees with the dashboard for today and yesterday (cross-check)', async () => {
  const app = await fixtureApp();
  const worker = createWorker(app.deps);
  try {
    await worker.tick();
    const html = (await get(app, '/dash?period=today&brand=brand-one')).text;
    const m = metrics(html);
    const day = new Date(app.deps.now() + 3600000).toISOString().slice(0, 10);
    const r = app.db.prepare('SELECT * FROM daily_rollup WHERE brand_id = 1 AND day = ?').get(day);
    assert.deepEqual([Number(m.clicks), Number(m.joins), Number(m.regs), Number(m.ftds), Number(m.redeps), Number(m.revenue)],
      [r.clicks, r.joins, r.regs, r.ftds, r.redeps, r.revenue]);
  } finally { await app.close(); }
});

test('attach + link: the broker id is linked to the member and the trader\'s other parked events resolve', async () => {
  const app = await fixtureApp();
  try {
    const now = app.deps.now();
    const ev = app.db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, forward_state)
                               VALUES (?, 1, 'affstore', 'dep', 'dep', ?, ?, 'USD', '{}', ?, 'parked', 'none')`);
    ev.run('e10', '197999999', 15, now - 10 * 60000); // same trader as e5
    ev.run('e11', '197444444', 9, now - 5 * 60000);   // someone else
    const mid = app.db.prepare('SELECT id FROM members WHERE telegram_id = 1004').get().id;
    const r = await post(app, '/api/events/e5/attach', { member_id: mid, note: 'confirmed in DM', link_account: true }, { json: true });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, event_id: 'e5', member_id: mid, path: 'manual', confidence: 100, linked: true, rematched: 1 });
    const acc = app.db.prepare("SELECT member_id, source, confidence FROM accounts WHERE iq_user_id = '197999999'").get();
    assert.deepEqual({ ...acc }, { member_id: mid, source: 'manual', confidence: 100 });
    const e10 = app.db.prepare("SELECT e.state, e.matched_member_id, a.path FROM events e JOIN attributions a ON a.event_id = e.event_id WHERE e.event_id = 'e10'").get();
    assert.deepEqual({ ...e10 }, { state: 'matched', matched_member_id: mid, path: 'trader_id' }, 'resolved by the matcher through the new link');
    assert.equal(app.db.prepare("SELECT state FROM events WHERE event_id = 'e11'").get().state, 'parked', 'another trader is untouched');
    assert.ok(allZero(invariants(app.db)), JSON.stringify(invariants(app.db)));
  } finally { await app.close(); }
});

test('attach + link: a broker id owned by another member is refused and nothing changes; no trader id -> 422', async () => {
  const app = await fixtureApp();
  try {
    const now = app.deps.now();
    app.db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, forward_state)
                    VALUES ('own', 1, 'affstore', 'dep', 'dep', '197000001', 5, 'USD', '{}', ?, 'parked', 'none')`).run(now);
    app.db.prepare(`INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, forward_state)
                    VALUES ('notrader', 1, 'affstore', 'dep', 'dep', NULL, 5, 'USD', '{}', ?, 'parked', 'none')`).run(now);
    const mid = app.db.prepare('SELECT id FROM members WHERE telegram_id = 1004').get().id;
    let r = await post(app, '/api/events/own/attach', { member_id: mid, note: 'n', link_account: true }, { json: true });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'account_claimed');
    assert.equal(app.db.prepare("SELECT state FROM events WHERE event_id = 'own'").get().state, 'parked', 'the attach was rolled back too');
    assert.equal(app.db.prepare("SELECT member_id FROM accounts WHERE iq_user_id = '197000001'").get().member_id, app.db.prepare('SELECT id FROM members WHERE telegram_id = 1001').get().id);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM attribution_log WHERE event_id = 'own'").get().n, 0, 'nothing logged');
    r = await post(app, '/api/events/notrader/attach', { member_id: mid, note: 'n', link_account: true }, { json: true });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error, 'no_trader_id');
    r = await post(app, '/api/events/notrader/attach', { member_id: mid, note: 'n' }, { json: true });
    assert.equal(r.status, 200, 'without linking it attaches as before');
    assert.equal((await r.json()).linked, false);
  } finally { await app.close(); }
});

test('attach + link from the dashboard: the checkbox is offered when there is a broker id, and the notice says what happened', async () => {
  const app = await fixtureApp();
  try {
    const html = (await get(app, '/dash/events?tab=parked')).text;
    assert.match(html, /<input type="checkbox" name="link" value="1"> also link broker id 197999999 to this member/);
    const r = await post(app, '/dash/events/e5/attach', { member: '1004', note: 'by phone', link: '1', back: '/dash/events?tab=parked' });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('location'), /notice=attached_linked$/);
    assert.match((await get(app, '/dash/events?tab=parked&notice=attached_linked')).text, /broker id is now linked to that member/);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE iq_user_id = '197999999'").get().n, 1);
  } finally { await app.close(); }
});
