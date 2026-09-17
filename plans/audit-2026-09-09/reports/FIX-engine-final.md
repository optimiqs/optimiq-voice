# FIX — the final engine round (E2E-final2.md rows 4, 11, 12, 13, 14, 16)

Area: `apps/engine/src/calls`, `src/media`, `src/nats`, `src/queue`, and `apps/api/src/cdr` (writer only).
Nothing committed, staged or stashed. No service restarted. `apps/engine/src/routing`, `apps/api` pbx,
`apps/web` and `apps/sipd` read only throughout.

---

## 1. P1 — the variable allow-list ate four stamped variables — FIXED

`channel-orchestrator.service.ts`. The two halves are now derived from ONE array and the compiler
enforces it:

- new `ARRIVAL_VARIABLES` (11 names) + `ARRIVAL_VARIABLE_READS` (the 5 with a media-server read; the
  rest are inline-or-absent, which is the distinction `readEngineVariables` already documented).
- `readEngineVariables` iterates `ARRIVAL_VARIABLES` instead of its own 7-name literal.
- `invitedChannelSnapshot` builds `const variables: Record<ArrivalVariable, string | undefined>` and
  passes it through the existing `definedOnly`. **A name added to the array does not compile until it
  is stamped, and a stamped name is by construction a read name** — the two can no longer diverge.
  The conditional-spread absence semantics are preserved (`definedOnly` drops the holes), so
  `attestationOf` can still tell "no claim" from "a claim that said nothing".
- The stale doc comment ("every one of the FIVE variables") and `readEngineVariables`' "two entries
  have no `read`" paragraph updated to what is now true.

Tests (`channel-orchestrator.spec.ts`): a new case admits an INVITE carrying `deviceId` + a full
attestation and asserts all ten variables land on the KV snapshot; a second ends the leg and asserts
`sipAttestation`/`sipVerstat`/`sipOrigId` (and the Call-ID, below) on the `cdr.leg.write`.
`OPTIMIQ_DEVICE_ID` on the snapshot IS what `ControlledLeg.deviceId` returns, which is what the
walker's hot-desk precondition and the Ray Baum device on `call.emergency.dialed` read — both were
`undefined` for every endpoint there has ever been.

## 2. P1 — `sip_call_id` was never written (0 of 15 220 rows) — FIXED

- `cdr-leg.ts`: `CdrLegInput.sipCallId`, forwarded by `buildCdrLegWrite`, omitted (not nulled) on a
  leg with no dialog.
- `channel-orchestrator.service.ts` `writeCdr`: reads it off `OPTIMIQ_SIP_CALL_ID` through
  `normalizeSipCallId` — off the variable and not the dialog registry, so an adopted leg files the
  same value. `recordSipDialog` already stamps it on B-legs and masqueraded channels, so both sides
  of a call carry it.
- `apps/api/src/cdr/writer/cdr-leg-mapping.ts`: `sipCallId` added to `MAPPED_KEYS` and to
  `CallLegInsertValues`, mapped with a 256-char truncation (matching `normalizeSipCallId`'s ceiling;
  it only ever bites a foreign producer), written to the existing `call_legs.sip_call_id` column.

**No `packages/events` change was needed and none was made.** `cdrLegWriteDataSchema` is a
`z.looseObject` — the file says so and says why — so the key survives `makeCdrLegWriteEvent`,
`validateEvent` and the writer's `cdrEventSchema.parse` verbatim. Verified by round-tripping a real
envelope through `cdrEventSchema.parse`. If the reviewer wants it documented in the contract, adding
`sipCallId: z.string().max(256).nullish()` to `cdr-events.ts` is additive and behaviour-neutral —
listed under Cross-area needed.

Tests: `cdr-leg.spec.ts` (carried / omitted, payload still validates) and
`apps/api/test/cdr/cdrLegMapping.test.ts` (mapped, null, truncated, out of `raw`).

## 3. P1 — early media never relayed — FIXED (with the log line the audit asked for)

The 183 path is otherwise correct end to end — `sipd-event-mapping` carries `sdpAnswer` on the
`hasEarlyMedia` half, `SplitPlaneMediaPort.earlyMedia` allocates and `ring`s 183 with the body, the
latch is repeated by the later `answer`. The single silent short-circuit is
`relayEarlyMedia`'s `originatorOf(mediaChannelId) === undefined` return.

- **Second source for the originator.** The composite's `originatorChannelId` is stamped only inside
  `SplitPlaneMediaPort.originate`; a B-leg whose plane record was rebuilt without it (adoption,
  re-registration, a leg the port learned about after the originate) answers `undefined` and the
  caller silently gets nothing until the 200. `originatorFromLeg` now resolves the same fact from the
  B-leg aggregate's `OPTIMIQ_ORIGINATING_LEG_ID` — the field the CDR already assembles a fan-out
  with — through `registry.byDomainChannelId` back to the media channel. It survives a failover the
  port record does not.
- **The missing warn.** `"early media arrived on a leg with no known originator; the caller hears
ringback until answer"`. Its absence is why this needed a wire capture.

Tests: the existing "relays a callee's early media…" case still pins the happy path; a new case
originates WITHOUT `originatorChannelId` (asserting `originatorOf` is undefined), files the B-leg in
the registry the way `legHooksFor` does, and asserts the 183-with-body still reaches the A-leg.

**Honest limit**: I could not reproduce the live silence against the fakes — with
`originatorChannelId` set the existing spec has always passed — so this closes the one silent return
that fits the evidence (no 183, no log line, settle succeeded because the call bridged at the 200)
and instruments the other. If the next live round still shows nothing, the new warn names the leg.

## 4. P1 — `*5` never released the presser's leg — FIXED

`call-control.ts` `parkPeer`: after a park that actually took, `leg.markHangup("NORMAL_CLEARING")`
then `hangupQuietly(leg.mediaChannelId, "NORMAL_CLEARING")`. Only on success — a refusal leaves both
legs as they were, which is what lets the phone report "that lot is full" to somebody still on the
call. `markHangup` first for `completeTransfer`'s reason (the CDR cause is first-wins).

That is the whole of row 16's remaining half: the recall DID route to the parker; it landed in their
voicemail because their extension was still occupied by the leg they parked from.

Tests (`call-control.spec.ts`): the existing both-orientations case now also asserts
`hungUp() == [{presser, NORMAL_CLEARING}]`; a new case asserts a refused park hangs nobody up.

## 5. P1 — shared line: retrieve refused, recall ended hangup — FIXED

**Retrieve.** `retrieveSharedLine` called `refuseIfUnusable(leg, "shared-line retrieve")`, but a
second appearance retrieves by DIALLING the line, so the leg arrives from the walker's `shared-line`
node still ringing. Every retrieve there has ever been was refused _"the leg has not answered"_ and
the walk fell to its timeout branch. Now only the teardown half of that guard applies.

The leg is answered where it has to be — in `bridge`, which had the identical guard one layer down.
`bridge` now answers an unanswered member instead of refusing it: a ringing leg has no media session
on a split plane, so bridging IS the answer, and `pickup`/`monitor` already answer inline for exactly
this reason. Teardown and tenancy checks are unchanged and still first.

**Recall.** A shared-line hold is a phone re-INVITEing `sendonly` — nothing tears its dialog down —
so the appearance that held the line was still in the call when the timer fired, and routing the
caller at that appearance's extension dialled a number this very call was occupying. Exactly the park
shape. `recallSharedLine` now cuts the bridge-peer link both ways (so `endBridgePeer` does not follow
the teardown into the caller it is recalling) and releases the holder's leg `NORMAL_CLEARING` before
`routeTransferee`, so the recall reaches an idle extension.

Tests: retrieve from an unanswered appearance bridges and answers; the recall case asserts the
holder's leg is hung up, the caller's peer link is cut first, and the route still reaches `1001`.

Not fixed, and not mine: barge-in is still unimplemented (`plan-walker.ts` says so in a note).

## 6. P2 — queue callback: root cause found, one real engine defect fixed

**Root cause of "the agent never became reachable", and it is NOT an engine defect.**
`isEligibleForDistribution` reads the engine's `agent-state` KV entry, which is the only thing both
distribution and `QueueCallbackRunner.freeAgents()` consult. `PATCH /queue-agents/:id {status}` —
what the E2E used — writes the `queue_agent.status` COLUMN and nothing else;
`apps/api/src/pbx/queues/queue-agent-session.controller.ts` says so in its own header and gives
availability its own sub-resource: **`POST /queue-agents/:id/session/login | resume`** is what writes
the KV entry (`agent-state.publisher.ts`). The agent was never logged in, so `freeAgents()` returned
0, the runner skipped `no-agent`, and no `rpc.engine.v1.queue-callback` was ever published — which is
precisely why the control call did not ring either. Nothing in `apps/engine/src/queue` is wrong here.
Re-run with the session endpoints, or from the queue console.

**The real engine defect, fixed: `queueNumber` was never supplied.** `QueueCallbackScheduler.register`
accepts `options.queueNumber`, `QueueCallbackRunner` forwards it, and the ONLY caller —
`queue-session.ts:644` — passed three arguments. So `planQueueCallback` resolved the outbound route
with `from = ""`; a tenant whose outbound rules are gated on the queue's toll class matches nothing
and every promised callback is refused `invalid_target`. It is also where the answered customer is
put back. Fixed at the seam that has the artifact:

- `queueNumbersOf(artifact)` — queue id → number, scanned off `internal.numbers` (there is no
  `queueId -> number` index and no number on `QueuePlanNode`; same shape as `parkLots`).
- `queueCallbackPort(scheduler, numbers)` wraps the scheduler for the walk, so the ACD plane's
  three-argument `register` is untouched.
- `walkerFor`'s `extra` gains `queueNumbers`, passed by both call sites from the artifact they
  already hold — same pattern as `realm` and `prompts`.

Tests: the scheduler passes the number through to the dialler; `queueNumbersOf` indexes queues and
keeps one number per queue; the port fills the fourth argument in and leaves an unnumbered queue
alone. (`queueNumbersOf`/`queueCallbackPort` are exported for this.)

`GET /queues/:id/callbacks` (404) is an `apps/api` surface — not mine, still open.

## Cross-area needed

1. `packages/events/src/schemas/cdr-events.ts` — OPTIONAL: add
   `sipCallId: z.string().max(256).nullish()` beside the attestation trio so the contract documents a
   column that is now written. Behaviour-neutral (the schema is `looseObject`; the value already
   flows). Not made, per the brief.
2. `apps/engine/src/routing/plan-walker.ts` — the `shared-line` node's retrieve branch would be
   clearer calling `ensureAnswered()` before `lines.retrieve`. Not required now (call control answers
   the leg), listed so the walker's owner knows the precondition moved.
3. `apps/api` — no way to inspect a pending callback (`GET /queues/:id/callbacks`, 404), and
   `PATCH /queue-agents/:id {status}` reads like an availability control while only the
   `/session/*` sub-resource makes an agent reachable. That mismatch cost this round's row 12.
4. Still open and outside this brief: CLIR restricted (row 3, no field/column/feature code between
   the two implemented edges), blind transfer from the answering party (`apps/web`
   `jssip-adapter.ts` REFER `From`), attended-transfer CDR linkage.

## Additional fixes noticed in files touched

- `bridge` refused an unanswered PEER too, with the same message. Both members are now answered,
  which is the general form of what `pickup` does by hand.

## Verification (exact output)

- `apps/engine`: `tsc --noEmit` clean. `bun test` → **1865 pass, 26 skip, 0 fail**, 4198 expect(),
  82 files (was 1847/26/0 — +18 cases across `channel-orchestrator.spec.ts`, `cdr-leg.spec.ts`,
  `call-control.spec.ts`, `queue-callback.scheduler.spec.ts`).
- `apps/api`: `tsc --noEmit` clean. `pnpm run test` → **1453 passing, 0 failing** (was 1437 — +16,
  4 of them mine).
- `pnpm exec oxlint apps/engine/src/{calls,media,nats,queue} apps/api/src/cdr apps/api/test/cdr` →
  0 findings, exit 0.
- `pnpm exec oxfmt` on the same set → 159 files, no unrelated file rewritten.
- Contract round trip: a `cdr.leg.write` carrying `sipCallId` through `makeCdrLegWriteEvent` →
  JSON → `cdrEventSchema.parse` keeps the value.
