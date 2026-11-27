// Phase 8 — Meta Conversions API sender (server-side events for dataset META_DATASET_ID).
//
// Rows are queued in meta_sends under a send_id ('join:<brand_id>:<telegram_id>' | 'evt:<event_id>') that is
// also the Meta event_id, so a retry, a re-match or a restart can never produce a second conversion, and Meta
// can deduplicate against the browser pixel. The payload is built at send time from the stored rows; event_time
// is the member's joined_at or the postback's received_at, never "now".
//
// META_CAPI_ENABLED=0: enqueue writes nothing and drain returns at once — no URL is built, no socket opened,
// the token is never read (config.meta.token is null). The token is only ever placed in the request URL here
// and is scrubbed from anything stored or logged.
import { createHash } from 'node:crypto';
import { log } from './log.js';

const GRAPH = 'https://graph.facebook.com';
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
// Meta rejects website/chat events older than 7 days; one such row would fail its whole batch.
export const MAX_EVENT_AGE_S = 7 * 86400;

// C1 — what each queued kind becomes at Meta.
export const META_EVENTS = Object.freeze({
  lead: Object.freeze({ event_name: 'Lead', action_source: 'chat' }),
  registration: Object.freeze({ event_name: 'CompleteRegistration', action_source: 'website' }),
  purchase: Object.freeze({ event_name: 'Purchase', action_source: 'website' }),
  // Meta will not offer Lead on a sales-objective ad set; Subscribe is offered and means the same thing here.
  subscribe: Object.freeze({ event_name: 'Subscribe', action_source: 'website' })
});
// events.kind -> queued kind. Anything else (ignored, unknown) is never queued.
export const KIND_FOR_EVENT = Object.freeze({ reg: 'registration', ftd: 'purchase', dep: 'purchase' });

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// C2 — deterministic, and does not expose the Telegram id.
export function externalId(telegramId) {
  return sha256(`coinvoo:${telegramId}`);
}

// fb.1.<clicks.created_at in ms>.<fbclid>, only for a click that carried an fbclid.
export function fbcFor(click) {
  return click && click.fbclid ? `fb.1.${click.created_at}.${click.fbclid}` : null;
}

// The Meta event_id: the send_id, except that a join's send_id ('join:<brand_id>:<telegram_id>') would hand
// Meta the raw Telegram id, so a join goes out as 'join:<brand_id>:' + the first 32 hex of its external_id.
// Deterministic either way, so a retry or a resend is deduplicated by Meta.
export function metaEventId(row, member) {
  if ((row.kind === 'lead' || row.kind === 'subscribe') && member) {
    const prefix = row.kind === 'lead' ? 'join' : 'join_sub';
    return `${prefix}:${row.send_id.split(':')[1]}:${externalId(member.telegram_id).slice(0, 32)}`;
  }
  return row.send_id;
}

function httpUrl(s) {
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : null;
  } catch {
    return null;
  }
}

// Build the Meta event for one queued row from the current database. Pure apart from the reads.
// Returns { event } or { skip: reason }.
export function buildEvent(db, row, { now, publicBase = null } = {}) {
  const spec = META_EVENTS[row.kind];
  if (!spec) return { skip: 'bad_kind' };
  let member = null;
  let ev = null;
  let timeMs;
  if (row.kind === 'lead' || row.kind === 'subscribe') {
    member = db.prepare('SELECT id, telegram_id, joined_at, click_id FROM members WHERE id = ?').get(Number(row.ref));
    if (!member) return { skip: 'no_member' };
    timeMs = member.joined_at;
  } else {
    ev = db.prepare('SELECT event_id, kind, state, amount, currency, country, received_at, matched_member_id FROM events WHERE event_id = ?').get(row.ref);
    if (!ev) return { skip: 'no_event' };
    if (ev.state !== 'matched') return { skip: 'not_matched' };
    if (ev.matched_member_id) member = db.prepare('SELECT id, telegram_id, joined_at, click_id FROM members WHERE id = ?').get(ev.matched_member_id);
    timeMs = ev.received_at;
  }
  const click = member && member.click_id
    ? db.prepare('SELECT click_id, created_at, fbclid, ua, ip_raw, referer FROM clicks WHERE click_id = ?').get(member.click_id)
    : null;

  const eventTime = Math.floor(timeMs / 1000);
  if (now !== undefined && Math.floor(now / 1000) - eventTime > MAX_EVENT_AGE_S) return { skip: 'too_old' };

  // In this order of preference; keys only when there is a value. ip_hash is never read here.
  const user_data = {};
  if (member) user_data.external_id = externalId(member.telegram_id);
  const fbc = fbcFor(click);
  if (fbc) user_data.fbc = fbc;
  if (click && click.ua) user_data.client_user_agent = click.ua;
  if (click && click.ip_raw) user_data.client_ip_address = click.ip_raw;
  // Meta's spec: country is a lowercase ISO-3166 alpha-2 code, SHA-256 hashed.
  if (ev && typeof ev.country === 'string' && /^[A-Za-z]{2}$/.test(ev.country)) user_data.country = sha256(ev.country.toLowerCase());
  if (Object.keys(user_data).length === 0) return { skip: 'no_user_data' };

  const custom_data = {};
  if (row.kind === 'purchase') {
    if (!(Number(ev.amount) > 0)) return { skip: 'bad_amount' };
    custom_data.value = Number(ev.amount);
    custom_data.currency = /^[A-Z]{3}$/.test(ev.currency || '') ? ev.currency : 'USD';
  }
  // Website events need the browser's user agent at Meta; a member with no bound click has none. The
  // conversion is still real, so it goes out as system_generated — which has no user-agent requirement —
  // rather than being dropped. external_id alone still identifies the person to Meta.
  const actionSource = spec.action_source === 'website' && !user_data.client_user_agent
    ? 'system_generated'
    : spec.action_source;

  const event = { event_name: spec.event_name, event_time: eventTime, event_id: metaEventId(row, member), action_source: actionSource, user_data };
  if (Object.keys(custom_data).length) event.custom_data = custom_data;
  const source = httpUrl(click && click.referer) || (click && publicBase ? `${publicBase}/c/${click.click_id}` : null);
  if (source) event.event_source_url = source;
  return { event };
}

export function createCapi(deps) {
  const { db, config } = deps;
  const cfg = config.meta;
  let busy = false;

  // Remove the token, and any access_token parameter, from text that will be stored or logged.
  function scrub(text) {
    let s = String(text ?? '');
    if (cfg.token) s = s.split(cfg.token).join('[redacted]');
    return s.replace(/access_token=[^&\s"']+/gi, 'access_token=[redacted]');
  }

  const insert = () => db.prepare(
    `INSERT INTO meta_sends (send_id, kind, ref, brand_id, state, tries, created_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?) ON CONFLICT(send_id) DO NOTHING`
  );

  // C5. Disabled = no row at all (no invisible backlog). Return true when a row was added.
  function enqueueJoin(db_, member, now) {
    if (!cfg.enabled) return false;
    const lead = insert().run(`join:${member.brand_id}:${member.telegram_id}`, 'lead', String(member.id), member.brand_id ?? null, now).changes === 1;
    // The same join also goes out as Subscribe, so a sales-objective ad set has an event it will accept.
    const sub = insert().run(`join_sub:${member.brand_id}:${member.telegram_id}`, 'subscribe', String(member.id), member.brand_id ?? null, now).changes === 1;
    return lead || sub;
  }

  function enqueueEvent(db_, event, now) {
    if (!cfg.enabled) return false;
    const kind = KIND_FOR_EVENT[event.kind];
    if (event.state !== 'matched' || !kind) return false;
    return insert().run(`evt:${event.event_id}`, kind, String(event.event_id), event.brand_id ?? null, now).changes === 1;
  }

  function backoffMs(tries) {
    const list = config.backoffMin && config.backoffMin.length ? config.backoffMin : [1, 2, 4, 8, 15, 30, 60];
    return Math.round(list[Math.min(tries - 1, list.length - 1)] * 60000);
  }

  // One POST for a chunk; updates every row in it. Never throws.
  async function post(chunk, out) {
    const body = { data: chunk.map((c) => c.event) };
    if (cfg.testEventCode) body.test_event_code = cfg.testEventCode;
    const url = `${GRAPH}/${cfg.version}/${cfg.datasetId}/events?access_token=${encodeURIComponent(cfg.token)}`;
    let status = 0;
    let text = '';
    let json = null;
    let threw = null;
    try {
      const res = await deps.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs)
      });
      status = res.status;
      text = await res.text();
      try { json = JSON.parse(text); } catch { /* not JSON */ }
    } catch (e) {
      threw = e;
    }
    const now = deps.now();
    const ok = !threw && status === 200 && json && json.events_received === chunk.length;
    const markSent = db.prepare("UPDATE meta_sends SET state = 'sent', sent_at = ?, tries = tries + 1, next_at = NULL, resp = ? WHERE send_id = ?");
    const markRetry = db.prepare('UPDATE meta_sends SET state = ?, tries = ?, next_at = ?, resp = ? WHERE send_id = ?');
    const markFailed = db.prepare("UPDATE meta_sends SET state = 'failed', tries = tries + 1, next_at = NULL, resp = ? WHERE send_id = ?");

    if (ok) {
      const resp = scrub(text).slice(0, 200);
      for (const c of chunk) markSent.run(now, resp, c.row.send_id);
      out.sent += chunk.length;
      return;
    }
    // 429 / 5xx / network failure / a 200 that did not take every event: retry with backoff.
    if (threw || RETRY_STATUS.has(status) || status === 200) {
      const reason = scrub(threw ? `error: ${threw.name === 'TimeoutError' ? 'timeout' : (threw.message || threw)}` : `${status} ${text}`).slice(0, 200);
      for (const c of chunk) {
        const tries = c.row.tries + 1;
        if (tries >= cfg.maxTries) { markRetry.run('failed', tries, null, reason, c.row.send_id); out.failed++; }
        else { markRetry.run('pending', tries, now + backoffMs(tries), reason, c.row.send_id); out.retry++; }
      }
      return;
    }
    // Any other 4xx (or unexpected status): failed now, with Meta's own words.
    const err = json && json.error ? json.error : null;
    const msg = scrub(`${status} ${err ? (err.error_user_msg || err.message || text) : text}`).slice(0, 200);
    for (const c of chunk) markFailed.run(msg, c.row.send_id);
    out.failed += chunk.length;
  }

  // C4. Send up to `limit` due rows, in calls of META_CAPI_BATCH. Never throws; single-flight.
  async function drain(limit = cfg.batch) {
    const out = { sent: 0, failed: 0, retry: 0, skipped: 0 };
    if (!cfg.enabled || busy) return out;
    busy = true;
    try {
      const now = deps.now();
      const rows = db.prepare(
        `SELECT send_id, kind, ref, tries FROM meta_sends
          WHERE state = 'pending' AND (next_at IS NULL OR next_at <= ?)
          ORDER BY created_at, send_id LIMIT ?`
      ).all(now, Math.max(1, Math.floor(limit)));
      const skip = db.prepare("UPDATE meta_sends SET state = 'skipped', resp = ?, next_at = NULL WHERE send_id = ?");
      // Claim each row before sending it, so a second process (scripts/meta-backfill.js --send next to the
      // service) cannot send it too. A claim left by a crash expires after the lease and the row is retried;
      // Meta drops the duplicate by event_id.
      const lease = now + cfg.timeoutMs + 60000;
      const claim = db.prepare("UPDATE meta_sends SET next_at = ? WHERE send_id = ? AND state = 'pending' AND (next_at IS NULL OR next_at <= ?)");
      const ready = [];
      for (const row of rows) {
        if (claim.run(lease, row.send_id, now).changes !== 1) continue;
        let b;
        try { b = buildEvent(db, row, { now, publicBase: config.publicBase }); } catch (e) { log.error('meta build', e); b = { skip: 'build_error' }; }
        if (b.skip) { skip.run(b.skip, row.send_id); out.skipped++; } else ready.push({ row, event: b.event });
      }
      for (let i = 0; i < ready.length; i += cfg.batch) await post(ready.slice(i, i + cfg.batch), out);
    } catch (e) {
      log.error('meta drain', new Error(scrub(e && e.message ? e.message : e)));
    } finally {
      busy = false;
    }
    if (out.sent || out.failed || out.retry || out.skipped) log.info('meta drain', out);
    return out;
  }

  return { enabled: cfg.enabled, enqueueJoin, enqueueEvent, drain, scrub };
}
