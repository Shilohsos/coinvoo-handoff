// Phase 11 — dashboard v2: sign-in sessions, assets and CSP, HTML error pages, spend management, search,
// campaign grouping, the time series, the System screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seedDashFixture, captureLogs } from './helpers.js';
import { authGuardFor, AUTH_MAX_FAILS } from '../src/auth.js';
import { createSessionStore } from '../src/session.js';
import { assetHref } from '../src/ui/assets.js';
import * as Q from '../src/queries.js';

const HTML = { accept: 'text/html,application/xhtml+xml' };
const form = (o) => new URLSearchParams(o).toString();
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

async function req(app, path, { method = 'GET', headers = {}, body } = {}) {
  const r = await fetch(`${app.base}${path}`, { method, redirect: 'manual', headers, body });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
const asAdmin = (app) => ({ authorization: app.auth });
async function signIn(app, { next = '' } = {}) {
  const r = await req(app, '/dash/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ username: 'admin', password: 'pass', next }) });
  assert.equal(r.status, 303);
  return { r, cookie: cookieOf(r) };
}

// ---------------------------------------------------------------------------------------------------------------
// sign-in sessions

test('a signed-out browser is sent to the sign-in page and comes back; scripts still get 401 + Basic', async () => {
  const app = await startApp();
  try {
    const browser = await req(app, '/dash/members?q=x', { headers: HTML });
    assert.equal(browser.status, 303);
    assert.equal(browser.headers.get('location'), '/dash/login?next=%2Fdash%2Fmembers%3Fq%3Dx');
    const script = await req(app, '/dash/members');
    assert.equal(script.status, 401);
    assert.equal(script.headers.get('www-authenticate'), 'Basic realm="coinvoo"');
    const page = await req(app, '/dash/login?next=%2Fdash%2Fmembers', { headers: HTML });
    assert.equal(page.status, 200);
    assert.match(page.text, /<form method="post" action="\/dash\/login">/);
    assert.match(page.text, /<input type="hidden" name="next" value="\/dash\/members">/);
    assert.match(page.text, /autocomplete="current-password"/);
  } finally { await app.close(); }
});

test('sign in: a wrong password is refused without a cookie; the right one sets an HttpOnly session and redirects to next', async () => {
  const app = await startApp();
  try {
    const bad = await req(app, '/dash/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ username: 'admin', password: 'nope' }) });
    assert.equal(bad.status, 401);
    assert.match(bad.text, /Wrong username or password\./);
    assert.equal(bad.headers.get('set-cookie'), null);

    let lines;
    let signed;
    lines = await captureLogs(async () => { signed = await signIn(app, { next: '/dash/campaigns?period=30d' }); });
    assert.equal(signed.r.headers.get('location'), '/dash/campaigns?period=30d');
    const sc = signed.r.headers.get('set-cookie');
    assert.match(sc, /^cv_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/, 'no Secure over plain http');
    assert.ok(lines.includes('[coinvoo] signed_in via=form'));
    assert.ok(!lines.join('\n').includes(signed.cookie.split('=')[1]), 'the token is never logged');

    // the cookie is admin everywhere: the dashboard, the admin JSON, the CSV exports
    for (const p of ['/dash', '/dash/members', '/api/members', '/api/export/members.csv', '/dash/search?q=1']) {
      assert.equal((await req(app, p, { headers: { cookie: signed.cookie } })).status, 200, p);
    }
    // only a hash of the token is stored
    const token = signed.cookie.split('=')[1];
    const rows = app.db.prepare('SELECT id FROM sessions').all();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].id, token);
    assert.match(rows[0].id, /^[0-9a-f]{64}$/);
    // already signed in: the sign-in page sends you on
    assert.equal((await req(app, '/dash/login', { headers: { ...HTML, cookie: signed.cookie } })).headers.get('location'), '/dash');
  } finally { await app.close(); }
});

test('sign in: next can only point inside /dash; the form is same-origin only; HTTPS behind Caddy gets Secure', async () => {
  const app = await startApp();
  try {
    for (const next of ['//evil.example/x', 'https://evil.example/dash', '/dash/../..//evil.example', '/api/members']) {
      assert.equal((await signIn(app, { next })).r.headers.get('location'), '/dash', next);
    }
    const cross = await req(app, '/dash/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' }, body: form({ username: 'admin', password: 'pass' }) });
    assert.equal(cross.status, 403);
    const tls = await req(app, '/dash/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' }, body: form({ username: 'admin', password: 'pass' }) });
    assert.match(tls.headers.get('set-cookie'), /; Secure$/);
  } finally { await app.close(); }
});

test('sign out ends the session; revoke ends the others; expired or foreign sessions do not count', async () => {
  const app = await startApp();
  try {
    const a = (await signIn(app)).cookie;
    const b = (await signIn(app)).cookie;
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 2);
    const rv = await req(app, '/dash/sessions/revoke', { method: 'POST', headers: { cookie: a } });
    assert.equal(rv.status, 303);
    assert.equal(rv.headers.get('location'), '/dash/system?notice=sessions_revoked');
    assert.equal((await req(app, '/dash', { headers: { cookie: b } })).status, 401, 'the other session is gone');
    assert.equal((await req(app, '/dash', { headers: { cookie: a } })).status, 200, 'this one stays');

    const out = await req(app, '/dash/logout', { method: 'POST', headers: { cookie: a } });
    assert.equal(out.status, 303);
    assert.equal(out.headers.get('location'), '/dash/login?bye=1');
    assert.match(out.headers.get('set-cookie'), /^cv_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
    assert.equal((await req(app, '/dash', { headers: { cookie: a } })).status, 401);
    assert.match((await req(app, '/dash/login?bye=1', { headers: HTML })).text, /You have been signed out\./);

    const c = (await signIn(app)).cookie;
    app.db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1);
    assert.equal((await req(app, '/dash', { headers: { cookie: c } })).status, 401, 'expired');
    assert.equal((await req(app, '/dash', { headers: { cookie: 'cv_session=forged-token-forged-token-forged-token-abc' } })).status, 401);
  } finally { await app.close(); }
});

test('changing ADMIN_USER or ADMIN_PASS ends every session', async () => {
  const app = await startApp();
  try {
    const { cookie } = await signIn(app);
    const fake = { headers: { cookie }, socket: {} };
    assert.equal(app.deps.sessions.check(fake), true);
    const other = createSessionStore(app.db, { config: { ...app.config, adminPass: 'a-new-password' }, salt: 's' });
    assert.equal(other.check(fake), false, 'issued for the old credentials');
  } finally { await app.close(); }
});

test('the sign-in form shares the failed sign-in limit; a live session is honoured from a blocked address', async () => {
  const app = await startApp();
  try {
    authGuardFor(app.config).now = () => Date.parse('2026-11-20T10:00:00Z');
    const { cookie } = await signIn(app);
    const login = (password) => req(app, '/dash/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...HTML }, body: form({ username: 'admin', password }) });
    for (let i = 0; i < AUTH_MAX_FAILS; i++) assert.equal((await login(`guess${i}`)).status, 401);
    const blocked = await login('pass');
    assert.equal(blocked.status, 429, 'the right password from a blocked address waits too');
    assert.match(blocked.text, /Too many wrong passwords/);
    assert.equal((await req(app, '/dash', { headers: { cookie } })).status, 200, 'an existing session still works');
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// assets, CSP, error pages

test('assets: served from memory with a content hash, cached forever, 304 on revalidation, public', async () => {
  const app = await startApp();
  try {
    for (const href of [assetHref.css, assetHref.js]) {
      assert.match(href, /^\/dash\/assets\/app-[0-9a-f]{12}\.(css|js)$/);
      const r = await req(app, href);
      assert.equal(r.status, 200, href);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.match(r.headers.get('content-type'), href.endsWith('.css') ? /^text\/css/ : /^text\/javascript/);
      assert.ok(r.text.length > 1000);
      assert.equal((await req(app, href, { headers: { 'if-none-match': r.headers.get('etag') } })).status, 304);
    }
    assert.equal((await req(app, '/dash/assets/app-000000000000.css')).status, 404);
    const page = await req(app, '/dash', { headers: asAdmin(app) });
    assert.ok(page.text.includes(`href="${assetHref.css}"`) && page.text.includes(`src="${assetHref.js}"`));
  } finally { await app.close(); }
});

test('CSP: styles only from the stylesheet (no inline style anywhere), scripts only with the nonce', async () => {
  const app = await startApp();
  try {
    seedDashFixture(app.db, app.deps.now());
    const id = app.db.prepare('SELECT id FROM members WHERE telegram_id = 1001').get().id;
    for (const p of ['/dash', '/dash/members', `/dash/members/${id}`, '/dash/events', '/dash/events?tab=parked', '/dash/events/e1', '/dash/campaigns', '/dash/campaigns?group=campaign',
      '/dash/spend', '/dash/links', '/dash/system', '/dash/login']) {
      const r = await req(app, p, { headers: asAdmin(app) });
      assert.equal(r.status, 200, p);
      const csp = r.headers.get('content-security-policy');
      assert.match(csp, /style-src 'self';/, p);
      assert.ok(!/unsafe-inline/.test(csp), p);
      assert.ok(!/ style="/.test(r.text) && !/<style/.test(r.text), `${p}: an inline style would be blocked by the CSP`);
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
      for (const s of r.text.match(/<script[^>]*>/g)) assert.ok(s.includes(`nonce="${nonce}"`), `${p}: ${s}`);
      assert.ok(!/NaN|undefined|Infinity/.test(r.text.replace(/<script[\s\S]*?<\/script>/g, '')), p);
    }
  } finally { await app.close(); }
});

test('browsers get styled error pages in the app; API clients keep JSON', async () => {
  const app = await startApp();
  try {
    const html = await req(app, '/dash/members/99999', { headers: { ...HTML, ...asAdmin(app) } });
    assert.equal(html.status, 404);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(html.text, /<div class="err-code">404<\/div><h1>Not found<\/h1>/);
    assert.match(html.text, /aria-label="Primary"/, 'signed in: inside the app shell');
    const json = await req(app, '/dash/members/99999', { headers: asAdmin(app) });
    assert.equal(json.status, 404);
    assert.equal(JSON.parse(json.text).error, 'not_found');
    const bad = await req(app, '/dash?period=bogus', { headers: { ...HTML, ...asAdmin(app) } });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /That request was not valid/);
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// spend management

test('spend: the Spend screen lists rows by day; a row can be deleted from the form and from the API', async () => {
  const app = await startApp();
  try {
    const add = (o) => fetch(`${app.base}/api/spend`, { method: 'POST', headers: { ...asAdmin(app), 'content-type': 'application/json' }, body: JSON.stringify({ brand: 'brand-one', ...o }) }).then((r) => r.json());
    const day = new Date(app.deps.now() + 3600000).toISOString().slice(0, 10);
    const a = (await add({ day, campaign: 'NG_A', spend: 40 })).spend;
    const b = (await add({ day, campaign: 'NG_B', spend: 2.5 })).spend;
    const page = await req(app, '/dash/spend', { headers: asAdmin(app) });
    assert.equal(page.status, 200);
    assert.match(page.text, /<tr class="group"><td colspan="8">[^<]+<span class="dot"><\/span><b>\$42\.50<\/b><\/td><\/tr>/, 'one header per day with the day total');
    assert.match(page.text, /data-confirm="Delete this spend row/);

    const del = await req(app, `/dash/spend/${a.id}/delete`, { method: 'POST', headers: { ...asAdmin(app), 'content-type': 'application/x-www-form-urlencoded' }, body: form({ back: '/dash/spend?period=7d' }) });
    assert.equal(del.status, 303);
    assert.equal(del.headers.get('location'), '/dash/spend?period=7d&notice=spend_deleted');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM costs').get().n, 1);
    const again = await req(app, `/dash/spend/${a.id}/delete`, { method: 'POST', headers: { ...asAdmin(app), 'content-type': 'application/x-www-form-urlencoded' }, body: form({ back: '//evil.example' }) });
    assert.equal(again.headers.get('location'), '/dash/campaigns?notice=spend_missing', 'unknown row, and an off-site back falls back');

    const api = await req(app, `/api/spend/${b.id}`, { method: 'DELETE', headers: asAdmin(app) });
    assert.equal(api.status, 200);
    assert.equal(JSON.parse(api.text).deleted.campaign, 'NG_B');
    assert.equal((await req(app, `/api/spend/${b.id}`, { method: 'DELETE', headers: asAdmin(app) })).status, 404);
    assert.equal((await req(app, `/api/spend/${b.id}`, { method: 'DELETE' })).status, 401);
    assert.equal((await req(app, '/api/spend/1', { method: 'DELETE', headers: { ...asAdmin(app), 'sec-fetch-site': 'cross-site' } })).status, 403);
  } finally { await app.close(); }
});

test('the spend form returns to the Spend screen when it was sent from there', async () => {
  const app = await startApp();
  try {
    const day = new Date(app.deps.now() + 3600000).toISOString().slice(0, 10);
    const r = await req(app, '/dash/spend', { method: 'POST', headers: { ...asAdmin(app), 'content-type': 'application/x-www-form-urlencoded' }, body: form({ brand: 'brand-one', day, spend: '9', back: '/dash/spend?period=30d' }) });
    assert.equal(r.headers.get('location'), '/dash/spend?period=30d&notice=spend_saved');
    assert.match((await req(app, '/dash/spend?period=30d&notice=spend_saved', { headers: asAdmin(app) })).text, /<div class="flash ok" role="status">.*Spend saved\./s);
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// search, grouping, series, overview, system

test('search: Telegram id, username, trader id, event id prefix, link token and campaign name', async () => {
  const app = await startApp();
  try {
    seedDashFixture(app.db, app.deps.now());
    const s = async (q) => JSON.parse((await req(app, `/dash/search?q=${encodeURIComponent(q)}`, { headers: asAdmin(app) })).text).groups;
    const keys = async (q) => Object.fromEntries((await s(q)).map((g) => [g.key, g.items.map((i) => i.label)]));
    assert.deepEqual((await keys('1001')).members, ['@xss_user']);
    assert.ok((await keys('chidi')).members.includes('@camp_chidi'), 'username substring');
    assert.ok((await keys('Ngozi')).members.includes('@chan_ngozi'), 'first name');
    assert.deepEqual((await keys('197000003')).members, ['@camp_chidi'], 'a broker id finds its member');
    assert.ok((await keys('197000001')).events.length >= 1, 'trader id finds its events');
    assert.deepEqual((await s('e1')).find((g) => g.key === 'events').items.map((i) => i.href).slice(0, 1), ['/dash/events/e1']);
    const token = app.db.prepare('SELECT click_id FROM clicks LIMIT 1').get().click_id;
    assert.deepEqual((await keys(token.slice(0, 5))).links, [token]);
    assert.ok((await keys('NG_')).campaigns.includes('NG_Broad'));
    assert.deepEqual(await s(''), []);
    assert.equal((await req(app, '/dash/search?q=1001')).status, 401);
    assert.ok(!JSON.stringify(await s('203.0.113')).includes('203.0.113'), 'an IP is never a search hit');
  } finally { await app.close(); }
});

test('campaigns: grouping by ad set or campaign sums the rows, recomputes the ratios and keeps the totals', async () => {
  const app = await startApp();
  try {
    seedDashFixture(app.db, app.deps.now());
    const rows = async (g) => {
      const html = (await req(app, `/dash/campaigns?period=7d${g ? `&group=${g}` : ''}`, { headers: asAdmin(app) })).text;
      return Object.fromEntries([...html.matchAll(/<tr data-row="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [m[1].replace(/&amp;/g, '&'),
        Object.fromEntries([...m[2].matchAll(/data-col="([a-z_]+)" data-value="([^"]*)"/g)].map((c) => [c[1], c[2]]))]));
    };
    const ad = await rows('');
    const camp = await rows('campaign');
    assert.deepEqual(ad.total, camp.total, 'the totals row is the same at every level');
    const byCampaign = {};
    for (const [k, r] of Object.entries(ad)) {
      if (k === 'total') continue;
      const c = k.split('|')[0];
      byCampaign[c] = (byCampaign[c] || 0) + Number(r.clicks);
    }
    for (const [k, r] of Object.entries(camp)) {
      if (k === 'total') continue;
      assert.equal(Number(r.clicks), byCampaign[k.split('|')[0]], k);
      assert.equal(k.split('|')[2], '', 'no ad at campaign level');
      if (Number(r.joins) > 0) assert.equal(Number(r.clicks_per_join).toFixed(6), (Number(r.clicks) / Number(r.joins)).toFixed(6), 'ratio recomputed');
    }
    assert.ok(Object.keys(camp).length <= Object.keys(ad).length);
  } finally { await app.close(); }
});

test('series: the per-day buckets add up to the period funnel exactly', async () => {
  const app = await startApp();
  try {
    seedDashFixture(app.db, app.deps.now());
    const range = Q.periodRange({ period: '30d' }, app.deps.now());
    const f = Q.funnel(app.db, { brandId: null, start: range.start, end: range.end });
    const s = Q.series(app.db, { brandId: null, start: range.start, end: range.end, bucketMs: 86400000 });
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    assert.equal(s.n, 30);
    assert.deepEqual([sum(s.clicks), sum(s.joins), sum(s.regs), sum(s.ftds), sum(s.redeps)], [f.clicks, f.joins, f.regs, f.ftds, f.redeps]);
    assert.equal(Math.round(sum(s.revenue) * 100), Math.round((f.revenue.USD || 0) * 100), 'USD revenue only');
    const h = Q.series(app.db, { brandId: null, start: range.end - 86400000, end: range.end, bucketMs: 3600000 });
    assert.equal(h.n, 24);
  } finally { await app.close(); }
});

test('overview: KPI tiles carry sparklines, the chart and the attention list; nav badges count parked events', async () => {
  const app = await startApp();
  try {
    seedDashFixture(app.db, app.deps.now());
    const html = (await req(app, '/dash?period=30d', { headers: asAdmin(app) })).text;
    assert.equal((html.match(/<svg class="spark/g) || []).length >= 6, true);
    assert.match(html, /<div class="chart" role="img" aria-label="Revenue and FTDs over the period">/);
    assert.match(html, /<h2>Needs attention<\/h2>/);
    const parked = app.db.prepare("SELECT COUNT(*) AS n FROM events WHERE state = 'parked'").get().n;
    assert.ok(parked > 0);
    assert.match(html, new RegExp(`<span>Events</span><span class="count warn" title="parked events">${parked}</span>`));
    assert.match(html, /Postback URL is open/, 'no AFF_KEY: flagged');
  } finally { await app.close(); }
});

test('system: every status card renders, and no secret is ever on the page', async () => {
  const META = { META_CAPI_ENABLED: '1', META_DATASET_ID: '1234567890', META_CAPI_TOKEN: 'placeholder-meta-value-never-shown' };
  const app = await startApp({ ...META, AFF_KEY: 'placeholder-postback-key-for-tests', JOIN_KEY: 'placeholder-join-key' });
  try {
    const html = (await req(app, '/dash/system', { headers: asAdmin(app) })).text;
    for (const id of ['service', 'database', 'snapshot', 'backups', 'meta', 'forward', 'security', 'alerts', 'report', 'retention']) assert.match(html, new RegExp(`<section class="card" id="${id}">`), id);
    for (const secret of ['placeholder-meta-value-never-shown', 'placeholder-postback-key-for-tests', 'placeholder-join-key', 'pass"']) assert.ok(!html.includes(secret), secret);
    assert.match(html, /Postback key \(AFF_KEY\)<\/span><span><span class="tag t-ok">enforced<\/span>/);
    assert.ok(!html.includes('data-snapshot-stale'), 'the stale marker stays on the Overview');
  } finally { await app.close(); }
});

test('links: the landing-page CTA URL and the Meta URL parameters are ready to copy', async () => {
  const app = await startApp();
  try {
    const html = (await req(app, '/dash/links', { headers: asAdmin(app) })).text;
    assert.match(html, /data-copy="https:\/\/coinvoo\.example\/go\/brand-one"/);
    assert.match(html, /data-copy="campaign_name=\{\{campaign\.name\}\}&amp;adset_name=\{\{adset\.name\}\}&amp;ad_name=\{\{ad\.name\}\}/);
    assert.ok(!/go\/brand-two/.test(html), 'only active brands');
  } finally { await app.close(); }
});

test('event page: a parked event can be attached from its own page, and the notice shows there', async () => {
  const app = await startApp();
  try {
    seedDashFixture(app.db, app.deps.now());
    const page = (await req(app, '/dash/events/e5', { headers: asAdmin(app) })).text;
    assert.match(page, /<details class="disclose" open><summary>/);
    assert.match(page, /<input type="hidden" name="back" value="\/dash\/events\/e5">/);
    const r = await req(app, '/dash/events/e5/attach', { method: 'POST', headers: { ...asAdmin(app), 'content-type': 'application/x-www-form-urlencoded' }, body: form({ member: '1001', note: 'seen in the bot chat', back: '/dash/events/e5' }) });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/dash/events/e5?notice=attached');
    assert.match((await req(app, '/dash/events/e5?notice=attached', { headers: asAdmin(app) })).text, /Event attached\./);
  } finally { await app.close(); }
});
