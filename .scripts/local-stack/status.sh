#!/usr/bin/env bash
# One screen: what is running, on which port, and whether its health endpoint answers.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

probe() {
	local code; code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$1" 2>/dev/null)"
	[ "$code" = "000" ] && printf 'unreachable' || printf '%s' "$code"
}
row() { printf '%-9s %-7s %-9s %-26s %s\n' "$1" "$2" "$3" "$4" "$5"; }

row SERVICE PID PORT HEALTH STATE
pg_state="$(docker inspect --format '{{.State.Health.Status}}' voice-e2e-postgres-1 2>/dev/null || echo absent)"
row postgres - "$PG_PORT" "-" "$pg_state"
for entry in \
	"nats $NATS_MONITOR_PORT http://127.0.0.1:$NATS_MONITOR_PORT/healthz" \
	"smtp $SMTP_PORT -" \
	"mediad $MEDIAD_HEALTH_PORT http://127.0.0.1:$MEDIAD_HEALTH_PORT/healthz" \
	"sipd $SIPD_HEALTH_PORT http://127.0.0.1:$SIPD_HEALTH_PORT/healthz" \
	"engine $ENGINE_PORT http://127.0.0.1:$ENGINE_PORT/healthz" \
	"api $API_PORT http://127.0.0.1:$API_PORT/api/auth/ok" \
	"web $WEB_PORT http://127.0.0.1:$WEB_PORT/sign-in"; do
	# shellcheck disable=SC2086
	set -- $entry
	health="-"; [ "$3" != "-" ] && health="$(probe "$3")"
	row "$1" "$(service_pid "$1" || echo -)" "$2" "$health" "$(service_pid "$1" >/dev/null && echo running || echo stopped)"
done

printf '\nbroker connections by user:\n'
curl -s -m 3 "http://127.0.0.1:$NATS_MONITOR_PORT/connz?auth=1&limit=200" 2>/dev/null \
	| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);const m={};for(const c of v.connections)m[c.authorized_user]=(m[c.authorized_user]||0)+1;for(const[k,n]of Object.entries(m))console.log(`  ${k}: ${n}`)}catch{console.log("  broker unreachable")}})'
# `grep -c` prints the count and still exits 1 when that count is zero, so no `|| echo 0` fallback.
printf '\npermission violations in the broker log: %s\n' "$(grep -ci 'violation' "$LOG_DIR/nats.log" 2>/dev/null; true)"
printf 'logs: %s\npids: %s\n' "$LOG_DIR" "$PID_DIR"
