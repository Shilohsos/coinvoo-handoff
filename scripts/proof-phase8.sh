#!/usr/bin/env bash
# Phase 8 status: the Meta Conversions API sender as the service sees it. Read-only; prints no token.
#   set -a; . /srv/coinvoo/.env; set +a; bash scripts/proof-phase8.sh
# Shows: enabled state, dataset id, API version, whether a token is set (yes/no only), test_event_code in use,
# meta_sends rows by state and kind, today's sent count (Africa/Lagos), the oldest due row, and the last
# stored Meta response (truncated, token scrubbed again here for safety).
set -uo pipefail
cd "$(dirname "$0")/.."
DB="${DB_PATH:-/srv/coinvoo/coinvoo.db}"
[ -f "$DB" ] || { echo "[coinvoo] ERROR proof-phase8: database not found: $DB" >&2; exit 1; }

echo "== coinvoo phase 8: meta capi  $(date -u +%FT%TZ)  db=$DB"
echo "enabled=${META_CAPI_ENABLED:-0} dataset=${META_DATASET_ID:--} version=${META_API_VERSION:-v22.0} token_set=$([ -n "${META_CAPI_TOKEN:-}" ] && echo yes || echo no) test_event_code=$([ -n "${META_TEST_EVENT_CODE:-}" ] && echo set || echo none)"

DB="$DB" node --no-warnings --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(process.env.DB, { readOnly: true });
  const has = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = \x27table\x27 AND name = \x27meta_sends\x27").get();
  if (!has) { console.log("meta_sends: missing (migration 007 not applied yet: start the Phase 8 service once)"); process.exit(0); }
  const scrub = (s) => String(s ?? "").split(process.env.META_CAPI_TOKEN || "\u0000").join("[redacted]").replace(/access_token=[^&\s"]+/g, "access_token=[redacted]");
  const latest = db.prepare("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1").get();
  console.log(`migrations latest=${latest ? latest.name : "-"}`);
  const byState = db.prepare("SELECT state, COUNT(*) AS n FROM meta_sends GROUP BY state ORDER BY state").all();
  console.log(`rows by state: ${byState.length ? byState.map((r) => `${r.state}=${r.n}`).join(" ") : "(none)"}`);
  const byKind = db.prepare("SELECT kind, state, COUNT(*) AS n FROM meta_sends GROUP BY kind, state ORDER BY kind, state").all();
  for (const r of byKind) console.log(`  ${r.kind.padEnd(13)} ${r.state.padEnd(8)} ${r.n}`);
  const dayStart = Math.floor((Date.now() + 3600000) / 86400000) * 86400000 - 3600000;
  console.log(`sent today (Africa/Lagos) = ${db.prepare("SELECT COUNT(*) AS n FROM meta_sends WHERE state = \x27sent\x27 AND sent_at >= ?").get(dayStart).n}`);
  const due = db.prepare("SELECT send_id, tries, next_at FROM meta_sends WHERE state = \x27pending\x27 ORDER BY created_at LIMIT 1").get();
  console.log(due ? `oldest pending: ${due.send_id.replace(/^join:(\d+):\d+$/, "join:$1:<telegram id>")} tries=${due.tries} next_at=${due.next_at ? new Date(due.next_at).toISOString() : "now"}` : "oldest pending: (none)");
  const last = db.prepare("SELECT send_id, state, resp FROM meta_sends WHERE resp IS NOT NULL ORDER BY COALESCE(sent_at, next_at, created_at) DESC LIMIT 1").get();
  console.log(last ? `last resp (${last.state}): ${scrub(last.resp).slice(0, 160)}` : "last resp: (none)");
  const fail = db.prepare("SELECT resp, COUNT(*) AS n FROM meta_sends WHERE state = \x27failed\x27 GROUP BY resp ORDER BY n DESC LIMIT 3").all();
  for (const f of fail) console.log(`  failed x${f.n}: ${scrub(f.resp).slice(0, 120)}`);
  db.close();'
