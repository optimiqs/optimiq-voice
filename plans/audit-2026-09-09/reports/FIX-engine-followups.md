# FIX — AREA=engine-followups

Area: `apps/engine` only. No git state touched, no service restarted, no `packages/*`, `apps/api`,
`apps/sipd` or `apps/web` file edited.

## 1. CDR disposition — an unanswered leg filed as `answered` (E2E-calling P1-C, E2E-records F3)

**FIXED — `apps/engine/src/calls/cdr-leg.ts`.**

The remaining path is not an ordering race at all; it is `dispositionFor` itself. The records agent
fixed one _producer_ of the wrong cause (a refused originate now gets `USER_NOT_REGISTERED`), but the
classifier still turned `NORMAL_CLEARING` on a leg with `answeredAt IS NULL` into `answered` via
`isAnsweredCause`. Every other way a leg dies unanswered ends up there too — a simultaneous-ring
loser the media server cleared, a caller who cancelled, a leg the edge tore down when the race was
settled — because the engine's cause is first-wins and any of those can lose the race to the
teardown's generic clearing. So the number of producers is unbounded and the classifier is the only
place a fix holds.

`dispositionFor` now derives the outcome from the ANSWER STATE first and from the cause second, and
an unanswered leg can no longer be `answered` whatever the cause says:

- `answeredAt` present → `answered`.
- `USER_BUSY` → `busy`.
- `NORMAL_CLEARING`, `NO_ANSWER`, `NO_USER_RESPONSE`, `ORIGINATOR_CANCEL`, `LOSE_RACE`,
  `SUBSCRIBER_ABSENT`, `ALLOTTED_TIMEOUT`, `PROGRESS_TIMEOUT`, `PICKED_OFF`, `NO_PICKUP` → `no-answer`.
- everything else (`CALL_REJECTED`, `USER_NOT_REGISTERED`, gateway/transport) → `failed`.

`ANSWERED_HANGUP_CAUSES` in `packages/telephony` is left alone: it is a reconciliation heuristic for
records the engine did not write, and it is no longer a source of dispositions.

Tests: `calls/cdr-leg.spec.ts` — the loser/cancel/timeout/clearing set can never be `answered`; the
no-answer set; refusal and unreachable are `failed`. The old case that asserted the opposite
("recovers an answered leg whose answer instant was lost") asserted the wrong thing and is replaced.
20 pass.

Also corrected the now-stale comments in `plan-walker.ts#originate` and its spec that justified the
`USER_NOT_REGISTERED` fix by "`dispositionFor` reads `NORMAL_CLEARING` as answered". The fix stays —
its real justification is that the not-registered BRANCH of an extension can only be taken if the
cause says so — but the reasoning no longer holds and would have misled the next reader.

### `ring_group_ref` (E2E-routing P2-1) — NOT fixable inside this area

The engine already knows the group: `planDestinationOf` returns `destinationRef = ringGroupId` and it
is mirrored onto every leg (`OPTIMIQ_DESTINATION_REF`) and written to `call_legs.destination_ref`.
The dedicated `ring_group_ref` column is populated by nothing: `cdrLegWriteDataSchema`
(`packages/events`) has no such field and `apps/api/src/cdr/writer/cdr-leg-mapping.ts` never maps
one. See "Cross-area needed".

## 2. A busy callee relayed as 480 (E2E-calling P1-F)

**FIXED — `apps/engine/src/routing/plan-walker.ts`.**

sipd's `StatusForCause` is correct (17 → `486 Busy Here`; its `default` is 480), and `settleDial`
routes `USER_BUSY` correctly. The engine was simply sending the wrong cause. In `dialSimultaneous`
— which every on-net extension dial goes through, because `dialOne` delegates to it whenever the AOR
has to be resolved to contacts — the race kept `lastCause` as the LAST cause to arrive. An extension
with a stale registration beside a live one (E2E-calling finding D: closed browser tabs) produces one
cause per contact: the busy phone answers `486`, and the dead contact fails a moment later with
`USER_NOT_REGISTERED` / `SUBSCRIBER_ABSENT`. Last-writer-wins made that the race's verdict, the walk
hung the caller up with a cause sipd has no status for, and the caller got `480 Temporarily
Unavailable` — which also makes a dial plan keep hunting on a final rejection.

`lastCause` now keeps the most INFORMATIVE cause (`causeRank`, three tiers): a decision by the far
end (`USER_BUSY`, `CALL_REJECTED`, `INCOMING_CALL_BARRED`, `UNALLOCATED_NUMBER`) outranks "the
endpoint was reached and the call ran out of time or was withdrawn" (`NO_ANSWER`, `NO_USER_RESPONSE`,
`ALLOTTED_TIMEOUT`, `PROGRESS_TIMEOUT`, `ORIGINATOR_CANCEL`, `LOSE_RACE`, `NORMAL_CLEARING`), which
outranks everything that never left this platform.

Test: `plan-walker.spec.ts` — "keeps a busy callee's own cause when a stale contact fails after it".
Verified it fails (`Received: "SUBSCRIBER_ABSENT"`) with last-writer-wins restored.

## 3. The held party hears silence (E2E-calling P2-H)

**FIXED, partly — `routing/plan-destination.ts`, `calls/channel-orchestrator.service.ts`.**

`onPhoneHold` already started/stopped music at the PEER, so start/stop was not the gap. The gap was
WHICH music: a phone holds by re-INVITEing `sendonly` and SIP cannot name a class, so `musicClass`
was always `undefined` and the port fell to `moh:default`. A tenant's configured class was reachable
from a queue and a park lot and from nowhere else.

`PlanDestination` now carries the compiler's resolved `mohClass` for the five node kinds that have
one, `recordDestination` mirrors it onto the leg as `OPTIMIQ_MOH_CLASS` beside the destination it
already mirrors (so it survives teardown and failover, same argument), and `onPhoneHold` reads it —
far end's request first, the leg's class second, `undefined` (the media server's default) last. The
same class is now what `channel.held` publishes.

Degradation: the refusal path keeps its best-effort `catch` and now NAMES the class that would not
start ("the held party hears silence"). It is a log line and not a call note because the orchestrator
has no per-call note channel outside a walk — `PlanWalker.note` is walk-scoped and hold happens long
after the walk returned. Adding one is a wider change than this brief; flagged below.

`moh/default` still has to exist for the default case — that is the default-media agent's asset, and
the ref this code emits is unchanged (`moh:<class>` via `MediadMediaPort.startMusicOnHold`).

Test: `calls/channel-orchestrator-routing.spec.ts` — "plays the destination's own music-on-hold class
at the held party" (extension node with `mohClass: "jazz"`, real ARI `ChannelHold` frame). Verified it
fails (`Received: undefined`) without the lookup.

## 4. `abortOnCallerHangup` — CONFIRMED in the tree and correct

`dialSimultaneous` and `dialOne` both default to `true`; the queue path still passes `true`
explicitly (`plan-walker.ts:5633-5634`). Every dial shape reaches one of them: extension and follow-me
and sequential ring groups through `dialSequential` → `dialOne`, simultaneous groups and every on-net
`dialOne` through `dialSimultaneous`, trunk/external through `dialOne`. `watchCallerHangup`'s and
`dialQueueAgents`' doc comments are rewritten for the split plane and are accurate. Abort unwinds
through the existing loser cleanup, so every outstanding B-leg gets `hangupQuietly(…,
"ORIGINATOR_CANCEL")` → CANCEL/BYE on the wire → `SplitPlaneMediaPort.hangup` releases the media
session in its `finally`. The regression test
("cancels the ringing callee when the caller hangs up first") is present and pins the extension shape.

**Added** the missing shape: "cancels every member of a simultaneous group when the caller hangs up"
asserts BOTH B-legs are cancelled with `ORIGINATOR_CANCEL`. Verified it fails (5 s timeout) with the
default flipped back.

Residual, not fixed: `dialSequential` does not race its inter-attempt delay against the caller's
hangup — a caller who hangs up inside a delay is noticed at the next loop top. Now bounded by the
offset (below) rather than by delay + timeout, and `abandoned` still catches it before the next
INVITE, so it costs no wire traffic.

## 5. `delaySeconds` had two meanings (E2E-routing P2-2)

**FIXED — `plan-walker.ts#dialSequential`.** One meaning now: **an offset from the start of the dial**,
which is what `dialSimultaneous` has always done and what the UI says — the control is labelled
"Start ringing after (seconds)" (`ring-group-member-dialog.tsx`) and the group summary reads
`starts at +Ns` (`ring-group-detail.tsx`). `dialSequential` slept the full delay BETWEEN members, which
compounds with the timeouts ahead of it: the measured `delaySeconds: 8` behind `timeoutSeconds: 8` rang
at 16.4 s with 8 s of dead air. Each hop now waits for whatever is LEFT of its own offset, and a member
whose offset has already passed starts immediately.

No compiler change is needed — `packages/routing` stores the number and documents nothing about it, and
the simultaneous reading is already the offset. Two pieces of prose still say the opposite; see below.

Tests: two in `plan-walker.spec.ts` (delays `[5_000, 3_000]` for offsets 0/5/8, not `[5_000, 8_000]`;
and an already-passed offset waits not at all). Both verified failing against the old code. The
harness gained a `delays` recorder and a clock that moves only when the walk asks for a delay, which is
what makes "offset" distinguishable from "gap" in a spec.

## Cross-area needed

1. **`ring_group_ref` / `ivr_ref` on the CDR.** Cheapest correct fix is entirely in `apps/api`:
   in `cdr-leg-mapping.ts`, when `destinationType === "ring-group"` (resp. `"ivr-menu"`) and
   `destinationRef` is a UUID, also write it to `ringGroupRef` (resp. `ivrRef`). No contract change,
   no engine change — the engine already sends the id. The alternative (a `ringGroupRef` field on
   `cdrLegWriteDataSchema` in `packages/events` plus a mapping plus an engine field) buys nothing,
   because the two would always be the same value.
2. **`apps/api/src/pbx/ring-groups/ring-groups.dto.ts:33** — "Always 0 for `simultaneous`; the delay is
what makes `sequential` sequential." Both halves are now wrong: the ordering is what makes it
   sequential, and the field means the same thing in both strategies. Suggested: "How far into the
   group's ring this member starts. An offset from the first INVITE in both strategies; the ordering
   is what makes a sequential group sequential."
3. **`apps/web/app/(app)/ring-groups/_components/ring-group-member-dialog.tsx:161`** — the description
   shown for `sequential` says "The delay is what makes a sequential group sequential." The label above
   it ("Start ringing after (seconds)") and the detail view ("starts at +Ns") are both already right;
   the description should match them, e.g. "Ring this member this many seconds into the call. Zero
   starts it as soon as the member ahead of it stops ringing."
4. **A per-call note channel outside the walk** (owner: whoever owns `ChannelAggregate`'s reporting
   surface). `PlanWalker.note` is walk-scoped, so mid-call failures — a hold whose music will not
   start being the live example — can only be logged. Not urgent; recorded because item 3 of this
   brief asked for a note and a log line is what the code can honestly do today.

## Not done, and why

- **E2E-calling P1-A (the routing-cache watch stall)** — already fixed by the routing agent in this
  tree (`routing-artifact.source.ts`, `WATCH_SILENCE_MS` + `watchIsCurrent()`), per `E2E-routing.md`.
  Not touched.
- **Findings D, E, G, I, J, K** — sipd, apps/web and missing-feature work; outside this area.

## Verification (exact final counts)

- `pnpm --filter @optimiq-voice/engine run typecheck` — clean (`tsc --noEmit`, no output).
- `pnpm --filter @optimiq-voice/engine run test` — **1605 pass, 6 skip, 0 fail**, 3594 expect() calls,
  72 files.
- `pnpm exec oxlint apps/engine/src` — 165 files, **0 warnings, 0 errors**.
- `pnpm exec oxfmt apps/engine/src` — clean (the new specs were reformatted by it; suite re-run after,
  533 pass / 0 fail across `src/routing/plan-walker.spec.ts` + `src/calls`).

## Needs restart

`apps/engine` — every change here is engine TypeScript and none of it is live. Nothing was restarted.
After a restart, re-check: `probe-reject.mjs` against a busy 2002 should show `486 Busy Here` on the
caller's wire and "Busy" in the UI; a two-party call's `call_legs` should show at most one `answered`
row per answered leg; a sequential group with `delaySeconds: 8` / `timeoutSeconds: 8` should ring its
second member at ~8 s, not ~16 s; and the held party should hear the tenant's class once
`moh/default` (or a configured class) exists as an asset.

## Files changed

| File                                             | Change                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/calls/cdr-leg.ts`                           | `dispositionFor` reads the answer state first; an unanswered leg is never `answered`                                            |
| `src/calls/cdr-leg.spec.ts`                      | 3 cases replacing the one that asserted the opposite                                                                            |
| `src/routing/plan-walker.ts`                     | `causeRank` + most-informative-cause in `dialSimultaneous`; `delaySeconds` as an offset in `dialSequential`; two stale comments |
| `src/routing/plan-walker.spec.ts`                | 4 new cases; harness gained `delays` and a delay-driven clock                                                                   |
| `src/routing/plan-destination.ts`                | `PlanDestination.mohClass`, carried for the five node kinds that have one                                                       |
| `src/calls/channel-orchestrator.service.ts`      | `OPTIMIQ_MOH_CLASS` mirrored with the destination; `onPhoneHold` uses it; the silence warning names the class                   |
| `src/calls/channel-orchestrator-routing.spec.ts` | 1 new case: the destination's own MOH class reaches the held party                                                              |
