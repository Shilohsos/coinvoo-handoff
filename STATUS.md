# Build Status

Updated by the operator as phases land. Claude updates the "PR" column only.

| Phase | Title | Branch | PR | State |
|---|---|---|---|---|
| 1 | Click bridge, join capture, members | `phase-1-click-bridge` | [#1](https://github.com/your-org/coinvoo/pull/1) | **merged `213c7d9` · live on 10.0.0.13** |
| 2 | Postback receiver, matcher, parked pool | `phase-2-matcher` | [#2](https://github.com/your-org/coinvoo/pull/2) | **merged `b7277ef` · live · 3,181 members · 128 events · $1,941.72 matched** |
| 3 | Dashboard v1 | `phase-3-dashboard` | [#3](https://github.com/your-org/coinvoo/pull/3) | **merged `3bc82d7` · live · 4 screens + admin JSON · 3,408 members · 168 events · $2,025.03 matched** |
| 4 | Campaigns, spend, CSV | `phase-4-campaigns` | [#4](https://github.com/your-org/coinvoo/pull/4) | **merged `59d4cb1` · live · campaigns screen + spend upsert + 3 CSV exports** |
| 5 | Daily report, alerts, read API | `phase-5-report` | [#5](https://github.com/your-org/coinvoo/pull/5) | **merged `78838f1` · live · daily card 08:00 WAT + 6 alerts + read API + maintenance** |
| 8 | Meta Conversions API (server-side) | `phase-8-meta-capi` | — | **directive pushed · awaiting build** |

### Cross-phase review (#6, merged into phase 5)

`claude/trusting-maxwell-3pkqld` → merged as `203b823`. Four reproduced bug fixes (click counts shrinking on
re-open, missing CSRF on link minting, a real token containing `TEST` discarded as a stub, `HEAD` on an ad link
returning 405), a per-open `click_opens` log (migration `005`) that makes Clicks/Join a true click-to-join rate,
a per-IP postback rate limit (`AFF_RATE_LIMIT_PER_SEC`), broker-id linking on manual attach, a nightly database
backup (`BACKUP_DIR` / `BACKUP_KEEP`), and the Overview now uses the shared `summarize()`.

Suite after both merges: **167 tests, 167 pass**, including a run with the disk simulated at 96 % full.

## Blocking decisions before Phase 1 starts

1. **Host** — `10.0.0.11` or `10.0.0.12`. The current host is at 96 % disk.
2. **Brands at launch** — brand-one only, or brand-one + brand-two.
3. **Dashboard login** — Master only, or PA as well.

Defaults if unanswered: `10.0.0.11`, both brands, Master only.

## Live environment facts (for reference, not for code)

| Thing | Value |
|---|---|
| Gate bot, brand-one | `/root/gatebot1-bot/index.js`, 12,676 members |
| Gate bot, brand-two | `/root/brand-two-onboard-bot/index.js`, 1,287 members |
| Postback receiver today | `/srv/aff-recon/recon.py` on port 8769 |
| Trading bot DB | `/srv/trading-bot/trading-bot.db` (read-only) |
| Caddy route to repoint | `handle /api/aff*` → `localhost:8769` becomes `localhost:8770` in Phase 2 |
| Node | v22.22.2 (`node:sqlite` available) |
