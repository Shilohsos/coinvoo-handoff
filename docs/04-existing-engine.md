# 04 — Existing Engine (verified on the server, 15 Nov 2026)

Everything below was read from the running host, not from memory. Coinvoo is built **around** these services; it does not replace them.

---

## 1. Services already running (PM2)

| PM2 name | Path | Runtime | Role | Coinvoo relationship |
|---|---|---|---|---|
| `gatebot1` | `/root/gatebot1-bot/index.js` | node | brand-one onboarding-channel gate bot. Approves join requests, sends welcome DM. **12,676 members** in `/root/gatebot1-bot/gatebot1.db` | Phase 1 adds payload capture + one `POST /api/join` call |
| `brand-two-onboard` | `/root/brand-two-onboard-bot/index.js` | node | brand-two gate bot, same pattern. **1,287 members** in `brand-two-onboard.db` | Same Phase 1 patch |
| `aff-recon` | `/srv/aff-recon/recon.py` | `/usr/bin/python3` | Postback receiver + trader_id matcher, port **8769**. Forwards to Joinvoo. 18 sent / 16 pending at inventory time | Superseded by Coinvoo Phase 2; stays until cutover |
| `iqbot-v3-bot` | `/srv/trading-bot` | node | The trading bot. Owns the money path and the authoritative `users` table | **Read-only.** Coinvoo reads `users` for `iq_user_id → telegram_id` |
| `meta-track` | `/srv/trading-bot/meta-track.py` | python | Meta CAPI proxy, port 8766 | Untouched |
| `tiktok-track` | `/srv/trading-bot/tiktok-track.py` | python | TikTok Events API proxy, port 8767 | Untouched |
| `snap-track` | `/srv/trading-bot/snapchat-track.py` | python | Snapchat CAPI proxy, port 8768 | Untouched |
| `onboard-repost` | `/root/onboard-repost-bot/index.js` | node | Reposts forwarded content to the Yacht Club as the main bot | Untouched |
| `sales-bot` | `/srv/trading-bot` (tsx) | node | Sales KPI bot | Untouched |

## 2. Databases that matter

### `/srv/trading-bot/trading-bot.db` — the trading bot (read-only for Coinvoo)

Columns Coinvoo needs from `users`:

| Column | Use |
|---|---|
| `telegram_id` | The person |
| `iq_user_id` | Broker `trader_id` as stored by the bot |
| `username` | Display |
| `currency` | Display |
| `approval_status`, `approved_at` | Whether they are a live member |
| `funded_balance_usd` | Sanity check against postback amounts |
| `affiliate_data` | Raw affiliate payload the bot captured, when present |
| `created_at`, `last_used` | Timeline |

> `users.iq_user_id` is the bridge that makes Path C work. It is populated when a member connects their IQ Option account in the bot.

### `/root/gatebot1-bot/gatebot1.db`

```sql
CREATE TABLE users (
  telegram_id INTEGER PRIMARY KEY,
  first_name  TEXT,
  username    TEXT,
  joined_at   TEXT,
  last_msg    TEXT
);
CONFIG TABLE: config
```

### `/root/brand-two-onboard-bot/brand-two-onboard.db`

Same `users` shape, plus `seq_sent`, `seq_state`, `config`.

### `/srv/aff-recon/recon.db` — the current postback store

```sql
CREATE TABLE events (
  event_id    TEXT PRIMARY KEY,
  status      TEXT,
  trader_id   TEXT,
  amount      REAL,
  country     TEXT,
  clickid     TEXT,
  afftrack_in TEXT,
  tg_id       TEXT,
  state       TEXT,        -- sent | pending | held | failed
  tries       INTEGER DEFAULT 0,
  resp        TEXT,
  created_at  REAL,
  matched_at  REAL,
  sent_at     REAL
);
CREATE INDEX idx_events_state  ON events(state);
CREATE INDEX idx_events_trader ON events(trader_id);
```

Phase 2 imports these rows into `events` (idempotent on `event_id`) so history is not lost.

## 3. Caddy routing (current, on `example.com`)

```
handle /api/tiktok*  → localhost:8767
handle /api/snap*    → localhost:8768
handle /api/aff*     → localhost:8769     ← aff-recon today; Coinvoo takes this in Phase 2
handle /api/*        → localhost:8766     ← meta CAPI
```

Order matters: the specific `handle` blocks precede the catch-all. Coinvoo must be inserted **above** `handle /api/*`.

## 4. Affiliate network contract (Affstore → us)

Postback query parameters observed on live traffic:

| Param | Meaning | Notes |
|---|---|---|
| `status` | `reg` \| `ftd` \| `dep` | mapped in `03 §6` |
| `net` | `affstore` | network name |
| `event_id` | uuid | dedupe key |
| `trader_id` | broker account id | the reconciliation key; 9 digits in practice |
| `amount` | deposit value | present on `ftd`/`dep` |
| `currency` | ISO code | may be absent → default USD |
| `country_code` | ISO-2 | |
| `clickid` | click id from the affiliate link | often empty |
| `afftrack` | our per-member tag | set to the Telegram id on personal offer links |
| `aff_model` | `revenue` / `cpa` | |

**Two independent feeds exist** and both are useful:

1. the postback endpoint (structured, carries `trader_id`);
2. the affiliate Telegram channel feed, which the gate bots/sales bot read — the fallback source when a postback is missing.

## 5. What Coinvoo is allowed to touch

| Target | Access | Phase |
|---|---|---|
| `trading-bot.db` `users` | **read-only** queries | 2 |
| `gatebot1-bot/gatebot1.db` | **read-only** (backfill of members) | 2 |
| `brand-two-onboard-bot/brand-two-onboard.db` | **read-only** (backfill) | 2 |
| `aff-recon/recon.db` | **read-only** (history import) | 2 |
| `/root/gatebot1-bot/index.js` | **one handler addition** | 1 |
| `/root/brand-two-onboard-bot/index.js` | **one handler addition** | 1 |
| Caddy `/api/aff*` route | **repoint to 8770** | 2 |
| Everything else | **do not touch** | — |

## 6. The Phase 1 patch to each gate bot (exact contract)

Both bots are plain Telegraf v4 JavaScript. Add one function and one branch — nothing else.

```js
// brand.js — the only new file inside each bot directory
const COINVOO = process.env.TRIBUTE_URL;          // e.g. http://127.0.0.1:8770
const BRAND   = process.env.TRIBUTE_BRAND;        // 'brand-one' | 'brand-two'

async function reportJoin(payload) {
  if (!COINVOO) return;
  try {
    await fetch(`${COINVOO}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brand: BRAND, ...payload }),
      signal: AbortSignal.timeout(2500)
    });
  } catch (e) {
    console.log(`[join] coinvoo report failed: ${e.message}`);
  }
}

module.exports = { reportJoin, BRAND, COINVOO };
```

Then, inside the bot:

- **`bot.start`:** if `ctx.startPayload` matches `/^c_[0-9A-Z]{10}$/` → `reportJoin({click_id: payload.slice(2), telegram_id, username, first_name, source:'bot:start'})`.
- **`bot.on('chat_join_request')`:** after approval → `reportJoin({click_id:null, telegram_id, username, first_name, source:'channel:'+ctx.chat.id, channel_join:true})`.

Non-negotiable: the report call is fire-and-forget, wrapped, and **cannot** delay or break the existing welcome DM. If Coinvoo is down, the bot behaves exactly as it does today.

## 7. What is already proven (so we do not rebuild it)

| Capability | Where it lives now | Reuse in Coinvoo |
|---|---|---|
| `trader_id → telegram_id` matching | `aff-recon/recon.py` | Port the logic to `matcher.js`, same rules |
| Joinvoo forward | `aff-recon` → `joinvoo.com/pb/…` | Same URL, now sent **after** local matching |
| 48-hour parked retry | `aff-recon` worker | Same policy, new state machine |
| Member inventories | gate bots + `trading-bot.db` | Backfill into `members` in Phase 2 |
| Trackers | 8766 / 8767 / 8768 | Untouched; Coinvoo only reads nothing from them |
