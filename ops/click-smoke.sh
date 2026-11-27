#!/usr/bin/env bash
# ops/click-smoke.sh — prove the click -> open -> join path against a running Coinvoo (docs/07 §12).
#
# 1. mints a link through the admin route (POST /api/links) under a one-off campaign SMOKE_<time>_<pid>;
# 2. opens it the way a phone browser does (GET /c/<token>, normal browser user-agent) and expects the
#    302 to the bot with start=c_<token>;
# 3. posts the join the gate bot would post (POST /api/join) for a reserved, never-real telegram id;
# 4. asserts through the admin JSON: exactly one click, one human open, one member carrying that click_id;
# 5. discards the token: deletes the link, its open and the smoke member from DB_PATH (on success AND on
#    failure), then checks the campaign is gone. SMOKE_KEEP=1 keeps them for inspection.
#
# Environment: ADMIN_USER, ADMIN_PASS, DB_PATH (required — the service's own .env has all three);
#   COINVOO_BASE (default http://127.0.0.1:8770), JOIN_KEY (sent as X-Coinvoo-Key when set),
#   SMOKE_BRAND (default brand-one), NODE (default node).
# Exit 0 = every check passed and the token was discarded. Any mismatch exits 1.
set -euo pipefail

BASE="${COINVOO_BASE:-http://127.0.0.1:8770}"
BRAND="${SMOKE_BRAND:-brand-one}"
NODE="${NODE:-node}"
UA='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'

say() { echo "[coinvoo] click-smoke $*"; }
fail() { echo "[coinvoo] ERROR click-smoke: $*" >&2; exit 1; }

[ -n "${ADMIN_USER:-}" ] || fail "ADMIN_USER is not set"
[ -n "${ADMIN_PASS:-}" ] || fail "ADMIN_PASS is not set"
[ -n "${DB_PATH:-}" ] || fail "DB_PATH is not set (needed to discard the smoke token)"
[ -f "$DB_PATH" ] || fail "DB_PATH not found: $DB_PATH"
command -v curl >/dev/null 2>&1 || fail "curl not found"
command -v "$NODE" >/dev/null 2>&1 || fail "node not found ($NODE)"

work="$(mktemp -d "${TMPDIR:-/tmp}/coinvoo-smoke.XXXXXX")"
chmod 700 "$work"
# Credentials go to curl through header files, never on the command line (ps would show them).
printf 'Authorization: Basic %s\n' "$(printf '%s:%s' "$ADMIN_USER" "$ADMIN_PASS" | base64 | tr -d '\n')" > "$work/auth"
: > "$work/joinkey"
[ -n "${JOIN_KEY:-}" ] && printf 'X-Coinvoo-Key: %s\n' "$JOIN_KEY" > "$work/joinkey"

campaign="SMOKE_$(date -u +%Y%m%dT%H%M%SZ)_$$"
token=""
tg=""

# json <path> — read JSON on stdin, print the value at a dotted path ("" when absent).
json() {
  "$NODE" -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{let o;try{o=JSON.parse(s)}catch{process.exit(3)}
const v=process.argv[1].split(".").reduce((a,k)=>(a===null||a===undefined?a:a[k]),o);process.stdout.write(v===undefined||v===null?"":String(v))})' "$1"
}

# get <path> — admin GET, body to stdout; non-200 fails.
get() {
  local code
  code="$(curl -sS -o "$work/body" -w '%{http_code}' -H @"$work/auth" "$BASE$1")" || fail "GET $1: request failed"
  [ "$code" = 200 ] || fail "GET $1: HTTP $code $(head -c 200 "$work/body")"
  cat "$work/body"
}

expect() { # expect <label> <actual> <wanted>
  [ "$2" = "$3" ] || fail "$1: expected $3, got ${2:-<empty>}"
}

discard() {
  local rc=$?
  if [ -n "$token" ] && [ "${SMOKE_KEEP:-0}" != 1 ]; then
    if out="$(TOKEN="$token" TG="$tg" CAMPAIGN="$campaign" "$NODE" --no-warnings --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.DB_PATH);
db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
const { TOKEN: t, TG: tg, CAMPAIGN: c } = process.env;
db.exec("BEGIN IMMEDIATE");
try {
  // Only rows this run created: the token is new, the campaign is unique, the member is the reserved id.
  db.prepare("UPDATE clicks SET member_id = NULL WHERE click_id = ? AND campaign = ?").run(t, c);
  const opens = db.prepare("DELETE FROM click_opens WHERE click_id = ?").run(t).changes;
  const members = tg ? db.prepare("DELETE FROM members WHERE click_id = ? AND telegram_id = ? AND join_source = ?").run(t, Number(tg), "smoke").changes : 0;
  const clicks = db.prepare("DELETE FROM clicks WHERE click_id = ? AND campaign = ?").run(t, c).changes;
  db.exec("COMMIT");
  process.stdout.write(`clicks=${clicks} opens=${opens} members=${members}`);
} catch (e) { db.exec("ROLLBACK"); process.stderr.write(e.message); process.exit(1); }
' 2>"$work/err")"; then
      say "discarded token=$token $out"
      left="$(get "/api/clicks?campaign=$campaign" | json total)" || left="?"
      if [ "$left" != 0 ]; then echo "[coinvoo] ERROR click-smoke: campaign $campaign still has $left link(s) after discard" >&2; rc=1; fi
    else
      echo "[coinvoo] ERROR click-smoke: discard failed for token=$token: $(head -c 300 "$work/err")" >&2
      rc=1
    fi
  elif [ -n "$token" ]; then
    say "kept token=$token campaign=$campaign (SMOKE_KEEP=1)"
  fi
  rm -rf "$work"
  exit "$rc"
}
trap discard EXIT

# 1. mint through the admin route
code="$(curl -sS -o "$work/body" -w '%{http_code}' -H @"$work/auth" -H 'content-type: application/json' \
  --data "{\"brand\":\"$BRAND\",\"campaign\":\"$campaign\",\"adset\":\"smoke\",\"ad\":\"smoke\"}" "$BASE/api/links")" \
  || fail "POST /api/links: request failed (is the service running at $BASE?)"
[ "$code" = 200 ] || fail "POST /api/links: HTTP $code $(head -c 200 "$work/body")"
token="$(json token < "$work/body")"
[ -n "$token" ] || fail "POST /api/links: no token in the response"
say "minted token=$token campaign=$campaign"

# 2. open it like a phone browser
read -r status location < <(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' -A "$UA" "$BASE/c/$token") \
  || fail "GET /c/$token: request failed"
expect "GET /c/<token> status" "$status" 302
case "$location" in *"start=c_$token") ;; *) fail "GET /c/<token> redirect: expected ...start=c_$token, got ${location:-<none>}" ;; esac
say "opened status=$status location=$location"

# 3. the join the gate bot would send, for a reserved telegram id (990000000000+, above any real one)
for _ in 1 2 3; do
  cand=$((990000000000 + ((RANDOM << 15) | RANDOM)))
  if [ "$(get "/api/members?q=$cand" | json total)" = 0 ]; then tg="$cand"; break; fi
done
[ -n "$tg" ] || fail "could not find an unused reserved telegram id"
code="$(curl -sS -o "$work/body" -w '%{http_code}' -H @"$work/joinkey" -H 'content-type: application/json' \
  --data "{\"brand\":\"$BRAND\",\"telegram_id\":$tg,\"click_id\":\"$token\",\"username\":\"coinvoo_smoke\",\"source\":\"smoke\"}" "$BASE/api/join")" \
  || fail "POST /api/join: request failed"
[ "$code" = 200 ] || fail "POST /api/join: HTTP $code $(head -c 200 "$work/body")"
expect "join created" "$(json created < "$work/body")" true
expect "join click_id" "$(json click_id < "$work/body")" "$token"
say "joined telegram_id=$tg member=$(json member_id < "$work/body")"

# 4. what the service recorded
get "/api/clicks?campaign=$campaign" > "$work/clicks"
expect "clicks for the campaign" "$(json total < "$work/clicks")" 1
expect "click_id" "$(json clicks.0.click_id < "$work/clicks")" "$token"
expect "human opens" "$(json clicks.0.opens < "$work/clicks")" 1
expect "joins on the click" "$(json clicks.0.joins < "$work/clicks")" 1
[ -n "$(json clicks.0.clicked_at < "$work/clicks")" ] || fail "clicked_at is empty"
get "/api/members?q=$tg" > "$work/members"
expect "members with that telegram id" "$(json total < "$work/members")" 1
expect "member click_id" "$(json members.0.click_id < "$work/members")" "$token"
say "PASS clicks=1 opens=1 members=1 click_id=$token"
