#!/usr/bin/env bash
# Phase 4 proof (docs/08 "Phase 4" + DIRECTIVE-PHASE-4 §7). Runs the real service on scratch databases under /tmp.
# The directive's fixture is built THROUGH THE SERVICE (mint links, open them, post joins and postbacks, enter spend),
# then the campaigns screen, spend upsert, the three CSVs and the streaming bound are checked. A synthetic database with
# the shape of the live copy (one LIVE_SMOKE link, 3,408 members, 168 events, no spend) is rendered too.
# Prints a numbered PASS/FAIL list and exits non-zero on any failure. Never touches a live database.
set -u
cd "$(dirname "$0")/.."

DB="${DB_PATH:-/tmp/coinvoo-proof4.db}"
PORT="${PORT:-8773}"
BULK_DB=/tmp/coinvoo-proof4-bulk.db;  BULK_PORT=8774
LIVE_DB=/tmp/coinvoo-proof4-live.db;  LIVE_PORT=8775
OUT=/tmp/coinvoo-proof4-csv
LOG=/tmp/coinvoo-proof4.log
case "$DB" in /tmp/*) ;; *) echo "refusing: DB_PATH must be under /tmp (scratch databases only)"; exit 2;; esac
rm -rf "$OUT" "$LOG"; mkdir -p "$OUT"
for f in "$DB" "$BULK_DB" "$LIVE_DB"; do rm -f "$f" "$f-wal" "$f-shm"; done

export PUBLIC_BASE=https://coinvoo.example ADMIN_USER=admin ADMIN_PASS=pass
export BACKUP_DIR=off  # phase 6: the backup defaults to /var/backups/coinvoo; a proof run must never write there
export BRAND_ONE_BOT_USERNAME=coinvoo_test_bot BRAND_TWO_BOT_USERNAME=coinvoo_echo_test_bot
export BOTDB_SNAPSHOT=/nonexistent/botdb-snapshot.db
unset JOIN_KEY PARALLEL_FORWARD JOINVOO_PB

FAILS=0; STEP=0; PIDS=""
check() { STEP=$((STEP + 1))
  if [ "$2" = "$3" ]; then printf 'PASS %2d  %s\n' "$STEP" "$1"
  else printf 'FAIL %2d  %s\n        expected: %s\n        actual:   %s\n' "$STEP" "$1" "$2" "$3"; FAILS=$((FAILS + 1)); fi; }
sql() { node --no-warnings -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  for (const r of db.prepare(process.argv[2]).all()) console.log(Object.values(r).join("|"));
' "${2:-$DB}" "$1"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
cu() { curl -s -u admin:pass "$@"; }
boot() { # boot <db> <port>  -> $PID
  DB_PATH="$1" PORT="$2" node src/server.js >>"$LOG" 2>&1 & PID=$!; PIDS="$PIDS $PID"
  for _ in $(seq 1 50); do curl -s "localhost:$2/api/aff/health" >/dev/null 2>&1 && return 0; sleep 0.1; done; return 1; }
trap 'for p in $PIDS; do kill "$p" 2>/dev/null; done' EXIT
TODAY=$(node -e 'console.log(new Date(Date.now()+3600000).toISOString().slice(0,10))')

echo "== coinvoo phase 4 proof  db=$DB port=$PORT node=$(node --version)  lagos-today=$TODAY"
boot "$DB" "$PORT" || { echo "FAIL  service did not start"; cat "$LOG"; exit 1; }; SRV=$PID

# ---- 1. auth ---------------------------------------------------------------------------------------------------
U=""; for p in /dash/campaigns /api/spend /api/export/members.csv /api/export/events.csv /api/export/campaigns.csv; do U="$U $(code "localhost:$PORT$p")"; done
check "401 without credentials on /dash/campaigns, /api/spend and the three exports" " 401 401 401 401 401" "$U"
check "401 on unauthenticated POST /api/spend" "401" "$(code -X POST -H 'content-type: application/json' -d '{}' "localhost:$PORT/api/spend")"

# ---- 2. the directive's fixture, built through the service -----------------------------------------------------
mint() { cu -X POST "localhost:$PORT/api/links" -H 'content-type: application/json' -d "$1" | jq -r .token; }
open() { curl -s -o /dev/null "localhost:$PORT/c/$1"; }
TA=(); TB=(); TC=(); TN=()
for i in 1 2 3; do t=$(mint '{"brand":"brand-one","campaign":"NG_A","adset":"a1","ad":"ad_a"}'); open "$t"; TA+=("$t"); done
for i in 1 2 3; do t=$(mint '{"brand":"brand-one","campaign":"NG_B","adset":"b1","ad":"ad_b"}'); open "$t"; TB+=("$t"); done
for i in 1 2;   do t=$(mint '{"brand":"brand-one","campaign":"NG_C","adset":"c1","ad":"ad_c"}'); open "$t"; TC+=("$t"); done
for i in 1 2;   do t=$(mint '{"brand":"brand-one"}'); open "$t"; TN+=("$t"); done
check "10 links minted and opened (3 + 3 + 2 campaign links, 2 with no campaign)" "10|10|2" \
  "$(sql "SELECT COUNT(*)||'|'||COUNT(clicked_at)||'|'||SUM(campaign IS NULL) FROM clicks")"
join() { curl -s -X POST "localhost:$PORT/api/join" -H 'content-type: application/json' -d "{\"brand\":\"brand-one\",\"telegram_id\":$1,\"username\":\"$2\",\"first_name\":\"$3\",\"click_id\":\"$4\",\"source\":\"bot:start\"}" >/dev/null; }
join 9001 doe   'Doe, John' "${TA[0]}"
join 9002 two   'Two'       "${TA[1]}"
join 9003 three 'Three'     "${TB[0]}"
join 9004 four  'Four'      "${TN[0]}"
pb() { curl -s "localhost:$PORT/api/aff?$1" >/dev/null; }
pb "status=ftd&trader_id=197100001&amount=50&event_id=p-f1&afftrack=9001"
pb "status=ftd&trader_id=197100003&amount=50&event_id=p-f2&afftrack=9003"
pb "status=dep&trader_id=197100001&amount=10&event_id=p-f3&afftrack=9001"
pb "status=dep&trader_id=197999999&amount=25&event_id=p-parked"
pb "status=ftd&trader_id=1&amount=100&event_id=p-stub&afftrack=TEST-RECON-1"
check "4 members joined; 3 events matched, 1 parked, 1 ignored (stub)" "4|3|1|1" \
  "$(sql "SELECT (SELECT COUNT(*) FROM members)||'|'||(SELECT COUNT(*) FROM events WHERE state='matched')||'|'||(SELECT COUNT(*) FROM events WHERE state='parked')||'|'||(SELECT COUNT(*) FROM events WHERE state='ignored')")"

# ---- 3. spend API: upsert replaces, negative refused ------------------------------------------------------------
SP='{"brand":"brand-one","day":"'$TODAY'","campaign":"NG_A","adset":"a1","ad":"ad_a","currency":"USD","note":"TikTok"}'
R1=$(cu -X POST "localhost:$PORT/api/spend" -H 'content-type: application/json' -d "${SP%\}},\"spend\":120.5}"); echo "$R1"
R2=$(cu -X POST "localhost:$PORT/api/spend" -H 'content-type: application/json' -d "${SP%\}},\"spend\":100}"); echo "$R2"
check "POST /api/spend twice (120.5 then 100): same row id, latest amount" "same 100" \
  "$([ "$(echo "$R1" | jq .spend.id)" = "$(echo "$R2" | jq .spend.id)" ] && echo same || echo different) $(echo "$R2" | jq -r .spend.spend)"
check "one costs row for the key (replaced, not added to 220.5)" "1|100" "$(sql "SELECT COUNT(*)||'|'||CAST(MAX(spend) AS INTEGER) FROM costs")"
check "spend -5 -> 422 negative_spend, nothing stored" "422 negative_spend 1" \
  "$(B=$(curl -s -w '\n%{http_code}' -u admin:pass -X POST "localhost:$PORT/api/spend" -H 'content-type: application/json' -d '{"brand":"brand-one","day":"'$TODAY'","spend":-5}'); echo "$(echo "$B" | tail -1) $(echo "$B" | head -1 | jq -r .error) $(sql 'SELECT COUNT(*) FROM costs')")"
check "malformed day -> 400" "400" "$(code -u admin:pass -X POST "localhost:$PORT/api/spend" -H 'content-type: application/json' -d '{"brand":"brand-one","day":"2026-02-30","spend":1}')"
check "GET /api/spend lists the row (newest day first)" "1 $TODAY" "$(cu "localhost:$PORT/api/spend" | jq -r '"\(.count) \(.spend[0].day)"')"

# ---- 4. campaigns screen vs hand-computed values, totals vs independent SQL ---------------------------------------
cu "localhost:$PORT/dash/campaigns?period=7d&brand=brand-one" > /tmp/coinvoo-proof4-campaigns.html
cu "localhost:$PORT/dash?period=7d&brand=brand-one" > /tmp/coinvoo-proof4-overview.html
cat <<'EOT'
-- independent SQL, query 1 (clicks and joins: no campaign grouping, straight table counts; a click is one row of click_opens) --
SELECT (SELECT COUNT(*) FROM click_opens WHERE brand_id=1 AND is_bot=0 AND opened_at >= :start AND opened_at < :end) AS clicks,
       (SELECT COUNT(*) FROM members WHERE brand_id=1 AND joined_at  >= :start AND joined_at  < :end) AS joins;
-- independent SQL, query 2 (FTDs, revenue, spend) --
SELECT (SELECT COUNT(*)                   FROM events WHERE brand_id=1 AND state='matched' AND kind='ftd' AND received_at >= :start AND received_at < :end) AS ftds,
       (SELECT COALESCE(SUM(amount),0)    FROM events WHERE brand_id=1 AND state='matched' AND kind IN ('ftd','dep') AND currency='USD' AND received_at >= :start AND received_at < :end) AS revenue,
       (SELECT COALESCE(SUM(spend),0)     FROM costs  WHERE brand_id=1 AND currency='USD' AND day >= :from_day AND day <= :to_day) AS spend;
EOT
CMP=$(DB="$DB" node --no-warnings --input-type=module -e '
  import { DatabaseSync } from "node:sqlite"; import { readFileSync } from "node:fs";
  const dec = (s) => s.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,"\"").replace(/&#39;/g,"\x27").replace(/&amp;/g,"&");
  const html = readFileSync("/tmp/coinvoo-proof4-campaigns.html", "utf8");
  const rows = {};
  for (const m of html.matchAll(/<tr data-row="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g))
    rows[dec(m[1])] = Object.fromEntries([...m[2].matchAll(/data-col="([a-z_]+)" data-value="([^"]*)"/g)].map((c) => [c[1], c[2] === "" ? null : Number(c[2])]));
  const want = {
    "NG_A|a1|ad_a": { clicks: 3, joins: 2, ftds: 1, revenue: 60, spend: 100, clicks_per_join: 1.5, cost_per_ftd: 100, roi: -40 },
    "NG_B|b1|ad_b": { clicks: 3, joins: 1, ftds: 1, revenue: 50, spend: null, clicks_per_join: 3, cost_per_ftd: null, roi: null },
    "NG_C|c1|ad_c": { clicks: 2, joins: 0, ftds: 0, revenue: 0, spend: null, clicks_per_join: null, cost_per_ftd: null, roi: null },
    "(none)||":     { clicks: 2, joins: 1, ftds: 0, revenue: 0, spend: null, clicks_per_join: 2, cost_per_ftd: null, roi: null },
    "total":        { clicks: 10, joins: 4, ftds: 2, revenue: 110, spend: 100, clicks_per_join: 2.5, cost_per_ftd: 50, roi: 10 }
  };
  let bad = 0;
  const cols = ["clicks","joins","clicks_per_join","ftds","revenue","spend","cost_per_ftd","roi"];
  console.log("row".padEnd(16) + cols.map((c) => c.padStart(16)).join(""));
  for (const [k, w] of Object.entries(want)) {
    const got = rows[k] || {};
    const ok = cols.every((c) => (got[c] ?? null) === w[c]);
    if (!ok) bad++;
    console.log((ok ? "ok  " : "DIFF") + k.padEnd(12) + cols.map((c) => String(got[c] ?? "—").padStart(16)).join(""));
  }
  console.log("ROWS " + (bad === 0 && Object.keys(rows).length === 5 ? "MATCH_HAND" : "DIFFER"));
  const db = new DatabaseSync(process.env.DB, { readOnly: true });
  const DAY = 86400000, now = Date.now(), today = Math.floor((now + 3600000) / DAY) * DAY - 3600000;
  const start = today - 6 * DAY, end = today + DAY, lab = (ms) => new Date(ms + 3600000).toISOString().slice(0, 10);
  const q1 = db.prepare("SELECT (SELECT COUNT(*) FROM click_opens WHERE brand_id=1 AND is_bot=0 AND opened_at >= ? AND opened_at < ?) AS clicks, (SELECT COUNT(*) FROM members WHERE brand_id=1 AND joined_at >= ? AND joined_at < ?) AS joins").get(start, end, start, end);
  const q2 = db.prepare("SELECT (SELECT COUNT(*) FROM events WHERE brand_id=1 AND state=\x27matched\x27 AND kind=\x27ftd\x27 AND received_at >= ? AND received_at < ?) AS ftds, (SELECT COALESCE(SUM(amount),0) FROM events WHERE brand_id=1 AND state=\x27matched\x27 AND kind IN (\x27ftd\x27,\x27dep\x27) AND currency=\x27USD\x27 AND received_at >= ? AND received_at < ?) AS revenue, (SELECT COALESCE(SUM(spend),0) FROM costs WHERE brand_id=1 AND currency=\x27USD\x27 AND day >= ? AND day <= ?) AS spend").get(start, end, start, end, lab(start), lab(end - 1));
  const sqlTotals = { ...q1, ...q2 };
  let diff = 0;
  for (const [k, v] of Object.entries(sqlTotals)) { const ok = rows.total[k] === v; if (!ok) diff++; console.log(`${ok ? "ok  " : "DIFF"} total.${k.padEnd(8)} screen=${String(rows.total[k]).padEnd(8)} sql=${v}`); }
  console.log("TOTALS " + (diff === 0 ? "EQUAL_SQL" : "DIFFER_SQL"));
  const ov = Object.fromEntries([...readFileSync("/tmp/coinvoo-proof4-overview.html","utf8").matchAll(/data-metric="([a-z_]+)" data-value="([^"]*)"/g)].map((m) => [m[1], Number(m[2])]));
  console.log(`OVERVIEW ${ov.revenue === rows.total.revenue && ov.joins === rows.total.joins && ov.clicks === rows.total.clicks && ov.cost_per_join === 25 && ov.cost_per_ftd === 50 && ov.roi === 10 ? "AGREES" : "DISAGREES"} (revenue ${ov.revenue}, joins ${ov.joins}, cost/join ${ov.cost_per_join}, cost/FTD ${ov.cost_per_ftd}, ROI ${ov.roi})`);
')
echo "$CMP" | grep -vE '^(ROWS|TOTALS|OVERVIEW)'
check "campaign rows (NG_A, NG_B, NG_C, (none)) and totals equal the hand-computed table" "ROWS MATCH_HAND" "$(echo "$CMP" | grep '^ROWS')"
check "totals row equals the independent SQL sums (clicks, joins, ftds, revenue, spend)" "TOTALS EQUAL_SQL" "$(echo "$CMP" | grep '^TOTALS')"
check "Overview agrees: revenue, joins, clicks, cost/join 25, cost/FTD 50, ROI 10" "OVERVIEW AGREES" "$(echo "$CMP" | grep '^OVERVIEW' | cut -d' ' -f1-2)"
H=$(cat /tmp/coinvoo-proof4-campaigns.html)
metric() { sed -n "s/.*data-metric=\"$1\" data-value=\"\([0-9]*\)\".*/\1/p" | head -1; }
check "attribution-quality block present on the campaigns screen (matched 3, parked 1, expired 0, ignored 1)" "3 1 0 1" \
  "$(echo "$H" | metric matched) $(echo "$H" | metric parked) $(echo "$H" | metric expired) $(echo "$H" | metric ignored)"
check "Campaigns link is in the nav" "1" "$(echo "$H" | grep -c '<a href="/dash/campaigns" class="on">Campaigns</a>')"

# ---- 5. the three CSVs ---------------------------------------------------------------------------------------------
for k in members events campaigns; do curl -s -D "$OUT/$k.hdr" -u admin:pass -o "$OUT/$k.csv" "localhost:$PORT/api/export/$k.csv?period=7d&brand=brand-one"; done
for k in members events campaigns; do echo "-- $k.csv (first 3 lines of $(($(wc -l < "$OUT/$k.csv" | tr -d ' ')))) --"; head -3 "$OUT/$k.csv" | tr -d '\r'; done
check "three CSVs: 200, text/csv; charset=utf-8, attachment filename coinvoo-<kind>-$TODAY.csv" "ok ok ok" \
  "$(for k in members events campaigns; do tr -d '\r' < "$OUT/$k.hdr" | grep -qi '^content-type: text/csv; charset=utf-8' && tr -d '\r' < "$OUT/$k.hdr" | grep -qi "^content-disposition: attachment; filename=\"coinvoo-$k-$TODAY.csv\"" && head -1 "$OUT/$k.hdr" | grep -q ' 200' && echo ok || echo BAD; done | tr '\n' ' ' | sed 's/ $//')"
check "streamed: Transfer-Encoding chunked, no Content-Length" "chunked" "$(tr -d '\r' < "$OUT/members.hdr" | grep -i '^transfer-encoding' | cut -d' ' -f2; tr -d '\r' < "$OUT/members.hdr" | grep -qi '^content-length' && echo HAS-CONTENT-LENGTH)"
check "header rows are the dashboard columns in snake_case" "ok" "$([ "$(head -1 "$OUT/members.csv" | tr -d '\r')" = 'joined,telegram,username,first_name,source,broker_id,ftd,re_deposits,total,last_event,path,currency' ] && [ "$(head -1 "$OUT/events.csv" | tr -d '\r')" = 'event_id,received,kind,amount,currency,trader_id,afftrack,country,state,ignore_reason,path,confidence,member,username,note' ] && [ "$(head -1 "$OUT/campaigns.csv" | tr -d '\r')" = 'campaign,ad_set,ad,clicks,joins,clicks_per_join,ftds,revenue,spend,cost_per_ftd,roi,brand,currency' ] && echo ok || echo differs)"
check "RFC 4180: the member named Doe, John is quoted" "1" "$(grep -c '"Doe, John"' "$OUT/members.csv" | tr -d ' ')"
check "row counts equal the dashboard counts (members 4, campaigns 4 rows, events = 5 stored)" "4 4 5" \
  "$(node --no-warnings -e 'const c=(f)=>{const t=require("fs").readFileSync(f,"utf8");let q=false,n=0;for(const ch of t){if(ch==="\""){q=!q}else if(ch==="\n"&&!q)n++}return n-1};console.log(c(process.argv[1]),c(process.argv[3]),c(process.argv[2]))' "$OUT/members.csv" "$OUT/events.csv" "$OUT/campaigns.csv")"
check "no PII beyond the dashboard: no IP, ssid, token, payload column" "clean" "$(cat "$OUT"/*.csv | grep -qiE 'ssid|api_token|payload|ip_hash|203\.0\.113' && echo LEAK || echo clean)"
check "bad filter is a JSON 400 before any CSV starts" "400 application/json" "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' -u admin:pass "localhost:$PORT/api/export/events.csv?state=bogus" | sed 's/;.*//')"

# ---- 6. streaming bound: 5,000 rows, peak RSS of the server process --------------------------------------------------
DB_PATH="$BULK_DB" node --no-warnings --input-type=module -e '
  import { loadConfig } from "./src/config.js"; import { openDb, migrate } from "./src/db.js";
  import { seedBulk } from "./test/helpers.js";
  const c = loadConfig(process.env); const db = openDb(c.dbPath); migrate(db, { env: c.brandSeed }); seedBulk(db, { events: 5000, members: 5000 }); db.close();'
boot "$BULK_DB" "$BULK_PORT" || { echo "FAIL bulk service did not start"; exit 1; }; BULK=$PID
hwm() { grep VmHWM "/proc/$1/status" | awk '{printf "%.0f", $2/1024}'; }
RSS0=$(hwm "$BULK")
for k in members events; do curl -s -D "$OUT/bulk-$k.hdr" -u admin:pass -o "$OUT/bulk-$k.csv" "localhost:$BULK_PORT/api/export/$k.csv?period=all"; done
RSS1=$(hwm "$BULK")
echo "bulk export: members.csv=$(($(wc -l < "$OUT/bulk-members.csv")-1)) rows $(wc -c < "$OUT/bulk-members.csv" | tr -d ' ') bytes; events.csv=$(($(wc -l < "$OUT/bulk-events.csv")-1)) rows $(wc -c < "$OUT/bulk-events.csv" | tr -d ' ') bytes; server RSS before=${RSS0} MB peak=${RSS1} MB"
check "5,000-row exports: members and events each 5,000 rows" "5000 5000" "$(($(wc -l < "$OUT/bulk-members.csv")-1)) $(($(wc -l < "$OUT/bulk-events.csv")-1))"
check "5,000-row exports are chunked" "chunked chunked" "$(tr -d '\r' < "$OUT/bulk-members.hdr" | grep -i '^transfer-encoding' | cut -d' ' -f2) $(tr -d '\r' < "$OUT/bulk-events.hdr" | grep -i '^transfer-encoding' | cut -d' ' -f2)"
check "server peak RSS (VmHWM) under 150 MB after both exports" "ok" "$([ "$RSS1" -lt 150 ] && echo ok || echo "${RSS1}MB")"
T=$(curl -s -o /dev/null -w '%{time_total}' -u admin:pass "localhost:$BULK_PORT/dash/campaigns?period=30d"); T=$(curl -s -o /dev/null -w '%{time_total}' -u admin:pass "localhost:$BULK_PORT/dash/campaigns?period=30d")
echo "timing: /dash/campaigns on 5,000 events / 5,000 members = ${T}s"
check "/dash/campaigns under 600 ms on 5,000 events" "ok" "$(awk -v t="$T" 'BEGIN{print (t < 0.6) ? "ok" : "slow"}')"

# ---- 7. live-shaped database: 1 LIVE_SMOKE link, 3,408 members, 168 events, zero spend ----------------------------------
DB_PATH="$LIVE_DB" node --no-warnings --input-type=module -e '
  import { loadConfig } from "./src/config.js"; import { openDb, migrate } from "./src/db.js";
  const c = loadConfig(process.env); const db = openDb(c.dbPath); migrate(db, { env: c.brandSeed });
  const now = Date.now(), H = 3600000;
  db.prepare("INSERT INTO clicks (click_id, brand_id, campaign, adset, ad, created_at, clicked_at) VALUES (?, 1, ?, ?, ?, ?, ?)").run("LIVESMOKE1", "LIVE_SMOKE", "master_tap", "v1", now - 20 * H, now - H);
  db.prepare("INSERT INTO click_opens (click_id, brand_id, opened_at) VALUES (?, 1, ?)").run("LIVESMOKE1", now - H);
  db.exec("BEGIN");
  const mem = db.prepare("INSERT INTO members (brand_id, telegram_id, username, joined_at, join_source) VALUES (1, ?, ?, ?, \x27backfill:botdb\x27)");
  const ids = []; for (let i = 0; i < 3408; i++) ids.push(Number(mem.run(6000000000 + i, "u" + i, now - (i % 25) * 86400000).lastInsertRowid));
  const ev = db.prepare("INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, ignore_reason, matched_member_id, matched_at, forward_state) VALUES (?, 1, \x27affstore\x27, ?, ?, ?, ?, \x27USD\x27, \x27{}\x27, ?, ?, ?, ?, ?, \x27sent\x27)");
  const att = db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at) VALUES (?, ?, ?, ?, ?)");
  const states = [...Array(89).fill("matched"), ...Array(40).fill("parked"), ...Array(37).fill("expired"), ...Array(2).fill("ignored")];
  states.forEach((st, i) => { const kind = ["reg","ftd","dep"][i % 3], t = now - Math.floor(i / 168 * 20 * 86400000), mid = st === "matched" ? ids[i * 5] : null;
    ev.run("live-" + i, kind, kind, st === "ignored" ? "1" : String(197400000 + i), kind === "reg" ? null : 20 + i, t, st, st === "ignored" ? "stub_guard" : null, mid, mid ? t : null);
    if (st === "matched") att.run("live-" + i, mid, "trader_id", 90, t); else if (st !== "parked") att.run("live-" + i, null, "none", 0, t); });
  db.exec("UPDATE events SET forward_state = \x27none\x27 WHERE state = \x27parked\x27"); db.exec("COMMIT"); db.close();'
boot "$LIVE_DB" "$LIVE_PORT" || { echo "FAIL live-shape service did not start"; exit 1; }
LP=$(curl -s -u admin:pass "localhost:$LIVE_PORT/dash/campaigns?period=30d&brand=brand-one")
check "live-shaped DB: /dash/campaigns 200 with the LIVE_SMOKE row, the (none) row and a totals row" "(none)|| LIVE_SMOKE|master_tap|v1 total" \
  "$(echo "$LP" | grep -o '<tr data-row="[^"]*"' | sed 's/<tr data-row="//; s/"$//' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')"
check "live-shaped DB: empty spend state, dashes (not 0, NaN or Infinity) in Spend / Cost-FTD / ROI" "ok" \
  "$(echo "$LP" | grep -q 'No spend entered for' && echo "$LP" | grep -q 'No spend entered in this period' && ! echo "$LP" | grep -qE 'NaN|Infinity|undefined' && echo ok || echo BAD)"
check "live-shaped DB: quality block 89 / 40 / 37 / 2 and matched 53.6 %" "89 40 37 2 53.6" \
  "$(echo "$LP" | metric matched) $(echo "$LP" | metric parked) $(echo "$LP" | metric expired) $(echo "$LP" | metric ignored) $(echo "$LP" | grep -o 'Matched</span><span class="pc">[0-9.]* %' | grep -o '[0-9.]* %' | sed 's/ %//')"
curl -s -u admin:pass "localhost:$LIVE_PORT/api/export/campaigns.csv?period=30d&brand=brand-one" | tr -d '\r' > "$OUT/live-campaigns.csv"
echo "-- live-shaped campaigns.csv --"; cat "$OUT/live-campaigns.csv"
check "live-shaped DB: campaigns.csv has the header, LIVE_SMOKE and (none)" "3 1 1" "$(wc -l < "$OUT/live-campaigns.csv" | tr -d ' ') $(grep -c '^LIVE_SMOKE,' "$OUT/live-campaigns.csv" | tr -d ' ') $(grep -c '^(none),' "$OUT/live-campaigns.csv" | tr -d ' ')"

# ---- 8. restart keeps the spend; integrity; no dependency --------------------------------------------------------------
kill "$SRV"; wait "$SRV" 2>/dev/null
boot "$DB" "$PORT" || { echo "FAIL restart"; exit 1; }
check "restart: spend row and campaign totals unchanged" "1|100 100" "$(sql "SELECT COUNT(*)||'|'||CAST(MAX(spend) AS INTEGER) FROM costs") $(cu "localhost:$PORT/dash/campaigns?period=7d&brand=brand-one" | grep -o '<tr data-row="total"[^>]*>.*' | grep -o 'data-col="spend" data-value="[^"]*"' | grep -o '"[0-9.]*"$' | tr -d '"')"
check "PRAGMA integrity_check" "ok" "$(sql 'PRAGMA integrity_check')"
check "no dependency added; no new migration" "0 5" "$(grep -c '"dependencies"' package.json | tr -d ' ') $(ls migrations | wc -l | tr -d ' ')"

echo "-- service log (errors only) --"; grep -E 'ERROR|FATAL' "$LOG" || echo "(none)"
echo "-- not run here: the .backup copy of the live database (operator step), Caddy/trk host --"
if [ "$FAILS" -eq 0 ]; then echo "RESULT: ALL $STEP CHECKS PASSED"; else echo "RESULT: $FAILS OF $STEP CHECKS FAILED"; exit 1; fi
