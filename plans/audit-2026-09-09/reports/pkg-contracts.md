# Audit — AREA: pkg-contracts

Scope read in full: `packages/events` (src/_, src/schemas/_, scripts/generate-go.ts, scripts/registry.ts,
scripts/go-emitter.ts, scripts/check-drift.sh, schema/index.json), `packages/events-go` (hand-written Go,
generated Go, parity_test.go, testdata/parity.json), `packages/config`, `packages/logging`,
`packages/effect-runtime`, `packages/identifiers`, `packages/runtime-go`. Cross-checked against
`config/nats.conf`, `apps/api/src/pbx/security/sip-acl.publisher.ts`, `apps/sipd/internal/acl/acl.go`,
`apps/sipd/internal/dialog/store.go`, `apps/sipd/internal/command/command.go`.

Counts: **2 P0, 4 P1, 7 P2.**

---

### [P0] Effect defect logging writes an unredacted `Cause` straight to pino (confidence: high)

- Where: `packages/effect-runtime/src/effect/run-effect.ts:56-57`
- Code:
  ```ts
  const ref = `err_${randomUUID().slice(0, 8)}`;
  getPinoLogger().error({ ref, cause: Cause.pretty(exit.cause) }, "unhandled effect failure");
  ```
- Problem: this is the process-wide pino instance, obtained directly. `packages/logging` applies redaction
  only inside `AppLogger.write` (`logger.ts:113-135`); `createPinoLogger` sets no `redact` option
  (`logger.ts:26-30`), so nothing between this call and the transport scrubs anything. `Cause.pretty`
  renders the full error chain including messages and stack frames — a `postgres://user:password@host`
  connection string from a pg driver error, a SIP digest from a credential-derivation failure, a caller's
  E.164 from a validation message, an `EventValidationError.message` (which `validationErrorFrom` builds by
  concatenating every issue message).
- Failure scenario / cost: any 500 on an Effect path writes tenant PII and, on a DSN/auth failure, a live
  secret into the log aggregator — the exact class of leak `redaction.ts` exists to prevent, on the one path
  that only fires when something has already gone wrong (so it is never exercised in the happy path).
- Fix: route through the redactor. Minimal:
  ```ts
  import { scrubSensitiveString } from "@optimiq-voice/logging";
  getPinoLogger().error(
  	{ ref, cause: scrubSensitiveString(Cause.pretty(exit.cause)) },
  	"unhandled effect failure",
  );
  ```
  Better: give `createPinoLogger` a `formatters.log` (or `hooks.logMethod`) that runs `redactLogValue`, so no
  caller can hold an unredacted handle.
- Cross-area: none (both files are in this area); the pino-level fix would also cover every other direct
  `getPinoLogger()` caller elsewhere in the repo.

### [P0] Every `Effect.log` annotation reaches pino unredacted (confidence: high)

- Where: `packages/effect-runtime/src/effect/observability.ts:44-52`
- Code:
  ```ts
  const fields: Record<string, unknown> = { ...output.annotations };
  ...
  if (output.cause !== undefined) { fields.cause = output.cause; }
  pino[toPinoLevel(output.level)](fields, formatMessage(output.message));
  ```
- Problem: same bypass as above, but on the _normal_ logging path rather than the defect path. Every
  `Effect.annotateLogs({...})` value — which is where a service naturally puts `callerNumber`, `email`,
  `aor`, `token` — is spread into the pino call verbatim, and `formatMessage` `JSON.stringify`s any non-string
  message part. `AppLogger` is the only thing in this package that redacts, and Effect code never goes through it.
- Failure scenario / cost: two logging front doors with different guarantees. A developer who correctly uses
  `AppLogger` in Nest and `Effect.logInfo` inside a service gets redaction in one and not the other, with no
  signal that the second is unsafe.
- Fix: `fields` → `requireUnknownRecord(redactLogValue(fields))` and
  `formatMessage(...)` → `scrubSensitiveString(formatMessage(...))`, or (preferred) do it once inside
  `createPinoLogger` so both this and `run-effect.ts` are covered by one change.
- Cross-area: none.

---

### [P1] `assertProductionNatsCredentials` accepts _any_ service pair, not the caller's own (confidence: high)

- Where: `packages/config/src/env-invariants.ts:196-201`
- Code:
  ```ts
  const hasServicePair = PER_SERVICE_NATS_PASSWORDS.some(
  	([passKey, userKey]) => isSet(config[passKey]) && isSet(config[userKey]),
  );
  if (hasServicePair) {
  	return;
  }
  ```
- Problem: the check is satisfied by the presence of _some_ pair anywhere in the environment. A production
  `OPTIMIQ_SERVICE=api` container that is handed `NATS_SIPD_USER`/`NATS_SIPD_PASS` (a shared secret bundle, a
  copy-pasted compose block, `APP_ENV_CONTENT` from a manager that ships all ten names) passes, and then
  `natsCredentials(env, "api")` finds no `NATS_API_*` pair, falls back to `NATS_USER`/`NATS_PASS` (unset) and
  returns `{}` — an _unauthenticated_ connection. The engine branch guards itself explicitly
  (`env-invariants.ts:270-272` requires `NATS_ENGINE_USER`/`PASS`); the api branch does not.
  The function's own doc-block states the failure this exists to prevent: "a production deployment that forgot
  the credentials would come up looking healthy with no events flowing at all — and a deployment that has not
  yet applied the config would come up connected to an OPEN broker, which is worse."
- Failure scenario / cost: a production api boots green, every publish and every `$JS.API.>` request is refused
  with `Authorization Violation` (logged, not fatal, per the doc), and the control plane silently stops writing
  `routing-cache` / `did-index` / `sip-acl`. Against a broker where `nats.conf` has not been applied it
  connects anonymously instead.
- Fix: check the pair belonging to `config.OPTIMIQ_SERVICE` rather than `.some()`:
  ```ts
  const own =
  	config.OPTIMIQ_SERVICE === "engine"
  		? (["NATS_ENGINE_PASS", "NATS_ENGINE_USER"] as const)
  		: (["NATS_API_PASS", "NATS_API_USER"] as const);
  if (isSet(config[own[0]]) && isSet(config[own[1]])) return;
  ```
  Keep the placeholder loop over all four (it is correct as-is).
- Cross-area: none. Deployments that today rely on the loose check would need their own pair or the shared pair.

### [P1] The codegen registry has no completeness assertion, so the drift gate cannot see an omission (confidence: high)

- Where: `packages/events/scripts/registry.ts:249` (`EVENT_ENTRIES`) and `:335` (`RPC_ENTRIES`)
- Code: `export const EVENT_ENTRIES: readonly EventEntry[] = [ callEntry("channel.created", …), … ]` — a
  hand-maintained array; nothing compares it against the `*_EVENT_DEFINITIONS` maps or `Object.keys(RPC_CONTRACTS)`.
- Problem: `check-drift.sh` only asserts that regenerating produces no `git diff` in `schema/` and `events-go/`.
  If a new event is added to `CALL_EVENT_DEFINITIONS` (or a new RPC to `RPC_CONTRACTS`) and the registry entry
  is forgotten, codegen emits _nothing new_, the diff is empty, and the gate reports "no drift". The Go package
  then has no struct, no `EventType…` constant, and `NewDataFor(type)` returns `nil` for it.
  (Verified both lists are complete _today_: 53 definitions / 53 entries, 37 `RPC_CONTRACTS` keys / 37
  `RPC_ENTRIES` — so this is a gate hole, not a present-tense omission.)
- Failure scenario / cost: the first event added after this audit that a Go consumer needs is silently absent;
  `apps/sipd`/`apps/mediad` drop it (`NewDataFor` → nil) and CI is green. That is precisely the failure
  §3.5's "CI checks cross-language drift" is meant to catch.
- Fix: add a throwing check at the top of `generate-go.ts` (or module scope of `registry.ts`):
  ```ts
  const declared = new Set(EVENT_ENTRIES.map((e) => e.type));
  for (const defs of ALL_EVENT_DEFINITIONS)
  	for (const type of Object.keys(defs))
  		if (!declared.has(type))
  			throw new Error(`registry.ts is missing EVENT_ENTRIES entry for ${type}`);
  const rpc = new Set(RPC_ENTRIES.map((e) => e.subject));
  for (const subject of Object.keys(RPC_CONTRACTS))
  	if (!rpc.has(subject))
  		throw new Error(`registry.ts is missing RPC_ENTRIES entry for ${subject}`);
  ```
- Cross-area: none.

### [P1] The parity golden covers 21 of 53 events and 0 of 37 RPC pairs (confidence: high)

- Where: `packages/events/scripts/generate-go.ts:675-1069` (`eventSamples()`), asserted by
  `packages/events-go/parity_test.go:639` (`TestParityEventSamples`)
- Code: `TestParityEventSamples` guards only `if len(g.EventSamples) == 0 { t.Fatal(...) }` — there is no
  assertion that every entry of `EventTypes` has a sample. `testdata/parity.json` carries
  `eventTypes: 53`, `eventSamples: 21`, and **no `rpc` section at all**.
- Problem: the round-trip proof (the "shape half of the parity proof", per the test's own comment) exercises
  21 payload structs. The other 32 event payloads and _all 74_ generated RPC request/response structs
  (`rpc_gen.go`, 3266 lines) are emitted but never decoded/re-encoded by any test. `TestParityEventTypeRegistry`
  only compares family/type strings and that `NewDataFor` is non-nil — it never touches a field.
- Failure scenario / cost: an emitter mistake on an unsampled type — a missing `json` tag, a value type where
  `needsPointer` should have produced `*T` (so `expiresInSeconds: 0` marshals as absent), a dropped
  passthrough key — ships undetected. On the RPC side that is a Go caller silently sending an incomplete
  `rpc.sip.v1.invite` request or losing a field of an `allocate-session` response, on the INVITE path.
- Fix: two surgical steps. (a) In `generate-go.ts`, derive samples for every `EVENT_ENTRIES` type instead of the
  hand-written `samples.push(...)` list, or at minimum add an assertion in `parity_test.go` that every
  `EventTypes` entry has a sample (`t.Errorf` naming the missing ones), so an unsampled type is a red test
  rather than an invisible one. (b) Add an `rpcSamples` section to the golden (one request + one response per
  subject, built from the same makers) and a `TestParityRPCSamples` mirroring `TestParityEventSamples`.
- Cross-area: none — both halves live in this area.

### [P1] `sip-acl` KV value has already drifted: writer emits `orgId`, Go reader expects `organizationId` (confidence: high)

- Where: TS writer `apps/api/src/pbx/security/sip-acl.publisher.ts:449-459` (`projectSipAclEntry`) against
  contract `packages/events/src/schemas/live-state.ts:520-537` (`sipAclEntrySchema`); Go reader
  `apps/sipd/internal/acl/acl.go:64-84`.
- Code:
  ```go
  type Record struct {
      ID             string `json:"id"`
      OrganizationID string `json:"organizationId"`
      ...
      Description string `json:"description,omitempty"`
  ```
  vs. `sipAclEntrySchema` = `{ network, orgId, action, scope, priority, trunkId?, name?, enabled, updatedAt }`.
- Problem: three concrete disagreements on the platform's **anti-toll-fraud boundary**: `orgId` vs
  `organizationId`, and `id` / `description` which the writer deliberately never emits (`readSipAclRows`
  explicitly excludes `description`). The Go doc comment states the cause: _"Neither packages/events nor
  packages/events-go defines the VALUE — there is no `sipAclEntrySchema`"_ — which is now false
  (`live-state.ts:520`), so the comment is stale and the struct was written against the database columns
  instead of the contract. Today the drift is inert only because `Record.Entry()` / `Record.Applies()` never
  read `OrganizationID`; it is one code change away from an ACL evaluator that thinks every entry belongs to
  the empty tenant. The same absence of a generated type applies to `sipDialogClaimSchema`,
  `extensionPresenceSchema` and `mediaSessionDirectoryEntrySchema` (the latter two hand-mirrored in
  `events-go/presence.go` and `media_sessions.go`; I verified those two currently match field-for-field).
- Failure scenario / cost: the KV value contracts most exposed to cross-language drift are the four with no
  generated Go type and no parity coverage; one of them is the boundary that decides whether an
  unauthenticated INVITE is admitted, and it has already drifted once without anything noticing.
- Fix: `schema/index.json`'s `liveState` registry carries exactly one entry (`trunks` →
  `TrunkDirectoryEntry`, `generate-go.ts:459`). Extend it with `sipAclEntrySchema`, `sipDialogClaimSchema`,
  `extensionPresenceSchema` and `mediaSessionDirectoryEntrySchema` so the emitter produces the Go structs, then
  delete `presence.go` / `media_sessions.go`'s hand-written mirrors and have `apps/sipd` use the generated
  types.
- Cross-area: **yes** — completing the fix requires `apps/sipd/internal/acl/acl.go` (and
  `internal/dialog/store.go`) to import the generated types; the field rename is a wire-visible change that must
  land with the writer.

---

### [P2] `SENSITIVE_LOG_PATTERN` matches substrings, so `sessionId` and `ipAddress` are blanked (confidence: high)

- Where: `packages/logging/src/redaction.ts:15`
- Code: `/(…|session|…|address|…)/i` tested with `SENSITIVE_LOG_PATTERN.test(key)` at `redaction.ts:151`.
- Problem: the test is an unanchored substring match against the whole key name. `sessionId`,
  `sessionCount`, `applicationSessionId`, `ipAddress`, `remoteAddress`, `emailVerified` and `didIndex` all
  match and become `[REDACTED]`. `sessionId` is a primary correlation key — e.g.
  `apps/engine/src/session/application-sessions.ts:214` logs `{ sessionId, legId, application }`.
- Failure scenario / cost: correlating an incident across api/engine logs by session id is impossible, and
  the redaction looks like it is working, so nobody investigates.
- Fix: keep the value scrubbers, but make the key test exact-ish: split the key into words with the same
  camel/kebab/snake splitter the emitter uses and match whole words, plus an explicit allowlist of
  `*Id`-suffixed identifiers (`sessionId`, `callId`, `legId`). Minimal version: `/(^|[_-])(session|address|did)([_-]|$)/i`
  for the ambiguous tokens, leaving `token|secret|password|…` as substrings.
- Cross-area: none.

### [P2] `parseSubject` cannot parse instance-addressed RPC subjects (confidence: high)

- Where: `packages/events/src/subjects.ts:1279`
- Code: `if (first === "rpc" && rest.length === 1) { return { kind: "rpc", … }; }`
- Problem: eight RPC subjects carry a variable tail — `rpc.sip.v1.ring.<tok>`, `.answer`, `.hangup`,
  `.reinvite`, `rpc.engine.v1.park-handoff|session-verb|conference-control.<tok>`,
  `rpc.session.v1.announce.<org>.<appTok>` (built by `subjectFor` at lines 906-975), plus
  `sipOriginateRpc(instanceId)` which optionally appends one. All of them return `undefined` here, so
  `parseSubjectOrThrow` throws `UnknownSubjectError` for a subject this package itself builds.
  `eventSchemaForSubject` is unaffected (it discards `rpc` anyway), so the blast radius today is diagnostic
  code and `generate-go.ts:1255`'s golden.
- Fix: `if (first === "rpc" && rest.length >= 1)` returning `{ service: second, method: rest[0], target: rest.slice(1).join(".") || undefined }`,
  and add `target` to the `rpc` arm of `ParsedSubject`. Regenerate the Go golden.
- Cross-area: regenerates `packages/events-go/subjects.go` + `testdata/parity.json` (both in this area).

### [P2] `engineRenegotiateRpc` sits under `sipInviteRpc`'s doc comment (confidence: high)

- Where: `packages/events/src/subjects.ts:886-893`
- Code:
  ```ts
  /** `rpc.sip.v1.invite` — flat, queue-grouped. See {@link RPC_SUBJECTS.sipInvite}. */
  engineRenegotiateRpc(instanceId: string): string { ... },

  sipInviteRpc(): string { return RPC_SUBJECTS.sipInvite; },
  ```
- Problem: the doc comment documents the wrong function, and `sipInviteRpc` — the admission subject, one of
  the most-read entries in the file — is left undocumented. In a file whose entire discipline is "the comment
  is the contract", this is the one place the comment lies.
- Fix: move the JSDoc onto `sipInviteRpc` and give `engineRenegotiateRpc` its own (it is instance-addressed,
  unlike everything the misplaced comment says).
- Cross-area: none.

### [P2] Zod `.default()` on a cross-language wire schema: Go's zero value is not the TS default (confidence: medium)

- Where: `packages/events/src/schemas/live-state.ts:528,534`
- Code: `priority: z.int().min(0).max(65_535).default(100)`, `enabled: z.boolean().default(true)`
- Problem: `.default()` is a TypeScript-decoder concept. A value written without `enabled` parses to `true`
  in TS and decodes to `false` in Go (`acl.go:83`), and `priority` absent is `100` in TS and `0` in Go — which
  `priorityOf` inverts into the _highest_-precedence rule. `projectSipAclEntry` happens to write both fields
  explicitly today, so nothing is broken now; the hazard is that the schema declares an absence-semantics the
  Go reader does not share.
- Failure scenario / cost: any future writer (a migration backfill, a partial CAS update) that omits `enabled`
  produces an entry TS believes is active and the edge silently ignores — a legitimate carrier refused, with
  both sides "correct" per their own decoder.
- Fix: on wire schemas that cross to Go, use `.optional()` with the default applied at the writer, or make the
  field required. At minimum, note the asymmetry in the schema comment and have the emitter refuse a `default`
  keyword rather than dropping it silently (`go-emitter.ts` currently ignores `default` entirely).
- Cross-area: `apps/sipd/internal/acl/acl.go` if the field is made required.

### [P2] `EventValidationError.issues` carries the whole payload on the cross-check path (confidence: high)

- Where: `packages/events/src/validate.ts:132-135`, against the doc at `packages/events/src/errors.ts:34`
- Code:
  ```ts
  new z.ZodError([
  	{ code: "custom", path: [mismatch.path], message: mismatch.message, input: payload },
  ]);
  ```
- Problem: `errors.ts:34` documents `summary` as "safe to log without dumping the payload", and the class
  exposes `issues` publicly. On the subject/orgId cross-check path the single issue's `input` **is** the whole
  event envelope — caller number, callee number, AOR, SIP headers. A consumer that logs the error object
  (rather than `.summary`) dumps a full call event, and `redactLogValue`'s `MAX_REDACTION_DEPTH = 6` may
  truncate before reaching nested payload fields.
- Fix: drop `input` from the synthetic issue (it adds nothing — the message already names both subjects), or
  set it to `{ subject, orgId }`.
- Cross-area: none.

### [P2] `getEnvEntries()` is dead and would return `APP_ENV_CONTENT` verbatim (confidence: high)

- Where: `packages/config/src/env.ts:288-292`, exported at `index.ts:1`
- Code: `return Object.entries(envSource).filter((entry): entry is [string, string] => typeof entry[1] === "string");`
- Problem: no production caller (only `env.spec.ts:55`). It returns the _entire_ process environment snapshot,
  including `APP_ENV_CONTENT` — the whole secret bundle from the secret manager as a single string, and every
  `NATS_*_PASS` / `AUTH_SECRET`. An exported helper shaped like "dump the env" on a platform whose logger
  redacts by key name is a leak waiting for its first caller.
- Fix: delete it, or have it exclude `APP_ENV_CONTENT` and every key matching the logging package's sensitive
  pattern.
- Cross-area: none.

### [P2] `isStreamNotFoundError` falls back to a message regex (confidence: medium)

- Where: `packages/events/src/streams.ts:427`
- Code: `return /not found/i.test(String((error as { message?: unknown }).message ?? ""));`
- Problem: after the two precise `api_error` checks, any error whose message merely contains "not found" —
  a DNS failure, a `consumer not found`, a bad `KV_<bucket>` name — is treated as "the stream is absent".
  In `ensureStreams` that turns into `streams.add(...)` on a stream that exists; in `ensureKvBuckets`
  (`streams.ts:1029-1036`) it reports `created: true` for a bucket that was already there, which is the
  operator-facing signal the function exists to produce.
- Fix: drop the regex fallback (both `err_code: 10059` and `code: 404` are stable across the client versions
  in `catalog:`), or narrow it to `/stream not found/i`.
- Cross-area: none.

---

## Verified and dropped (checked, not findings)

- **Go type coverage is complete.** Every `goType` / `goRequestType` / `goResponseType` in `schema/index.json`
  (53 events, 37 RPC pairs, 1 live-state) resolves to a declared type in `packages/events-go`. No missing types.
- **Registry completeness holds today.** 53 event definitions ↔ 53 `EVENT_ENTRIES`; 37 `RPC_CONTRACTS` keys ↔
  37 `RPC_ENTRIES`; 37 `RPC_SUBJECTS` keys all present in `RPC_CONTRACTS`.
- **Codegen is deterministic.** No `Date.now`, `Math.random`, `randomUUID` or unordered-set iteration anywhere
  in `generate-go.ts` / `registry.ts` / `go-emitter.ts`; the only sort (`go-emitter.ts:204`) is on import paths.
- **`sipOriginateRpc(instanceId)` is not a dead subject.** `apps/sipd/internal/command/command.go:170-171`
  subscribes both the flat queue-grouped subject and the instance-addressed one.
- **`sipDialogClaimSchema` ↔ `apps/sipd/internal/dialog/store.go:277-298` match field-for-field**, as do
  `extensionPresenceSchema`/`presence.go` and `mediaSessionDirectoryEntrySchema`/`media_sessions.go`.
- **No per-message validator compilation.** Every Zod schema is a module-level constant; `validateEvent`
  selects one by subject and calls `safeParse`. `anyEventSchema` (a 10-way non-discriminated union that would
  be expensive on failure) is exported but has no production caller.
- **`matchesSubject` (`subjects.ts:1345`) implements NATS semantics correctly** for `*` (exactly one token) and
  `>` (one or more, final position only), including the trailing length equality.
- **Stream/KV definitions are internally consistent**: `discard: "new"` on the three ledgers (CDR, AUDIT,
  VOICEMAIL) and `"old"` elsewhere, `ttlMs: 0` on the four configuration buckets, `duplicateWindowMs` widened
  to 10 min only on CDR and VOICEMAIL. `assertStreamCompatible` guards exactly the two immutable fields
  (retention, storage). `kvOptionsFor` passes `ttl` in millis, which is what the `nats` KV client expects.
- **`SIP_STREAM`, `SIP_ACL_KV`, `TRUNKS_KV`, `SIP_DIALOGS_KV`, `SHARED_LINE_STATE_KV` are absent from
  `src/index.ts`'s export list** but reachable via the `./streams` subpath export, which is how every consumer
  imports them. Inconsistent, not broken — not reported.
- **`makeRuntime`'s shared `MemoMap`** (`effect-runtime/src/effect/memo-map.ts`) is refcounted by Effect, and
  `module-runtime.spec.ts` covers the double-dispose and concurrent-dispose paths. No fiber or layer leak found.
- **`natsCredentials` half-pair handling** (`nats-credentials.ts:158-176`) correctly throws per pair rather than
  falling back to the admin identity.
