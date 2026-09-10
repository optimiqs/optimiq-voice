# FIX — recording pause/resume for a call nobody was handed

Closes the gap left open by `FIX-clir-refer-pause.md` §3 cross-area 1 and 2:
`POST /api/v1/calls/:id/recording/{pause,resume}` reached only application-session-driven calls, and
nothing told a browser a call was being recorded. Nothing committed, staged or stashed. **No service
restarted, no NATS reload, no migration.**

---

## 1. Engine — a leg-scoped control RPC

### The contract: `rpc.engine.v1.call-control.<instanceToken>` (a SIBLING, not a widening)

`packages/events/src/schemas/rpc.ts` gained `CALL_CONTROL_VERBS`
(`pauseRecord`/`resumeRecord`/`stopRecord` — the same three names `SESSION_VERBS` uses, so one HTTP
route maps onto either transport with one vocabulary), `callControlRequestSchema`,
`CALL_CONTROL_REFUSAL_REASONS`, `callControlResponseSchema`, `CALL_CONTROL_RPC` (2 s, conference
moderation's budget). `subjects.ts` gained `RPC_SUBJECTS.engineCallControl` +
`subjectFor.engineCallControlRpc`. Exported from `schemas/index.ts`; `scripts/registry.ts` emits it
for Go.

**Why a sibling and not `session-verb` with an escape.** A session verb is authorised against the
session id the engine minted when an application _took_ the call — `application-sessions.ts` refuses
`unknown-leg` for any leg no live session holds. A softphone/desk-phone/queue call was handed to
nobody. The two ways to reuse that channel were to mint a session for every call in the platform so
a pause button could exist, or to punch an escape through the one check that makes a session id mean
anything. This subject instead authorises on what the control plane genuinely has: the **org**,
taken from the operator's own login and compared against the LEG (never the other way round), and
**ownership**, re-checked against the engine's own registry.

**`legId` is optional, and absent is the common case.** The control plane has the CALL — that is
what the `channels` bucket and the CDR are keyed by — and does not know which leg the recorder is
on. Absent means "the recorded leg of this call", which is unambiguous because `startRecording`
refuses a second recording on a leg that already has one.

**`wrong_instance`, underscored.** Spelled exactly as `apps/mediad` and
`SIP_TRANSFER_REFUSAL_REASONS` spell the same fact, rather than hyphenated like its neighbours here
— a caller that has to switch on two spellings of one condition will eventually miss one.

### The responder

New `apps/engine/src/nats/call-control.service.ts`, modelled on `session-verb.service.ts`:
instance-addressed, no queue group, every path answers, never throws. **Served sequentially**, which
is the one place it differs from the verb channel and is deliberate — every verb here is a map
lookup plus one 500 ms media command, nothing waits for a person, and ordering means two presses of
one button cannot race. Registered + exported in `nats.module.ts`.

### The handler

`ChannelOrchestrator.controlCallRecording` (`@Optional() recordingControl` injected last, attached
beside the conference one). Order of checks **is** the authorisation: legs of this call in this org →
this instance still owns one → something is recording on it → the verb.

- Leg lookup is a **linear scan of `registry.all`**, deliberately: there is no by-call index, the map
  is one entry per live leg on one process, and the caller is a person pressing a button. A fifth
  index maintained on every call setup would cost the hot path to save a human-speed path nothing.
- A leg whose `OPTIMIQ_ENGINE_INSTANCE_ID` is **absent counts as ours** — it is in this instance's
  registry, which is the stronger fact, and the variable is stamped by the KV mirror, so a call
  controlled between admission and the first `putChannel` must not be refused as somebody else's.
  Only a variable that _names_ another instance produces `wrong_instance`.
- Another tenant's call id and an id that never existed produce **byte-identical** refusals
  (`unknown-call`), asserted with `toEqual`.
- `unsupported` vs `media-refused` is told apart by `MediaOperationNotSupportedError` appearing in
  the runtime's flattened refusal string — a pinned `name` field on the class, not a message a
  rewording can lose. (ARI's pause _shortens_ the file, so on that driver the operation does not
  exist rather than having failed, and a console must HIDE the control.)

### `nats.conf`

Two grants added, each its own line rather than a wider `rpc.engine.v1.*`, on the argument the
conference line already makes (different powers, independently withdrawable): api **publish**
`rpc.engine.v1.call-control.*`, engine **subscribe** the same. **HUP reload required — not done.**
No new bucket read was needed: the api already holds `$KV.channels.>` for the live-calls topic.

---

## 2. API — the endpoints reach both kinds of call

New `apps/api/src/pbx/calls/call-control.client.ts` (`ConferenceControlClient`'s shape: own NATS
connection, read-only KV bind, refusal-never-throw). `ownersOf(org, callId)` does a
`keys("<org>.<callId>.>")` range on `channels`, **drains the key list before reading a single
value** — the ordered-consumer trap `LiveHub.snapshot` documents at length — parses
`liveChannelSchema`, re-checks `organizationId`, and returns the de-duplicated, sorted set of
`OPTIMIQ_ENGINE_INSTANCE_ID`s.

`CallRecordingService.setPaused` unchanged for a controlled call; when `ControlledCalls` has no
entry it now falls through to `setPausedOnEngine`. **The session path is tried FIRST**, and that
order is the decision: a call under an application's control has exactly one commander, and routing
its pause around the session would put two paths on one recorder with no ordering — the race
`ApplicationSessions.run` refuses a second session to avoid. Owners are walked in turn and
`wrong_instance` is the **only** reason worth continuing on; every other refusal is a fact about the
call the next instance would repeat. The reply's `paused` is reported, not the request's: the button
is drawn from it.

Permission **`calls.control`, unchanged** — no registry change, no codegen change. Status mapping:
`unknown-call`/`wrong_instance` → 404, `not-recording`/`media-refused`/`bad_request` → 409 carrying
the reason, `unsupported` → 501, `shutting-down`/`internal` → 503.
`CallRecordingNotPausableException`'s reason type widened to the union of both vocabularies, so a
client never has to know which transport carried its request.
`CallControlClient` registered in `pbx.module.ts`; `@Optional()` on the service so a deployment with
no broker refuses rather than pretending.

**Tests** (`apps/api/test/pbx/callRecordingControl.test.ts`, +9 → **1461 passing, 0 failing**):
addressing the owner with the operator as `byUserId` and no `legId` on the wire; the recorder's state
winning over the request; the session path preferred with the engine never consulted; a call nothing
live holds = 404 with nothing sent; the lookup made under the caller's org; re-address on
`wrong_instance` and stop on anything else; all eight engine refusals → status; no-broker → 404.

---

## 3. Recording state on the live channel

**Flags, not a new field or a new event.** `packages/telephony` `CHANNEL_FLAGS` gained `recording`
and `recording-paused`. That is the whole producer: the snapshot is already mirrored into `channels`
on every change and already reaches the `active-calls` live topic. A new object field would have had
to be threaded through the snapshot write path; a `call.recording.*` event would have needed a
stream and a reader. `packages/events` live-state gained the reader's half —
`LIVE_CHANNEL_RECORDING_FLAGS` (two strings copied, not imported: events is the bottom of the
dependency graph) and `recordingStateOf(channel) → { active, paused }`, which **ignores
`recording-paused` when `recording` is absent**: "Recording paused" for a call nothing is recording
tells an agent a card number is safe from a recorder that is not running.

Written by a new `CallControlHost.markRecording(leg, {active, paused})`, called at all four edges of
`CallControl` (start / pause / resume / stop) and implemented in the orchestrator as
add/remove flag + `putChannel`. Fire-and-forget: a KV mirror that could not be written must not fail
a pause the media plane already applied. Skipped for a tearing-down leg, on the rule every other
late write here follows. `recordingFor()` now also returns `paused`.

**Web.** `lib/softphone/recording.ts` gained the pure decision, spec'd in `recording.spec.ts` (+11 →
24 in that file):

- `observedRecording(legs, extension)` — picks this agent's recorded leg out of the whole
  organization's feed by matching the extension against `profile.callerIdNumber` **or**
  `destinationNumber` (the two ends the engine resolves it onto), reading the pause only behind the
  active flag.
- `recordingEventForObservation(state, observation)` → the one event to dispatch, or nothing. Two
  guards: a request **in flight on the same call** is left alone (the feed and the REST reply race,
  and an observation landing mid-request would clear `pending` and let a second press through), and
  an observation that **agrees** produces nothing (a republished row must not churn the reducer).
- New `RECORDING_OBSERVED` reducer case. This is the only way `paused` is entered without a local
  confirmation, and it must exist: an agent who paused from their desk phone, or a supervisor from a
  console, changed the recorder.

`softphone-context.tsx` consumes `useLiveActiveCalls()`, gated on the softphone call being
`active`/`ringing` so the feed's lag cannot re-light the control on a call that just ended. The
dialer's `RecordingControls` needed no change — it was already written against this state. Stale
"no producer exists yet" comments in `recording.ts` and the context's `recording` doc corrected.

**Stated limitation:** the `active-calls` topic's permission is `cdr.read`. An agent without it gets
an empty feed and therefore no control — the pause is hidden rather than offered over a recorder
whose state nothing can see. Widening that is a change to `LIVE_TOPIC_PERMISSIONS`, not to the
softphone; flagged as a product decision below.

---

## Additional fixes

- **`packages/events-go/parity_test.go` was already failing** before this work: the hand-maintained
  RPC-subject map had drifted from the golden by four subjects other agents added
  (`engineQueueCallback`, `mediaPauseRecording`, `pbxHotDesk`, `pbxToggleFeature`). All four added
  alongside my `engineCallControl`; the module is green again.

---

## Cross-area needed

1. **`config/nats.conf` HUP reload** — for the two new `rpc.engine.v1.call-control.*` grants (and
   still for `FIX-engine-features.md`'s three `rpc.media.v1.pause-recording` ones). Not done.
2. **Decision:** should the softphone's recording indicator work without `cdr.read`? Today an agent
   without it sees no control. The narrow fix is a `calls.monitor`-style grant on the
   `active-calls` topic, which `live-topics.ts` already names as the eventual answer to exactly this.
3. **`packages/telephony`** was edited (two additive flags) though it was not in my grant — it is
   the authority for `ChannelSnapshot` and there is no way for the engine to carry recording state
   on the snapshot without it. Two entries in one array plus a doc line; flagged for the owner.

## Live re-run owed

- **Row 15 (pause/resume) on a softphone call** — needs nats HUP, engine restart, api restart. The
  path is: agent places a call, a record policy or `*1` starts the recorder → the `recording` flag
  reaches the browser over `active-calls` → the control appears → pause → `channels` carries
  `recording-paused` → the button says "Recording paused" → resume → one object with a silence gap
  and `pauses` intervals on the CDR row.
- **Multi-instance `wrong_instance`** — only unit-proven; the deployment is single-engine.

## Verification (exact final counts)

| Command                                                                  | Result                                                                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/events run typecheck`                      | pass, 0 errors                                                                                                         |
| `pnpm --filter @optimiq-voice/events run test`                           | **418 pass, 12 skip, 0 fail**, 1110 expect()                                                                           |
| `pnpm --filter @optimiq-voice/events run codegen` ×2 + `git status` diff | **byte-identical — idempotent**                                                                                        |
| `pnpm --filter @optimiq-voice/telephony run typecheck` / `test`          | pass / **259 pass, 0 fail**, 1125 expect()                                                                             |
| `pnpm --filter @optimiq-voice/engine run typecheck`                      | pass, 0 errors                                                                                                         |
| `pnpm --filter @optimiq-voice/engine run test`                           | **1883 pass, 12 skip, 0 fail**, 4234 expect()                                                                          |
| `pnpm --filter @optimiq-voice/api run typecheck` (both tsconfigs)        | pass, 0 errors                                                                                                         |
| `pnpm --filter @optimiq-voice/api run test` (mocha)                      | **1461 passing, 0 failing**                                                                                            |
| `pnpm --filter @optimiq-voice/web run typecheck`                         | pass, 0 errors                                                                                                         |
| `pnpm --filter @optimiq-voice/web run test`                              | **889 pass, 0 fail**, 2822 expect()                                                                                    |
| `pnpm exec turbo run typecheck --filter=...@optimiq-voice/events`        | **16/16 successful**                                                                                                   |
| `packages/events-go`: `gofmt -l .` / `go vet ./...` / `go test ./...`    | clean / clean / **ok**                                                                                                 |
| `apps/sipd`, `apps/mediad`: `go build ./...`                             | clean (unaffected)                                                                                                     |
| `pnpm exec oxlint` over every touched dir                                | 1 warning, **pre-existing** and not mine (`no-explicit-any` in `media-dtmf-recording.spec.ts`, unchanged by this work) |
| `pnpm exec oxfmt` over every touched dir                                 | 785 files, clean, no rewrites left                                                                                     |

`codegen:check` exits 1 **only** because the generated files are uncommitted — as they already were
before this work, from other agents' schema changes. Idempotence was proved instead by running
codegen twice and diffing `git status`.

## needs-restart / reload

- **nats-server — HUP reload required** for `rpc.engine.v1.call-control.*` (api publish, engine
  subscribe). Without it the api's requests are refused by the broker and every pause on a PBX call
  answers 503.
- **engine — restart** (the new responder, the recording flags on the snapshot, `markRecording`).
- **apps/api — restart** (the new client, the fallback path, the widened error type).
- **apps/web — no restart needed beyond the dev server picking up the change.**
- No migration, no rebuild of `apps/sipd` or `apps/mediad` on account of this work.
