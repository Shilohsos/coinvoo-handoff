# CLAUDE.md — Build Law for Coinvoo

This file governs every phase. Read it before writing a line. If a directive appears to conflict with this file, this file wins and you say so in the PR.

---

## 1. Scope discipline

- Work **only** inside the files named by the active directive, plus files you create inside `/srv/coinvoo`.
- Do not explore, refactor, lint, or "improve" anything else in the repository or on the server.
- Do not run repository-wide searches, audits, or greps outside the coinvoo directory.
- The four existing services (`gatebot1-bot`, `brand-two-onboard-bot`, `aff-recon`, `iqbot-v3`) are **off limits** except where a directive explicitly authorises a named, minimal edit. Phase 1 authorises exactly two such edits (join-payload capture in each gate bot). No other directive touches them.
- Do not modify any file not directly required by the active directive.
- Everything outside the directive is out of scope — ignore it entirely.

## 2. Stack — fixed

| Concern | Choice |
|---|---|
| Runtime | Node.js ≥ 22 (target: `v22.22.x`) |
| Language | Plain ESM JavaScript, `.js` files only |
| HTTP | `node:http` — a small hand-written router |
| Database | `node:sqlite` (`DatabaseSync`) — built into Node 22 |
| Crypto | `node:crypto` |
| Templates | Template literals producing HTML strings (no template engine) |
| Tests | `node:test` + `node:assert` (`node --test`) |
| Dependencies | **None.** `package.json` has no `dependencies` block |

**Prohibited:** TypeScript, tsx, ts-node, Express/Koa/Fastify, better-sqlite3, Prisma/Knex, React/Vue, any bundler, any CSS framework, any package that adds a runtime dependency. If you believe a dependency is unavoidable, stop and raise it in the PR description instead of adding it.

Rationale: the server is at 96 % disk, every existing bot was crashed at least once by a build mismatch, and a zero-dependency service cannot rot. This is not negotiable.

## 3. Code rules

1. **Parameterised SQL only.** No string interpolation of values into SQL. Identifiers may be interpolated only from a hard-coded allow-list.
2. **Never crash the process.** The HTTP handler wraps every route in `try/catch`; a thrown error logs `[coinvoo] ERROR <route>:` with the stack and returns HTTP 500 JSON. The process keeps running.
3. **Time:** store `INTEGER` epoch **milliseconds, UTC**. Render in `Africa/Lagos` (UTC+1) only at display time. Never store local strings.
4. **Money:** `REAL` amount + ISO currency code column. Never sum across currencies without labelling the result.
5. **IDs:** internal primary keys are `INTEGER`; public identifiers (click ids, event ids) are `TEXT`.
6. **Logging:** one line per meaningful event, prefixed `[coinvoo]`. Format: `[coinvoo] <verb> <key=value>…`. No emoji, no colour codes, no multi-line blobs.
7. **Config:** read from `process.env` at startup into a frozen `config` object; fail fast with a clear message if a required variable is missing.
8. **Idempotency:** every inbound write path must be safe to receive twice. Use `INSERT … ON CONFLICT DO NOTHING` where identities are natural.
9. **No background timers** except the retry worker defined in Phase 2 and the report scheduler in Phase 5. Each must be a single interval guard against overlapping runs (a `busy` flag), exactly like the bots on this server.
10. **HTML output is escaped.** One `esc()` helper, applied to every interpolated value.

## 4. Repository protocol

- Branch per phase: `phase-1-click-bridge`, `phase-2-matcher`, … Never commit to `main` directly.
- One PR per phase. The PR body must contain:
  1. what was built, in five lines or fewer;
  2. the **actual terminal output** of that phase's proof script (`docs/08-test-plan.md`);
  3. any deviation from the directive, stated plainly.
- Commit messages: `phase N: <what>` — imperative, single line, no emoji.
- Do not delete or edit files from an earlier phase without saying so in the PR.
- Do not regenerate the DDL from scratch in a later phase. Migrations are additive: `migrations/NNN_<name>.sql`, applied in order at boot, recorded in `schema_migrations`.

## 5. Definition of done — every phase

A phase is done only when all of the following are true:

1. `node --test` passes with the phase's tests.
2. The proof script from `docs/08-test-plan.md` has been run against the real service and its output is pasted into the PR.
3. The service starts clean from an empty database and from a Phase-N−1 database (both paths tested).
4. `node --check` passes on every `.js` file changed.
5. No secret, token, password, or real affiliate id appears anywhere in the diff.
6. The service survives a restart with data intact (WAL mode, no uncommitted state).
7. The PR states explicitly which directive requirements are **not** met, if any.

## 6. What you must never do

- Never place a real bot token, API key, password, or private key in the repository — not in code, not in a test, not in a comment, not in the PR body.
- Never write to the databases of the other services (`trading-bot.db`, `gatebot1.db`, `brand-two-onboard.db`, `recon.db`). Read-only, and only where a directive names it.
- Never call Telegram, IQ Option, Affstore, Joinvoo, or any external API from a test without the directive naming that call.
- Never silence an error to make a test pass.
- Never claim a phase is complete without the proof output.

## 7. Tone of your report back

Numbers, paths, and outputs. No marketing. If something failed, lead with the failure.
