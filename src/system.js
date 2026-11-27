// Phase 11 — one read of the service's own state for the System screen and the Overview's "Needs attention" list.
// Counts and states only: never a token, a key, a password or a raw IP.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotHealth } from './botdb.js';
import { ALERTS, getSetting } from './alerts.js';
import { loadReportConfig } from './report.js';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const MIGRATION_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;
const BACKUP_RE = /^coinvoo-\d{4}-\d{2}-\d{2}\.db$/;
const DAY = 86400000;

function newestBackup(dir) {
  try {
    let newest = null;
    let count = 0;
    for (const f of readdirSync(dir)) {
      if (!BACKUP_RE.test(f)) continue;
      count++;
      const st = statSync(join(dir, f));
      if (!newest || st.mtimeMs > newest.mtime) newest = { file: f, mtime: st.mtimeMs, bytes: st.size };
    }
    return { count, newest };
  } catch {
    return { count: 0, newest: null, unreadable: true };
  }
}

export function systemStatus(deps) {
  const { db, config } = deps;
  const now = deps.now();
  const one = (sql, ...p) => db.prepare(sql).get(...p).n;
  const rc = deps.reportConfig || loadReportConfig(process.env, { dbPath: config.dbPath });

  const applied = db.prepare('SELECT name, applied_at FROM schema_migrations ORDER BY name').all();
  const shipped = readdirSync(MIGRATIONS_DIR).filter((f) => MIGRATION_RE.test(f)).sort().map((f) => f.replace(/\.sql$/, ''));
  const appliedSet = new Set(applied.map((r) => r.name));
  let dbBytes = null;
  try { if (config.dbPath !== ':memory:') dbBytes = statSync(config.dbPath).size; } catch { /* unknown */ }

  let snap;
  try { snap = snapshotHealth(deps.snapshot, now, config.snapshotStaleMinutes); } catch { snap = { rows: null, synced_at: null, age_s: null, stale: true, available: false }; }

  const backup = config.backupDir ? newestBackup(config.backupDir) : null;
  const backupError = getSetting(db, 'backup_error');

  const metaCounts = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of db.prepare('SELECT state, COUNT(*) AS n FROM meta_sends WHERE created_at >= ? GROUP BY state').all(now - 7 * DAY)) metaCounts[r.state] = r.n;
  const metaLastFail = db.prepare("SELECT resp, created_at FROM meta_sends WHERE state = 'failed' ORDER BY created_at DESC LIMIT 1").get();
  const metaOldestPending = db.prepare("SELECT MIN(created_at) AS t FROM meta_sends WHERE state = 'pending'").get().t;

  const fwd = { pending: 0, failed: 0, sent: 0 };
  for (const r of db.prepare("SELECT forward_state AS s, COUNT(*) AS n FROM events WHERE forward_state IN ('pending', 'failed', 'sent') AND received_at >= ? GROUP BY forward_state").all(now - 7 * DAY)) fwd[r.s] = r.n;

  const alerts = ALERTS.map((a) => ({ name: a.name, label: a.label, state: getSetting(db, `alert_state_${a.name}`) || 'clear' }));

  const status = {
    now,
    service: { version: config.version, node: process.version, uptime_s: Math.floor((Date.now() - deps.startedAt) / 1000), started_at: deps.startedAt },
    worker: { last_run_at: deps.workerState ? deps.workerState.lastRunAt : null, interval_s: Math.round(config.workerIntervalMs / 1000) },
    db: {
      bytes: dbBytes, latest: applied.length ? applied[applied.length - 1].name : null, applied: applied.length,
      pending: shipped.filter((m) => !appliedSet.has(m)),
      members: one('SELECT COUNT(*) AS n FROM members'), events: one('SELECT COUNT(*) AS n FROM events'),
      clicks: one('SELECT COUNT(*) AS n FROM clicks'), opens: one('SELECT COUNT(*) AS n FROM click_opens WHERE is_bot = 0')
    },
    snapshot: snap,
    backup: { enabled: !!config.backupDir, dir: config.backupDir, keep: config.backupKeep, count: backup ? backup.count : 0,
      newest_at: backup && backup.newest ? backup.newest.mtime : null, newest_bytes: backup && backup.newest ? backup.newest.bytes : null, error: backupError },
    meta: { enabled: !!(config.meta && config.meta.enabled), dataset: config.meta && config.meta.enabled ? config.meta.datasetId : null,
      version: config.meta ? config.meta.version : null, counts: metaCounts, oldest_pending_at: metaOldestPending,
      last_failure: metaLastFail ? { at: metaLastFail.created_at, resp: metaLastFail.resp } : null },
    forward: { enabled: !!config.parallelForward, ...fwd },
    postback: { key_set: !!config.affKey, enforced: !!config.affKeyEnforce, ...(deps.postbackKeyStats || { ok: 0, missing: 0, bad: 0, last_refused_at: null }) },
    join_key_set: !!config.joinKey,
    alerts: { enabled: rc.alertsEnabled, list: alerts },
    report: { enabled: rc.reportEnabled, hour: rc.reportHour, last_day: getSetting(db, 'last_report_day') },
    retention: { payload_days: 365, ip_raw_days: config.ipRawRetentionDays },
    sessions: deps.sessions ? deps.sessions.count() : 0,
    parked: one("SELECT COUNT(*) AS n FROM events WHERE state = 'parked'")
  };
  status.issues = issuesOf(status, config);
  return status;
}

// What deserves the operator's attention, most serious first. level: 'neg' | 'warn' | 'info'.
function issuesOf(s, config) {
  const out = [];
  if (s.db.pending.length) out.push({ level: 'neg', key: 'migrations', title: 'Database migrations pending', text: s.db.pending.join(', '), href: '/dash/system' });
  for (const a of s.alerts.list) if (a.state === 'firing') out.push({ level: 'neg', key: `alert_${a.name}`, title: `Alert firing: ${a.label}`, text: 'Sent to the alert chat. It clears by itself when the condition clears.', href: '/dash/system#alerts' });
  if (s.backup.error) out.push({ level: 'neg', key: 'backup', title: 'Backups are failing', text: s.backup.error.slice(0, 160), href: '/dash/system#backups' });
  if (s.meta.enabled && s.meta.counts.failed) out.push({ level: 'neg', key: 'meta', title: `${s.meta.counts.failed} conversion${s.meta.counts.failed === 1 ? '' : 's'} not accepted by Meta (7 days)`, text: s.meta.last_failure ? s.meta.last_failure.resp || '' : '', href: '/dash/system#meta' });
  if (s.snapshot.stale) out.push({ level: 'warn', key: 'snapshot', title: s.snapshot.available ? 'Bot snapshot is out of date' : 'Bot snapshot unavailable', text: 'Broker-id matching cannot see new accounts until it syncs.', href: '/dash/system#snapshot' });
  if (s.forward.enabled && s.forward.failed) out.push({ level: 'warn', key: 'forward', title: `${s.forward.failed} Joinvoo forward${s.forward.failed === 1 ? '' : 's'} failing`, text: 'Retried with backoff; the event itself is safe.', href: '/dash/system#forward' });
  if (!s.postback.key_set) out.push({ level: 'warn', key: 'aff_key', title: 'Postback URL is open', text: 'Set AFF_KEY so only Affstore can post deposits (docs/07 §4a).', href: '/dash/system#security' });
  else if (!s.postback.enforced) out.push({ level: 'info', key: 'aff_key_rollout', title: 'Postback key in rollout mode', text: 'Keys are counted but not enforced (AFF_KEY_ENFORCE=0).', href: '/dash/system#security' });
  if (s.worker.last_run_at === null && s.service.uptime_s > 3 * (config.workerIntervalMs / 1000) && s.service.uptime_s > 180) out.push({ level: 'warn', key: 'worker', title: 'Worker has not run', text: 'Parked events are not being retried.', href: '/dash/system' });
  return out;
}
