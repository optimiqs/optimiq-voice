# Shared state for the local end-to-end stack scripts. Sourced, never executed.
#
# Everything mutable — secrets, env files, PIDs, logs, the object store — lives under STACK_HOME,
# outside the checkout, so a `git clean` cannot destroy a running stack and no secret is ever
# written into the repository.

set -euo pipefail

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$STACK_DIR/../.." && pwd)"
STACK_HOME="${STACK_HOME:-/private/tmp/claude-501/-Users-jayarajsrivathsavadari-Documents-Github-fonoster/d22c2238-f57c-44f4-832e-7d32567ef763/scratchpad/e2e}"
ENV_DIR="$STACK_HOME/env"
LOG_DIR="$STACK_HOME/logs"
PID_DIR="$STACK_HOME/pids"

# shellcheck source=ports.env
set -a; . "$STACK_DIR/ports.env"; set +a

mkdir -p "$ENV_DIR" "$LOG_DIR" "$PID_DIR" "$STACK_HOME/objects" "$STACK_HOME/exports" \
	"$STACK_HOME/nats" "$STACK_HOME/certs" "$STACK_HOME/bin"

NATIVE_SERVICES=(nats smtp sipd mediad engine api web)
ALL_SERVICES=(postgres "${NATIVE_SERVICES[@]}")

log() { printf '[stack] %s\n' "$*"; }
die() { printf '[stack] ERROR: %s\n' "$*" >&2; exit 1; }

# Who holds a TCP port, if anyone. Empty output means free.
# `lsof` exits 1 when it matches nothing, which under `pipefail` would fail the whole pipeline —
# and a free port is the normal case here, not an error.
port_holder() {
	{ lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; } | awk 'NR>1 {print $1" (pid "$2")"}' | sort -u | paste -sd, -
}

require_port_free() {
	local holder; holder="$(port_holder "$1")"
	[ -z "$holder" ] || die "port $1 ($2) is already held by: $holder"
}

service_pid() {
	local file="$PID_DIR/$1.pid"
	[ -f "$file" ] || return 1
	local pid; pid="$(cat "$file")"
	kill -0 "$pid" 2>/dev/null || return 1
	printf '%s' "$pid"
}

# Wait for a URL to answer 2xx, or fail with the last body seen.
wait_http() {
	local url="$1" label="$2" deadline=$(( $(date +%s) + ${3:-90} ))
	while [ "$(date +%s)" -lt "$deadline" ]; do
		if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then return 0; fi
		sleep 1
	done
	die "timed out waiting for $label at $url"
}
