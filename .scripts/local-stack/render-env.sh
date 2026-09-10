#!/usr/bin/env bash
# Generates the per-service env files under $STACK_HOME/env from a secret set created once.
#
# Every variable each process reads is written here explicitly. That matters more than it looks:
# packages/config hydrates unset variables from the repository root `.env`, a legacy file that
# still names a 5432 Postgres and an Asterisk that is not part of this stack, so a variable left
# out of these files does not stay unset — it silently picks up the wrong value.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

SECRETS="$ENV_DIR/secrets.env"
if [ ! -f "$SECRETS" ]; then
	log "generating secrets into $SECRETS"
	umask 077
	{
		for name in PG_PASSWORD AUTH_SECRET SIPD_NONCE_SECRET PROVISION_SIP_SECRET_KEY \
			CDR_RECORDING_URL_SECRET NATS_PASS NATS_SYS_PASS NATS_API_PASS NATS_ENGINE_PASS \
			NATS_SIPD_PASS NATS_MEDIAD_PASS API_DB_PASSWORD PBX_DB_PASSWORD CDR_DB_PASSWORD; do
			printf '%s=%s\n' "$name" "$(openssl rand -hex 24)"
		done
		# AES-256-GCM, so this one is a KEY rather than a password: exactly 32 bytes, not the 24
		# the loop above is happy with. secret-cipher.ts refuses anything else.
		printf 'PLATFORM_SECRET_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
	} > "$SECRETS"
fi
# shellcheck source=/dev/null
set -a; . "$SECRETS"; set +a

REALM=local.test
ORIGIN="http://127.0.0.1:${WEB_PORT}"
PG=127.0.0.1:${PG_PORT}
OWNER="postgresql://postgres:${PG_PASSWORD}@${PG}"

cat > "$ENV_DIR/nats.env" <<EOF
NATS_USER=operator
NATS_PASS=${NATS_PASS}
NATS_SYS_USER=system
NATS_SYS_PASS=${NATS_SYS_PASS}
NATS_API_USER=api
NATS_API_PASS=${NATS_API_PASS}
NATS_ENGINE_USER=engine
NATS_ENGINE_PASS=${NATS_ENGINE_PASS}
NATS_SIPD_USER=sipd
NATS_SIPD_PASS=${NATS_SIPD_PASS}
NATS_MEDIAD_USER=mediad
NATS_MEDIAD_PASS=${NATS_MEDIAD_PASS}
EOF

cat > "$ENV_DIR/migrate.env" <<EOF
NODE_ENV=development
DATABASE_DEPLOYMENT_STAGE=development
APP_ENV_CONTENT=
DATABASE_MIGRATION_URL=${OWNER}/optimiq_voice
PBX_DATABASE_MIGRATION_URL=${OWNER}/optimiq_pbx
CDR_DATABASE_MIGRATION_URL=${OWNER}/optimiq_cdr
API_DATABASE_URL=${OWNER}/optimiq_voice
PBX_DATABASE_URL=${OWNER}/optimiq_pbx
CDR_DATABASE_URL=${OWNER}/optimiq_cdr
EOF

cat > "$ENV_DIR/api.env" <<EOF
NODE_ENV=development
OPTIMIQ_SERVICE=api
LOG_LEVEL=info
LOG_PRETTY=false
API_HTTP_BRIDGE_PORT=${API_PORT}
API_APP_URL=${ORIGIN}
AUTH_URL=${ORIGIN}
AUTH_SECRET=${AUTH_SECRET}
API_DATABASE_URL=postgresql://voice_api:${API_DB_PASSWORD}@${PG}/optimiq_voice
PBX_DATABASE_URL=postgresql://voice_pbx:${PBX_DB_PASSWORD}@${PG}/optimiq_pbx
CDR_DATABASE_URL=postgresql://voice_cdr:${CDR_DB_PASSWORD}@${PG}/optimiq_cdr
API_NATS_URL=nats://127.0.0.1:${NATS_PORT}
NATS_URL=nats://127.0.0.1:${NATS_PORT}
NATS_API_USER=api
NATS_API_PASS=${NATS_API_PASS}
SMTP_HOST=127.0.0.1
SMTP_PORT=${SMTP_PORT}
SMTP_SECURE=false
MAIL_FROM='Optimiq Voice Local <voice@local.test>'
PROVISION_SIP_SECRET_KEY=${PROVISION_SIP_SECRET_KEY}
# The AES-256-GCM envelope key over organization_sso_provider.client_secret.
PLATFORM_SECRET_ENCRYPTION_KEY=${PLATFORM_SECRET_ENCRYPTION_KEY}
PROVISION_SIP_SERVER=${REALM}
PROVISION_SIP_PORT=${SIPD_SIP_PORT}
PROVISION_BASE_URL=${ORIGIN}
PROVISION_WEBRTC_ENABLED=true
PROVISION_SIP_WSS_URL=wss://127.0.0.1:${SIPD_WSS_PORT}
CDR_RECORDING_ROOT=${STACK_HOME}/objects
CDR_EXPORT_ROOT=${STACK_HOME}/exports
CDR_RECORDING_URL_SECRET=${CDR_RECORDING_URL_SECRET}
PBX_MEDIA_OBJECT_ROOT=${STACK_HOME}/objects
PBX_VOICEMAIL_MEDIA_ROOT=${STACK_HOME}/objects
EOF

cat > "$ENV_DIR/engine.env" <<EOF
NODE_ENV=development
OPTIMIQ_SERVICE=engine
LOG_LEVEL=info
LOG_PRETTY=false
ENGINE_HOST=127.0.0.1
ENGINE_PORT=${ENGINE_PORT}
ENGINE_MEDIA_DRIVER=mediad
ENGINE_INSTANCE_ID=e2e-engine-1
ENGINE_MEDIA_OBJECT_ROOT=${STACK_HOME}/objects
# The engine is the one process on this stack whose ceiling is a single thread, so its health
# listener carries a CPU profiler here exactly as sipd and mediad carry /debug/pprof on theirs.
ENGINE_PROFILING=true
NATS_URL=nats://127.0.0.1:${NATS_PORT}
NATS_ENGINE_USER=engine
NATS_ENGINE_PASS=${NATS_ENGINE_PASS}
EOF

cat > "$ENV_DIR/web.env" <<EOF
NODE_ENV=development
PORT=${WEB_PORT}
API_PROXY_ORIGIN=http://127.0.0.1:${API_PORT}
# The live WebSocket cannot ride the Next dev rewrite; the browser connects to the API directly.
NEXT_PUBLIC_API_ORIGIN=http://127.0.0.1:${API_PORT}
EOF

cat > "$ENV_DIR/sipd.env" <<EOF
NATS_URL=nats://127.0.0.1:${NATS_PORT}
NATS_SIPD_USER=sipd
NATS_SIPD_PASS=${NATS_SIPD_PASS}
SIPD_INSTANCE_ID=e2e-sipd-1
SIPD_REALM=${REALM}
SIPD_NONCE_SECRET=${SIPD_NONCE_SECRET}
SIPD_PROVISION_SECRET_KEY=${PROVISION_SIP_SECRET_KEY}
SIPD_CREDENTIAL_SOURCE=nats
SIPD_INVITE=true
SIPD_UDP=true
SIPD_TCP=true
SIPD_LISTEN_ADDR=127.0.0.1:${SIPD_SIP_PORT}
SIPD_EXTERNAL_LISTEN_ADDR=127.0.0.1:${SIPD_EXTERNAL_PORT}
SIPD_TLS=true
SIPD_TLS_LISTEN_ADDR=127.0.0.1:${SIPD_TLS_PORT}
SIPD_WS=true
SIPD_WS_LISTEN_ADDR=127.0.0.1:${SIPD_WS_PORT}
SIPD_WSS=true
SIPD_WSS_LISTEN_ADDR=127.0.0.1:${SIPD_WSS_PORT}
SIPD_TLS_CERT_FILE=${STACK_HOME}/certs/cert.pem
SIPD_TLS_KEY_FILE=${STACK_HOME}/certs/key.pem
SIPD_HEALTH_ADDR=127.0.0.1:${SIPD_HEALTH_PORT}
SIPD_PPROF=true
SIPD_LOG_LEVEL=info
EOF

cat > "$ENV_DIR/mediad.env" <<EOF
NATS_URL=nats://127.0.0.1:${NATS_PORT}
NATS_MEDIAD_USER=mediad
NATS_MEDIAD_PASS=${NATS_MEDIAD_PASS}
MEDIAD_INSTANCE_ID=e2e-mediad-1
MEDIAD_PUBLIC_IP=127.0.0.1
MEDIAD_BIND_IP=127.0.0.1
MEDIAD_RTP_PORT_MIN=${MEDIAD_RTP_MIN}
MEDIAD_RTP_PORT_MAX=${MEDIAD_RTP_MAX}
MEDIAD_WEBRTC=true
MEDIAD_WEBRTC_PORT_MIN=${MEDIAD_WEBRTC_MIN}
MEDIAD_WEBRTC_PORT_MAX=${MEDIAD_WEBRTC_MAX}
MEDIAD_SOUNDS_DIR=${STACK_HOME}/objects
MEDIAD_RECORDINGS_DIR=${STACK_HOME}/objects
MEDIAD_HEALTH_ADDR=127.0.0.1:${MEDIAD_HEALTH_PORT}
MEDIAD_PPROF=true
MEDIAD_LOG_LEVEL=info
EOF

chmod 600 "$ENV_DIR"/*.env
log "env files written to $ENV_DIR"
