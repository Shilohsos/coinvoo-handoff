// Phase 8 Part G — send matched conversions from a past window to Meta (Conversions API).
//   set -a; . /srv/coinvoo/.env; set +a
//   node scripts/meta-backfill.js --since 2026-11-16            # dry run (default): counts only, no writes, no network
//   node scripts/meta-backfill.js --since 2026-11-16 --send     # enqueue, then drain until nothing is due
// Window: matched reg/ftd/dep events received since 00:00 Africa/Lagos on --since. Joins are not backfilled.
// Each event is queued under evt:<event_id>, so anything the service already queued or sent is never sent again,
// and the event keeps its true received_at as event_time (Meta refuses events older than 7 days: those are
// counted under skipped=too_old). The token is never printed.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createCapi, buildEvent, KIND_FOR_EVENT } from '../src/capi.js';

const LAGOS_OFFSET_MS = 3600000;

export function sinceMs(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? t - LAGOS_OFFSET_MS : null;
}

// Returns { would_send, sent, failed, skipped, already_queued, retry_pending, reasons }.
export async function metaBackfill({ db, config, since, send = false, now = Date.now, fetchImpl = globalThis.fetch }) {
  const from = sinceMs(since);
  if (from === null) throw new Error('--since must be YYYY-MM-DD');
  if (!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta_sends'").get()) {
    throw new Error('meta_sends does not exist: start the Phase 8 service once so migration 007 is applied');
  }
  const events = db.prepare(
    `SELECT event_id, brand_id, kind, state FROM events
      WHERE state = 'matched' AND kind IN ('reg', 'ftd', 'dep') AND received_at >= ?
      ORDER BY received_at`
  ).all(from);
  const queued = db.prepare('SELECT 1 AS x FROM meta_sends WHERE send_id = ?');
  const out = { would_send: 0, sent: 0, failed: 0, skipped: 0, already_queued: 0, retry_pending: 0, reasons: {} };
  const t = now();
  const todo = [];
  for (const e of events) {
    const sendId = `evt:${e.event_id}`;
    if (queued.get(sendId)) { out.already_queued++; continue; }
    const b = buildEvent(db, { send_id: sendId, kind: KIND_FOR_EVENT[e.kind], ref: e.event_id }, { now: t, publicBase: config.publicBase });
    if (b.skip) { out.skipped++; out.reasons[b.skip] = (out.reasons[b.skip] || 0) + 1; continue; }
    out.would_send++;
    todo.push(e);
  }
  if (!send) return out;

  if (!config.meta.enabled) throw new Error('--send needs META_CAPI_ENABLED=1 with META_DATASET_ID and META_CAPI_TOKEN in the environment');
  const capi = createCapi({ db, config, now, fetchImpl });
  for (const e of todo) capi.enqueueEvent(db, e, t);
  const sendIds = new Set(todo.map((e) => `evt:${e.event_id}`));
  // Drain until a pass finds nothing due (rows waiting on a retry back-off are left to the service).
  for (;;) {
    const r = await capi.drain(config.meta.batch);
    if (!r.sent && !r.failed && !r.retry && !r.skipped) break;
  }
  const state = db.prepare('SELECT state, resp FROM meta_sends WHERE send_id = ?');
  for (const id of sendIds) {
    const row = state.get(id);
    if (!row) continue;
    if (row.state === 'sent') out.sent++;
    else if (row.state === 'failed') out.failed++;
    else if (row.state === 'skipped') { out.skipped++; out.reasons[row.resp] = (out.reasons[row.resp] || 0) + 1; }
    else out.retry_pending++;
  }
  return out;
}

export function formatResult(r, { send }) {
  const reasons = Object.entries(r.reasons).map(([k, v]) => `${k}:${v}`).join(',') || '-';
  return `[coinvoo] meta backfill mode=${send ? 'send' : 'dry-run'} would_send=${r.would_send} sent=${r.sent} failed=${r.failed} skipped=${r.skipped} already_queued=${r.already_queued} retry_pending=${r.retry_pending} skip_reasons=${reasons}`;
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--since');
  const since = at >= 0 ? args[at + 1] : null;
  const send = args.includes('--send');
  if (!sinceMs(since)) {
    console.error('usage: node scripts/meta-backfill.js --since YYYY-MM-DD [--send]');
    process.exit(2);
  }
  let config;
  try { config = loadConfig(process.env); } catch (e) { console.error(`[coinvoo] FATAL config: ${e.message}`); process.exit(1); }
  // A dry run only reads; --send writes the queue rows it sends.
  const db = send ? openDb(config.dbPath) : new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    const r = await metaBackfill({ db, config, since, send });
    console.log(formatResult(r, { send }));
    if (r.failed) process.exitCode = 1;
  } catch (e) {
    console.error(`[coinvoo] ERROR meta backfill: ${e.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
