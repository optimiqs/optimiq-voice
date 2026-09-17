#!/usr/bin/env bash
# Tails one service's log. `logs.sh` with no argument lists what is available.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [ $# -eq 0 ]; then
	printf 'usage: logs.sh <service> [tail args]\nservices: %s postgres\n' "${NATIVE_SERVICES[*]}"
	exit 0
fi
name="$1"; shift
if [ "$name" = "postgres" ]; then
	exec docker logs -f voice-e2e-postgres-1 "$@"
fi
[ -f "$LOG_DIR/$name.log" ] || die "no log for '$name' at $LOG_DIR/$name.log"
exec tail -f "$@" "$LOG_DIR/$name.log"
