#!/usr/bin/env bash
# Brings the whole platform up locally: Postgres in Docker on a shifted port, the real broker
# config, and every application service native so it can be attached to and restarted on its own.
#
# Idempotent: a service already running is left alone, and re-running only starts what is down.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ONLY="${1:-}"
wanted() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

bash "$STACK_DIR/render-env.sh"
# shellcheck source=/dev/null
set -a; . "$ENV_DIR/secrets.env"; set +a

start_native() {
	local name="$1"; shift
	if service_pid "$name" >/dev/null; then log "$name already running (pid $(service_pid "$name"))"; return; fi
	log "starting $name"
	( "$@" >> "$LOG_DIR/$name.log" 2>&1 & echo $! > "$PID_DIR/$name.pid" )
}

# ---------------------------------------------------------------- postgres + migrations
if wanted postgres; then
	if [ -z "$(port_holder "$PG_PORT")" ]; then
		log "starting postgres on $PG_PORT"
		( cd "$STACK_DIR" && PG_PORT="$PG_PORT" PG_PASSWORD="$PG_PASSWORD" docker compose -f compose.pg.yaml up -d )
	else
		log "postgres port $PG_PORT already held; assuming this stack's container"
	fi
	until PGPASSWORD="$PG_PASSWORD" psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -Atc 'select 1' >/dev/null 2>&1; do sleep 1; done

	log "applying the four migration journals"
	( set -a; . "$ENV_DIR/migrate.env"; set +a; cd "$REPO_ROOT" && node .scripts/migrate-platform.mjs --expected-stage development )

	log "provisioning runtime roles"
	provision() {
		PGPASSWORD="$PG_PASSWORD" psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -q -v ON_ERROR_STOP=1 \
			-d "$1" -v role="$2" -v password="$3" -v database="$1" -v tenant_role="$4" -v bypassrls="$5" \
			-f "$STACK_DIR/provision-roles.sql" 2>&1 | grep -v '^psql.*NOTICE' || true
	}
	provision optimiq_voice voice_api "$API_DB_PASSWORD" api_tenant_tls false
	provision optimiq_pbx   voice_pbx "$PBX_DB_PASSWORD" pbx_tenant_tls true
	provision optimiq_cdr   voice_cdr "$CDR_DB_PASSWORD" cdr_tenant_tls true
fi

# ---------------------------------------------------------------- broker
# The overlay includes the REAL config/nats.conf through a symlink — nats-server resolves an
# `include` relative to the including file and rejects an absolute path — and then shifts the two
# ports and the store directory. The accounts, users and per-service permission allow-lists under
# test are therefore exactly the ones the deployment ships.
if wanted nats; then
	service_pid nats >/dev/null || require_port_free "$NATS_PORT" nats
	ln -sf "$REPO_ROOT/config/nats.conf" "$STACK_HOME/nats/nats-base.conf"
	cat > "$STACK_HOME/nats/nats.conf" <<EOF
include "nats-base.conf"

host: 127.0.0.1
port: ${NATS_PORT}
http_port: ${NATS_MONITOR_PORT}
jetstream {
  store_dir: "${STACK_HOME}/nats/store"
}
EOF
	[ -x "$STACK_HOME/../bin/nats-server" ] || die "nats-server binary not found at $STACK_HOME/../bin/nats-server"
	( set -a; . "$ENV_DIR/nats.env"; set +a
	  start_native nats "$STACK_HOME/../bin/nats-server" -c "$STACK_HOME/nats/nats.conf" )
	wait_http "http://127.0.0.1:${NATS_MONITOR_PORT}/healthz" nats 30
fi

# ---------------------------------------------------------------- mail sink
if wanted smtp; then
	service_pid smtp >/dev/null || require_port_free "$SMTP_PORT" smtp
	mkdir -p "$STACK_HOME/mail"
	( export SMTP_PORT MAIL_DIR="$STACK_HOME/mail"
	  start_native smtp node "$REPO_ROOT/.scripts/local-stack/smtp.mjs" )
fi

# ---------------------------------------------------------------- media and signalling edges
if { wanted mediad && ! service_pid mediad >/dev/null; } || { wanted sipd && ! service_pid sipd >/dev/null; }; then
	[ -f "$STACK_HOME/certs/cert.pem" ] || {
		log "generating a self-signed cert for the TLS and WSS listeners"
		openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=localhost \
			-addext "subjectAltName=DNS:localhost,DNS:local.test,IP:127.0.0.1" \
			-keyout "$STACK_HOME/certs/key.pem" -out "$STACK_HOME/certs/cert.pem" 2>/dev/null
	}
	log "building the Go services"
	( cd "$REPO_ROOT" && go build -o "$STACK_HOME/bin/sipd" ./apps/sipd/cmd/sipd && go build -o "$STACK_HOME/bin/mediad" ./apps/mediad/cmd/mediad )
fi
if wanted mediad; then
	service_pid mediad >/dev/null || require_port_free "$MEDIAD_HEALTH_PORT" mediad
	( set -a; . "$ENV_DIR/mediad.env"; set +a; start_native mediad "$STACK_HOME/bin/mediad" )
	wait_http "http://127.0.0.1:${MEDIAD_HEALTH_PORT}/healthz" mediad 30
fi
if wanted sipd; then
	service_pid sipd >/dev/null || require_port_free "$SIPD_HEALTH_PORT" sipd
	( set -a; . "$ENV_DIR/sipd.env"; set +a; start_native sipd "$STACK_HOME/bin/sipd" )
	wait_http "http://127.0.0.1:${SIPD_HEALTH_PORT}/healthz" sipd 30
fi

# ---------------------------------------------------------------- engine
# From source, through the same metadata-emitting runner as `start:dev`
# (`node --import @swc-node/register/esm-register`), minus its `--watch`: the engine injects most of
# its providers by bare class type, and under a runner that drops `design:paramtypes` every one of
# them arrives as undefined. `--watch` is left off deliberately — a stack that is meant to stay up
# restarts on `down.sh`/`up.sh`, not on somebody saving a file. `pnpm run check:di` is the guard for
# the metadata itself, and CI runs it for both apps.
if wanted engine; then
	service_pid engine >/dev/null || require_port_free "$ENGINE_PORT" engine
	( set -a; . "$ENV_DIR/engine.env"; set +a
	  cd "$REPO_ROOT/apps/engine" && start_native engine node --import @swc-node/register/esm-register src/main.ts )
	wait_http "http://127.0.0.1:${ENGINE_PORT}/healthz" engine 60
fi

# ---------------------------------------------------------------- api and web
# From source through the same metadata-emitting runner the engine uses. This is what
# `SipAuthEventConsumer.events` surfaced: under a runner with no `design:paramtypes` it arrived as
# `undefined`, Nest raised nothing — with no metadata a constructor looks dependency-free — and
# every refused REGISTER threw and was redelivered for ever.
if wanted api; then
	service_pid api >/dev/null || require_port_free "$API_PORT" api
	( set -a; . "$ENV_DIR/api.env"; set +a
	  cd "$REPO_ROOT/apps/api" && start_native api node --import @swc-node/register/esm-register src/main.ts )
	wait_http "http://127.0.0.1:${API_PORT}/api/auth/ok" api 120
fi
if wanted web; then
	service_pid web >/dev/null || require_port_free "$WEB_PORT" web
	service_pid web >/dev/null || ( cd "$REPO_ROOT/apps/web" && pnpm run codegen >/dev/null )
	( set -a; . "$ENV_DIR/web.env"; set +a
	  cd "$REPO_ROOT/apps/web" && start_native web pnpm exec next dev --port "$WEB_PORT" --hostname 127.0.0.1 )
	wait_http "http://127.0.0.1:${WEB_PORT}/sign-in" web 90
fi

log "up. run .scripts/local-stack/status.sh for the port map and health."
