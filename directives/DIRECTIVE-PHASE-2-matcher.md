# DIRECTIVE — PHASE 2: Postback Receiver, Matcher, Parked Pool

**Branch:** `phase-2-matcher`
**Depends on:** Phase 1 merged (`213c7d9`) and running on `10.0.0.13`
**Parent docs:** `docs/03-attribution-rules.md` (the law), `docs/05-api-spec.md §3–5`, `docs/07-ops-deploy.md §8`
**Estimated size:** 2 days

---

## 0. Locked decisions (15 Nov 2026) — supersede the parent docs where they differ

1. **brand-one only.** Brand `brand-one` is active; `brand-two` is seeded but `active = 0`. Do not build anything brand-two-specific, and `/api/links` already rejects inactive brands — leave that behaviour alone.
2. **The bot database is on another host.** `BOT_DB=/srv/trading-bot/trading-bot.db` (153 MB, hot, on `10.0.0.14`) is **not reachable** from the Coinvoo host. Do not try to open it, mount it, or SSH to it. Instead read the snapshot:
   - path: `/srv/coinvoo/botdb-snapshot.db` (SQLite, ~276 KB)
   - table: `user_accounts(telegram_id INTEGER, iq_user_id TEXT, username TEXT, currency TEXT, approval_status TEXT, created_at TEXT)`
   - index: `idx_ua_iq` on `iq_user_id`
   - freshness: `SELECT value FROM meta WHERE key = 'synced_at'` (ISO-8601 UTC), refreshed every 5 minutes by a cron on the bot host
   - open with `readOnly: true`; if the file is missing or unreadable, treat the rule as a miss and log `[coinvoo] snapshot unavailable` at most once per hour
   - if `synced_at` is older than 30 minutes, log `[coinvoo] snapshot stale age=<n>s` once per worker tick (matching still proceeds — a stale snapshot is better than none)
   - `BOT_DB` is therefore **not** used in Phase 2; do not add it to config.
3. **No postback cutover yet.** Affstore keeps posting to the existing receiver on the main host. Coinvoo receives a **mirror** of each event: the old receiver forwards a copy to `https://trk.example.com/api/aff`. Consequences for this build:
   - every event must be idempotent on `event_id` (already specified) — duplicates from a mirror retry are normal;
   - the `source` of an event is `network=affstore` regardless of which receiver saw it first;
   - do **not** change any Caddyfile, DNS record, or Affstore row. The route `trk.example.com/api/aff* → 127.0.0.1:8770` is already live and verified.
4. **Also import history** (both idempotent, both required this phase):
   - `scripts/import-recon.js` — `/srv/aff-recon/recon.db` is **not** on this host either. Ship the script so it runs where that file exists, and prove it with a **fixture** copy checked into `test/fixtures/recon-sample.db`. The PR must state that the production run is operator work.
   - `scripts/backfill-members.js` — seed `members` from (a) `botdb-snapshot.db` (3,181 rows) with `join_source = 'backfill:botdb'`, and (b) an optional `--gate-db <path>` import of a gate-bot `users` table with `join_source = 'backfill:gate'`. Neither has a `click_id`. Never overwrite an existing member.
5. **Deployment target** is a **systemd** unit (`coinvoo.service`), not PM2 — PM2's daemon on that host mangles ecosystem files. Restart command: `systemctl restart coinvoo`; logs: `journalctl -u coinvoo -f`. Do not add PM2 entries.

---

## Scope lock

Build the money layer: receive postbacks, store them raw, decide who they belong to, park what cannot be decided, forward to Joinvoo in parallel. Do not build the dashboard (Phase 3) or reports (Phase 5). Do not change Phase 1 behaviour except where this directive says so.

---

## 1. What this phase delivers

```
Affstore postback → POST|GET /api/aff
                      1 store raw (immutable, dedupe on event_id)
                      2 match: afftrack → trader_id(accounts) → click → trader_id(bot db) → parked
                      3 attributions + attribution_log
                      4 forward to Joinvoo (parallel run)
                      5 return {ok:true} in <150 ms
```

Plus a 60 s worker that re-runs parked events and retries failed forwards.

## 2. Files to create / change

```
src/routes/postback.js        new — GET|POST /api/aff
src/matcher.js                new — resolve(event) → {member_id, path, confidence, notes[]}
src/botdb.js                  new — read-only lookup into BOT_DB (users.iq_user_id → telegram_id)
src/forward.js                new — Joinvoo forwarding + backoff bookkeeping
src/worker.js                 new — 60 s retry/expire/rollup tick (single-flight)
src/routes/health.js          change — extend /api/aff/stats with event counters
src/server.js                 change — mount routes, start worker
migrations/003_events.sql     new — events, attributions, attribution_log, costs,
                              daily_rollup, plus accounts if not created in 001
migrations/004_views.sql      new — v_member_value, v_campaign_perf
scripts/import-recon.js       new — idempotent import of /srv/aff-recon/recon.db
scripts/backfill-members.js   new — seed members from botdb-snapshot.db and an optional
                              gate-bot users table (see §0.4)
scripts/rematch.js            new — CLI: re-run the matcher for one trader_id or event_id
scripts/proof-phase2.sh       new — docs/08 Phase 2
test/fixtures/recon-sample.db new — 20-row fixture proving import-recon.js without the
                              production file
test/matcher.test.js          new
test/postback.test.js         new
test/backfill.test.js         new — member backfill is idempotent and never overwrites
```

## 3. Postback receiver — `GET|POST /api/aff`

Requirements:

1. Parse query string (GET) and `application/x-www-form-urlencoded` or JSON body (POST) into one flat object. Preserve the **complete** original payload as `payload_json` (JSON-encoded).
2. Normalise `status` → `kind` per `docs/03 §6`. Unmappable → store with `state='ignored'`, `ignore_reason='bad_kind'`, return 200.
3. Generate `event_id` (`crypto.randomUUID()`) when the network omits it.
4. `INSERT OR IGNORE` into `events`. If `changes === 0` → duplicate → `{ok:true, event_id, duplicate:true}`, stop. No matching, no forward.
5. Store **before** matching. The raw row must exist even if the matcher throws — wrap the matcher in its own try/catch and, on failure, leave `state='new'` and log loudly.
6. Match (§4), write `attributions` + `attribution_log`, set `state` and `matched_*`.
7. Schedule the forward with `setImmediate` — never in the response path.
8. Respond. Budget: p99 < 150 ms.
9. Never return 5xx for a stored event. Only a genuine DB failure returns 500.

## 4. Matcher — `src/matcher.js`

Implement `docs/03-attribution-rules.md` literally. Exported shape:

```js
resolve({ brand_id, trader_id, aff_track, click_id, kind, amount, currency })
  → { member_id|null, account_id|null, path, confidence, notes: [{candidate, reason}] }
```

Required sequence:

| # | Rule | Confidence | Implementation |
|---|---|---|---|
| 1 | `afftrack` is a decimal Telegram id present in `members` for the brand | 100 | direct query |
| 2 | `trader_id` in `accounts` | 90 | `accounts.iq_user_id` → member |
| 3 | `trader_id` in the snapshot `user_accounts` → `telegram_id` → member | 90 | `/srv/coinvoo/botdb-snapshot.db`, read-only; open with `{ readOnly: true }` |
| 4 | postback `clickid` equals `members.click_id` | 85 | |
| 5 | none | 0 | `state='parked'` |

Additional rules:

- Stub guard runs **before** matching: `trader_id` fails `/^\d{5,}$/`, or `afftrack`/`clickid` matches `/test/i`, or `amount <= 0` on `ftd|dep` → `ignored`, `ignore_reason='stub_guard'`.
- Soft duplicate: same `(trader_id, kind, amount)` within 120 s → stored, `ignored/duplicate_soft`.
- Multi-candidate order: account owner → matching `click_id` → earliest `joined_at` → most recent `last_seen_at`. Every rejection writes a log row.
- `afftrack` naming an unknown Telegram id → note `afftrack_unknown`, continue to rule 2 (do not stop).
- Rule 2 vs rule 3 disagreement → trust `accounts`, note `trader_conflict`.

Snapshot access (`src/botdb.js`):

- Open `/srv/coinvoo/botdb-snapshot.db` with `new DatabaseSync(path, { readOnly: true })`; one cached connection, closed on `SIGTERM`. Never write to it.
- Query: `SELECT telegram_id, iq_user_id, username, approval_status FROM user_accounts WHERE iq_user_id = ?`.
- Missing/unreadable file → log `[coinvoo] snapshot unavailable` at most once per hour, treat as a miss, never fail the postback.
- Stale snapshot (`meta.synced_at` older than 30 min) → log `[coinvoo] snapshot stale age=<n>s` once per worker tick, keep matching.
- Because the snapshot may lag by up to 5 minutes, a brand-new account can miss its first event. That event parks and is picked up by the worker on the next tick — this is expected, and the reason the parked pool exists.

## 5. Parked pool

- `state='parked'`, `attributions` row **not** written (a parked event has no decision).
- Re-run triggers:
  - worker tick (60 s);
  - immediately after `POST /api/join` creates a member whose `telegram_id` or later `accounts` row matches a parked event;
  - `node scripts/rematch.js <trader_id>` for manual repair.
- After `PARK_HOURS` (48): `state='expired'`, and the forward still happens (unattributed).
- Every transition logs one line: `[coinvoo] parked ev=<id> trader=<id> reason=no_member`.

## 6. Forward to Joinvoo (parallel run)

- `JOINVOO_PB` from env; `PARALLEL_FORWARD=1` enables.
- Send: `status`, `net`, `afftrack` (the resolved Telegram id when known, else the inbound `afftrack`), `event_id`, `trader_id`, `amount`, `country_code`.
- Never send our click id in `clickid` — Joinvoo has no concept of it; leave their field untouched.
- Outcome → `forward_state` (`sent`/`failed`), `forward_resp` (first 500 chars), `forward_tries++`, `forward_next_at` with backoff `[1,2,4,8,15,30,60]` minutes.
- The worker retries `forward_state IN ('pending','failed')` when `forward_next_at <= now`.
- A forward failure **never** affects the stored event or the attribution.

## 7. Worker — `src/worker.js`

One `setInterval(60_000)` with a `busy` flag (skip the tick if the previous is still running). Per tick, in this order:

1. expire parked events older than `PARK_HOURS`;
2. re-run parked events younger than `PARK_HOURS` (limit 200 per tick, oldest first);
3. retry forwards whose `forward_next_at <= now` (limit 100);
4. rebuild `daily_rollup` for today and yesterday (Africa/Lagos day boundaries).

Every tick logs exactly one summary line:

```
[coinvoo] worker tick parked=12 rematched=3 expired=0 forwards=5 rolled_up=2 took=84ms
```

## 8. History import — `scripts/import-recon.js`

- Reads `/srv/aff-recon/recon.db` **read-only**.
- Maps each row into `events` with `event_id` unchanged, `kind` from `status`, `state` derived from `state` (`sent`→`matched` if `tg_id` present else `expired`; `pending`/`held`→`parked`; `failed`→`expired`), `forward_state='sent'` where `sent_at` is set.
- `--dry-run` prints counts per target state and writes nothing.
- Idempotent: running twice does not change row counts. Verify in the PR with before/after counts.

## 9. Caddy cutover (operator step — documented, not automated)

The directive's code does not edit Caddy. In the PR, state the exact two-line change for `docs/07-ops-deploy.md §8` step 1 (add `/api/aff2*` → 8770 for the 48 h comparison). The actual repoint is performed by the operator after the comparison passes.

## 10. Tests

Unit tests in `docs/08-test-plan.md` Phase 2 steps 1–9, plus:

- matcher precedence with a fixture covering all five rules and both conflict cases;
- stub guard on four shapes;
- duplicate hard and soft;
- parked → matched → expired lifecycle using a mocked clock;
- `BOT_DB` unreadable → event still stored, state matched-or-parked, no crash;
- invariant query returns all zeros.

## 11. Definition of done

- [ ] `node --test` green.
- [ ] `scripts/proof-phase2.sh` output in the PR, all numbered steps pass.
- [ ] Invariants from `docs/02-data-model.md §5` all return 0 against the test database.
- [ ] Import dry-run counts match the live `recon.db`; real import is idempotent (proven twice).
- [ ] Forward retry proven: kill network access, insert an event, confirm `pending`, restore, confirm `sent`.
- [ ] Postback latency < 150 ms measured on 20 sequential calls (show the `time` output).
- [ ] No write of any kind to `trading-bot.db`, `gatebot1.db`, `brand-two-onboard.db`, `recon.db`.
- [ ] PR lists the Caddy cutover steps verbatim, marked as operator work.

## 12. Do not

- Do not build the dashboard.
- Do not modify the trading bot or the gate bots.
- Do not change the Caddyfile yourself.
- Do not invent attribution when the rules do not produce one — park it.
- Do not suppress `ignored` events; they must remain visible in the data.
