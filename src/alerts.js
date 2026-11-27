// Threshold alerts. Each of the eight fires ONCE when its condition becomes true, stays silent while it
// stays true, and sends one "... cleared" message when it clears. The state (`firing` | `clear`) is
// written to settings.alert_state_<name> BEFORE the message goes out, so a restart or a slow send
// cannot produce a second alert. A failed send is logged and not retried (no storms).
import * as Q from './queries.js';
import { sendMessage } from './telegram.js';
import { fmtClock } from './render.js';
import { log } from './log.js';
import { fmtAge } from './botdb.js';

const H = 3600 * 1000;

// ---------- settings (key/value table) ----------

export function getSetting(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Alert state with an in-memory mirror: if the database itself is what is failing (the `health`
// alert), the state must still be remembered long enough not to repeat the message.
function stateAccess(db, mem) {
  return {
    // This process wrote every value it holds, so the mirror is authoritative; a fresh process (a
    // restart) has an empty mirror and reads the persisted state.
    get(name) {
      if (mem.has(name)) return mem.get(name);
      try { return getSetting(db, `alert_state_${name}`) || 'clear'; } catch { return 'clear'; }
    },
    set(name, value) {
      mem.set(name, value);
      try { setSetting(db, `alert_state_${name}`, value); } catch { /* the in-memory mirror holds it */ }
    }
  };
}

// ---------- the eight conditions ----------
// check(ctx) -> { firing: boolean, text: string }. Text is plain text and always names the metric that
// tripped and the threshold it crossed, so calibrating does not need the code (docs/07 §8).

export const ALERTS = [
  {
    name: 'health', label: 'database check',
    check: ({ deps }) => {
      try { deps.db.prepare('SELECT 1').get(); return { firing: false, text: '' }; } catch { return { firing: true, text: 'COINVOO — database check failing (SELECT 1 errored; threshold: any error)' }; }
    }
  },
  {
    // Only while links are being opened: a quiet night with no clicks is not silence.
    name: 'silence', label: 'postback silence',
    check: ({ deps, rc, now }) => {
      const last = deps.db.prepare('SELECT MAX(received_at) AS t FROM events').get().t;
      // People opening ad links (a crawler unfurling a link at 3 a.m. does not count).
      const clicks = deps.db.prepare('SELECT COUNT(*) AS n FROM click_opens WHERE opened_at >= ? AND is_bot = 0').get(now - 24 * H).n;
      const firing = last !== null && clicks > 0 && now - last > rc.silenceHours * H;
      return { firing, text: firing ? `COINVOO — no postbacks for ${Math.floor((now - last) / H)} h (last: ${fmtClock(last)}; threshold ${rc.silenceHours} h)` : '' };
    }
  },
  {
    // parked / (matched + parked + expired) over the last 24 h, as docs/07 §8 defines it. A minimum
    // number of decided events keeps a single parked event on a quiet night from alerting.
    name: 'parked', label: 'unmatched ratio',
    check: ({ deps, rc, now }) => {
      const f = Q.funnel(deps.db, { brandId: null, start: now - 24 * H, end: now + 1 });
      const decided = f.states.matched + f.states.parked + f.states.expired;
      const pct = decided > 0 ? (f.states.parked / decided) * 100 : 0;
      const firing = decided >= rc.parkedMinEvents && pct > rc.parkedPct;
      return { firing, text: firing ? `COINVOO — ${Math.round(pct)}% of events unmatched in the last 24 h (${f.states.parked} of ${decided}; threshold ${rc.parkedPct}%)` : '' };
    }
  },
  {
    // A forward that has been `failed` for more than 15 minutes. The forward starts when the event is
    // matched (or expires), so that moment, not the postback's arrival, is the age that counts.
    name: 'forward', label: 'forward failures',
    check: ({ deps, now }) => {
      const n = deps.db.prepare(
        `SELECT COUNT(*) AS n FROM events e LEFT JOIN attributions a ON a.event_id = e.event_id
          WHERE e.forward_state = 'failed' AND COALESCE(e.matched_at, a.decided_at, e.received_at) < ?`
      ).get(now - 15 * 60000).n;
      return { firing: n > 0, text: n > 0 ? `COINVOO — ${n} postback${n === 1 ? '' : 's'} failing to forward to Joinvoo (threshold: any failed for over 15 min)` : '' };
    }
  },
  {
    // Free space under 10 %, as `df` reports it. Read through the injected probe deps.diskFreePct()
    // (wired to the host in worker.js); without a probe the condition is not evaluated.
    name: 'disk', label: 'disk usage',
    probe: 'diskFreePct',
    check: ({ deps }) => {
      const free = deps.diskFreePct();
      const firing = free < 10;
      return { firing, text: firing ? `COINVOO — disk ${Math.round(100 - free)}% full, ${free.toFixed(1)}% free (threshold: under 10% free)` : '' };
    }
  },
  {
    // RSS above 250 MB continuously for 10 minutes. Read through the injected probe deps.rssMb()
    // (wired to the process RSS in worker.js); without a probe the condition is not evaluated.
    name: 'memory', label: 'memory',
    probe: 'rssMb',
    check: ({ deps, state, now }) => {
      const mb = deps.rssMb();
      if (mb > 250) {
        if (state.memOverSince === null || state.memOverSince === undefined) state.memOverSince = now;
      } else {
        state.memOverSince = null;
      }
      const firing = state.memOverSince !== null && now - state.memOverSince >= 10 * 60000;
      return { firing, text: firing ? `COINVOO — memory ${Math.round(mb)} MB for 10 min (threshold 250 MB)` : '' };
    }
  },
  {
    // The bot snapshot (ops/sync-botdb.sh) older than SNAPSHOT_STALE_MINUTES, or not readable at all.
    // Read through the injected probe deps.snapshotHealth() (wired in worker.js, same numbers as
    // /api/aff/health); without a probe the condition is not evaluated.
    // Phase 7: while it stays stale it is repeated at most once an hour (settings.alert_sent_at_snapshot).
    name: 'snapshot', label: 'bot snapshot',
    probe: 'snapshotHealth',
    repeatMs: 3600 * 1000,
    check: ({ deps }) => {
      const h = deps.snapshotHealth();
      const limit = `threshold ${deps.config.snapshotStaleMinutes} min`;
      if (!h.stale) return { firing: false, text: '' };
      if (!h.available) {
        const last = h.age_s === null ? 'never read' : `last sync ${fmtAge(h.age_s)} ago`;
        return { firing: true, text: `COINVOO — bot snapshot unavailable, ${last} (${limit})` };
      }
      if (h.age_s === null) return { firing: true, text: `COINVOO — bot snapshot has no synced_at (${limit})` };
      return { firing: true, text: `COINVOO — bot snapshot ${fmtAge(h.age_s)} old (${limit})` };
    }
  },
  {
    // The nightly backup (worker.js) could not write: settings.backup_error holds the reason until a
    // backup succeeds or the boot check finds the directory writable again.
    name: 'backup', label: 'backup',
    check: ({ deps }) => {
      const err = getSetting(deps.db, 'backup_error');
      return { firing: !!err, text: err ? `COINVOO — backup failing: ${err.slice(0, 200)} (threshold: any failure)` : '' };
    }
  }
];

// When a repeating alert last went out (ms), persisted like the state so a restart does not re-send early.
function sentAt(db, state, name) {
  state.sent = state.sent || new Map();
  if (state.sent.has(name)) return state.sent.get(name);
  let v = 0;
  try { v = Number(getSetting(db, `alert_sent_at_${name}`)) || 0; } catch { /* the mirror decides */ }
  state.sent.set(name, v);
  return v;
}
function markSent(db, state, name, at) {
  state.sent = state.sent || new Map();
  state.sent.set(name, at || 0);
  try {
    if (at) setSetting(db, `alert_sent_at_${name}`, at);
    else db.prepare('DELETE FROM settings WHERE key = ?').run(`alert_sent_at_${name}`);
  } catch { /* the in-memory mirror holds it */ }
}

// One evaluation pass. Returns the transitions it made: [{ name, to, text, ok }].
// `state` is a plain object the caller keeps between passes (memory-duration tracking, state mirror).
export async function runAlerts(deps, rc, state) {
  if (!rc.alertsEnabled) return [];
  state.mem = state.mem || new Map();
  const st = stateAccess(deps.db, state.mem);
  const now = deps.now();
  const made = [];

  for (const a of ALERTS) {
    // Host conditions are read only through injected probes: no probe, no evaluation, no state change.
    if (a.probe && typeof deps[a.probe] !== 'function') continue;
    let r;
    try {
      r = a.check({ deps, rc, state, now });
    } catch (e) {
      // If the database is failing, `health` reports it and the rest cannot be evaluated.
      log.error(`alert ${a.name}`, e);
      continue;
    }
    const prev = st.get(a.name);
    let to = null;
    let text = null;
    if (r.firing && prev !== 'firing') { to = 'firing'; text = r.text; }
    else if (!r.firing && prev === 'firing') { to = 'clear'; text = `COINVOO — ${a.label} cleared`; }
    else if (r.firing && a.repeatMs && now - sentAt(deps.db, state, a.name) >= a.repeatMs) { to = 'firing'; text = `${r.text} — still firing`; }
    if (!to) continue;

    st.set(a.name, to); // before the send: fire once, whatever the send does
    if (a.repeatMs) markSent(deps.db, state, a.name, to === 'firing' ? now : null);
    const res = await sendMessage({
      token: rc.token, chatId: rc.alertChatId, text, fetchImpl: deps.fetchImpl, apiBase: rc.apiBase,
      timeoutMs: rc.timeoutMs, retryDelayMs: rc.retryDelayMs
    });
    log.info('alert', { name: a.name, state: to, sent: res.ok ? 'ok' : 'failed', message: res.messageId, status: res.status, error: res.ok ? null : res.error });
    made.push({ name: a.name, to, text, ok: res.ok, messageId: res.messageId });
  }
  return made;
}
