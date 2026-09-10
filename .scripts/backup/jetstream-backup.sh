#!/usr/bin/env bash
# Snapshots JetStream: every stream and KV bucket, either through the broker or off the file store.
#
# Usage: NATS_URL=nats://... .scripts/backup/jetstream-backup.sh [SET_DIR]
#        NATS_STORE_DIR=/data .scripts/backup/jetstream-backup.sh [SET_DIR]
#
# ## Two methods, and why the CLI one is preferred
#
# `nats stream backup` asks the SERVER for a snapshot. The server takes it against a consistent
# view of the stream — message set, subject state, consumer state and configuration — and it works
# against a running broker with no coordination at all. That is the method to use.
#
# The store-dir copy is the fallback for a deployment with no `nats` CLI in reach. It carries a
# consistency caveat that must not be waved away: **a file-store copy taken while the broker is
# running is not a point-in-time snapshot.** JetStream writes message blocks, index state and
# consumer state as separate files, its default `sync_interval` is 2 minutes (see
# `config/nats.conf`), and `cp`/`tar` walks them one at a time. A copy can therefore contain a
# message block newer than the index that describes it, or a consumer's acknowledged sequence
# ahead of the stream's. The server repairs most of that on load, but "most" is not a property to
# put under a billing ledger. Take a store-dir copy either from a filesystem snapshot (LVM, ZFS,
# an EBS snapshot) or with the broker stopped — `nats-server --signal ldm=<pid>` puts the server
# into lame-duck mode and drains clients first, which is as close as a running node gets.
#
# ## What is NOT in either artifact
#
# Streams and buckets configured as MEMORY storage are not on disk and are not in a file-store
# copy; they are in a CLI snapshot only as an empty set. Today that is the `presence` KV bucket,
# which is transient BLF state that the engine re-applies on reconnect
# (`apps/engine/src/nats/jetstream.service.ts`). Losing it costs a few seconds of stale busy lamps,
# not data.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SET_DIR="${1:-$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$SET_DIR"

nats_args=(--server "$NATS_URL")
[ -n "${NATS_USER:-}" ] && nats_args+=(--user "$NATS_USER")
[ -n "${NATS_PASS:-}" ] && nats_args+=(--password "$NATS_PASS")
[ -n "${NATS_CREDS:-}" ] && nats_args+=(--creds "$NATS_CREDS")

if command -v nats >/dev/null 2>&1; then
	log "snapshotting JetStream through the broker at $NATS_URL"
	streams="$(nats "${nats_args[@]}" stream ls --names)"
	[ -n "$streams" ] || die "the broker reports no streams; refusing to write an empty snapshot set"
	work="$SET_DIR/jetstream"
	mkdir -p "$work"
	for stream in $streams; do
		log "  stream $stream"
		# --no-progress keeps a cron log readable; --chunk-size is left at the server default.
		nats "${nats_args[@]}" stream backup "$stream" "$work/$stream.tgz" --no-progress >/dev/null
	done
	archive="$SET_DIR/jetstream-streams.tar"
	tar -C "$SET_DIR" -cf "$archive" jetstream
	rm -rf "$work"
	manifest_add "$SET_DIR" jetstream broker-snapshot "$archive"
	printf '%s\n' $streams >"$SET_DIR/jetstream-streams.list"
	manifest_add "$SET_DIR" jetstream-list streams "$SET_DIR/jetstream-streams.list"
	log "JetStream snapshot written ($(printf '%s\n' $streams | wc -l | tr -d ' ') streams)"
	exit 0
fi

[ -n "$NATS_STORE_DIR" ] || die "neither the nats CLI nor NATS_STORE_DIR is available"
[ -d "$NATS_STORE_DIR" ] || die "NATS_STORE_DIR does not exist: $NATS_STORE_DIR"

warn "the nats CLI is not on PATH; falling back to a store-dir copy"
warn "a store-dir copy of a RUNNING broker is not point-in-time — see the header of this script"
archive="$SET_DIR/jetstream-store.tar.gz"
tar -C "$(dirname "$NATS_STORE_DIR")" -czf "$archive" "$(basename "$NATS_STORE_DIR")"
manifest_add "$SET_DIR" jetstream store-dir "$archive"
printf 'method=store-dir\nconsistency=crash-consistent-only\nsource=%s\n' "$NATS_STORE_DIR" \
	>"$SET_DIR/jetstream-store.caveat"
manifest_add "$SET_DIR" jetstream-caveat store-dir "$SET_DIR/jetstream-store.caveat"
log "JetStream store-dir copy written to $archive"
