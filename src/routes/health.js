import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sendJson } from '../router.js';
import { nowMs } from '../util.js';
import { snapshotHealth } from '../botdb.js';
import { adminAuthState } from '../auth.js';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
const MIGRATION_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;
const BACKUP_RE = /^coinvoo-\d{4}-\d{2}-\d{2}\.db$/;

// The migrations shipped with this build, by name (read once: they only change with a deploy).
let shipped = null;
function shippedMigrations() {
  if (!shipped) shipped = readdirSync(MIGRATIONS_DIR).filter((f) => MIGRATION_RE.test(f)).sort().map((f) => f.replace(/\.sql$/, ''));
  return shipped;
}

// GET /api/aff/health and /api/aff/stats — public, counters only, no PII. Money is not a public counter: the
// revenue block of /api/aff/stats is added only for a caller with admin credentials (Phase 10).
export function healthRoutes(deps) {
  const { db, config, startedAt, workerState, snapshot, now = nowMs } = deps;
  // { rows, synced_at, age_s, stale } — stale above SNAPSHOT_STALE_MINUTES, or when the file cannot be read.
  function snapshotField() {
    if (!snapshot) return null;
    try {
      const h = snapshotHealth(snapshot, now(), config.snapshotStaleMinutes);
      return { rows: h.rows, synced_at: h.synced_at, age_s: h.age_s, stale: h.stale };
    } catch {
      return { rows: null, synced_at: null, age_s: null, stale: true };
    }
  }

  // Seconds since the newest nightly backup (file mtime); null when there is none or backups are off.
  function backupAgeS() {
    if (!config.backupDir) return null;
    try {
      let newest = null;
      for (const f of readdirSync(config.backupDir)) {
        if (!BACKUP_RE.test(f)) continue;
        const t = statSync(join(config.backupDir, f)).mtimeMs;
        if (newest === null || t > newest) newest = t;
      }
      return newest === null ? null : Math.max(0, Math.floor((now() - newest) / 1000));
    } catch {
      return null;
    }
  }

  function health({ res }) {
    try {
      db.prepare('SELECT 1').get();
    } catch {
      return sendJson(res, 503, { ok: false, db: 'fail' });
    }
    const snap = snapshotField();
    sendJson(res, 200, {
      ok: true,
      service: 'coinvoo',
      version: config.version,
      db: 'ok',
      uptime_s: Math.floor((nowMs() - startedAt) / 1000),
      last_event_at: db.prepare('SELECT MAX(received_at) AS t FROM events').get().t,
      worker_last_run_at: workerState ? workerState.lastRunAt : null,
      snapshot: snap,
      snapshot_age_s: snap ? snap.age_s : null,
      snapshot_stale: snap ? snap.stale : true,
      backup_enabled: !!config.backupDir,
      backup_age_s: backupAgeS(),
      // Phase 10: whether postbacks must carry AFF_KEY, and how the ones since boot fared (counts only).
      postback_key: {
        set: !!config.affKey,
        enforced: !!config.affKeyEnforce,
        ...(deps.postbackKeyStats || { ok: 0, missing: 0, bad: 0, last_refused_at: null })
      }
    });
  }

  function stats({ req, res }) {
    const since = nowMs() - 24 * 3600 * 1000;
    const one = (sql, ...p) => db.prepare(sql).get(...p).n;
    sendJson(res, 200, {
      ok: true,
      period: '24h',
      links: {
        total: one('SELECT COUNT(*) AS n FROM clicks'),
        opened: one('SELECT COUNT(*) AS n FROM clicks WHERE clicked_at IS NOT NULL'),
        opened_24h: one('SELECT COUNT(*) AS n FROM clicks WHERE clicked_at >= ?', since),
        opens_24h: one('SELECT COUNT(*) AS n FROM click_opens WHERE opened_at >= ? AND is_bot = 0', since)
      },
      members: {
        total: one('SELECT COUNT(*) AS n FROM members'),
        joined_24h: one('SELECT COUNT(*) AS n FROM members WHERE joined_at >= ?', since),
        with_click: one('SELECT COUNT(*) AS n FROM members WHERE click_id IS NOT NULL')
      },
      // Ignored events (stub guard, duplicates, unknown status) stay in `total` and `ignored`
      // but are excluded from the per-kind counts and from all revenue.
      events: {
        total: one('SELECT COUNT(*) AS n FROM events WHERE received_at >= ?', since),
        reg: one("SELECT COUNT(*) AS n FROM events WHERE received_at >= ? AND state <> 'ignored' AND kind = 'reg'", since),
        ftd: one("SELECT COUNT(*) AS n FROM events WHERE received_at >= ? AND state <> 'ignored' AND kind = 'ftd'", since),
        dep: one("SELECT COUNT(*) AS n FROM events WHERE received_at >= ? AND state <> 'ignored' AND kind = 'dep'", since),
        matched: one("SELECT COUNT(*) AS n FROM events WHERE received_at >= ? AND state = 'matched'", since),
        parked: one("SELECT COUNT(*) AS n FROM events WHERE received_at >= ? AND state = 'parked'", since),
        expired: one("SELECT COUNT(*) AS n FROM events WHERE received_at >= ? AND state = 'expired'", since),
        ignored: one("SELECT COUNT(*) AS n FROM events WHERE received_at >= ? AND state = 'ignored'", since)
      },
      forward: {
        sent: one("SELECT COUNT(*) AS n FROM events WHERE received_at >= ? AND forward_state = 'sent'", since),
        pending: one("SELECT COUNT(*) AS n FROM events WHERE received_at >= ? AND forward_state = 'pending'", since),
        failed: one("SELECT COUNT(*) AS n FROM events WHERE received_at >= ? AND forward_state = 'failed'", since)
      },
      // Money only for an authenticated caller; an anonymous one gets the counters above.
      ...(adminAuthState(req, config) === 'ok' ? {
        revenue: {
          matched_usd: one("SELECT COALESCE(SUM(amount), 0) AS n FROM events WHERE received_at >= ? AND state = 'matched' AND kind IN ('ftd', 'dep') AND currency = 'USD'", since),
          unattributed_usd: one("SELECT COALESCE(SUM(amount), 0) AS n FROM events WHERE received_at >= ? AND state IN ('parked', 'expired') AND kind IN ('ftd', 'dep') AND currency = 'USD'", since)
        }
      } : {})
    });
  }

  // GET /api/health/ready — the go/no-go before paid traffic. ok is false when the database check fails, a
  // shipped migration is not applied, or the bot snapshot is unreadable or older than 3x SNAPSHOT_STALE_MIN.
  // 200 when ok, 503 when not, so an uptime check can read the status alone.
  function ready({ res }) {
    const out = { ok: false, db: 'fail', migrations: null, join_key_set: !!config.joinKey, aff_key_set: !!config.affKey, aff_key_enforced: !!config.affKeyEnforce };
    let dbOk = false;
    try { db.prepare('SELECT 1').get(); dbOk = true; out.db = 'ok'; } catch { /* reported as fail */ }
    let migrationsOk = false;
    let clickTracking = 'fail';
    let lastEventAgeS = null;
    if (dbOk) {
      try {
        const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
        const want = shippedMigrations();
        const missing = want.filter((m) => !applied.has(m));
        migrationsOk = missing.length === 0;
        out.migrations = migrationsOk ? want[want.length - 1] : `missing:${missing.join(',')}`;
      } catch { out.migrations = 'unreadable'; }
      try { db.prepare('SELECT COUNT(*) AS n FROM click_opens').get(); clickTracking = 'ok'; } catch { clickTracking = 'no_click_opens_table'; }
      try {
        const t = db.prepare('SELECT MAX(received_at) AS t FROM events').get().t;
        lastEventAgeS = t === null ? null : Math.max(0, Math.floor((now() - t) / 1000));
      } catch { /* null */ }
    }
    const snap = snapshotField();
    const limitS = config.snapshotStaleMinutes * 60 * 3;
    const snapshotOk = !!snap && snap.rows !== null && snap.age_s !== null && snap.age_s <= limitS;
    Object.assign(out, {
      snapshot_age_s: snap ? snap.age_s : null,
      snapshot_stale: snap ? snap.stale : true,
      backup_enabled: !!config.backupDir,
      backup_age_s: backupAgeS(),
      last_event_age_s: lastEventAgeS,
      click_tracking: clickTracking
    });
    out.ok = dbOk && migrationsOk && snapshotOk;
    if (!out.ok) {
      out.reasons = [!dbOk && 'db', dbOk && !migrationsOk && 'migrations',
        !snapshotOk && `snapshot ${snap && snap.rows === null ? 'unreadable' : `older than ${limitS} s`}`].filter(Boolean);
    }
    sendJson(res, out.ok ? 200 : 503, out);
  }

  return [
    ['GET', '/api/health/ready', ready],
    ['GET', '/api/aff/health', health],
    ['GET', '/api/aff/stats', stats]
  ];
}
