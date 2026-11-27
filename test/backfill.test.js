import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, makeSnapshot, invariants, allZero } from './helpers.js';
import { backfillMembers } from '../scripts/backfill-members.js';
import { importRecon } from '../scripts/import-recon.js';
import { rematch } from '../scripts/rematch.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'recon-sample.db');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function makeGateDb(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'coinvoo-gate-'));
  const path = join(dir, 'gatebot1.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE users (telegram_id INTEGER PRIMARY KEY, first_name TEXT, username TEXT, joined_at TEXT, last_msg TEXT)');
  const ins = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(...r);
  db.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('backfill: seeds members from the snapshot and a gate db, is idempotent, never overwrites', async () => {
  const snap = makeSnapshot([
    { telegram_id: 9001, iq_user_id: '197200001', username: 'one', created_at: '2026-09-01T10:00:00Z' },
    { telegram_id: 9001, iq_user_id: '197200002', username: 'one', created_at: '2026-09-05T10:00:00Z' }, // second broker account, same person
    { telegram_id: 9002, iq_user_id: '197200003', username: 'two', created_at: '2026-09-02T10:00:00Z' },
    { telegram_id: 9003, iq_user_id: '197200004', username: 'three', created_at: '2026-09-03T10:00:00Z' }
  ]);
  const gate = makeGateDb([
    [9003, 'Three', 'three', '2026-08-01 10:00:00', '2026-11-01 10:00:00'], // also in the snapshot: botdb wins, gate must not overwrite
    [9100, 'Gate', 'gateguy', '2026-08-02 10:00:00', null],
    [9101, null, null, 'not a date', null]
  ]);
  const app = await startApp();
  try {
    // A member who already exists, with a click: backfill must leave every field alone.
    const token = (await app.mint()).token;
    await app.join({ brand: 'brand-one', telegram_id: 9002, username: 'live', first_name: 'Live', click_id: token, source: 'bot:start' });
    const before = { ...app.db.prepare('SELECT * FROM members WHERE telegram_id = 9002').get() };

    const dry = backfillMembers(app.db, { snapshotPath: snap.path, gateDbPath: gate.path, dryRun: true });
    assert.deepEqual(dry.botdb, { source_rows: 3, inserted: 2, already_present: 1 });
    assert.deepEqual(dry.gate, { source_rows: 3, inserted: 3, already_present: 0 }, 'dry run does not see its own inserts');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM members').get().n, 1, 'dry run wrote nothing');

    const r1 = backfillMembers(app.db, { snapshotPath: snap.path, gateDbPath: gate.path });
    assert.deepEqual(r1.botdb, { source_rows: 3, inserted: 2, already_present: 1 });
    assert.deepEqual(r1.gate, { source_rows: 3, inserted: 2, already_present: 1 });
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM members').get().n, 5);

    const r2 = backfillMembers(app.db, { snapshotPath: snap.path, gateDbPath: gate.path });
    assert.equal(r2.botdb.inserted + r2.gate.inserted, 0, 'second run changes nothing');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM members').get().n, 5);

    assert.deepEqual({ ...app.db.prepare('SELECT * FROM members WHERE telegram_id = 9002').get() }, before, 'existing member untouched');
    const src = (tg) => app.db.prepare('SELECT join_source, click_id FROM members WHERE telegram_id = ?').get(tg);
    assert.deepEqual({ ...src(9001) }, { join_source: 'backfill:botdb', click_id: null });
    assert.equal(src(9003).join_source, 'backfill:botdb');
    assert.equal(src(9100).join_source, 'backfill:gate');
    assert.equal(app.db.prepare('SELECT joined_at FROM members WHERE telegram_id = 9001').get().joined_at, Date.parse('2026-09-01T10:00:00Z'), 'earliest broker-account time');
    assert.ok(allZero(invariants(app.db)));
  } finally {
    await app.close();
    snap.cleanup();
    gate.cleanup();
  }
});

test('import-recon: dry run writes nothing; real import maps states; second run changes nothing; recon.db is untouched', async () => {
  const app = await startApp();
  try {
    for (const tg of [7000000001, 7000000002, 7000000003, 7000000004]) app.member(tg);
    const before = sha(FIXTURE);

    const dry = importRecon(app.db, { reconPath: FIXTURE, dryRun: true });
    assert.deepEqual(dry.by_state, { matched: 8, parked: 5, expired: 3, ignored: 4 });
    assert.equal(dry.source_rows, 20);
    assert.equal(dry.would_insert, 20);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0, 'dry run wrote nothing');

    const r1 = importRecon(app.db, { reconPath: FIXTURE });
    assert.equal(r1.inserted, 20);
    assert.deepEqual(r1.by_state, { matched: 8, parked: 5, expired: 3, ignored: 4 });
    const count = () => app.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    assert.equal(count(), 20);
    const snapshotOfTables = () => JSON.stringify([
      app.db.prepare('SELECT * FROM events ORDER BY event_id').all(),
      app.db.prepare('SELECT * FROM attributions ORDER BY event_id').all()]);
    const state1 = snapshotOfTables();

    const r2 = importRecon(app.db, { reconPath: FIXTURE });
    assert.equal(r2.inserted, 0);
    assert.equal(r2.already_present, 20);
    assert.equal(count(), 20);
    assert.equal(snapshotOfTables(), state1, 'a second import changes no row');
    assert.equal(sha(FIXTURE), before, 'recon.db is byte-identical after import');

    const row = (id) => app.db.prepare('SELECT * FROM events WHERE event_id = ?').get(id);
    const a = row('ev-r01');
    assert.deepEqual([a.state, a.kind, a.amount, a.forward_state, a.forward_tries, a.network], ['matched', 'ftd', 50, 'sent', 1, 'affstore']);
    assert.equal(a.received_at, 1790000000 * 1000);
    assert.equal(app.db.prepare("SELECT path FROM attributions WHERE event_id = 'ev-r01'").get().path, 'afftrack');
    assert.equal(app.db.prepare("SELECT path FROM attributions WHERE event_id = 'ev-r03'").get().path, 'trader_id');
    assert.equal(row('ev-r07').state, 'parked', 'sent with a tg_id nobody here knows is parked, not falsely matched');
    assert.equal(row('ev-r08').state, 'expired');
    assert.equal(row('ev-r12').state, 'expired');
    assert.deepEqual([row('ev-r13').state, row('ev-r13').ignore_reason], ['ignored', 'bad_kind']);
    for (const id of ['ev-r14', 'ev-r15', 'ev-r16']) assert.deepEqual([row(id).state, row(id).ignore_reason], ['ignored', 'stub_guard'], id);
    assert.equal(row('ev-r09').forward_state, 'none', 'unsent + parked: left for the normal expiry policy (invariant 4)');
    assert.equal(row('ev-r12').forward_state, 'skipped', 'unsent history that is already decided is not re-forwarded');
    assert.ok(JSON.parse(row('ev-r01').payload_json).imported_from === 'recon.db');
    assert.ok(allZero(invariants(app.db)), JSON.stringify(invariants(app.db)));
  } finally {
    await app.close();
  }
});

test('rematch script: re-runs the matcher for a trader_id or an event_id', async () => {
  const app = await startApp();
  try {
    await app.pb({ status: 'dep', trader_id: '197300001', amount: '25', event_id: 'rm1' });
    assert.equal(app.db.prepare("SELECT state FROM events WHERE event_id = 'rm1'").get().state, 'parked');
    const m = app.member(9400);
    app.db.prepare("INSERT INTO accounts (member_id, iq_user_id, source, confidence, linked_at) VALUES (?, '197300001', 'manual', 100, 1)").run(m);
    const deps = { ...app.deps, forwarder: null };
    assert.deepEqual(rematch(deps, '197300001'), { considered: 1, matched: 1, parked: 0 });
    const row = app.db.prepare("SELECT state, matched_member_id FROM events WHERE event_id = 'rm1'").get();
    assert.deepEqual({ ...row }, { state: 'matched', matched_member_id: m });
    assert.deepEqual(rematch(deps, 'rm1'), { considered: 0, matched: 0, parked: 0 }, 'already decided');
    assert.ok(allZero(invariants(app.db)));
  } finally {
    await app.close();
  }
});
