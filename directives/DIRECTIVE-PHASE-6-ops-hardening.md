# DIRECTIVE — PHASE 6: Ops hardening

Status: ready to implement.
Base: `main` at `9944a64`. Suite on main: 167/167.

Scope discipline: work ONLY in the files named here. Do not touch the matcher, the postback
path, the click bridge, the dashboard routes, or Caddy. No dependency may be added.

## Part 1 — The bot-DB sync is broken and it is the biggest matching defect

`/root/tribute-sync/sync-botdb.sh` on the application host still pushes to the pre-rename path:

```
scp: dest open "/root/tribute/botdb-snapshot.db.tmp": No such file or directory
```

The snapshot the matcher reads (`/srv/coinvoo/botdb-snapshot.db`) has not been refreshed since
the rename. Every postback for a user who connected their account after that moment is parked
for no reason.

Required:

1. Move the sync into this repository as `ops/sync-botdb.sh`, with the destination path taken
   from `BOTDB_SNAPSHOT` (default `/srv/coinvoo/botdb-snapshot.db`). No hard-coded `tribute`.
2. The script must fail loudly: non-zero exit on every failure path, one line per run to stdout
   (`synced rows=N size=N bytes`), lock file so overlapping runs exit 0 silently.
3. Ship a systemd unit pair in `ops/` (`coinvoo-sync.service`, `coinvoo-sync.timer`, every 5 min)
   as the preferred scheduling method; keep the cron line documented as the fallback.
4. `docs/07-ops-deploy.md`: replace the existing snapshot section with the install steps, the
   two scheduling options, and how to confirm freshness.

Acceptance: running `ops/sync-botdb.sh` on the host writes the snapshot with a `meta.synced_at`
within the last minute, and `GET /api/aff/health` reports the snapshot age.

## Part 2 — Surface snapshot staleness instead of failing silently

The snapshot reader already warns after 30 minutes of staleness, but nothing outside the log sees
it. A stale map looks identical to a working one on the dashboard.

Required:

1. `/api/aff/health` gains `snapshot: { rows, synced_at, age_s, stale }`, where `stale` is true
   above `SNAPSHOT_STALE_MINUTES` (default 30).
2. A new alert condition, same delivery path as the others: snapshot stale beyond that threshold.
   Fire once per state change, not per check.
3. The Overview shows a small warning strip when `stale` is true, naming the snapshot age. Do not
   add it to any other screen.

Acceptance: rename the snapshot file under a running service → health reports `stale: true` and
one alert is delivered; restore it → the strip clears and no second alert fires.

## Part 3 — Nightly backup is documented but disabled

Boot line on the host today: `backup disabled missing=BACKUP_DIR`. Escrow-grade data, no dump.

Required:

1. `BACKUP_DIR` defaults to `/var/backups/coinvoo` when unset; `BACKUP_KEEP` defaults to 14.
2. The backup runs on the existing worker schedule and logs one line per run with the file name
   and size.
3. If the directory is missing, create it. If it is not writable, log the error and raise the
   existing alert path — silence is not acceptable.
4. `docs/07-ops-deploy.md`: add the restore procedure (`sqlite3 new.db ".restore"`), and state that
   the backup is a `.backup` (online, consistent), never a file copy.

Acceptance: one dump appears in the directory after the scheduled run, opens cleanly, and contains
the expected row counts for `members`, `events`, `clicks`.

## Part 4 — Alert thresholds are guesses

Parked sits at 29 % of events on live data and the configured threshold is 40 %, so the first busy
day trips it. Make the thresholds data-driven rather than fixed guesses.

Required:

1. `PARKED_ALERT_PCT` default 50, `POSTBACK_SILENCE_HOURS` default 6 — keep both env-overridable
   and document them in `docs/07-ops-deploy.md`.
2. Each alert carries the metric that triggered it and the threshold in its text, so calibration
   does not require reading the code.

Acceptance: threshold change via env only, no code edit, proven by test.

## Part 5 — The click bridge has never carried real traffic

`click_opens` is empty and there is one legacy click row. Nothing proves the click → join path
works with live ad traffic.

Required:

1. `ops/click-smoke.sh`: mints a link through the admin route, requests it with a normal browser
   user-agent, posts a matching join, and asserts one click, one open, one member with the right
   `click_id`. Exits non-zero on any mismatch. Must use a token that is discarded afterwards.
2. `docs/07-ops-deploy.md`: one paragraph on standing up a campaign — which link goes in the ad,
   what the numbers should look like within the first hour, and how to tell a broken pixel from a
   slow campaign.

Acceptance: smoke script passes twice in a row against the running service.

## Definition of done

- `node --test` ≥ 167 tests, all pass, including the disk-simulated run.
- No dependency change.
- Existing routes unchanged except the health field and the Overview strip.
- `docs/07-ops-deploy.md` covers Parts 1–5.
- Every acceptance item above demonstrated in the PR description, with command output.
