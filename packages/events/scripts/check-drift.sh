#!/usr/bin/env bash
#
# Cross-language drift gate (plan §3.5: "CI checks cross-language drift").
#
# Run AFTER `pnpm --filter @optimiq-voice/events codegen`. It fails when the regenerated artefacts
# differ from what is committed, which happens exactly when someone edited a Zod schema (or the
# codegen itself) without regenerating — the failure mode the gate exists to catch.
#
# Both checks are needed: `git diff` catches edits to tracked files, `git status` catches a NEW
# generated file (a new event type) that nobody added, which `git diff` alone would miss.
#
#   pnpm --filter @optimiq-voice/events codegen:check
#
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
paths=("packages/events/schema" "packages/events-go")

cd "$repo_root"

status=0

if ! git --no-pager diff --exit-code -- "${paths[@]}"; then
	status=1
fi

untracked="$(git status --porcelain --untracked-files=all -- "${paths[@]}")"
if [[ -n "$untracked" ]]; then
	echo "Generated artefacts are not committed:" >&2
	echo "$untracked" >&2
	status=1
fi

if [[ $status -ne 0 ]]; then
	cat >&2 <<'EOF'

events codegen drift detected.

packages/events/src (Zod) is the single source of truth; packages/events/schema (JSON Schema) and
packages/events-go (Go structs + parity golden) are generated from it. Regenerate and commit:

  pnpm --filter @optimiq-voice/events codegen
  git add packages/events/schema packages/events-go

EOF
	exit 1
fi

echo "events codegen: no drift"
