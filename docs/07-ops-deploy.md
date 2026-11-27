# 07 — Operations and Deployment

---

## 1. Host

**Decision pending:** `10.0.0.11` (Contabo, 145 GB disk, headroom) or `10.0.0.12` (Contabo, 4 cores, 7.9 GB RAM). The current host (`10.0.0.14`) is at 96 % disk — it can run the service, but nothing heavy may be added until that is resolved.

Whatever the host: the service listens on `127.0.0.1:8770` only and is exposed through Caddy.

## 2. Environment (`reference/env.example`)

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (default 8770) | Listen port |
| `DB_PATH` | yes | `/srv/coinvoo/coinvoo.db` |
| `PUBLIC_BASE` | yes | `https://example.com` — used to mint short links |
| `IP_SALT` | no (generated) | Salt for `ip_hash`; generated at first boot and stored in `settings` |
| `ADMIN_USER` / `ADMIN_PASS` | yes | Dashboard basic auth |
| `JOIN_KEY` | no | Shared secret for `POST /api/join`; when unset, loopback only |
| `BOTDB_SNAPSHOT` | no (`/srv/coinvoo/botdb-snapshot.db`) | The bot-DB snapshot the matcher reads (§5). The service never reads `BOT_DB` |
| `SNAPSHOT_STALE_MINUTES` | no (30) | Snapshot older than this = stale: health `stale:true`, alert, Overview strip (§5) |
| `JOINVOO_PB` | Phase 2 | Joinvoo postback URL, e.g. `https://joinvoo.com/pb/<token>` |
| `PARALLEL_FORWARD` | Phase 2 | `1` = forward to Joinvoo, `0` = stop |
| `PARK_HOURS` | no (48) | Parked pool lifetime |
| `TZ` | yes | `Africa/Lagos` |
| `REPORT_CHAT_ID` | Phase 5 | Telegram chat for the daily report |
| `REPORT_BOT_TOKEN` | Phase 5 | Bot token used only for the report |
| `ALERT_CHAT_ID` | Phase 5 | Where alerts go |
| `POSTBACK_SILENCE_HOURS` | no (6) | Silence alert threshold (§8) |
| `PARKED_ALERT_PCT` | no (50) | Unmatched-ratio alert threshold (§8) |
| `PARKED_ALERT_MIN_EVENTS` | no (10) | Decided events in 24 h before the ratio can alert (§8) |
| `BACKUP_DIR` | no (`/var/backups/coinvoo`) | Nightly backup directory (§6); `off` disables it |
| `BACKUP_KEEP` | no (14) | Nightly backups kept (§6) |

`BOT_DB` (`/srv/trading-bot/trading-bot.db`, read-only) is read only by `ops/sync-botdb.sh` on the bot host (§5).

No secret is ever written to the repository. `reference/env.example` carries names and placeholders.

## 3. PM2

```js
// ecosystem.config.cjs — committed for reference
module.exports = {
  apps: [{
    name: 'coinvoo',
    script: 'src/server.js',
    cwd: '/srv/coinvoo',
    interpreter: 'node',
    max_memory_restart: '300M',
    autorestart: true,
    watch: false,
    env: { NODE_ENV: 'production' }
  }]
};
```

Start:

```bash
cd /srv/coinvoo
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs coinvoo --lines 50
```

Boot log must print, one line each:

```
[coinvoo] boot version=1.0.0 db=/srv/coinvoo/coinvoo.db
[coinvoo] migrations applied=5 latest=005_click_opens new=0
[coinvoo] listening port=8770
[coinvoo] worker started interval=60s
[coinvoo] report enabled hour=8            (or: report disabled missing=...)
[coinvoo] alerts enabled                   (or: alerts disabled missing=...)
[coinvoo] backup enabled dir=/var/backups/coinvoo keep=14
```

If the backup line is `[coinvoo] ERROR backup: ...` instead, fix the directory (§6) — the `backup` alert is already firing.

## 4. Caddy

Insert **above** the generic `/api/*` handler:

```
handle /c/* {
    reverse_proxy localhost:8770
}
handle /dash* {
    reverse_proxy localhost:8770
}
handle /api/join {
    reverse_proxy localhost:8770
}
handle /api/aff* {
    reverse_proxy localhost:8770
}
handle /go/* {
    reverse_proxy localhost:8770
}
```

Phase 9 added `GET /go/<brand>` (the landing-page CTA). On `trk.example.com` the live routes are `/c/*`,
`/api/*` and `/dash*`: **`/go/*` is not among them** until a `handle /go/*` block is added there. Check it before the
CTAs move: `curl -sI https://trk.example.com/go/brand-one` must answer `302` with `location: https://t.me/...`,
not a 404 from another handler.

### 4a. Postback key (Phase 10)

Close the open postback URL in four steps, without losing a postback:

1. Pick a key (`openssl rand -hex 24`). Put `AFF_KEY=<key>` and `AFF_KEY_ENFORCE=0` in `/srv/coinvoo/.env` and
   restart. Nothing is refused yet; every postback is still accepted.
2. Add `&key=<key>` to the postback URL in the Affstore panel (and to the mirror that forwards copies, if one is
   still running).
3. Watch `curl -s localhost:8770/api/aff/health | jq .postback_key`: real postbacks must move `ok` up while
   `missing` and `bad` stay where they were.
4. Remove `AFF_KEY_ENFORCE=0` (enforced is the default) and restart. From now on a postback without the key gets
   `401` and is not stored; each refusing address is logged once a minute as `[coinvoo] postback refused
   reason=key_missing ip=<hash>`.

The key is stripped from every stored payload, so it never shows on the dashboard's raw view.

Phase 2 cutover only: the `/api/aff*` block is changed from `localhost:8769` to `localhost:8770`. `aff-recon` keeps running for one week as the fallback; reverting is a one-line change.

Take a Caddyfile backup before editing (`Caddyfile.bak-coinvoo-<date>`) and verify with `caddy validate --config /etc/caddy/Caddyfile` before reload.

## 5. Bot-DB snapshot sync

The matcher's broker-id rule (`trader_id` → Telegram id) reads `botdb-snapshot.db`: a copy of the trading bot's
`user_accounts` table plus `meta.synced_at` (ISO-8601 UTC). The bot database lives on the bot host and is never
opened by the service. `ops/sync-botdb.sh` builds the copy there every 5 minutes and pushes it to `BOTDB_SNAPSHOT`
on the Coinvoo host. If it stops, every postback from a user who connected their broker account after the last
sync parks for no reason — so a stale snapshot is surfaced (below), never silent.

What the script does, every run:

- opens `BOT_DB` read-only and copies **only** `telegram_id, iq_user_id, username, currency, approval_status,
  created_at` of `user_accounts` (nothing else leaves the bot host) into a fresh file with `meta.synced_at = now`;
- refuses to publish an empty table, checks the row count and `integrity_check`;
- puts the file in place with an atomic rename (`scp` to `<BOTDB_SNAPSHOT>.tmp`, then `mv` on the Coinvoo host);
  the service reopens the snapshot when its inode changes, so no restart is needed;
- prints one line, `[coinvoo] synced rows=N size=N bytes`; every failure prints one `[coinvoo] ERROR sync-botdb: ...`
  line on stderr and exits non-zero; if a previous run still holds the lock it exits 0 without output.

Settings (environment): `BOT_DB` (default `/srv/trading-bot/trading-bot.db`), `BOTDB_SNAPSHOT` (default
`/srv/coinvoo/botdb-snapshot.db`), `BOTDB_REMOTE` (`user@coinvoo-host`; unset = write locally, for a single-host
install), `SYNC_LOCK` (default `/tmp/coinvoo-sync.lock`), `NODE` (node ≥ 22.5; it builds the file with `node:sqlite`).

### Install (on the bot host)

```bash
# 0. retire the pre-rename job (it pushes to /root/tribute/... and fails)
crontab -l | grep -n tribute-sync          # delete that line with `crontab -e`
# 1. the script
install -d -m 755 /opt/coinvoo-sync
install -m 755 ops/sync-botdb.sh /opt/coinvoo-sync/sync-botdb.sh
# 2. its settings (no secrets: the copy uses the host's existing ssh key for the Coinvoo host)
cat > /etc/default/coinvoo-sync <<'ENV'
BOT_DB=/srv/trading-bot/trading-bot.db
BOTDB_SNAPSHOT=/srv/coinvoo/botdb-snapshot.db
BOTDB_REMOTE=root@<coinvoo-host>
NODE=/usr/bin/node
ENV
# 3. one manual run: must print `[coinvoo] synced rows=... size=... bytes` and exit 0
set -a; . /etc/default/coinvoo-sync; set +a; /opt/coinvoo-sync/sync-botdb.sh; brand-two "exit=$?"
```

### Schedule it — preferred: systemd timer

```bash
install -m 644 ops/coinvoo-sync.service ops/coinvoo-sync.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now coinvoo-sync.timer
systemctl list-timers coinvoo-sync.timer          # NEXT within 5 minutes
journalctl -u coinvoo-sync.service -n 5 --no-pager # one `synced rows=...` line per run
```

A failed run shows as `failed` in `systemctl status coinvoo-sync.service` and its ERROR line is in the journal.

### Fallback: cron

Only where systemd is not available. Cron's `PATH` is minimal, so name `node` explicitly:

```
*/5 * * * * set -a; . /etc/default/coinvoo-sync; set +a; /opt/coinvoo-sync/sync-botdb.sh >>/var/log/coinvoo-sync.log 2>&1
```

Never run both; the lock makes an overlap harmless, but one scheduler is the rule.

### Confirm freshness (on the Coinvoo host)

```bash
curl -s localhost:8770/api/aff/health | jq .snapshot
# {"rows":3412,"synced_at":1795341600000,"age_s":94,"stale":false}
```

`age_s` stays under 300 when the timer runs. `stale` turns `true` above `SNAPSHOT_STALE_MINUTES` (default 30), or
when the file is missing or unreadable (`rows: null`; the age keeps counting from the last sync the service saw).
While stale: the `bot snapshot` alert fires once (§8), the Overview shows a red strip naming the age, and the log
prints `snapshot stale age=Ns` every tick. When a sync lands again the alert sends one `cleared` notice and the strip
disappears. Direct check: `sqlite3 -readonly /srv/coinvoo/botdb-snapshot.db "SELECT value FROM meta WHERE key='synced_at'"`.

## 6. Backups

On by default. The worker runs it on its existing schedule — the first tick after 03:00 WAT, once a day, with the
rest of the daily maintenance — into `BACKUP_DIR` (default `/var/backups/coinvoo`), keeping the newest
`BACKUP_KEEP` (default 14) files named `coinvoo-YYYY-MM-DD.db`. Other files in the directory are never touched.

- **It is a `.backup`, never a file copy.** It uses SQLite's online backup API — the same mechanism as the sqlite3
  shell's `.backup` — so the copy is consistent while the service keeps writing (WAL). Copying `coinvoo.db` with
  `cp` is not a backup: it misses whatever is still in `coinvoo.db-wal` and can tear mid-write.
- Each dump is written as `*.part`, switched to a single self-contained file (no `-wal`), checked with
  `quick_check`, then renamed into place. One log line per run: `[coinvoo] backup file=coinvoo-2026-11-16.db
  bytes=167936 kept=14 removed=1`.
- A missing directory is created. If it cannot be created or written — at boot or at the nightly run — the service
  logs `[coinvoo] ERROR backup: ...` **and** the `backup` alert fires (§8). The alert clears when a backup succeeds
  or a restart finds the directory writable.
- `BACKUP_DIR=off` switches it off (boot line `backup disabled BACKUP_DIR=off`). Only the test suite and the proof
  scripts do that.

### Restore

```bash
# 1. check the dump you want before touching anything
sqlite3 -readonly /var/backups/coinvoo/coinvoo-2026-11-16.db \
  "PRAGMA integrity_check; SELECT COUNT(*) FROM members; SELECT COUNT(*) FROM events; SELECT COUNT(*) FROM clicks;"
# 2. stop the service, keep the current database (all three files) aside
systemctl stop coinvoo            # or: pm2 stop coinvoo
mkdir -p /srv/coinvoo/pre-restore && mv /srv/coinvoo/coinvoo.db* /srv/coinvoo/pre-restore/
# 3. restore into a new file with the sqlite3 shell's .restore, then move it into place
sqlite3 /srv/coinvoo/new.db ".restore '/var/backups/coinvoo/coinvoo-2026-11-16.db'"
sqlite3 /srv/coinvoo/new.db "PRAGMA integrity_check; SELECT COUNT(*) FROM members;"
mv /srv/coinvoo/new.db /srv/coinvoo/coinvoo.db
# 4. start and check
systemctl start coinvoo && curl -s localhost:8770/api/aff/health
```

Move `coinvoo.db-wal` and `coinvoo.db-shm` away with the old database (step 2): a WAL left next to a restored file
is replayed into it. Everything recorded after the dump's time is lost; postbacks that arrived since are not
re-sent by the network, so compare `/api/aff/stats` with the network's report after a restore.

Restore drill (no service impact): run step 1, then step 3 into `/tmp/new.db` instead.

**Keep a copy off this host.** `BACKUP_DIR` is on the same disk as the database, so a lost disk or host takes the
backups with it — and this host has no replica (single host, single process). Copy the newest dump elsewhere once a
day, after 03:30 WAT, for example with a root cron line on another machine:
`rsync -a --delete coinvoo-host:/var/backups/coinvoo/ /srv/backups/coinvoo/`. Pull, don't push: the Coinvoo host
then holds no credentials for the backup machine.

### Raw IP retention (Phase 10)

`clicks.ip_raw` exists only for Meta matching. The daily maintenance blanks it once the click's last open is older
than `IP_RAW_RETENTION_DAYS` (default 90; `0` keeps it forever). `ip_hash` is never touched, so no screen changes.
The maintenance line reports the count: `... ip_raw_blanked=12 ...`.

## 7. Logs and rotation

- stdout/stderr via PM2: `pm2 logs coinvoo`.
- Application log file optional: `/srv/coinvoo/coinvoo.log`. If written, rotate at 20 MB, keep 5.
- One line per event: `[coinvoo] event=<id> kind=ftd trader=197318401 path=trader_id conf=90 member=1234`.
- Never log a full raw payload at info level; the database is the record.

## 8. Monitoring and alerts

Alerts go to `ALERT_CHAT_ID` (Phase 5 delivery path, plain text). Each fires **once** when its condition becomes
true, stays silent while it stays true, and sends one `COINVOO — <label> cleared` notice when it clears. Every alert
names the metric that tripped it and the threshold, so calibrating does not need the code.

| Alert | Fires when | Threshold (env) | Example text |
|---|---|---|---|
| database check | `SELECT 1` fails | any error | `COINVOO — database check failing (SELECT 1 errored; threshold: any error)` |
| postback silence | no postback for longer than the threshold while people opened ad links in the last 24 h | `POSTBACK_SILENCE_HOURS` = 6 | `COINVOO — no postbacks for 7 h (last: 04:00; threshold 6 h)` |
| unmatched ratio | `parked / (matched + parked + expired)` over 24 h above the threshold, with at least `PARKED_ALERT_MIN_EVENTS` decided | `PARKED_ALERT_PCT` = 50 | `COINVOO — 60% of events unmatched in the last 24 h (6 of 10; threshold 50%)` |
| forward failures | any forward `failed` for over 15 min | fixed | `COINVOO — 3 postbacks failing to forward to Joinvoo (threshold: any failed for over 15 min)` |
| disk usage | free space under 10 % (as `df` prints it) | fixed | `COINVOO — disk 96% full, 4.0% free (threshold: under 10% free)` |
| memory | RSS above 250 MB for 10 min | fixed | `COINVOO — memory 268 MB for 10 min (threshold 250 MB)` |
| bot snapshot | snapshot older than the threshold, unreadable, or never synced (§5) | `SNAPSHOT_STALE_MINUTES` = 30 | `COINVOO — bot snapshot 45 min old (threshold 30 min)` |
| backup | the nightly backup or the boot check cannot write (§6) | any failure | `COINVOO — backup failing: EACCES: permission denied, mkdir '/var/backups/coinvoo' (threshold: any failure)` |

Change a threshold by editing the service `.env` and restarting; no code changes. Check what your `.env` carries:
a value copied from an older `env.example` (`PARKED_ALERT_PCT=40`) overrides the new default.

**Calibrating from data.** Parked runs at about 29 % on live data, so 50 leaves room for a busy day without
hiding a starving matcher. Revisit monthly from the service's own numbers:

```sql
-- daily unmatched share, last 30 days (Lagos days). Older events have since expired, so read parked+expired.
SELECT date(received_at / 1000 + 3600, 'unixepoch') AS day,
       SUM(state IN ('matched', 'parked', 'expired')) AS decided,
       ROUND(100.0 * SUM(state IN ('parked', 'expired')) / MAX(1, SUM(state IN ('matched', 'parked', 'expired'))), 1) AS unmatched_pct
  FROM events WHERE received_at >= (strftime('%s', 'now') - 30 * 86400) * 1000
 GROUP BY day ORDER BY day;
-- longest gap between postbacks per day, in hours
SELECT date(received_at / 1000 + 3600, 'unixepoch') AS day, ROUND(MAX(gap) / 3600000.0, 1) AS max_gap_h
  FROM (SELECT received_at, received_at - LAG(received_at) OVER (ORDER BY received_at) AS gap FROM events
         WHERE received_at >= (strftime('%s', 'now') - 30 * 86400) * 1000)
 GROUP BY day ORDER BY day;
```

Set `PARKED_ALERT_PCT` about 10 points above the worst normal day, and `POSTBACK_SILENCE_HOURS` about 1.5× the
longest normal gap during ad hours. `GET /api/aff/health` returning non-200 is for the external uptime check.

## 9. Cutover plan (Phase 2 → production)

1. Deploy coinvoo on 8770 with `/api/aff*` **still** pointing at `aff-recon` (8769). Nothing user-facing changes.
2. Point the network's postback URL at a **second** copy (`/api/aff2*`) that hits coinvoo. Both receivers now see every event.
3. For 48 h compare: event counts, matched counts, matched Telegram ids, revenue sums. They must agree row-for-row on `event_id`.
4. Repoint `/api/aff*` to 8770 in Caddy. Leave `aff-recon` running, idle.
5. After one week of agreement, stop `aff-recon` and cancel Joinvoo.

Rollback at any step: point the route back to 8769. Coinvoo's database keeps whatever it stored; nothing is lost.

## 10. Deploy discipline

- Deploy only when the trading bot has no in-flight trades and the yacht engine is idle (same window rules as the main bot) — Coinvoo itself is safe to restart, but the Caddy reload is shared infrastructure.
- `node --check` every changed file before restart.
- After restart: `curl -s localhost:8770/api/aff/health` must return `ok:true`, then one synthetic postback with `trader_id=1` must land as `ignored / stub_guard`.
- Keep the previous release directory (`/srv/coinvoo.prev`) until the new one has served traffic for 24 h.

## 11. Disk discipline

The service is small, but:
- never `npm install` (no dependencies exist to install);
- do not commit databases, logs, or `node_modules`;
- the nightly backup keeps 14 files, not 90.
- backups live in `/var/backups/coinvoo`, not under `/srv/coinvoo`, and only 14 are kept.

## 12. Standing up a campaign

**Before money goes on it**, prove the click path on the host: `set -a; . /srv/coinvoo/.env; set +a;
ops/click-smoke.sh` twice. It mints a throw-away link through the admin route, opens it with a phone browser's
user-agent, posts the join the gate bot would post, checks there is exactly one click, one human open and one member
carrying that `click_id`, then deletes all three rows; it exits non-zero on any mismatch (and still cleans up).
Then mint the real link on **Links** (or `POST /api/links`) with campaign / ad set / ad names that match the ad
platform's, and put the **`url`** — `https://<PUBLIC_BASE>/c/<token>` — in the ad. Never the `t.me/...?start=c_...`
link: it skips the open, so the click, the platform click id (`ttclid` / `fbclid` / `gclid`, appended by the platform)
and the timing are lost. **Within the first hour**, the Campaigns screen should show clicks a few minutes after the
platform reports link clicks and roughly in line with them (a little lower is normal: some taps die before the
redirect, and link-preview crawlers are recorded but not counted); joins should be a non-zero share of clicks (the
Telegram Start tap is a second step, so well under 100 %); registrations and FTDs usually lag by hours, so zero in
hour one is not a fault. **Broken tracking vs a slow campaign:** if the platform reports link clicks but Coinvoo
shows none (or only crawler opens — `opens_24h` in `/api/aff/stats` stays 0), the link in the ad is wrong or the
`/c/*` route is down: run `click-smoke.sh` and compare the ad's URL with the minted one. If clicks arrive but joins
stay at 0 while the gate bot is getting `/start` without a payload (`organic:bot` joins rise), the hand-off from link
to bot is broken. If the platform's own clicks are low and Coinvoo's clicks track them, the campaign is just slow —
fix the creative or the budget, not the tracking.
