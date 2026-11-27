# DIRECTIVE — PHASE 5: Daily Report, Alerts, Read API

**Branch:** `phase-5-report`
**Depends on:** Phase 4 merged
**Parent docs:** `docs/06-dashboard-spec.md`, `docs/07-ops-deploy.md §7`, `docs/05-api-spec.md §6`
**Estimated size:** 1–2 days

---

## Scope lock

Delivery and eyes: one daily card per brand, threshold alerts, and a stable read API. No new tracking, no dashboard redesign, no ad-platform API pull.

---

## 1. What this phase delivers

1. A daily Telegram report at `REPORT_HOUR` WAT (default 08:00), one card per active brand, plus an "all brands" total line.
2. Six alerts, each fired once per condition and never repeated until the condition clears.
3. A read API returning exactly what the dashboard shows, for the bots and for ad-hoc queries.
4. A daily maintenance task: rollup rebuild (already in the worker) + `payload_json` prune at 12 months.

## 2. Files

```
src/report.js              new — build the card payload + render text
src/telegram.js            new — minimal Bot API client (fetch, 10 s timeout, retry once)
src/alerts.js              new — threshold evaluation + fire-once state in settings
src/routes/readapi.js      new — /api/report/daily and the read endpoints
src/worker.js              change — schedule the report, evaluate alerts, prune old payloads
scripts/proof-phase5.sh    new — docs/08 Phase 5
test/report.test.js        new
test/alerts.test.js        new
```

## 3. Report card

Send as plain text (`parse_mode` omitted entirely — no markdown, no HTML) to `REPORT_CHAT_ID` using `REPORT_BOT_TOKEN`.

Fixed shape, no emoji, numbers with thousands separators:

```
COINVOO — brand-one — Fri 14 Nov 2026

Clicks 412 · Joins 96 · Regs 41 · FTDs 12 · Re-deps 19
Revenue $1,240.50 · Spend $600.00 · ROI +106.8%
Cost/join $6.25 · Cost/FTD $50.00

Matched 84.1% · Parked 9.2% · Expired 4.4% · Ignored 2.3%
Unattributed revenue $180.00

Top campaign: NG_Broad / 18-34 / vid_03 — 5 FTDs, $310.00
Last event: 4 min ago
```

Rules:

- Numbers come from the same query functions the dashboard uses. No second implementation.
- If a metric is not computable it prints `—`.
- `Last event` > 6 h prints `Last event: 7 h ago (silence)`.
- One card per brand, then one combined line:
  `ALL BRANDS — revenue $1,830.00 · spend $900.00 · FTDs 17`.
- Scheduler: check every 60 s; fire when `Africa/Lagos` hour == `REPORT_HOUR` and `settings.last_report_day != today`. Write `last_report_day` **before** sending, so a restart cannot double-send. If sending fails, log and do not retry the day (the next day's card covers it) — unless the failure is a network error, in which case retry up to 3 times within 10 minutes.

## 4. Alerts

Fire once per condition; store `settings.alert_state_<name>` = `firing|clear`.

| Alert | Condition | Text |
|---|---|---|
| `health` | `/api/aff/health` DB check failing | `COINVOO — database check failing` |
| `silence` | newest event older than `POSTBACK_SILENCE_HOURS` (6) while clicks exist in the last 24 h | `COINVOO — no postbacks for 7 h (last: 12:14)` |
| `parked` | parked ratio > 40 % over 24 h | `COINVOO — 47% of events unmatched in the last 24 h` |
| `forward` | any `forward_state='failed'` for > 15 min | `COINVOO — 3 postbacks failing to forward to Joinvoo` |
| `disk` | free space < 10 % | `COINVOO — disk 91% full` |
| `memory` | RSS > 250 MB for 10 min | `COINVOO — memory 268 MB` |

Delivery: `ALERT_CHAT_ID` with `REPORT_BOT_TOKEN`. One message per condition transition into `firing`; nothing while it stays firing; one `… cleared` message when it clears. No alert storms.

## 5. Read API

| Path | Returns |
|---|---|
| `GET /api/report/daily?day=YYYY-MM-DD&brand=brand-one` | Exactly the numbers the card prints, as JSON |
| `GET /api/summary?period=today\|7d\|30d&brand=` | The Overview numbers |
| `GET /api/member/:telegram_id` | Member value + last 5 events (for bot use) |

- Same auth rules as admin JSON.
- Same query functions as the dashboard.
- Responses include `generated_at`; no caching beyond `Cache-Control: no-store`.

## 6. Maintenance

In the daily tick (first tick after 03:00 WAT):

- `UPDATE events SET payload_json = NULL WHERE received_at < now - 365d AND payload_json IS NOT NULL;`
- rebuild `daily_rollup` for the previous 7 days (guards against a missed tick);
- log one line with the counts changed.

## 7. Tests

1. Report payload for a fixture day equals the dashboard numbers for the same day (programmatic comparison).
2. Scheduler fires once: simulate two ticks in the same hour → one send.
3. Restart during the report hour → no duplicate (state written before send).
4. Each alert fires once, then stays silent, then clears — driven by a mocked clock and a fixture.
5. Silence alert triggers only when clicks exist in the last 24 h (no alert at 3 a.m. on a quiet day).
6. Read API numbers equal `/dash` numbers for the same period.
7. Prune removes `payload_json` older than 365 days and leaves the row, amount and attribution intact.
8. Telegram client: 10 s timeout, one retry on 5xx/network, never retries on 400.

## 8. Definition of done

- [ ] `node --test` green.
- [ ] `scripts/proof-phase5.sh` output in the PR, including one **real** report card sent to a test chat (paste the message text and the message id).
- [ ] Alert fire-once/clear proven with the mocked clock output pasted.
- [ ] Read API equality proven against the dashboard for one day.
- [ ] Prune proven on a fixture with two old rows.
- [ ] No dependency added.

## 9. Do not

- Do not use markdown or HTML in the report or alerts — plain text only.
- Do not add ad-platform API pulling.
- Do not add a second copy of any query the dashboard already has.
- Do not send anything to a chat that is not `REPORT_CHAT_ID` / `ALERT_CHAT_ID`.
- Do not retry a failed report the same day.
