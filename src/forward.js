import { log } from './log.js';

const TIMEOUT_MS = 5000;

// Parallel run: copy every attributed (or expired) event to Joinvoo. Never affects the stored
// event or its attribution; all failure is bookkeeping on the events row.
export function createForwarder(deps) {
  const { db, config } = deps;
  const inflight = new Set();

  function params(ev) {
    const m = ev.matched_member_id
      ? db.prepare('SELECT telegram_id FROM members WHERE id = ?').get(ev.matched_member_id)
      : null;
    const p = {
      status: ev.kind,
      net: 'affstore',
      // The resolved Telegram id when known, else whatever the network sent. Our own click id
      // is deliberately never sent: Joinvoo's `clickid` field is left untouched.
      afftrack: m ? String(m.telegram_id) : ev.aff_track,
      event_id: ev.event_id,
      trader_id: ev.trader_id,
      amount: ev.amount,
      country_code: ev.country
    };
    const u = new URL(config.joinvooPb);
    for (const [k, v] of Object.entries(p)) if (v !== null && v !== undefined && v !== '') u.searchParams.set(k, String(v));
    return u;
  }

  // Never throws. Returns the new forward_state, or null when nothing was attempted.
  async function attempt(eventId) {
    if (!config.parallelForward || inflight.has(eventId)) return null;
    inflight.add(eventId);
    try {
      const ev = db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId);
      if (!ev || (ev.forward_state !== 'pending' && ev.forward_state !== 'failed')) return null;

      let ok = false;
      let resp;
      try {
        const res = await deps.fetchImpl(params(ev).toString(), { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
        resp = `${res.status} ${(await res.text()).slice(0, 480)}`;
        ok = res.ok;
      } catch (e) {
        resp = `error: ${e && e.message ? e.message : e}`;
      }

      const tries = ev.forward_tries + 1;
      const wait = config.backoffMin[Math.min(tries - 1, config.backoffMin.length - 1)];
      const state = ok ? 'sent' : 'failed';
      db.prepare('UPDATE events SET forward_state = ?, forward_tries = ?, forward_next_at = ?, forward_resp = ? WHERE event_id = ?')
        .run(state, tries, ok ? null : Math.round(deps.now() + wait * 60000), resp.slice(0, 500), eventId);
      log.info('forward', { ev: eventId, state, tries });
      return state;
    } catch (e) {
      log.error('forward', e);
      return null;
    } finally {
      inflight.delete(eventId);
    }
  }

  function schedule(eventId) {
    setImmediate(() => { attempt(eventId); });
  }

  // Worker step: everything due, in chunks so one slow host cannot stall the tick for long.
  async function retryDue(limit = 100) {
    if (!config.parallelForward) return 0;
    const ids = db.prepare(
      `SELECT event_id FROM events
        WHERE forward_state IN ('pending', 'failed') AND COALESCE(forward_next_at, 0) <= ?
        ORDER BY COALESCE(forward_next_at, 0) LIMIT ?`
    ).all(deps.now(), limit).map((r) => r.event_id);
    let n = 0;
    for (let i = 0; i < ids.length; i += 10) {
      const results = await Promise.all(ids.slice(i, i + 10).map(attempt));
      n += results.filter((r) => r !== null).length;
    }
    return n;
  }

  return { attempt, schedule, retryDue };
}
