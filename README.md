# Coinvoo — Internal Attribution Platform

**Codename:** `coinvoo`
**Purpose:** Replace Joinvoo with our own system that answers one question end to end:

> Which ad click produced which Telegram member, and how much money did that member deposit?

**Status:** COMPLETE — all 13 phases built and shipped. 296/296 tests pass.

**This is a clone-ready handoff package.** Complete source, migrations, ops scripts, tests and the original build directives. All names are generic (`brand-one` / `brand-two`), all host details are placeholders. Fill in `reference/env.example` and run.

---

## Why we are building this

Measured against the live Joinvoo account on 12 Nov 2026:

| Metric | Joinvoo | Our engine |
|---|---|---|
| Signups tagged to a source | **2 of 57 (3.5 %)** | — |
| Postback events matched to a person | — | **25 of 49 (51 %)**, 22 retrying |
| Ceiling once the person connects | n/a | **1,830 of 2,187 events (84 %)** · 867 of 1,067 IDs (81 %) |

Joinvoo can only attribute a person who arrives through **its own** welcome link, and its offer link supports a single placeholder: `{tg_id}`. Attribution therefore stops at "joined" — 55 of 57 signups are dark.

Coinvoo attributes everyone, including:

- people who join through the bot (click id survives into the bot via `?start=`)
- people who join through a plain channel invite (source = channel/organic)
- people who registered with no link at all and are recovered by `trader_id` → `iq_user_id` → `telegram_id`

## Repository map

| Path | Contents |
|---|---|
| [`docs/00-scope.md`](docs/00-scope.md) | Approved product scope — purpose, modules, phases, risks |
| [`docs/01-architecture.md`](docs/01-architecture.md) | Services, ports, request flows, design decisions |
| [`docs/02-data-model.md`](docs/02-data-model.md) | Complete SQLite DDL, indexes, retention, migration policy |
| [`docs/03-attribution-rules.md`](docs/03-attribution-rules.md) | The three arrival paths, resolution order, confidence, parked pool, stub guard |
| [`docs/04-existing-engine.md`](docs/04-existing-engine.md) | Verified inventory of what already runs on the server, and the integration contract |
| [`docs/05-api-spec.md`](docs/05-api-spec.md) | Every endpoint: request, response, errors |
| [`docs/06-dashboard-spec.md`](docs/06-dashboard-spec.md) | Screens, columns, actions, empty states |
| [`docs/07-ops-deploy.md`](docs/07-ops-deploy.md) | PM2, Caddy, env, backups, alerts, port takeover, rollback |
| [`docs/08-test-plan.md`](docs/08-test-plan.md) | Acceptance tests per phase with exact commands |
| [`directives/`](directives/) | Five build directives for Claude — one per phase |
| [`reference/joinvoo-capability-matrix.md`](reference/joinvoo-capability-matrix.md) | What Joinvoo does, what we keep, what we drop |
| [`reference/env.example`](reference/env.example) | Environment variable names (placeholders only — never real secrets) |
| [`CLAUDE.md`](CLAUDE.md) | Build law: constraints, stack, branch/PR protocol, definition of done |

## Build order

| Phase | Deliverable | Directive |
|---|---|---|
| 1 | Click bridge + join capture + member rows | `DIRECTIVE-PHASE-1` |
| 2 | Postback receiver + matcher (3 paths) + parked pool + Joinvoo forwarding | `DIRECTIVE-PHASE-2` |
| 3 | Dashboard v1: overview, members, events, parked pool | `DIRECTIVE-PHASE-3` |
| 4 | Campaigns, spend entry, cost metrics, CSV export | `DIRECTIVE-PHASE-4` |
| 5 | Daily Telegram report, alerts, read API | `DIRECTIVE-PHASE-5` |

Total: roughly **9–12 working days**. Each phase is an independent branch and PR, with a proof script whose output is pasted into the PR body.

## Non-negotiables

1. **Zero runtime dependencies.** Node 22 built-ins only: `node:http`, `node:sqlite`, `node:crypto`, `node:fs`. No Express, no better-sqlite3, no ORM, no build step.
2. **Plain ESM JavaScript.** No TypeScript, no transpiler, no bundler. The service runs exactly as written.
3. **Secrets never enter this repository.** All credentials come from environment variables. `reference/env.example` carries names and placeholders only.
4. **Append-only history.** Postback payloads are stored raw and immutable before interpretation. Every attribution decision is logged with its path.
5. **Parallel run.** Joinvoo stays live and keeps receiving every event until our numbers reconcile with theirs for one week. Coinvoo forwards — it does not withhold.
6. **Existing bots are not refactored.** Phase 1 authorises exactly one handler addition in each gate bot. Nothing else in them is touched.

## Fixed facts

| Item | Value |
|---|---|
| Service port | `8770` |
| Database | `/srv/coinvoo/coinvoo.db` (SQLite, WAL) |
| PM2 process name | `coinvoo` |
| Working directory | `/srv/coinvoo` |
| Timezone for display | `Africa/Lagos` (WAT, UTC+1); storage is UTC epoch milliseconds |
| Dashboard | `/dash` on the service, behind HTTP basic auth, fronted by Caddy |
| Host | **decision pending** — `10.0.0.11` or `10.0.0.12` (the current host is at 96 % disk) |

## Open decisions (needed before Phase 1 merges)

| # | Question | Default if unanswered |
|---|---|---|
| 1 | Host: `10.0.0.11` or `10.0.0.12`? | `10.0.0.11` |
| 2 | Brands at launch: brand-one only, or brand-one + brand-two? | both |
| 3 | Dashboard login: Master only, or PA too? | Master only |
| 4 | Ad spend in v1: manual entry, or TikTok pull in Phase 4? | manual entry |
| 5 | Keep Joinvoo in parallel for one week? | yes |

---

*Owner: the platform owner · Specification by Wizard · 12 November 2026*
