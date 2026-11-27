#!/usr/bin/env bash
# Phase 2 proof (docs/08-test-plan.md "Phase 2" + DIRECTIVE-PHASE-2 §11). Boots the real service on a
# scratch database, drives it with curl, prints a numbered PASS/FAIL list, exits non-zero on any failure.
# Joinvoo is a local stand-in (no external call is made); the bot snapshot and recon.db are fixtures.
set -u
cd "$(dirname "$0")/.."

DB="${DB_PATH:-/tmp/coinvoo-test.db}"
PORT="${PORT:-8771}"
MOCK_PORT="${MOCK_PORT:-8799}"
SNAP=/tmp/coinvoo-proof-snapshot.db
LOG=/tmp/coinvoo-proof2.log
MOCKLOG=/tmp/coinvoo-proof2-joinvoo.log
RECON=test/fixtures/recon-sample.db
case "$DB" in /tmp/*) ;; *) echo "refusing: DB_PATH must be under /tmp (scratch database only)"; exit 2;; esac
rm -f "$DB" "$DB-wal" "$DB-shm" "$LOG" "$MOCKLOG" "$SNAP"

export DB_PATH="$DB" PORT
export PUBLIC_BASE=https://coinvoo.example ADMIN_USER=admin ADMIN_PASS=pass
export BACKUP_DIR=off  # phase 6: the backup defaults to /var/backups/coinvoo; a proof run must never write there
export BRAND_ONE_BOT_USERNAME=coinvoo_test_bot BRAND_TWO_BOT_USERNAME=coinvoo_echo_test_bot
export BOTDB_SNAPSHOT="$SNAP"
export PARALLEL_FORWARD=1 JOINVOO_PB="http://127.0.0.1:$MOCK_PORT/pb/placeholder"
export FORWARD_BACKOFF_MIN=0.02,0.02,0.05 WORKER_INTERVAL_MS=2000
unset JOIN_KEY

FAILS=0; STEP=0; SRV=; MOCK=
check() { # check "<description>" "<expected>" "<actual>"
  STEP=$((STEP + 1))
  if [ "$2" = "$3" ]; then printf 'PASS %2d  %s\n' "$STEP" "$1"
  else printf 'FAIL %2d  %s\n        expected: %s\n        actual:   %s\n' "$STEP" "$1" "$2" "$3"; FAILS=$((FAILS + 1)); fi
}
# sqlite3 CLI is not required: query through node:sqlite, rows joined with '|'.
sql() { node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  for (const r of db.prepare(process.argv[2]).all()) console.log(Object.values(r).join("|"));
' "${2:-$DB}" "$1"; }
sqlw() { node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA busy_timeout = 5000"); db.exec(process.argv[2]);
' "$DB" "$1"; }
pb() { curl -s "localhost:$PORT/api/aff?$1"; }
start() {
  node src/server.js >>"$LOG" 2>&1 &
  SRV=$!
  for _ in $(seq 1 50); do curl -s "localhost:$PORT/api/aff/health" >/dev/null 2>&1 && return 0; sleep 0.1; done
  return 1
}
stop() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null && wait "$SRV" 2>/dev/null; SRV=; }
mock_start() {
  MOCKLOG="$MOCKLOG" MOCK_PORT="$MOCK_PORT" node -e '
    require("node:http").createServer((q, r) => { require("node:fs").appendFileSync(process.env.MOCKLOG, q.url + "\n"); r.end("ok"); })
      .listen(+process.env.MOCK_PORT, "127.0.0.1");
  ' &
  MOCK=$!
  for _ in $(seq 1 50); do curl -s "localhost:$MOCK_PORT/" >/dev/null 2>&1 && return 0; sleep 0.1; done
  return 1
}
mock_stop() { [ -n "$MOCK" ] && kill "$MOCK" 2>/dev/null && wait "$MOCK" 2>/dev/null; MOCK=; }
wait_for() { # wait_for "<sql>" "<expected>" [seconds]
  for _ in $(seq 1 $(( ${3:-15} * 10 ))); do [ "$(sql "$1")" = "$2" ] && return 0; sleep 0.1; done; return 1
}
trap 'stop; mock_stop' EXIT

echo "== coinvoo phase 2 proof  db=$DB port=$PORT node=$(node --version)"

# Fixture bot snapshot (the production file lives on the bot host, refreshed every 5 minutes).
SNAP="$SNAP" node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.env.SNAP);
  db.exec(`CREATE TABLE user_accounts (telegram_id INTEGER, iq_user_id TEXT, username TEXT, currency TEXT, approval_status TEXT, created_at TEXT);
           CREATE INDEX idx_ua_iq ON user_accounts(iq_user_id);
           CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
  db.prepare("INSERT INTO user_accounts VALUES (?,?,?,?,?,?)").run(6956546116, "197318401", "bot_user_a", "USD", "approved", "2026-10-01T10:00:00Z");
  db.prepare("INSERT INTO user_accounts VALUES (?,?,?,?,?,?)").run(6956546117, "197318402", "bot_user_b", "USD", "approved", "2026-10-02T10:00:00Z");
  db.prepare("INSERT INTO meta VALUES (?,?)").run("synced_at", new Date().toISOString());
'
SNAP_SHA=$(sha256sum "$SNAP" | cut -d' ' -f1); RECON_SHA=$(sha256sum "$RECON" | cut -d' ' -f1)

mock_start || { echo "FAIL  joinvoo stand-in did not start"; exit 1; }
start || { echo "FAIL  service did not start"; cat "$LOG"; exit 1; }
check "boot on an empty database: 5 migrations applied" "[coinvoo] migrations applied=5 latest=005_click_opens new=5" "$(grep '^\[coinvoo\] migrations' "$LOG" | head -1)"
check "brand-two is seeded inactive (brand-one only)" "brand-one|1
brand-two|0" "$(sql 'SELECT code, active FROM brands ORDER BY code')"

# Prerequisites for the numbered steps: one member joined through the bot, the rest from the bot snapshot.
curl -s -X POST "localhost:$PORT/api/join" -H 'content-type: application/json' \
  -d '{"brand":"brand-one","telegram_id":7000000001,"username":"tester","first_name":"tester","source":"bot:start"}' >/dev/null
BF1=$(node scripts/backfill-members.js 2>&1 | tr '\n' ' '); echo "$BF1"
BF2=$(node scripts/backfill-members.js 2>&1 | tr '\n' ' ')
check "backfill-members from the snapshot: 2 new members" "inserted=2" "$(echo "$BF1" | grep -o 'inserted=[0-9]*')"
check "backfill-members is idempotent (second run inserts 0)" "inserted=0" "$(echo "$BF2" | grep -o 'inserted=[0-9]*')"

# docs/08 step 1 — stub postback
check "docs/08:1 stub postback -> ignored stub_guard" '{"ok":true,"ignored":"stub_guard"}' \
  "$(pb 'status=ftd&net=affstore&trader_id=1&amount=100&event_id=stub-1&afftrack=TEST-RECON-1')"

# step 2 — real FTD, known member, afftrack path
R=$(pb 'status=ftd&trader_id=197512345&amount=50&event_id=ev-1&afftrack=7000000001&country_code=NG'); echo "$R"
check "docs/08:2 afftrack path -> matched, confidence 100, member 1" "true afftrack 1 100" \
  "$(echo "$R" | jq -r '"\(.matched) \(.path) \(.member_id) \(.confidence)"')"

# step 3 — duplicate
check "docs/08:3 duplicate event_id -> duplicate:true" '{"ok":true,"event_id":"ev-1","duplicate":true}' \
  "$(pb 'status=ftd&trader_id=197512345&amount=50&event_id=ev-1&afftrack=7000000001')"
check "docs/08:3 ...and still exactly one row" "1" "$(sql "SELECT COUNT(*) FROM events WHERE event_id='ev-1'")"

# step 4 — trader_id path, member resolved from the bot snapshot
R=$(pb 'status=ftd&trader_id=197318401&amount=10&event_id=ev-2'); echo "$R"
check "docs/08:4 bot-snapshot path -> matched trader_id, confidence 90" "true trader_id 90" \
  "$(echo "$R" | jq -r '"\(.matched) \(.path) \(.confidence)"')"
check "docs/08:4 ...and the broker account is now linked (source bot_db)" "197318401|bot_db" \
  "$(sql "SELECT iq_user_id, source FROM accounts WHERE iq_user_id='197318401'")"

# step 5 — unknown trader -> parked
check "docs/08:5 unknown trader -> parked" '{"ok":true,"event_id":"ev-3","duplicate":false,"matched":false,"path":"parked"}' \
  "$(pb 'status=dep&trader_id=197999999&amount=25&event_id=ev-3')"
# step 6 — the park is real, and a parked event has no attribution row
check "docs/08:6 state is parked" "parked" "$(sql "SELECT state FROM events WHERE event_id='ev-3'")"
check "docs/08:6 parked event has no attribution row" "0" "$(sql "SELECT COUNT(*) FROM attributions WHERE event_id='ev-3'")"

# step 7 — the person appears, the account is linked, the parked event is picked up
curl -s -X POST "localhost:$PORT/api/join" -H 'content-type: application/json' \
  -d '{"brand":"brand-one","telegram_id":7000000001,"source":"bot:start"}' >/dev/null
M2=$(sql "SELECT id FROM members WHERE telegram_id=7000000001")
sqlw "INSERT INTO accounts(member_id,iq_user_id,source,confidence,linked_at) VALUES ($M2,'197999999','manual',100,strftime('%s','now')*1000)"
node scripts/rematch.js 197999999
check "docs/08:7 rematch -> matched to the new member" "matched|$M2" "$(sql "SELECT state,matched_member_id FROM events WHERE event_id='ev-3'")"

# step 8 — invariants (docs/02 §5), every value must be 0
INV=$(sql "
 SELECT 'accounts_dupes', COUNT(*) FROM (SELECT iq_user_id FROM accounts GROUP BY iq_user_id HAVING COUNT(*)>1)
 UNION ALL SELECT 'matched_without_attribution', COUNT(*) FROM events e WHERE e.state='matched'
   AND (SELECT COUNT(*) FROM attributions a WHERE a.event_id=e.event_id AND a.confidence>0) <> 1
 UNION ALL SELECT 'parked_with_attribution', COUNT(*) FROM events e WHERE e.state='parked'
   AND EXISTS (SELECT 1 FROM attributions a WHERE a.event_id=e.event_id)
 UNION ALL SELECT 'parked_bad_forward_state', COUNT(*) FROM events WHERE state='parked' AND forward_state NOT IN ('none','pending','sent')
 UNION ALL SELECT 'zero_confidence_vs_expired_ignored', ABS((SELECT COUNT(*) FROM attributions WHERE confidence=0) - (SELECT COUNT(*) FROM events WHERE state IN ('expired','ignored')))
 UNION ALL SELECT 'members_unknown_click', COUNT(*) FROM members WHERE click_id IS NOT NULL AND click_id NOT IN (SELECT click_id FROM clicks)")
echo "$INV"
check "docs/08:8 invariants all zero" "0" "$(echo "$INV" | cut -d'|' -f2 | sort -u | tr '\n' ' ' | sed 's/ $//')"

# step 9 — the response does not wait for the Joinvoo forward
T0=$(date +%s%N); pb 'status=ftd&trader_id=197512345&amount=5&event_id=ev-4&afftrack=7000000001' >/dev/null; T1=$(date +%s%N)
MS=$(( (T1 - T0) / 1000000 )); echo "ev-4 response: ${MS} ms"
check "docs/08:9 response < 150 ms" "ok" "$([ "$MS" -lt 150 ] && echo ok || echo "slow:${MS}ms")"
wait_for "SELECT forward_state FROM events WHERE event_id='ev-4'" sent 10
check "docs/08:9 forward lands after the response (forward_state=sent)" "sent" "$(sql "SELECT forward_state FROM events WHERE event_id='ev-4'")"
check "docs/08:9 the stand-in received ev-4 with the resolved afftrack and no clickid" "1" \
  "$(grep -c 'event_id=ev-4' "$MOCKLOG" | tr -d ' ')"
check "     ...afftrack=7000000001, clickid absent" "afftrack=7000000001 no-clickid" \
  "$(grep 'event_id=ev-4' "$MOCKLOG" | head -1 | { read -r u; a=$(echo "$u" | grep -o 'afftrack=[0-9]*'); echo "$a $(echo "$u" | grep -q clickid && echo has-clickid || echo no-clickid)"; })"

# DoD — latency: 20 sequential postbacks
echo "-- 20 sequential postbacks (curl time_total, ms) --"
TIMES=""
time {
  for i in $(seq 1 20); do
    t=$(curl -s -o /dev/null -w '%{time_total}' "localhost:$PORT/api/aff?status=dep&trader_id=1973000$(printf '%02d' "$i")&amount=$((i + 1))&event_id=lat-$i&afftrack=7000000001")
    TIMES="$TIMES $(awk -v t="$t" 'BEGIN{printf "%.0f", t*1000}')"
  done
}
echo "ms:$TIMES"
MAXMS=$(echo $TIMES | tr ' ' '\n' | sort -n | tail -1)
check "DoD: 20 sequential postbacks, slowest ${MAXMS} ms < 150 ms" "ok" "$([ "$MAXMS" -lt 150 ] && echo ok || echo slow)"
check "DoD: all 20 matched" "20" "$(sql "SELECT COUNT(*) FROM events WHERE event_id LIKE 'lat-%' AND state='matched'")"

# DoD — forward retry: network down -> failed/pending, network back -> sent
mock_stop
pb 'status=ftd&trader_id=197600001&amount=77&event_id=ev-retry&afftrack=7000000001' >/dev/null
wait_for "SELECT forward_state FROM events WHERE event_id='ev-retry'" failed 10
check "DoD: Joinvoo unreachable -> forward_state=failed, event still matched" "failed|matched" \
  "$(sql "SELECT forward_state, state FROM events WHERE event_id='ev-retry'")"
# The worker keeps retrying while it is down. Poll rather than sleep a fixed time: with 2 s ticks and a
# 1.2 s backoff the second attempt lands up to ~3.2 s after the first, so a fixed 3 s sleep could miss it.
wait_for "SELECT forward_tries >= 2 AND forward_state = 'failed' FROM events WHERE event_id='ev-retry'" 1 8
check "DoD: worker retried while down (tries >= 2, still failed)" "ok" "$([ "$(sql "SELECT forward_tries FROM events WHERE event_id='ev-retry'")" -ge 2 ] && [ "$(sql "SELECT forward_state FROM events WHERE event_id='ev-retry'")" = failed ] && echo ok || echo no)"
mock_start
wait_for "SELECT forward_state FROM events WHERE event_id='ev-retry'" sent 20
check "DoD: Joinvoo back -> worker delivers, forward_state=sent" "sent" "$(sql "SELECT forward_state FROM events WHERE event_id='ev-retry'")"
check "DoD: the stand-in received ev-retry" "1" "$(grep -c 'event_id=ev-retry' "$MOCKLOG" | tr -d ' ')"

# worker summary line
check "worker logs exactly one summary line per tick (format)" "ok" \
  "$(grep -E '^\[coinvoo\] worker tick parked=[0-9]+ rematched=[0-9]+ expired=[0-9]+ forwards=[0-9]+ rolled_up=[0-9]+ took=[0-9]+ms$' "$LOG" | head -1 | grep -q . && echo ok || echo none)"

# history import (fixture recon.db; the production run is operator work)
EV_BEFORE=$(sql 'SELECT COUNT(*) FROM events')
DRY=$(node scripts/import-recon.js --recon "$RECON" --dry-run 2>&1); echo "$DRY"
check "docs/08:10 import dry-run source_rows matches recon.db COUNT(*)" "$(sql 'SELECT COUNT(*) FROM events' "$RECON")" "$(echo "$DRY" | grep -o 'source_rows=[0-9]*' | cut -d= -f2)"
check "docs/08:10 dry-run wrote nothing" "$EV_BEFORE" "$(sql 'SELECT COUNT(*) FROM events')"
IMP1=$(node scripts/import-recon.js --recon "$RECON" 2>&1); echo "$IMP1"; N1=$(sql 'SELECT COUNT(*) FROM events')
IMP2=$(node scripts/import-recon.js --recon "$RECON" 2>&1); echo "$IMP2"; N2=$(sql 'SELECT COUNT(*) FROM events')
check "docs/08:11 first import adds 20 rows" "$((EV_BEFORE + 20))" "$N1"
check "docs/08:11 second import changes nothing ($N1 -> $N2)" "$N1" "$N2"
check "docs/08:11 second import reports inserted=0" "inserted=0" "$(echo "$IMP2" | grep -o 'inserted=[0-9]*')"

# invariants again, now with history in the table
INV2=$(sql "
 SELECT COUNT(*) FROM events e WHERE e.state='matched' AND (SELECT COUNT(*) FROM attributions a WHERE a.event_id=e.event_id AND a.confidence>0) <> 1
 UNION ALL SELECT COUNT(*) FROM events e WHERE e.state='parked' AND EXISTS (SELECT 1 FROM attributions a WHERE a.event_id=e.event_id)
 UNION ALL SELECT COUNT(*) FROM events WHERE state='parked' AND forward_state NOT IN ('none','pending','sent')
 UNION ALL SELECT ABS((SELECT COUNT(*) FROM attributions WHERE confidence=0) - (SELECT COUNT(*) FROM events WHERE state IN ('expired','ignored')))" | sort -u | tr '\n' ' ' | sed 's/ $//')
check "invariants still all zero after the history import" "0" "$INV2"

# restart: data survives
EV_N=$(sql 'SELECT COUNT(*) FROM events'); ATT_N=$(sql 'SELECT COUNT(*) FROM attributions'); MEM_N=$(sql 'SELECT COUNT(*) FROM members')
stop; start || { echo "FAIL  restart"; cat "$LOG"; exit 1; }
check "restart: events, attributions, members unchanged" "$EV_N $ATT_N $MEM_N" "$(sql 'SELECT COUNT(*) FROM events') $(sql 'SELECT COUNT(*) FROM attributions') $(sql 'SELECT COUNT(*) FROM members')"
check "restart: health ok and last_event_at present" "true true" "$(curl -s "localhost:$PORT/api/aff/health" | jq -r '"\(.ok) \(.last_event_at != null)"')"
check "stats: counters for the window" "true" "$(curl -s "localhost:$PORT/api/aff/stats" | jq -r '(.events.matched > 0 and .events.ignored >= 1 and .forward.sent > 0)')"
check "PRAGMA integrity_check" "ok" "$(sql 'PRAGMA integrity_check')"
stop

# DoD — boots clean from a Phase-1 database (migrations 001+002 only, with data in it)
P1=/tmp/coinvoo-test-phase1.db; rm -f "$P1" "$P1-wal" "$P1-shm"; mkdir -p /tmp/coinvoo-p1-migs; rm -f /tmp/coinvoo-p1-migs/*
cp migrations/001_init.sql migrations/002_seed_brands.sql /tmp/coinvoo-p1-migs/
DB_PATH="$P1" node --no-warnings -e '
  import("./src/db.js").then(({ openDb, migrate }) => {
    const db = openDb(process.env.DB_PATH);
    migrate(db, { dir: "/tmp/coinvoo-p1-migs", env: process.env });
    db.prepare("INSERT INTO members (brand_id, telegram_id, joined_at, join_source) VALUES (1, 7000000001, 1, ?)").run("bot:start");
    db.close();
  });'
DB_PATH="$P1" PORT=$((PORT + 1)) node src/server.js >"$LOG.p1" 2>&1 &
P1PID=$!; sleep 1
check "boot from a Phase-1 database: migrations 003-005 applied" "[coinvoo] migrations applied=5 latest=005_click_opens new=3" "$(grep '^\[coinvoo\] migrations' "$LOG.p1" | head -1)"
check "...Phase-1 member survives; echo deactivated" "1|0" "$(sql 'SELECT (SELECT COUNT(*) FROM members), (SELECT active FROM brands WHERE code='"'"'brand-two'"'"')' "$P1")"
kill "$P1PID" 2>/dev/null; wait "$P1PID" 2>/dev/null

# DoD — read-only inputs untouched
check "bot snapshot file byte-identical (never written)" "$SNAP_SHA" "$(sha256sum "$SNAP" | cut -d' ' -f1)"
check "recon.db fixture byte-identical (never written)" "$RECON_SHA" "$(sha256sum "$RECON" | cut -d' ' -f1)"

echo "-- service log (first 60 lines) --"
head -60 "$LOG"
echo "-- joinvoo stand-in received $(wc -l < "$MOCKLOG" | tr -d ' ') requests --"
echo "-- live-host items NOT run by this script: production recon.db import, Caddy /api/aff2*, real Affstore mirror --"
if [ "$FAILS" -eq 0 ]; then echo "RESULT: ALL $STEP CHECKS PASSED"; else echo "RESULT: $FAILS OF $STEP CHECKS FAILED"; exit 1; fi
