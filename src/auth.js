import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './router.js';
import { basicAuthOk, clientIp, safeEqual } from './util.js';
import { log } from './log.js';

// Phase 10: failed sign-ins are limited per client address. /dash and /api/* are reachable from the internet
// (behind Caddy), so without this ADMIN_PASS could be guessed at full speed. MAX_FAILS wrong credentials within
// WINDOW_MS block that address for BLOCK_MS, correct credentials included. A missing Authorization header is not a
// failure (a browser's first request never carries one). State is in memory: a restart forgets it.
export const AUTH_MAX_FAILS = 10;
export const AUTH_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_BLOCK_MS = 15 * 60 * 1000;

const guards = new WeakMap();
const sessionStores = new WeakMap();

// Phase 11: the dashboard's sign-in sessions (src/session.js), registered once per app. A request with a live
// session cookie is admin, exactly like one with correct basic auth.
export function useSessions(config, store) {
  sessionStores.set(config, store);
}
export function sessionsFor(config) {
  return sessionStores.get(config) || null;
}

// One guard per config object (one per running app). `now` is replaceable so tests can move the clock.
export function authGuardFor(config) {
  let g = guards.get(config);
  if (g) return g;
  const salt = randomBytes(16).toString('hex'); // log lines carry a hash of the address, never the address
  const seen = new Map(); // ip -> { fails, first, blockedUntil }
  g = {
    now: () => Date.now(),
    blockedFor(ip) {
      const e = seen.get(ip);
      const t = g.now();
      return e && e.blockedUntil > t ? Math.ceil((e.blockedUntil - t) / 1000) : 0;
    },
    fail(ip) {
      const t = g.now();
      if (seen.size > 10000) for (const [k, v] of seen) if (v.blockedUntil <= t && t - v.first > AUTH_WINDOW_MS) seen.delete(k);
      let e = seen.get(ip);
      if (!e || t - e.first > AUTH_WINDOW_MS) { e = { fails: 0, first: t, blockedUntil: 0 }; seen.set(ip, e); }
      e.fails++;
      if (e.fails >= AUTH_MAX_FAILS && e.blockedUntil <= t) {
        e.blockedUntil = t + AUTH_BLOCK_MS;
        log.info('auth_blocked', { ip: createHash('sha256').update(ip + salt).digest('hex').slice(0, 12), fails: e.fails, minutes: AUTH_BLOCK_MS / 60000 });
      }
    },
    success(ip) { seen.delete(ip); },
    reset() { seen.clear(); }
  };
  guards.set(config, g);
  return g;
}

// 'ok' | 'none' (no credentials sent) | 'bad' (wrong credentials, counted) | 'blocked' (address is locked out).
// Never throws, so a public route can use it to decide whether to add private fields.
export function adminAuthState(req, config) {
  const g = authGuardFor(config);
  const ip = clientIp(req) || 'unknown';
  // A live session proves an earlier successful sign-in, so it is honoured even from a blocked address.
  const store = sessionStores.get(config);
  if (store && store.check(req)) return 'ok';
  if (g.blockedFor(ip)) return 'blocked';
  const header = req.headers.authorization;
  if (!header) return 'none';
  if (basicAuthOk(header, config.adminUser, config.adminPass)) { g.success(ip); return 'ok'; }
  g.fail(ip); // the attempt that reaches the limit is still answered as wrong; the block starts with the next one
  return 'bad';
}

// Basic auth (timing-safe, see util.basicAuthOk). The router answers a 401 HttpError with
// `WWW-Authenticate: Basic realm="coinvoo"`, and a 429 with `Retry-After`.
// The sign-in form's check: the same limiter as basic auth. 'ok' | 'bad' | 'blocked'.
export function checkPassword(req, config, user, pass) {
  const g = authGuardFor(config);
  const ip = clientIp(req) || 'unknown';
  if (g.blockedFor(ip)) return 'blocked';
  const ok = safeEqual(String(user || ''), config.adminUser) & safeEqual(String(pass || ''), config.adminPass);
  if (ok) { g.success(ip); return 'ok'; }
  g.fail(ip);
  return 'bad';
}

export function requireAdmin(req, config) {
  const state = adminAuthState(req, config);
  if (state === 'ok') return;
  if (state === 'blocked') {
    const s = authGuardFor(config).blockedFor(clientIp(req) || 'unknown');
    throw new HttpError(429, 'too_many_attempts', 'too many failed sign-ins from this address; try again later', { 'retry-after': String(Math.max(1, s)) });
  }
  throw new HttpError(401, 'unauthorized', 'basic auth required');
}

// Browsers attach cached Basic credentials to cross-site form posts, so every state-changing
// admin request must also come from this site. `Sec-Fetch-Site` is authoritative where sent;
// otherwise `Origin` must match the Host. Clients that send neither (curl, scripts) pass.
export function requireSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) {
    if (site === 'same-origin' || site === 'none') return;
    throw new HttpError(403, 'cross_site', 'cross-site request refused');
  }
  const origin = req.headers.origin;
  if (!origin) return;
  let host = null;
  try { host = new URL(origin).host; } catch { /* "null" or malformed */ }
  const allowed = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean);
  if (!host || !allowed.includes(host)) throw new HttpError(403, 'cross_site', 'cross-site request refused');
}
