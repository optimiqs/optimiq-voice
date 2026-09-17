#!/usr/bin/env bash
# Takes one complete artifact set: Postgres, JetStream and the object store.
#
# Usage:
#   PG_OWNER_URL=postgresql://postgres:...@db:5432 \
#   NATS_URL=nats://nats:4222 \
#   OBJECT_ROOT=/opt/optimiq-voice/recordings \
#   BACKUP_ROOT=/var/backups/optimiq-voice \
#   .scripts/backup/backup.sh
#
# ## Order, and what it costs to get it wrong
#
# Postgres first, JetStream second, objects last. That is the order of how fast each moves and how
# expensive a stale copy is: the ledger's rows are the authoritative record, the streams are the
# in-flight work that produced them, and an object is immutable once written. So a set is
# internally skewed only in the safe direction — the streams may hold a leg the SQL dump has not
# got yet, which a restore replays; a recording object may exist with no row, which is inert.
#
# The reverse order would be a set containing rows that point at objects the copy predates: a
# recordings row whose audio is not in the artifact, which the API answers 500 for.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SET_DIR="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$SET_DIR"
started="$(date -u +%s)"
log "artifact set: $SET_DIR"

"$BACKUP_DIR/pg-backup.sh" "$SET_DIR"
"$BACKUP_DIR/jetstream-backup.sh" "$SET_DIR"
if [ -n "$OBJECT_ROOT" ]; then
	"$BACKUP_DIR/objects-backup.sh" "$SET_DIR"
else
	warn "OBJECT_ROOT is unset; the object store is NOT in this set"
fi

finished="$(date -u +%s)"
cat >"$SET_DIR/SET.json" <<EOF
{
  "startedAt": "$(date -u -r "$started" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)",
  "durationSeconds": $((finished - started)),
  "databases": "$PG_DATABASES",
  "natsUrl": "$NATS_URL",
  "objectRoot": "${OBJECT_ROOT:-}",
  "host": "$(hostname)"
}
EOF

manifest_verify "$SET_DIR"
log "backup complete in $((finished - started))s: $SET_DIR"
du -sh "$SET_DIR" 2>/dev/null || true
