# 08 — Test Plan

Every phase ships with a proof script in `scripts/`. The script prints a numbered pass/fail list and exits non-zero on any failure. **The real output is pasted into the PR body.** No output, no merge.

Run order: unit tests first (`node --test`), then the proof script against a live service on a scratch database (`DB_PATH=/tmp/coinvoo-test.db`), then — for Phase 2 only — a read-only check against the real bot database.

---

## Phase 1 — click bridge + join capture

**Unit (`node --test`)**

1. Token generator produces 10 characters from the Crockford alphabet, no `I L O U`, 10 000 iterations, zero collisions.
2. `ip_hash` is stable for the same ip+salt and differs across salts; raw IP never appears in the row.
3. Member upsert: first call creates, second call updates `username` and does not duplicate.
4. First touch wins: a member with `click_id=A` who later joins with `click_id=B` keeps `A`.
5. Unknown click id on `/api/join` → 422.

**Proof (`scripts/proof-phase1.sh`)**

```bash
# 1. boot on a scratch db
DB_PATH=/tmp/coinvoo-test.db PORT=8771 node src/server.js &
sleep 1
curl -s localhost:8771/api/aff/health            # expect ok:true

# 2. create a link
TOKEN=$(curl -s -u admin:pass -X POST localhost:8771/api/links \
  -H 'content-type: application/json' \
  -d '{"brand":"brand-one","campaign":"NG_Broad","adset":"18-34","ad":"vid_03"}' \
  | jq -r .token)
brand-two "token=$TOKEN"                              # expect 10 chars

# 3. click it — must redirect
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "localhost:8771/c/$TOKEN?ttclid=E.C.P.test"
# expect: 302 https://t.me/<gate_bot>?start=c_<TOKEN>

# 4. the click row exists with its campaign
sqlite3 /tmp/coinvoo-test.db \
 "SELECT token,campaign,adset,ad,length(ip_hash) FROM clicks WHERE token='$TOKEN';"
# expect: token|NG_Broad|18-34|vid_03|32

# 5. the bot reports the join
curl -s -X POST localhost:8771/api/join -H 'content-type: application/json' \
  -d "{\"brand\":\"brand-one\",\"telegram_id\":7000000001,\"username\":\"tester\",\"first_name\":\"tester\",\"click_id\":\"$TOKEN\",\"source\":\"bot:start\"}"
# expect: {"ok":true,"member_id":1,"created":true,"click_id":"<TOKEN>"}

# 6. member row carries the click and the campaign
sqlite3 /tmp/coinvoo-test.db \
 "SELECT m.telegram_id,m.join_source,c.campaign FROM members m JOIN clicks c ON c.click_id=m.click_id;"
# expect: 7000000001|bot:start|NG_Broad

# 7. unknown token is a clean 404, no row written
curl -s -o /dev/null -w '%{http_code}\n' localhost:8771/c/ZZZZZZZZZZ   # expect 404
sqlite3 /tmp/coinvoo-test.db 'SELECT COUNT(*) FROM clicks;'            # expect 1

# 8. restart with the same db — data survives
kill %1; DB_PATH=/tmp/coinvoo-test.db PORT=8771 node src/server.js & sleep 1
sqlite3 /tmp/coinvoo-test.db 'SELECT COUNT(*) FROM members;'           # expect 1
```

**Gate-bot patch proof (live, bot untouched otherwise)**

9. From the admin's own Telegram, open `https://t.me/<gate_bot>?start=c_<TOKEN>` → the bot's normal welcome DM arrives unchanged.
10. `POST /api/join` appears in the coinvoo log with `source=bot:start`.
11. Stop coinvoo, repeat step 9 → the DM still arrives; the bot logs `[join] coinvoo report failed` and does not stall.

---

## Phase 2 — postback receiver + matcher

**Unit**

1. Status mapping table: every inbound synonym → the right `kind`; unknown → `ignored/bad_kind`.
2. Stub guard: `trader_id=1`, `afftrack=TEST-RECON-1`, `amount<=0` → `ignored`, never matched.
3. Duplicate `event_id` → second insert is a no-op, `duplicate:true`, counts stay at 1.
4. Soft duplicate (same trader/kind/amount within 120 s, different event_id) → stored, `ignored/duplicate_soft`.
5. Matcher rule precedence: an event with both a valid `afftrack` and a `trader_id` resolves by `afftrack`, confidence 100.
6. `account_claimed`: a second member presenting a linked `iq_user_id` is refused, the owner keeps the event.
7. Parked → matched on member creation; parked → expired after 48 h and still forwarded.

**Proof (`scripts/proof-phase2.sh`)**

```bash
DB_PATH=/tmp/coinvoo-test.db PORT=8771 node src/server.js & sleep 1

# 1. stub postback
curl -s "localhost:8771/api/aff?status=ftd&net=affstore&trader_id=1&amount=100&event_id=stub-1&afftrack=TEST-RECON-1"
# expect {"ok":true,"ignored":"stub_guard"}

# 2. real registration, known member, afftrack path
curl -s "localhost:8771/api/aff?status=ftd&trader_id=197512345&amount=50&event_id=ev-1&afftrack=7000000001&country_code=NG"
# expect {"ok":true,"matched":true,"path":"afftrack","member_id":1,...}

# 3. duplicate
curl -s "localhost:8771/api/aff?status=ftd&trader_id=197512345&amount=50&event_id=ev-1&afftrack=7000000001"
# expect {"ok":true,"duplicate":true}

# 4. trader_id path (member known via bot db)
curl -s "localhost:8771/api/aff?status=ftd&trader_id=197318401&amount=10&event_id=ev-2"
# expect matched:true path:trader_id confidence 90 (member resolved from BOT_DB)

# 5. unknown trader → parked
curl -s "localhost:8771/api/aff?status=dep&trader_id=197999999&amount=25&event_id=ev-3"
# expect {"ok":true,"matched":false,"path":"parked"}

# 6. the park is real
sqlite3 /tmp/coinvoo-test.db "SELECT state FROM events WHERE event_id='ev-3';"   # parked

# 7. the person appears → parked event is picked up
curl -s -X POST localhost:8771/api/join -H 'content-type: application/json' \
 -d '{"brand":"brand-one","telegram_id":7000000001,"source":"bot:start"}'
sqlite3 /tmp/coinvoo-test.db \
 "INSERT INTO accounts(member_id,iq_user_id,source,confidence,linked_at) VALUES (2,'197999999','manual',100,strftime('%s','now')*1000);"
node scripts/rematch.js 197999999
sqlite3 /tmp/coinvoo-test.db "SELECT state,matched_member_id FROM events WHERE event_id='ev-3';"
# expect matched|2

# 8. invariants
sqlite3 /tmp/coinvoo-test.db "
 SELECT 'accounts_dupes', COUNT(*) FROM (SELECT iq_user_id FROM accounts GROUP BY iq_user_id HAVING COUNT(*)>1)
 UNION ALL SELECT 'matched_without_attribution', COUNT(*) FROM events e WHERE e.state='matched'
   AND NOT EXISTS (SELECT 1 FROM attributions a WHERE a.event_id=e.event_id)
 UNION ALL SELECT 'parked_with_attribution', COUNT(*) FROM events e WHERE e.state='parked'
   AND EXISTS (SELECT 1 FROM attributions a WHERE a.event_id=e.event_id);"
# every value must be 0

# 9. Joinvoo forward is attempted and does not block the response
time curl -s "localhost:8771/api/aff?status=ftd&trader_id=197512345&amount=5&event_id=ev-4&afftrack=7000000001"
# expect < 150 ms, and later: forward_state='sent' (or 'pending' if the sandbox has no network)
```

**History import (read-only)**

10. `node scripts/import-recon.js --dry-run` reports the count of rows in `recon.db` that would be imported; the count matches `SELECT COUNT(*) FROM recon.db events`.
11. Real import is idempotent: run twice, total stays the same.

---

## Phase 3 — dashboard

1. `/dash` without credentials → 401; with credentials → 200 and six funnel numbers.
2. Numbers agree with direct SQL for the same period (test compares both, asserts equality).
3. `/dash/members?q=197318401` finds the member by broker id.
4. Member detail shows the event trail in reverse chronological order.
5. `/dash/events?tab=parked` lists only parked rows; the `Attach` action writes `path='manual'` and moves the row out of the park.
6. A 5 000-event synthetic volume renders `/dash/events` in under 800 ms.
7. Every interpolated string is escaped: a member whose `first_name` is `<script>alert(1)</script>` renders as text, not script.
8. Unmatched block is present on both Overview and Campaigns.

---

## Phase 4 — campaigns, spend, CSV

1. `POST /api/spend` twice for the same `(day, campaign, adset, ad)` upserts, does not duplicate.
2. Cost per join and cost per FTD match a hand computation on a fixture of 10 clicks, 4 joins, 2 FTDs, $100 spend.
3. ROI is `—` when spend is 0, and correct when spend > 0.
4. `/api/export/members.csv` has a header row, one row per member, and values that match the dashboard.
5. CSV fields containing commas/quotes/newlines are quoted correctly (fixture includes a name with a comma).
6. An export of 5 000 rows streams without loading everything into memory (verify peak RSS < 150 MB).

---

## Phase 5 — report, alerts, read API

1. `GET /api/report/daily?day=<yesterday>` returns the exact numbers the report will send; the report card rendered from it is byte-stable for the same input.
2. The scheduler fires once at `REPORT_HOUR` WAT, not twice, and survives a restart without double-sending (guard on `settings.last_report_day`).
3. Silence alert fires when the newest event is older than the threshold (simulate by inserting a single old event and running the check).
4. Parked-ratio alert fires at > 40 % and clears below it.
5. Read API returns the same numbers as the dashboard for the same period.
6. A restart during the report hour does not duplicate the day's report.

---

## Cross-phase regression (run before every merge)

```bash
for f in $(git diff --name-only origin/main | grep '\.js$'); do node --check "$f"; done
node --test
sqlite3 /tmp/coinvoo-test.db 'PRAGMA integrity_check;'      # expect: ok
```

And the honesty check:

```bash
# the unmatched ratio must equal what the dashboard prints
sqlite3 /tmp/coinvoo-test.db "
SELECT ROUND(100.0*SUM(state='matched')/(SUM(state IN ('matched','parked','expired'))),1)
FROM events;"
```
