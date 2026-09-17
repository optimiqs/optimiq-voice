# FIX — AREA: pkg-contracts

## P0

**Effect defect logging writes an unredacted `Cause` straight to pino** — FIXED (pino-level).
`packages/logging/src/logger.ts`: `createPinoLogger` now installs a `hooks.logMethod` that runs
every argument through `redactLogValue` before the transport, so `AppLogger`, `getLogger`, the
Effect logger bridge and any raw `getPinoLogger().error(...)` are all covered by one gate.
`createPinoLogger` also takes an optional destination stream so the hook itself is testable without
opening a transport worker. `run-effect.ts` and `observability.ts` are unchanged — they no longer
need per-call scrubbing.

**Every `Effect.log` annotation reaches pino unredacted** — FIXED by the same change.
New `packages/effect-runtime/src/effect/observability.spec.ts` proves it end to end: a DSN, a SIP
password and an E.164 in `Effect.annotateLogs` + the message, and a DSN/E.164 inside a rendered
Effect `Cause`, all come out redacted; `sessionId` survives.
New tests in `packages/logging/src/logger.spec.ts` cover the raw-pino front door.

## P1

**`assertProductionNatsCredentials` accepts any service pair** — FIXED
(`packages/config/src/env-invariants.ts`). It now checks the pair belonging to
`config.OPTIMIQ_SERVICE` (`NATS_ENGINE_*` for engine, `NATS_API_*` otherwise); the placeholder loop
over all four is unchanged. The existing spec asserted the wrong thing (an api-service config
satisfied by `NATS_ENGINE_*`) and was corrected; two tests added — another service's pair no longer
passes, the shared pair still does.

**Codegen registry has no completeness assertion** — FIXED
(`packages/events/scripts/registry.ts`): `assertRegistryComplete()` runs at module scope and throws
if any `*_EVENT_DEFINITIONS` key has no `EVENT_ENTRIES` entry or any `RPC_CONTRACTS` key has no
`RPC_ENTRIES` entry. Both lists are complete today, so the generator is unaffected.

**Parity golden covered 21/53 events and 0/37 RPC pairs** — FIXED
(`packages/events/scripts/generate-go.ts`). Added a deterministic sample synthesizer driven by the
same JSON Schema the emitter consumes (`sampleFor`/`sampleString`/`sampleNumber`, first enum member,
lower bound of a range, first candidate string matching `pattern`/`minLength`/`maxLength`; optional
fields populated too). It emits:

- one envelope per `EVENT_ENTRIES` type via `makeEvent(defineEvent(...))`, so each sample is
  validated by the contract before it reaches the golden (`eventSamples` is now 21 hand-written +
  53 synthesized);
- a new `rpcSamples` section: one request and one response per subject, each `.parse()`d by the Zod
  contract.
  Go side: `registry_gen.go` gained `NewRPCRequestFor`/`NewRPCResponseFor`; `parity_test.go` gained
  `TestParityRPCSamples` (round-trips all 74 RPC structs) and `TestParityEventSampleCoverage` (every
  `EventTypes` entry must have a sample). All pass.

**`sip-acl` KV value has no generated Go type** — FIXED on this side.
`registry.ts` gained `LIVE_STATE_ENTRIES` (trunks, sip-acl, sip-dialogs, presence, media-sessions);
`generate-go.ts` emits `schema/live-state/<bucket>.schema.json` for each and one
`packages/events-go/live_state_gen.go` (replacing `trunk_directory_gen.go`), and `schema/index.json`'s
`liveState` registry now lists all five. Generated names: `TrunkDirectoryEntry`, `SIPACLEntry`,
`SIPDialogClaim`, `ExtensionPresenceValue`, `MediaSessionDirectoryValue` — the last two are suffixed
`Value` deliberately so they do not collide with the hand-written `ExtensionPresence` /
`MediaSessionDirectoryEntry` that `apps/sipd` compiles against today (deleting those is a cross-area
change; see below). `apps/sipd` and `apps/mediad` still build.

## P2

- `SENSITIVE_LOG_PATTERN` substring over-match — FIXED (`packages/logging/src/redaction.ts`).
  `session`, `address` and `\bdid\b` moved out of the substring pattern into
  `AMBIGUOUS_SENSITIVE_KEY_PATTERN = /(^|[_-])(session|address|did)([_-]|$)/i`. `sessionId`,
  `sessionCount`, `applicationSessionId`, `ipAddress`, `remoteAddress`, `didIndex` now survive;
  `session`, `session_id`, `ip-address`, `did` are still blanked. Test added.
- `parseSubject` cannot parse instance-addressed RPC subjects — FIXED
  (`subjects.ts`, plus `target` on the `rpc` arm of `ParsedSubject`, the Go `ParsedSubject.Target`,
  the golden's `parseSubject` cases and `goldenParsedSubject`). Spec added.
- `engineRenegotiateRpc` under `sipInviteRpc`'s doc comment — FIXED; each now has its own.
- Zod `.default()` cross-language mismatch — FIXED for the two fields the audit named:
  `sipAclEntrySchema.priority` and `.enabled` are now required (no default), which keeps
  `projectSipAclEntry` byte-identical (it writes both explicitly) and matches the non-pointer Go
  decode. The wider `.default()` use in `rpc.ts` was checked and left alone: `z.toJSONSchema(io:
"output")` marks a defaulted field REQUIRED, so the emitter already produces a non-pointer field
  and every TS writer emits it — those are not mismatches. No emitter change needed.
- `EventValidationError.issues` carried the whole payload — FIXED (`validate.ts`): the synthetic
  issue's `input` is now `{ subject, orgId }`. Spec added.
- `getEnvEntries()` dead and dumps `APP_ENV_CONTENT` — FIXED: deleted from `env.ts`, `index.ts` and
  its only caller (`env.spec.ts`).
- `isStreamNotFoundError` message regex — FIXED: narrowed to `/stream not found/i`; two rows added
  to the existing classification table (`consumer not found`, a DNS failure).

## Additional fixes

None beyond the above; nothing else in the touched files looked wrong.

## Cross-area needed

- `apps/sipd/internal/acl/acl.go` — `Record` should become (or be derived from) the generated
  `events.SIPACLEntry`: it currently declares `OrganizationID \`json:"organizationId"\``where the
writer emits`orgId`, plus `id`/`description`the writer never emits. Its doc comment ("there is
no`sipAclEntrySchema`") is now false. Inert today only because `Applies()` never reads the field.
- `apps/sipd` (`internal/subscribe`, `integration_test.go`) and `apps/mediad` could drop the
  hand-written `ExtensionPresence` / `MediaSessionDirectoryEntry` mirrors in
  `packages/events-go/presence.go` and `media_sessions.go` in favour of the new generated
  `ExtensionPresenceValue` / `MediaSessionDirectoryValue`; deleting the mirrors requires those apps
  to move first (`presence.go` also carries the `PresenceDeviceState` vocabulary and its methods,
  which stay).

## Verification (exact final output)

- `packages/events`: typecheck clean; `387 pass, 12 skip, 0 fail` (1037 expect, 399 tests).
- `packages/config`: typecheck clean; `36 pass, 0 fail`.
- `packages/logging`: typecheck clean; `25 pass, 0 fail`.
- `packages/effect-runtime`: typecheck clean; `12 pass, 0 fail`.
- `packages/identifiers`: typecheck clean; `6 pass, 0 fail`.
- `packages/events-go`: `go vet ./...` clean; `go test -race ./...` → `ok ... 1.334s`.
- `packages/runtime-go`: `go vet ./...` clean; `go test -race ./...` → `ok .../health`.
- `apps/sipd`, `apps/mediad`: `go build ./...` OK.
- Codegen: `pnpm --filter @optimiq-voice/events run codegen` writes 151 files; running it twice
  produces byte-identical output (checksummed) — idempotent. `codegen:check` cannot pass here
  because it is a `git diff`/`git status` gate and the regenerated artefacts are intentionally
  uncommitted (the brief forbids touching git state); it will be clean once
  `packages/events/schema` + `packages/events-go` are committed.
- `pnpm exec turbo run build typecheck --filter=...` for dependents: 19/21 tasks pass. The one
  failure is `@optimiq-voice/api#build` on `SsoProviderRow.clientSecret` /
  `listEnabledSsoProviders` in `apps/api/src/auth/*` — another agent's in-flight `@optimiq-voice/db`
  change, unrelated to these packages.
- `pnpm exec oxlint` on the five packages: one pre-existing `no-explicit-any` warning in
  `media-dtmf-recording.spec.ts`. `pnpm exec oxfmt`: clean.
