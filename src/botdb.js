import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { log, fmt } from './log.js';

const WARN_EVERY_MS = 3600 * 1000;

// 47 min · 3 h 12 min · 2 d 5 h — for the alert text and the Overview strip.
export function fmtAge(s) {
  if (s === null || s === undefined) return 'unknown';
  const m = Math.floor(s / 60);
  if (m < 1) return 'under 1 min';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

// The one definition of "stale" shared by /api/aff/health, /api/health/ready, the snapshot alert and the
// Overview strip. The age is the older of meta.synced_at and the file's mtime (Phase 7: a file that stopped
// being replaced is stale even if its synced_at was written carelessly). A snapshot that cannot be read, or
// has neither, is stale. When the file is gone the age counts from the last values this process saw.
export function snapshotHealth(snapshot, now, staleMinutes) {
  const s = snapshot.status();
  const ages = [s.syncedAt, s.mtime].filter((t) => t !== null && t !== undefined).map((t) => Math.max(0, Math.floor((now - t) / 1000)));
  const ageS = ages.length ? Math.max(...ages) : null;
  const stale = !s.available || ageS === null || ageS > staleMinutes * 60;
  return { rows: s.rows, synced_at: s.syncedAt, age_s: ageS, stale, available: s.available };
}

// Read-only access to botdb-snapshot.db (a copy of the trading bot's user table, refreshed
// every 5 minutes on another host). Never writes. A missing or unreadable file is a miss,
// never an error: the postback must still be stored and parked.
export function createSnapshot({ path, now = Date.now, staleMinutes = 30 }) {
  let db = null;
  let lastSyncedAt = null;
  let lastMtime = null;
  let fileId = null;
  let lastWarnAt = null;

  function warn() {
    const t = now();
    if (lastWarnAt === null || t - lastWarnAt >= WARN_EVERY_MS) {
      lastWarnAt = t;
      console.log(fmt('snapshot unavailable'));
    }
  }

  function close() {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
    db = null;
    fileId = null;
  }

  // One cached connection. If the cron replaces the file (rename), the inode changes and the
  // cached handle would keep reading the old copy forever, so reopen when it does.
  function conn() {
    let st;
    try {
      st = statSync(path);
    } catch {
      close();
      warn();
      return null;
    }
    const id = `${st.dev}:${st.ino}`;
    if (db && id === fileId) return db;
    close();
    try {
      db = new DatabaseSync(path, { readOnly: true });
      fileId = id;
      return db;
    } catch {
      db = null;
      warn();
      return null;
    }
  }

  function all(sql, param) {
    const c = conn();
    if (!c) return [];
    try {
      const stmt = c.prepare(sql);
      return param === undefined ? stmt.all() : stmt.all(param);
    } catch {
      close();
      warn();
      return [];
    }
  }

  function lookupByTrader(iqUserId) {
    return all('SELECT telegram_id, iq_user_id, username, approval_status FROM user_accounts WHERE iq_user_id = ?', String(iqUserId));
  }

  function lookupByTelegram(telegramId) {
    return all('SELECT telegram_id, iq_user_id, username, approval_status FROM user_accounts WHERE telegram_id = ?', Number(telegramId));
  }

  function syncedAt() {
    const rows = all("SELECT value FROM meta WHERE key = 'synced_at'");
    if (!rows.length) return null;
    const t = Date.parse(rows[0].value);
    if (!Number.isFinite(t)) return null;
    lastSyncedAt = t;
    return t;
  }

  // { available, rows, syncedAt } — rows is null when the file cannot be read; syncedAt then falls
  // back to the last value read from it (null if it was never readable in this process).
  function status() {
    const t = syncedAt();
    const c = conn();
    const gone = { available: false, rows: null, syncedAt: lastSyncedAt, mtime: lastMtime };
    if (!c) return gone;
    let rows = null;
    try { rows = c.prepare('SELECT COUNT(*) AS n FROM user_accounts').get().n; } catch { return gone; }
    try { lastMtime = statSync(path).mtimeMs; } catch { return gone; }
    return { available: true, rows, syncedAt: t, mtime: lastMtime };
  }

  // Called once per worker tick.
  function checkFreshness() {
    const t = syncedAt();
    if (t === null) return { available: conn() !== null, ageS: null };
    const ageS = Math.max(0, Math.floor((now() - t) / 1000));
    if (ageS > staleMinutes * 60) log.info('snapshot stale', { age: `${ageS}s` });
    return { available: true, ageS };
  }

  return { lookupByTrader, lookupByTelegram, syncedAt, status, checkFreshness, close };
}
