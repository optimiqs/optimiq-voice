#!/usr/bin/env bash
# Rebuilds a stack from one artifact set, re-provisions the runtime roles, and verifies the result.
#
# Usage:
#   RESTORE_OWNER_URL=postgresql://postgres:...@db:5432 \
#   RESTORE_DB_SUFFIX=_restore \
#   RESTORE_CONFIRM=restore \
#   .scripts/backup/restore.sh [SET_DIR]
#
# With no SET_DIR the newest set under BACKUP_ROOT is used.
#
# ## The refusal that matters
#
# A restore is the one operation in this repository that can destroy a production database by
# succeeding. So the target names are DERIVED (RESTORE_DB_PREFIX / RESTORE_DB_SUFFIX) and the
# script refuses to run when the derivation leaves a name unchanged, unless RESTORE_IN_PLACE=yes is
# set as well. A drill therefore cannot become an outage through a forgotten variable, and a real
# disaster recovery is two explicit variables rather than one.
#
# ## What it does, in order
#
# 1. Verifies the artifact set against its manifest. A corrupt set fails here, before anything is
#    created.
# 2. Applies the cluster's roles and grants (`roles.sql`, passwordless — see `pg-backup.sh`).
# 3. Creates each target database and `pg_restore`s into it.
# 4. Re-applies the runtime-role provisioning from `.scripts/local-stack/provision-roles.sql` with
#    the passwords in the TARGET environment (`API_DB_PASSWORD` / `PBX_DB_PASSWORD` /
#    `CDR_DB_PASSWORD`, the names `render-env.sh` writes; `RESTORE_`-prefixed copies override
#    them), because the dumped roles have none. A missing one is fatal.
# 5. ANALYZEs, then compares every table's row count against the count file taken at dump time.
# 6. Smoke-reads: one authenticated-shaped query per database through the runtime login, which is
#    what proves the grants and the RLS memberships survived rather than just the rows.
#
# JetStream and the object store are restored by the two blocks at the end, each of which is a
# no-op when the set does not carry that artifact.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_cmd pg_restore
require_cmd psql

RESTORE_OWNER_URL="${RESTORE_OWNER_URL:-$PG_OWNER_URL}"
[ -n "$RESTORE_OWNER_URL" ] || die "RESTORE_OWNER_URL is required (the TARGET cluster's owner URL)"
[ "${RESTORE_CONFIRM:-}" = "restore" ] || die "set RESTORE_CONFIRM=restore to proceed"

RESTORE_DB_PREFIX="${RESTORE_DB_PREFIX:-}"
RESTORE_DB_SUFFIX="${RESTORE_DB_SUFFIX:-}"

# A client newer than the server emits SET statements the server does not know — PostgreSQL 17's
# `transaction_timeout` against a 16 server is the one seen in practice. Every such statement is
# reported as a pg_restore error and none of them affect the data, which makes the error count
# useless as a signal unless the mismatch is known about. Match the major versions in a real
# recovery.
client_major="$(pg_restore --version | sed -n 's/.* \([0-9][0-9]*\).*/\1/p')"
server_major="$(psql --no-align --tuples-only --dbname "$(pg_url_for "$RESTORE_OWNER_URL" postgres)" \
	--command 'show server_version_num' | cut -c1-2)"
[ "$client_major" = "$server_major" ] ||
	warn "pg_restore is $client_major and the target server is $server_major; benign SET errors are expected"

SET_DIR="$(resolve_set "${1:-}")"
log "restoring from $SET_DIR"
manifest_verify "$SET_DIR"

target_name() { printf '%s%s%s' "$RESTORE_DB_PREFIX" "$1" "$RESTORE_DB_SUFFIX"; }

for database in $PG_DATABASES; do
	if [ "$(target_name "$database")" = "$database" ] && [ "${RESTORE_IN_PLACE:-}" != "yes" ]; then
		die "target name for $database is unchanged; set RESTORE_DB_PREFIX/RESTORE_DB_SUFFIX for a drill, or RESTORE_IN_PLACE=yes for a real recovery"
	fi
done

owner_psql() {
	psql --quiet --no-psqlrc --dbname "$(pg_url_for "$RESTORE_OWNER_URL" "$1")" "${@:2}"
}

# ---- roles and grants -------------------------------------------------------------------------
# ON_ERROR_STOP is off for exactly this file: on a cluster that already carries some of the roles
# (every drill on a live host does) the CREATE ROLE statements are expected to fail, and the
# GRANTs after them are the half that matters.
log "applying cluster roles and grants"
owner_psql postgres --file "$SET_DIR/roles.sql" >"$SET_DIR/restore-roles.log" 2>&1 || true
log "  $(grep -c 'ERROR' "$SET_DIR/restore-roles.log" || true) statement(s) reported an error (pre-existing roles are expected)"

# ---- databases --------------------------------------------------------------------------------
restored=()
for database in $PG_DATABASES; do
	dump="$SET_DIR/pg-$database.dump"
	[ -f "$dump" ] || {
		warn "no dump for $database in this set; skipping"
		continue
	}
	target="$(target_name "$database")"
	log "restoring $database into $target"
	if [ "${RESTORE_DROP_EXISTING:-0}" = "1" ]; then
		owner_psql postgres --command "drop database if exists \"$target\"" >/dev/null
	fi
	owner_psql postgres --command "create database \"$target\"" >/dev/null 2>&1 ||
		log "  $target already exists; restoring into it"
	# --no-owner is refused here for the reason pg-backup.sh states; --exit-on-error is refused
	# because a role-membership statement on a shared cluster is not a reason to abandon a
	# restore. Every error is kept and counted instead.
	pg_restore --dbname "$(pg_url_for "$RESTORE_OWNER_URL" "$target")" \
		--jobs "${RESTORE_JOBS:-4}" --verbose "$dump" \
		>"$SET_DIR/restore-$database.log" 2>&1 || true
	errors="$(grep -c '^pg_restore: error' "$SET_DIR/restore-$database.log" || true)"
	log "  pg_restore reported ${errors:-0} error line(s) (see restore-$database.log)"
	restored+=("$database:$target")
done

# ---- runtime principals -----------------------------------------------------------------------
# The dumped roles carry no password (`--no-role-passwords`), so a restored cluster's logins cannot
# connect until this runs. Passwords come from the TARGET environment, never from the artifact.
#
# ## The names are the ones the stack already writes
#
# `render-env.sh` and `secrets.env` carry `API_DB_PASSWORD` / `PBX_DB_PASSWORD` / `CDR_DB_PASSWORD`,
# and this script used to look only for `RESTORE_*`-prefixed copies of them. Nothing set those, so
# every drill silently skipped the provisioning and left `voice_api`, `voice_pbx` and `voice_cdr`
# without a password — a restored cluster full of correct rows that no service can log in to. So the
# plain names are read too, and the `RESTORE_`-prefixed ones stay as an explicit override for
# restoring into a cluster whose passwords differ from the environment's.
db_password_for() {
	case "$1" in
	voice_api) printf '%s' "${RESTORE_API_DB_PASSWORD:-${API_DB_PASSWORD:-}}" ;;
	voice_pbx) printf '%s' "${RESTORE_PBX_DB_PASSWORD:-${PBX_DB_PASSWORD:-}}" ;;
	voice_cdr) printf '%s' "${RESTORE_CDR_DB_PASSWORD:-${CDR_DB_PASSWORD:-}}" ;;
	esac
}

# And a missing one is fatal, not a warning. A restore that "succeeds" with unprovisioned logins is
# the worst outcome available here: the drill reports green and the recovered stack does not boot.
# `RESTORE_ALLOW_UNPROVISIONED=yes` is the escape hatch for restoring into a cluster where the roles
# are managed elsewhere.
provision_roles() {
	local target="$1" role="$2" password="$3" tenant_role="$4" bypassrls="$5"
	[ -n "$password" ] || {
		[ "${RESTORE_ALLOW_UNPROVISIONED:-}" = "yes" ] ||
			die "no password in the environment for $role (set API_DB_PASSWORD/PBX_DB_PASSWORD/CDR_DB_PASSWORD, or their RESTORE_-prefixed overrides); a restored cluster whose runtime logins have no password cannot boot. Set RESTORE_ALLOW_UNPROVISIONED=yes only when the roles are provisioned elsewhere."
		warn "no password in the environment for $role; leaving it unprovisioned as instructed"
		return
	}
	owner_psql "$target" --set ON_ERROR_STOP=1 \
		--set "role=$role" --set "password=$password" --set "database=$target" \
		--set "tenant_role=$tenant_role" --set "bypassrls=$bypassrls" \
		--file "$REPO_ROOT/.scripts/local-stack/provision-roles.sql" >/dev/null
	log "  provisioned $role on $target"
}

for pair in "${restored[@]}"; do
	source_db="${pair%%:*}"
	target="${pair##*:}"
	case "$source_db" in
	*_voice) provision_roles "$target" voice_api "$(db_password_for voice_api)" api_tenant_tls false ;;
	*_pbx) provision_roles "$target" voice_pbx "$(db_password_for voice_pbx)" pbx_tenant_tls true ;;
	*_cdr) provision_roles "$target" voice_cdr "$(db_password_for voice_cdr)" cdr_tenant_tls true ;;
	esac
done

# ---- verification -----------------------------------------------------------------------------
failures=0
for pair in "${restored[@]}"; do
	source_db="${pair%%:*}"
	target="${pair##*:}"
	counts="$SET_DIR/pg-$source_db.counts"
	log "verifying $target"
	# n_live_tup is a statistics estimate, and it is zero on a freshly restored table until the
	# table has been analysed. Both sides of the comparison are therefore post-ANALYZE readings.
	owner_psql "$target" --command "analyze" >/dev/null
	actual="$SET_DIR/restore-$source_db.counts"
	owner_psql "$target" --no-align --tuples-only --field-separator=' ' \
		--command "select relname, n_live_tup from pg_stat_user_tables order by relname" >"$actual"
	if diff -u "$counts" "$actual" >"$SET_DIR/restore-$source_db.counts.diff"; then
		log "  row counts match across $(wc -l <"$actual" | tr -d ' ') tables"
	else
		# A count that MOVED is not automatically a failure — the source was live during the dump —
		# so the diff is reported rather than fatal, and a table that vanished entirely is.
		missing="$(comm -23 <(awk '{print $1}' "$counts" | sort) <(awk '{print $1}' "$actual" | sort))"
		if [ -n "$missing" ]; then
			warn "tables missing after restore: $(printf '%s' "$missing" | tr '\n' ' ')"
			failures=$((failures + 1))
		else
			warn "row counts differ (see restore-$source_db.counts.diff); no table is missing"
		fi
	fi
done

# The smoke read. Not a `select 1`: each of these touches a table the product cannot work without,
# through the schema the restore just rebuilt.
smoke() {
	local target="$1" label="$2" query="$3" value
	value="$(owner_psql "$target" --no-align --tuples-only --command "$query" 2>&1)" || {
		warn "smoke read failed on $target ($label): $value"
		failures=$((failures + 1))
		return
	}
	log "  smoke read $label = $value"
}
for pair in "${restored[@]}"; do
	source_db="${pair%%:*}"
	target="${pair##*:}"
	case "$source_db" in
	*_voice) smoke "$target" users 'select count(*) from "user"' ;;
	*_pbx)
		smoke "$target" extensions 'select count(*) from extension'
		smoke "$target" organizations 'select count(distinct organization_id) from extension'
		;;
	*_cdr)
		smoke "$target" call_legs 'select count(*) from call_legs'
		smoke "$target" latest_leg "select coalesce(max(started_at)::text, 'none') from call_legs"
		;;
	esac
done

# The reads above ran as the owner, which proves the rows are there and nothing about whether the
# application can reach them. This one connects as the RUNTIME login — the principal the API
# actually uses — which is what makes the restored grants, the tenant-role membership and BYPASSRLS
# load-bearing rather than decorative. A restore that passes everything above and fails here is a
# database full of data no service can read, and it is the failure mode a drill exists to catch.
runtime_smoke() {
	local target="$1" role="$2" password="$3" query="$4" host_url value
	[ -n "$password" ] || return 0
	host_url="$(printf '%s' "$RESTORE_OWNER_URL" | sed "s|://[^@]*@|://$role:$password@|")"
	value="$(psql --no-align --tuples-only --no-psqlrc \
		--dbname "$(pg_url_for "$host_url" "$target")" --command "$query" 2>&1)" || {
		warn "runtime-login smoke read failed on $target as $role: $value"
		failures=$((failures + 1))
		return
	}
	log "  runtime read as $role = $value"
}
for pair in "${restored[@]}"; do
	source_db="${pair%%:*}"
	target="${pair##*:}"
	case "$source_db" in
	*_voice) runtime_smoke "$target" voice_api "$(db_password_for voice_api)" 'select count(*) from "user"' ;;
	*_pbx) runtime_smoke "$target" voice_pbx "$(db_password_for voice_pbx)" 'select count(*) from extension' ;;
	*_cdr) runtime_smoke "$target" voice_cdr "$(db_password_for voice_cdr)" 'select count(*) from call_legs' ;;
	esac
done

# ---- JetStream ---------------------------------------------------------------------------------
if [ -f "$SET_DIR/jetstream-streams.tar" ]; then
	if command -v nats >/dev/null 2>&1 && [ -n "${RESTORE_NATS_URL:-}" ]; then
		work="$(mktemp -d)"
		tar -C "$work" -xf "$SET_DIR/jetstream-streams.tar"
		for snapshot in "$work"/jetstream/*.tgz; do
			stream="$(basename "$snapshot" .tgz)"
			log "restoring stream $stream into $RESTORE_NATS_URL"
			nats --server "$RESTORE_NATS_URL" stream restore "$snapshot" --no-progress >/dev/null ||
				warn "  stream $stream did not restore"
		done
		rm -rf "$work"
	else
		warn "JetStream snapshot present but RESTORE_NATS_URL or the nats CLI is missing; not restored"
	fi
elif [ -f "$SET_DIR/jetstream-store.tar.gz" ]; then
	if [ -n "${RESTORE_NATS_STORE_DIR:-}" ]; then
		# Into an EMPTY directory only: unpacking over a live store mixes two servers' block files
		# and the result loads as neither.
		[ -z "$(ls -A "$RESTORE_NATS_STORE_DIR" 2>/dev/null || true)" ] ||
			die "RESTORE_NATS_STORE_DIR is not empty: $RESTORE_NATS_STORE_DIR"
		mkdir -p "$RESTORE_NATS_STORE_DIR"
		tar -C "$RESTORE_NATS_STORE_DIR" --strip-components=1 -xzf "$SET_DIR/jetstream-store.tar.gz"
		log "JetStream store unpacked into $RESTORE_NATS_STORE_DIR"
	else
		warn "JetStream store-dir copy present but RESTORE_NATS_STORE_DIR is unset; not restored"
	fi
fi

# ---- objects -----------------------------------------------------------------------------------
if [ -f "$SET_DIR/objects.tar" ] || [ -f "$SET_DIR/objects.tar.gz" ]; then
	if [ -n "${RESTORE_OBJECT_ROOT:-}" ]; then
		mkdir -p "$RESTORE_OBJECT_ROOT"
		archive="$SET_DIR/objects.tar"
		[ -f "$archive" ] || archive="$SET_DIR/objects.tar.gz"
		tar -C "$RESTORE_OBJECT_ROOT" --strip-components=1 -xf "$archive"
		log "object store unpacked into $RESTORE_OBJECT_ROOT ($(find "$RESTORE_OBJECT_ROOT" -type f | wc -l | tr -d ' ') files)"
	else
		warn "object archive present but RESTORE_OBJECT_ROOT is unset; not restored"
	fi
elif [ -f "$SET_DIR/objects-s3.pointer" ]; then
	if [ -n "${RESTORE_OBJECT_ROOT:-}" ]; then
		require_cmd aws
		source_url="$(sed -n 's/^destination=//p' "$SET_DIR/objects-s3.pointer")"
		aws s3 sync "$source_url" "$RESTORE_OBJECT_ROOT" --only-show-errors
		log "object store synced from $source_url"
	else
		warn "S3 object pointer present but RESTORE_OBJECT_ROOT is unset; not restored"
	fi
fi

[ "$failures" -eq 0 ] || die "$failures verification step(s) failed"
log "restore complete and verified"
