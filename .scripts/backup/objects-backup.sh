#!/usr/bin/env bash
# Copies the object store — recordings, voicemail, prompts, hold music, CDR exports, branding.
#
# Usage: OBJECT_ROOT=/opt/optimiq-voice/recordings .scripts/backup/objects-backup.sh [SET_DIR]
#        OBJECT_ROOT=s3://bucket/prefix        .scripts/backup/objects-backup.sh [SET_DIR]
#
# ## Filesystem: a tar, not a tree
#
# One artifact per set keeps the manifest checksum meaningful and makes an off-site copy one file
# transfer. It is uncompressed by default: the store is almost entirely already-compressed audio
# (wav is the exception and is a minority of the bytes), so gzip spends CPU to save nothing. Set
# OBJECT_COMPRESS=1 for a store dominated by wav.
#
# ## S3: a sync into a backup prefix, and only a pointer here
#
# Bytes are never pulled through the backup host for an S3-backed store — a hosted PBX's recording
# bucket is measured in terabytes and the artifact set is not the place for it. `aws s3 sync`
# server-side copies into a dated prefix under OBJECT_BACKUP_URL, and the artifact set records
# where that landed. The restore reads the pointer and syncs back.
#
# Note this deployment MIRRORS rather than replaces: `createObjectStore` writes both the filesystem
# root and the bucket (see `apps/api/src/storage`). Whichever of the two the deployment treats as
# authoritative is what OBJECT_ROOT must name.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SET_DIR="${1:-$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$SET_DIR"

[ -n "$OBJECT_ROOT" ] || die "OBJECT_ROOT is required (a filesystem path or an s3:// URL)"

case "$OBJECT_ROOT" in
s3://*)
	require_cmd aws
	[ -n "${OBJECT_BACKUP_URL:-}" ] || die "OBJECT_BACKUP_URL is required for an s3:// OBJECT_ROOT"
	destination="${OBJECT_BACKUP_URL%/}/$(basename "$SET_DIR")"
	log "syncing $OBJECT_ROOT to $destination"
	aws s3 sync "$OBJECT_ROOT" "$destination" --only-show-errors
	pointer="$SET_DIR/objects-s3.pointer"
	printf 'source=%s\ndestination=%s\n' "$OBJECT_ROOT" "$destination" >"$pointer"
	manifest_add "$SET_DIR" objects s3-pointer "$pointer"
	log "object store synced; pointer written to $pointer"
	;;
*)
	[ -d "$OBJECT_ROOT" ] || die "OBJECT_ROOT does not exist: $OBJECT_ROOT"
	if [ "${OBJECT_COMPRESS:-0}" = "1" ]; then
		archive="$SET_DIR/objects.tar.gz"
		tar -C "$(dirname "$OBJECT_ROOT")" -czf "$archive" "$(basename "$OBJECT_ROOT")"
	else
		archive="$SET_DIR/objects.tar"
		tar -C "$(dirname "$OBJECT_ROOT")" -cf "$archive" "$(basename "$OBJECT_ROOT")"
	fi
	manifest_add "$SET_DIR" objects filesystem "$archive"
	log "object store archived to $archive"
	;;
esac
