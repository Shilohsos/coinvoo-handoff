#!/usr/bin/env bash
# Phase 3 proof (docs/08 "Phase 3" + DIRECTIVE-PHASE-3 §7). Builds a FIXTURE database (hand-checkable rows +
# 5,000 synthetic events + 3,181 members), boots the real service on it, and drives it with curl -u.
# Prints a numbered PASS/FAIL list and exits non-zero on any failure. Never touches a live database.
set -u
cd "$(dirname "$0")/.."

DB="${DB_PATH:-/tmp/coinvoo-proof3.db}"
PORT="${PORT:-8772}"
COPY=/tmp/coinvoo-verify.db
COPY_PORT=8780
LOG=/tmp/coinvoo-proof3.log
case "$DB" in /tmp/*) ;; *) echo "refusing: DB_PATH must be under /tmp (fixture database only)"; exit 2;; esac
rm -f "$DB" "$DB-wal" "$DB-shm" "$COPY" "$COPY-wal" "$COPY-shm" "$LOG"

export PUBLIC_BASE=https://coinvoo.example ADMIN_USER=admin ADMIN_PASS=pass
export BACKUP_DIR=off  # phase 6: the backup defaults to /var/backups/coinvoo; a proof run must never write there
export BRAND_ONE_BOT_USERNAME=coinvoo_test_bot BRAND_TWO_BOT_USERNAME=coinvoo_echo_test_bot
export BOTDB_SNAPSHOT=/nonexistent/botdb-snapshot.db WORKER_INTERVAL_MS=2000
unset JOIN_KEY PARALLEL_FORWARD JOINVOO_PB

FAILS=0; STEP=0; SRV=; SRV2=
check() { STEP=$((STEP + 1))
  if [ "$2" = "$3" ]; then printf 'PASS %2d  %s\n' "$STEP" "$1"
  else printf 'FAIL %2d  %s\n        expected: %s\n        actual:   %s\n' "$STEP" "$1" "$2" "$3"; FAILS=$((FAILS + 1)); fi; }
sql() { node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  for (const r of db.prepare(process.argv[2]).all()) console.log(Object.values(r).join("|"));
' "${2:-$DB}" "$1"; }
cu() { curl -s -u admin:pass "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
boot() { # boot <db> <port> -> pid in $PID
  DB_PATH="$1" PORT="$2" node src/server.js >>"$LOG" 2>&1 & PID=$!
  for _ in $(seq 1 50); do curl -s "localhost:$2/api/aff/health" >/dev/null 2>&1 && return 0; sleep 0.1; done; return 1; }
trap '[ -n "$SRV" ] && kill "$SRV" 2>/dev/null; [ -n "$SRV2" ] && kill "$SRV2" 2>/dev/null' EXIT

echo "== coinvoo phase 3 proof  fixture-db=$DB port=$PORT node=$(node --version)"

# Fixture: migrated database + 9 hand-written rows + 5,000 synthetic events.
DB_PATH="$DB" node --no-warnings --input-type=module -e '
  import { loadConfig } from "./src/config.js"; import { openDb, migrate } from "./src/db.js";
  import { seedDashFixture, seedBulk } from "./test/helpers.js";
  const config = loadConfig(process.env); const db = openDb(config.dbPath); migrate(db, { env: config.brandSeed });
  seedDashFixture(db); seedBulk(db, { events: 4991, members: 3181 }); db.close();'
echo "fixture: members=$(sql 'SELECT COUNT(*) FROM members') events=$(sql 'SELECT COUNT(*) FROM events') clicks=$(sql 'SELECT COUNT(*) FROM clicks')"
boot "$DB" "$PORT" || { echo "FAIL  service did not start"; cat "$LOG"; exit 1; }; SRV=$PID

# 1. auth
UNAUTH=""
for p in /dash /dash/members /dash/members/1 /dash/events /dash/events/e1 /dash/links /api/members /api/members/1 /api/events /api/events/e1 /api/clicks; do
  UNAUTH="$UNAUTH $(code "localhost:$PORT$p")"; done
check "401 without credentials on all 11 protected GET paths" " 401 401 401 401 401 401 401 401 401 401 401" "$UNAUTH"
check "401 carries WWW-Authenticate: Basic realm=\"coinvoo\"" 'www-authenticate: Basic realm="coinvoo"' "$(curl -si "localhost:$PORT/dash" | tr -d '\r' | grep -i '^www-authenticate')"
check "401 on unauthenticated POSTs (links, attach, api attach)" "401 401 401" "$(code -X POST "localhost:$PORT/dash/links") $(code -X POST "localhost:$PORT/dash/events/e5/attach") $(code -X POST "localhost:$PORT/api/events/e5/attach")"
check "wrong password -> 401" "401" "$(code -u admin:nope "localhost:$PORT/dash")"
check "with credentials: /dash, /dash/members, /dash/events, /dash/links -> 200" "200 200 200 200" \
  "$(code -u admin:pass "localhost:$PORT/dash") $(code -u admin:pass "localhost:$PORT/dash/members") $(code -u admin:pass "localhost:$PORT/dash/events") $(code -u admin:pass "localhost:$PORT/dash/links")"
check "public routes stay public: /api/aff/health, /api/aff/stats, /c/<unknown>" "200 200 404" \
  "$(code "localhost:$PORT/api/aff/health") $(code "localhost:$PORT/api/aff/stats") $(code "localhost:$PORT/c/ZZZZZZZZZZ")"

# 2. overview numbers == SQL (the two oracle queries are printed)
cu "localhost:$PORT/dash?period=7d&brand=brand-one" > /tmp/coinvoo-proof3-overview.html
cat <<'EOT'
-- oracle query 1 (funnel + quality + money, one grouped read of events) --
SELECT kind, state, currency, COUNT(*), COALESCE(SUM(amount),0) FROM events
 WHERE brand_id = :b AND received_at >= :start AND received_at < :end GROUP BY kind, state, currency;
-- oracle query 2 (joins and clicks; a click is one row of click_opens) --
SELECT (SELECT COUNT(*) FROM members WHERE brand_id=:b AND joined_at>=:start AND joined_at<:end),
       (SELECT COUNT(*) FROM click_opens WHERE brand_id=:b AND is_bot=0 AND opened_at>=:start AND opened_at<:end);
EOT
OVR=$(DB="$DB" node --no-warnings --input-type=module -e '
  import { DatabaseSync } from "node:sqlite"; import { readFileSync } from "node:fs";
  const html = readFileSync("/tmp/coinvoo-proof3-overview.html", "utf8");
  const dash = Object.fromEntries([...html.matchAll(/data-metric="([a-z_]+)" data-value="([^"]*)"/g)].map((m) => [m[1], Number(m[2])]));
  const db = new DatabaseSync(process.env.DB, { readOnly: true });
  const DAY = 86400000, now = Date.now(), today = Math.floor((now + 3600000) / DAY) * DAY - 3600000;
  const start = today - 6 * DAY, end = today + DAY;
  const rows = db.prepare("SELECT kind, state, currency, COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM events WHERE brand_id = 1 AND received_at >= ? AND received_at < ? GROUP BY kind, state, currency").all(start, end);
  const sum = (f) => rows.filter(f).reduce((a, r) => a + r.n, 0);
  const usd = (st) => rows.filter((r) => r.currency === "USD" && ["ftd","dep"].includes(r.kind) && st.includes(r.state)).reduce((a, r) => a + r.amt, 0);
  const one = (q) => Object.values(db.prepare(q).get(start, end))[0];
  const sqlv = {
    clicks: one("SELECT COUNT(*) FROM click_opens WHERE brand_id = 1 AND is_bot = 0 AND opened_at >= ? AND opened_at < ?"),
    joins: one("SELECT COUNT(*) FROM members WHERE brand_id = 1 AND joined_at >= ? AND joined_at < ?"),
    regs: sum((r) => r.kind === "reg" && r.state !== "ignored"), ftds: sum((r) => r.kind === "ftd" && r.state !== "ignored"),
    redeps: sum((r) => r.kind === "dep" && r.state !== "ignored"), revenue: usd(["matched"]), unattributed: usd(["parked","expired"]),
    matched: sum((r) => r.state === "matched"), parked: sum((r) => r.state === "parked"), expired: sum((r) => r.state === "expired"), ignored: sum((r) => r.state === "ignored")
  };
  let bad = 0;
  for (const [k, v] of Object.entries(sqlv)) { const ok = Math.abs(dash[k] - v) < 1e-9; if (!ok) bad++; console.log(`${ok ? "ok  " : "DIFF"} ${k.padEnd(13)} dashboard=${String(dash[k]).padEnd(10)} sql=${v}`); }
  console.log(`RESULT ${bad === 0 ? "EQUAL" : "DIFFERENT"}`);')
echo "$OVR" | sed '/^RESULT/d'
check "overview (7d, brand-one) equals direct SQL on all 11 numbers" "RESULT EQUAL" "$(echo "$OVR" | grep '^RESULT')"
HTML=$(cat /tmp/coinvoo-proof3-overview.html)
check "attribution quality block present (matched/parked/expired/ignored)" "4" "$(echo "$HTML" | grep -o 'data-metric="\(matched\|parked\|expired\|ignored\)"' | wc -l | tr -d ' ')"
check "spend, cost/join, cost/FTD, ROI render — with no spend entered" "4" "$(echo "$HTML" | grep -o '\(Spend\|Cost / join\|Cost / FTD\|ROI\)</div><div class="tv"[^>]*>—' | wc -l | tr -d ' ')"
check "daily_rollup (worker) agrees with the dashboard for today" "ok" "$(sleep 2.5; T=$(cu "localhost:$PORT/dash?period=today&brand=brand-one" | grep -o 'data-metric="\(clicks\|joins\|regs\|ftds\|redeps\|revenue\)" data-value="[^"]*"' | sed 's/.*data-value="\([^"]*\)"/\1/' | tr '\n' ' ' | sed 's/ $//'); R=$(sql "SELECT clicks||' '||joins||' '||regs||' '||ftds||' '||redeps||' '||CAST(revenue AS INTEGER) FROM daily_rollup WHERE brand_id=1 ORDER BY day DESC LIMIT 1"); [ "$T" = "$R" ] && echo ok || echo "dash=[$T] rollup=[$R]")"

# 3. members
check "search by telegram id" "1003" "$(cu "localhost:$PORT/api/members?q=1003" | jq -r '[.members[].telegram_id]|join(",")')"
check "search by username (@ prefix, partial)" "1003" "$(cu "localhost:$PORT/api/members?q=%40camp_chi" | jq -r '[.members[].telegram_id]|join(",")')"
check "search by broker id" "1003" "$(cu "localhost:$PORT/api/members?q=197000003" | jq -r '[.members[].telegram_id]|join(",")')"
check "default sort is total, descending (first 50 rows)" "true" "$(cu "localhost:$PORT/api/members?brand=brand-one&limit=50" | jq -r '[.members[].total] as $t | ($t == ($t|sort|reverse))')"
check "pagination: page 1 and page 2 are 50 rows each" "50 50" "$(cu "localhost:$PORT/dash/members?sort=joined" | grep -o '<tr><td>' | wc -l | tr -d ' ') $(cu "localhost:$PORT/dash/members?sort=joined&page=2" | grep -o '<tr><td>' | wc -l | tr -d ' ')"
check "pagination: page 2 does not repeat page 1" "100" "$(cu "localhost:$PORT/api/members?limit=50&page=1&sort=joined" | jq -r '[.members[].id]' > /tmp/p1.json; cu "localhost:$PORT/api/members?limit=50&page=2&sort=joined" | jq -r '[.members[].id]' > /tmp/p2.json; jq -s 'add|unique|length' /tmp/p1.json /tmp/p2.json)"

# 4. events + manual attach
check "parked tab shows only parked rows" "parked" "$(cu "localhost:$PORT/api/events?state=parked&limit=200" | jq -r '[.events[].state]|unique|join(",")')"
check "parked tab renders a reason and an Attach form" "ok" "$(P=$(cu "localhost:$PORT/dash/events?tab=parked"); echo "$P" | grep -q 'no member for trader_id' && echo "$P" | grep -q '<summary>Attach</summary>' && echo ok || echo missing)"
check "parked count before attach (e5 is parked)" "parked" "$(sql "SELECT state FROM events WHERE event_id='e5'")"
check "cross-site attach is refused (Origin: evil)" "403" "$(code -u admin:pass -H 'Origin: https://evil.example' -d 'member=1004&note=x' "localhost:$PORT/dash/events/e5/attach")"
check "attach without a note is refused, event stays parked" "notice=note_required parked" \
  "$(L=$(curl -s -o /dev/null -w '%{redirect_url}' -u admin:pass --data-urlencode 'member=1004' --data-urlencode 'note=' --data-urlencode 'back=/dash/events?tab=parked' "localhost:$PORT/dash/events/e5/attach"); echo "$(echo "$L" | grep -o 'notice=[a-z_]*') $(sql "SELECT state FROM events WHERE event_id='e5'")")"
check "attach with a note -> 303 notice=attached" "303 notice=attached" \
  "$(curl -s -o /dev/null -w '%{http_code} ' -u admin:pass --data-urlencode 'member=@chan_ngozi' --data-urlencode 'note=confirmed in DM' --data-urlencode 'back=/dash/events?tab=parked' "localhost:$PORT/dash/events/e5/attach")$(curl -s -o /dev/null -w '' -u admin:pass "localhost:$PORT/dash"; sql "SELECT 'notice=attached' WHERE EXISTS (SELECT 1 FROM events WHERE event_id='e5' AND state='matched')")"
check "event is matched, attribution is manual/100 with the note" "matched|manual|100|confirmed in DM" \
  "$(sql "SELECT e.state||'|'||a.path||'|'||a.confidence||'|'||a.note FROM events e JOIN attributions a ON a.event_id=e.event_id WHERE e.event_id='e5'")"
check "attribution_log carries the note" "manual_attach: confirmed in DM" "$(sql "SELECT reason FROM attribution_log WHERE event_id='e5' AND reason LIKE 'manual_attach%'")"
check "a second attach is refused (409 not_parked)" "409" "$(code -u admin:pass -H 'content-type: application/json' -d '{"member_id":1,"note":"again"}' "localhost:$PORT/api/events/e5/attach")"
check "e5 is gone from the parked tab" "0" "$(cu "localhost:$PORT/api/events?state=parked&q=197999999" | jq -r '.total')"

# 5. escaping + redaction
MP=$(cu "localhost:$PORT/dash/members/$(sql "SELECT id FROM members WHERE telegram_id=1001")")
check "<script> first name is rendered escaped (&lt;script&gt;)" "escaped" "$(echo "$MP" | grep -q '&lt;script&gt;alert(1)&lt;/script&gt;' && ! echo "$MP" | grep -q '<script>alert(1)' && echo escaped || echo UNESCAPED)"
RAW=$(cu "localhost:$PORT/dash/events/e6")
check "raw viewer redacts IP and token fields from payloads" "redacted" "$(echo "$RAW" | grep -q '\[redacted\]' && ! echo "$RAW" | grep -q '203.0.113.9' && ! echo "$RAW" | grep -q 'sekret-token' && echo redacted || echo LEAK)"
check "CSP header with a per-response script nonce" "ok" "$(curl -si -u admin:pass "localhost:$PORT/dash" | tr -d '\r' | grep -i '^content-security-policy' | grep -q "script-src 'nonce-" && echo ok || echo missing)"

# 6. links
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -u admin:pass --data-urlencode 'brand=brand-one' --data-urlencode 'campaign=NG_Proof' --data-urlencode 'adset=18-34' --data-urlencode 'ad=vid_77' "localhost:$PORT/dash/links")
TOK=$(echo "$LOC" | grep -o 'minted=[0-9A-Z]*' | cut -d= -f2)
check "link builder mints a 10-char token and redirects to the result" "10" "${#TOK}"
LP=$(cu "localhost:$PORT/dash/links?minted=$TOK")
check "result shows the short URL and the t.me destination" "ok" "$(echo "$LP" | grep -q "https://coinvoo.example/c/$TOK" && echo "$LP" | grep -q "https://t.me/coinvoo_test_bot?start=c_$TOK" && echo ok || echo missing)"
check "recent clicks lists the new link" "ok" "$(echo "$LP" | grep -q 'NG_Proof / 18-34 / vid_77' && echo ok || echo missing)"

# 7. performance, 5,000-event fixture
T_EV=$(curl -s -o /dev/null -w '%{time_total}' -u admin:pass "localhost:$PORT/dash/events"); T_EV=$(curl -s -o /dev/null -w '%{time_total}' -u admin:pass "localhost:$PORT/dash/events")
T_OV=$(curl -s -o /dev/null -w '%{time_total}' -u admin:pass "localhost:$PORT/dash?period=30d")
T_MB=$(curl -s -o /dev/null -w '%{time_total}' -u admin:pass "localhost:$PORT/dash/members")
echo "timings (curl time_total): /dash/events=${T_EV}s  /dash?period=30d=${T_OV}s  /dash/members=${T_MB}s   [events in db: $(sql 'SELECT COUNT(*) FROM events')]"
check "/dash/events under 800 ms" "ok" "$(awk -v t="$T_EV" 'BEGIN{print (t < 0.8) ? "ok" : "slow"}')"
check "/dash under 400 ms" "ok" "$(awk -v t="$T_OV" 'BEGIN{print (t < 0.4) ? "ok" : "slow"}')"

# 8. backup / restore: copy the database as `.backup` would, run three counts, serve the copy (directive §0.9)
EV_N=$(sql 'SELECT COUNT(*) FROM events'); MB_N=$(sql 'SELECT COUNT(*) FROM members'); REV=$(sql "SELECT ROUND(SUM(amount),2) FROM events WHERE state='matched' AND currency='USD' AND kind IN ('ftd','dep')")
node --no-warnings -e 'const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(process.argv[1]); d.exec("PRAGMA busy_timeout=5000"); d.exec("VACUUM INTO '"'$COPY'"'"); d.close()' "$DB"
echo "backup copy: $(ls -la $COPY | awk '{print $5}') bytes -> $COPY"
check "restored copy: events, members, matched USD revenue — three counts equal" "$EV_N $MB_N $REV" "$(sql 'SELECT COUNT(*) FROM events' "$COPY") $(sql 'SELECT COUNT(*) FROM members' "$COPY") $(sql "SELECT ROUND(SUM(amount),2) FROM events WHERE state='matched' AND currency='USD' AND kind IN ('ftd','dep')" "$COPY")"
check "restored copy: PRAGMA integrity_check" "ok" "$(sql 'PRAGMA integrity_check' "$COPY")"
boot "$COPY" "$COPY_PORT" || { echo "FAIL copy did not start"; exit 1; }; SRV2=$PID
A=$(curl -s -u admin:pass "localhost:$PORT/dash?period=30d&brand=brand-one" | grep -o 'data-metric="[a-z_]*" data-value="[^"]*"' | sort)
B=$(curl -s -u admin:pass "localhost:$COPY_PORT/dash?period=30d&brand=brand-one" | grep -o 'data-metric="[a-z_]*" data-value="[^"]*"' | sort)
check "dashboard served from the restored copy shows identical numbers" "same" "$([ "$A" = "$B" ] && echo same || echo different)"
kill "$SRV2" 2>/dev/null; wait "$SRV2" 2>/dev/null; SRV2=

# 9. restart keeps everything; integrity
kill "$SRV"; wait "$SRV" 2>/dev/null; SRV=
boot "$DB" "$PORT" || { echo "FAIL restart"; exit 1; }; SRV=$PID
check "restart: events and members unchanged, dashboard serves" "$EV_N $MB_N 200" "$(sql 'SELECT COUNT(*) FROM events') $(sql 'SELECT COUNT(*) FROM members') $(code -u admin:pass "localhost:$PORT/dash")"
check "PRAGMA integrity_check" "ok" "$(sql 'PRAGMA integrity_check')"
check "no dependency, no build step, no new migration needed" "0 5" "$(grep -c '"dependencies"' package.json | tr -d ' ') $(ls migrations | wc -l | tr -d ' ')"

echo "-- service log (errors only) --"
grep -E 'ERROR|FATAL' "$LOG" || echo "(none)"
echo "-- not run here: production data copy, Caddy/trk host, screenshots (see PR) --"
if [ "$FAILS" -eq 0 ]; then echo "RESULT: ALL $STEP CHECKS PASSED"; else echo "RESULT: $FAILS OF $STEP CHECKS FAILED"; exit 1; fi
