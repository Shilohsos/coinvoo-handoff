#!/usr/bin/env bash
# Phase 6 proof: every acceptance item of directives/DIRECTIVE-PHASE-6-ops-hardening.md, against the real service
# (node src/server.js) on a throw-away database, a fake bot DB and a local Telegram stand-in. Nothing here reaches
# the network, the live databases, or /var/backups. Run from the repository root: bash ops/proof-phase6.sh
set -uo pipefail
cd "$(dirname "$0")/.."

T="$(mktemp -d "${TMPDIR:-/tmp}/coinvoo-proof6.XXXXXX")"
PORT=8781; TGPORT=8782; CPORT=8783
DB="$T/coinvoo.db"; SNAP="$T/coinvoo/botdb-snapshot.db"; BOT="$T/bot/trading-bot.db"; BK="$T/backups/coinvoo"
LOG="$T/service.log"; TGLOG="$T/telegram.jsonl"; : > "$TGLOG"
STEP=0; FAILS=0; PIDS=""
check() { STEP=$((STEP + 1))
  if [ "$2" = "$3" ]; then printf 'PASS %2d  %s\n' "$STEP" "$1"
  else printf 'FAIL %2d  %s\n        expected: %s\n        actual:   %s\n' "$STEP" "$1" "$2" "$3"; FAILS=$((FAILS + 1)); fi; }
sq() { sqlite3 -readonly "$@"; }
cu() { curl -s -u admin:pass "$@"; }
UA='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
boot() { # boot <port> <logfile> -> $PID   (environment carries the rest)
  PORT="$1" node src/server.js >>"$2" 2>&1 & PID=$!; PIDS="$PIDS $PID"
  for _ in $(seq 1 50); do curl -s "localhost:$1/api/aff/health" >/dev/null 2>&1 && return 0; sleep 0.1; done; return 1; }
stop() { kill "$1" 2>/dev/null; wait "$1" 2>/dev/null; }
alerts() { jq -s -r --arg c "$1" '[.[] | select(.body.chat_id == $c)][] | .body.text' "$TGLOG"; }
nalerts() { jq -s --arg c "$1" '[.[] | select(.body.chat_id == $c)] | length' "$TGLOG"; }
trap 'for p in $PIDS; do kill "$p" 2>/dev/null; done; rm -rf "$T"' EXIT

export PUBLIC_BASE=https://coinvoo.example ADMIN_USER=admin ADMIN_PASS=pass
export BRAND_ONE_BOT_USERNAME=coinvoo_test_bot BRAND_TWO_BOT_USERNAME=coinvoo_echo_test_bot
export DB_PATH="$DB" BOTDB_SNAPSHOT="$SNAP"
echo "== coinvoo phase 6 proof  node=$(node --version)  sqlite3=$(sqlite3 --version | cut -d' ' -f1)  now=$(date -u +%FT%TZ)  tmp=$T"

# ---- Telegram stand-in -------------------------------------------------------------------------------------------------
TGLOG="$TGLOG" TGPORT="$TGPORT" node -e '
  const http = require("http"), fs = require("fs"); let id = 600;
  http.createServer((q, r) => { let b = ""; q.on("data", (c) => b += c); q.on("end", () => {
    fs.appendFileSync(process.env.TGLOG, JSON.stringify({ path: q.url, body: JSON.parse(b || "{}") }) + "\n");
    r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ ok: true, result: { message_id: ++id } })); }); })
    .listen(+process.env.TGPORT, "127.0.0.1");' &
PIDS="$PIDS $!"; sleep 0.4

# ---- Part 1: ops/sync-botdb.sh ----------------------------------------------------------------------------------------------
echo "-- Part 1: sync --"
mkdir -p "$T/bot" "$T/coinvoo"
BOT="$BOT" node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.env.BOT);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE user_accounts (id INTEGER PRIMARY KEY, telegram_id INTEGER, iq_user_id TEXT, username TEXT, currency TEXT, approval_status TEXT, created_at TEXT, session_blob TEXT); CREATE TABLE trades (id INTEGER PRIMARY KEY, amount REAL);");
  const ins = db.prepare("INSERT INTO user_accounts (telegram_id, iq_user_id, username, currency, approval_status, created_at, session_blob) VALUES (?, ?, ?, \x27USD\x27, \x27approved\x27, \x272026-11-01T00:00:00Z\x27, \x27stays-on-the-bot-host\x27)");
  for (let i = 1; i <= 3; i++) ins.run(7000 + i, String(197100000 + i), "proof" + i);
  for (let i = 1; i <= 50; i++) ins.run(8000 + i, String(197200000 + i), null);
  db.close();'
SYNCENV=(BOT_DB="$BOT" BOTDB_SNAPSHOT="$SNAP" SYNC_LOCK="$T/sync.lock")
echo "\$ BOT_DB=$BOT BOTDB_SNAPSHOT=$SNAP ops/sync-botdb.sh"
OUT=$(env "${SYNCENV[@]}" ops/sync-botdb.sh); RC=$?; echo "$OUT"; echo "exit=$RC"
check "sync: exit 0 and exactly one line 'synced rows=N size=N bytes'" "0 1 [coinvoo] synced rows=53 size=$(stat -c %s "$SNAP") bytes" "$RC $(echo "$OUT" | wc -l) $OUT"
SYNCED=$(sq "$SNAP" "SELECT value FROM meta WHERE key='synced_at'")
AGE=$(node -e 'console.log(Math.round((Date.now() - Date.parse(process.argv[1])) / 1000))' "$SYNCED")
echo "\$ sqlite3 -readonly $SNAP \"SELECT value FROM meta WHERE key='synced_at'\"  ->  $SYNCED  (age ${AGE}s)"
check "sync: meta.synced_at written within the last minute" "yes" "$([ "$AGE" -ge 0 ] && [ "$AGE" -le 60 ] && echo yes || echo "no (${AGE}s)")"
check "sync: only user_accounts (6 columns) + meta leave the bot host" "meta,user_accounts|telegram_id,iq_user_id,username,currency,approval_status,created_at" \
  "$(sq "$SNAP" "SELECT group_concat(name) FROM (SELECT name FROM sqlite_master WHERE type='table' ORDER BY name)")|$(sq "$SNAP" "SELECT group_concat(name) FROM pragma_table_info('user_accounts')")"
flock "$T/sync.lock" sleep 2 & HOLD=$!; sleep 0.3
OUT=$(env "${SYNCENV[@]}" ops/sync-botdb.sh 2>&1); RC=$?
echo "\$ ops/sync-botdb.sh   (while another run holds the lock)  ->  exit=$RC output='${OUT}'"
check "sync: an overlapping run exits 0 silently" "0|" "$RC|$OUT"; wait $HOLD
OUT=$(env "${SYNCENV[@]}" BOT_DB="$T/bot/missing.db" ops/sync-botdb.sh 2>&1); RC=$?
echo "\$ BOT_DB=.../missing.db ops/sync-botdb.sh  ->  exit=$RC"; echo "$OUT"
check "sync: a failure exits non-zero with one ERROR line" "1 1" "$RC $(echo "$OUT" | grep -c '^\[coinvoo\] ERROR sync-botdb: ')"
OUT=$(env "${SYNCENV[@]}" BOTDB_SNAPSHOT="$T/nowhere/botdb-snapshot.db" ops/sync-botdb.sh 2>&1); RC=$?
echo "\$ BOTDB_SNAPSHOT=.../nowhere/botdb-snapshot.db ops/sync-botdb.sh  ->  exit=$RC"; echo "$OUT"
check "sync: a missing destination exits non-zero" "1" "$RC"
if command -v systemd-analyze >/dev/null 2>&1; then
  mkdir -p "$T/units"; sed "s|/opt/coinvoo-sync/sync-botdb.sh|$PWD/ops/sync-botdb.sh|" ops/coinvoo-sync.service > "$T/units/coinvoo-sync.service"; cp ops/coinvoo-sync.timer "$T/units/"
  VER=$(cd "$T/units" && systemd-analyze verify coinvoo-sync.service coinvoo-sync.timer 2>&1; echo "rc=$?")
  echo "\$ systemd-analyze verify coinvoo-sync.service coinvoo-sync.timer  ->  $VER"
  check "systemd: unit pair verifies; timer fires every 5 min" "rc=0|*-*-* *:00/5:00" "$(echo "$VER" | tail -1)|$(systemd-analyze calendar '*:0/5' | sed -n 's/^Normalized form: //p')"
fi

# ---- seed: links, browser opens, joins and postbacks through the real routes (worker idle) --------------------------------------
echo "-- seed through the API (service run 1, worker idle, backup off) --"
BACKUP_DIR=off WORKER_INTERVAL_MS=3600000 boot "$PORT" "$T/seed.log" || { echo "FAIL  seed service did not start"; cat "$T/seed.log"; exit 1; }; SEED=$PID
for i in 1 2 3; do
  TOK=$(cu -X POST "localhost:$PORT/api/links" -H 'content-type: application/json' -d "{\"brand\":\"brand-one\",\"campaign\":\"PROOF6\",\"adset\":\"a$i\",\"ad\":\"v1\"}" | jq -r .token)
  curl -s -o /dev/null -A "$UA" "localhost:$PORT/c/$TOK"
  curl -s -o /dev/null -X POST "localhost:$PORT/api/join" -H 'content-type: application/json' -d "{\"brand\":\"brand-one\",\"telegram_id\":700$i,\"click_id\":\"$TOK\"}"
done
curl -s "localhost:$PORT/api/aff?status=ftd&trader_id=197100001&amount=50&event_id=p6-ftd-1" | jq -c .
curl -s "localhost:$PORT/api/aff?status=reg&trader_id=197100002&event_id=p6-reg-2" | jq -c .
curl -s "localhost:$PORT/api/aff?status=dep&trader_id=197999999&amount=20&event_id=p6-dep-x" | jq -c .
stop "$SEED"
echo "seeded: members=$(sq "$DB" 'SELECT COUNT(*) FROM members') events=$(sq "$DB" 'SELECT COUNT(*) FROM events') clicks=$(sq "$DB" 'SELECT COUNT(*) FROM clicks') click_opens=$(sq "$DB" 'SELECT COUNT(*) FROM click_opens')"

# ---- the service under test ----------------------------------------------------------------------------------------------------
export REPORT_BOT_TOKEN="111222:FAKE_TOKEN_FOR_TESTS_ONLY" ALERT_CHAT_ID=-1002222 TELEGRAM_API_BASE="http://127.0.0.1:$TGPORT" WORKER_INTERVAL_MS=2000
BACKUP_DIR="$BK" boot "$PORT" "$LOG" || { echo "FAIL  service did not start"; cat "$LOG"; exit 1; }; SRV=$PID
echo "-- service run 2: boot log --"; grep -E 'boot|migrations|listening|worker started|alerts|backup' "$LOG" | sed "s|$T|<tmp>|g"
HS=$(curl -s "localhost:$PORT/api/aff/health" | jq -c .snapshot)
echo "\$ curl -s localhost:$PORT/api/aff/health | jq -c .snapshot  ->  $HS"
check "health reports the snapshot: rows=53, age_s under a minute, stale=false" "53 true false" "$(echo "$HS" | jq -r '"\(.rows) \(.age_s <= 60) \(.stale)"')"

# ---- Part 3: backup ----------------------------------------------------------------------------------------------------------------
echo "-- Part 3: backup --"
for _ in $(seq 1 50); do grep -q '^\[coinvoo\] backup file=' "$LOG" && break; sleep 0.2; done
echo "hour now (Africa/Lagos): $(node -e 'console.log(new Date(Date.now()+3600000).getUTCHours())') — the worker's daily run is the first tick after 03:00"
grep -E '^\[coinvoo\] (maintenance|backup)' "$LOG"
DUMP="$BK/$(ls "$BK" | head -1)"; echo "\$ ls -l <tmp>/backups/coinvoo"; ls -l "$BK" | tail -n +2 | sed "s|$T|<tmp>|g"
check "one dump in BACKUP_DIR (directory created), one log line with file name and size" "1 1 $(stat -c %s "$DUMP")" \
  "$(ls "$BK" | wc -l) $(grep -c '^\[coinvoo\] backup file=coinvoo-[0-9-]*\.db bytes=' "$LOG") $(sed -n 's/^\[coinvoo\] backup file=[^ ]* bytes=\([0-9]*\).*/\1/p' "$LOG")"
echo "\$ sqlite3 -readonly <dump> 'PRAGMA integrity_check; PRAGMA journal_mode; counts'"
sq "$DUMP" "PRAGMA integrity_check; PRAGMA journal_mode; SELECT 'members='||COUNT(*) FROM members; SELECT 'events='||COUNT(*) FROM events; SELECT 'clicks='||COUNT(*) FROM clicks;"
LIVE="$(sq "$DB" "SELECT COUNT(*) FROM members")/$(sq "$DB" "SELECT COUNT(*) FROM events")/$(sq "$DB" "SELECT COUNT(*) FROM clicks")"
check "dump opens cleanly and holds the expected rows (members/events/clicks = live = 3/3/3)" "ok|3/3/3|$LIVE" \
  "$(sq "$DUMP" 'PRAGMA integrity_check')|$(sq "$DUMP" "SELECT COUNT(*) FROM members")/$(sq "$DUMP" "SELECT COUNT(*) FROM events")/$(sq "$DUMP" "SELECT COUNT(*) FROM clicks")|3/3/3"
echo "\$ sqlite3 new.db \".restore '<dump>'\"   (docs/07 §6)"
sqlite3 "$T/new.db" ".restore '$DUMP'"
check "restore procedure: .restore into a new file gives the same counts" "ok 3 3 3" \
  "$(sq "$T/new.db" 'PRAGMA integrity_check') $(sq "$T/new.db" 'SELECT COUNT(*) FROM members') $(sq "$T/new.db" 'SELECT COUNT(*) FROM events') $(sq "$T/new.db" 'SELECT COUNT(*) FROM clicks')"
echo "-- Part 3: a BACKUP_DIR that cannot be written (service run 3, its own alert chat) --"
: > "$T/blocker"
ALERT_CHAT_ID=-1003333 DB_PATH="$T/other.db" BACKUP_DIR="$T/blocker/coinvoo" boot "$CPORT" "$T/c.log" || { echo "FAIL  run 3 did not start"; cat "$T/c.log"; exit 1; }; C=$PID
for _ in $(seq 1 40); do [ "$(nalerts -1003333)" -ge 1 ] && break; sleep 0.2; done; sleep 4.5
grep -E '^\[coinvoo\] (ERROR backup|backup|alert)' "$T/c.log" | sed "s|$T|<tmp>|g"
echo "alert chat -1003333:"; alerts -1003333 | sed "s|$T|<tmp>|g; s/^/  -> /"
check "unwritable BACKUP_DIR: ERROR logged by the boot check and by the scheduled run; exactly one 'backup failing' alert over several ticks" "2 1" \
  "$(grep -c '^\[coinvoo\] ERROR backup: Error: ENOTDIR' "$T/c.log") $(alerts -1003333 | grep -c '^COINVOO — backup failing: ENOTDIR: .*(threshold: any failure)$')"
stop "$C"

# ---- Part 2: staleness surfaced ---------------------------------------------------------------------------------------------------
echo "-- Part 2: rename the snapshot under the running service --"
strip() { cu "localhost:$PORT$1" | grep -o '<div class="flash err" data-snapshot-stale="1">[^<]*' | sed 's/<[^>]*>//'; }
check "before: Overview has no strip, no alert yet" "0 0" "$(cu "localhost:$PORT/dash" | grep -c 'data-snapshot-stale') $(nalerts -1002222)"
mv "$SNAP" "$SNAP.away"; echo "\$ mv botdb-snapshot.db botdb-snapshot.db.away"
sleep 7
HS=$(curl -s "localhost:$PORT/api/aff/health" | jq -c .snapshot); echo "health .snapshot -> $HS"
echo "alert chat -1002222:"; alerts -1002222 | sed 's/^/  -> /'
echo "Overview strip: $(strip /dash)"
check "renamed: health stale=true, rows=null" "true null" "$(echo "$HS" | jq -r '"\(.stale) \(.rows)"')"
check "renamed: exactly one alert delivered over ~3 ticks" "1|COINVOO — bot snapshot unavailable" "$(nalerts -1002222)|$(alerts -1002222 | head -1 | cut -d, -f1)"
check "renamed: the strip is on the Overview and names the age; no other screen has it" "1 0 0 0 0" \
  "$(strip /dash | grep -cE 'last sync (under 1 min|[0-9]+ min) ago') $(for p in members events campaigns links; do cu "localhost:$PORT/dash/$p" | grep -c 'data-snapshot-stale'; done | paste -sd' ')"
mv "$SNAP.away" "$SNAP"; echo "\$ mv botdb-snapshot.db.away botdb-snapshot.db"
sleep 7
HS=$(curl -s "localhost:$PORT/api/aff/health" | jq -c .snapshot); echo "health .snapshot -> $HS"
echo "alert chat -1002222:"; alerts -1002222 | sed 's/^/  -> /'
check "restored: health stale=false, the strip clears" "false 0" "$(echo "$HS" | jq -r .stale) $(cu "localhost:$PORT/dash" | grep -c 'data-snapshot-stale')"
check "restored: no second alert — one firing message in all, then the one 'cleared' notice" "1|COINVOO — bot snapshot cleared" \
  "$(alerts -1002222 | grep -vc 'cleared$')|$(alerts -1002222 | tail -1)"

# ---- Part 4: thresholds are env-only ------------------------------------------------------------------------------------------------
echo "-- Part 4: thresholds via env, proven by test --"
T4=$(node --test --test-reporter=spec --test-name-pattern='thresholds|PARKED_ALERT_PCT=40|SNAPSHOT_STALE_MINUTES' test/ops.test.js test/alerts.test.js 2>&1)
echo "$T4" | grep -E '^\s*(✔|✖)|^ℹ (tests|pass|fail)' | sed 's/ ([0-9.]*ms)$//'
check "the env-only threshold tests pass" "0" "$(echo "$T4" | sed -n 's/^ℹ fail //p')"

# ---- Part 5: click smoke, twice --------------------------------------------------------------------------------------------------
echo "-- Part 5: ops/click-smoke.sh twice against the running service --"
for r in 1 2; do
  echo "\$ COINVOO_BASE=http://127.0.0.1:$PORT ops/click-smoke.sh   (run $r)"
  COINVOO_BASE="http://127.0.0.1:$PORT" ops/click-smoke.sh; RC=$?; echo "exit=$RC"
  check "click-smoke run $r passes" "0" "$RC"
done
check "smoke left nothing behind: members/clicks/click_opens as seeded (3/3/3)" "3/3/3" \
  "$(sq "$DB" 'SELECT COUNT(*) FROM members')/$(sq "$DB" 'SELECT COUNT(*) FROM clicks')/$(sq "$DB" 'SELECT COUNT(*) FROM click_opens')"

# ---- hygiene ---------------------------------------------------------------------------------------------------------------------------
check "no dependency added; no new migration" "0 5" "$(grep -c '"dependencies"' package.json) $(ls migrations | wc -l)"
check "the fake bot token appears in no log line" "0" "$(cat "$LOG" "$T/c.log" "$T/seed.log" | grep -c 'FAKE_TOKEN')"
stop "$SRV"
echo "-- service log (errors only) --"; grep -E 'ERROR|FATAL' "$LOG" || echo "(none)"
if [ "$FAILS" -eq 0 ]; then echo "RESULT: ALL $STEP CHECKS PASSED"; else echo "RESULT: $FAILS OF $STEP CHECKS FAILED"; exit 1; fi
