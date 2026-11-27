#!/usr/bin/env bash
# scripts/sync-botdb.sh — Phase 7 Part B1 entry point for the bot-DB snapshot sync.
# The implementation is ops/sync-botdb.sh (Phase 6, docs/07 §5); this keeps one copy of the logic.
#   - target BOTDB_SNAPSHOT, default /srv/coinvoo/botdb-snapshot.db (the pre-rename path is gone)
#   - atomic: written to <target>.tmp, then mv into place
#   - unreadable or missing source DB: one `[coinvoo] ERROR sync-botdb: ...` line on stderr, exit 1
exec "$(dirname -- "$(readlink -f -- "$0")")/../ops/sync-botdb.sh" "$@"
