# 00 — Product Scope (approved)

**Project:** Internal attribution platform for the brand-one / brand-two funnels
**Codename:** `coinvoo`
**Date:** 12 November 2026
**Status:** approved for build

---

## 1. Purpose

Replace Joinvoo with our own system that answers one question end to end:

> Which ad click produced which Telegram member, and how much money did that member deposit?

Joinvoo answers this only when the member walks through *its* join flow. Our version must answer it for **everyone** — including members who joined through the bot, through a plain channel link, or before the system existed.

### Success criteria

1. Every new join is tagged to a source (ad → campaign → ad set → creative) or explicitly marked "organic".
2. Every registration and deposit is attached to a person, or parked as unattributed with a reason.
3. A daily report lands in Telegram: clicks, joins, registrations, first deposits, re-deposits, revenue, spend, cost-per-outcome.
4. No member ever notices the machinery. Zero extra taps beyond joining.

---

## 2. What Joinvoo does today (verified against the live account)

| Area | What it provides |
|---|---|
| Channels | Channel list, join methods (Joinvoo approves / request-to-join / bot-first), invite links |
| Join bot | Approves join requests, sends welcome DM |
| Offer link | Per-person link containing `{tg_id}` — the only placeholder supported |
| Deposits | Postback endpoint, event log, "not matched to a person yet" pool |
| Results | Joins, FTDs, re-deposits, revenue, matched % |
| Campaigns | Ad-level breakdown |
| Money | Spend entry, cost-per-join, cost-per-deposit, payback |
| Reports | Telegram alerts + daily report card |
| Extras | Landing pages, paths, developer API, live report links, white label, team inbox |

### Known limits that cost us money today

- Only `{tg_id}` — no click id, so ad-level attribution stops at "joined".
- Matching requires the member to arrive through Joinvoo's own join flow.
- **55 of 57 sign-ups in the current account are untagged.**
- No visibility into what happened before the join.

---

## 3. The attribution problem, stated properly

There are exactly three ways a person can arrive, and the system must handle all three.

**Path A — ad → our link → bot → offer link (best)**
Ad click carries `ttclid`/`fbclid` → our short link stores it and 302s to `t.me/<bot>?start=<click_id>` → Telegram hands the bot that payload → bot stores the click against the Telegram id and DMs a personal offer link → registration postback carries `trader_id` → matched with full ad context.

**Path B — channel invite (no click id)**
Person joins the channel directly. The gate bot sees the join request and the Telegram identity, but not the ad. Joins are counted, source = channel/organic. If they later register through a personal link, they re-enter Path A.

**Path C — plain affiliate link (nothing)**
Person registers with no link at all. Recovered by reconciliation: postback `trader_id` → `users.iq_user_id` → `telegram_id` → the person. Ad context is lost, the person is not.

> Joinvoo only really does Path B and part of Path A. Path A-with-click-id and Path C are what make this clone worth building.

---

## 4. Scope

### In scope

- Click capture and short links
- Join capture (bot approvals + channel joins)
- Registration / FTD / re-deposit capture via postbacks
- Matching engine with confidence and a parked pool
- Dashboard: members, events, attribution, campaigns, money
- Daily Telegram report
- CSV export
- Multi-brand (brand-one, brand-two) and multi-channel from day one
- Audit log of every attribution decision

### Out of scope (v1)

- White label for third parties
- Team inbox / live chat (the Replyvoo equivalent)
- Landing page builder
- Mobile apps
- Automated ad-spend API pull (manual entry in v1; API later)

---

## 5. Modules and priority

### P0 — must exist for launch

**M1. Click bridge**
`GET /c/<token>` → records click → 302 to `t.me/<brand_bot>?start=<click_id>`.
Captures: click id, brand, campaign/adset/ad/creative, `ttclid`, `fbclid`, landing timestamp, IP hash, user agent.
Target: redirect under 300 ms, pixel unaffected.

**M2. Join capture**
- Bot `/start <payload>` → stores `click_id` against the Telegram id, sends welcome + personal offer link.
- Join-request approvals (existing bots) → creates a member row with source = `join:<channel>`.
- De-dupe: one member per Telegram id per brand.

**M3. Postback receiver**
`GET|POST /api/aff?status=reg|ftd|dep&net=…&trader_id=…&amount=…&event_id=…`
Stores the raw event *before* any interpretation (immutable), dedupes on `event_id`, returns 200 fast.

**M4. Matcher**
Resolution order, highest confidence first:
1. `afftrack` → Telegram id (exact, confidence 100)
2. `trader_id` → `users.iq_user_id` → Telegram id (confidence 90, try candidates until match)
3. `click_id` → member (confidence 85)
4. Parked — no match, retried for 48 h, then marked `expired`

Every decision is written to `attribution_log` with the path used.

**M5. Stub guard + hygiene**
Broker test postbacks (`trader_id=1`, `test_aff_track`) are stored but never matched.

### P1 — the dashboard

- **M6 Overview** — today / 7 days / 30 days: clicks, joins, registrations, FTDs, re-deposits, revenue, spend, cost-per-join, cost-per-FTD, matched %.
- **M7 Members** — searchable: Telegram id, username, join date, source (campaign/creative or organic), broker id, deposits total, last activity, attribution path. Row expands to the full event trail.
- **M8 Events** — every postback: time, network, type, trader id, amount, matched person (or reason unmatched), raw payload.
- **M9 Campaigns** — spend per campaign/creative, joins, FTDs, revenue, cost per outcome, ROI. Manual spend entry in v1.
- **M10 Parked pool** — the "not matched" queue with the reason, and a one-click manual attach.

### P2 — after launch

- **M11** Daily Telegram report (morning card, per brand)
- **M12** CSV exports (members, events, campaigns)
- **M13** Read API for the bots and for reporting
- **M14** Alerts: deposit spike/drop, postback silence, unmatched ratio above threshold
- **M15** Ad-spend API pull (TikTok first)

---

## 6. Risks and dependencies

1. **Postback coverage.** If Affstore stops sending `trader_id` for some events, Path C weakens. Mitigation: the affiliate channel feed is a second, independent source; both write to the same events table.
2. **Telegram `?start=` payload** is limited to 64 characters — click ids must be short (base32, ≤24 chars).
3. **Disk.** The current host is at 96 % (4.2 GB free). The platform itself is small; confirm the host choice before Phase 1.
4. **Attribution honesty.** The parked pool can grow if people register anonymously. The dashboard must show the unmatched ratio plainly rather than hide it.
5. **Parallel running.** Keep Joinvoo live until our numbers reconcile against theirs for one week; then cancel.

---

## 7. Acceptance tests (product level)

1. Click `/c/<token>` → lands in the bot → bot DMs the personal link → member row carries the click id and campaign.
2. Test postback with `trader_id=1` → stored, never matched (stub guard).
3. Real registration postback → matched to the right Telegram id, path shown as `afftrack` or `trader_id`.
4. Deposit arriving before the person is known → parked → matched automatically when they later connect.
5. Duplicate `event_id` → rejected, counted once.
6. Dashboard totals for a day equal the raw event counts.
7. Person with two Telegram ids on one broker account → matcher tries candidates until one confirms, logs the choice.

---

*End of scope.*
