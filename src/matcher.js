import { withTx } from './db.js';
import { log } from './log.js';

// docs/03-attribution-rules.md, in the order DIRECTIVE-PHASE-2 §4 fixes:
//   1 afftrack (100) -> 2 accounts (90) -> 3 bot snapshot (90) -> 4 click id (85) -> parked (0).
const TG_RE = /^\d{1,15}$/;

export function logRow(db, eventId, candidate, reason, now) {
  db.prepare('INSERT INTO attribution_log (event_id, candidate, reason, created_at) VALUES (?, ?, ?, ?)')
    .run(eventId, candidate === null || candidate === undefined ? null : String(candidate), reason, now);
}

// One broker account, one owner. Returns 'linked' | 'exists' | 'claimed'.
export function linkAccount(db, { memberId, iqUserId, source, confidence, now, eventId = null }) {
  const r = db.prepare(
    `INSERT INTO accounts (member_id, iq_user_id, source, confidence, linked_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(iq_user_id) DO NOTHING`
  ).run(memberId, String(iqUserId), source, confidence, now);
  if (r.changes === 1) return 'linked';
  const owner = db.prepare('SELECT member_id FROM accounts WHERE iq_user_id = ?').get(String(iqUserId));
  if (owner && owner.member_id === memberId) return 'exists';
  const m = db.prepare('SELECT telegram_id FROM members WHERE id = ?').get(memberId);
  logRow(db, eventId || `account:${iqUserId}`, m ? m.telegram_id : memberId, 'account_claimed', now);
  return 'claimed';
}

// Pure decision (reads only). ev: { brand_id, trader_id, aff_track, click_id, ... }
// -> { member_id|null, account_id|null, path, confidence, link, notes: [{candidate, reason}] }
export function resolve(ev, { db, snapshot }) {
  const notes = [];
  const brandId = ev.brand_id ?? null;
  const memberByTg = db.prepare('SELECT id, telegram_id, joined_at, last_seen_at, click_id FROM members WHERE brand_id IS ? AND telegram_id = ?');

  // 1. afftrack names a Telegram id that is a member.
  if (ev.aff_track && TG_RE.test(ev.aff_track)) {
    const m = memberByTg.get(brandId, Number(ev.aff_track));
    if (m) return { member_id: m.id, account_id: null, path: 'afftrack', confidence: 100, link: null, notes };
    notes.push({ candidate: ev.aff_track, reason: 'afftrack_unknown' });
  }

  // Candidates from both trader_id sources (needed up front to detect a conflict).
  let owner = null;
  let snapCands = [];
  if (ev.trader_id) {
    owner = db.prepare(
      `SELECT a.id AS account_id, a.member_id, m.telegram_id
         FROM accounts a JOIN members m ON m.id = a.member_id
        WHERE a.iq_user_id = ? AND m.brand_id IS ?`
    ).get(String(ev.trader_id), brandId) || null;

    const seen = new Set();
    for (const row of snapshot.lookupByTrader(ev.trader_id)) {
      if (row.telegram_id === null || row.telegram_id === undefined) continue;
      const m = memberByTg.get(brandId, Number(row.telegram_id));
      if (!m) {
        notes.push({ candidate: row.telegram_id, reason: 'snapshot_no_member' });
        continue;
      }
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      snapCands.push(m);
    }
  }

  // 2. trader_id already linked inside coinvoo. The account owner always wins.
  if (owner) {
    for (const c of snapCands) {
      if (c.id !== owner.member_id) notes.push({ candidate: c.telegram_id, reason: 'candidate_rejected:accounts_owner' });
    }
    if (snapCands.length && !snapCands.some((c) => c.id === owner.member_id)) {
      notes.push({ candidate: snapCands[0].telegram_id, reason: 'trader_conflict' });
    }
    return { member_id: owner.member_id, account_id: owner.account_id, path: 'trader_id', confidence: 90, link: null, notes };
  }

  // 3. trader_id via the bot snapshot. Several members may claim it: click id, earliest
  //    joined_at, most recent last_seen_at.
  if (snapCands.length) {
    const clickMatch = (c) => (ev.click_id && c.click_id === ev.click_id ? 1 : 0);
    const sorted = [...snapCands].sort((a, b) =>
      (clickMatch(b) - clickMatch(a)) ||
      (a.joined_at - b.joined_at) ||
      ((b.last_seen_at || 0) - (a.last_seen_at || 0)));
    const win = sorted[0];
    for (const c of sorted.slice(1)) {
      const rule = clickMatch(win) !== clickMatch(c) ? 'click_id'
        : win.joined_at !== c.joined_at ? 'earliest_joined_at' : 'last_seen_at';
      notes.push({ candidate: c.telegram_id, reason: `candidate_rejected:${rule}` });
    }
    return {
      member_id: win.id, account_id: null, path: 'trader_id', confidence: 90,
      link: { member_id: win.id, iq_user_id: String(ev.trader_id) }, notes
    };
  }

  // 4. click id. The token is minted per ad, so many members can carry it. Only a single
  //    carrier is an identification; more than one is not, and is parked instead of guessed.
  if (ev.click_id) {
    const rows = db.prepare('SELECT id FROM members WHERE brand_id IS ? AND click_id = ? LIMIT 2').all(brandId, ev.click_id);
    if (rows.length === 1) {
      return { member_id: rows[0].id, account_id: null, path: 'click', confidence: 85, link: null, notes };
    }
    if (rows.length > 1) notes.push({ candidate: ev.click_id, reason: 'click_ambiguous' });
  }

  return { member_id: null, account_id: null, path: 'parked', confidence: 0, link: null, notes };
}

// Decide one stored event and persist the outcome. A throw rolls back and leaves the row as it was.
// Default eligible states are new/parked. Returns null when the event is not eligible.
export function matchEvent(deps, eventId, { states = ['new', 'parked'] } = {}) {
  const { db, snapshot, now: clock } = deps;
  const out = withTx(db, () => {
    const ev = db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId);
    if (!ev || !states.includes(ev.state)) return null;
    const now = clock();
    const r = resolve(ev, { db, snapshot });
    const first = ev.state === 'new';

    if (first || r.member_id) for (const n of r.notes) logRow(db, ev.event_id, n.candidate, n.reason, now);

    if (r.member_id) {
      if (r.link) {
        linkAccount(db, { memberId: r.link.member_id, iqUserId: r.link.iq_user_id, source: 'bot_db', confidence: 90, now, eventId: ev.event_id });
      }
      const fwd = ev.forward_state === 'none' ? (deps.config.parallelForward ? 'pending' : 'skipped') : ev.forward_state;
      db.prepare(
        `UPDATE events SET state = 'matched', matched_member_id = ?, matched_at = ?,
                forward_state = ?, forward_next_at = CASE WHEN ? = 'pending' AND forward_state = 'none' THEN ? ELSE forward_next_at END
          WHERE event_id = ?`
      ).run(r.member_id, now, fwd, fwd, now, ev.event_id);
      db.prepare(
        `INSERT INTO attributions (event_id, member_id, path, confidence, decided_at, note)
         VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(event_id) DO NOTHING`
      ).run(ev.event_id, r.member_id, r.path, r.confidence, now);
      logRow(db, ev.event_id, r.member_id, `matched:${r.path}`, now);
      return { state: 'matched', path: r.path, confidence: r.confidence, member_id: r.member_id, event: ev, forward: fwd, transitioned: true };
    }

    if (first) {
      db.prepare("UPDATE events SET state = 'parked' WHERE event_id = ?").run(ev.event_id);
      logRow(db, ev.event_id, null, 'parked:no_member', now);
    }
    return { state: 'parked', path: 'parked', confidence: 0, member_id: null, event: ev, forward: ev.forward_state, transitioned: first };
  });

  if (!out) return null;
  if (out.state === 'matched') {
    log.info('matched', { ev: out.event.event_id, kind: out.event.kind, trader: out.event.trader_id, path: out.path, conf: out.confidence, member: out.member_id });
    if (out.forward === 'pending' && deps.forwarder) deps.forwarder.schedule(out.event.event_id);
    // Phase 8: queue the conversion for Meta. After the commit, and a failure never undoes the match.
    if (deps.capi) {
      try { deps.capi.enqueueEvent(deps.db, { ...out.event, state: 'matched' }, clock()); } catch (e) { log.error('match meta enqueue', e); }
    }
  } else if (out.transitioned) {
    log.info('parked', { ev: out.event.event_id, trader: out.event.trader_id, reason: 'no_member' });
  }
  return { state: out.state, path: out.path, confidence: out.confidence, member_id: out.member_id };
}

// A member just became known (POST /api/join): link any bot-snapshot accounts for that
// Telegram id, then re-run the parked events that name the member or one of its accounts.
export function onMemberSeen(deps, { brandId, memberId, telegramId }) {
  const { db, snapshot, now: clock } = deps;
  const now = clock();
  for (const row of snapshot.lookupByTelegram(telegramId)) {
    if (!row.iq_user_id) continue;
    withTx(db, () => linkAccount(db, { memberId, iqUserId: row.iq_user_id, source: 'bot_db', confidence: 90, now }));
  }
  const traders = db.prepare('SELECT iq_user_id FROM accounts WHERE member_id = ?').all(memberId).map((r) => r.iq_user_id);
  const marks = traders.map(() => '?').join(',');
  const sql = `SELECT event_id FROM events WHERE state IN ('new', 'parked') AND brand_id IS ?
                 AND (aff_track = ?${traders.length ? ` OR trader_id IN (${marks})` : ''})
               ORDER BY received_at LIMIT 200`;
  const ids = db.prepare(sql).all(brandId, String(telegramId), ...traders).map((r) => r.event_id);
  let matched = 0;
  for (const id of ids) {
    const r = matchEvent(deps, id);
    if (r && r.state === 'matched') matched++;
  }
  return { considered: ids.length, matched };
}
