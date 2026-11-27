import { randomUUID } from 'node:crypto';
import { HttpError, sendJson } from '../router.js';
import { log } from '../log.js';
import { withTx } from '../db.js';
import { matchEvent, logRow } from '../matcher.js';
import { TOKEN_RE, clientIp, ipHash, safeEqual } from '../util.js';

// docs/03 §6
export const KIND_MAP = {
  reg: 'reg', registration: 'reg', register: 'reg', signup: 'reg',
  ftd: 'ftd', first_deposit: 'ftd', firstdeposit: 'ftd',
  dep: 'dep', redep: 'dep', deposit: 'dep', repeat_deposit: 'dep', redeposit: 'dep'
};
const SOFT_DUP_MS = 120 * 1000;
const MAX_BODY = 256 * 1024;
// Phase 10: where the postback key may arrive. It is removed from the payload before anything is stored, whether
// or not AFF_KEY is set, so a key never reaches the database, the dashboard's raw view or a log line.
export const KEY_PARAMS = ['key', 'aff_key'];

async function readText(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'request body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// One flat object: query string first, then the body (JSON or form) over it.
async function readPayload(req, url) {
  const flat = {};
  for (const [k, v] of url.searchParams) flat[k] = v;
  if (req.method === 'POST') {
    const raw = await readText(req);
    if (raw.trim()) {
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (ct.includes('json')) {
        let obj;
        try { obj = JSON.parse(raw); } catch { throw new HttpError(400, 'bad_params', 'body is not valid JSON'); }
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new HttpError(400, 'bad_params', 'JSON body must be an object');
        Object.assign(flat, obj);
      } else {
        for (const [k, v] of new URLSearchParams(raw)) flat[k] = v;
      }
    }
  }
  return flat;
}

// Pure: what kind of event is this, and is it one we must refuse to count?
// Order: unmappable status, then the stub guard (docs/03 §4).
export function classify({ status, trader_id, aff_track, click_id, amount }) {
  const kind = KIND_MAP[String(status || '').toLowerCase()];
  if (!kind) return { kind: 'ignored', reason: 'bad_kind' };
  if (!/^\d{5,}$/.test(trader_id || '')) return { kind, reason: 'stub_guard' };
  // Our click tokens are Crockford base32 and can contain the letters TEST; only non-token values count.
  if (/test/i.test(aff_track || '') || (/test/i.test(click_id || '') && !TOKEN_RE.test(click_id))) return { kind, reason: 'stub_guard' };
  if ((kind === 'ftd' || kind === 'dep') && amount !== null && !(Number(amount) > 0)) return { kind, reason: 'stub_guard' };
  return { kind, reason: null };
}

// GET|POST /api/aff — public, high volume. Store raw first, decide second, forward third.
export function postbackRoutes(deps) {
  const { db, config } = deps;
  // Since boot: postbacks whose key matched, carried none, or carried a wrong one (read by /api/aff/health).
  const keyStats = deps.postbackKeyStats || (deps.postbackKeyStats = { ok: 0, missing: 0, bad: 0, last_refused_at: null });
  const keyWarned = new Map();

  // 'ok' | 'missing' | 'bad', or null when no AFF_KEY is configured. Strips every key parameter from `flat`.
  function checkKey(req, flat) {
    const sent = [...KEY_PARAMS.map((k) => flat[k]), req.headers['x-coinvoo-key']].filter((v) => typeof v === 'string' && v !== '');
    for (const k of KEY_PARAMS) delete flat[k];
    if (!config.affKey) return null;
    if (!sent.length) return 'missing';
    // Constant time per candidate, every candidate compared, so timing does not reveal which one matched.
    return sent.map((v) => safeEqual(v, config.affKey)).includes(true) ? 'ok' : 'bad';
  }

  // Per-IP fixed one-second windows (docs/05 §9). In memory: a restart forgets them, which is harmless.
  const windows = new Map();
  const warned = new Map();
  function overLimit(req) {
    if (!config.affRatePerSec) return false;
    const key = clientIp(req) || 'unknown';
    const now = deps.now();
    const sec = Math.floor(now / 1000);
    let w = windows.get(key);
    if (!w || w.sec !== sec) {
      if (windows.size > 5000) for (const [k, v] of windows) if (v.sec < sec) windows.delete(k);
      w = { sec, n: 0 };
      windows.set(key, w);
    }
    w.n++;
    if (w.n <= config.affRatePerSec) return false;
    // One log line per IP per minute, with the IP hashed like everywhere else.
    if (!warned.has(key) || now - warned.get(key) >= 60000) {
      warned.set(key, now);
      if (warned.size > 5000) warned.clear();
      log.info('rate_limited', { route: '/api/aff', ip: ipHash(key, deps.salt).slice(0, 12), limit: config.affRatePerSec });
    }
    return true;
  }

  async function handler({ req, res, url }) {
    if (overLimit(req)) return sendJson(res, 429, { ok: false, error: 'rate_limited', detail: `more than ${config.affRatePerSec} postbacks per second from one address` }, { 'retry-after': '1' });
    const flat = await readPayload(req, url);
    // Trackers that rebuild the target URL from a stored base drop unknown query parameters,
    // so the key can also travel in the path: /api/aff/k/<key>?status=...&trader_id=...
    const pathKey = /^\/api\/aff\/k\/([^/]+)\/?$/.exec(url.pathname || '');
    if (pathKey) {
      try { flat.key = decodeURIComponent(pathKey[1]); } catch { flat.key = pathKey[1]; }
    }
    const key = checkKey(req, flat);
    if (key) keyStats[key]++;
    if (key && key !== 'ok' && config.affKeyEnforce) {
      keyStats.last_refused_at = deps.now();
      const ip = clientIp(req) || 'unknown';
      const t = deps.now();
      if (!keyWarned.has(ip) || t - keyWarned.get(ip) >= 60000) {
        keyWarned.set(ip, t);
        if (keyWarned.size > 5000) keyWarned.clear();
        log.info('postback refused', { reason: `key_${key}`, ip: ipHash(ip, deps.salt).slice(0, 12) });
      }
      return sendJson(res, 401, { ok: false, error: 'unauthorized', detail: 'missing or invalid postback key' });
    }
    if (Object.keys(flat).length === 0) throw new HttpError(400, 'bad_params', 'no parameters');

    const s = (k) => {
      const v = flat[k];
      if (v === undefined || v === null) return null;
      const t = String(v).trim();
      return t === '' ? null : t;
    };

    const statusRaw = s('status') || '';
    const traderId = s('trader_id');
    const affTrack = s('afftrack');
    const clickId = s('clickid') || s('click_id');
    const amountRaw = s('amount');
    const amount = amountRaw === null ? null : (Number.isFinite(Number(amountRaw)) ? Number(amountRaw) : null);
    const cur = (s('currency') || '').toUpperCase();
    const currency = /^[A-Z]{3}$/.test(cur) ? cur : 'USD';
    const eventId = (s('event_id') || randomUUID()).slice(0, 128);
    const brand = db.prepare('SELECT id FROM brands WHERE code = ? AND active = 1').get(config.defaultBrand);
    const now = deps.now();

    let { kind, reason } = classify({ status: statusRaw, trader_id: traderId, aff_track: affTrack, click_id: clickId, amount: amountRaw === null ? null : (amount === null ? NaN : amount) });
    if (!reason && traderId) {
      const dup = db.prepare(
        `SELECT 1 AS x FROM events WHERE trader_id = ? AND kind = ? AND amount IS ? AND event_id <> ?
            AND received_at >= ? AND COALESCE(ignore_reason, '') <> 'duplicate_soft' LIMIT 1`
      ).get(traderId, kind, amount, eventId, now - SOFT_DUP_MS);
      if (dup) reason = 'duplicate_soft';
    }
    const ignored = reason !== null;

    let inserted;
    try {
      inserted = withTx(db, () => {
        const r = db.prepare(
          `INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, country,
                               click_id, aff_track, payload_json, received_at, state, ignore_reason, forward_state)
           VALUES (?, ?, 'affstore', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id) DO NOTHING`
        ).run(eventId, brand ? brand.id : null, statusRaw, kind, traderId, amount, currency, s('country_code') || s('country'),
          clickId, affTrack, JSON.stringify(flat), now, ignored ? 'ignored' : 'new', reason, ignored ? 'skipped' : 'none');
        if (r.changes === 0) return false;
        if (ignored) {
          db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at, note) VALUES (?, NULL, 'none', 0, ?, ?) ON CONFLICT(event_id) DO NOTHING")
            .run(eventId, now, reason);
          logRow(db, eventId, null, `ignored:${reason}`, now);
        }
        return true;
      });
    } catch (e) {
      log.error('POST /api/aff store', e);
      throw new HttpError(500, 'store_failed', 'could not store the event');
    }

    if (!inserted) {
      log.info('duplicate', { ev: eventId });
      return sendJson(res, 200, { ok: true, event_id: eventId, duplicate: true });
    }
    if (ignored) {
      log.info('ignored', { ev: eventId, reason, trader: traderId });
      return sendJson(res, 200, { ok: true, ignored: reason });
    }

    // The raw row is safe. A matcher failure leaves it 'new' for the worker; the network still gets 200.
    let r = null;
    try {
      r = matchEvent(deps, eventId);
    } catch (e) {
      log.error('POST /api/aff match', e);
    }
    if (!r) return sendJson(res, 200, { ok: true, event_id: eventId, duplicate: false, matched: false, path: 'deferred' });
    const body = { ok: true, event_id: eventId, duplicate: false, matched: r.state === 'matched', path: r.path };
    if (r.member_id) body.member_id = r.member_id;
    if (r.state === 'matched') body.confidence = r.confidence;
    sendJson(res, 200, body);
  }

  return [
    ['GET', '/api/aff', handler],
    ['POST', '/api/aff', handler],
    ['GET', '/api/aff/k/:key', handler],
    ['POST', '/api/aff/k/:key', handler]
  ];
}
