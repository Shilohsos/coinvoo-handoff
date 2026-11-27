# DIRECTIVE — PHASE 7: META-READY (join ingest, sync, backups, UI, click tracking)

Repo: `your-org/coinvoo` · branch from `main` (`4c54944` or later)
Owner: Claude · Reviewer: Wizard · Target: merge + deploy tonight ahead of Meta ads

---

## Why

Meta ads start tonight. Clicks and postbacks are flowing (187 events today) but **the join feed has been dead since 16 Nov 11:06** — 1,500+ joins missing — and the ops layer (snapshot sync, backups) is off. Phase 7 closes every gap that can corrupt attribution once paid traffic lands.

---

## HARD RULES (unchanged)

- Zero dependencies. No framework. No build step. Node stdlib only (`node:http`, `node:sqlite`, `node:fs`).
- Tests must be **100% green** before merge. Existing suite must not regress.
- Do **not** touch: matcher attribution rules, postback parsing, Caddy, DNS, Cloudflare, dash Basic Auth.
- Only the files named in each part are in scope. Anything outside is out of scope — ignore it entirely.

---

## PART A — Join ingest (P0, blocks paid traffic)

### A1. Accept the legacy header
`src/routes/join.js` currently rejects with `missing or invalid X-Coinvoo-Key`.
The gate bot still sends `x-tribute-key` (same key value). Accept **either** header:

```
X-Coinvoo-Key: <JOIN_KEY>      → ok
x-tribute-key: <JOIN_KEY>      → ok (legacy)
neither / wrong value          → 401 unchanged
loopback with no JOIN_KEY      → unchanged
```

Implement a small helper (`joinKeyFromHeaders(req)`) so the check stays in one place. Constant-time compare via the existing `safeEqual`.

**Tests:** new header ok, legacy header ok, wrong key 401, missing key non-loopback 401, loopback still allowed.

### A2. Batch backfill endpoint
`POST /api/join/batch` — same auth as A1.

Request:
```json
{ "joins": [ { "telegram_id": 123, "joined_at": 1763387171000, "username": "x", "first_name": "Y", "join_source": "channel:-1002766084283" } ] }
```
- Max **500** rows per request, 400 `too_many` above that.
- Each row goes through the existing `recordJoin` with `now = joined_at` (so historical joins keep their real timestamp, not "now").
- Idempotent: `recordJoin` already upserts on `(brand_id, telegram_id)` — re-posting must not duplicate or rewrite `joined_at`.
- Response: `{ "created": n, "updated": n, "errors": [ {"index": i, "error": "..."} ] }`.

**Tests:** create batch, re-post same batch → `created 0`, row count unchanged, `joined_at` preserved; oversized batch 400; bad telegram_id collected into `errors`, valid rows still inserted.

### A3. Docs
`docs/05-api-spec.md`: document both header names and the batch endpoint, with the idempotency guarantee.

---

## PART B — Snapshot sync + staleness

### B1. Sync script
Add/refresh `scripts/sync-botdb.sh`:
- Target `/srv/coinvoo/botdb-snapshot.db` (was `/root/tribute/…`).
- Atomic: write `.tmp`, `mv` into place.
- Exit non-zero + log line when the source DB is unreadable.

### B2. Staleness visibility
`src/config.js`: `SNAPSHOT_STALE_MIN` (default **30**).
Worker: if snapshot mtime older than that, fire the existing alert channel **once per hour** (dedupe via settings key, do not spam).
`/api/aff/health`: add `snapshot_age_s`, `snapshot_stale`.

**Tests:** fresh snapshot → not stale; backdated mtime → stale flag true and one alert emitted; second run within the hour does not re-alert.

---

## PART C — Backups on by default

`src/config.js`: default `BACKUP_DIR` to `/srv/coinvoo/backups` when the env var is absent (still overridable). `BACKUP_KEEP` unchanged (14).
Boot: create the directory when missing; log `backup enabled dir=…`.
`/api/aff/health`: add `backup_enabled`, `backup_age_s`.

**Tests:** default resolved when env unset; directory created; nightly backup produces a file; prune keeps exactly `BACKUP_KEEP`.

---

## PART D — Phase 6 (PR #7) merge

Rebase `phase-6-ops-hardening` onto current `main`, resolve any conflict, run the full suite, then merge. Report the final SHA and the test count.

---

## PART E — Dashboard UI refresh (ALREADY DONE — no action)

The palette refresh (`src/render.js` CSS block, `src/routes/dash.js` three SVG bar colours) is committed on `main` by Wizard. **Do not modify these files** — they are listed only so you know the diff is intentional.

---

## PART F — click_opens verification

`click_opens` has **0 rows** in production even though clicks exist. Verify the path end-to-end:

- `GET /c/:click_id` inserts exactly one `click_opens` row per open.
- `is_bot` set from user-agent (crawler patterns), `is_bot = 1` rows excluded from dashboards.
- Repeat open from the same click within **60 s** does not insert a second row.
- `fbclid`, `ttclid`, `gclid`, `sub1..sub3`, `utm_*` carried from the URL into `clicks` on mint, and `click_opens` references the same `click_id`.

**Tests:** synthetic `GET /c/<id>` → row exists; second immediate hit → still one; bot UA → `is_bot = 1`; params persisted.

---

## PART G — Readiness endpoint

`GET /api/health/ready` (no auth, same style as `/api/aff/health`):

```json
{ "ok": true, "db": "ok", "migrations": "005_click_opens",
  "join_key_set": true, "snapshot_age_s": 42, "snapshot_stale": false,
  "backup_enabled": true, "backup_age_s": 3600,
  "last_event_age_s": 12, "click_tracking": "ok" }
```
`ok` is false when: db fails, migrations missing, or snapshot stale beyond 3× the threshold. This is the endpoint I will hit before launching ads.

**Tests:** healthy fixture → `ok: true`; stale snapshot → `ok: false`.

---

## Acceptance checklist

- [ ] `npm test` green, report the count
- [ ] A1: legacy header accepted (prove with a curl in the PR body)
- [ ] A2: batch backfill idempotent (prove with two identical posts)
- [ ] B: `snapshot_age_s` visible in `/api/aff/health`
- [ ] C: backup file written under `/srv/coinvoo/backups`
- [ ] D: PR #7 merged, SHA reported
- [ ] E: UI commit present
- [ ] F: `click_opens` row inserted by a synthetic click
- [ ] G: `/api/health/ready` returns `ok: true`

Report per part: what changed, file list, test names added, and anything you deliberately did not do.
