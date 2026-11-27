import { statfsSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync, accessSync, renameSync, rmSync, constants as FS } from 'node:fs';
import * as sqlite from 'node:sqlite';
import { join } from 'node:path';
import { withTx } from './db.js';
import { log } from './log.js';
import { matchEvent, logRow } from './matcher.js';
import { loadReportConfig, scheduleReport } from './report.js';
import { runAlerts, getSetting, setSetting } from './alerts.js';
import { snapshotHealth } from './botdb.js';

const DAY_MS = 86400000;
const LAGOS_OFFSET_MS = 3600000; // Africa/Lagos is UTC+1 all year (no DST)

export function lagosDayStart(ms) {
  return Math.floor((ms + LAGOS_OFFSET_MS) / DAY_MS) * DAY_MS - LAGOS_OFFSET_MS;
}
export function lagosDayLabel(startMs) {
  return new Date(startMs + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

// Free space as `df` prints it: available / (used + available). Reserved blocks are neither, so
// `bavail / blocks` would understate it. Pure, so the arithmetic is testable without a host.
export function dfFreePct(s) {
  const used = s.blocks - s.bfree;
  const denom = used + s.bavail;
  return denom > 0 ? (s.bavail / denom) * 100 : 100;
}

// The production probes behind the disk and memory alerts (alerts.js only ever calls these).
export function hostProbes(diskPath) {
  return {
    diskFreePct: () => dfFreePct(statfsSync(diskPath)),
    rssMb: () => process.memoryUsage().rss / (1024 * 1024)
  };
}

// events.payload_json is NOT NULL, so "pruned" is this marker rather than a NULL.
export const PRUNED_PAYLOAD = '{"pruned":true}';
const PRUNE_AFTER_MS = 365 * DAY_MS;

// Single-flight 60 s tick: expire -> re-run parked -> retry forwards -> roll up, then (Phase 5) the daily
// maintenance, the report schedule and the alert pass. The last two send over the network, so they run in
// the background behind their own in-flight guards and never hold the tick up.
export function createWorker(deps) {
  const { db, config } = deps;
  let busy = false;
  let timer = null;

  // REPORT_BOT_TOKEN / REPORT_CHAT_ID / ALERT_CHAT_ID are optional: without them the report and the
  // alerts do nothing. Read once, here, like the rest of the configuration.
  const rc = deps.reportConfig || (deps.reportConfig = loadReportConfig(process.env, { dbPath: config.dbPath }));
  // Real host readings for the disk and memory alerts, unless the caller injected its own (tests do).
  const probes = hostProbes(rc.diskPath);
  if (typeof deps.diskFreePct !== 'function') deps.diskFreePct = probes.diskFreePct;
  if (typeof deps.rssMb !== 'function') deps.rssMb = probes.rssMb;
  // The snapshot alert reads the same numbers as /api/aff/health.
  if (typeof deps.snapshotHealth !== 'function') deps.snapshotHealth = () => snapshotHealth(deps.snapshot, deps.now(), config.snapshotStaleMinutes);
  const reportState = { inflight: false };
  const alertState = { mem: new Map(), memOverSince: null, inflight: false };
  const background = new Set();
  const lastMaintenance = { day: null, pruned: 0, rolled_up: 0 };

  function track(promise) {
    background.add(promise);
    promise.finally(() => background.delete(promise));
  }

  function expireParked() {
    const cutoff = deps.now() - config.parkHours * 3600 * 1000;
    const rows = db.prepare("SELECT event_id, trader_id FROM events WHERE state IN ('new', 'parked') AND received_at < ?").all(cutoff);
    for (const r of rows) {
      withTx(db, () => {
        const now = deps.now();
        db.prepare(
          `UPDATE events SET state = 'expired',
                  forward_state = CASE WHEN forward_state = 'none' THEN ? ELSE forward_state END,
                  forward_next_at = CASE WHEN forward_state = 'none' THEN ? ELSE forward_next_at END
            WHERE event_id = ?`
        ).run(config.parallelForward ? 'pending' : 'skipped', now, r.event_id);
        db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at, note) VALUES (?, NULL, 'none', 0, ?, 'expired') ON CONFLICT(event_id) DO NOTHING")
          .run(r.event_id, now);
        logRow(db, r.event_id, null, 'expired', now);
      });
      log.info('expired', { ev: r.event_id, trader: r.trader_id });
    }
    return rows.length;
  }

  function rematchParked() {
    const since = deps.now() - config.parkHours * 3600 * 1000;
    const ids = db.prepare("SELECT event_id FROM events WHERE state IN ('new', 'parked') AND received_at >= ? ORDER BY received_at DESC LIMIT 200")
      .all(since).map((r) => r.event_id);
    let matched = 0;
    for (const id of ids) {
      try {
        const r = matchEvent(deps, id);
        if (r && r.state === 'matched') matched++;
      } catch (e) {
        log.error('worker.rematch', e);
      }
    }
    return matched;
  }

  // Rebuild one Lagos day. Counts exclude ignored events; revenue is matched ftd+dep, USD only.
  function rollupDay(startMs) {
    const day = lagosDayLabel(startMs);
    const end = startMs + DAY_MS;
    return withTx(db, () => {
      db.prepare('DELETE FROM daily_rollup WHERE day = ?').run(day);
      const r = db.prepare(
        `INSERT INTO daily_rollup (brand_id, day, clicks, joins, regs, ftds, redeps, revenue, spend)
         SELECT b.id, ?,
           (SELECT COUNT(*) FROM click_opens o WHERE o.brand_id = b.id AND o.is_bot = 0 AND o.opened_at >= ? AND o.opened_at < ?),
           (SELECT COUNT(*) FROM members m WHERE m.brand_id = b.id AND m.joined_at >= ? AND m.joined_at < ?),
           (SELECT COUNT(*) FROM events e WHERE e.brand_id = b.id AND e.kind = 'reg' AND e.state <> 'ignored' AND e.received_at >= ? AND e.received_at < ?),
           (SELECT COUNT(*) FROM events e WHERE e.brand_id = b.id AND e.kind = 'ftd' AND e.state <> 'ignored' AND e.received_at >= ? AND e.received_at < ?),
           (SELECT COUNT(*) FROM events e WHERE e.brand_id = b.id AND e.kind = 'dep' AND e.state <> 'ignored' AND e.received_at >= ? AND e.received_at < ?),
           (SELECT COALESCE(SUM(e.amount), 0) FROM events e WHERE e.brand_id = b.id AND e.state = 'matched' AND e.kind IN ('ftd', 'dep') AND e.currency = 'USD' AND e.received_at >= ? AND e.received_at < ?),
           (SELECT COALESCE(SUM(k.spend), 0) FROM costs k WHERE k.brand_id = b.id AND k.day = ? AND k.currency = 'USD')
         FROM brands b WHERE b.active = 1`
      ).run(day, startMs, end, startMs, end, startMs, end, startMs, end, startMs, end, startMs, end, day);
      return r.changes;
    });
  }

  // Once a day, on the first tick after 03:00 Africa/Lagos: blank payloads older than 365 days (the row, its
  // amount and its attribution stay) and rebuild the last 7 days of daily_rollup in case a tick was missed.
  // The day is recorded BEFORE the work, so a restart does not repeat it.
  function maintain() {
    const now = deps.now();
    if (new Date(now + LAGOS_OFFSET_MS).getUTCHours() < 3) return null;
    const todayStart = lagosDayStart(now);
    const today = lagosDayLabel(todayStart);
    if (getSetting(db, 'last_maintenance_day') === today) return null;
    setSetting(db, 'last_maintenance_day', today);
    const pruned = db.prepare('UPDATE events SET payload_json = ? WHERE received_at < ? AND payload_json <> ?')
      .run(PRUNED_PAYLOAD, now - PRUNE_AFTER_MS, PRUNED_PAYLOAD).changes;
    // Phase 10: the raw client IP exists only for Meta matching. Past IP_RAW_RETENTION_DAYS (from the click's last
    // open) it is blanked; ip_hash stays, so nothing on the dashboard changes. 0 keeps it forever.
    const ipBlanked = config.ipRawRetentionDays > 0
      ? db.prepare('UPDATE clicks SET ip_raw = NULL WHERE ip_raw IS NOT NULL AND COALESCE(clicked_at, created_at) < ?')
        .run(now - config.ipRawRetentionDays * DAY_MS).changes
      : 0;
    let rolled = 0;
    for (let i = 1; i <= 7; i++) rolled += rollupDay(todayStart - i * DAY_MS);
    Object.assign(lastMaintenance, { day: today, pruned, ip_raw_blanked: ipBlanked, rolled_up: rolled });
    log.info('maintenance', { day: today, pruned_payloads: pruned, ip_raw_blanked: ipBlanked, rolled_up: rolled });
    lastMaintenance.backup = { pending: true };
    track(backup(today).then((r) => { lastMaintenance.backup = r; }));
    return { pruned, ip_raw_blanked: ipBlanked, rolled_up: rolled };
  }

  // The backup's failure state lives in settings.backup_error, which the `backup` alert reads. It is set by a
  // failed backup or a failed boot check and cleared by a successful one of either.
  function backupFailed(e) {
    log.error('backup', e);
    const msg = e.code && !String(e.message).startsWith(e.code) ? `${e.code} ${e.message}` : String(e.message);
    try { setSetting(db, 'backup_error', msg.replace(/\s+/g, ' ').trim()); } catch { /* db failing: the health alert says so */ }
  }
  function backupOk() {
    try { db.prepare("DELETE FROM settings WHERE key = 'backup_error'").run(); } catch { /* as above */ }
  }

  // Create the directory if it is missing and prove it is writable. Run at boot so a bad BACKUP_DIR is
  // reported within a minute, not at 03:00.
  function checkBackupDir() {
    if (!config.backupDir) return null;
    try {
      mkdirSync(config.backupDir, { recursive: true });
      accessSync(config.backupDir, FS.W_OK);
      backupOk();
      return true;
    } catch (e) {
      backupFailed(e);
      return false;
    }
  }

  // Nightly copy of the database (docs/07 §6). SQLite's online backup API (the same as the sqlite3 shell's
  // `.backup`) copies a consistent snapshot page by page while the service keeps writing; it is never a file
  // copy. It is written to a `.part` name, switched to a single self-contained file (journal_mode=DELETE),
  // checked, and only then renamed into place. Only files named coinvoo-YYYY-MM-DD.db are counted and pruned
  // to the newest BACKUP_KEEP; anything else in the directory is left alone. Never throws.
  async function backup(day) {
    if (!config.backupDir) return null;
    const name = `coinvoo-${day}.db`;
    const file = join(config.backupDir, name);
    const part = `${file}.part`;
    try {
      mkdirSync(config.backupDir, { recursive: true });
      accessSync(config.backupDir, FS.W_OK);
      if (existsSync(file)) {
        log.info('backup skipped', { file: name, reason: 'exists' });
      } else {
        rmSync(part, { force: true });
        if (typeof sqlite.backup === 'function') await sqlite.backup(db, part);
        else db.prepare('VACUUM INTO ?').run(part); // Node < 22.16: also online and consistent
        const copy = new sqlite.DatabaseSync(part);
        try {
          copy.exec('PRAGMA journal_mode = DELETE');
          const check = copy.prepare('PRAGMA quick_check').get().quick_check;
          if (check !== 'ok') throw new Error(`backup copy failed quick_check: ${check}`);
        } finally { copy.close(); }
        renameSync(part, file);
      }
      const ours = readdirSync(config.backupDir).filter((f) => /^coinvoo-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse();
      const old = ours.slice(config.backupKeep);
      for (const f of old) unlinkSync(join(config.backupDir, f));
      const bytes = statSync(file).size;
      log.info('backup', { file: name, bytes, kept: ours.length - old.length, removed: old.length });
      backupOk();
      return { file, bytes, removed: old.length };
    } catch (e) {
      try { rmSync(part, { force: true }); } catch { /* best effort */ }
      backupFailed(e);
      return { error: e.message };
    }
  }

  async function tick() {
    if (busy) return null;
    busy = true;
    const t0 = Date.now();
    let summary = null;
    try {
      deps.snapshot.checkFreshness();
      const expired = expireParked();
      const rematched = rematchParked();
      const forwards = await deps.forwarder.retryDue(100);
      // Phase 8: one Meta batch per tick; drain never throws and is a no-op when disabled.
      const meta = deps.capi && config.meta && config.meta.enabled ? await deps.capi.drain(config.meta.batch) : null;
      const today = lagosDayStart(deps.now());
      const rolledUp = rollupDay(today) + rollupDay(today - DAY_MS);
      const parked = db.prepare("SELECT COUNT(*) AS n FROM events WHERE state = 'parked'").get().n;
      summary = { parked, rematched, expired, forwards, meta: meta ? meta.sent : 'off', rolled_up: rolledUp };
      log.info('worker tick', { ...summary, took: `${Date.now() - t0}ms` });
    } catch (e) {
      log.error('worker', e);
    }
    try {
      maintain();
      track(scheduleReport(deps, rc, reportState).catch((e) => log.error('report', e)));
      if (!alertState.inflight) {
        alertState.inflight = true;
        track(runAlerts(deps, rc, alertState).catch((e) => log.error('alerts', e)).finally(() => { alertState.inflight = false; }));
      }
    } catch (e) {
      log.error('worker.phase5', e);
    } finally {
      deps.workerState.lastRunAt = deps.now();
      busy = false;
    }
    return summary;
  }

  // Waits for the report and alert sends started by earlier ticks (tests and the proof script).
  async function flush() {
    while (background.size) await Promise.allSettled([...background]);
  }

  function start() {
    log.info('worker started', { interval: `${Math.round(config.workerIntervalMs / 1000)}s` });
    // Said once, at boot: whether the report and the alerts are on, never which token or chat.
    if (rc.reportEnabled) log.info('report enabled', { hour: rc.reportHour });
    else log.info('report disabled', { missing: rc.missingReport.join(',') });
    if (rc.alertsEnabled) log.info('alerts enabled');
    else log.info('alerts disabled', { missing: rc.missingAlerts.join(',') });
    if (rc.warnings.length) log.info('report config invalid, defaults used', { vars: rc.warnings.join(',') });
    if (config.backupDir) {
      if (checkBackupDir()) log.info('backup enabled', { dir: config.backupDir, keep: config.backupKeep });
    } else log.info('backup disabled', { BACKUP_DIR: 'off' });
    timer = setInterval(() => { tick(); }, config.workerIntervalMs);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop, flush, lastMaintenance, checkBackupDir };
}
