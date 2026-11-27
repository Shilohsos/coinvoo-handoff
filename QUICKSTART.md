# Coinvoo — Quickstart

Clone-ready handoff package. Node >= 22. No npm dependencies.

## 1. Install

```bash
git clone <this-repo> coinvoo
cd coinvoo
```

## 2. Configure

The service reads the **process environment** — it does not parse a `.env` file itself.

```bash
cp reference/env.example .env
# edit .env, then load it into the shell / unit:
set -a; . ./.env; set +a
```

Edit `.env`. Required: `DB_PATH`, `PUBLIC_BASE`, `ADMIN_USER`, `ADMIN_PASS`,
`BRAND_ONE_BOT_USERNAME`. Everything else has a working default.

Set `ADMIN_USER` / `ADMIN_PASS` before first boot — the dashboard is Basic-auth protected.

Placeholders are shell-safe (`CHANGEME_*`), so `. ./.env` works as-is.

## 3. Run

```bash
set -a; . ./.env; set +a
npm start                     # node src/server.js
```

For systemd, use `EnvironmentFile=`; for PM2, `ecosystem.config.cjs`.

Migrations apply automatically on boot (idempotent).

## 4. Verify

```bash
npm test                      # 296 tests
```

## What it does

Bridges an ad click to a Telegram member to a deposit:

- `GET /c/:token` — click bridge; records the click, forwards to the gate bot
- `POST /api/join` — the gate bot reports who joined
- `POST /api/postback` — the affiliate network reports reg / FTD / redeposit
- `/dash` — dashboard (clicks, joins, events, money, campaigns)
- `/api/report/daily` — the daily report the bot sends

Attribution order: `afftrack` -> `trader_id` -> `click_id`; anything unmatched
parks for 48 h and then forwards unattributed.

## Layout

| Path | Contents |
|---|---|
| `src/` | the service — router, matcher, dashboard, worker, Meta CAPI |
| `migrations/` | SQL, applied in order |
| `docs/` | scope, architecture, data model, API spec, ops, test plan |
| `directives/` | the original phase-by-phase build directives |
| `ops/` | systemd unit + timer, bot-DB sync, smoke scripts |
| `scripts/` | backfills, imports, proof scripts |
| `test/` | 296 tests |

## Sanitisation

This package was prepared for third-party handoff. Brand names, hostnames, IPs,
affiliate ids and personal identifiers have been replaced with generic
placeholders. Values that matter are read from `.env` — nothing is hard-coded.
