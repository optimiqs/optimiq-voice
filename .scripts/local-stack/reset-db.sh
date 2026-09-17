#!/usr/bin/env bash
# Resets the stack's state to a fresh install: the three databases, the JetStream store and the
# object store. Needed before re-running smoke-call.mjs, because an organization's SIP domain is a
# unique claim across the deployment and the second run cannot take `local.test` back.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
# shellcheck source=/dev/null
set -a; . "$ENV_DIR/secrets.env"; set +a

log "stopping the services that hold pools and consumers"
for name in web api engine; do
	if pid="$(service_pid "$name")"; then kill "$pid" 2>/dev/null || true; fi
	rm -f "$PID_DIR/$name.pid"
done
sleep 2

export PGPASSWORD="$PG_PASSWORD"
for name in optimiq_voice optimiq_pbx optimiq_cdr; do
	log "recreating $name"
	psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -d postgres -q -c "drop database if exists $name with (force)" -c "create database $name"
done

log "re-running the migration journals"
( set -a; . "$ENV_DIR/migrate.env"; set +a; cd "$REPO_ROOT" && node .scripts/migrate-platform.mjs --expected-stage development )

log "re-provisioning runtime roles"
provision() {
	psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -q -v ON_ERROR_STOP=1 \
		-d "$1" -v role="$2" -v password="$3" -v database="$1" -v tenant_role="$4" -v bypassrls="$5" \
		-f "$STACK_DIR/provision-roles.sql" 2>&1 | grep -v NOTICE || true
}
provision optimiq_voice voice_api "$API_DB_PASSWORD" api_tenant_tls false
provision optimiq_pbx   voice_pbx "$PBX_DB_PASSWORD" pbx_tenant_tls true
provision optimiq_cdr   voice_cdr "$CDR_DB_PASSWORD" cdr_tenant_tls true

# The platform's own audio goes with it — the default music-on-hold class and the system prompt
# set — and comes back when the api restarts below: `PBX_ENSURE_SYSTEM_MEDIA` seeds it on boot
# (apps/api/src/pbx/media/system-media.service.ts). Nothing else puts those files on the mount, and
# mediad's prompt library IS this directory, so a reset that skipped the restart would leave every
# queue caller on silence.
log "clearing the object store and the captured mail"
rm -rf "$STACK_HOME/objects"/* "$STACK_HOME/mail"/* 2>/dev/null || true

# The KV buckets carry the routing cache, the registrations and the channel state of the database
# that has just been dropped, so they have to go with it. Only the broker's own store is removed;
# the engine recreates every stream and bucket at boot and sipd re-attaches its watchers.
log "clearing the JetStream store"
if pid="$(service_pid nats)"; then kill "$pid" 2>/dev/null || true; rm -f "$PID_DIR/nats.pid"; sleep 1; fi
rm -rf "$STACK_HOME/nats/store"
bash "$STACK_DIR/up.sh" nats

log "restarting engine, api and web"
bash "$STACK_DIR/up.sh" engine
bash "$STACK_DIR/up.sh" api
bash "$STACK_DIR/up.sh" web
log "reset complete."
