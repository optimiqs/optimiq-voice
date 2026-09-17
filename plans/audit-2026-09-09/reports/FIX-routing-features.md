# FIX — AREA = routing features

Run: 2026-09-09 21:00–22:10 UTC against the standing stack (`STACK.md`). `apps/api` was restarted
(migrations applied first); `apps/engine` was **not** — every engine change below is listed under
"Needs an engine restart".

Two briefs landed on this area. The coordinator's five `E2E-routing2.md` items are in priority order
first; my original four follow. What is unfinished is named exactly, at the end.

---

## Coordinator item 1 — IVR direct extension dial: DONE

The compiler already expressed `directDialEnabled`; the ENGINE refused it. `plan-walker.ts:3030`
read the flag, wrote a note saying it "needs an internal resolve the walker cannot make yet", and
fell into the invalid branch. That resolve was already in the file: `extensionNodeFor` is the
artifact-wide `number -> extension node` index that call screening and `*69` share.

- **`apps/engine/src/routing/plan-walker.ts`** — `ivrMenuNode` takes `input`, matches an option
  first, then the extension directory, then invalid. One added lookup, no new port.
- **The `maxDigits` half, which is the part that made it look unimplementable.** A menu of
  single-digit options is configured `maxDigits: 1`, and a collection capped at one digit is over
  before the second digit of `1104` exists — exactly the limit `FIX-ivr-dtmf.md` H-3 recorded as a
  product failure. The walker now gathers `max(node.maxDigits, node.directDialMaxDigits ?? 0)`, and
  the inter-digit timeout separates the two intents.
- **`packages/routing/src/plan.ts`** — new OPTIONAL `IvrMenuPlanNode.directDialMaxDigits`, the
  longest extension number in the artifact. Optional, so a reader compiled before it ignores it and
  behaves exactly as it did — not an artifact version bump.
- **Compiler diagnostics** (`compile.ts` `directDialDigits`, `diagnostics.ts`): two new codes.
  `ivr-direct-dial-ambiguous` names each digit option that an extension number starts with — and
  says separately when the option IS an extension number, which makes that extension unreachable by
  direct dial. `ivr-direct-dial-empty` covers direct dial on an org with no extension. A regex
  option is deliberately not judged: what it would shadow is not decidable from the pattern.
- Tests: `compile.spec.ts` "compile — IVR direct dial" (7), `plan-walker.spec.ts` "direct dial" (6).
  `scenario.spec.ts`'s "compiles cleanly" now asserts the one warning Acme legitimately earns rather
  than an empty list — its main menu offers `1` and every Acme extension is `1xxx`.
- UI: `ivr-menu-dialog.tsx` — the three fields already existed; they now carry help text saying what
  the inter-digit timeout decides and that direct dial is not capped by `maxDigits`.

**Live** (compile-on-write against the running tenant):
`ivr-direct-dial-ambiguous: IVR menu "RT Main" has an option "1" that 11 extension numbers start with; a caller who wants the option waits 2000ms before it is taken.`
The walk itself needs the engine restart.

---

## Coordinator item 2 — `*65` / `*64` reach nothing: DONE (one cross-area line outstanding)

Confirmed: `reportToggleCodeCollisions` only CHECKED those codes for collisions. Nothing ever made
them dialable — they cannot live in `internal.numbers` (a `*` key is read as an extension number)
and they were never in `internal.featureCodes`.

- **`packages/routing`** — two actions added to `FEATURE_CODE_ACTIONS`, `call-flow-toggle` and
  `time-condition-override`, argument mode `none`. Deliberately NOT added to `pbx-db`'s list: no
  `feature_code` ROW may carry them, because each code lives on the entity it acts on. `compile.ts`
  `compileToggleCodes` synthesises one `CompiledFeatureCode` per enabled flow with a code and per
  enabled condition with an override code, pinning the entity id into `params` and minting a
  `feature-code:<call-flow|time-condition>:<id>` node. `reportToggleCodeCollisions` now checks
  against the CATALOGUE only, so a toggle code is not reported as colliding with the entry compiled
  from it, while a real feature code that would swallow it is still a hard error.
- **`packages/events`** — new subject `rpc.pbx.v1.toggle-feature` + `TOGGLE_FEATURE_RPC`. Its own
  subject rather than a sixth `extensionFeatureSchema` member: one changes a column on the caller's
  own extension, the other changes what every caller to the tenant hears, and they must be
  separately grantable at the broker. `scripts/registry.ts` + codegen run.
- **`apps/api/src/pbx/call-flows/`** — `toggle-feature.service.ts` (reads the row under RLS, cycles
  it, writes through `PbxRepository.update` with `serviceActor("engine.feature-code")` so
  compile-on-write runs in the same transaction, publishes the BLF lamp after the commit) and
  `toggle-feature-rpc.controller.ts` (every path replies; a timeout would leave a receptionist
  believing the office is closed). Declared in `pbx.module.ts`.
- **`apps/engine/src/routing/`** — `toggle-feature.source.ts` (the RPC port) and the walker's
  `toggleCode` handler, with `ToggleFeaturePort` / `ToggleFeatureChange` / `ToggleFeatureOutcome`.
  A caller with NO number can press it: a lobby phone with caller id suppressed is exactly the
  handset a night-mode key is provisioned on.
- Tests: `compile.spec.ts` "the entity toggle codes" (6), `plan-walker-features.spec.ts`
  "*65 / *64" (8).

**Live** — `POST /api/v1/routing/simulate`, `internal`:

```
*65 -> matched:true  destinationType:"feature-code"  entryNodeId:"feature-code:call-flow:01a08827-9781-…"
*64 -> matched:true  destinationType:"feature-code"  entryNodeId:"feature-code:time-condition:01a08827-bc18-…"
```

Both previously fell through to "no outbound route matched".

---

## Coordinator item 3 — `*81` with a pinned `params.groupId`: DONE

`argumentMode` came from a static per-action table, so a `paging` code read as `required` and
`matchFeatureCode` skipped it when dialled bare.

- **`packages/routing/src/feature-codes.ts`** — new `featureCodeArgumentMode(action, params)` and a
  `FEATURE_CODE_PINNED_ARGUMENT` table with exactly one entry (`paging: "groupId"`). `call-park` is
  deliberately absent: `params.lotId` pins the lot and the argument selects an orbit inside it, so
  both are meaningful at once. `compile.ts` uses it in place of the raw table lookup.
- Tests: `feature-codes.spec.ts` "featureCodeArgumentMode" (4).

**Live**: `*81` bare, group pinned → `matched:true`, `destinationType:"feature-code"`.

---

## Coordinator item 4 — `DEFAULT_FEATURE_CODES` imported by no production code: DONE

- **`apps/api/src/pbx/feature-codes/feature-codes.service.ts`** — `seedDefaults(session)`, idempotent
  by CODE (a code the org already holds is left exactly as it is, including one repointed,
  relabelled or disabled — re-seeding must never undo a tenant's decision). Every write goes through
  the ordinary repository path, so each row carries the same audit actor, tenant guard and
  compile-on-write a hand-created code does.
- **`feature-codes.controller.ts`** — `POST /api/v1/feature-codes/defaults`, `feature-codes.write`.

**Live**: first call created all twenty (`*97 … *43`); second created none and skipped twenty.

**Not done, and it is a cross-area line:** invoking it AT organization creation. Organizations are
created by better-auth's own endpoints (`packages/auth/src/auth.ts:489`, the `organization()`
plugin) and this area has no org-create seam. The hook is
`organization({ organizationCreation: { afterCreate: … } })` in `packages/auth`, calling the endpoint
above or the service directly. Until then a new org needs one POST.

---

## Coordinator item 5 — shared lines answered "not implemented yet": DONE for the walk half

The cast was the cause, not a formality. `const unreachable = node as { kind: string }` in the node
switch's `default` arm defeated the exhaustiveness check, so `shared-line` sat in that arm for a
release while `shared-line-registry.ts` was finished and tested.

- **`plan-walker.ts`** — the cast is gone; the arm now reads the kind through `node satisfies never`,
  so a node kind added to `packages/routing` and not to this switch is a compile error. The arm
  survives only for an artifact from a NEWER release than the binary.
- **`sharedLineNode`** — fans out to every appearance like a ring group, then does the thing a ring
  group cannot: the appearance that answered SEIZES the line through the registry's compare-and-set.
  An appearance that answers and loses the seizure is hung up rather than bridged (bridging it would
  put two callers on one line — the exact split the registry exists to prevent) and the caller gets
  `USER_BUSY`. Barge-in off refuses an already-seized line before anything rings. A seizure this walk
  took and could not turn into a bridge is given back.
- **`SharedLinePort`** on the walker deps — the two operations a WALK can perform. Hold, retrieve and
  recall are deliberately absent because they are mid-call.
- **`shared-line-registry.ts`** — new `releaseOwn(orgId, sharedLineId)`, so a walk does not have to
  be told which instance it is.
- Tests: `plan-walker.spec.ts` "shared lines" (7).

**What is still missing, precisely.** Hold, retrieve-from-another-appearance and the hold-recall
re-ring are mid-call: they happen after the walk has handed the call to the orchestrator, on
`hold`/`unhold` events it owns. `SharedLineRegistry.hold`, `armRecall` and `cancelRecall` are
written and tested for exactly that; the seam is one subscription in `apps/engine/src/calls`, which
is not my area. The same file owns the seizure RELEASE on call end. Barging into an existing call is
also a `call-control.ts` operation; a barge-in-enabled line currently rings the appearances as a new
call and the walk says so in its notes.

---

## My item 1 — IVR direct dial with inter-digit timeout

Same as coordinator item 1 above. UI fields already existed; help text and compiler diagnostics added.

## My item 4 — E.164 assertion in `packages/routing`: DONE

`packages/routing` compared numbers as opaque strings: `didDefaults` is keyed by the DID's `e164`, an
inbound rule bound to one number compares it with `===`, the ELIN is whichever spelling came out of
the row. One DID stored `0044…` and presented `+44…` is an inbound route that never fires.

- **`packages/routing/src/e164-ingest.ts`** (new) — `ingestE164` for a field that IS a phone number,
  `ingestDialTarget` for a DIAL STRING. The second is the load-bearing distinction: an external
  target is matched against outbound patterns written the way a handset dials (`NXXNXXXXXX`,
  `9`-prefixed, a bare extension), so it canonicalises ONLY a target that already declares itself
  international (`+`, `00`, `011`) and leaves everything else exactly as written. Neither ever drops
  a value — an unreadable one is compiled verbatim with a diagnostic, because refusing the compile
  would take every working call in the tenant down over one row.
- **Applied at INGESTION, once each**: DIDs and trunk caller-id overrides in `index()` (so the four
  places that read a DID cannot disagree, and a bad trunk override is not reported once per route
  naming the trunk); extension caller id, outbound-route caller-id override, `settings
.outboundCallerIdNumber`, external destinations, forward destinations and follow-me hops at their
  compile sites.
- **`non-e164-number`** diagnostic, a warning for the same reason `invalid-queue-priority` is.
- **`RoutingSettingsInput.defaultCallingCode`** + the `defaultCallingCode` org setting
  (`org-settings.catalog.ts`, `snapshot-loader.ts`) — what lets a bare national number be
  canonicalised at all. Absent means it is REPORTED rather than guessed, which is the safe half:
  guessing `+1` would point a British tenant's routing at Manhattan.
- Tests: `e164-ingest.spec.ts` (18, unit + through the compiler).

**Live**: the tenant's compile carries no `non-e164-number` diagnostic — its one DID
(`+15005550161`) was already canonical, which is the correct no-op.

## My item 2 — queue callback / virtual hold: CONFIG + CALLER HALF DONE, DIALLER NOT WIRED

The design is that a callback token IS a resume tombstone with one extra block. That is not a
shortcut: a caller who rings back before the system reaches them claims their own token through the
ordinary `join`, in the compare-and-set that deletes it — so "we never call somebody who is already
back in the line" is a property of the data structure rather than a check somebody has to remember.

Done and tested:

- **`packages/pbx-db`** — eight `queue` columns + `queue_callback_key_shape_check`; migration
  `20260909212339_pbx_queue_callback`, **applied to the running stack**.
- **`packages/events`** — optional `callback` block on `queueResumeTombstoneSchema`; `"callback"`
  added to `queueCallerAbandonedDataSchema.reason` and to `cdrLegWrite`'s `queueOutcome`.
- **`packages/cdr-db`** — `"callback"` in `QUEUE_OUTCOMES`; migration
  `20260909212559_cdr_queue_callback_outcome`, applied.
- **`packages/routing`** — `QueueCallbackPlan` on `QueuePlanNode` (one optional sub-object, because
  the nine fields are only meaningful together and a reader that has to check a boolean before
  trusting the other eight has a shape that can lie); `queueCallback()` compiles and CLAMPS every
  bound; `queue-callback-unusable` warns when the accept key is not a DTMF digit, is already the exit
  key (the exit key keeps it), or there is neither a key nor a wait to announce it after.
- **`apps/engine/src/queue/queue-waiting.ts`** — `dueCallbacks` (ordered by the line's own
  comparator) and `deferCallback` (records an attempt, DROPS the token when they are spent — a place
  held for a number nobody will call again is a slot the queue counts and never fills).
- **`queue-session.ts`** — one digit polled per pass and dispatched to the exit key or the callback
  key (`pollDigit` consumes, so asking twice would let the exit key eat the callback's digit); the
  offer announced once at `offerAfterSeconds`; accept refused for a caller with no number; new
  `callback` outcome; `leaveLine` writes the token.
- **`plan-walker.ts`** — `callback` maps to `NORMAL_CLEARING` (there is nowhere to route somebody who
  has agreed to hang up) and reports `"callback"` to the CDR.
- **`queue-callback.ts`** (new) — `QueueCallbackRunner` with an explicit `tick()`, gated on the same
  `isEligibleForDistribution` the distribution loop uses, placing at most one callback per free
  agent (dialling five people back into a queue with one free agent recreates the queue on the
  customers' phones).
- API DTO + snapshot loader + web form (`Callback (virtual hold)` section) + contracts.
- Tests: `compile.spec.ts` (7), `queue-waiting.spec.ts` (7), `queue-session.spec.ts` (9),
  `queue-callback.spec.ts` (8), `schemas.spec.ts` (3).

**Not done:** the `QueueCallbackDialer` has no concrete implementation and the runner is not on a
timer. The engine cannot mint an A-leg from anywhere I own: `WalkerCallControl.dial` re-routes the
existing leg, `CallControlPort.dial` makes a B-leg, and the only "create a call" surface is
`rpc.engine.v1.originate` — whose request is `{fromExtension, to}`, i.e. an EXTENSION placing a call,
not a queue calling a customer back. See "Cross-area needed". Until that lands, a queue with
`callbackEnabled` promises a call nothing places, which is why the column defaults to `false` and the
compiler warns on every unusable configuration.

**Live**: the columns persist through the API, and the exit/callback clash warning fires on the real
tenant —
`queue-callback-unusable: Queue "RT Queue" uses "2" for both its exit key and its callback offer; the exit key keeps it and the callback compiled with no key.`

## My item 3 — hot desking: NOT STARTED

Displaced by the coordinator's five items, which were given as priority order. Nothing was written,
so there is no half-built surface to unpick. The map is in this session's transcript; the shape it
would take:

1. `device_line.extension_id` is the binding (`packages/pbx-db/src/schema/devices-schema.ts:239`).
2. A `hot-desk-login` / `hot-desk-logout` feature-code action, in `FEATURE_CODE_ACTIONS` on both
   sides plus `FEATURE_CODE_ARGUMENT_MODE`, with a PIN gather modelled on `challengeOutboundPin`
   (`plan-walker.ts:4275`) verifying against `pinSetEntry.pinHash` with `verifyPinDigest`.
3. A `rpc.pbx.v1.hot-desk` responder — the shape `toggle-feature` now has, which is the template.
4. **The blocker to state up front:** the engine has NO device identity on a walk. `PlanWalker` sees
   `callerIdNumber`, `organizationId`, `callId`. The AOR/device is known to sipd
   (`kv.Binding.DeviceID`), so plumbing device identity onto the walk input is a prerequisite and it
   crosses into `apps/engine/src/calls` and `apps/sipd`.
5. **Cross-area consequences that must be decided before any of it:** `sip-credentials.service.ts:422`
   resolves a registration by `coalesce(device_line.auth_user, extension.number)`, and the secret is
   `extension.sipSecretRef ?? line.sipSecretRef`. Swapping `extension_id` therefore changes either the
   digest username (when `auth_user` is NULL) or the HA1 (when it is pinned) — so the phone must
   re-provision and re-REGISTER, sipd's cached credential must be invalidated
   (`sip-credentials.responder.ts:335`), and the live `kv.Binding.ExtensionID` for the AOR is stale
   until it does. Also: `device`/`device_line` are absent from `ROUTING_TABLE_TO_ENTITY`
   (`cache.ts:157`), so a binding write triggers no recompile today.

---

## Cross-area needed

1. **`apps/engine/src/calls/channel-orchestrator.service.ts`** — two lines, and without them two of
   the fixes above announce "not available" at runtime:
   - inject `ToggleFeatureRpcPort` and pass `toggles: this.toggles` beside `features:` (line ~1491);
   - inject `SharedLineRegistry` and pass `sharedLines: this.sharedLines` beside `conferences:`
     (line ~1517). The registry is already exported from `RoutingModule`.
2. **`apps/engine/src/calls`** — the shared line's mid-call half: subscribe hold/unhold to
   `SharedLineRegistry.hold` / `armRecall` / `cancelRecall`, and `releaseOwn` on call end.
3. **The queue-callback dialler.** Either a `fromQueue` variant of `originateRequestSchema`
   (`packages/events/src/schemas/rpc.ts:2982`) carrying `{orgId, queueId, to, callerIdNumber?}`, or a
   sibling subject. `planOriginate` (`apps/engine/src/calls/originate-plan.ts:59`) is where the
   caller-id policy would have to answer a third question: a callback presents the QUEUE's identity,
   not the original caller's. Then a `QueueCallbackDialer` over it and a tick in `queue.module.ts`.
4. **`packages/auth/src/auth.ts:489`** — an `organizationCreation.afterCreate` hook to seed the
   default feature codes at org creation.
5. **CDR leg linking for a callback.** `call_legs` links legs within one `call_id`
   (`originatingLegId`, `bridgeLegId`); nothing links two CALLS. A callback is a new `call_id`, so
   relating it to the original queued call needs either a `related_call_id` column or a deliberate
   `call_id` reuse. Not decided here; the token carries enough to do either.

**Shared packages I did touch, additively, because the features are impossible without them:**
`packages/events` (one subject, one RPC pair, one optional KV field, two enum members + codegen),
`packages/pbx-db` (eight queue columns + one migration), `packages/cdr-db` (one enum member + one
migration). `pnpm --filter @optimiq-voice/events run codegen` also picked up other agents' pending
zod changes into `packages/events/schema/**` and `packages/events-go/*_gen.go` — that is the
generated artifact catching up with source, but it means those files carry more than my diff.

---

## Verification

| Check                                                                               | Result                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/routing run typecheck`                                | pass                                                                      |
| `pnpm --filter @optimiq-voice/routing run test`                                     | **914 pass, 0 fail**, 2137 expect(), 23 files                             |
| `pnpm exec turbo run build --filter=...@optimiq-voice/routing`                      | 16 successful, 16 total                                                   |
| `pnpm --filter @optimiq-voice/engine run typecheck`                                 | pass                                                                      |
| `pnpm --filter @optimiq-voice/engine run test`                                      | **1790 pass, 12 skip, 0 fail**, 4031 expect(), 79 files                   |
| `pnpm --filter @optimiq-voice/api run typecheck`                                    | pass (both tsconfigs)                                                     |
| `pnpm --filter @optimiq-voice/api run test`                                         | **1414 passing, 0 failing**                                               |
| `pnpm --filter @optimiq-voice/web run typecheck`                                    | pass                                                                      |
| `pnpm --filter @optimiq-voice/web run test`                                         | **864 pass, 0 fail**, 2764 expect(), 42 files                             |
| `pnpm --filter @optimiq-voice/events run test`                                      | 400 pass, 12 skip, 0 fail                                                 |
| `pnpm --filter @optimiq-voice/telephony run test`                                   | 259 pass, 0 fail                                                          |
| `pnpm --filter @optimiq-voice/pbx-db run test`                                      | 122 ran, 14 skip, 0 fail                                                  |
| `pnpm --filter @optimiq-voice/cdr-db run test`                                      | 110 ran, 35 skip, 0 fail                                                  |
| `pnpm --filter @optimiq-voice/pbx-db run db:check` / `cdr-db`                       | "Everything's fine"                                                       |
| `pnpm exec oxlint` (routing, telephony, engine routing+queue, api pbx, web lib/pbx) | exit 0                                                                    |
| `pnpm exec oxfmt` (same + events, pbx-db, cdr-db, web queues/ivr)                   | clean, 545 files                                                          |
| live                                                                                | `<scratchpad>/e2e/routing/features.mjs` — see the PASS lines quoted above |

Nothing was committed, staged or stashed.

## Needs an engine restart to verify

Every engine change is compiled and unit-tested but not live. In one list:

1. `plan-walker.ts` — IVR direct dial + the widened gather (item 1).
2. `plan-walker.ts` + `toggle-feature.source.ts` + `routing.module.ts` — `*65` / `*64` (item 2).
   **Also needs the orchestrator line in "Cross-area needed" #1**, or the code announces
   "no toggle port".
3. `plan-walker.ts` + `shared-line-registry.ts` — the shared-line node (item 5). **Also needs
   cross-area #1.**
4. `queue-session.ts`, `queue-waiting.ts`, `queue-callback.ts`, `queue-event-publisher.service.ts` —
   virtual hold's caller half.

`apps/api` is already restarted and live; `apps/web` is `next dev` and hot-reloaded. Both database
migrations are applied to the running Postgres.

## Notes for the reviewer

- The `directDialMaxDigits` field is the one place I extended the compiler for item 1, which the
  coordinator asked me not to re-design. I judged it necessary rather than cosmetic: without it the
  engine cannot honour `directDialEnabled` on a `maxDigits: 1` menu at all, which is every menu of
  single-digit options. It is an optional field, so no version bump and no behaviour change for a
  menu that does not use direct dial.
- `scenario.spec.ts`'s "compiles cleanly" assertion changed from "no diagnostics" to "exactly the
  direct-dial prefix warning". That warning is the feature working on a fixture that genuinely has
  the collision; asserting it is what keeps it from being lost in a later change.
- The one behaviour I changed without being asked: the queue session used to `pollDigit()` and
  discard a digit that was not the exit key, while its comment claimed non-exit digits were "left in
  the leg's buffer". The comment was wrong and the discard was real. It now polls once per pass and
  dispatches, which is both what the comment said and what two keys require.
