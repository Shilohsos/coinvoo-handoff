# DIRECTIVE — PHASE 3: Dashboard v1

**Branch:** `phase-3-dashboard`
**Depends on:** Phase 2 merged (`b7277ef`) and live on `10.0.0.13`
**Parent docs:** `docs/06-dashboard-spec.md` (the visual contract), `docs/05-api-spec.md §6–8`
**Estimated size:** 3–4 days

---

## 0. Locked decisions (15 Nov 2026) — read before anything else

1. **Runtime is the same host and the same process.** The service runs under **systemd** (`coinvoo.service`) on `10.0.0.13`, Node 24, zero dependencies, no build step. Add routes to the existing `node:http` router; do **not** add PM2 entries, a framework, a bundler, or an asset pipeline. Restart is `systemctl restart coinvoo`; logs are `journalctl -u coinvoo -f`.
2. **The public surface already exists.** `https://trk.example.com` routes `/c/*`, `/api/*` and `/dash*` to `127.0.0.1:8770` and is live. **Do not edit Caddy, DNS, or Cloudflare.**
3. **Auth is already configured.** `ADMIN_USER` / `ADMIN_PASS` are set in `/srv/coinvoo/.env`. Basic auth (timing-safe compare) is required on `/dash*` and every `/api/` route **except** `/api/aff`, `/api/aff/health`, `/api/aff/stats`, `/api/join`, and `/c/*`.
4. **There is real data — build against it, not a toy fixture.** As of this writing: **3,181 members** (all `join_source='backfill:botdb'`), **128 events** (67 `matched`, 25 `parked`, 34 `expired`, 2 `ignored`), **$1,941.72** matched revenue, `daily_rollup` holds 2 days. Every screen must render sensibly on the live copy.
5. **Schema facts that change the queries:**
   - `events` columns are exactly: `event_id, brand_id, network, status_raw, kind, trader_id, amount, currency, country, click_id, aff_track, payload_json, received_at, state, ignore_reason, matched_member_id, matched_at, forward_state, forward_tries, forward_next_at, forward_resp`.
   - `attributions` has a row for `matched` (real path/confidence) and for `ignored`/`expired` (`path='none'`, `confidence=0`). **Parked events have no attribution row** — event screens must `LEFT JOIN`, never `JOIN`.
   - `members.click_id` is the **ad token**, not a person-specific id: many members can carry the same `click_id`. A member’s “source” is the campaign/adset/ad of that token.
   - A postback whose `clickid` matches more than one member is **parked with note `click_ambiguous`** — show the note, it is not a bug.
   - `daily_rollup.revenue` / `.spend` are **USD only** and rebuilt by the worker; counts exclude `ignored`. Use the rollup for period totals; use base tables for member/campaign/member-detail views.
   - `events.amount` is `REAL` with `events.currency` (default `USD`). Never sum across currencies; render the code.
6. **Timezone:** day boundaries and display are `Africa/Lagos` (UTC+1). Storage stays UTC epoch ms.
7. **Read-mostly.** The only writes are manual attach on a parked event (and spend entry, Phase 4). No edit/delete for members or events.
8. **Do not touch tracking.** Matcher, worker, postback route, gate-bot contract and snapshot reader are out of scope. A data bug found while building the dashboard is reported in the PR and left alone.
9. **Verifying against production data (operator step, documented in the PR):**
   ```bash
   sqlite3 /srv/coinvoo/coinvoo.db ".backup '/tmp/coinvoo-verify.db'"
   DB_PATH=/tmp/coinvoo-verify.db PORT=8780 node src/server.js   # read the copy, never the live file
   ```
   Never point a development run at the live database.

---

## Scope lock

Read-only reporting over data that already exists. No new tracking, no postback changes, no campaign maths beyond the columns this directive names (campaigns and CSV are Phase 4).

---

## 1. What this phase delivers

Four screens and the member detail page, served as HTML from the same process, behind basic auth:

- `/dash` — overview
- `/dash/members` — list, and `/dash/members/:id` — trail
- `/dash/events` — all / matched / parked / ignored, with manual attach
- `/dash/links` — link builder + recent clicks

Plus the admin JSON the HTML renders from, so the same numbers are available programmatically.

## 2. Files to create

```
src/auth.js                 new — basic auth, timingSafeEqual, applied to /dash and admin /api
src/render.js               new — layout(), esc(), table(), pagination(), fmtMoney(), fmtTime()
src/routes/dash.js          new — all HTML screens
src/routes/admin.js         new — /api/members, /api/events, /api/clicks, /api/events/:id/attach
src/queries.js              new — every SQL read used by dash + admin, one place
migrations/005_indexes.sql  new — only if a measured query needs an index (say which in the PR)
scripts/proof-phase3.sh     new — docs/08 Phase 3
test/dash.test.js           new — HTTP-level tests against a fixture database
```

## 3. Screens — exact content

Follow `docs/06-dashboard-spec.md`. The following are the acceptance-critical details:

### Overview
- Six funnel numbers: clicks, joins, registrations, FTDs, re-deposits, revenue.
- Six money numbers: spend, cost/join, cost/FTD, revenue, ROI, unattributed revenue.
- Attribution quality block: matched %, parked %, expired %, ignored % — **always rendered**, even when zero, computed as in `docs/03 §8`.
- Last 10 events, one line each.
- Period tabs write `?period=today|7d|30d` (custom range optional).
- Brand selector writes `?brand=all|brand-one|brand-two`.

### Members
- Server-side search on `q` (telegram id, username, first_name, iq_user_id) and `?page=`.
- Columns per spec; source renders the campaign/adset/ad of the bound click, or `channel` / `organic`.
- Sortable by `joined`, `total`, `last_event` via `?sort=&dir=`.

### Member detail
- Identity, value, click context, event trail, two actions (`Open raw events`, `Copy offer link`).

### Events
- Tabs: `all | matched | parked | ignored` via `?tab=`.
- Parked tab: reason per row + `Attach` form (member search by telegram id or username) → `POST /api/events/:id/attach` with `{member_id, note}`.
- Raw viewer per row: pretty-printed `payload_json` + `attribution_log` lines.

### Links
- Link builder form → `POST /api/links` → shows `url` and `telegram_url` with a copy button.
- Recent clicks table.

## 4. Admin JSON

Exactly as `docs/05-api-spec.md §6` for members, events, clicks and attach. Same query functions as the HTML screens — one implementation, two renderers. Never duplicate SQL between the JSON and the HTML path.

## 5. Rules

1. **Escape everything.** `esc()` on every interpolated value; test with a `<script>` first name.
2. **One SQL source.** `src/queries.js` exports named functions; routes call those only.
3. **No N+1.** Member list uses one query with aggregates; member detail uses at most four.
4. **Pagination** 50 rows, `?page=` preserved across filters.
5. **Performance bar:** `/dash/events` under 800 ms against a 5,000-event fixture; `/dash` under 400 ms.
6. **`—` for not-computable**, `0` only for genuine zero.
7. **Times** in `Africa/Lagos`, `DD MMM HH:mm`.
8. **No JavaScript framework.** A single inline `<script>` block for copy-to-clipboard and the row expander only. Everything must work with JS disabled except those two niceties.
9. **Auth** on every `/dash*` and every admin JSON route. Unauthenticated → `401` with `WWW-Authenticate: Basic realm="coinvoo"`.
10. **Manual attach** writes `attributions(event_id, member_id, path='manual', confidence=100, note)` and updates the event to `state='matched'`; the note lands in `attribution_log`.

## 6. Tests

`test/dash.test.js` uses a fixture database built by a helper (not the live DB) with:

- 3 brands' worth of clicks (only two brands seeded), 6 members, 8 events across all four states;
- one member whose `first_name` is `<script>alert(1)</script>`;
- one member with no click (organic), one with a full click context.

Assertions:

1. 401 without auth on every protected path.
2. Overview numbers equal direct SQL for the same period (compare programmatically, not by eye).
3. Membership search matches telegram id, username and broker id.
4. Parked tab shows only parked; attach moves the event and writes the log row.
5. Escaping holds (response body contains `&lt;script&gt;`, not `<script>`).
6. Pagination returns 50 rows and a stable page 2.
7. Performance: 5,000-event fixture, `/dash/events` < 800 ms (measure with `performance.now()` inside the test).

## 7. Definition of done

- [ ] `node --test` green including the seven assertions above.
- [ ] `scripts/proof-phase3.sh` output in the PR (uses `curl -u` against the fixture service).
- [ ] All four screens screenshotted (PNG in the PR description is fine — do not commit binaries).
- [ ] Numbers cross-checked against SQL, with the two queries pasted.
- [ ] Backup/restore test: restore last night's copy into `/tmp`, run three counts, show they match.
- [ ] No dependency added; no framework; no build step.
- [ ] No write to any database other than `coinvoo.db`.

## 8. Do not

- Do not add charts beyond inline SVG bars.
- Do not add websockets, polling, or auto-refresh.
- Do not add campaign ROI maths or CSV — Phase 4.
- Do not edit the postback path or the matcher; if a bug is found there, report it in the PR and leave it.
- Do not expose raw payloads on any public route.
