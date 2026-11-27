// Phase 12 — ad links -> per-click channel invites -> join binding (directive "Phase 10", Part E).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, testEnv, captureLogs } from './helpers.js';
import { loadConfig } from '../src/config.js';

// Placeholders only: nothing here is a credential.
const SECRET = 'placeholder-gate-shared-secret';
const GATE = { GATE_BOT_API: 'http://127.0.0.1:8771', GATE_SHARED_SECRET: SECRET, GATE_BOT_TIMEOUT_MS: '150', BRAND_ONE_INVITE_LINK: 'https://t.me/+BrandWideInvite' };
const CHROME = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

// A stand-in for the gate bot's POST /invite. `mode`: 'ok' | 'timeout' | 503 | 'bad'.
function fakeBot() {
  const calls = [];
  let n = 0;
  const bot = { mode: 'ok', calls };
  bot.fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (bot.mode === 'timeout') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    if (typeof bot.mode === 'number') return new Response('{"ok":false}', { status: bot.mode });
    if (bot.mode === 'bad') return new Response(JSON.stringify({ invite_link: 'https://evil.example/phish' }), { status: 200 });
    return new Response(JSON.stringify({ invite_link: `https://t.me/+Inv${String(++n).padStart(6, '0')}` }), { status: 200 });
  };
  return bot;
}

async function appWithBot(env = GATE) {
  const bot = fakeBot();
  const app = await startApp(env, { fetchImpl: bot.fetchImpl });
  return { app, bot };
}
const admin = (app, extra = {}) => ({ authorization: app.auth, 'content-type': 'application/json', ...extra });
async function createLink(app, body = { brand: 'brand-one', label: 'Lagos broad', campaign: 'NG_Broad', adset: '18-34', ad: 'vid_03' }) {
  const r = await fetch(`${app.base}/api/ad-links`, { method: 'POST', headers: admin(app), body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  return (await r.json()).ad_link;
}
const visit = (app, path, headers = {}) => fetch(`${app.base}${path}`, { redirect: 'manual', headers: { 'user-agent': CHROME, ...headers } });
const dest = async (r) => {
  // A hit answers with the hop page (Meta needs a detectable pixel); keep accepting the bare 302 too.
  if (r.status === 302) return r.headers.get('x-coinvoo-invite');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/html/);
  const m = (await r.text()).match(/location\.replace\((".*?")\)/);
  assert.ok(m, 'the hop page forwards to the invite');
  return JSON.parse(m[1]);
};
const one = (app, sql, ...p) => app.db.prepare(sql).get(...p);
const join = (app, body) => fetch(`${app.base}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brand: 'brand-one', ...body }) }).then((r) => r.json());

test('1 an unknown code falls through to /c/:token (404), and a minted click token still wins', async () => {
  const { app, bot } = await appWithBot();
  try {
    const r = await visit(app, '/c/ZZZZZZZZZZ');
    assert.equal(r.status, 404);
    assert.equal(await r.text(), 'link not found');
    const { token } = await app.mint({ brand: 'brand-one', campaign: 'OLD' });
    const t = await visit(app, `/c/${token}`);
    assert.equal(t.status, 302);
    assert.equal(t.headers.get('location'), `https://t.me/coinvoo_test_bot?start=c_${token}`, 'the old token path is untouched');
    assert.equal(bot.calls.length, 0, 'the bot is never asked for a token link');
    assert.equal((await visit(app, '/c/not-a-code')).status, 404);
  } finally { await app.close(); }
});

test('2 a known code mints a click, fills the campaign from the link, and 302s to the invite the bot made for it', async () => {
  const { app, bot } = await appWithBot();
  try {
    const link = await createLink(app);
    assert.match(link.code, /^[0-9A-HJKMNP-TV-Z]{10}$/);
    assert.equal(link.url, `https://coinvoo.example/c/${link.code}`);
    const r = await visit(app, `/c/${link.code}?utm_source=facebook`);
    assert.equal(await dest(r), 'https://t.me/+Inv000001');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const token = r.headers.get('x-coinvoo-click');
    const click = one(app, 'SELECT campaign, adset, ad, ad_link_id, utm_source FROM clicks WHERE click_id = ?', token);
    assert.deepEqual({ ...click }, { campaign: 'NG_Broad', adset: '18-34', ad: 'vid_03', ad_link_id: link.id, utm_source: 'facebook' });
    assert.deepEqual(bot.calls[0].body, { brand: 'brand-one', click_id: token });
    assert.equal(bot.calls[0].url, 'http://127.0.0.1:8771/invite');
    assert.equal(bot.calls[0].headers['x-coinvoo-token'], SECRET);
    assert.deepEqual({ ...one(app, 'SELECT click_id, invite_link FROM invites') }, { click_id: token, invite_link: 'https://t.me/+Inv000001' });
    assert.equal(one(app, 'SELECT COUNT(*) AS n FROM click_opens WHERE click_id = ? AND is_bot = 0', token).n, 1);
    // the ad's own parameters win over the saved ones
    const r2 = await visit(app, `/c/${link.code}?campaign_name=FROM_AD`);
    assert.equal(one(app, 'SELECT campaign FROM clicks WHERE click_id = ?', r2.headers.get('x-coinvoo-click')).campaign, 'FROM_AD');
    assert.notEqual(r2.headers.get('x-coinvoo-click'), token, 'every visit is its own click');
  } finally { await app.close(); }
});

test('3 bot timeout: the newest unused invite of the brand, then the brand invite link, then the bot start', async () => {
  const { app, bot } = await appWithBot();
  try {
    const link = await createLink(app);
    bot.mode = 'timeout';
    let r;
    const lines = await captureLogs(async () => { r = await visit(app, `/c/${link.code}`); });
    assert.equal(await dest(r), 'https://t.me/+BrandWideInvite', 'no invite stored yet: the brand link');
    assert.ok(lines.some((l) => /invite fallback reason=bot_timeout/.test(l)));
    assert.ok(!lines.join('\n').includes(SECRET), 'the secret is never logged');
    bot.mode = 'ok';
    const minted = await dest(await visit(app, `/c/${link.code}`));
    bot.mode = 'timeout';
    const reused = await visit(app, `/c/${link.code}`);
    assert.equal(await dest(reused), minted, 'the newest stored invite is re-used');
    assert.equal(one(app, 'SELECT COUNT(*) AS n FROM invites WHERE invite_link = ?', minted).n, 2, 'and recorded against the new click');
  } finally { await app.close(); }
  const bare = await startApp({ GATE_BOT_API: GATE.GATE_BOT_API, GATE_SHARED_SECRET: SECRET, GATE_BOT_TIMEOUT_MS: '100' }, { fetchImpl: fakeBot().fetchImpl });
  try {
    const link = await createLink(bare);
    bare.deps.fetchImpl = async () => { throw new Error('connect ECONNREFUSED'); };
    const r = await visit(bare, `/c/${link.code}`);
    const token = r.headers.get('x-coinvoo-click');
    assert.equal(await dest(r), `https://t.me/coinvoo_test_bot?start=c_${token}`, 'no invite and no brand link: the bot start still carries the click');
  } finally { await bare.close(); }
});

test('4 bot 503 (or a link that is not a Telegram invite): same fallback, always a 302, never a 500', async () => {
  const { app, bot } = await appWithBot();
  try {
    const link = await createLink(app);
    for (const mode of [503, 500, 429, 'bad']) {
      bot.mode = mode;
      const r = await visit(app, `/c/${link.code}`);
      assert.equal(await dest(r), 'https://t.me/+BrandWideInvite', String(mode));
    }
    assert.equal(one(app, 'SELECT COUNT(*) AS n FROM invites').n, 0, 'nothing from a refusal or a bad link is stored');
  } finally { await app.close(); }
});

test('5 an inactive link (or an inactive brand) falls through: not found, no click', async () => {
  const { app } = await appWithBot();
  try {
    const link = await createLink(app);
    const p = await fetch(`${app.base}/api/ad-links/${link.id}`, { method: 'PATCH', headers: admin(app), body: JSON.stringify({ active: false }) });
    assert.equal((await p.json()).ad_link.active, false);
    assert.equal((await visit(app, `/c/${link.code}`)).status, 404);
    await fetch(`${app.base}/api/ad-links/${link.id}`, { method: 'PATCH', headers: admin(app), body: JSON.stringify({ active: true }) });
    app.db.prepare("UPDATE brands SET active = 0 WHERE code = 'brand-one'").run();
    assert.equal((await visit(app, `/c/${link.code}`)).status, 404);
    assert.equal(one(app, 'SELECT COUNT(*) AS n FROM clicks').n, 0);
  } finally { await app.close(); }
});

test('6 no fbclid is stamped when the visit carries none; one is when it does', async () => {
  const { app } = await appWithBot();
  try {
    const link = await createLink(app);
    const a = (await visit(app, `/c/${link.code}`)).headers.get('x-coinvoo-click');
    const b = (await visit(app, `/c/${link.code}?fbclid=IwAR0xyz`)).headers.get('x-coinvoo-click');
    assert.equal(one(app, 'SELECT fbclid FROM clicks WHERE click_id = ?', a).fbclid, null);
    assert.equal(one(app, 'SELECT fbclid FROM clicks WHERE click_id = ?', b).fbclid, 'IwAR0xyz');
  } finally { await app.close(); }
});

test('7 a join naming a known invite binds its click, source channel:join', async () => {
  const { app, bot } = await appWithBot();
  try {
    const link = await createLink(app);
    const r = await visit(app, `/c/${link.code}`);
    const j = await join(app, { telegram_id: 7700001, invite_link: r.headers.get('x-coinvoo-invite'), source: 'channel:join' });
    assert.deepEqual([j.created, j.click_id, j.rejoin], [true, r.headers.get('x-coinvoo-click'), false]);
    assert.equal(one(app, 'SELECT join_source FROM members WHERE telegram_id = 7700001').join_source, 'channel:join');
    // a shared invite (re-used while the bot refused): the newest click nobody joined from gets the next joiner
    bot.mode = 503;
    const shared = r.headers.get('x-coinvoo-invite');
    const r2 = await visit(app, `/c/${link.code}`);
    assert.equal(r2.headers.get('x-coinvoo-invite'), shared);
    const j2 = await join(app, { telegram_id: 7700002, invite_link: shared, source: 'channel:join' });
    assert.equal(j2.click_id, r2.headers.get('x-coinvoo-click'));
    // every click on it already has its member: the join is recorded, without guessing a click
    const j3 = await join(app, { telegram_id: 7700003, invite_link: shared, source: 'channel:join' });
    assert.deepEqual([j3.created, j3.click_id], [true, null]);
    // an invite we never made (the brand-wide link) binds nothing
    assert.equal((await join(app, { telegram_id: 7700004, invite_link: 'https://t.me/+BrandWideInvite', source: 'channel:join' })).click_id, null);
    const s = await (await fetch(`${app.base}/api/ad-links/${link.id}/stats`, { headers: admin(app) })).json();
    assert.deepEqual(s, { ok: true, clicks: 2, joins: 2, members: 2 });
  } finally { await app.close(); }
});

test('8 leave then join again: rejoins + 1, still one member row; a repeated join without a leave is not a rejoin', async () => {
  const { app } = await appWithBot();
  try {
    const link = await createLink(app);
    const r = await visit(app, `/c/${link.code}`);
    const invite = r.headers.get('x-coinvoo-invite');
    await join(app, { telegram_id: 7700010, invite_link: invite, source: 'channel:join' });
    // the approved join request also reaches the bot as left -> member; reporting it again changes nothing
    assert.equal((await join(app, { telegram_id: 7700010, source: 'channel:join' })).rejoin, false);
    assert.deepEqual(await join(app, { telegram_id: 7700010, event: 'leave' }), { ok: true, member_id: 1, left: true });
    const back = await join(app, { telegram_id: 7700010, invite_link: invite, source: 'channel:join' });
    assert.deepEqual([back.created, back.rejoin, back.click_id], [false, true, r.headers.get('x-coinvoo-click')]);
    await join(app, { telegram_id: 7700010, event: 'leave' });
    await join(app, { telegram_id: 7700010, source: 'channel:join' });
    const m = app.db.prepare('SELECT COUNT(*) AS n, MAX(rejoins) AS rejoins, MAX(left_at) AS left_at FROM members WHERE telegram_id = 7700010').get();
    assert.deepEqual({ ...m }, { n: 1, rejoins: 2, left_at: null });
    const s = await (await fetch(`${app.base}/api/ad-links/${link.id}/stats`, { headers: admin(app) })).json();
    assert.deepEqual([s.members, s.joins], [1, 3], 'joins counts the rejoins, members does not');
    assert.deepEqual(await join(app, { telegram_id: 7799999, event: 'leave' }), { ok: true, member_id: null, left: false }, 'a leave never creates a member');
    assert.equal((await fetch(`${app.base}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brand: 'brand-one', telegram_id: 1, event: 'kick' }) })).status, 400);
  } finally { await app.close(); }
});

test('9 admin CRUD needs a sign-in (session or basic); writes are same-origin; a code collision is retried', async () => {
  const { app } = await appWithBot();
  try {
    for (const [method, path] of [['GET', '/api/ad-links'], ['POST', '/api/ad-links'], ['PATCH', '/api/ad-links/1'], ['GET', '/api/ad-links/1/stats']]) {
      assert.equal((await fetch(`${app.base}${path}`, { method, body: method === 'GET' ? undefined : '{}' })).status, 401, `${method} ${path}`);
    }
    const signIn = await fetch(`${app.base}/dash/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=pass' });
    const cookie = signIn.headers.get('set-cookie').split(';')[0];
    const viaSession = await fetch(`${app.base}/api/ad-links`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ brand: 'brand-one', label: 'session' }) });
    assert.equal(viaSession.status, 200);
    const existing = (await viaSession.json()).ad_link.code;
    const { token } = await app.mint({ brand: 'brand-one' });
    const queue = [existing, token, 'NEWCDE0001'];
    app.deps.newToken = () => queue.shift();
    const made = await createLink(app, { brand: 'brand-one', label: 'retry' });
    assert.equal(made.code, 'NEWCDE0001', 'a code in use by a link or by a click is skipped');
    assert.equal(made.created_by, 'admin');
    assert.equal((await fetch(`${app.base}/api/ad-links`, { method: 'POST', headers: admin(app, { 'sec-fetch-site': 'cross-site' }), body: JSON.stringify({ brand: 'brand-one' }) })).status, 403);
    assert.equal((await fetch(`${app.base}/api/ad-links`, { method: 'POST', headers: admin(app), body: JSON.stringify({ brand: 'nope' }) })).status, 422);
    const p = await (await fetch(`${app.base}/api/ad-links/${made.id}`, { method: 'PATCH', headers: admin(app), body: JSON.stringify({ label: 'renamed', campaign: 'C2', active: false }) })).json();
    assert.deepEqual([p.ad_link.label, p.ad_link.campaign, p.ad_link.active], ['renamed', 'C2', false]);
    assert.equal((await fetch(`${app.base}/api/ad-links/${made.id}`, { method: 'PATCH', headers: admin(app), body: JSON.stringify({ code: 'HIJACK0001' }) })).status, 400, 'the code cannot be edited');
    assert.equal((await fetch(`${app.base}/api/ad-links/9999`, { method: 'PATCH', headers: admin(app), body: JSON.stringify({ label: 'x' }) })).status, 404);
    const list = await (await fetch(`${app.base}/api/ad-links`, { headers: { cookie } })).json();
    assert.equal(list.ad_links.length, 2);
    assert.deepEqual(list.ad_links.find((l) => l.code === 'NEWCDE0001').stats, { clicks: 0, joins: 0, members: 0 });
  } finally { await app.close(); }
});

test('a crawler gets the pixel page and still costs one invite; HEAD and an unconfigured bot cost none', async () => {
  const { app, bot } = await appWithBot();
  try {
    const link = await createLink(app);
    const c = await visit(app, `/c/${link.code}`, { 'user-agent': 'facebookexternalhit/1.1' });
    assert.equal(c.status, 200, 'the page is served so a checker can see the pixel');
    const html = await c.text();
    assert.doesNotMatch(html, /http-equiv="refresh"/, 'a crawler is not forwarded on');
    assert.equal(one(app, 'SELECT is_bot FROM click_opens').is_bot, 1, 'the crawler visit is kept, flagged');
    const h = await fetch(`${app.base}/c/${link.code}`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(h.status, 302);
    assert.ok(bot.calls.length >= 1, 'the crawler cost an invite so the button has a target');
    assert.equal(one(app, 'SELECT COUNT(*) AS n FROM clicks').n, 1, 'HEAD mints nothing');
  } finally { await app.close(); }
  const off = await startApp({ BRAND_ONE_INVITE_LINK: 'https://t.me/+BrandWideInvite' }, { fetchImpl: async () => { throw new Error('must not be called'); } });
  try {
    const link = await createLink(off);
    assert.equal(await dest(await visit(off, `/c/${link.code}`)), 'https://t.me/+BrandWideInvite');
  } finally { await off.close(); }
});

test('config: GATE_BOT_API needs GATE_SHARED_SECRET (16+ characters); both unset is fine', () => {
  assert.throws(() => loadConfig(testEnv({ GATE_BOT_API: 'http://127.0.0.1:8771' })), /GATE_BOT_API requires GATE_SHARED_SECRET/);
  assert.throws(() => loadConfig(testEnv({ GATE_BOT_API: 'ftp://x', GATE_SHARED_SECRET: SECRET })), /GATE_BOT_API must start with http/);
  assert.throws(() => loadConfig(testEnv({ GATE_SHARED_SECRET: 'short' })), /GATE_SHARED_SECRET must be at least 16/);
  const c = loadConfig(testEnv({ GATE_BOT_API: 'http://127.0.0.1:8771/', GATE_SHARED_SECRET: SECRET }));
  assert.deepEqual([c.gateBotApi, c.gateBotTimeoutMs], ['http://127.0.0.1:8771', 3000]);
  assert.equal(loadConfig(testEnv()).gateBotApi, null);
});

test('an unresolved ad macro is not a campaign; a real value beside it still wins', async () => {
  const { app } = await appWithBot();
  try {
    const link = await createLink(app, { brand: 'brand-one', label: 'macro', campaign: 'SavedCamp' });
    const r = await visit(app, `/c/${link.code}?campaign_name={{campaign.name}}&fbclid={{fbclid}}&adset_name=18-34`, { redirect: 'manual' });
    assert.equal(r.status, 302, 'a browser is forwarded straight on');
    const token = r.headers.get('x-coinvoo-click');
    const c = one(app, 'SELECT campaign, adset, fbclid FROM clicks WHERE click_id = ?', token);
    assert.deepEqual({ ...c }, { campaign: 'SavedCamp', adset: '18-34', fbclid: null }, 'the placeholder falls back to the saved value and never becomes a click field');
  } finally { await app.close(); }
});

test('a live join rewrites the joined_at and source a backfill had put on the row', async () => {
  const { app } = await appWithBot();
  try {
    const link = await createLink(app);
    const invite = (await visit(app, `/c/${link.code}`)).headers.get('x-coinvoo-invite');
    await app.db.prepare(`INSERT INTO members (brand_id, telegram_id, username, joined_at, join_source) VALUES (1, 7700020, NULL, 1000, 'backfill:botdb')`).run();
    const j = await join(app, { telegram_id: 7700020, invite_link: invite, source: 'channel:join' });
    assert.equal(j.click_id, (await one(app, 'SELECT click_id FROM clicks WHERE click_id = ?', j.click_id)).click_id);
    const m = one(app, 'SELECT joined_at, join_source, click_id FROM members WHERE telegram_id = 7700020');
    assert.equal(m.join_source, 'channel:join', 'the live join replaces the backfill source');
    assert.ok(m.joined_at > 1000, 'the join time is the one we saw, not the backfill guess');
    assert.equal(m.click_id, j.click_id);
    const again = await join(app, { telegram_id: 7700020, source: 'backfill:batch', now: 5000 });
    const m2 = one(app, 'SELECT join_source, joined_at FROM members WHERE telegram_id = 7700020');
    assert.deepEqual([m2.join_source, m2.joined_at], ['channel:join', m.joined_at], 'a later backfill never rewrites it');
    assert.equal(again.created, false);
  } finally { await app.close(); }
});
