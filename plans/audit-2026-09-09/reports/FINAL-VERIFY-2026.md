# FINAL VERIFY 2026 — full verification on the current tree

Branch `feat/optimiq-pbx-phase0`, HEAD `32b8499`, working tree dirty (371 changed paths; a
concurrent agent is editing the queue-survey path).

## Summary

| #   | Check                                                            | Verdict                              |
| --- | ---------------------------------------------------------------- | ------------------------------------ |
| 1   | `pnpm install --frozen-lockfile` (lockfile unchanged)            | PASS                                 |
| 2   | `pnpm turbo run build typecheck test`                            | PASS                                 |
| 3   | `check:di`                                                       | PASS                                 |
| 4   | `check:nats`                                                     | PASS                                 |
| 5   | events `codegen:check` (drift + Go parity)                       | **FAIL** — see F1                    |
| 6   | gofmt, 4 Go modules                                              | PASS                                 |
| 7   | go vet, 4 modules x 5 tag sets                                   | PASS                                 |
| 8   | `go test -race ./...`, 4 modules                                 | **FAIL** in events-go only — see F1  |
| 9   | oxlint                                                           | PASS (0 errors, 38 warnings)         |
| 10  | oxfmt --check                                                    | PASS after fix (3 files reformatted) |
| 11  | actionlint, 8 workflows                                          | PASS                                 |
| 12  | web `codegen` idempotency                                        | PASS                                 |
| 13  | drizzle folders vs ledger, 4 folders / 3 DBs                     | PASS                                 |
| 14  | live stack: 8/8 healthy, 4x /metrics 200, smoke call, violations | PASS                                 |

12 pass, 1 fail (counted once; items 5 and 8 are the same root cause), 1 pass-after-fix.

## Counts and durations

### 1. Install

`pnpm install --frozen-lockfile` → exit 0, 1.60s. `git status --porcelain pnpm-lock.yaml` empty:
lockfile unchanged.

### 2. turbo build + typecheck + test

48 tasks, 48 successful, 16 cached. **48.8s wall** (167s user).

| Package                       | pass     | skip   | fail  |
| ----------------------------- | -------- | ------ | ----- |
| @optimiq-voice/api            | 1772     | —      | 0     |
| @optimiq-voice/engine         | 2057     | 12     | 0     |
| @optimiq-voice/web            | 1071     | 0      | 0     |
| @optimiq-voice/routing        | 965      | 0      | 0     |
| @optimiq-voice/events         | 437      | 12     | 0     |
| @optimiq-voice/telephony      | 259      | 0      | 0     |
| @optimiq-voice/auth           | 243      | 0      | 0     |
| @optimiq-voice/telnyx         | 136      | 0      | 0     |
| @optimiq-voice/pbx-db         | 117      | 21     | 0     |
| @optimiq-voice/db             | 111      | 0      | 0     |
| @optimiq-voice/media-ari      | 87       | 7      | 0     |
| @optimiq-voice/cdr-db         | 79       | 38     | 0     |
| @optimiq-voice/config         | 37       | 0      | 0     |
| @optimiq-voice/logging        | 25       | 0      | 0     |
| @optimiq-voice/effect-runtime | 12       | 0      | 0     |
| @optimiq-voice/identifiers    | 6        | 0      | 0     |
| **Total**                     | **7414** | **90** | **0** |

engine reports 2069 tests across 87 files in 44.25s; api 1772 passing in 2s.

### 3–4. DI and NATS grants

- `check:di`: 217 injectable classes across 8 modules; every bare-class constructor parameter has
  `design:paramtypes`. 1.8s.
- `check:nats`: api 8 streams / 10 buckets / 12 durable consumers / 197 publish grants; engine
  12 streams / 18 buckets / 0 durable consumers / 229 publish grants. 180 required JetStream
  subjects all granted. 0.25s.

Note: the root `package.json` has no `check:di` script — it lives in `apps/api`. Ran as
`pnpm --filter @optimiq-voice/api run check:di`.

### 6–8. Go modules

| Module              | packages | gofmt -l | vet (5 tag sets) | test -race         |
| ------------------- | -------- | -------- | ---------------- | ------------------ |
| apps/sipd           | 25       | clean    | clean            | ok, 0.20s (cached) |
| apps/mediad         | 10       | clean    | clean            | ok, 10.30s         |
| packages/events-go  | 1        | clean    | clean            | **FAIL 0.36s**     |
| packages/runtime-go | 6        | clean    | clean            | ok, 1.70s          |

Build tags present in the tree: `e2e` (13 files), `load` (5), `integration` (5), `loadtest` (1),
plus `unix`/`!unix`. `go vet` run with default, `-tags=e2e`, `-tags=integration`, `-tags=load`,
`-tags=loadtest` on all four modules — 20 combinations, all exit 0.

### 9–11. Lint / format / workflows

- `pnpm run lint` (oxlint) → exit 0. 38 warnings, all `typescript(no-explicit-any)` in
  `.scripts/verify-browser-calling.mts` (a helper script). 0 errors.
- `pnpm run format:check` (oxfmt) initially failed on 3 of 1595 files; reformatted (see Fixes).
  Now: "All matched files use the correct format."
- `actionlint .github/workflows/*.yaml` → exit 0, no output. 8 workflows.

### 12. Web codegen idempotency

`pnpm --filter @optimiq-voice/web run codegen` wrote 131 permissions and 5 role templates to
`apps/web/lib/permissions.generated.ts`. `git status --porcelain apps/web` identical before and
after — idempotent.

### 13. Drizzle folders vs ledger (Postgres 127.0.0.1:5533)

| Folder                  | migrations on disk | DB            | ledger table                    | rows |
| ----------------------- | ------------------ | ------------- | ------------------------------- | ---- |
| packages/db/drizzle     | 6                  | optimiq_voice | drizzle.__drizzle_migrations    | 6    |
| apps/api/drizzle        | 6                  | optimiq_voice | public.__drizzle_migrations_api | 6    |
| packages/pbx-db/drizzle | 44                 | optimiq_pbx   | drizzle.__drizzle_migrations    | 44   |
| packages/cdr-db/drizzle | 16                 | optimiq_cdr   | drizzle.__drizzle_migrations    | 16   |

All four match. (`optimiq_voice` carries two independent ledgers — the shared `drizzle` schema for
`packages/db` and `public.__drizzle_migrations_api` for `apps/api`.)

### 14. Live smoke

`.scripts/local-stack/status.sh` — 8/8 healthy:

| service  | port | health  |
| -------- | ---- | ------- |
| postgres | 5533 | healthy |
| nats     | 8322 | 200     |
| smtp     | 2625 | running |
| mediad   | 9291 | 200     |
| sipd     | 9290 | 200     |
| engine   | 9300 | 200     |
| api      | 3200 | 200     |
| web      | 3300 | 200     |

Broker connections by user: mediad 1, sipd 1, engine 3, api 27.

`/metrics` (private listeners): 9200 → 200, 9201 → 200, 9290 → 200, 9291 → 200. (9300 is the
engine's `/healthz` listener and returns 404 on `/metrics` by design; its metrics are on 9201.)

`.scripts/local-stack/smoke-call.mjs` (with `MAIL_DIR=<scratchpad>/e2e/mail`, per
`.scripts/local-stack/README.md`) — PASS, 5.75s, two consecutive runs. All 9 assertions:
org + extensions created; second user verified through captured mail; both browser softphones
registered against sipd over WSS; caller inbound audio 24 packets energy 0.387; callee inbound
24 packets energy 0.408; hold/resume renegotiate and restore audio both ways (caller 35 pkts
energy 0.609, callee 106 pkts energy 0.970); hangup propagates; 2 CDR legs persisted under one
call (billsec 3155ms / 3146ms); teardown namespaced.

Broker permission violations: 1018 before, 1018 after — delta 0. Newest violation in
`nats.log` is timestamped `2026/09/10 00:51:59`, ~7.5h before this run; nothing new was produced.
(980 of the 1018 come from a single historical connection, cid:9.)

## Fixes applied

Formatting only, all three verified as pure whitespace/import-ordering, none in the concurrent
agent's paths:

- `packages/events/scripts/registry.ts` — import of `SECURITY_EVENT_DEFINITIONS` moved into
  sorted position.
- `apps/api/test/messaging/messaging.test.ts` — three expression wraps.
- `apps/engine/test/engine-integration.spec.ts` — three lines rewrapped.

`pnpm run format:check` now clean.

## Residual failures

### F1 — packages/events-go is behind packages/events (NOT FIXED: survey path)

`go test ./...` in `packages/events-go` fails two subtests; `codegen:check` reports the matching
drift. Running `pnpm --filter @optimiq-voice/events run codegen` does not close it, because the
missing pieces live in the hand-maintained Go mirrors `subjects.go` and `streams.go`, which the
generator does not emit.

`TestParityConstants` (`parity_test.go:185`, `:234`):

- subject roots: Go has 11, TS golden has 12 — Go is missing `messaging: messaging.evt.v1`.
- rpc subjects: Go has 42, TS golden has 44 — Go is missing
  `pbxQueueSurvey: rpc.pbx.v1.queue-survey` and
  `pbxQueueDisposition: rpc.pbx.v1.queue-disposition`.

`TestParityStreams` (`parity_test.go:493`): `EventStreams` has 11 entries, golden 12 — Go is
missing `MessagingStream` (TS `MESSAGING_STREAM`: `MESSAGING`, limits/file/discard-new, 30d,
2 GiB, 10min dup window).

Closing this needs, in `packages/events-go`: `SubjectRootMessaging` + an `AllMessagingFilter()`
and the messaging subject builder in `subjects.go`, `MessagingStream` appended to `EventStreams`
in `streams.go`, and the three corresponding entries in `parity_test.go`.

**Reported, not fixed.** Two of the three gaps (`queue-survey`, `queue-disposition`) are exactly
the survey path a concurrent agent is editing — the schemas
`packages/events/schema/rpc/rpc.pbx.v1.queue-survey.*` and `...queue-disposition.*` are still
untracked, as is `packages/events/src/schemas/messaging-events.ts`. Writing the Go mirror while
that contract is in flight would race it. The `messaging` half is independent of the survey work
and could be closed separately.

Everything else on the recipe passes.
