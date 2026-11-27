# Joinvoo — Capability Matrix and Build Decisions

Read from the live Joinvoo account (plan BASIC) on 12 November 2026.

---

## 1. What Joinvoo has, and what we do about it

| Joinvoo capability | Keep in Coinvoo? | Decision |
|---|---|---|
| Channel list with join methods (Joinvoo approves / request-to-join / bot-first) | **Partial** | We already run our own gate bots with approval. Coinvoo records joins; it does not approve them. |
| Join bot + welcome DM | **No** | The gate bots do this today and do it well. Untouched. |
| Offer link with `{tg_id}` | **Yes, extended** | Our personal offer link carries `afftrack=<telegram_id>`, same idea. We additionally carry a click id into the bot, which Joinvoo cannot. |
| Postback endpoint | **Yes** | Same contract, plus raw storage and an audit trail. |
| "Not matched to a person yet" pool | **Yes** | Called the parked pool; 48 h retry, then expired-but-forwarded. |
| Results screen (joins, FTDs, re-deps, revenue, matched %) | **Yes** | Overview screen. Matched % is mandatory, never hidden. |
| Campaign breakdown | **Yes** | Campaigns screen; v1 spend is manual. |
| Money: spend, cost per join, cost per FTD, payback | **Yes** | Cost/join, cost/FTD, ROI. Payback horizon is P2. |
| Telegram alerts + daily report card | **Yes** | Phase 5. Plain text, no markdown. |
| Landing pages / path builder | **No** | Out of scope. We already have PHP landing pages on our own domain. |
| Developer API | **Partial** | Read API in Phase 5; write API is unnecessary (the postback endpoint is the write path). |
| Live report share links | **No** | v1 is single-operator. |
| White label | **No** | Out of scope. |
| Team inbox (Replyvoo) | **No** | Out of scope. |

---

## 2. Where Joinvoo structurally loses

Three facts, measured on the live account:

1. **Attribution requires Joinvoo's own join flow.** If the member joins through our bot or a plain channel invite, Joinvoo sees a member but no source. Live count: **55 of 57 signups untagged (96.5 %)**.
2. **The offer link supports `{tg_id}` only.** No click id, no campaign, no creative. Ad-level optimisation stops at "joined" and the deposit cannot be traced back to the ad that caused it.
3. **No reconciliation path.** A customer who registers with no link at all is invisible forever. Coinvoo recovers them through `trader_id → iq_user_id → telegram_id`.

Our measured position: **51 % of postbacks matched today, 84 % ceiling** once members connect their accounts (1,830 of 2,187 events; 867 of 1,067 IDs).

---

## 3. Where Joinvoo is ahead (be honest about it)

- Mature product, uptime, support, and a UI that needs no one to maintain it.
- Ad-platform integrations and spend pulling that we are deferring to P2.
- Landing-page builder.
- White label, team seats, share links.

Translation: Coinvoo wins on the only number that decides where the money goes — **revenue attributed to the ad that produced it** — and loses on polish. That is an acceptable trade because we are the only operator.

---

## 4. Shared dependency, shared risk

Both systems depend on Affstore continuing to send `trader_id` and `event_id` on every postback. If they stop:

- Path C (reconciliation) weakens to click-id-only;
- duplicate detection degrades to the soft rule;
- the affiliate Telegram channel feed becomes the fallback source.

Mitigation in Coinvoo: the channel feed is a second writer to the same `events` table (Phase 2 import script + a feed reader in P2), so a silent network does not mean a silent system.

---

## 5. Transition

1. Coinvoo runs in parallel from Phase 2 onward. Every event is stored, matched, **and forwarded to Joinvoo**.
2. For one week, compare: event counts, matched counts, matched Telegram ids, revenue sums, and per-day totals.
3. Only when the two agree row-for-row on `event_id`, repoint the postback URL to Coinvoo alone.
4. Cancel Joinvoo after a further week of clean Coinvoo-only operation.

Rollback at any point: point the postback URL back at Joinvoo (or at `aff-recon` on 8769). Coinvoo's database keeps everything it saw.
