// Every SQL read (and the one write: manual attach) used by the dashboard and the admin JSON.
// Routes call these named functions only; the HTML and JSON paths share one implementation.
import { HttpError } from './router.js';
import { withTx } from './db.js';
import { log } from './log.js';
import { lagosDayStart, lagosDayLabel } from './worker.js';
import { linkAccount, matchEvent } from './matcher.js';

const DAY_MS = 86400000;
const LAGOS_OFFSET_MS = 3600000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- parameters ----------

export function parsePage(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : 1;
}

export function parseLimit(v, dflt, max = 200) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : dflt;
}

// A Lagos calendar day 'YYYY-MM-DD' -> its start in epoch ms, or null.
export function dayStartMs(day) {
  if (!DAY_RE.test(day || '')) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? t - LAGOS_OFFSET_MS : null;
}

export function listBrands(db) {
  return db.prepare('SELECT id, code, name, active FROM brands ORDER BY id').all().map((b) => ({ ...b }));
}

// 'all' | 'all'-ish -> null (no filter); a known code -> its id; anything else -> 400.
export function resolveBrandId(db, code) {
  if (!code || code === 'all') return null;
  const b = db.prepare('SELECT id FROM brands WHERE code = ?').get(code);
  if (!b) throw new HttpError(400, 'bad_params', `unknown brand "${code}"`);
  return b.id;
}

// Period -> [start, end) in epoch ms on Lagos day boundaries, plus the equally long period before it.
export function periodRange({ period, from, to }, now) {
  const today = lagosDayStart(now);
  let key = period || '7d';
  let start;
  let end;
  if (from || to) {
    const s = dayStartMs(from);
    const e = dayStartMs(to);
    if (s === null || e === null || e < s || (e - s) / DAY_MS > 366) throw new HttpError(400, 'bad_params', 'from/to must be YYYY-MM-DD with from <= to (max 367 days)');
    key = 'custom';
    start = s;
    end = e + DAY_MS;
  } else if (key === 'today') {
    start = today; end = today + DAY_MS;
  } else if (key === '7d') {
    start = today - 6 * DAY_MS; end = today + DAY_MS;
  } else if (key === '30d') {
    start = today - 29 * DAY_MS; end = today + DAY_MS;
  } else {
    throw new HttpError(400, 'bad_params', 'period must be today, 7d or 30d');
  }
  const len = end - start;
  return { key, start, end, prevStart: start - len, prevEnd: start, fromDay: lagosDayLabel(start), toDay: lagosDayLabel(end - DAY_MS) };
}

const escLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const marks = (n) => Array.from({ length: n }, () => '?').join(',');

// ---------- overview ----------

export function lastEventAt(db, brandId) {
  return db.prepare('SELECT MAX(received_at) AS t FROM events WHERE (? IS NULL OR brand_id = ?)').get(brandId, brandId).t;
}

export function hasAnyTraffic(db, brandId) {
  const c = db.prepare('SELECT COUNT(*) AS n FROM clicks WHERE (? IS NULL OR brand_id = ?)').get(brandId, brandId).n;
  const e = db.prepare('SELECT COUNT(*) AS n FROM events WHERE (? IS NULL OR brand_id = ?)').get(brandId, brandId).n;
  return c + e > 0;
}

// Counts and money for one period. Counts of reg/ftd/dep exclude ignored events; revenue is
// matched ftd+dep only, per currency (never summed across currencies). `ftds` counts first deposits in every
// currency; `ftds_usd` is the USD ones, the only count that may be divided into USD spend.
export function funnel(db, { brandId, start, end }) {
  // Clicks = opens of ad links in the period (one row each in click_opens; crawlers excluded).
  const clicks = db.prepare('SELECT COUNT(*) AS n FROM click_opens WHERE (? IS NULL OR brand_id = ?) AND is_bot = 0 AND opened_at >= ? AND opened_at < ?')
    .get(brandId, brandId, start, end).n;
  const mem = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN click_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS ad
       FROM members WHERE (? IS NULL OR brand_id = ?) AND joined_at >= ? AND joined_at < ?`
  ).get(brandId, brandId, start, end);
  const rows = db.prepare(
    `SELECT kind, state, currency, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amt
       FROM events WHERE (? IS NULL OR brand_id = ?) AND received_at >= ? AND received_at < ?
      GROUP BY kind, state, currency`
  ).all(brandId, brandId, start, end);
  const f = {
    clicks, joins: mem.n, ad_joins: mem.ad,
    regs: 0, ftds: 0, ftds_usd: 0, redeps: 0,
    states: { matched: 0, parked: 0, expired: 0, ignored: 0, new: 0 },
    revenue: {}, unattributed: {}
  };
  for (const r of rows) {
    f.states[r.state] = (f.states[r.state] || 0) + r.n;
    if (r.state !== 'ignored') {
      if (r.kind === 'reg') f.regs += r.n;
      else if (r.kind === 'ftd') { f.ftds += r.n; if (r.currency === 'USD') f.ftds_usd += r.n; }
      else if (r.kind === 'dep') f.redeps += r.n;
    }
    if (r.kind === 'ftd' || r.kind === 'dep') {
      if (r.state === 'matched') f.revenue[r.currency] = (f.revenue[r.currency] || 0) + r.amt;
      else if (r.state === 'parked' || r.state === 'expired') f.unattributed[r.currency] = (f.unattributed[r.currency] || 0) + r.amt;
    }
  }
  return f;
}

// Spend entered by hand (Phase 4 adds the form); USD only. rows=0 means nothing was entered.
export function spend(db, { brandId, fromDay, toDay }) {
  const r = db.prepare(
    `SELECT COUNT(*) AS rows, COALESCE(SUM(spend), 0) AS usd FROM costs
      WHERE (? IS NULL OR brand_id = ?) AND currency = 'USD' AND day >= ? AND day <= ?`
  ).get(brandId, brandId, fromDay, toDay);
  return { rows: r.rows, usd: r.usd };
}

export function lastEvents(db, { brandId, limit = 10 }) {
  return db.prepare(
    `SELECT e.event_id, e.kind, e.amount, e.currency, e.trader_id, e.state, e.ignore_reason, e.received_at,
            a.path, m.id AS member_id, m.username, m.telegram_id
       FROM events e
       LEFT JOIN attributions a ON a.event_id = e.event_id
       LEFT JOIN members m ON m.id = e.matched_member_id
      WHERE (? IS NULL OR e.brand_id = ?)
      ORDER BY e.received_at DESC, e.event_id LIMIT ?`
  ).all(brandId, brandId, limit).map((r) => ({ ...r }));
}

// ---------- members ----------

const MEMBER_SORTS = { joined: 'm.joined_at', total: 'COALESCE(agg.total, 0)', last_event: 'agg.last_event_at' };

// One CTE pair: matched events per member, with the path of their most valuable event.
const MEMBER_CTE = `
WITH ev AS (
  SELECT e.matched_member_id AS mid, e.kind, e.amount, e.currency, e.received_at, a.path,
         ROW_NUMBER() OVER (PARTITION BY e.matched_member_id
                            ORDER BY (e.kind IN ('ftd', 'dep')) DESC, e.amount DESC, e.received_at DESC) AS rn
    FROM events e LEFT JOIN attributions a ON a.event_id = e.event_id
   WHERE e.state = 'matched' AND e.matched_member_id IS NOT NULL
), agg AS (
  SELECT mid,
         SUM(CASE WHEN kind = 'ftd' AND currency = 'USD' THEN amount END) AS ftd,
         SUM(CASE WHEN kind = 'dep' AND currency = 'USD' THEN amount END) AS redep,
         SUM(CASE WHEN kind IN ('ftd', 'dep') AND currency = 'USD' THEN amount END) AS total,
         SUM(CASE WHEN kind = 'ftd' THEN 1 ELSE 0 END) AS ftd_count,
         SUM(CASE WHEN kind = 'dep' THEN 1 ELSE 0 END) AS dep_count,
         COUNT(*) AS event_count,
         MAX(received_at) AS last_event_at,
         MAX(CASE WHEN rn = 1 THEN path END) AS path
    FROM ev GROUP BY mid
)`;

function memberWhere(db, o) {
  const where = [];
  const params = [];
  if (o.brandId !== null && o.brandId !== undefined) { where.push('m.brand_id = ?'); params.push(o.brandId); }
  const q = (o.q || '').trim().replace(/^@/, '');
  if (q) {
    const ors = [];
    if (!/^\d+$/.test(q)) {
      // Names and usernames are substring-matched; an all-digit query is an id, never a name
      // (Telegram usernames cannot start with a digit), so it would only add noise.
      const like = `%${escLike(q)}%`;
      ors.push("m.username LIKE ? ESCAPE '\\'", "m.first_name LIKE ? ESCAPE '\\'");
      params.push(like, like);
    } else if (/^\d{1,15}$/.test(q)) {
      ors.push('m.telegram_id = ?'); params.push(Number(q));
      ors.push('EXISTS (SELECT 1 FROM accounts a WHERE a.member_id = m.id AND a.iq_user_id = ?)'); params.push(q);
      // Backfilled members have no accounts row until a postback links one; the bot snapshot knows them.
      const tgs = o.snapshot ? o.snapshot.lookupByTrader(q).map((r) => Number(r.telegram_id)).filter(Number.isSafeInteger) : [];
      if (tgs.length) { ors.push(`m.telegram_id IN (${marks(tgs.length)})`); params.push(...tgs); }
    }
    where.push(ors.length ? `(${ors.join(' OR ')})` : '0');
  }
  if (o.ftd === 'has') where.push('COALESCE(agg.ftd_count, 0) > 0');
  else if (o.ftd === 'no') where.push('COALESCE(agg.ftd_count, 0) = 0');
  if (o.fromMs != null) { where.push('m.joined_at >= ?'); params.push(o.fromMs); }
  if (o.toMs != null) { where.push('m.joined_at < ?'); params.push(o.toMs); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// The member list SELECT, shared by the paged list and the streamed CSV export.
function memberSelect(w, orderBy) {
  return `${MEMBER_CTE}
     SELECT m.id, m.brand_id, m.telegram_id, m.username, m.first_name, m.joined_at, m.join_source, m.click_id,
            c.campaign, c.adset, c.ad,
            (SELECT iq_user_id FROM accounts a WHERE a.member_id = m.id ORDER BY a.id LIMIT 1) AS iq_user_id,
            COALESCE(agg.ftd, 0) AS ftd, COALESCE(agg.redep, 0) AS redep, COALESCE(agg.total, 0) AS total,
            COALESCE(agg.ftd_count, 0) AS ftd_count, COALESCE(agg.dep_count, 0) AS dep_count,
            agg.last_event_at, agg.path
       FROM members m
       LEFT JOIN clicks c ON c.click_id = m.click_id
       LEFT JOIN agg ON agg.mid = m.id
       ${w.sql}
      ${orderBy}`;
}

export function listMembers(db, o) {
  const limit = o.limit || 50;
  const page = o.page || 1;
  const sortKey = MEMBER_SORTS[o.sort] ? o.sort : 'total';
  const dir = o.dir === 'asc' ? 'ASC' : 'DESC';
  const w = memberWhere(db, o);
  const total = db.prepare(`${MEMBER_CTE} SELECT COUNT(*) AS n FROM members m LEFT JOIN agg ON agg.mid = m.id ${w.sql}`).get(...w.params).n;
  const rows = db.prepare(
    `${memberSelect(w, `ORDER BY ${MEMBER_SORTS[sortKey]} ${dir} NULLS LAST, m.joined_at DESC, m.id DESC`)} LIMIT ? OFFSET ?`
  ).all(...w.params, limit, (page - 1) * limit).map((r) => ({ ...r }));

  // Non-USD deposits per listed member, in one query (the list columns are USD only).
  const other = {};
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    for (const r of db.prepare(
      `SELECT matched_member_id AS mid, currency, SUM(amount) AS amt FROM events
        WHERE state = 'matched' AND kind IN ('ftd', 'dep') AND currency <> 'USD' AND matched_member_id IN (${marks(ids.length)})
        GROUP BY matched_member_id, currency`
    ).all(...ids)) (other[r.mid] ||= []).push({ currency: r.currency, amount: r.amt });
  }
  for (const r of rows) r.other_currencies = other[r.id] || [];
  return { rows, total, page, limit, sort: sortKey, dir: dir.toLowerCase() };
}

// Member detail: four queries.
export function memberDetail(db, id) {
  const m = db.prepare(
    `SELECT m.*, b.code AS brand_code, b.name AS brand_name, b.offer_link_tpl,
            c.campaign, c.adset, c.ad, c.creative, c.created_at AS click_created_at, c.clicked_at,
            c.ttclid IS NOT NULL AS has_ttclid, c.fbclid IS NOT NULL AS has_fbclid, c.gclid IS NOT NULL AS has_gclid
       FROM members m JOIN brands b ON b.id = m.brand_id LEFT JOIN clicks c ON c.click_id = m.click_id
      WHERE m.id = ?`
  ).get(id);
  if (!m) return null;
  const accounts = db.prepare('SELECT iq_user_id, source, confidence, linked_at FROM accounts WHERE member_id = ? ORDER BY id').all(id).map((r) => ({ ...r }));
  const value = db.prepare(
    `SELECT currency,
            COALESCE(SUM(CASE WHEN kind = 'ftd' THEN amount END), 0) AS ftd,
            COALESCE(SUM(CASE WHEN kind = 'dep' THEN amount END), 0) AS redep,
            COALESCE(SUM(CASE WHEN kind IN ('ftd', 'dep') THEN amount END), 0) AS total,
            COUNT(*) AS events, MAX(received_at) AS last_event_at
       FROM events WHERE matched_member_id = ? AND state = 'matched' GROUP BY currency`
  ).all(id).map((r) => ({ ...r }));
  const trail = db.prepare(
    `SELECT e.event_id, e.kind, e.amount, e.currency, e.received_at, e.trader_id, a.path, a.confidence, a.note
       FROM events e LEFT JOIN attributions a ON a.event_id = e.event_id
      WHERE e.matched_member_id = ? ORDER BY e.received_at DESC, e.event_id LIMIT 200`
  ).all(id).map((r) => ({ ...r }));
  return { member: { ...m }, accounts, value, trail };
}

// ---------- events ----------

const EVENT_STATES = ['new', 'matched', 'parked', 'expired', 'ignored'];
const EVENT_KINDS = ['reg', 'ftd', 'dep', 'ignored'];

function eventWhere(o) {
  const where = [];
  const params = [];
  if (o.brandId !== null && o.brandId !== undefined) { where.push('e.brand_id = ?'); params.push(o.brandId); }
  if (o.state) {
    if (!EVENT_STATES.includes(o.state)) throw new HttpError(400, 'bad_params', 'unknown state');
    where.push('e.state = ?'); params.push(o.state);
  }
  if (o.kind) {
    if (!EVENT_KINDS.includes(o.kind)) throw new HttpError(400, 'bad_params', 'unknown kind');
    where.push('e.kind = ?'); params.push(o.kind);
  }
  if (o.fromMs != null) { where.push('e.received_at >= ?'); params.push(o.fromMs); }
  if (o.toMs != null) { where.push('e.received_at < ?'); params.push(o.toMs); }
  if (o.memberId) { where.push('e.matched_member_id = ?'); params.push(o.memberId); }
  const q = (o.q || '').trim();
  if (q) {
    where.push("(e.trader_id = ? OR e.aff_track = ? OR e.event_id LIKE ? ESCAPE '\\')");
    params.push(q, q, `${escLike(q)}%`);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listEvents(db, o) {
  const limit = o.limit || 50;
  const page = o.page || 1;
  const w = eventWhere(o);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM events e ${w.sql}`).get(...w.params).n;
  const rows = db.prepare(
    `SELECT e.event_id, e.brand_id, e.status_raw, e.kind, e.trader_id, e.amount, e.currency, e.country, e.click_id, e.aff_track,
            e.received_at, e.state, e.ignore_reason, e.matched_member_id, e.matched_at,
            e.forward_state, e.forward_tries, e.forward_next_at, e.forward_resp, e.payload_json,
            a.path, a.confidence, a.note AS attribution_note,
            m.telegram_id, m.username
       FROM events e
       LEFT JOIN attributions a ON a.event_id = e.event_id
       LEFT JOIN members m ON m.id = e.matched_member_id
       ${w.sql}
      ORDER BY e.received_at DESC, e.event_id
      LIMIT ? OFFSET ?`
  ).all(...w.params, limit, (page - 1) * limit).map((r) => ({ ...r }));

  // attribution_log lines for the whole page in one query.
  const logs = {};
  if (rows.length) {
    const ids = rows.map((r) => r.event_id);
    for (const l of db.prepare(
      `SELECT event_id, candidate, reason, created_at FROM attribution_log WHERE event_id IN (${marks(ids.length)}) ORDER BY id`
    ).all(...ids)) (logs[l.event_id] ||= []).push({ candidate: l.candidate, reason: l.reason, created_at: l.created_at });
  }
  for (const r of rows) r.log = logs[r.event_id] || [];
  return { rows, total, page, limit };
}

export function eventDetail(db, id) {
  const row = db.prepare(
    `SELECT e.*, a.path, a.confidence, a.note AS attribution_note, m.telegram_id, m.username
       FROM events e LEFT JOIN attributions a ON a.event_id = e.event_id LEFT JOIN members m ON m.id = e.matched_member_id
      WHERE e.event_id = ?`
  ).get(id);
  if (!row) return null;
  const log_ = db.prepare('SELECT candidate, reason, created_at FROM attribution_log WHERE event_id = ? ORDER BY id').all(id).map((l) => ({ ...l }));
  return { ...row, log: log_ };
}

// Human reasons for a parked event, from the notes the matcher wrote (docs/06 §4).
export function parkedReasons(ev) {
  const notes = new Set(ev.log.map((l) => l.reason));
  const out = [];
  if (notes.has('afftrack_unknown')) out.push('afftrack_unknown');
  if (notes.has('snapshot_no_member')) out.push('known to the bot, no member here');
  if (notes.has('click_ambiguous')) out.push('click_ambiguous (clickid shared by several members)');
  if (!out.length || notes.has('parked:no_member')) {
    if (ev.trader_id) out.push('no member for trader_id');
    else if (ev.click_id) out.push('no click match');
    else out.push('no identifiers on the postback');
  }
  return [...new Set(out)];
}

// ---------- clicks ----------

export function listClicks(db, o) {
  const limit = o.limit || 50;
  const page = o.page || 1;
  const where = [];
  const params = [];
  if (o.brandId !== null && o.brandId !== undefined) { where.push('c.brand_id = ?'); params.push(o.brandId); }
  if (o.campaign) { where.push('c.campaign = ?'); params.push(o.campaign); }
  // Phase 11: free text — a token prefix, or part of a campaign / ad set / ad name.
  const q = (o.q || '').trim().slice(0, 100);
  if (q) {
    const like = `%${escLike(q)}%`;
    where.push("(c.click_id LIKE ? ESCAPE '\\' OR c.campaign LIKE ? ESCAPE '\\' OR c.adset LIKE ? ESCAPE '\\' OR c.ad LIKE ? ESCAPE '\\')");
    params.push(`${escLike(q.toUpperCase())}%`, like, like, like);
  }
  if (o.fromMs != null) { where.push('c.created_at >= ?'); params.push(o.fromMs); }
  if (o.toMs != null) { where.push('c.created_at < ?'); params.push(o.toMs); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM clicks c ${w}`).get(...params).n;
  const rows = db.prepare(
    `SELECT c.click_id, b.code AS brand, c.campaign, c.adset, c.ad, c.creative,
            c.ttclid IS NOT NULL AS has_ttclid, c.fbclid IS NOT NULL AS has_fbclid, c.gclid IS NOT NULL AS has_gclid,
            c.created_at, c.clicked_at, c.joined_at,
            (SELECT COUNT(*) FROM click_opens o WHERE o.click_id = c.click_id AND o.is_bot = 0) AS opens,
            (SELECT COUNT(*) FROM members m WHERE m.click_id = c.click_id) AS joins
       FROM clicks c JOIN brands b ON b.id = c.brand_id
       ${w}
      ORDER BY COALESCE(c.clicked_at, c.created_at) DESC, c.click_id
      LIMIT ? OFFSET ?`
  ).all(...params, limit, (page - 1) * limit).map((r) => ({ ...r, has_ttclid: !!r.has_ttclid, has_fbclid: !!r.has_fbclid, has_gclid: !!r.has_gclid }));
  return { rows, total, page, limit };
}

// ---------- manual attach (the only write in this phase) ----------

// Members an operator might mean by "123456789" or "@name", within one brand.
export function findMemberCandidates(db, { q, brandId }) {
  const t = (q || '').trim().replace(/^@/, '');
  if (!t) return [];
  const params = [brandId ?? null, brandId ?? null];
  let cond;
  if (/^\d{1,15}$/.test(t)) { cond = 'm.telegram_id = ?'; params.push(Number(t)); }
  else { cond = "m.username = ? COLLATE NOCASE"; params.push(t); }
  return db.prepare(
    `SELECT m.id, m.telegram_id, m.username, m.first_name FROM members m
      WHERE (? IS NULL OR m.brand_id = ?) AND ${cond} ORDER BY m.id LIMIT 5`
  ).all(...params).map((r) => ({ ...r }));
}

// `link: true` also links the event's broker id (trader_id) to the member, as the matcher does on a
// trader_id match, and then re-runs that trader's other parked events: one manual decision resolves them
// all. A broker id that already belongs to another member is refused (409) and nothing changes.
export function attachEvent(deps, { eventId, memberId, note, link = false }) {
  const { db, config } = deps;
  const text = typeof note === 'string' ? note.trim() : '';
  if (!text) throw new HttpError(400, 'bad_params', 'a note is required');
  if (text.length > 500) throw new HttpError(400, 'bad_params', 'note is longer than 500 characters');
  if (!Number.isSafeInteger(memberId) || memberId <= 0) throw new HttpError(400, 'bad_params', 'member_id must be a positive integer');

  const out = withTx(db, () => {
    const ev = db.prepare('SELECT event_id, brand_id, kind, state, forward_state, trader_id FROM events WHERE event_id = ?').get(eventId);
    if (!ev) throw new HttpError(404, 'not_found', 'no such event');
    if (ev.state !== 'parked') throw new HttpError(409, 'not_parked', `event is ${ev.state}; only parked events can be attached`);
    const m = db.prepare('SELECT id, brand_id, telegram_id FROM members WHERE id = ?').get(memberId);
    if (!m) throw new HttpError(422, 'unknown_member', 'no such member');
    if ((ev.brand_id ?? null) !== (m.brand_id ?? null)) throw new HttpError(422, 'brand_mismatch', 'member belongs to another brand');

    const now = deps.now();
    let linked = null;
    if (link) {
      if (!ev.trader_id) throw new HttpError(422, 'no_trader_id', 'this event has no trader_id to link');
      if (linkAccount(db, { memberId: m.id, iqUserId: ev.trader_id, source: 'manual', confidence: 100, now, eventId }) === 'claimed') {
        throw new HttpError(409, 'account_claimed', `broker id ${ev.trader_id} already belongs to another member`);
      }
      linked = ev.trader_id;
    }
    const fwd = ev.forward_state === 'none' ? (config.parallelForward ? 'pending' : 'skipped') : ev.forward_state;
    db.prepare(
      `UPDATE events SET state = 'matched', matched_member_id = ?, matched_at = ?, forward_state = ?,
              forward_next_at = CASE WHEN ? = 'pending' AND forward_state = 'none' THEN ? ELSE forward_next_at END
        WHERE event_id = ?`
    ).run(m.id, now, fwd, fwd, now, eventId);
    db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at, note) VALUES (?, ?, 'manual', 100, ?, ?)")
      .run(eventId, m.id, now, text);
    db.prepare('INSERT INTO attribution_log (event_id, candidate, reason, created_at) VALUES (?, ?, ?, ?)')
      .run(eventId, String(m.telegram_id), `manual_attach: ${text}`, now);
    return { member_id: m.id, forward: fwd, trader: ev.trader_id, brand_id: ev.brand_id, kind: ev.kind, linked };
  });
  log.info('attached', { ev: eventId, member: out.member_id, path: 'manual', linked: out.linked });
  if (out.forward === 'pending' && deps.forwarder) deps.forwarder.schedule(eventId);
  // Phase 10: a manual decision is a conversion like any other, so it is queued for Meta exactly as matchEvent
  // queues a matcher decision. After the commit; a failure here never undoes the attach.
  if (deps.capi) {
    try { deps.capi.enqueueEvent(db, { event_id: eventId, kind: out.kind, brand_id: out.brand_id, state: 'matched' }, deps.now()); } catch (e) { log.error('attach meta enqueue', e); }
  }
  let rematched = 0;
  if (out.linked) {
    const ids = db.prepare("SELECT event_id FROM events WHERE state IN ('new', 'parked') AND trader_id = ? AND brand_id IS ? ORDER BY received_at")
      .all(out.linked, out.brand_id).map((r) => r.event_id);
    for (const id of ids) { const r = matchEvent(deps, id); if (r && r.state === 'matched') rematched++; }
  }
  return { event_id: eventId, member_id: out.member_id, path: 'manual', confidence: 100, linked: out.linked !== null, rematched };
}


// How a member arrived, for display and export: campaign / ad of the bound link, else channel,
// backfill or organic. (The link token is per ad, so this is the ad's context, not the person's.)
export function memberSource(r) {
  if (r.campaign) return `${r.campaign}${r.ad ? ` / ${r.ad}` : ''}`;
  if (r.click_id) return `link ${r.click_id}`;
  const js = r.join_source || '';
  if (js.startsWith('channel')) return 'channel';
  if (js.startsWith('backfill')) return 'backfill';
  return 'organic';
}

// ---------- Phase 4: campaigns ----------

export const NONE_LABEL = '(none)';

// One row per (brand, campaign, adset, ad), plus a `(none)` pseudo-row for everything with no
// campaign. All figures are for the period [start, end) on Lagos day boundaries:
//   clicks  opens of the ad links in the period (click_opens; crawlers and 60 s repeats excluded)
//   joins   members who joined in the period via that link
//   ftds    matched ftd events in the period from those members
//   revenue matched ftd+dep, USD only (other currencies are reported by funnel(), never summed in)
//   spend   USD rows of `costs` whose day falls in the period
// `(none)` carries links with no campaign AND members who never had a link (organic, channel,
// backfill), so that revenue with no campaign stays visible and the totals reconcile with the
// Overview. Parked/expired money has no member, so it is not in any row (see the quality block).
export function campaignPerf(db, { brandId, start, end, fromDay, toDay }) {
  const p = { b: brandId, s: start, e: end, fd: fromDay, td: toDay };
  const raw = db.prepare(
    `WITH kc AS (
       SELECT click_id, brand_id,
              CASE WHEN campaign IS NULL THEN '' ELSE campaign END AS campaign,
              CASE WHEN campaign IS NULL THEN '' ELSE COALESCE(adset, '') END AS adset,
              CASE WHEN campaign IS NULL THEN '' ELSE COALESCE(ad, '') END AS ad
         FROM clicks WHERE ($b IS NULL OR brand_id = $b)
     ), parts AS (
       SELECT kc.brand_id, kc.campaign, kc.adset, kc.ad, 1 AS clicks, 0 AS joins, 0 AS ftds, 0 AS ftds_usd, 0.0 AS revenue, 0.0 AS spend, 0 AS spend_rows
         FROM click_opens o JOIN kc ON kc.click_id = o.click_id WHERE o.is_bot = 0 AND o.opened_at >= $s AND o.opened_at < $e
       UNION ALL
       SELECT kc.brand_id, kc.campaign, kc.adset, kc.ad, 0, 1, 0, 0, 0.0, 0.0, 0
         FROM members m JOIN kc ON kc.click_id = m.click_id WHERE m.joined_at >= $s AND m.joined_at < $e
       UNION ALL
       SELECT m.brand_id, '', '', '', 0, 1, 0, 0, 0.0, 0.0, 0
         FROM members m WHERE m.click_id IS NULL AND ($b IS NULL OR m.brand_id = $b) AND m.joined_at >= $s AND m.joined_at < $e
       UNION ALL
       SELECT kc.brand_id, kc.campaign, kc.adset, kc.ad, 0, 0, CASE WHEN e.kind = 'ftd' THEN 1 ELSE 0 END, CASE WHEN e.kind = 'ftd' AND e.currency = 'USD' THEN 1 ELSE 0 END,
              CASE WHEN e.currency = 'USD' THEN COALESCE(e.amount, 0) ELSE 0 END, 0.0, 0
         FROM events e JOIN members m ON m.id = e.matched_member_id JOIN kc ON kc.click_id = m.click_id
        WHERE e.state = 'matched' AND e.kind IN ('ftd', 'dep') AND e.received_at >= $s AND e.received_at < $e
       UNION ALL
       SELECT m.brand_id, '', '', '', 0, 0, CASE WHEN e.kind = 'ftd' THEN 1 ELSE 0 END, CASE WHEN e.kind = 'ftd' AND e.currency = 'USD' THEN 1 ELSE 0 END,
              CASE WHEN e.currency = 'USD' THEN COALESCE(e.amount, 0) ELSE 0 END, 0.0, 0
         FROM events e JOIN members m ON m.id = e.matched_member_id
        WHERE m.click_id IS NULL AND ($b IS NULL OR m.brand_id = $b)
          AND e.state = 'matched' AND e.kind IN ('ftd', 'dep') AND e.received_at >= $s AND e.received_at < $e
       UNION ALL
       SELECT brand_id, campaign, adset, ad, 0, 0, 0, 0, 0.0, spend, 1
         FROM costs WHERE ($b IS NULL OR brand_id = $b) AND currency = 'USD' AND day >= $fd AND day <= $td
     )
     SELECT brand_id, campaign, adset, ad, SUM(clicks) AS clicks, SUM(joins) AS joins, SUM(ftds) AS ftds, SUM(ftds_usd) AS ftds_usd,
            SUM(revenue) AS revenue, SUM(spend) AS spend, SUM(spend_rows) AS spend_rows
       FROM parts GROUP BY brand_id, campaign, adset, ad`
  ).all(p);

  const brands = Object.fromEntries(listBrands(db).map((b) => [b.id, b.code]));
  const ratios = (r) => ({
    ...r,
    clicks_per_join: r.joins > 0 ? r.clicks / r.joins : null,
    cost_per_ftd: r.spend_rows > 0 && r.ftds_usd > 0 ? r.spend / r.ftds_usd : null, // USD spend over USD first deposits
    roi: r.spend > 0 ? ((r.revenue - r.spend) / r.spend) * 100 : null
  });
  const rows = raw.map((r) => ratios({
    brand_id: r.brand_id, brand: brands[r.brand_id] || String(r.brand_id),
    campaign: r.campaign, adset: r.adset, ad: r.ad, is_none: r.campaign === '',
    clicks: r.clicks, joins: r.joins, ftds: r.ftds, ftds_usd: r.ftds_usd, revenue: r.revenue, spend: r.spend, spend_rows: r.spend_rows
  }));
  // The (none) row is always there, even when empty: missing attribution must stay visible.
  if (!rows.some((r) => r.is_none)) {
    rows.push(ratios({ brand_id: brandId, brand: brandId === null ? 'all' : (brands[brandId] || ''), campaign: '', adset: '', ad: '', is_none: true,
      clicks: 0, joins: 0, ftds: 0, ftds_usd: 0, revenue: 0, spend: 0, spend_rows: 0 }));
  }
  rows.sort((a, b) => (a.is_none - b.is_none) || (b.revenue - a.revenue) || (b.clicks - a.clicks)
    || a.campaign.localeCompare(b.campaign) || a.adset.localeCompare(b.adset) || a.ad.localeCompare(b.ad));

  // Totals: sums of the additive columns, ratios recomputed from the totals (never summed or averaged).
  const t = rows.reduce((a, r) => ({
    clicks: a.clicks + r.clicks, joins: a.joins + r.joins, ftds: a.ftds + r.ftds, ftds_usd: a.ftds_usd + r.ftds_usd,
    revenue: a.revenue + r.revenue, spend: a.spend + r.spend, spend_rows: a.spend_rows + r.spend_rows
  }), { clicks: 0, joins: 0, ftds: 0, ftds_usd: 0, revenue: 0, spend: 0, spend_rows: 0 });
  const totals = ratios({ campaign: 'Total', adset: '', ad: '', brand: '', is_total: true, ...t });

  const ex = db.prepare(
    `SELECT COUNT(*) AS n FROM costs WHERE ($b IS NULL OR brand_id = $b) AND currency <> 'USD' AND day >= $fd AND day <= $td`
  ).get({ b: brandId, fd: fromDay, td: toDay });
  return { rows, totals, excluded_spend_rows: ex.n };
}

// ---------- Phase 4: spend ----------

const SPEND_COLS = 'id, brand_id, day, campaign, adset, ad, spend, currency, note, created_at';

// One row per (brand, day, campaign, adset, ad). Entering a row again REPLACES spend, currency and
// note: it stores what was entered, never a sum (120 twice is 120).
export function upsertSpend(db, r) {
  return { ...db.prepare(
    `INSERT INTO costs (brand_id, day, campaign, adset, ad, spend, currency, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(brand_id, day, campaign, adset, ad)
       DO UPDATE SET spend = excluded.spend, currency = excluded.currency, note = excluded.note
     RETURNING ${SPEND_COLS}`
  ).get(r.brandId, r.day, r.campaign, r.adset, r.ad, r.spend, r.currency, r.note, r.now) };
}

export function listSpend(db, { brandId, fromDay, toDay, limit = 500 }) {
  return db.prepare(
    `SELECT s.id, b.code AS brand, s.day, s.campaign, s.adset, s.ad, s.spend, s.currency, s.note, s.created_at
       FROM costs s JOIN brands b ON b.id = s.brand_id
      WHERE (? IS NULL OR s.brand_id = ?) AND (? IS NULL OR s.day >= ?) AND (? IS NULL OR s.day <= ?)
      ORDER BY s.day DESC, s.id DESC LIMIT ?`
  ).all(brandId, brandId, fromDay ?? null, fromDay ?? null, toDay ?? null, toDay ?? null, limit).map((r) => ({ ...r }));
}

// ---------- Phase 4: streamed exports ----------
// Iterators over the same filters/SELECTs as the screens. Rows are pulled one at a time by the
// caller; nothing is collected here.

export function iterMembers(db, o) {
  const w = memberWhere(db, o);
  return db.prepare(memberSelect(w, 'ORDER BY m.joined_at DESC, m.id DESC')).iterate(...w.params);
}

export function iterEvents(db, o) {
  const w = eventWhere(o);
  // payload_json is deliberately not selected: raw payloads can carry IPs and tokens.
  return db.prepare(
    `SELECT e.event_id, e.kind, e.amount, e.currency, e.trader_id, e.aff_track, e.country, e.received_at,
            e.state, e.ignore_reason, a.path, a.confidence, a.note AS attribution_note, m.telegram_id, m.username
       FROM events e
       LEFT JOIN attributions a ON a.event_id = e.event_id
       LEFT JOIN members m ON m.id = e.matched_member_id
       ${w.sql}
      ORDER BY e.received_at DESC, e.event_id`
  ).iterate(...w.params);
}

// ---------- Phase 11: dashboard v2 ----------

// Counts and USD money per equal time bucket over [start, end), for the Overview chart and the KPI sparklines.
// Same definitions as funnel(): clicks = non-crawler opens, joins = members joined, regs/ftds/redeps = received and
// not ignored, revenue = matched ftd + dep in USD (other currencies are never added in), spend = USD spend by day.
export function series(db, { brandId, start, end, bucketMs }) {
  const n = Math.max(1, Math.ceil((end - start) / bucketMs));
  const zero = () => new Array(n).fill(0);
  const out = { n, start, bucketMs, clicks: zero(), joins: zero(), regs: zero(), ftds: zero(), redeps: zero(), revenue: zero(), spend: zero() };
  const p = { b: brandId ?? null, s: start, e: end, k: bucketMs };
  const at = (i) => (Number.isInteger(i) && i >= 0 && i < n ? i : null);
  for (const r of db.prepare(
    `SELECT CAST((opened_at - $s) / $k AS INTEGER) AS i, COUNT(*) AS n FROM click_opens
      WHERE ($b IS NULL OR brand_id = $b) AND is_bot = 0 AND opened_at >= $s AND opened_at < $e GROUP BY i`
  ).all(p)) { const i = at(r.i); if (i !== null) out.clicks[i] = r.n; }
  for (const r of db.prepare(
    `SELECT CAST((joined_at - $s) / $k AS INTEGER) AS i, COUNT(*) AS n FROM members
      WHERE ($b IS NULL OR brand_id = $b) AND joined_at >= $s AND joined_at < $e GROUP BY i`
  ).all(p)) { const i = at(r.i); if (i !== null) out.joins[i] = r.n; }
  for (const r of db.prepare(
    `SELECT CAST((received_at - $s) / $k AS INTEGER) AS i, kind, state, currency, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amt
       FROM events WHERE ($b IS NULL OR brand_id = $b) AND received_at >= $s AND received_at < $e
      GROUP BY i, kind, state, currency`
  ).all(p)) {
    const i = at(r.i);
    if (i === null) continue;
    if (r.state !== 'ignored') {
      if (r.kind === 'reg') out.regs[i] += r.n;
      else if (r.kind === 'ftd') out.ftds[i] += r.n;
      else if (r.kind === 'dep') out.redeps[i] += r.n;
    }
    if ((r.kind === 'ftd' || r.kind === 'dep') && r.state === 'matched' && r.currency === 'USD') out.revenue[i] += r.amt;
  }
  if (bucketMs % DAY_MS === 0) {
    for (const r of db.prepare(
      `SELECT day, COALESCE(SUM(spend), 0) AS usd FROM costs
        WHERE ($b IS NULL OR brand_id = $b) AND currency = 'USD' AND day >= $fd AND day <= $td GROUP BY day`
    ).all({ b: p.b, fd: lagosDayLabel(start), td: lagosDayLabel(end - 1) })) {
      const s = dayStartMs(r.day);
      const i = s === null ? null : at(Math.floor((s - start) / bucketMs));
      if (i !== null) out.spend[i] += r.usd;
    }
  }
  return out;
}

// Events per state under the same brand / member / search filters as the list, for the tab counts.
export function eventStateCounts(db, o) {
  const w = eventWhere({ ...o, state: '', kind: '' });
  const out = { all: 0, new: 0, matched: 0, parked: 0, expired: 0, ignored: 0 };
  for (const r of db.prepare(`SELECT e.state, COUNT(*) AS n FROM events e ${w.sql} GROUP BY e.state`).all(...w.params)) {
    out[r.state] = (out[r.state] || 0) + r.n;
    out.all += r.n;
  }
  return out;
}

export function parkedCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM events WHERE state = 'parked'").get().n;
}

// The command palette: members, events, links and campaigns matching a free-text query. Exact ids first.
// Returns [{ key, label, icon, items: [{ label, sub, href }] }]. Never more than `limit` per group.
export function searchAll(db, rawQ, { limit = 6, snapshot = null } = {}) {
  const q = String(rawQ || '').trim().slice(0, 100);
  if (!q) return [];
  const bare = q.replace(/^@/, '');
  const like = `%${escLike(bare)}%`;
  const digits = /^\d{1,15}$/.test(bare);
  const groups = [];

  // Members: Telegram id, broker id (accounts or the bot snapshot), username, first name.
  const mWhere = [];
  const mParams = [];
  if (digits) {
    mWhere.push('m.telegram_id = ?'); mParams.push(Number(bare));
    mWhere.push('EXISTS (SELECT 1 FROM accounts a WHERE a.member_id = m.id AND a.iq_user_id = ?)'); mParams.push(bare);
    const tgs = snapshot ? snapshot.lookupByTrader(bare).map((r) => Number(r.telegram_id)).filter(Number.isSafeInteger) : [];
    if (tgs.length) { mWhere.push(`m.telegram_id IN (${marks(tgs.length)})`); mParams.push(...tgs); }
  } else {
    mWhere.push("m.username LIKE ? ESCAPE '\\'", "m.first_name LIKE ? ESCAPE '\\'"); mParams.push(like, like);
  }
  const members = db.prepare(
    `SELECT m.id, m.telegram_id, m.username, m.first_name, b.code AS brand FROM members m JOIN brands b ON b.id = m.brand_id
      WHERE ${mWhere.join(' OR ')} ORDER BY m.joined_at DESC LIMIT ?`
  ).all(...mParams, limit);
  groups.push({ key: 'members', label: 'Members', icon: 'user', items: members.map((m) => ({
    label: m.username ? `@${m.username}` : String(m.telegram_id),
    sub: [m.first_name, String(m.telegram_id), m.brand].filter(Boolean).join(' · '),
    href: `/dash/members/${m.id}`
  })) });

  // Events: event id prefix, trader id, afftrack.
  const events = db.prepare(
    `SELECT event_id, kind, amount, currency, state, trader_id FROM events
      WHERE event_id LIKE ? ESCAPE '\\' OR trader_id = ? OR aff_track = ?
      ORDER BY received_at DESC LIMIT ?`
  ).all(`${escLike(q)}%`, q, q, limit);
  groups.push({ key: 'events', label: 'Events', icon: 'activity', items: events.map((e) => ({
    label: `${e.kind.toUpperCase()}${e.amount !== null && e.kind !== 'reg' ? ` ${e.amount} ${e.currency}` : ''} · ${e.trader_id || e.event_id}`,
    sub: `${e.state} · ${e.event_id}`,
    href: `/dash/events/${encodeURIComponent(e.event_id)}`
  })) });

  // Links: token prefix (tokens are upper-case Crockford base32).
  if (/^[0-9A-Za-z]{3,10}$/.test(q)) {
    const links = db.prepare(
      `SELECT c.click_id, c.campaign, c.adset, c.ad, b.code AS brand FROM clicks c JOIN brands b ON b.id = c.brand_id
        WHERE c.click_id LIKE ? ESCAPE '\\' ORDER BY c.created_at DESC LIMIT ?`
    ).all(`${escLike(q.toUpperCase())}%`, limit);
    groups.push({ key: 'links', label: 'Links', icon: 'link', items: links.map((c) => ({
      label: c.click_id, sub: [c.campaign, c.adset, c.ad].filter(Boolean).join(' / ') || c.brand,
      href: url('/dash/links', { q: c.click_id })
    })) });
  }

  // Campaigns: names that contain the query.
  if (!digits) {
    const camps = db.prepare(
      `SELECT campaign, COUNT(*) AS n FROM clicks WHERE campaign LIKE ? ESCAPE '\\' GROUP BY campaign ORDER BY n DESC LIMIT ?`
    ).all(like, limit);
    groups.push({ key: 'campaigns', label: 'Campaigns', icon: 'layers', items: camps.map((c) => ({
      label: c.campaign, sub: `${c.n} link${c.n === 1 ? '' : 's'}`, href: url('/dash/campaigns', { period: '30d', q: c.campaign })
    })) });
  }
  return groups.filter((g) => g.items.length);
}

function url(path, params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

// Remove one spend row. Returns the row as it was, or null when there is none.
export function deleteSpend(db, id) {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = db.prepare(`SELECT ${SPEND_COLS} FROM costs WHERE id = ?`).get(id);
  if (!row) return null;
  db.prepare('DELETE FROM costs WHERE id = ?').run(id);
  return { ...row };
}
