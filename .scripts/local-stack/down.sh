#!/usr/bin/env bash
# Stops the stack. Native services first (so they deregister from the broker cleanly), then the
# broker, then the Docker Postgres. `--purge` also drops the database volume and the object store.
# A service name (`down.sh api`) stops only that service, mirroring `up.sh <service>`.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ONLY=""
case "${1:-}" in
	""|--purge) ;;
	web|api|engine|sipd|mediad|smtp|nats) ONLY="$1" ;;
	*) die "unknown argument '$1' (expected a service name or --purge)" ;;
esac

for name in web api engine sipd mediad smtp nats; do
	[ -z "$ONLY" ] || [ "$ONLY" = "$name" ] || continue
	if pid="$(service_pid "$name")"; then
		log "stopping $name (pid $pid)"
		kill "$pid" 2>/dev/null || true
		for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
		kill -9 "$pid" 2>/dev/null || true
	fi
	rm -f "$PID_DIR/$name.pid"
done

if [ -n "$ONLY" ]; then
	log "$ONLY down."
	exit 0
elif [ "${1:-}" = "--purge" ]; then
	log "removing the database volume and the object store"
	( cd "$STACK_DIR" && PG_PASSWORD=unused docker compose -f compose.pg.yaml down -v )
	rm -rf "$STACK_HOME/objects" "$STACK_HOME/exports" "$STACK_HOME/mail" "$STACK_HOME/nats/store"
else
	( cd "$STACK_DIR" && PG_PASSWORD=unused docker compose -f compose.pg.yaml down )
fi
log "down."
