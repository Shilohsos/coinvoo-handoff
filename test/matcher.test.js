import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, makeSnapshot, invariants, allZero, captureLogs } from './helpers.js';
import { linkAccount } from '../src/matcher.js';
import { createWorker } from '../src/worker.js';
import { createSnapshot } from '../src/botdb.js';

const ev = (app, id) => app.db.prepare('SELECT * FROM events WHERE event_id = ?').get(id);
const attr = (app, id) => app.db.prepare('SELECT * FROM attributions WHERE event_id = ?').get(id);
const reasons = (app, id) => app.db.prepare('SELECT reason FROM attribution_log WHERE event_id = ? ORDER BY id').all(id).map((r) => r.reason);

async function withSnapshot(rows, fn, syncedAt) {
  const snap = makeSnapshot(rows, syncedAt);
  const app = await startApp({ BOTDB_SNAPSHOT: snap.path });
  try { await fn(app); } finally { await app.close(); snap.cleanup(); }
}

test('matcher: all five rules, in order, with their confidences', async () => {
  await withSnapshot([{ telegram_id: 7001, iq_user_id: '197000001' }], async (app) => {
    const m1 = app.member(7000);
    const m2 = app.member(7010);
    const m3 = app.member(7001);
    app.db.prepare("INSERT INTO accounts (member_id, iq_user_id, source, confidence, linked_at) VALUES (?, '197000010', 'manual', 100, 1)").run(m2);
    const token = (await app.mint()).token;
    const m4 = app.member(7004);
    app.db.prepare('UPDATE members SET click_id = ? WHERE id = ?').run(token, m4);

    // 1 afftrack 100
    let r = await app.pb({ status: 'ftd', trader_id: '197000900', amount: '50', event_id: 'e1', afftrack: '7000' });
    assert.deepEqual([r.matched, r.path, r.member_id, r.confidence], [true, 'afftrack', m1, 100]);
    // 2 accounts 90
    r = await app.pb({ status: 'ftd', trader_id: '197000010', amount: '50', event_id: 'e2' });
    assert.deepEqual([r.matched, r.path, r.member_id, r.confidence], [true, 'trader_id', m2, 90]);
    // 3 bot snapshot 90, and the account is linked for next time
    r = await app.pb({ status: 'ftd', trader_id: '197000001', amount: '50', event_id: 'e3' });
    assert.deepEqual([r.matched, r.path, r.member_id, r.confidence], [true, 'trader_id', m3, 90]);
    const acct = app.db.prepare("SELECT member_id, source FROM accounts WHERE iq_user_id = '197000001'").get();
    assert.deepEqual({ ...acct }, { member_id: m3, source: 'bot_db' });
    // 4 click id 85
    r = await app.pb({ status: 'reg', trader_id: '197000444', event_id: 'e4', clickid: token });
    assert.deepEqual([r.matched, r.path, r.member_id, r.confidence], [true, 'click', m4, 85]);
    // 5 nothing -> parked, no attribution row
    r = await app.pb({ status: 'dep', trader_id: '197999999', amount: '25', event_id: 'e5' });
    assert.deepEqual([r.matched, r.path], [false, 'parked']);
    assert.equal(ev(app, 'e5').state, 'parked');
    assert.equal(attr(app, 'e5'), undefined);
    assert.equal(attr(app, 'e3').confidence, 90);
    assert.ok(allZero(invariants(app.db)), JSON.stringify(invariants(app.db)));
  });
});

test('matcher: afftrack outranks trader_id when both are valid', async () => {
  await withSnapshot([], async (app) => {
    const a = app.member(7100);
    const b = app.member(7101);
    app.db.prepare("INSERT INTO accounts (member_id, iq_user_id, source, confidence, linked_at) VALUES (?, '197000020', 'manual', 100, 1)").run(b);
    const r = await app.pb({ status: 'ftd', trader_id: '197000020', amount: '10', event_id: 'p1', afftrack: '7100' });
    assert.deepEqual([r.path, r.member_id, r.confidence], ['afftrack', a, 100]);
  });
});

test('matcher: afftrack naming an unknown Telegram id is noted and the next rule still runs', async () => {
  await withSnapshot([], async (app) => {
    const owner = app.member(7200);
    app.db.prepare("INSERT INTO accounts (member_id, iq_user_id, source, confidence, linked_at) VALUES (?, '197000030', 'manual', 100, 1)").run(owner);
    const r = await app.pb({ status: 'ftd', trader_id: '197000030', amount: '10', event_id: 'u1', afftrack: '9999999999' });
    assert.deepEqual([r.path, r.member_id], ['trader_id', owner]);
    assert.ok(reasons(app, 'u1').includes('afftrack_unknown'));
  });
});

test('matcher: accounts and snapshot disagree -> trust accounts, log trader_conflict', async () => {
  await withSnapshot([{ telegram_id: 7301, iq_user_id: '197000040' }], async (app) => {
    const owner = app.member(7300);
    app.member(7301);
    app.db.prepare("INSERT INTO accounts (member_id, iq_user_id, source, confidence, linked_at) VALUES (?, '197000040', 'manual', 100, 1)").run(owner);
    const r = await app.pb({ status: 'ftd', trader_id: '197000040', amount: '10', event_id: 'c1' });
    assert.deepEqual([r.path, r.member_id], ['trader_id', owner]);
    const rs = reasons(app, 'c1');
    assert.ok(rs.includes('trader_conflict'));
    assert.ok(rs.includes('candidate_rejected:accounts_owner'));
  });
});

test('matcher: several snapshot candidates -> click id, then earliest joined_at, rejections logged', async () => {
  await withSnapshot([{ telegram_id: 7401, iq_user_id: '197000050' }, { telegram_id: 7402, iq_user_id: '197000050' }], async (app) => {
    const early = app.member(7401);
    const late = app.member(7402);
    app.db.prepare('UPDATE members SET joined_at = 1000 WHERE id = ?').run(early);
    app.db.prepare('UPDATE members SET joined_at = 2000 WHERE id = ?').run(late);

    let r = await app.pb({ status: 'ftd', trader_id: '197000050', amount: '10', event_id: 'm1' });
    assert.equal(r.member_id, early);
    assert.ok(reasons(app, 'm1').includes('candidate_rejected:earliest_joined_at'));

    // A postback carrying the later member's click id flips the choice (rule 2 of §2).
    app.db.prepare('DELETE FROM accounts').run();
    const token = (await app.mint()).token;
    app.db.prepare('UPDATE members SET click_id = ? WHERE id = ?').run(token, late);
    r = await app.pb({ status: 'ftd', trader_id: '197000050', amount: '11', event_id: 'm2', clickid: token });
    assert.equal(r.member_id, late);
    assert.ok(reasons(app, 'm2').includes('candidate_rejected:click_id'));
  });
});

test('matcher: a click id shared by several members is not an identification -> parked', async () => {
  await withSnapshot([], async (app) => {
    const token = (await app.mint()).token;
    for (const tg of [7501, 7502]) app.db.prepare('UPDATE members SET click_id = ? WHERE id = ?').run(token, app.member(tg));
    const r = await app.pb({ status: 'reg', trader_id: '197000060', event_id: 'amb1', clickid: token });
    assert.deepEqual([r.matched, r.path], [false, 'parked']);
    assert.ok(reasons(app, 'amb1').includes('click_ambiguous'));
  });
});

test('accounts: a second Telegram id presenting an owned broker account is refused (account_claimed)', async () => {
  await withSnapshot([], async (app) => {
    const a = app.member(7601);
    const b = app.member(7602);
    assert.equal(linkAccount(app.db, { memberId: a, iqUserId: '197000070', source: 'manual', confidence: 100, now: 1 }), 'linked');
    assert.equal(linkAccount(app.db, { memberId: a, iqUserId: '197000070', source: 'manual', confidence: 100, now: 2 }), 'exists');
    assert.equal(linkAccount(app.db, { memberId: b, iqUserId: '197000070', source: 'bot_db', confidence: 90, now: 3 }), 'claimed');
    assert.equal(app.db.prepare("SELECT member_id FROM accounts WHERE iq_user_id = '197000070'").get().member_id, a);
    assert.ok(app.db.prepare("SELECT 1 AS x FROM attribution_log WHERE reason = 'account_claimed' AND candidate = '7602'").get());
    const r = await app.pb({ status: 'ftd', trader_id: '197000070', amount: '10', event_id: 'ac1' });
    assert.equal(r.member_id, a, 'the owner keeps the event');
  });
});

test('stub guard: four shapes are stored, ignored, never matched, never counted', async () => {
  await withSnapshot([], async (app) => {
    app.member(7700);
    const shapes = {
      s1: { status: 'ftd', trader_id: '1', amount: '100', afftrack: '7700' },
      s2: { status: 'ftd', trader_id: '197000080', amount: '100', afftrack: 'TEST-RECON-1' },
      s3: { status: 'reg', trader_id: '197000081', clickid: 'myTestClick' },
      s4: { status: 'ftd', trader_id: '197000082', amount: '0', afftrack: '7700' },
      s5: { status: 'dep', trader_id: '1234', amount: '5', afftrack: '7700' }
    };
    for (const [id, p] of Object.entries(shapes)) {
      const r = await app.pb({ event_id: id, ...p });
      assert.deepEqual(r, { ok: true, ignored: 'stub_guard' }, id);
      const row = ev(app, id);
      assert.equal(row.state, 'ignored');
      assert.equal(row.ignore_reason, 'stub_guard');
      assert.equal(row.matched_member_id, null);
      assert.equal(row.forward_state, 'skipped');
    }
    const s = await (await fetch(`${app.base}/api/aff/stats`, { headers: { authorization: app.auth } })).json(); // money needs credentials (Phase 10)
    assert.equal(s.events.ignored, 5);
    assert.equal(s.events.ftd + s.events.dep + s.events.reg, 0, 'ignored events are in no metric');
    assert.equal(s.revenue.matched_usd, 0);
    assert.ok(allZero(invariants(app.db)), JSON.stringify(invariants(app.db)));
  });
});

test('lifecycle (mocked clock): parked -> matched when the member appears; parked -> expired after a week and still forwarded', async () => {
  let t = Date.now();
  const sent = [];
  const fetchImpl = async (url) => { sent.push(new URL(url)); return new Response('ok', { status: 200 }); };
  const app = await startApp({ PARALLEL_FORWARD: '1', JOINVOO_PB: 'https://joinvoo.example/pb/placeholder' }, { now: () => t, fetchImpl });
  const worker = createWorker(app.deps);
  try {
    // Two events nobody can claim yet.
    let r = await app.pb({ status: 'ftd', trader_id: '197000090', amount: '25', event_id: 'l1', afftrack: '7800' });
    assert.equal(r.path, 'parked');
    r = await app.pb({ status: 'dep', trader_id: '197000091', amount: '30', event_id: 'l2', afftrack: '7801' });
    assert.equal(r.path, 'parked');
    assert.equal(sent.length, 0, 'a parked event is not forwarded');

    // 1 h later member 7800 exists; the next tick decides l1 and leaves l2 parked.
    t += 3600 * 1000;
    const m = app.member(7800);
    let s = await worker.tick();
    assert.equal(s.rematched, 1);
    assert.equal(s.parked, 1);
    assert.equal(ev(app, 'l1').state, 'matched');
    assert.equal(ev(app, 'l1').matched_member_id, m);
    assert.equal(attr(app, 'l1').path, 'afftrack');
    assert.equal(ev(app, 'l1').forward_state, 'sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].searchParams.get('afftrack'), '7800');

    // A week after arrival l2 expires, gets an unattributed attribution, and is still forwarded.
    t += 169 * 3600 * 1000;
    s = await worker.tick();
    assert.equal(s.expired, 1);
    assert.equal(ev(app, 'l2').state, 'expired');
    assert.deepEqual({ ...attr(app, 'l2') }.path, 'none');
    assert.equal(attr(app, 'l2').confidence, 0);
    assert.equal(ev(app, 'l2').forward_state, 'sent');
    assert.equal(sent.at(-1).searchParams.get('afftrack'), '7801', 'unattributed: the inbound afftrack goes through');
    assert.equal(sent.at(-1).searchParams.get('clickid'), null, 'our click id is never sent');
    assert.ok(allZero(invariants(app.db)), JSON.stringify(invariants(app.db)));
  } finally {
    worker.stop();
    await app.close();
  }
});

test('snapshot unavailable: event is still stored and parked, one warning per hour, no crash', async () => {
  let t = Date.now();
  const app = await startApp({}, { now: () => t });
  try {
    const lines = await captureLogs(async () => {
      for (let i = 0; i < 3; i++) {
        const r = await app.pb({ status: 'ftd', trader_id: `19700010${i}`, amount: '10', event_id: `n${i}` });
        assert.equal(r.ok, true);
        assert.equal(r.path, 'parked');
      }
      t += 3601 * 1000;
      await app.pb({ status: 'ftd', trader_id: '197000109', amount: '10', event_id: 'n9' });
    });
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 4);
    assert.equal(lines.filter((l) => l === '[coinvoo] snapshot unavailable').length, 2, 'once, then again after an hour');
  } finally {
    await app.close();
  }
});

test('snapshot freshness: stale beyond 30 min is logged and matching continues', async () => {
  const t0 = Date.parse('2026-11-15T12:00:00Z');
  const snap = makeSnapshot([{ telegram_id: 7900, iq_user_id: '197000200' }], '2026-11-15T11:00:00Z'); // 60 min old
  const s = createSnapshot({ path: snap.path, now: () => t0 });
  try {
    const lines = await captureLogs(() => { assert.equal(s.checkFreshness().ageS, 3600); });
    assert.deepEqual(lines, ['[coinvoo] snapshot stale age=3600s']);
    assert.equal(s.lookupByTrader('197000200').length, 1, 'a stale snapshot still answers');
    const fresh = createSnapshot({ path: snap.path, now: () => Date.parse('2026-11-15T11:10:00Z') });
    const none = await captureLogs(() => { fresh.checkFreshness(); });
    assert.deepEqual(none, []);
    fresh.close();
  } finally {
    s.close();
    snap.cleanup();
  }
});

test('worker: one summary line per tick, single-flight, rollup agrees with events', async () => {
  const app = await startApp({});
  const worker = createWorker(app.deps);
  try {
    app.member(7950);
    await app.pb({ status: 'reg', trader_id: '197000300', event_id: 'w1', afftrack: '7950' });
    await app.pb({ status: 'ftd', trader_id: '197000300', amount: '40', event_id: 'w2', afftrack: '7950' });
    await app.pb({ status: 'dep', trader_id: '197000301', amount: '10', event_id: 'w3' });
    await app.pb({ status: 'ftd', trader_id: '1', amount: '10', event_id: 'w4' });
    const lines = await captureLogs(async () => {
      const [a, b] = await Promise.all([worker.tick(), worker.tick()]);
      assert.ok((a === null) !== (b === null), 'the overlapping tick is skipped');
    });
    const tick = lines.filter((l) => l.startsWith('[coinvoo] worker tick'));
    assert.equal(tick.length, 1);
    assert.match(tick[0], /^\[coinvoo\] worker tick parked=1 rematched=0 expired=0 forwards=0 meta=off rolled_up=2 took=\d+ms$/);

    const day = new Date(Date.now() + 3600000).toISOString().slice(0, 10);
    const row = app.db.prepare('SELECT * FROM daily_rollup WHERE day = ? AND brand_id = 1').get(day);
    const total = app.db.prepare("SELECT COUNT(*) AS n FROM events WHERE state <> 'ignored'").get().n;
    assert.equal(row.regs + row.ftds + row.redeps, total, 'invariant 1: rollup kinds sum to non-ignored events');
    assert.equal(row.revenue, 40, 'revenue is matched ftd+dep only; the parked $10 is not in it');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM daily_rollup WHERE brand_id = 2').get().n, 0, 'inactive brand has no rollup');
  } finally {
    await app.close();
  }
});
