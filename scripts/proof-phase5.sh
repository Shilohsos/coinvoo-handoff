#!/usr/bin/env bash
# Phase 5 proof (docs/08 "Phase 5" + DIRECTIVE-PHASE-5 §8). Runs the real service on scratch databases under /tmp.
# The Telegram Bot API is a LOCAL STAND-IN (TELEGRAM_API_BASE), so nothing leaves this machine and no real token or
# chat is used. The one real send is the optional LIVE step at the end, which the operator runs with real
# REPORT_BOT_TOKEN / REPORT_CHAT_ID exported (LIVE=1); without them it prints SKIPPED.
# Prints a numbered PASS/FAIL list and exits non-zero on any failure. Never touches a live database.
set -u
cd "$(dirname "$0")/.."

# Real credentials, if the operator supplied them, are set aside BEFORE the stand-in environment replaces them.
LIVE_TOKEN="${REPORT_BOT_TOKEN:-}"; LIVE_CHAT="${REPORT_CHAT_ID:-}"
unset REPORT_BOT_TOKEN REPORT_CHAT_ID ALERT_CHAT_ID TELEGRAM_API_BASE

DB="${DB_PATH:-/tmp/coinvoo-proof5.db}"
PORT="${PORT:-8776}"; TGPORT=8777; OFF_DB=/tmp/coinvoo-proof5-off.db; OFF_PORT=8778
TGLOG=/tmp/coinvoo-proof5-telegram.jsonl
LOG=/tmp/coinvoo-proof5.log; OFFLOG=/tmp/coinvoo-proof5-off.log
case "$DB" in /tmp/*) ;; *) echo "refusing: DB_PATH must be under /tmp (scratch databases only)"; exit 2;; esac
for f in "$DB" "$OFF_DB"; do rm -f "$f" "$f-wal" "$f-shm"; done; rm -f "$TGLOG" "$LOG" "$OFFLOG"; : > "$TGLOG"

FAKE_TOKEN='000000:PROOF_TOKEN_not_a_real_token_xxxxxxxxxx'
export PUBLIC_BASE=https://coinvoo.example ADMIN_USER=admin ADMIN_PASS=pass
export BACKUP_DIR=off  # phase 6: the backup defaults to /var/backups/coinvoo; a proof run must never write there
export BRAND_ONE_BOT_USERNAME=coinvoo_test_bot BRAND_TWO_BOT_USERNAME=coinvoo_echo_test_bot
export BOTDB_SNAPSHOT=/nonexistent/botdb-snapshot.db WORKER_INTERVAL_MS=2000
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
cu() { curl -s -u admin:pass "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
boot() { # boot <db> <port> <logfile> -> $PID
  DB_PATH="$1" PORT="$2" node src/server.js >>"$3" 2>&1 & PID=$!; PIDS="$PIDS $PID"
  for _ in $(seq 1 50); do curl -s "localhost:$2/api/aff/health" >/dev/null 2>&1 && return 0; sleep 0.1; done; return 1; }
trap 'for p in $PIDS; do kill "$p" 2>/dev/null; done' EXIT
tgcount() { jq -s --arg c "$1" '[.[] | select(.body.chat_id == $c)] | length' "$TGLOG"; }
tgtext()  { jq -s -r --arg c "$1" --argjson n "$2" '[.[] | select(.body.chat_id == $c)][$n].body.text' "$TGLOG"; }

D=$(node -e 'console.log(new Date(Date.now()+3600000-86400000).toISOString().slice(0,10))')
HOUR=$(node -e 'console.log(new Date(Date.now()+3600000).getUTCHours())')
echo "== coinvoo phase 5 proof  db=$DB port=$PORT node=$(node --version)  report-day=$D  REPORT_HOUR=$HOUR (Lagos, now)"

# ---- the Telegram stand-in ---------------------------------------------------------------------------------------
TGLOG="$TGLOG" TGPORT="$TGPORT" node -e '
  const http = require("http"), fs = require("fs"); let id = 900;
  http.createServer((q, r) => { let b = ""; q.on("data", (c) => b += c); q.on("end", () => {
    fs.appendFileSync(process.env.TGLOG, JSON.stringify({ path: q.url, body: JSON.parse(b || "{}") }) + "\n");
    r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ ok: true, result: { message_id: ++id } })); }); })
    .listen(+process.env.TGPORT, "127.0.0.1");' &
TGPID=$!; PIDS="$PIDS $TGPID"; sleep 0.5

# ---- 1. fixture: the day before today, hand-computable (brand-one) -------------------------------------------------------
DB_PATH="$DB" D="$D" node --no-warnings --input-type=module -e '
  import { loadConfig } from "./src/config.js"; import { openDb, migrate } from "./src/db.js";
  const c = loadConfig(process.env); const db = openDb(c.dbPath); migrate(db, { env: c.brandSeed });
  const D = process.env.D, L = (hhmm) => Date.parse(`${D}T${hhmm}:00Z`) - 3600000;
  const click = db.prepare("INSERT INTO clicks (click_id, brand_id, campaign, adset, ad, created_at, clicked_at) VALUES (?, 1, ?, ?, ?, ?, ?)");
  for (let i = 1; i <= 3; i++) click.run(("RB" + i).padEnd(10, "0"), "NG_Broad", "18-34", "vid_03", L("08:00"), L("10:00"));
  click.run("RO1".padEnd(10, "0"), "NG_Other", "x", "y", L("08:00"), L("10:30"));
  db.exec("INSERT INTO click_opens (click_id, brand_id, opened_at) SELECT click_id, brand_id, clicked_at FROM clicks");
  const mem = db.prepare("INSERT INTO members (brand_id, telegram_id, username, joined_at, click_id, join_source) VALUES (1, ?, ?, ?, ?, \x27bot:start\x27)");
  mem.run(7001, "one", L("11:00"), "RB1".padEnd(10, "0")); mem.run(7002, "two", L("11:05"), "RB2".padEnd(10, "0")); mem.run(7003, "three", L("11:10"), null);
  const id = (tg) => db.prepare("SELECT id FROM members WHERE telegram_id = ?").get(tg).id;
  const ev = db.prepare("INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, ignore_reason, matched_member_id, matched_at, forward_state) VALUES (?, 1, \x27affstore\x27, ?, ?, ?, ?, \x27USD\x27, ?, ?, ?, ?, ?, ?, \x27sent\x27)");
  const att = db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at) VALUES (?, ?, ?, ?, ?)");
  const P = JSON.stringify({ net: "affstore" });
  for (const [e, k, a, h, tg] of [["r1","reg",null,"17:00",7001],["r2","reg",null,"17:05",7002],["f1","ftd",50,"18:00",7001],["f2","ftd",70,"19:00",7002],["d1","dep",30,"20:00",7001],["z1","reg",null,"23:00",7003]]) {
    ev.run(e, k, k, "19710" + e, a, P, L(h), "matched", null, id(tg), L(h)); att.run(e, id(tg), "afftrack", 100, L(h)); }
  ev.run("p1","dep","dep","197999999",25,P,L("21:00"),"parked",null,null,null); db.prepare("UPDATE events SET forward_state = \x27none\x27 WHERE event_id = \x27p1\x27").run();
  ev.run("x1","ftd","ftd","197888888",40,P,L("22:00"),"expired",null,null,null); att.run("x1", null, "none", 0, L("22:00"));
  ev.run("s1","ftd","ftd","1",100,P,L("22:30"),"ignored","stub_guard",null,null); att.run("s1", null, "none", 0, L("22:30"));
  db.prepare("INSERT INTO costs (brand_id, day, campaign, adset, ad, spend, currency, created_at) VALUES (1, ?, \x27NG_Broad\x27, \x2718-34\x27, \x27vid_03\x27, 60, \x27USD\x27, ?)").run(D, Date.now());
  db.close();'
echo "fixture day $D: members=$(sql 'SELECT COUNT(*) FROM members') events=$(sql 'SELECT COUNT(*) FROM events') clicks=$(sql 'SELECT COUNT(*) FROM clicks') costs=$(sql 'SELECT COUNT(*) FROM costs')"

# ---- 2. the service with the report and alerts switched on ----------------------------------------------------------
export REPORT_BOT_TOKEN="$FAKE_TOKEN" REPORT_CHAT_ID=-1001111 ALERT_CHAT_ID=-1002222 TELEGRAM_API_BASE="http://127.0.0.1:$TGPORT"
export REPORT_HOUR="$HOUR" POSTBACK_SILENCE_HOURS=0.004
boot "$DB" "$PORT" "$LOG" || { echo "FAIL  service did not start"; cat "$LOG"; exit 1; }; SRV=$PID
check "boot log says the report and the alerts are on (and never the token or a chat id)" "ok" \
  "$(grep -q "^\[coinvoo\] report enabled hour=$HOUR\$" "$LOG" && grep -q '^\[coinvoo\] alerts enabled$' "$LOG" && ! grep -qE "PROOF_TOKEN|1001111|1002222" "$LOG" && echo ok || echo BAD)"

# a link opened now means "clicks exist in the last 24 h", which is when silence counts as an outage
TOK=$(cu -X POST "localhost:$PORT/api/links" -H 'content-type: application/json' -d '{"brand":"brand-one","campaign":"PROOF"}' | jq -r .token); curl -s -o /dev/null "localhost:$PORT/c/$TOK"
sleep 7

# ---- 3. the scheduled card ---------------------------------------------------------------------------------------------
check "exactly one report message was sent, to REPORT_CHAT_ID" "1" "$(tgcount -1001111)"
echo "-- the card as the bot received it --"; tgtext -1001111 0; echo "-- end of card --"
REQ=$(jq -s -c '[.[] | select(.body.chat_id == "-1001111")][0]' "$TGLOG")
check "request path is /bot<token>/sendMessage" "/bot$FAKE_TOKEN/sendMessage" "$(echo "$REQ" | jq -r .path)"
check "request body keys are exactly chat_id, text, disable_web_page_preview (no parse_mode)" "chat_id,disable_web_page_preview,text" "$(echo "$REQ" | jq -r '.body | keys | join(",")')"
CARD=$(tgtext -1001111 0)
HEADING=$(node -e 'const d=new Date(process.argv[1]+"T00:00:00Z");const W=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],M=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];console.log("COINVOO — brand-one — "+W[d.getUTCDay()]+" "+String(d.getUTCDate()).padStart(2,"0")+" "+M[d.getUTCMonth()]+" "+d.getUTCFullYear())' "$D")
check "card heading names the day that ended (yesterday)" "$HEADING" "$(echo "$CARD" | sed -n 1p)"
check "card numbers equal the hand-computed fixture (4 clicks, 3 joins, 3 regs, 3 FTDs, 2 re-deps; \$150 revenue, \$60 spend, +150.0 % ROI)" \
  "Clicks 4 · Joins 3 · Regs 3 · FTDs 3 · Re-deps 2|Revenue \$150.00 · Spend \$60.00 · ROI +150.0%|Cost/join \$20.00 · Cost/FTD \$20.00" \
  "$(echo "$CARD" | sed -n '3p;4p;5p' | paste -sd'|')"
check "card quality, unattributed and top campaign lines" "Matched 75.0% · Parked 12.5% · Expired 12.5% · Ignored 1|Unattributed revenue \$65.00|Top campaign: NG_Broad / 18-34 / vid_03 — 2 FTDs, \$150.00" \
  "$(echo "$CARD" | sed -n '7p;8p;10p' | paste -sd'|')"
check "card ends with the combined line and is plain text (no markdown or HTML)" "ALL BRANDS — revenue \$150.00 · spend \$60.00 · FTDs 3 ok" \
  "$(echo "$CARD" | tail -1) $(echo "$CARD" | grep -qE '[*`]|<[a-z]|&[a-z]+;' && echo MARKUP || echo ok)"
check "last_report_day is today's Lagos date" "$(node -e 'console.log(new Date(Date.now()+3600000).toISOString().slice(0,10))')" "$(sql "SELECT value FROM settings WHERE key = 'last_report_day'")"

# ---- 4. restart inside the report hour does not send again --------------------------------------------------------------
kill "$SRV"; wait "$SRV" 2>/dev/null
boot "$DB" "$PORT" "$LOG" || { echo "FAIL  restart"; cat "$LOG"; exit 1; }; SRV=$PID
sleep 7
check "restart during the report hour: still exactly one report message" "1" "$(tgcount -1001111)"

# ---- 5. a real fire-once / clear on the live service (silence), then the full mocked-clock timeline -----------------------
ALERTS_BEFORE=$(tgcount -1002222)
echo "alert chat so far: $ALERTS_BEFORE message(s)"; jq -s -r '[.[] | select(.body.chat_id == "-1002222")][] | "  -> " + .body.text' "$TGLOG"
check "silence alert on the live service: one message to ALERT_CHAT_ID over several ticks (and only to it)" "1" "$(jq -s '[.[] | select(.body.chat_id == "-1002222" and (.body.text | test("^COINVOO — no postbacks for [0-9]+ h \\(last: [0-9]{2}:[0-9]{2}; threshold 0.004 h\\)$")))] | length' "$TGLOG")"
check "no alert text went to the report chat, no report text to the alert chat" "0 0" \
  "$(jq -s '[.[] | select(.body.chat_id == "-1001111" and (.body.text | startswith("COINVOO — no ")))] | length' "$TGLOG") $(jq -s '[.[] | select(.body.chat_id == "-1002222" and (.body.text | contains("ALL BRANDS")))] | length' "$TGLOG")"
check "alert state is persisted as firing" "firing" "$(sql "SELECT value FROM settings WHERE key = 'alert_state_silence'")"
curl -s -o /dev/null "localhost:$PORT/api/aff?status=reg&trader_id=197555555&event_id=proof-live-1"
sleep 4
check "a fresh postback clears it: one 'cleared' message" "COINVOO — postback silence cleared" "$(jq -s -r '[.[] | select(.body.chat_id == "-1002222")] | last | .body.text' "$TGLOG")"

TL=$(node --no-warnings --input-type=module -e '
  import { startApp } from "./test/helpers.js"; import { runAlerts } from "./src/alerts.js"; import { loadReportConfig } from "./src/report.js";
  const H = 3600000, MIN = 60000, BASE = Date.parse("2026-11-15T10:00:00Z");
  const lagos = (hhmm, day = "2026-11-15") => Date.parse(`${day}T${hhmm}:00Z`) - H;
  const stamp = (ms) => new Date(ms + H).toISOString().slice(5, 16).replace("T", " ");
  let bad = 0; const out = [];
  async function scenario(name, prep, steps) {
    const clock = { now: BASE }, sent = [];
    const app = await startApp({}, { now: () => clock.now, fetchImpl: async (u, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200 }); } });
    const rc = Object.assign({}, loadReportConfig({ REPORT_BOT_TOKEN: "1:x", ALERT_CHAT_ID: "-1002222" }), { retryDelayMs: 0 }); const st = {};
    const ev = (id, o) => app.db.prepare("INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, payload_json, received_at, state, matched_at, forward_state) VALUES (?, 1, \x27affstore\x27, \x27dep\x27, \x27dep\x27, ?, 10, \x27USD\x27, \x27{}\x27, ?, ?, ?, ?)").run(id, "1970" + id, o.at, o.state || "matched", (o.state || "matched") === "matched" ? (o.matchedAt ?? o.at) : null, o.forward || "sent");
    const click = (id, at) => { app.db.prepare("INSERT INTO clicks (click_id, brand_id, campaign, created_at, clicked_at) VALUES (?, 1, \x27C\x27, ?, ?)").run(id.padEnd(10, "0"), at, at); app.db.prepare("INSERT INTO click_opens (click_id, brand_id, opened_at) VALUES (?, 1, ?)").run(id.padEnd(10, "0"), at); };
    const api = { app, ev, click, clock };
    prep && prep(api);
    for (const [now, expect, act] of steps) {
      clock.now = now; if (act) act(api);
      const before = sent.length; await runAlerts(app.deps, rc, st);
      const got = sent.slice(before).map((b) => b.text); const ok = JSON.stringify(got) === JSON.stringify(expect) && sent.slice(before).every((b) => b.chat_id === "-1002222" && !("parse_mode" in b));
      if (!ok) bad++;
      out.push(`${ok ? "ok  " : "DIFF"} ${name.padEnd(8)} ${stamp(now)}  ${got.length ? (got[0].includes("cleared") ? "CLEAR " : "FIRE  ") + got.join(" | ") : "(silent)"}${ok ? "" : "   expected: " + JSON.stringify(expect)}`);
    }
    await app.close();
  }
  await scenario("silence", (a) => { a.ev("e1", { at: lagos("12:14") }); a.click("ck1", lagos("13:00")); }, [
    [lagos("17:14"), []], [lagos("18:14"), []], [lagos("19:20"), ["COINVOO — no postbacks for 7 h (last: 12:14; threshold 6 h)"]], [lagos("19:21"), []], [lagos("23:30"), []],
    [lagos("23:41"), ["COINVOO — postback silence cleared"], (a) => a.ev("e2", { at: lagos("23:40") })], [lagos("23:42"), []]]);
  await scenario("parked", (a) => { for (let i = 0; i < 5; i++) a.ev("m" + i, { at: BASE - 2 * H }); for (let i = 0; i < 5; i++) a.ev("p" + i, { at: BASE - 2 * H, state: "parked", forward: "none" }); }, [
    [BASE, []], [BASE + MIN, ["COINVOO — 55% of events unmatched in the last 24 h (6 of 11; threshold 50%)"], (a) => a.ev("p9", { at: BASE, state: "parked", forward: "none" })], [BASE + 2 * MIN, []],
    [BASE + 3 * MIN, ["COINVOO — unmatched ratio cleared"], (a) => { for (let i = 0; i < 9; i++) a.ev("n" + i, { at: BASE + 2 * MIN }); }]]);
  await scenario("forward", () => {}, [
    [BASE, []], [BASE + MIN, []], [BASE + 20 * MIN, ["COINVOO — 3 postbacks failing to forward to Joinvoo (threshold: any failed for over 15 min)"], (a) => { for (const i of [1, 2, 3]) a.ev("f" + i, { at: BASE - H, matchedAt: BASE + MIN - 16 * MIN, forward: "failed" }); }],
    [BASE + 21 * MIN, []], [BASE + 22 * MIN, ["COINVOO — forward failures cleared"], (a) => a.app.db.prepare("UPDATE events SET forward_state = \x27sent\x27").run()]]);
  const disk = { free: 15 };
  await scenario("disk", (a) => { a.app.deps.diskFreePct = () => disk.free; }, [
    [BASE, []], [BASE + MIN, [], () => { disk.free = 10; }], [BASE + 2 * MIN, ["COINVOO — disk 91% full, 9.0% free (threshold: under 10% free)"], () => { disk.free = 9; }], [BASE + 3 * MIN, [], () => { disk.free = 3; }],
    [BASE + 4 * MIN, ["COINVOO — disk usage cleared"], () => { disk.free = 20; }]]);
  const mem = { mb: 200 };
  await scenario("memory", (a) => { a.app.deps.rssMb = () => mem.mb; }, [
    [BASE, []], [BASE + MIN, [], () => { mem.mb = 268; }], [BASE + 10 * MIN + 59000, []], [BASE + 11 * MIN, ["COINVOO — memory 268 MB for 10 min (threshold 250 MB)"]], [BASE + 12 * MIN, []],
    [BASE + 13 * MIN, ["COINVOO — memory cleared"], () => { mem.mb = 240; }]]);
  await scenario("health", (a) => { a.real = a.app.db.prepare.bind(a.app.db); }, [
    [BASE, []], [BASE + MIN, ["COINVOO — database check failing (SELECT 1 errored; threshold: any error)"], (a) => { a.app.db.prepare = (s) => { if (/SELECT 1\b/.test(s)) throw new Error("malformed"); return a.real(s); }; }],
    [BASE + 2 * MIN, []], [BASE + 3 * MIN, ["COINVOO — database check cleared"], (a) => { a.app.db.prepare = a.real; }]]);
  console.log(out.join("\n")); console.log(bad === 0 ? "TIMELINE_OK" : "TIMELINE_DIFF");')
echo "-- mocked clock: each alert fires once, stays silent while firing, clears once (instants in Africa/Lagos) --"
echo "$TL" | grep -v '^TIMELINE'
check "all six alerts: fire once -> silent -> clear, texts and ALERT_CHAT_ID exact, no parse_mode (mocked clock)" "TIMELINE_OK" "$(echo "$TL" | grep '^TIMELINE')"

# ---- 6. read API equals the dashboard, for one day --------------------------------------------------------------------------
cu "localhost:$PORT/api/report/daily?day=$D&brand=brand-one" > /tmp/coinvoo-proof5-daily.json
cu "localhost:$PORT/dash?from=$D&to=$D&brand=brand-one" > /tmp/coinvoo-proof5-dash.html
EQ=$(node --no-warnings --input-type=module -e '
  import { readFileSync } from "node:fs";
  const j = JSON.parse(readFileSync("/tmp/coinvoo-proof5-daily.json", "utf8")).brands[0];
  const m = Object.fromEntries([...readFileSync("/tmp/coinvoo-proof5-dash.html", "utf8").matchAll(/data-metric="([a-z_]+)" data-value="([^"]*)"/g)].map((x) => [x[1], x[2] === "" ? null : Number(x[2])]));
  const pairs = [["clicks", j.clicks, m.clicks], ["joins", j.joins, m.joins], ["regs", j.regs, m.regs], ["ftds", j.ftds, m.ftds], ["redeps", j.redeps, m.redeps],
    ["revenue", j.revenue, m.revenue], ["spend", j.spend, m.spend], ["cost_per_join", j.cost_per_join, m.cost_per_join], ["cost_per_ftd", j.cost_per_ftd, m.cost_per_ftd], ["roi", j.roi, m.roi],
    ["unattributed", j.unattributed, m.unattributed], ["matched", j.states.matched, m.matched], ["parked", j.states.parked, m.parked], ["expired", j.states.expired, m.expired], ["ignored", j.states.ignored, m.ignored]];
  let bad = 0; console.log("metric".padEnd(14) + "api".padStart(12) + "dashboard".padStart(12));
  for (const [k, a, b] of pairs) { const ok = a === b; if (!ok) bad++; console.log(`${ok ? "ok  " : "DIFF"} ${k.padEnd(9)}${String(a).padStart(12)}${String(b).padStart(12)}`); }
  console.log(bad === 0 ? "EQUAL" : "DIFFERENT");')
echo "-- GET /api/report/daily?day=$D&brand=brand-one   vs   GET /dash?from=$D&to=$D&brand=brand-one --"
echo "$EQ" | grep -v -x -E 'EQUAL|DIFFERENT'
check "read API equals /dash for $D on all 15 numbers" "EQUAL" "$(echo "$EQ" | grep -x -E 'EQUAL|DIFFERENT')"
APITEXT=$(cu "localhost:$PORT/api/report/daily?day=$D" | jq -r .text | grep -v '^Last event:')
check "GET /api/report/daily?day=$D (all brands) returns the very text the bot received (apart from the live 'Last event' age)" "same" "$([ "$APITEXT" = "$(echo "$CARD" | grep -v '^Last event:')" ] && echo same || echo different)"
SUM=$(cu "localhost:$PORT/api/summary?period=7d&brand=brand-one"); DASH7=$(cu "localhost:$PORT/dash?period=7d&brand=brand-one")
dm() { echo "$DASH7" | sed -n "s/.*data-metric=\"$1\" data-value=\"\\([^\"]*\\)\".*/\\1/p" | head -1; }
check "GET /api/summary (7d, brand-one) equals the Overview: clicks, joins, regs, ftds, revenue, matched" "$(dm clicks) $(dm joins) $(dm regs) $(dm ftds) $(dm revenue) $(dm matched)" \
  "$(echo "$SUM" | jq -r '"\(.clicks) \(.joins) \(.regs) \(.ftds) \(.revenue) \(.states.matched)"')"
check "read API: auth, generated_at, no-store" "401 true no-store" \
  "$(code "localhost:$PORT/api/summary") $(echo "$SUM" | jq '.generated_at > 0') $(curl -si -u admin:pass "localhost:$PORT/api/summary" | tr -d '\r' | grep -i '^cache-control' | cut -d' ' -f2)"
MEM=$(cu "localhost:$PORT/api/member/7001")
check "GET /api/member/7001: lifetime value (50 FTD + 30 re-deposit) and the newest event first" "7001 80 d1" "$(echo "$MEM" | jq -r '"\(.member.telegram_id) \(.value[0].total) \(.events[0].event_id)"')"

# ---- 7. maintenance: the prune, on a fixture with two old rows ---------------------------------------------------------------
PR=$(node --no-warnings --input-type=module -e '
  import { startApp } from "./test/helpers.js"; import { createWorker, PRUNED_PAYLOAD } from "./src/worker.js"; import { loadReportConfig } from "./src/report.js";
  const DAY = 86400000, clock = { now: Date.parse("2026-11-15T02:05:00Z") }; // 03:05 Lagos
  const app = await startApp({}, { now: () => clock.now }); const db = app.db;
  db.prepare("INSERT INTO members (brand_id, telegram_id, username, joined_at, join_source) VALUES (1, 7001, \x27one\x27, ?, \x27bot:start\x27)").run(clock.now);
  const ev = db.prepare("INSERT INTO events (event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, country, payload_json, received_at, state, matched_member_id, matched_at, forward_state) VALUES (?, 1, \x27affstore\x27, \x27ftd\x27, \x27ftd\x27, ?, ?, \x27USD\x27, \x27NG\x27, ?, ?, \x27matched\x27, (SELECT id FROM members WHERE telegram_id = 7001), ?, \x27sent\x27)");
  const att = db.prepare("INSERT INTO attributions (event_id, member_id, path, confidence, decided_at) VALUES (?, (SELECT id FROM members WHERE telegram_id = 7001), \x27afftrack\x27, 100, ?)");
  const ages = { old_400d: 400, old_366d: 366, edge_364d: 364, recent_3d: 3 };
  for (const [id, d] of Object.entries(ages)) { const t = clock.now - d * DAY; ev.run(id, "1977" + d, d, JSON.stringify({ event_id: id, ip: "203.0.113.9", pad: "x".repeat(40) }), t, t); att.run(id, t); }
  const snap = () => Object.fromEntries(db.prepare("SELECT e.event_id, length(e.payload_json) AS len, e.payload_json, e.amount, e.state, e.matched_member_id, a.confidence FROM events e JOIN attributions a ON a.event_id = e.event_id").all().map((r) => [r.event_id, { ...r }]));
  const before = snap();
  app.deps.reportConfig = loadReportConfig({}); const w = createWorker(app.deps);
  await w.tick(); await w.flush(); const after = snap();
  console.log("event_id    age_d  payload_before  payload_after              amount  state    attribution");
  let bad = 0;
  for (const [id, d] of Object.entries(ages)) {
    const a = after[id], b = before[id], old = d > 365;
    const okRow = a.amount === b.amount && a.state === b.state && a.matched_member_id === b.matched_member_id && a.confidence === b.confidence;
    const okPayload = old ? a.payload_json === PRUNED_PAYLOAD : a.payload_json === b.payload_json;
    if (!okRow || !okPayload) bad++;
    console.log(`${okRow && okPayload ? "ok  " : "DIFF"} ${id.padEnd(10)} ${String(d).padStart(5)}  ${String(b.len + " bytes").padStart(14)}  ${(old ? a.payload_json : "(unchanged, " + a.len + " bytes)").padEnd(24)}  ${String(a.amount).padStart(6)}  ${a.state}  conf=${a.confidence}`);
  }
  const first = w.lastMaintenance.pruned;
  clock.now += DAY; await w.tick(); await w.flush(); // next day: nothing left to prune
  const second = w.lastMaintenance.pruned;
  console.log(`pruned on the first run: ${first}; on the second run, a day later: ${second}`);
  console.log(bad === 0 && first === 2 && second === 0 ? "PRUNE_OK" : "PRUNE_DIFF"); await app.close();')
echo "-- maintenance at 03:05 Lagos on a fixture with two old rows (400 d and 366 d), one at 364 d and one recent --"
echo "$PR" | grep -v '^PRUNE'
check "prune: the two rows older than 365 days lose payload_json; row, amount, attribution intact; others untouched; next run changes nothing" "PRUNE_OK" "$(echo "$PR" | grep '^PRUNE')"

# ---- 8. no credentials: the service no-ops cleanly ------------------------------------------------------------------------------
( unset REPORT_BOT_TOKEN REPORT_CHAT_ID ALERT_CHAT_ID TELEGRAM_API_BASE; DB_PATH="$OFF_DB" PORT="$OFF_PORT" REPORT_HOUR="$HOUR" node src/server.js >"$OFFLOG" 2>&1 & echo $! > /tmp/coinvoo-proof5-off.pid )
OFFPID=$(cat /tmp/coinvoo-proof5-off.pid); PIDS="$PIDS $OFFPID"
for _ in $(seq 1 50); do curl -s "localhost:$OFF_PORT/api/aff/health" >/dev/null 2>&1 && break; sleep 0.1; done
TGBEFORE=$(wc -l < "$TGLOG" | tr -d ' ')
sleep 6
check "no REPORT_BOT_TOKEN / REPORT_CHAT_ID / ALERT_CHAT_ID: one boot line each for report and alerts, no error, service healthy" \
  "[coinvoo] report disabled missing=REPORT_BOT_TOKEN,REPORT_CHAT_ID|[coinvoo] alerts disabled missing=REPORT_BOT_TOKEN,ALERT_CHAT_ID|0|true" \
  "$(grep '^\[coinvoo\] report disabled' "$OFFLOG")|$(grep '^\[coinvoo\] alerts disabled' "$OFFLOG")|$(grep -cE 'ERROR|FATAL' "$OFFLOG")|$(curl -s "localhost:$OFF_PORT/api/aff/health" | jq .ok)"
check "...and it sent nothing and stored no report or alert state" "0|0" "$(($(wc -l < "$TGLOG" | tr -d ' ') - TGBEFORE))|$(sql "SELECT COUNT(*) FROM settings WHERE key IN ('last_report_day','report_retry') OR key LIKE 'alert_state_%'" "$OFF_DB")"
kill "$OFFPID" 2>/dev/null; wait "$OFFPID" 2>/dev/null

# ---- 9. hygiene ---------------------------------------------------------------------------------------------------------------------
check "the bot token appears in no log line" "0" "$(cat "$LOG" "$OFFLOG" | grep -c 'PROOF_TOKEN')"
check "no dependency added; no new migration" "0 5" "$(grep -c '"dependencies"' package.json | tr -d ' ') $(ls migrations | wc -l | tr -d ' ')"
check "PRAGMA integrity_check" "ok" "$(sql 'PRAGMA integrity_check')"

# ---- 10. the live send: operator step (needs the real token and a test chat) ------------------------------------------------------
echo "-- live send --"
if [ "${LIVE:-0}" = "1" ] && [ -n "$LIVE_TOKEN" ] && [ -n "$LIVE_CHAT" ]; then
  LIVE_OUT=$(REPORT_BOT_TOKEN="$LIVE_TOKEN" REPORT_CHAT_ID="$LIVE_CHAT" D="$D" DB_PATH="$DB" node --no-warnings --input-type=module -e '
    import { loadReportConfig, sendDailyReport } from "./src/report.js"; import { openDb } from "./src/db.js";
    const rc = loadReportConfig(process.env); const db = openDb(process.env.DB_PATH);
    const r = await sendDailyReport({ db, rc, now: Date.now(), day: process.env.D });
    console.log("ok=" + r.ok + " message_id=" + r.messageId + " status=" + r.status + (r.ok ? "" : " error=" + r.error)); console.log("--- text sent ---"); console.log(r.text); db.close();')
  echo "$LIVE_OUT"
  check "live: the real Bot API accepted the report card (ok=true and a message id)" "true" "$(echo "$LIVE_OUT" | grep -q '^ok=true message_id=[0-9]' && echo true || echo false)"
else
  echo "SKIPPED: set LIVE=1 with real REPORT_BOT_TOKEN and REPORT_CHAT_ID exported to send one real card to the test chat (operator step)."
fi

echo "-- stand-in Telegram received $(wc -l < "$TGLOG" | tr -d ' ') request(s): $(tgcount -1001111) to the report chat, $(tgcount -1002222) to the alert chat --"
echo "-- service log (errors only) --"; grep -E 'ERROR|FATAL' "$LOG" || echo "(none)"
if [ "$FAILS" -eq 0 ]; then echo "RESULT: ALL $STEP CHECKS PASSED"; else echo "RESULT: $FAILS OF $STEP CHECKS FAILED"; exit 1; fi
