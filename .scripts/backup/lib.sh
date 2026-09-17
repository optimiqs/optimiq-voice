# Shared state for the backup and restore scripts. Sourced, never executed.
#
# Every script here is driven entirely by environment variables so the same file runs from a cron
# entry, from a compose one-shot service and from an operator's shell. Nothing is read from the
# checkout and nothing mutable is written into it: an artifact set lands under BACKUP_ROOT.

set -euo pipefail

BACKUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$BACKUP_DIR/../.." && pwd)"

# Where artifact sets are written. One directory per run, named for its UTC start.
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/optimiq-voice}"

# The three physical databases. Four journals live in them: the auth and legacy-API journals share
# `optimiq_voice`, the PBX journal owns `optimiq_pbx`, the CDR journal owns `optimiq_cdr`.
# Override to match an installation that named its databases differently.
PG_DATABASES="${PG_DATABASES:-optimiq_voice optimiq_pbx optimiq_cdr}"

# A libpq URL for the OWNER (migration) principal, without a database component — the per-database
# name is appended. The runtime logins cannot dump: they hold no ownership and cannot read
# `pg_authid`, so a dump taken as one silently omits objects.
PG_OWNER_URL="${PG_OWNER_URL:-}"

# JetStream. Either point at the broker (preferred, `nats` CLI required) or at the file store.
NATS_URL="${NATS_URL:-nats://127.0.0.1:4222}"
NATS_STORE_DIR="${NATS_STORE_DIR:-}"

# The object store: a filesystem root, or an `s3://bucket/prefix` URL for the S3 driver.
OBJECT_ROOT="${OBJECT_ROOT:-}"

log() { printf '[backup] %s\n' "$*"; }
warn() { printf '[backup] WARNING: %s\n' "$*" >&2; }
die() {
	printf '[backup] ERROR: %s\n' "$*" >&2
	exit 1
}

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "$1 is not on PATH${2:+ ($2)}"
}

# `postgresql://user:pw@host:port` + `/dbname`, tolerating a trailing slash and a query string.
pg_url_for() {
	local base="$1" database="$2" query=""
	case "$base" in
	*\?*)
		query="?${base#*\?}"
		base="${base%%\?*}"
		;;
	esac
	printf '%s/%s%s' "${base%/}" "$database" "$query"
}

# Everything a manifest entry needs about one artifact, as one JSON object per line. The restore
# reads this back, so a set whose manifest is missing an artifact is a set that will not restore.
manifest_add() {
	local set_dir="$1" kind="$2" name="$3" path="$4"
	local size sha
	size="$(wc -c <"$path" | tr -d ' ')"
	sha="$(shasum -a 256 "$path" | awk '{print $1}')"
	printf '{"kind":"%s","name":"%s","file":"%s","bytes":%s,"sha256":"%s"}\n' \
		"$kind" "$name" "$(basename "$path")" "$size" "$sha" >>"$set_dir/manifest.jsonl"
}

# Verifies every artifact in a set still hashes to what was recorded. Cheap, and the only thing
# that distinguishes a backup from a directory of files nobody has ever read.
manifest_verify() {
	local set_dir="$1" failures=0
	[ -f "$set_dir/manifest.jsonl" ] || die "no manifest in $set_dir"
	while IFS= read -r line; do
		local file sha actual
		file="$(printf '%s' "$line" | sed -n 's/.*"file":"\([^"]*\)".*/\1/p')"
		sha="$(printf '%s' "$line" | sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p')"
		[ -n "$file" ] || continue
		if [ ! -f "$set_dir/$file" ]; then
			warn "missing artifact: $file"
			failures=$((failures + 1))
			continue
		fi
		actual="$(shasum -a 256 "$set_dir/$file" | awk '{print $1}')"
		if [ "$actual" != "$sha" ]; then
			warn "checksum mismatch: $file"
			failures=$((failures + 1))
		fi
	done <"$set_dir/manifest.jsonl"
	[ "$failures" -eq 0 ] || die "$failures artifact(s) failed verification in $set_dir"
	log "manifest verified: $set_dir"
}

# The newest artifact set under BACKUP_ROOT, or the one named in $1.
resolve_set() {
	local requested="${1:-}"
	if [ -n "$requested" ]; then
		[ -d "$requested" ] || die "no such backup set: $requested"
		printf '%s' "$requested"
		return
	fi
	local newest
	newest="$(find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d -name '2*' | sort | tail -n 1)"
	[ -n "$newest" ] || die "no backup set found under $BACKUP_ROOT"
	printf '%s' "$newest"
}
