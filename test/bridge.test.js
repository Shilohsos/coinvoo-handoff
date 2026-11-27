import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { openDb, migrate, splitSql } from '../src/db.js';
import { startApp, testEnv } from './helpers.js';

test('mint -> click -> 302 with the volatile fields stamped', async () => {
  const app = await startApp();
  try {
    const minted = await app.mint();
    assert.equal(minted.ok, true);
    assert.equal(minted.token.length, 10);
    assert.equal(minted.url, `https://coinvoo.example/c/${minted.token}`);
    assert.equal(minted.telegram_url, `https://t.me/coinvoo_test_bot?start=c_${minted.token}`);

    let row = app.db.prepare('SELECT * FROM clicks WHERE click_id = ?').get(minted.token);
    assert.equal(row.campaign, 'NG_Broad');
    assert.equal(row.ip_hash, null, 'volatile fields are NULL until opened');
    assert.equal(row.clicked_at, null);

    const r = await fetch(`${app.base}/c/${minted.token}?ttclid=E.C.P.test&sub1=x`, { redirect: 'manual', headers: { referer: 'https://ads.example/' } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `https://t.me/coinvoo_test_bot?start=c_${minted.token}`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-coinvoo-click'), minted.token);

    row = app.db.prepare('SELECT * FROM clicks WHERE click_id = ?').get(minted.token);
    assert.equal(row.ttclid, 'E.C.P.test');
    assert.equal(row.sub1, 'x');
    assert.equal(row.fbclid, null, 'absent params stay NULL, never empty string');
    assert.equal(row.ip_hash.length, 32);
    assert.equal(row.referer, 'https://ads.example/');
    assert.ok(row.clicked_at > 0);
  } finally {
    await app.close();
  }
});

test('re-opening a link refreshes volatile fields, adds no row, keeps earlier values', async () => {
  const app = await startApp();
  try {
    const { token } = await app.mint();
    await fetch(`${app.base}/c/${token}?ttclid=first&gclid=g1`, { redirect: 'manual' });
    await fetch(`${app.base}/c/${token}?ttclid=second`, { redirect: 'manual' });
    const row = app.db.prepare('SELECT ttclid, gclid FROM clicks WHERE click_id = ?').get(token);
    assert.equal(row.ttclid, 'second');
    assert.equal(row.gclid, 'g1');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM clicks').get().n, 1);
  } finally {
    await app.close();
  }
});

test('unknown / malformed token -> 404 text/plain "link not found", nothing written', async () => {
  const app = await startApp();
  try {
    for (const t of ['ZZZZZZZZZZ', 'short', 'lowercase1', '7K2M9QX4AI']) {
      const r = await fetch(`${app.base}/c/${t}`, { redirect: 'manual' });
      assert.equal(r.status, 404, t);
      assert.match(r.headers.get('content-type'), /text\/plain/);
      assert.equal(await r.text(), 'link not found');
    }
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM clicks').get().n, 0);
  } finally {
    await app.close();
  }
});

test('a link of an inactive brand is not honoured', async () => {
  const app = await startApp();
  try {
    const { token } = await app.mint();
    app.db.prepare("UPDATE brands SET active = 0 WHERE code = 'brand-one'").run();
    assert.equal((await fetch(`${app.base}/c/${token}`, { redirect: 'manual' })).status, 404);
    const r = await app.mint();
    assert.equal(r.error, 'unknown_brand');
  } finally {
    await app.close();
  }
});

test('/api/links: auth, unknown brand, bad params', async () => {
  const app = await startApp();
  try {
    const post = (body, headers = {}) => fetch(`${app.base}/api/links`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    let r = await post({ brand: 'brand-one' });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /Basic/);
    r = await post({ brand: 'brand-one' }, { authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') });
    assert.equal(r.status, 401);
    r = await post({ brand: 'nope' }, { authorization: app.auth });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error, 'unknown_brand');
    r = await post({ brand: 'brand-one', campaign: 5 }, { authorization: app.auth });
    assert.equal(r.status, 400);
    r = await post({}, { authorization: app.auth });
    assert.equal(r.status, 400);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM clicks').get().n, 0);
  } finally {
    await app.close();
  }
});

test('click -> join -> member row carries the click and campaign', async () => {
  const app = await startApp();
  try {
    const { token } = await app.mint();
    await fetch(`${app.base}/c/${token}`, { redirect: 'manual' });
    const r = await (await app.join({ brand: 'brand-one', telegram_id: 7000000001, username: 'tester', first_name: 'tester', click_id: token, source: 'bot:start' })).json();
    assert.deepEqual(r, { ok: true, member_id: 1, created: true, click_id: token, rejoin: false });
    const row = app.db.prepare('SELECT m.telegram_id, m.join_source, c.campaign, c.member_id, c.joined_at FROM members m JOIN clicks c ON c.click_id = m.click_id').get();
    assert.equal(row.telegram_id, 7000000001);
    assert.equal(row.join_source, 'bot:start');
    assert.equal(row.campaign, 'NG_Broad');
    assert.equal(row.member_id, 1);
    assert.ok(row.joined_at > 0);
  } finally {
    await app.close();
  }
});

test('health, stats, 404 JSON, 404 HTML for /dash, 405', async () => {
  const app = await startApp();
  try {
    const h = await (await fetch(`${app.base}/api/aff/health`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.service, 'coinvoo');
    assert.equal(h.db, 'ok');
    const s = await (await fetch(`${app.base}/api/aff/stats`)).json();
    assert.equal(s.ok, true);
    assert.equal(s.members.total, 0);
    let r = await fetch(`${app.base}/nope`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, 'not_found');
    r = await fetch(`${app.base}/dash/<script>`);
    assert.equal(r.status, 404);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.ok(!(await r.text()).includes('<script>'), 'path is escaped in the HTML 404');
    r = await fetch(`${app.base}/api/join`);
    assert.equal(r.status, 405);
  } finally {
    await app.close();
  }
});

test('a handler that throws returns 500 JSON and the server keeps serving', async () => {
  const app = await startApp();
  try {
    const { token } = await app.mint();
    app.db.prepare("UPDATE brands SET bot_username = 'bad name!' WHERE code = 'brand-one'").run();
    const orig = console.error;
    console.error = () => {};
    let r;
    try { r = await fetch(`${app.base}/c/${token}`, { redirect: 'manual' }); } finally { console.error = orig; }
    assert.equal(r.status, 500);
    assert.equal((await r.json()).ok, false);
    assert.equal((await fetch(`${app.base}/api/aff/health`)).status, 200);
  } finally {
    await app.close();
  }
});

test('config: fails fast naming every missing variable', () => {
  assert.throws(() => loadConfig({}), /DB_PATH.*PUBLIC_BASE.*ADMIN_USER.*ADMIN_PASS.*BRAND_ONE_BOT_USERNAME/);
  assert.throws(() => loadConfig(testEnv({ PORT: 'abc' })), /PORT/);
  assert.throws(() => loadConfig(testEnv({ PUBLIC_BASE: 'example.com' })), /PUBLIC_BASE/);
  const c = loadConfig(testEnv({ PUBLIC_BASE: 'https://x.example///' }));
  assert.equal(c.publicBase, 'https://x.example');
  assert.equal(c.port, 8770);
  assert.ok(Object.isFrozen(c));
});

test('migrations: apply once, are recorded, and rerun is a no-op; brand-two seeded only when configured', () => {
  const cfg = loadConfig(testEnv());
  const db = openDb(':memory:');
  const m1 = migrate(db, { env: cfg.brandSeed });
  assert.deepEqual([m1.newlyApplied, m1.total, m1.latest], [12, 12, '012_click_ad_ids']);
  const m2 = migrate(db, { env: cfg.brandSeed });
  assert.deepEqual([m2.newlyApplied, m2.total], [0, 12]);
  // Phase 2 locked decision: brand-two is seeded but inactive.
  assert.deepEqual(db.prepare('SELECT code, bot_username, active FROM brands ORDER BY code').all().map((r) => ({ ...r })),
    [{ code: 'brand-one', bot_username: 'coinvoo_test_bot', active: 1 }, { code: 'brand-two', bot_username: 'coinvoo_echo_bot', active: 0 }]);

  const onlyBrandOne = loadConfig(testEnv({ BRAND_TWO_BOT_USERNAME: '' }));
  const db2 = openDb(':memory:');
  migrate(db2, { env: onlyBrandOne.brandSeed });
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM brands').get().n, 1);
  db.close();
  db2.close();
});

test('splitSql: ignores comments and semicolons inside strings', () => {
  assert.deepEqual(splitSql("-- a; b\nSELECT 'x;y'; SELECT 2 -- tail\n;"), ["SELECT 'x;y'", 'SELECT 2']);
});

test('POST /api/links refuses cross-site requests (a text/plain form can carry JSON and cached Basic credentials)', async () => {
  const app = await startApp();
  try {
    const body = '{"brand":"brand-one","campaign":"csrf","x":"="}';
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'null' }]) {
      const r = await fetch(`${app.base}/api/links`, { method: 'POST', headers: { authorization: app.auth, 'content-type': 'text/plain', ...headers }, body });
      assert.equal(r.status, 403, JSON.stringify(headers));
    }
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM clicks WHERE campaign = 'csrf'").get().n, 0, 'nothing minted');
    // same-origin browsers and scripts that send no Origin still work
    const host = new URL(app.base).host;
    assert.equal((await fetch(`${app.base}/api/links`, { method: 'POST', headers: { authorization: app.auth, 'content-type': 'application/json', origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }, body: '{"brand":"brand-one"}' })).status, 200);
    assert.equal((await app.mint()).ok, true);
  } finally { await app.close(); }
});

test('HEAD /c/:token answers like GET (link checkers) but records nothing', async () => {
  const app = await startApp();
  try {
    const { token } = await app.mint();
    const r = await fetch(`${app.base}/c/${token}`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `https://t.me/coinvoo_test_bot?start=c_${token}`);
    assert.equal(r.headers.get('x-coinvoo-click'), token);
    const row = app.db.prepare('SELECT clicked_at, ip_hash, ua FROM clicks WHERE click_id = ?').get(token);
    assert.deepEqual([row.clicked_at, row.ip_hash, row.ua], [null, null, null], 'a check is not a click');
    assert.equal((await fetch(`${app.base}/c/ZZZZZZZZZZ`, { method: 'HEAD', redirect: 'manual' })).status, 404);
    assert.equal((await fetch(`${app.base}/c/bad`, { method: 'HEAD', redirect: 'manual' })).status, 404);
  } finally { await app.close(); }
});
