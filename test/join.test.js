// Phase 7 Part A — join ingest: the legacy X-Tribute-Key header and POST /api/join/batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { joinKeyFromHeaders } from '../src/routes/join.js';

const KEY = 'join-key-for-tests-only';
const T0 = Date.UTC(2026, 10, 16, 10, 6); // 16 Nov 11:06 Lagos, when the feed went quiet

function batch(app, body, headers = {}) {
  return fetch(`${app.base}/api/join/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}
const count = (app) => app.db.prepare('SELECT COUNT(*) AS n FROM members').get().n;

test('joinKeyFromHeaders: X-Coinvoo-Key, then the legacy X-Tribute-Key; empty values ignored', () => {
  assert.deepEqual(joinKeyFromHeaders({ headers: { 'x-coinvoo-key': 'a' } }), ['a']);
  assert.deepEqual(joinKeyFromHeaders({ headers: { 'x-tribute-key': 'b' } }), ['b']);
  assert.deepEqual(joinKeyFromHeaders({ headers: { 'x-coinvoo-key': 'a', 'x-tribute-key': 'b' } }), ['a', 'b']);
  assert.deepEqual(joinKeyFromHeaders({ headers: { 'x-coinvoo-key': '' } }), []);
  assert.deepEqual(joinKeyFromHeaders({ headers: {} }), []);
});

test('A1 /api/join with JOIN_KEY: X-Coinvoo-Key ok, legacy x-tribute-key ok, wrong key 401, no key through the proxy 401', async () => {
  const app = await startApp({ JOIN_KEY: KEY });
  const viaProxy = { 'x-forwarded-for': '198.51.100.7' };
  try {
    assert.equal((await app.join({ brand: 'brand-one', telegram_id: 501 }, { 'x-coinvoo-key': KEY, ...viaProxy })).status, 200, 'new header');
    assert.equal((await app.join({ brand: 'brand-one', telegram_id: 502 }, { 'x-tribute-key': KEY, ...viaProxy })).status, 200, 'legacy header');
    const wrong = await app.join({ brand: 'brand-one', telegram_id: 503 }, { 'x-tribute-key': 'nope', ...viaProxy });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).detail, 'missing or invalid X-Coinvoo-Key', 'the 401 is unchanged');
    assert.equal((await app.join({ brand: 'brand-one', telegram_id: 504 }, { 'x-coinvoo-key': 'nope', ...viaProxy })).status, 401);
    assert.equal((await app.join({ brand: 'brand-one', telegram_id: 505 }, viaProxy)).status, 401, 'missing key, non-loopback');
    assert.equal((await app.join({ brand: 'brand-one', telegram_id: 506 })).status, 401, 'with JOIN_KEY set, loopback still needs the key (unchanged)');
    assert.equal((await app.join({ brand: 'brand-one', telegram_id: 507 }, { 'x-coinvoo-key': 'stale', 'x-tribute-key': KEY })).status, 200, 'either header may carry it');
    assert.deepEqual(app.db.prepare('SELECT telegram_id FROM members ORDER BY telegram_id').all().map((r) => r.telegram_id), [501, 502, 507]);
  } finally { await app.close(); }
});

test('A1 /api/join without JOIN_KEY: loopback still allowed, proxied still refused (unchanged)', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.join({ brand: 'brand-one', telegram_id: 601 })).status, 200);
    assert.equal((await app.join({ brand: 'brand-one', telegram_id: 602 }, { 'x-forwarded-for': '198.51.100.7', 'x-tribute-key': 'anything' })).status, 401);
  } finally { await app.close(); }
});

test('A2 batch: creates with the real joined_at; re-posting the same batch creates 0, no duplicate, joined_at preserved', async () => {
  const app = await startApp({ JOIN_KEY: KEY });
  const joins = [
    { telegram_id: 7001, joined_at: T0 + 60000, username: 'ada', first_name: 'Ada', join_source: 'channel:-1002766084283' },
    { telegram_id: 7002, joined_at: T0 + 120000, username: 'bayo', first_name: 'Bayo', join_source: 'channel:-1002766084283' },
    { telegram_id: 7003, joined_at: T0 + 180000, first_name: 'Chi' }
  ];
  try {
    const r1 = await batch(app, { joins }, { 'x-tribute-key': KEY });
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { ok: true, created: 3, updated: 0, errors: [] });
    const rows = () => app.db.prepare('SELECT telegram_id, joined_at, username, join_source, click_id FROM members ORDER BY telegram_id').all().map((r) => ({ ...r }));
    const first = rows();
    assert.deepEqual(first, [
      { telegram_id: 7001, joined_at: T0 + 60000, username: 'ada', join_source: 'channel:-1002766084283', click_id: null },
      { telegram_id: 7002, joined_at: T0 + 120000, username: 'bayo', join_source: 'channel:-1002766084283', click_id: null },
      { telegram_id: 7003, joined_at: T0 + 180000, username: null, join_source: 'backfill:batch', click_id: null }
    ]);
    const r2 = await batch(app, { joins }, { 'x-coinvoo-key': KEY });
    assert.deepEqual(await r2.json(), { ok: true, created: 0, updated: 3, errors: [] });
    assert.equal(count(app), 3, 'row count unchanged');
    assert.deepEqual(rows(), first, 'joined_at (and everything else) preserved');
    // the same member arriving later through the live feed keeps its first joined_at too
    await app.join({ brand: 'brand-one', telegram_id: 7001, username: 'ada' }, { 'x-coinvoo-key': KEY });
    assert.equal(app.db.prepare('SELECT joined_at FROM members WHERE telegram_id = 7001').get().joined_at, T0 + 60000);
    // and a later backfill of an older join does not move last_seen_at backwards
    const seen = app.db.prepare('SELECT last_seen_at FROM members WHERE telegram_id = 7001').get().last_seen_at;
    await batch(app, { joins: [joins[0]] }, { 'x-coinvoo-key': KEY });
    assert.equal(app.db.prepare('SELECT last_seen_at FROM members WHERE telegram_id = 7001').get().last_seen_at, seen);
  } finally { await app.close(); }
});

test('A2 batch: more than 500 rows -> 400 too_many, nothing written; 500 is accepted', async () => {
  const app = await startApp({ JOIN_KEY: KEY });
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ telegram_id: 100000 + i, joined_at: T0 + i, username: `user_${i}`, first_name: `First ${i}`, join_source: 'channel:-1002766084283' }));
  try {
    const big = await batch(app, { joins: rows(501) }, { 'x-coinvoo-key': KEY });
    assert.equal(big.status, 400);
    assert.equal((await big.json()).error, 'too_many');
    assert.equal(count(app), 0);
    const body = JSON.stringify({ joins: rows(500) });
    assert.ok(body.length > 64 * 1024, `a full batch (${body.length} bytes) is larger than the shared 64 KB JSON limit`);
    const full = await batch(app, body, { 'x-coinvoo-key': KEY });
    assert.equal(full.status, 200);
    assert.equal((await full.json()).created, 500);
    assert.equal(count(app), 500);
  } finally { await app.close(); }
});

test('A2 batch: bad rows are collected into errors by index; valid rows are still inserted', async () => {
  const app = await startApp({ JOIN_KEY: KEY });
  try {
    const r = await batch(app, { joins: [
      { telegram_id: 8001, joined_at: T0 },
      { telegram_id: 'abc', joined_at: T0 },
      { telegram_id: -5 },
      { telegram_id: 8002, joined_at: Date.now() + 86400000 },
      null,
      { telegram_id: 8003, click_id: 'NOTATOKEN!' },
      { telegram_id: 8004, click_id: '7K2M9QX4AB' },
      { telegram_id: 8005 }
    ] }, { 'x-coinvoo-key': KEY });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.created, 2);
    assert.equal(j.updated, 0);
    assert.deepEqual(j.errors, [
      { index: 1, error: 'telegram_id must be a positive integer' },
      { index: 2, error: 'telegram_id must be a positive integer' },
      { index: 3, error: 'joined_at must be epoch milliseconds, not in the future' },
      { index: 4, error: 'row must be an object' },
      { index: 5, error: 'click_id is not a valid token' },
      { index: 6, error: 'click_id 7K2M9QX4AB does not exist' }
    ]);
    assert.deepEqual(app.db.prepare('SELECT telegram_id FROM members ORDER BY telegram_id').all().map((x) => x.telegram_id), [8001, 8005]);
  } finally { await app.close(); }
});

test('A2 batch: same auth as /api/join, and the request shape is checked', async () => {
  const app = await startApp({ JOIN_KEY: KEY });
  const viaProxy = { 'x-forwarded-for': '198.51.100.7' };
  try {
    assert.equal((await batch(app, { joins: [{ telegram_id: 1 }] }, viaProxy)).status, 401);
    assert.equal((await batch(app, { joins: [{ telegram_id: 1 }] }, { 'x-tribute-key': 'wrong', ...viaProxy })).status, 401);
    assert.equal((await batch(app, { joins: 'x' }, { 'x-tribute-key': KEY })).status, 400);
    assert.equal((await batch(app, '[1]', { 'x-tribute-key': KEY })).status, 400);
    assert.equal((await batch(app, { brand: 'nope', joins: [] }, { 'x-tribute-key': KEY })).status, 422);
    assert.equal(count(app), 0);
  } finally { await app.close(); }
  const open = await startApp();
  try {
    const r = await batch(open, { joins: [{ telegram_id: 9 }] });
    assert.equal(r.status, 200, 'loopback without JOIN_KEY, like /api/join');
  } finally { await open.close(); }
});
