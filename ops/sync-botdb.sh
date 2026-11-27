#!/usr/bin/env bash
# ops/sync-botdb.sh — refresh the bot-DB snapshot that Coinvoo's matcher reads (docs/07 §5).
#
# Reads user_accounts from the trading bot's database (read-only), writes a small standalone SQLite file
# with the same table plus meta.synced_at (ISO-8601 UTC), and puts it in place with an atomic rename, so
# the service never sees a half-written file (it reopens the snapshot when the inode changes).
#
# Environment (all optional):
#   BOT_DB          source database             default /srv/trading-bot/trading-bot.db
#   BOTDB_SNAPSHOT  destination path            default /srv/coinvoo/botdb-snapshot.db
#   BOTDB_REMOTE    user@host: copy the snapshot to that host over scp/ssh instead of writing it locally
#   SYNC_LOCK       lock file                   default ${TMPDIR:-/tmp}/coinvoo-sync.lock
#   NODE            node binary (>= 22.5)       default node
#
# Output: exactly one line on stdout per successful run: `[coinvoo] synced rows=N size=N bytes`.
# Every failure prints one `[coinvoo] ERROR sync-botdb: ...` line on stderr and exits non-zero.
# If another run holds the lock, this one exits 0 without output.
set -euo pipefail

BOT_DB="${BOT_DB:-/srv/trading-bot/trading-bot.db}"
BOTDB_SNAPSHOT="${BOTDB_SNAPSHOT:-/srv/coinvoo/botdb-snapshot.db}"
BOTDB_REMOTE="${BOTDB_REMOTE:-}"
SYNC_LOCK="${SYNC_LOCK:-${TMPDIR:-/tmp}/coinvoo-sync.lock}"
NODE="${NODE:-node}"

fail() { echo "[coinvoo] ERROR sync-botdb: $*" >&2; exit 1; }

command -v flock >/dev/null 2>&1 || fail "flock not found (util-linux)"
( : >>"$SYNC_LOCK" ) 2>/dev/null || fail "cannot open lock file $SYNC_LOCK"
exec 9>>"$SYNC_LOCK"
flock -n 9 || exit 0

command -v "$NODE" >/dev/null 2>&1 || fail "node not found ($NODE)"
[ -f "$BOT_DB" ] || fail "source database not found: $BOT_DB"
[ -r "$BOT_DB" ] || fail "source database not readable: $BOT_DB"

work="$(mktemp -d "${TMPDIR:-/tmp}/coinvoo-sync.XXXXXX")" || fail "cannot create a temporary directory"
trap 'rm -rf "$work"' EXIT

# Build the snapshot. Prints the row count; any error is one line on stderr and a non-zero exit.
BUILD_JS='
import { DatabaseSync } from "node:sqlite";
try {
  const src = new DatabaseSync(process.env.SRC, { readOnly: true });
  let rows;
  try {
    rows = src.prepare("SELECT telegram_id, iq_user_id, username, currency, approval_status, created_at FROM user_accounts").all();
  } finally { src.close(); }
  if (rows.length === 0) throw new Error("source user_accounts has 0 rows; refusing to publish an empty snapshot");
  const dst = new DatabaseSync(process.env.DST);
  dst.exec(`PRAGMA journal_mode = DELETE;
    CREATE TABLE user_accounts (telegram_id INTEGER, iq_user_id TEXT, username TEXT, currency TEXT, approval_status TEXT, created_at TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
  dst.exec("BEGIN");
  const ins = dst.prepare("INSERT INTO user_accounts VALUES (?, ?, ?, ?, ?, ?)");
  for (const r of rows) ins.run(r.telegram_id, r.iq_user_id === null ? null : String(r.iq_user_id), r.username, r.currency, r.approval_status, r.created_at);
  dst.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("synced_at", new Date().toISOString());
  dst.exec("COMMIT");
  dst.exec("CREATE INDEX idx_ua_iq ON user_accounts(iq_user_id); CREATE INDEX idx_ua_tg ON user_accounts(telegram_id);");
  const n = dst.prepare("SELECT COUNT(*) AS n FROM user_accounts").get().n;
  const check = dst.prepare("PRAGMA integrity_check").get().integrity_check;
  dst.close();
  if (n !== rows.length) throw new Error(`wrote ${n} rows, expected ${rows.length}`);
  if (check !== "ok") throw new Error(`integrity_check: ${check}`);
  process.stdout.write(String(n));
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e).replace(/\s+/g, " "));
  process.exit(1);
}
'
rows="$(SRC="$BOT_DB" DST="$work/snapshot.db" "$NODE" --no-warnings --input-type=module -e "$BUILD_JS" 2>"$work/err")" \
  || fail "build from $BOT_DB failed: $(head -c 500 "$work/err")"
size="$(stat -c %s "$work/snapshot.db")" || fail "cannot stat the built snapshot"

if [ -n "$BOTDB_REMOTE" ]; then
  remote_tmp="$BOTDB_SNAPSHOT.tmp"
  scp -q -o BatchMode=yes -o ConnectTimeout=20 "$work/snapshot.db" "$BOTDB_REMOTE:$remote_tmp" 2>"$work/err" \
    || fail "scp to $BOTDB_REMOTE:$remote_tmp failed: $(head -c 300 "$work/err")"
  ssh -o BatchMode=yes -o ConnectTimeout=20 "$BOTDB_REMOTE" "mv -f -- $(printf '%q' "$remote_tmp") $(printf '%q' "$BOTDB_SNAPSHOT")" 2>"$work/err" \
    || fail "rename on $BOTDB_REMOTE failed: $(head -c 300 "$work/err")"
else
  dest_dir="$(dirname -- "$BOTDB_SNAPSHOT")"
  [ -d "$dest_dir" ] || fail "destination directory not found: $dest_dir"
  # Copy next to the destination first: rename(2) is atomic only within one filesystem.
  cp -- "$work/snapshot.db" "$BOTDB_SNAPSHOT.tmp" 2>"$work/err" || fail "cannot write $BOTDB_SNAPSHOT.tmp: $(head -c 300 "$work/err")"
  mv -f -- "$BOTDB_SNAPSHOT.tmp" "$BOTDB_SNAPSHOT" 2>"$work/err" || fail "cannot rename into $BOTDB_SNAPSHOT: $(head -c 300 "$work/err")"
fi

echo "[coinvoo] synced rows=$rows size=$size bytes"
