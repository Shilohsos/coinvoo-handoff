# DIRECTIVE — PHASE 4: Campaigns, Spend, Cost Metrics, CSV

**Branch:** `phase-4-campaigns`
**Depends on:** Phase 3 merged
**Parent docs:** `docs/06-dashboard-spec.md §5`, `docs/05-api-spec.md §6`
**Estimated size:** 2 days

---

## Scope lock

Money-in (ad spend) and money-out (revenue) per campaign, plus exports. No new tracking. No report scheduler (Phase 5). No changes to the click or postback paths.

---

## 1. What this phase delivers

- `/dash/campaigns` — one row per `(campaign, adset, ad)` with clicks, joins, FTDs, revenue, spend, cost per FTD, ROI.
- Spend entry (form + `POST /api/spend`), upsert semantics.
- `(none)` pseudo-row for traffic with no campaign — so missing attribution is visible, not hidden.
- CSV exports for members, events and campaigns.

## 2. Files

```
src/routes/spend.js        new — POST/GET /api/spend
src/routes/export.js       new — three CSV streams
src/routes/dash.js         change — add /dash/campaigns screen
src/queries.js             change — campaign performance + spend totals
scripts/proof-phase4.sh    new — docs/08 Phase 4
test/campaigns.test.js     new
test/csv.test.js           new
```

## 3. Campaign screen

Columns, in this order: Campaign · Ad set · Ad · Clicks · Joins · Clicks/Join · FTDs · Revenue · Spend · Cost/FTD · ROI.

Rules:

1. Rows come from `clicks` grouped by `(brand_id, campaign, adset, ad)`; joins via `members.click_id`; FTDs and revenue via matched `events`.
2. Clicks with `campaign IS NULL` group into one row labelled `(none)`.
3. `Clicks/Join` = `clicks / NULLIF(joins,0)`; when joins = 0 → `—`.
4. `Cost/FTD` = `spend / NULLIF(ftds,0)`; when ftds = 0 → `—`.
5. `ROI` = `(revenue - spend) / NULLIF(spend,0) * 100`; when spend = 0 → `—`.
6. Totals row sums clicks, joins, FTDs, revenue, spend; recomputes the ratios from the totals (not by summing the per-row ratios — state this in the PR if you get it wrong).
7. Period + brand filters identical to Overview.
8. Footer repeats the attribution-quality block from Overview.

## 4. Spend API

`POST /api/spend`

```json
{ "day": "2026-11-15", "campaign": "NG_Broad", "adset": "18-34",
  "ad": "vid_03", "spend": 120.50, "currency": "USD", "note": "TikTok" }
```

- `day` must be `YYYY-MM-DD` interpreted in `Africa/Lagos`.
- Upsert on `(brand_id, day, campaign, adset, ad)` — `INSERT … ON CONFLICT DO UPDATE SET spend=excluded.spend, …`. Store what was entered, not a sum: entering 120 twice means 120, not 240. (If a correction is needed, the operator edits the same row.)
- `spend < 0` → 422.
- `brand` is required in the body; default `brand-one` only if `DEFAULT_BRAND` is set.
- Response returns the stored row.

`GET /api/spend?from=&to=&brand=` returns rows ordered by day descending.

## 5. CSV exports

`GET /api/export/members.csv`, `/api/export/events.csv`, `/api/export/campaigns.csv`

- `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="coinvoo-members-YYYY-MM-DD.csv"`.
- Header row exactly as the dashboard columns (snake_case in the CSV).
- RFC 4180 quoting: fields containing `,`, `"`, `\n` are wrapped in quotes and inner quotes doubled.
- **Streaming**: read with a cursor/iterator and write chunks; do not accumulate the file in memory. Test with 5,000 rows and assert peak RSS < 150 MB.
- Period + brand filters apply; defaults to the last 30 days when no filter is supplied.
- No PII beyond what the dashboard already shows: telegram id, username, first name, broker id, amounts, campaign context. No IP, no ssid, no tokens.

## 6. Tests

1. Fixture: 10 clicks (3 campaigns + 1 null-campaign), 4 joins, 2 FTDs ($50 each), 1 re-deposit ($10), spend $100 on one campaign.
2. Cost/join, cost/FTD and ROI match hand-computed values; the totals row recomputes from totals.
3. `(none)` row appears and carries the null-campaign clicks.
4. Spend upsert: POST twice with different amounts → one row, latest amount.
5. Spend with `spend: -5` → 422.
6. CSV: header present, row count equals the dashboard count, a member named `Doe, John` is quoted correctly, a note containing a newline stays in one field.
7. Streaming: 5,000-row export completes with peak RSS < 150 MB.
8. `/dash/campaigns` renders in < 600 ms on the fixture.

## 7. Definition of done

- [ ] `node --test` green.
- [ ] `scripts/proof-phase4.sh` output in the PR.
- [ ] The three CSVs downloaded in the proof and their first three lines pasted into the PR.
- [ ] Totals row proven correct against an independent SQL sum (two queries pasted).
- [ ] No dependency added; streaming proven.
- [ ] Attribution-quality block present on the campaigns screen.

## 8. Do not

- Do not pull ad spend from TikTok/Meta APIs — manual entry only (that is P2, Phase 5+).
- Do not alter the click or postback paths.
- Do not add per-day spend history (one row per day per ad, superseded on edit).
- Do not invent revenue: only matched `ftd`/`dep` amounts count, and unattributed money is reported separately.
