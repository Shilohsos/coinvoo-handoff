# 06 — Dashboard Specification

Plain server-rendered HTML. Dark, quiet, no framework, no charts beyond inline SVG bars. Money and counts are the only decoration.

Aesthetic: background `#0B0B0C`, panels `#141416`, hairline `#242428`, text `#E8E8EA`, muted `#8A8A90`, positive `#3FA46A`, negative `#B3403A`, gold accent `#C8A24A` for headings only. System font stack. Currency always formatted with thousands separators.

---

## 1. Overview — `/dash`

Period tabs: **Today · 7 days · 30 days · Custom**.

**Header:** brand selector (All / brand-one / brand-two), period, `last event 4 min ago`.

**Row 1 — funnel (six numbers, equal weight):**

| Clicks | Joins | Registrations | FTDs | Re-deposits | Revenue |
|---|---|---|---|---|---|

Under each: the period-over-period delta (`+12 %` vs previous period, `—` if not computable).

**Row 2 — money:**

| Spend | Cost / join | Cost / FTD | Revenue | ROI | Unattributed revenue |
|---|---|---|---|---|---|

`ROI = (revenue − spend) / spend` as a percentage; `—` when spend is 0.

**Row 3 — attribution quality (never hidden):**

```
Matched 84 %  (1,830 / 2,187)
Parked   9 %  (196)
Expired  4 %  (86)
Ignored  3 %  (75)
```

**Row 4 — today at a glance:** last 10 events, compact: `18:29 · FTD $10 · 197318401 · matched trader_id · @user`.

**Row 5 — spend entry shortcut:** link to `/dash/campaigns`.

Empty state: a single line, `No traffic recorded yet. Create a link on the Links screen.`

---

## 2. Members — `/dash/members`

Search box (`q`): matches Telegram id, username, first name, broker id.
Filters: brand, has-FTD / no-FTD, joined date range.

Columns:

| Joined | Telegram | Username | Source | Broker id | FTD | Re-deposits | Total | Last event | Path |
|---|---|---|---|---|---|---|---|---|---|

- **Source** renders `NG_Broad / vid_03` when the member carries a click with campaign data, else `channel` or `organic`.
- **Path** is the attribution rule that decided their most valuable event: `afftrack`, `trader_id`, `click`, `manual`, or `—`.
- Sorted by total descending by default; click any column header to sort.

Row click → `/dash/members/:id`.

---

## 3. Member detail — `/dash/members/:id`

**Identity block:** Telegram id (copyable), username, first name, joined, join source, click id (links to campaign context), broker id, currency.

**Value block:** FTD total, re-deposit total, lifetime total, event count, last event.

**Click context:** campaign, adset, ad, creative, `ttclid`/`fbclid` presence, click time — or `organic` in one line.

**Event trail:** every event for this member, newest first — time, kind, amount, path, confidence, link to the raw event.

**Actions:** `Open raw events`, `Copy offer link` (offer link template with their Telegram id filled in).

---

## 4. Events — `/dash/events`

Tabs: **All · Matched · Parked · Ignored**.

Columns:

| Received | Kind | Amount | Trader id | Afftrack | Country | State | Path | Member |
|---|---|---|---|---|---|---|---|---|

- **Parked** tab carries the reason per row (`no member for trader_id`, `afftrack_unknown`, `no click match`) and a **Attach** button opening a member search.
- **Ignored** tab shows `ignore_reason` (`stub_guard`, `duplicate_soft`, `bad_kind`) — visible, never counted.
- Row click → raw payload viewer (pretty-printed JSON, read-only, plus the `attribution_log` lines for that event).
- Manual attach writes `path='manual'`, `confidence=100`, and requires a note; the note appears in the log line.

---

## 5. Campaigns — `/dash/campaigns`

One row per `(campaign, adset, ad)`:

| Campaign | Ad set | Ad | Clicks | Joins | C/J | FTDs | Revenue | Spend | Cost/FTD | ROI |
|---|---|---|---|---|---|---|---|---|---|---|

- `C/J` = clicks ÷ joins (creative efficiency), `—` when joins = 0.
- Spend is entered inline: a small form at the bottom (`day`, campaign, adset, ad, spend, currency) that POSTs to `/api/spend`. Multiple days can be entered one at a time in v1.
- A totals row at the bottom sums revenue and spend for the selected period.
- `Unattributed` appears as its own pseudo-row (`campaign = '(none)'`) so missing spend/revenue is visible.

---

## 6. Links — `/dash/links`

**Create link form:** brand, campaign, adset, ad, creative → returns a short URL with a copy button, plus a QR-less plain-text preview of the destination.

**Recent clicks table:** created, token, campaign/adset/ad, `ttclid`/`fbclid` present, joined (yes/no), member.

---

## 7. Data rules that apply to every screen

1. All times render in `Africa/Lagos`, format `DD MMM HH:mm`.
2. All money renders `$1,204.50` or `₦1,204,500` per currency; mixed currencies are shown as separate columns or labelled.
3. `—` for "not computable", `0` only for genuine zero.
4. Any number that is a percentage is shown with one decimal.
5. The unmatched block from Overview appears on Campaigns too, in the footer — the same honesty rule everywhere.
6. No screen shows a bot token, an API key, or a raw IP address.
7. Pagination: 50 rows, `?page=` in the URL, keyboard-friendly.

---

## 8. What the dashboard deliberately does not have (v1)

- Charts beyond inline SVG bars.
- Team seats, comments, or an activity feed.
- A landing-page builder or link-preview thumbnails.
- Real-time websockets. Refresh is a page load; the header shows `last event N min ago`.

---

## 9. Dashboard v2 (Phase 11)

The operator asked for the dashboard to look and feel like a commercial SaaS product. v2 keeps every data rule in §7
and changes the presentation; where it relaxes a v1 limit (§8), that is said here.

**Shell.** A sidebar (Analytics: Overview, Members, Events, Campaigns · Operations: Spend, Links, System) with nav
badges for parked events and system issues, a search button that opens the command palette, the theme toggle and
sign-out. Below 900 px the sidebar becomes a drawer behind a top bar. A sign-in page replaces the browser's basic-auth
prompt (basic auth still works for scripts).

**Look.** Dark by default, light on request (remembered per browser; first visit follows the system setting).
System font stack, tabular numbers for every figure, one accent colour, green / amber / red only for meaning
(matched, parked, failing). One stylesheet and one script, both served from `/dash/assets/` with a content hash.

**Charts (v1 §8 relaxed).** Still inline SVG drawn on the server, no chart library: sparklines on the KPI tiles, a
revenue-bars-and-FTD-line chart on the Overview (hours for "Today", days up to three months, weeks beyond), and
proportional bars for the funnel, the top campaigns and the revenue column. Axis labels and tooltips are HTML, so
they stay legible on a phone; the numbers behind each chart are also given to screen readers.

**Screens added.** Spend (`/dash/spend`: rows by day with daily totals, add, delete) and System (`/dash/system`: the
health of the service and every integration, no secrets). The Overview gains "Needs attention" (parked events and
system issues, linked to where they are fixed); Campaigns gains grouping by ad set and by campaign; Events gains
per-tab counts and an attach form on the event page itself.

**Unchanged contracts.** `data-metric` / `data-value` on the Overview figures, `data-row` / `data-col` on the
campaign rows, the attribution-quality row text, `—` for not computable, one-decimal percentages, 50 rows per page,
Africa/Lagos times, money per currency and never summed across currencies, no raw IP and no secret on any screen.
