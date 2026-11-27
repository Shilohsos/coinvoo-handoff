import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

// Crockford base32: no I, L, O, U.
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const TOKEN_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

export const nowMs = () => Date.now();

// 10 random bytes, low 5 bits each (256 % 32 === 0, so the mapping is unbiased).
export function newToken() {
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

// sha256(ip + salt), first 32 hex chars. The raw IP is never stored.
export function ipHash(ip, salt) {
  return createHash('sha256').update(String(ip) + String(salt)).digest('hex').slice(0, 32);
}

function stripMapped(addr) {
  return addr && addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

export function isLoopback(addr) {
  const a = stripMapped(addr || '');
  return a === '127.0.0.1' || a === '::1';
}

// Client IP for hashing. Proxy headers are honoured only when the TCP peer is
// loopback (i.e. Caddy on this host); otherwise the socket peer is the truth.
//
// The site sits behind Cloudflare, so the address Caddy sees — and appends to
// X-Forwarded-For — is a Cloudflare edge node, which differs per request. Keying
// anything on that (sign-in limiter, rate limits, ip_hash) never accumulates.
// CF-Connecting-IP carries the visitor. It is trusted only when the request also
// carries CF-Ray, so a direct hit on the origin cannot forge it.
export function clientIp(req) {
  const peer = stripMapped(req.socket.remoteAddress || '');
  if (!isLoopback(peer)) return peer || null;
  const h = req.headers;
  if (h['cf-ray']) {
    const cf = String(h['cf-connecting-ip'] || '').trim();
    if (isIP(cf)) return stripMapped(cf);
  }
  // Caddy appends the address it saw to X-Forwarded-For, so the LAST entry is the
  // one our own proxy wrote; earlier entries may be client-supplied.
  const xff = String(h['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = xff.length - 1; i >= 0; i--) if (isIP(xff[i])) return stripMapped(xff[i]);
  return peer || null;
}

// Constant-time string compare (hash both sides so length does not leak).
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function basicAuthOk(header, user, pass) {
  const m = /^Basic\s+(.+)$/i.exec(header || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  const u = safeEqual(decoded.slice(0, i), user);
  const p = safeEqual(decoded.slice(i + 1), pass);
  return u && p;
}
