#!/usr/bin/env bash
# Dumps every Optimiq Voice database in pg_dump's custom format, plus the cluster's role and
# grant definitions.
#
# Usage: PG_OWNER_URL=postgresql://postgres:...@host:5432 .scripts/backup/pg-backup.sh [SET_DIR]
#
# Custom format (`-Fc`) rather than plain SQL because it is the only one `pg_restore` can filter,
# parallelise and reorder — a restore that must skip one table, or run with `--jobs`, cannot do
# either from a `.sql` file.
#
# ## Roles and grants
#
# `pg_dump` emits GRANTs but never CREATE ROLE, so a dump restored into a fresh cluster fails on
# every grant naming a role that does not exist yet — and the runtime logins (`voice_api`,
# `voice_pbx`, `voice_cdr`) and the tenant roles (`pbx_tenant_tls`, `cdr_tenant_tls`) are exactly
# such roles. `pg_dumpall --roles-only` is therefore taken alongside, and `restore.sh` applies it
# first. It is taken with `--no-role-passwords`, which means:
#
#   * the artifact contains no credential material, so it is safe beside the data dumps; and
#   * a restored cluster's logins have NO password until they are re-provisioned. That is the
#     point — `restore.sh` re-runs `.scripts/local-stack/provision-roles.sql` with the passwords
#     from the target environment, and a restore that silently resurrected a rotated password
#     would be a credential leak with a long half-life.
#
# Reading `pg_authid` requires superuser, so this runs as the owner/superuser principal, never as
# a runtime login.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_cmd pg_dump
require_cmd pg_dumpall
require_cmd psql

[ -n "$PG_OWNER_URL" ] || die "PG_OWNER_URL is required (the owner/superuser libpq URL, no database component)"

SET_DIR="${1:-$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$SET_DIR"

# `postgres` is the maintenance database every cluster has; the roles dump is cluster-wide and does
# not care which one it connects through.
roles_file="$SET_DIR/roles.sql"
log "dumping cluster roles and grants"
pg_dumpall --roles-only --no-role-passwords --dbname "$(pg_url_for "$PG_OWNER_URL" postgres)" >"$roles_file"
manifest_add "$SET_DIR" postgres-roles roles "$roles_file"

for database in $PG_DATABASES; do
	target="$SET_DIR/pg-$database.dump"
	log "dumping $database"
	# --no-owner/--no-acl are deliberately NOT passed: ownership and the ACLs on every table are
	# what the RLS preflight asserts at boot, and a dump that dropped them restores a cluster the
	# API refuses to start against.
	pg_dump --format=custom --compress=6 --verbose \
		--file "$target" "$(pg_url_for "$PG_OWNER_URL" "$database")" 2>"$SET_DIR/pg-$database.log"
	manifest_add "$SET_DIR" postgres "$database" "$target"

	# The row counts the restore verifies against. Taken from the same connection immediately after
	# the dump rather than from the dump itself, so a restore compares against a live reading.
	#
	# ANALYZE first, and it is not optional cosmetics: `n_live_tup` is an autovacuum estimate that
	# drifts, and the restored side is analysed by definition (a freshly loaded table has no stats
	# until it is). Comparing a drifted estimate against a fresh one produces a diff on half the
	# tables in the database and buries a real one. Set BACKUP_ANALYZE=0 to skip it on a cluster
	# where the I/O is not affordable — the comparison then becomes advisory.
	if [ "${BACKUP_ANALYZE:-1}" = "1" ]; then
		psql --quiet --dbname "$(pg_url_for "$PG_OWNER_URL" "$database")" --command "analyze" >/dev/null
	fi
	counts="$SET_DIR/pg-$database.counts"
	psql --quiet --no-align --tuples-only --field-separator=' ' \
		--dbname "$(pg_url_for "$PG_OWNER_URL" "$database")" \
		--command "select relname, n_live_tup from pg_stat_user_tables order by relname" >"$counts"
	manifest_add "$SET_DIR" postgres-counts "$database" "$counts"
done

log "postgres artifacts written to $SET_DIR"
