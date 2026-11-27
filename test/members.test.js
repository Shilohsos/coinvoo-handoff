import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

const tg = 7000000001;

test('member upsert: first call creates, second updates username without duplicating', async () => {
  const app = await startApp();
  try {
    const a = await (await app.join({ brand: 'brand-one', telegram_id: tg, username: 'tester', first_name: 'tester', source: 'bot:start' })).json();
    assert.equal(a.ok, true);
    assert.equal(a.created, true);
    assert.equal(a.click_id, null);

    const b = await (await app.join({ brand: 'brand-one', telegram_id: tg, username: 'tester2', first_name: 'tester', source: 'channel:-100' })).json();
    assert.equal(b.created, false);
    assert.equal(b.member_id, a.member_id);

    const rows = app.db.prepare('SELECT username, join_source FROM members').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].username, 'tester2');
    assert.equal(rows[0].join_source, 'bot:start', 'join_source is untouched on update');
  } finally {
    await app.close();
  }
});

test('same telegram_id under two brands is two members', async () => {
  const app = await startApp();
  try {
    // brand-two is seeded inactive since Phase 2; a join to it is refused until activated.
    assert.equal((await app.join({ brand: 'brand-two', telegram_id: tg })).status, 422);
    app.db.prepare("UPDATE brands SET active = 1 WHERE code = 'brand-two'").run();
    const a = await (await app.join({ brand: 'brand-one', telegram_id: tg })).json();
    const b = await (await app.join({ brand: 'brand-two', telegram_id: tg })).json();
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.member_id, b.member_id);
  } finally {
    await app.close();
  }
});

test('first touch wins: a member with click A who later joins with click B keeps A', async () => {
  const app = await startApp();
  try {
    const A = (await app.mint({ brand: 'brand-one', campaign: 'A' })).token;
    const B = (await app.mint({ brand: 'brand-one', campaign: 'B' })).token;
    await app.join({ brand: 'brand-one', telegram_id: tg, click_id: A, source: 'bot:start' });
    const r = await (await app.join({ brand: 'brand-one', telegram_id: tg, click_id: B, source: 'bot:start' })).json();
    assert.equal(r.click_id, A);
    assert.equal(r.created, false);
    const m = app.db.prepare('SELECT click_id FROM members').get();
    assert.equal(m.click_id, A);
    const cb = app.db.prepare('SELECT joined_at, member_id FROM clicks WHERE click_id = ?').get(B);
    assert.equal(cb.joined_at, null, 'click B is not bound');
    assert.equal(cb.member_id, null);
  } finally {
    await app.close();
  }
});

test('a member created without a click receives one later (NULL -> click) and binds the click row', async () => {
  const app = await startApp();
  try {
    const A = (await app.mint()).token;
    const first = await (await app.join({ brand: 'brand-one', telegram_id: tg, source: 'channel:-100123', channel_join: true })).json();
    assert.equal(first.click_id, null);
    const second = await (await app.join({ brand: 'brand-one', telegram_id: tg, click_id: A, source: 'bot:start' })).json();
    assert.equal(second.click_id, A);
    assert.equal(second.created, false);
    const c = app.db.prepare('SELECT joined_at, member_id FROM clicks WHERE click_id = ?').get(A);
    assert.equal(c.member_id, first.member_id);
    assert.ok(c.joined_at > 0);
    const m = app.db.prepare('SELECT join_source FROM members').get();
    assert.equal(m.join_source, 'channel:-100123', 'join_source stays as first recorded');
  } finally {
    await app.close();
  }
});

test('unknown click id on /api/join -> 422 unknown_click and no member is created', async () => {
  const app = await startApp();
  try {
    const r = await app.join({ brand: 'brand-one', telegram_id: tg, click_id: 'ZZZZZZZZZZ', source: 'bot:start' });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error, 'unknown_click');
    const bad = await app.join({ brand: 'brand-one', telegram_id: tg, click_id: 'not-a-token' });
    assert.equal(bad.status, 422);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM members').get().n, 0);
  } finally {
    await app.close();
  }
});

test('/api/join validation: unknown brand 422, bad telegram_id 400, bad JSON 400', async () => {
  const app = await startApp();
  try {
    let r = await app.join({ brand: 'nope', telegram_id: tg });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error, 'unknown_brand');
    for (const bad of [0, -5, 1.5, '123', null, undefined]) {
      r = await app.join({ brand: 'brand-one', telegram_id: bad });
      assert.equal(r.status, 400, `telegram_id=${bad}`);
    }
    r = await fetch(`${app.base}/api/join`, { method: 'POST', body: '{not json' });
    assert.equal(r.status, 400);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM members').get().n, 0);
  } finally {
    await app.close();
  }
});

test('/api/join auth: loopback-only without JOIN_KEY; X-Coinvoo-Key required with it', async () => {
  const open = await startApp();
  try {
    assert.equal((await open.join({ brand: 'brand-one', telegram_id: tg })).status, 200);
    // Came through a reverse proxy (peer is loopback, but X-Forwarded-For is set): refused.
    assert.equal((await open.join({ brand: 'brand-one', telegram_id: tg }, { 'x-forwarded-for': '198.51.100.7' })).status, 401);
  } finally {
    await open.close();
  }
  const keyed = await startApp({ JOIN_KEY: 'sekrit' });
  try {
    assert.equal((await keyed.join({ brand: 'brand-one', telegram_id: tg })).status, 401);
    assert.equal((await keyed.join({ brand: 'brand-one', telegram_id: tg }, { 'x-coinvoo-key': 'wrong' })).status, 401);
    const ok = await keyed.join({ brand: 'brand-one', telegram_id: tg }, { 'x-coinvoo-key': 'sekrit', 'x-forwarded-for': '198.51.100.7' });
    assert.equal(ok.status, 200);
    assert.equal(keyed.db.prepare('SELECT COUNT(*) AS n FROM members').get().n, 1);
  } finally {
    await keyed.close();
  }
});
