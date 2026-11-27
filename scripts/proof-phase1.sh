#!/usr/bin/env bash
# Phase 1 proof (docs/08-test-plan.md, "Proof"). Boots the real service on a scratch
# database, walks the click -> join path with curl, prints a numbered PASS/FAIL list and
# exits non-zero on any failure. Steps 9-11 (live gate bot) are manual and not run here.
set -u
cd "$(dirname "$0")/.."

DB="${DB_PATH:-/tmp/coinvoo-test.db}"
PORT="${PORT:-8771}"
LOG=/tmp/coinvoo-proof.log
case "$DB" in /tmp/*) ;; *) echo "refusing: DB_PATH must be under /tmp (scratch database only)"; exit 2;; esac
rm -f "$DB" "$DB-wal" "$DB-shm" "$LOG"

export DB_PATH="$DB" PORT
export PUBLIC_BASE=https://coinvoo.example ADMIN_USER=admin ADMIN_PASS=pass
export BACKUP_DIR=off  # phase 6: the backup defaults to /var/backups/coinvoo; a proof run must never write there
export BRAND_ONE_BOT_USERNAME=coinvoo_test_bot BRAND_TWO_BOT_USERNAME=coinvoo_echo_test_bot
unset JOIN_KEY

FAILS=0
STEP=0
check() { # check "<description>" "<expected>" "<actual>"
  STEP=$((STEP + 1))
  if [ "$2" = "$3" ]; then printf 'PASS %2d  %s\n' "$STEP" "$1"
  else printf 'FAIL %2d  %s\n        expected: %s\n        actual:   %s\n' "$STEP" "$1" "$2" "$3"; FAILS=$((FAILS + 1)); fi
}
# sqlite3 CLI is not required: read the scratch DB through node:sqlite, rows joined with '|'.
sql() {
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    for (const r of db.prepare(process.argv[2]).all()) console.log(Object.values(r).join("|"));
  ' "$DB" "$1"
}
start() {
  node src/server.js >>"$LOG" 2>&1 &
  SRV=$!
  for _ in $(seq 1 50); do curl -s "localhost:$PORT/api/aff/health" >/dev/null 2>&1 && return 0; sleep 0.1; done
  return 1
}
trap 'kill "$SRV" 2>/dev/null' EXIT

echo "== coinvoo phase 1 proof  db=$DB port=$PORT node=$(node --version)"

# 1. boot on a scratch db
start || { echo "FAIL  service did not start"; cat "$LOG"; exit 1; }
HEALTH=$(curl -s "localhost:$PORT/api/aff/health")
check "docs/08:1 boot + health ok:true" "true" "$(echo "$HEALTH" | jq -r .ok)"

# 2. create a link
TOKEN=$(curl -s -u admin:pass -X POST "localhost:$PORT/api/links" \
  -H 'content-type: application/json' \
  -d '{"brand":"brand-one","campaign":"NG_Broad","adset":"18-34","ad":"vid_03"}' | jq -r .token)
echo "token=$TOKEN"
check "docs/08:2 link minted, token is 10 chars" "10" "${#TOKEN}"

# 3. click it — must redirect
check "docs/08:3 GET /c/<token> -> 302 to the gate bot" \
  "302 https://t.me/coinvoo_test_bot?start=c_$TOKEN" \
  "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "localhost:$PORT/c/$TOKEN?ttclid=E.C.P.test")"

# 4. the click row exists with its campaign
check "docs/08:4 click row has campaign, adset, ad and a 32-char ip_hash" \
  "$TOKEN|NG_Broad|18-34|vid_03|32" \
  "$(sql "SELECT click_id,campaign,adset,ad,length(ip_hash) FROM clicks WHERE click_id='$TOKEN'")"

# 5. the bot reports the join
JOIN=$(curl -s -X POST "localhost:$PORT/api/join" -H 'content-type: application/json' \
  -d "{\"brand\":\"brand-one\",\"telegram_id\":7000000001,\"username\":\"tester\",\"first_name\":\"tester\",\"click_id\":\"$TOKEN\",\"source\":\"bot:start\"}")
echo "$JOIN"
check "docs/08:5 POST /api/join creates the member" \
  "{\"ok\":true,\"member_id\":1,\"created\":true,\"click_id\":\"$TOKEN\"}" "$JOIN"

# 6. member row carries the click and the campaign
check "docs/08:6 member row joined to click and campaign" "7000000001|bot:start|NG_Broad" \
  "$(sql "SELECT m.telegram_id,m.join_source,c.campaign FROM members m JOIN clicks c ON c.click_id=m.click_id")"

# 7. unknown token is a clean 404, no row written
check "docs/08:7a unknown token -> 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' "localhost:$PORT/c/ZZZZZZZZZZ")"
check "docs/08:7b no click row written for it" "1" "$(sql 'SELECT COUNT(*) FROM clicks')"

# 8. restart with the same db — data survives
SALT_BEFORE=$(sql "SELECT value FROM settings WHERE key='ip_salt'")
kill "$SRV"; wait "$SRV" 2>/dev/null
start || { echo "FAIL  service did not restart"; cat "$LOG"; exit 1; }
check "docs/08:8a restart: members survive" "1" "$(sql 'SELECT COUNT(*) FROM members')"
check "docs/08:8b restart: clicks survive" "1" "$(sql 'SELECT COUNT(*) FROM clicks')"
check "docs/08:8c restart: health ok" "true" "$(curl -s "localhost:$PORT/api/aff/health" | jq -r .ok)"
check "extra:8d restart: ip_salt unchanged (64 hex chars)" "$SALT_BEFORE" "$(sql "SELECT value FROM settings WHERE key='ip_salt'")"
check "extra:8e ip_salt is 64 hex chars" "64" "${#SALT_BEFORE}"

# extras beyond docs/08
check "extra:E1 unknown click_id on /api/join -> 422" "422" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "localhost:$PORT/api/join" -H 'content-type: application/json' -d '{"brand":"brand-one","telegram_id":1,"click_id":"ZZZZZZZZZZ"}')"
check "extra:E2 ...and no member was created" "1" "$(sql 'SELECT COUNT(*) FROM members')"
check "extra:E3 PRAGMA integrity_check" "ok" "$(sql 'PRAGMA integrity_check')"
check "extra:E4 journal_mode is wal" "wal" "$(sql 'PRAGMA journal_mode')"

kill "$SRV"; wait "$SRV" 2>/dev/null; SRV=
echo "-- service log --"
cat "$LOG"
echo "-- steps 9-11 (live gate bot) are manual and were NOT run by this script --"
if [ "$FAILS" -eq 0 ]; then echo "RESULT: ALL $STEP CHECKS PASSED"; else echo "RESULT: $FAILS OF $STEP CHECKS FAILED"; exit 1; fi
