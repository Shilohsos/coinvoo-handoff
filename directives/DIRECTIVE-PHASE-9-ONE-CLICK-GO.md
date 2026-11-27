# DIRECTIVE — PHASE 9: ONE-CLICK ENTRY (`GET /go/<brand>`)

Repo: `your-org/coinvoo` · branch from `main` (`3bfe50b` or later)
Owner: Claude · Reviewer: Wizard · Target: merge, deploy, then the landing pages point at it

---

## Why

The ad landing pages currently hand traffic to a third-party tracker (Torro). That hop is being removed, so
Coinvoo becomes the only tracker in the path. Today `/c/:token` requires a token minted in advance by
`POST /api/links`, which is right for a link you paste into an ad — but wrong for a landing-page CTA, where
every visitor must become their own click.

One token reused by every visitor is actively harmful: `/c/:token` stamps `fbclid`, `ip_raw` and `ua` onto the
*same row* on every open, so the last visitor's `fbclid` wins and every member binds to one `click_id` — which
the matcher then rejects as `click_ambiguous`. So a **per-visit mint** is required, not a convenience.

Estimated scope: one new route file, roughly 80 lines, no schema change, no dependency.

---

## HARD RULES (unchanged)

- Zero dependencies, plain ESM `.js`, `node:http`/`node:sqlite`/`node:crypto` only.
- `node --test` **100 % green** before the PR. The existing 228 tests must not regress.
- Do **not** modify `/c/:token`, the matcher, the attribution rules, `report.js`, or the Phase 8 Meta sender.
- Only the files named here are in scope.

---

## PART A — `src/routes/go.js` (new)

`GET /go/:brand` — public, no auth.

1. **Brand lookup.** `SELECT id, code, bot_username FROM brands WHERE code = ? AND active = 1`.
   Unknown or inactive → `404 text: link not found`. Never fall back to a default brand.
2. **Mint.** Reuse `mintLink(db, {...})` from `src/routes/links.js` — do not copy its SQL.
   `now` comes from `deps.now()`.
3. **Field mapping.** The landing pages pass the ad platform's own names. Resolve in this order, first
   non-empty wins, each trimmed and capped at 200 characters:

   | Column | Accepted parameters |
   |---|---|
   | `campaign` | `campaign_name`, `campaign_id`, `campaign`, `utm_campaign` |
   | `adset` | `adset_name`, `adset_id`, `adset`, `utm_medium` |
   | `ad` | `ad_name`, `ad_id`, `ad`, `utm_content` |
   | `creative` | `creative` |
   | `sub1` | `placement` |
   | `sub2` | `site_source_name` |
   | `sub3` | `utm_term` |

   Pass the first two into `mintLink` as `campaign`/`adset`/`ad`/`creative`; write the rest with the stamp.
4. **Stamp the request**, on the freshly minted row only: `fbclid`, `ttclid`, `gclid`, `sub1..sub3`, the five
   `utm_*`, `ip_hash`, `ip_raw`, `ua` (512 chars), `referer` (512 chars), `clicked_at`.
   `ip_raw` is written here for Meta matching only — it must not appear in any response, log or export.
5. **Record one open** in `click_opens` with the crawler flag (`CRAWLER_UA_RE`), exactly as `/c/` does.
   No open-dedupe: two visits are two clicks, by design.
6. **Redirect**: `302` → `https://t.me/<bot_username>?start=c_<token>`; headers `cache-control: no-store`,
   `x-coinvoo-click: <token>`. The bot username must pass `BOT_RE`; if it does not, fail like `/c/` does.
7. **HEAD** answers like GET but mints and records nothing (ad-platform link checkers).
8. **Rate limit**: per client IP, `GO_RATE_PER_SEC` (default **20**), `0` disables. Over the limit → `429`
   with a short text body. Reuse the fixed-window approach already used in `postback.js`.

**Never throws**: wrap like the other routes; a failure returns 500 JSON and the process lives.

---

## PART B — wiring

- `src/server.js`: register `goRoutes` with the existing route factories. No other change.
- `src/config.js`: `GO_RATE_PER_SEC`, integer ≥ 0, default 20, same style as the neighbours.
- `reference/env.example`: document it.

---

## PART C — tests (`test/go.test.js`, new)

1. `GET /go/brand-one` → 302 to `https://t.me/<bot>?start=c_<token>`, and exactly one `clicks` row exists.
2. Two consecutive requests mint **two different tokens** and two rows.
3. Mapping: `?campaign_name=A&adset_name=B&ad_name=C&placement=P&site_source_name=S&fbclid=F&utm_term=T`
   lands `A/B/C/P/S/F/T` in `campaign/adset/ad/sub1/sub2/fbclid/sub3`.
4. `campaign_id` is used when `campaign_name` is absent.
5. Unknown brand → 404, no row, no open.
6. Inactive brand → 404.
7. `HEAD /go/brand-one` → 302, **no** click row, no open.
8. Crawler UA → row created, `click_opens.is_bot = 1`.
9. `ip_raw` is stored, and does not appear in the response body or the log capture.
10. Rate limit: with `GO_RATE_PER_SEC=2`, the third request in the same second → 429.

---

## PART D — cutover (Wizard does this, not you)

The three landing pages at `example.com` will have their CTA rewritten from
`https://thedinator.com/tracker/spots/redirect/IhBXfihA?…` to
`https://trk.example.com/go/brand-one?…` with the same query passthrough. Nothing in this repository changes
for that — it is a template edit outside this repo.

---

## Acceptance criteria

1. `node --test` green (228 existing + new).
2. In production: one request to `/go/brand-one` creates exactly one `clicks` row, one `click_opens` row, and
   redirects to the gate bot with a `c_` start payload.
3. A completed join after that redirect stores `members.click_id` = the minted token.
4. `/c/:token` still behaves exactly as before.
5. No new dependency.

## Out of scope

Landing pages, Torro, Meta pixel changes, attribution rules, the daily card, the Meta queue.
