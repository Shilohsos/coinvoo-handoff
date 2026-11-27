# DIRECTIVE — PHASE 8: META CONVERSIONS API (server-side)

Repo: `your-org/coinvoo` · branch `phase-8-meta-capi` from `main`
Owner: Claude · Reviewer: Wizard · Target: merge, deploy, verify against the live dataset

---

## Why

Meta ads now land on dataset **`1448899670119083`** (Coinvoo's own). Coinvoo already knows the one
thing Meta cannot see: which ad click produced which Telegram member, and which deposit that member
made. That knowledge has to leave this server as server-side events, carrying the click's `fbclid`,
deduplicated against the browser pixel, with retries that survive a restart.

Without it, every deposit we attribute in the dashboard stays invisible to Meta's optimiser.

### Verified facts (2026-11-19, do not re-litigate)

- A system-user token (app *Conversions API Application*) posts to this dataset successfully:
  `POST /1448899670119083/events` → `200 {"events_received":1}`.
- That token's `debug_token` lists only `read_ads_dataset_quality`, and `GET /1448899670119083`
  returns `(#100) Missing Permission`. **Neither means the token cannot write.** Do not build a
  "token is read-only" guard out of the scope list or a dataset-node read; the only honest probe is
  an event POST.
- `clicks` stores `fbclid`, `ua`, `ip_hash` (sha256) — **no raw IP**.
- Neither Coinvoo nor the bot snapshot holds an email or phone. Email/phone matching is **out of
  scope** for this phase.

---

## HARD RULES (unchanged — read CLAUDE.md first)

- Zero dependencies. `node:http`, `node:sqlite`, `node:crypto`. No build step. Plain ESM `.js`.
- `node --test` must be **100 % green** before merge. The existing 167 tests must not regress.
- Do **not** touch: matcher attribution rules, postback parsing, click-token generation, Caddy, DNS,
  Cloudflare, dashboard Basic Auth, the four existing services on the host.
- The token is supplied in the service `.env` only. **Never** commit it, log it, or put it in a test
  fixture. Any log line that could carry it is a review failure.
- Only the files named in each part are in scope.

---

## PART A — Configuration (`src/config.js`)

New optional variables, all read once at boot, same style as the existing block:

| Variable | Default | Rule |
|---|---|---|
| `META_CAPI_ENABLED` | `0` | `1` switches the sender on. **`0` means zero network calls, ever.** |
| `META_DATASET_ID` | — | required when enabled |
| `META_CAPI_TOKEN` | — | required when enabled |
| `META_API_VERSION` | `v22.0` | must match `^v\d+\.\d+$` |
| `META_TEST_EVENT_CODE` | unset | when set, sent as `test_event_code` on every request |
| `META_CAPI_TIMEOUT_MS` | `8000` | integer ≥ 1000 |
| `META_CAPI_MAX_TRIES` | `5` | integer ≥ 1 |
| `META_CAPI_BATCH` | `50` | integer 1–1000 |

- Enabled with a missing dataset id or token → **fail fast at boot**, naming every missing variable in
  one message (the existing `errors[]` pattern).
- Disabled → the module must never construct a URL, open a socket, or read the token.
- Expose as `config.meta` (frozen object) plus a boolean `config.meta.enabled`.

**Tests:** enabled+missing → throws listing both names; disabled → no fetch even when rows are due;
bad `META_API_VERSION` rejected; `META_CAPI_BATCH` bounds enforced.

---

## PART B — Schema (`migrations/007_meta_capi.sql`)

```sql
-- Phase 8: outbound Meta Conversions API queue. One row per thing worth sending, keyed so a retry,
-- a re-match, or a restart can never send the same conversion twice.
CREATE TABLE meta_sends (
  send_id    TEXT PRIMARY KEY,          -- 'join:<brand_id>:<telegram_id>' | 'evt:<event_id>'
  kind       TEXT NOT NULL,             -- lead | registration | purchase
  ref        TEXT NOT NULL,             -- the member id or event id, as text
  brand_id   INTEGER,
  state      TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
  tries      INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER,
  resp       TEXT,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX idx_meta_due ON meta_sends(state, next_at);

-- Raw client IP for match quality. The hash stays the dashboard's only view of the address.
ALTER TABLE clicks ADD COLUMN ip_raw TEXT;
```

Additive only. Existing rows keep `NULL`. **`ip_raw` must never appear** in the dashboard, the CSV
exports, the read API, or any log line.

---

## PART C — Sender (`src/capi.js`, new)

### C1. Event mapping (pure, testable)

| Source | Meta `event_name` | `action_source` |
|---|---|---|
| member join (`recordJoin`) | `Lead` | `chat` |
| `events.kind = 'reg'` | `CompleteRegistration` | `website` |
| `events.kind = 'ftd'` | `Purchase` | `website` |
| `events.kind = 'dep'` | `Purchase` | `website` |

`Purchase` carries `custom_data: { value: <amount>, currency: <ISO> }`. `amount` must be > 0; a
non-positive amount skips the send with `state='skipped'` and reason `bad_amount`.

### C2. `user_data`, in this order of preference

- `external_id` — `sha256('coinvoo:' + telegram_id)`, hex. Deterministic: the same member always
  produces the same value, and it never exposes the Telegram id.
- `fbc` — only when a bound click has `fbclid`:
  `fb.1.<clicks.created_at>.<fbclid>` (milliseconds, exactly as stored).
- `client_user_agent` — `clicks.ua`.
- `client_ip_address` — `clicks.ip_raw` when present, else omit. **Never** send `ip_hash`.
- `country` — `events.country` when it is two letters; uppercase it.
- `fbp` — not captured, omit. Do not invent one.

An event with **no** `user_data` key left besides `event_source_url` must be skipped
(`state='skipped'`, reason `no_user_data`) rather than sent — Meta rejects those anyway
(`subcode 2804050`) and they pollute the queue.

`event_source_url` — `clicks.referer` when it parses as http(s), else omit.

### C3. The request

`POST https://graph.facebook.com/{version}/{dataset_id}/events?access_token=…`

Body: `{ data: [ { event_name, event_time, event_id, action_source, user_data, custom_data?,
event_source_url? } ], test_event_code? }`

- `event_time` — seconds, UTC. For a join: `members.joined_at / 1000`. For a postback:
  `events.received_at / 1000` (never "now" — a backfill must keep the true time).
- `event_id` — the `send_id`. This is the dedup key against the browser pixel and against retries.
- Batch up to `META_CAPI_BATCH` rows per call.

### C4. State machine — `drain(limit)`

- Select `state='pending'` rows with `next_at IS NULL OR next_at <= now`, oldest first.
- Success (`200` and `events_received === n`) → `sent`, `sent_at = now`, `resp` = first 200 chars.
- `429`, `500`, `502`, `503`, `504`, or a network throw → `tries++`, backoff minutes
  `[1, 2, 4, 8, 15, 30, 60]` (reuse `config.backoffMin` shape), `next_at = now + backoff`.
  At `tries >= META_CAPI_MAX_TRIES` → `failed`.
- Any other `4xx` → `failed` immediately, `resp` = Meta's `error_user_msg` or `message`, truncated.
  **Scrub the token** out of any stored response.
- Never throws. A dead Meta never affects a postback, a dashboard read, or the worker tick.

### C5. Enqueue helpers

- `enqueueJoin(db, member, now)` → `INSERT OR IGNORE` `join:<brand_id>:<telegram_id>`, kind `lead`.
- `enqueueEvent(db, event, now)` → only when `event.state = 'matched'` and
  `kind IN ('reg','ftd','dep')`; `INSERT OR IGNORE` `evt:<event_id>`.
- Both are no-ops when `config.meta.enabled` is false — but they still **record** the row? **No.**
  Disabled means no rows at all: an operator who turns this on tomorrow should not inherit a
  day of unsendable backlog. Backfill is Part G's job.

---

## PART D — Wiring

1. `src/routes/join.js` — after a successful `recordJoin`, call `enqueueJoin`. Wrapped so a throw
   cannot fail the join.
2. `src/matcher.js` — on the `matched` transition (the one place `state = 'matched'` is written),
   call `enqueueEvent`. Same wrapping.
3. `src/worker.js` — in the tick, after the existing forwards:
   `const meta = await capi.drain(config.meta.batch);` and add `meta` to the tick summary log.
4. `src/server.js` — construct the sender once, pass it through `deps` like `forwarder`; log one boot
   line: `[coinvoo] meta capi enabled dataset=<id> version=<v>` or
   `[coinvoo] meta capi disabled`. **Never log the token.**

---

## PART E — Raw IP capture (`src/routes/click.js`)

Store `ip_raw = clientIp(req)` on every new click, beside the existing `ip_hash`. Nothing else
changes: no validation, no rate-limit interaction, no response change.

If `clientIp` returns `null` (no header, no socket address), store `NULL` — do not invent one.

---

## PART F — Tests (`test/capi.test.js`, new; `test/click.test.js` extended)

Use the injected `deps.fetchImpl` pattern already in `forward.js`. Assert:

1. Mapping table — every kind, including `ignored` → no row.
2. `fbc` built as `fb.1.<ms>.<fbclid>` from a bound click; absent when the click has no `fbclid`.
3. `external_id` is the same value for the same telegram id across runs, and different for another id.
4. `ip_hash` is never present in any outgoing payload; `ip_raw` is used when set.
5. Disabled config → **zero** `fetchImpl` calls, even with due rows in the table.
6. `200` marks `sent`, sets `sent_at`, and a second `drain` sends nothing (dedup).
7. `500` → `tries=1`, `next_at` in the future, state still `pending`; at max tries → `failed`.
8. `400` with `error_user_msg` → `failed` immediately, message stored, token absent from `resp`.
9. A throwing `fetchImpl` does not reject `drain`.
10. Batch: 120 pending rows with `META_CAPI_BATCH=50` → three calls, 50/50/20.
11. A postback for an unmatched event creates no `meta_sends` row; the re-match later creates one.
12. `recordJoin` still returns its normal result when the enqueue throws.

---

## PART G — Ops

- `reference/env.example` — document every variable above with placeholders only.
- `scripts/meta-backfill.js` — matched events from a `--since <YYYY-MM-DD>` window, **dry-run by
  default**; `--send` enqueues and drains; prints `would_send`, `sent`, `failed`, `skipped`.
- `scripts/proof-phase8.sh` — enabled state, dataset id, version, rows by state, today's `sent`
  count, and the last `resp` (truncated). No token in the output.

---

## Acceptance criteria

1. `node --test` green, 167 existing + new tests.
2. With `META_CAPI_ENABLED=0`, `grep -r` finds no code path that builds a Meta URL outside `capi.js`.
3. A real join and a real matched `ftd` each produce exactly one row, one `POST`, and a `200`.
4. Restarting mid-queue resumes; nothing is sent twice (`send_id` proven unique).
5. Dashboard, CSV, read API and logs are byte-identical to before — `ip_raw` and the token appear
   nowhere.
6. No new dependency in `package.json`.

## PART H — Amendment (19 Nov, after review)

Part C2 originally skipped any website conversion with no `client_user_agent`. That silently dropped every
deposit from a member with no bound click — i.e. most organic joins. Changed: such a conversion is sent with
`action_source: system_generated`, which carries no user-agent requirement, with `event_source_url` omitted;
`external_id` alone still identifies the person. Only a missing member/event, a non-positive amount, or an
event older than Meta's 7-day window are skipped now.

---

## Out of scope — do not build

Browser pixel installation (landing pages live outside this repo), email/phone hashing, dataset
quality metrics, ad-spend import, any change to attribution rules.
