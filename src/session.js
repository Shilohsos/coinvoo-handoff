// Phase 11 — dashboard sessions. A sign-in on /dash/login sets an HttpOnly cookie carrying a random token; the
// database keeps only sha256(token). Basic auth still works everywhere (scripts, bots, the proof scripts).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { isLoopback } from './util.js';

export const SESSION_COOKIE = 'cv_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const TOUCH_EVERY_MS = 10 * 60 * 1000; // last_seen_at is written at most this often, not on every request

const sha = (s) => createHash('sha256').update(s).digest('hex');

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

// Secure only when the request really arrived over TLS (directly, or via Caddy on this host), so signing in over
// an SSH tunnel to http://127.0.0.1 still works.
function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  return isLoopback(req.socket && req.socket.remoteAddress) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

export function createSessionStore(db, { config, now = Date.now, salt }) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('session_secret', ?) ON CONFLICT(key) DO NOTHING").run(randomBytes(32).toString('hex'));
  const secret = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get().value;
  // A fingerprint of the credentials, never the credentials: a password change invalidates every session.
  const credFp = createHmac('sha256', secret).update(`${config.adminUser}\n${config.adminPass}`).digest('hex');

  const find = db.prepare('SELECT id, cred_fp, expires_at, last_seen_at FROM sessions WHERE id = ?');
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');

  function tokenOf(req) {
    const t = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return t && /^[A-Za-z0-9_-]{40,64}$/.test(t) ? t : null;
  }

  // true when the request carries a live session for the current credentials.
  function check(req) {
    const token = tokenOf(req);
    if (!token) return false;
    const id = sha(token);
    const row = find.get(id);
    const t = now();
    if (!row || row.expires_at <= t || row.cred_fp !== credFp) return false;
    if (t - row.last_seen_at > TOUCH_EVERY_MS) { try { touch.run(t, id); } catch { /* best effort */ } }
    return true;
  }

  // Start a session; returns the Set-Cookie header value.
  function create(req) {
    const t = now();
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(t);
    const token = randomBytes(32).toString('base64url');
    const ip = req.socket && req.socket.remoteAddress ? createHash('sha256').update(String(req.socket.remoteAddress) + salt).digest('hex').slice(0, 32) : null;
    const ua = req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 200) : null;
    db.prepare('INSERT INTO sessions (id, cred_fp, created_at, expires_at, last_seen_at, ip_hash, ua) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sha(token), credFp, t, t + SESSION_TTL_MS, t, ip, ua);
    return cookie(req, token, Math.floor(SESSION_TTL_MS / 1000));
  }

  // End this request's session (if any); returns the Set-Cookie header value that clears it.
  function destroy(req) {
    const token = tokenOf(req);
    if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha(token));
    return cookie(req, '', 0);
  }

  // Every other session ends ("sign out everywhere else"). Returns how many were ended.
  function revokeOthers(req) {
    const token = tokenOf(req);
    return db.prepare('DELETE FROM sessions WHERE id <> ?').run(token ? sha(token) : '').changes;
  }

  function count() {
    return db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ? AND cred_fp = ?').get(now(), credFp).n;
  }

  function cookie(req, value, maxAge) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
  }

  return { check, create, destroy, revokeOthers, count, tokenOf };
}
