# DIRECTIVE — PHASE 1: Click Bridge, Join Capture, Members

**Branch:** `phase-1-click-bridge`
**Parent docs:** `docs/01-architecture.md`, `docs/02-data-model.md`, `docs/05-api-spec.md`, `docs/08-test-plan.md`
**Estimated size:** 1–2 days

---

## Scope lock

Build only what this directive names. Do not build the matcher, the dashboard, campaigns, or reports — they belong to later phases. Do not refactor the gate bots beyond the single addition in §6. Do not touch `aff-recon`, `iqbot-v3`, or any other service.

---

## 1. What this phase delivers

A working path from an ad click to a named member:

```
ad click → GET /c/:token → click row → 302 → t.me/<gate_bot>?start=c_<token>
                                              ↓
                          gate bot posts /api/join with the click id
                                              ↓
                                   member row carries the click
```

Nothing else. No postbacks yet.

## 2. Files to create

```
/srv/coinvoo/
├── package.json                     no dependencies, "type":"module"
├── ecosystem.config.cjs             as specified in docs/07
├── src/
│   ├── server.js                    http server, router, boot sequence
│   ├── config.js                    env → frozen config, fail-fast
│   ├── db.js                        node:sqlite open, pragmas, migrate()
│   ├── log.js                       [coinvoo] one-line logger
│   ├── util.js                      esc(), nowMs(), base32 token, ipHash()
│   ├── router.js                    tiny method+path matcher with params
│   └── routes/
│       ├── click.js                 GET /c/:token
│       ├── join.js                  POST /api/join
│       ├── links.js                 POST /api/links (admin)
│       └── health.js                GET /api/aff/health, /api/aff/stats (counters only)
├── migrations/
│   ├── 001_init.sql                 brands, channels, clicks, members, accounts,
│   │                                settings, schema_migrations  (phase 1 subset)
│   └── 002_seed_brands.sql          two rows from env placeholders
├── scripts/
│   ├── proof-phase1.sh              exactly the script in docs/08 Phase 1
│   └── make-link.js                 CLI: node scripts/make-link.js brand-one NG_Broad 18-34 vid_03
└── test/
    ├── token.test.js
    ├── iphash.test.js
    └── members.test.js
```

Phase 1 creates only the tables it needs from `docs/02-data-model.md`: `brands`, `channels`, `clicks`, `members`, `accounts`, `settings`, `schema_migrations`. The rest arrive in Phase 2 — the migration list is additive, so this is correct.

## 3. Service requirements

1. `node:http` server listening on `127.0.0.1:PORT` (default 8770).
2. Boot order: load config → open DB → set pragmas (`journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`) → apply pending migrations in one transaction each → ensure `settings.ip_salt` exists (generate 32 random bytes, hex) → print the four boot lines → listen.
3. Router: exact paths and `:param` segments. Unknown path → 404 JSON (HTML 404 for `/dash*`, which is Phase 3).
4. Every route body is wrapped: `try { … } catch (e) { log.error; res 500 json }`. The process never exits on a request error.
5. `SIGTERM`/`SIGINT`: close the server, close the DB, exit 0.

## 4. Click bridge — `GET /c/:token`

- Token regex `/^[0-9A-HJKMNP-TV-Z]{10}$/` (Crockford base32). Invalid → 404 `text/plain` `link not found`.
- Token must exist in `clicks` (the row is created by `/api/links` in §5, not on the fly — a click id that was never minted must not be honoured).
- On hit: `UPDATE clicks SET …` is **not** how context arrives — the ad context is captured at **link creation** time for the fixed values (campaign/adset/ad/creative) and at **click time** for the volatile ones (`ttclid`, `fbclid`, `gclid`, `ua`, `ip_hash`, `referer`, `created_at`).

> Design note: the link is minted per advertisement, not per person. One token = one campaign/adset/ad. The volatile click data is stamped when the URL is opened. This keeps the mint endpoint simple and makes the token safe to put in an ad.

- Response: `302`, `Location: https://t.me/<brand.bot_username>?start=c_<token>`, `Cache-Control: no-store`, `X-Coinvoo-Click: <token>`.
- If the same token is opened again, update the volatile fields and increment nothing (there is no click counter — `COUNT(*)` of the row is one; a second opening of the same ad link is the same click from the reporting point of view).

> If you believe a per-opening counter is needed, add `clicks.open_count INTEGER DEFAULT 0` and increment it — say so in the PR.

## 5. Link minting — `POST /api/links` (admin, basic auth)

Request:

```json
{ "brand": "brand-one", "campaign": "NG_Broad", "adset": "18-34", "ad": "vid_03", "creative": "v3" }
```

Response:

```json
{ "ok": true, "token": "7K2M9QX4AB", "url": "https://<PUBLIC_BASE>/c/7K2M9QX4AB",
  "telegram_url": "https://t.me/<gate_bot>?start=c_7K2M9QX4AB" }
```

Rules:

- `brand` must exist and be active → 422 `unknown_brand`.
- Token generated by `crypto.randomBytes`, mapped to the Crockford alphabet, retried on collision (collision is effectively impossible, but the check is one line).
- The row is inserted with `created_at` and the campaign fields; volatile fields stay `NULL` until the link is opened.

## 6. Join capture — `POST /api/join`

Contract exactly as `docs/05-api-spec.md §2`. Additional requirements:

- Auth: if `JOIN_KEY` is set, require header `X-Coinvoo-Key`; otherwise require the socket peer to be loopback (`127.0.0.1` / `::1`). Reject otherwise with 401.
- `click_id` present but not in `clicks` → 422 `unknown_click` (do not create the member).
- Upsert `members` on `(brand_id, telegram_id)`:
  - insert with `joined_at = now`, `join_source = source`, `click_id = click_id`;
  - on conflict: update `username`, `first_name`, `last_seen_at`; set `click_id` **only if the stored value is NULL** (first touch wins); leave `joined_at` and `join_source` untouched.
- When a member is created or first receives a `click_id`, also set `clicks.joined_at = now, clicks.member_id = <id>`.
- Response includes `created: true|false` so the bot can decide whether to send a first-time welcome.

## 7. The gate-bot patch (the only edit outside this repository)

Two files change, one new file each. Read `docs/04-existing-engine.md §6` for the exact code.

**`/root/gatebot1-bot/brand.js` and `/root/brand-two-onboard-bot/brand.js`** — new file, the `reportJoin` helper.

**`index.js` in each bot** — exactly two insertions:

1. In the `bot.start` handler, before anything else:
   ```js
   const m = /^c_([0-9A-HJKMNP-TV-Z]{10})$/.exec(ctx.startPayload || '');
   if (m) reportJoin({ click_id: m[1], telegram_id: ctx.from.id,
                       username: ctx.from.username || null,
                       first_name: ctx.from.first_name || null,
                       source: 'bot:start' });
   ```
2. In the `chat_join_request` handler, after approval succeeds:
   ```js
   reportJoin({ click_id: null, telegram_id: req.user.id,
                username: req.user.username || null,
                first_name: req.user.first_name || null,
                source: 'channel:' + req.chat.id, channel_join: true });
   ```

Constraints:

- The call is `await`-free from the handler's perspective (`reportJoin` is async but not awaited) — it must never delay the welcome DM.
- 2.5 s timeout, all errors caught and logged as `[join] coinvoo report failed: …`.
- No other line in either bot changes. Diff must show only these insertions plus the `require`.

Env additions to each bot's `.env` (names only; the values are set by the operator):

```
TRIBUTE_URL=http://127.0.0.1:8770
TRIBUTE_BRAND=brand-one          # 'brand-two' on the brand-two bot
```

## 8. Logging

```
[coinvoo] boot version=1.0.0 db=/srv/coinvoo/coinvoo.db
[coinvoo] migrations applied=2 latest=002_seed_brands
[coinvoo] listening port=8770
[coinvoo] click token=7K2M9QX4AB brand=brand-one campaign=NG_Broad
[coinvoo] join brand=brand-one tg=7000000001 click=7K2M9QX4AB created=true
```

## 9. Tests

Write and pass the unit tests in `docs/08-test-plan.md` Phase 1, then run `scripts/proof-phase1.sh` and paste its complete output into the PR.

## 10. Definition of done

- [ ] `node --test` green (token, ip_hash, members).
- [ ] Proof script output in the PR, all steps pass.
- [ ] Gate-bot patch proven live: opening `?start=c_<token>` delivers the normal welcome DM and the click is recorded.
- [ ] With coinvoo stopped, the gate bot's welcome DM still arrives (fire-and-forget proven).
- [ ] Restart preserves data.
- [ ] `package.json` lists no dependencies.
- [ ] No secret or real id in the diff.
- [ ] PR states anything not done.

## 11. Do not

- Do not build the dashboard, matcher, or postback receiver.
- Do not edit `aff-recon`, Caddy, or `iqbot-v3`.
- Do not add an npm dependency.
- Do not change the gate bots' existing wording, keyboards, or approval logic.
- Do not store a raw IP address anywhere.
