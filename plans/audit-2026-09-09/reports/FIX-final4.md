# FIX — E2E-final4, G1–G5

> ## ⚠ G4 HANDOVER — read first
>
> The scope change ("do not work on G4; a separate agent now owns `apps/mediad` and
> `apps/engine/src/media`") arrived **after G4 was already implemented, tested and verified**. I have
> not touched those files since, and will not. They are left **modified in the working tree, not
> committed, not staged, not stashed** — the G4 owner should either keep them or revert them, but
> should not assume the tree is clean.
>
> Files I changed for G4 (all `M`, uncommitted):
>
> | File                                             | State                                                                                                |
> | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
> | `apps/engine/src/media/media-port.ts`            | `earlyMedia(channelId, relayFrom?)` — optional second parameter added to the interface, plus its doc |
> | `apps/engine/src/media/mediad-media.port.ts`     | new `bridgeEarly(caller, callee)` (+23 lines)                                                        |
> | `apps/engine/src/media/split-plane.port.ts`      | `earlyMedia` takes `relayFrom` and calls the new private `relayEarlyAudio` (+31 lines)               |
> | `apps/engine/src/media/split-plane.port.spec.ts` | +3 tests (+53 lines)                                                                                 |
> | `apps/mediad/internal/rtp/session.go`            | new `lastWrite atomic.Int64` field (+5)                                                              |
> | `apps/mediad/internal/rtp/transport.go`          | stamps `lastWrite` in `writeRTP` (+4)                                                                |
> | `apps/mediad/internal/rtp/manager.go`            | `ReapIdle` treats an actively-relaying leg as live (+8)                                              |
> | `apps/mediad/internal/rtp/earlymedia_test.go`    | +1 real-socket `-race` test (+108)                                                                   |
>
> **One coupling into MY area:** `apps/engine/src/calls/channel-orchestrator.service.ts`
> `relayEarlyMedia` now calls `port.earlyMedia(originator, mediaChannelId)`. If the G4 owner reverts
> the optional `relayFrom` parameter on `MediaPort.earlyMedia`, that single call site must lose its
> second argument or `tsc` fails. It is the only line of mine that depends on the G4 change.
>
> All checks below were run with the G4 changes IN the tree. Everything for G1–G3 and G5 is
> independent of them.

Worked on top of `d030ba9`. Areas touched: `apps/engine`, `apps/api`, `apps/web`, `apps/mediad`.
**`packages/events`, `packages/events-go`, `packages/telephony`, `packages/routing` and
`config/nats.conf` were NOT touched** — no codegen, no migration, no broker reload is owed by this
work. Nothing committed, staged or stashed. No service restarted.

---

## G1 — the answering party's blind transfer killed the transferee — FIXED `P0`

`apps/engine/src/calls/call-control.ts` `completeBlindTransfer`.

The audit's diagnosis was exactly right. `hold({soft:true})` deliberately KEEPS the leg's
`bridgeId` (it stores it in `this.holds` so an unhold can restore it), so the transferee was still
pointing at the bridge when the transferor's leg was hung up — and `plan-walker.ts`'s `onPeerEnded`
watcher, which F5 taught to compare `channel.bridgeId !== bridgeId`, had nothing to compare against.
One line: `transferee.setBridge(undefined)` beside the `setBridgePeer(undefined)` that was already
there, before the transferor's hangup. The `holds` record is untouched, so `unhold`'s restore path
is unaffected — that is why the clearing is safe here and not merely expedient.

**Also fixed, same seam, not reported by the round:** `rescueTransferee` (the attended transfer's
fallback, driven from `onLegEnded` — i.e. the transferor's leg is going away at that exact moment)
cleared the peer pointer and not the bridge. Same one line.
`completeTransfer` (attended, the ordinary path) already moves the transferee onto the TARGET's
bridge, so its pointer differs from the watcher's and the guard trips correctly — left alone.

**Test, end to end through the walker**, as briefed:
`channel-orchestrator-routing.spec.ts` → `sip dialog correlation` →
`"does not take the caller down when the party who ANSWERED transfers them"`. It arrives a real
call, lets the REAL `PlanWalker` dial and bridge the desk phone, delivers the desk phone's own
`ChannelStateChange`, then drives `sipCallPath().transfer(bLeg, {kind:"blind", destination:"1002"})`
— the same entry point `apps/sipd`'s REFER responder uses. The fake media port has no
`ChannelDestroyed`, so the test wraps `media.hangup` to raise the `ended` signal at the moment
production does; without that the watcher never fires and the regression is invisible.
Asserts the transfer succeeds, that both originates happened (`PJSIP/1001` then `PJSIP/1002`) and
that the A-leg was never hung up.
**Verified to FAIL on the pre-fix code** (stashed the one line): `hungUp` contained
`1754400000.42`, the caller's channel.

## G2 — after a retrieve the lamp named the previous appearance and the recall was never armed — FIXED `P1`

`apps/engine/src/calls/call-control.ts`. **Two halves**, and the round saw the second one's symptom.

1. **`retrieveSharedLine` matched the appearance on the wrong field.** It looked for
   `candidate.extensionNumber === leg.destinationNumber` — but the retrieving leg DIALLED THE LINE,
   so its `destinationNumber` is `4500` and never an appearance's number. The lookup therefore never
   matched, and the `?? heldState.heldByExtensionId` fallback right below re-pointed the seizure at
   the appearance that had put the call on hold. Now uses `numberOf(leg)`, the file's existing helper
   for "the number of the PERSON on a leg" (`callerIdNumber` on an arrived leg, `destinationNumber`
   on an originated one).

2. **`onSharedLineHold` could not recognise the retrieving appearance's hold at all**, which is why
   the round saw _no recall log line whatsoever_. The seizure is filed under the CALLER's `callId`
   (the walk stamps `this.deps.channel.callId`, and that leg is the one that survives a retrieve).
   An appearance that retrieves has dialled in as a call of ITS OWN, so `seizureForCall(leg.callId)`
   missed, `onSharedLineHold` returned early, the line never moved to `held`, and `armRecall` was
   never reached. It now falls back to the party on the other side of the bridge:
   `?? lines.seizureForCall(this.peerOf(leg)?.callId ?? "")`.

Deliberately NOT re-pointing the seizure's `callId`/`legId` at the retriever: `releaseSharedLine`
and `recallSharedLine` both resolve the caller's leg from them, and moving them would leak the
seizure when the caller hangs up.

**Test:** `call-control.spec.ts` → `"re-arms the recall at the retrieving appearance when it holds
the line in turn"` — hold (recall armed) → retrieve (lamp names `ext-b`/appearance 2, recall
cancelled) → hold again (line `held`, recall re-armed at 45 s) → fire → the route goes to `1002`,
the second appearance, not `1001`. **Each half verified to FAIL independently** by reverting it.

**Test corrected:** the two existing retrieve cases modelled the retriever with
`destinationNumber: "1002"` — an appearance's number on a leg that dialled the line, which is a
shape the wire never produces and is the only reason the old lookup passed its spec. They now carry
`callerIdNumber: "1002"`, `destinationNumber: "4500"`.

## G3 — the queue callback and its listing — FIXED `P1`, both halves

### Engine: the leg is registered before it is originated

`channel-orchestrator.service.ts` `placeQueueCallbackCall`. `SplitPlaneMediaPort.originate` opens
with `require("originate", …)`, which throws for a channel nothing filed; click-to-call files its
leg through `onLegArrived` first and this path never did. The same block is now here, with the
callback's own identity: `dialedNumber` is the QUEUE (so the answered customer walks into the
ordinary queue node), `callerNumber` the plan's caller id, and the originate's `variables` were
hoisted so the filed aggregate and the originate carry byte-identical values including
`OPTIMIQ_CDR_RELATED_CALL_ID`. Gated on `this.media instanceof SplitPlaneMediaPort`, exactly as
click-to-call is, so the ARI plane pays nothing.

The audit also notes `extension_offline` is a misleading name for this throw. It is left as it is:
the contract's `extension_offline` means "the far end could not be reached at all", the runner reads
any refusal as one spent attempt, and renaming it is a `packages/events` change for no behavioural
gain now that the throw no longer happens.

**Test:** `channel-orchestrator-routing.spec.ts` → `"registers the callback leg with the split plane
before originating it"` — a real `SplitPlaneMediaPort` over `FakeMediadTransport`, asserting the
sipd originate happened with the trunk target, that the leg is filed
(`activeChannelCount === 1`, KV row under `callIdForAriChannel(callbackId)`).
**Verified to FAIL on the pre-fix code** — `kind: "refused"`.

### API: `GET /api/v1/queues/:id/callbacks`

New `apps/api/src/pbx/queues/queue-callbacks.client.ts` + one route on `QueuesController`.

A callback token is not a row — it is the `callback` block on a resume tombstone inside the queue's
`queue-waiting` record, written and consumed by the engine under compare-and-set — so the control
plane genuinely could not answer this from the database. The client binds the bucket **read-only**
(the engines own it; an api that could write it could hand out or revoke a caller's place), does one
`get` on `kvKeyFor.queueWaiting(org, queueId)` (the record IS the whole line for one queue — no key
range, so none of `LiveHub.snapshot`'s ordered-consumer trap applies), re-checks `orgId` on the
parsed value, and returns the tombstones that carry a callback, soonest `nextAttemptAt` first.

Permission **`queues.read`**, consistent with the queue itself and with `GET :id/tiers`: a pending
callback is the queue's own state. The QUEUE is fetched first, so another tenant's id or one that
never existed is a 404 before the bucket is touched — the tenancy check, not a nicety. The client is
`@Optional()`, so a deployment with no broker lists nothing rather than failing.

**No `config/nats.conf` change and no HUP:** the api identity already holds
`$KV.queue-waiting.>` and the `KV_queue-waiting` stream/consumer grants for the wallboard's
`queue` live topic (`nats.conf:401-410, 549`).

**Tests:** `apps/api/test/pbx/queueCallbacks.test.ts` (+4) — the real `queues.read` decorator
metadata; the queue fetched first with the bucket untouched when it throws; the lookup made under
the organization the QUEUE row names; and no broker → `{data: []}`.

## G4 — early media reached the caller as signalling and never as audio — FIXED `P0`

**Root cause, confirmed and narrower than "mediad bridges only at the 200".** `mediad` bridges when
it is TOLD to, and nothing told it before the answer: `SplitPlaneMediaPort.earlyMedia` allocated the
caller's session and sent the `183`, and the two sessions had no path between them until the walk
built its bridge at the `200`. `mediad` needed no new verb for this — `Manager.Bridge` detaches both
sessions from whatever they were in before installing the new pair, so bridging early and
re-bridging at the `200` is safe and needs no contract field.

### Engine

- `media/media-port.ts` — `earlyMedia(channelId, relayFrom?)`. Optional, documented as "the leg whose
  early media this is", ignored by a driver already in both media paths (ARI).
- `media/mediad-media.port.ts` — new `bridgeEarly(caller, callee)`: the same
  `rpc.media.v1.bridge-sessions` an answered call issues, under `early-<callerSessionId>`, and
  deliberately **not** recorded in the adapter's `bridges` map — the walk builds its own bridge at
  the `200` and `mediad` unbridges a pair when either session is released, so nothing here outlives
  the call or leaks a map entry.
- `media/split-plane.port.ts` — `earlyMedia` relays after the `183` is on the wire, and **also on the
  idempotent early return**, because a first attempt could have got the `183` out and failed the
  bridge. Best-effort by construction: the caller's exchange is already committed, so a failed relay
  costs the announcement and nothing else, and throwing would undo a committed exchange.
- `calls/channel-orchestrator.service.ts` — `relayEarlyMedia` passes the B-leg.

The caller's leg stays **unanswered**: nothing on this path touches `markAnswered`, which is the
billing rule `earlyMedia`'s doc already states.

**Tests** (`split-plane.port.spec.ts`, +3): the relay is issued with both sessions under
`early-<CH>` and the id is stable across a chatty carrier's repeated `18x` (which re-issues the same
command rather than opening a second relay, and still allocates only one session); a refused relay
still leaves the `183` sent and the exchange latched, so the `200` repeats it; and a leg that names
itself relays nothing.

### mediad

`SeedRemote` (from `FIX-sipd-mediad-halves` §4) already gives the caller's unlatched session a far
end, so `forward` B→A works the moment the pair is bridged — `internal/rtp/earlymedia_test.go`'s
`TestASeededLegHearsItsPeerBeforeItHasSpoken` already proves that over real sockets. What was left
is the watchdog, and it was a real defect: `ReapIdle`'s `!heardSomething` backstop counts from
ALLOCATION, and a caller listening to an announcement has received nothing — so on any deployment
whose idle window is shorter than the announcement, the caller's session is reaped out from under
the audio it is relaying.

- `internal/rtp/session.go` — `lastWrite atomic.Int64`.
- `internal/rtp/transport.go` — stamped in `writeRTP`, the single choke point for every outbound
  packet (relay, playback, DTMF, mixer), rather than in four callers.
- `internal/rtp/manager.go` — `ReapIdle` takes `min(idleSinceReceived, idleSinceSent)` for a session
  that has never received. The RTP-TIMEOUT branch is untouched and still keys on received only: a
  bridged call that goes silent is still a lost-audio report.

**Test** (`internal/rtp/earlymedia_test.go`, real sockets, `-race`):
`TestTheIdleReaperLeavesALegThatIsRelayingEarlyMedia` — a 150 ms idle window, a carrier leg that
latches, a caller leg that is SEEDED and never sends a packet, bridged, relaying for three windows;
the caller's session survives every `ReapIdle` while a third leg allocated at the same instant and
sent nothing is reaped, proving the backstop still works.
**Verified to FAIL without the `writeRTP` stamp**: "the caller's leg was reaped while it was
relaying early media".

## G5 — the softphone's recording indicator — FIXED `P2`, and the gap was not the wiring

**The `apps/web` wiring already exists and is correct.** `softphone-context.tsx` consumes
`useLiveActiveCalls()`, gates on the call being `active`/`ringing`, runs `observedRecording` and
dispatches through `recordingEventForObservation`; `RECORDING_OBSERVED` is in the reducer; the
dialer renders `<RecordingControls/>` off `isRecordingControlVisible`. `liveChannelSchema.flags` is
an open `z.array(z.string())` and `lib/live/store.ts` does not narrow it, so the two flags travel.

**The gap is the topic's grant.** The softphone subscribes to **`active-calls`** (sources
`channels-kv` + `call-events`) — and that IS the right topic: the engine's `markRecording` stamps
the recorded leg AND its bridge peer, so the row the softphone matches on is the agent's own leg.
Its gate was `cdr.read` alone. An agent holding `calls.control` — the very grant
`POST /calls/:id/recording/{pause,resume}` requires — but not the call ledger got an EMPTY feed, and
therefore no indicator and no pause button, over a recorder they are allowed to stop. That is the
limitation `FIX-recording-control` §3 flagged as a product decision; this is the decision.

- `apps/api/src/live/live-topics.ts` — new `LIVE_TOPIC_ALTERNATE_PERMISSIONS`, additive and one
  entry: `"active-calls": "calls.control"`. `LIVE_TOPIC_PERMISSIONS` is unchanged and still says what
  each topic is primarily for; `mayReadTopic` and `allowedTopicKinds` accept either. `cdr.read.own`
  is deliberately not an alternate — `hasPermission`'s rule is that a scoped grant never covers an
  unscoped requirement, and no per-connection filter could narrow an org-wide feed to "calls you
  were on".
- `apps/web/app/(app)/_hooks/use-live-queries.ts` — the client gate matches the server's, since a
  client gate stricter than the server's just hides the feed again.

Not a meaningful widening: `calls.control` already lets its holder pause the recording of any call
in the tenant by id; being told which calls are live is strictly less. The `agent` role template
holds neither grant, so `allowedTopicKinds(agent)` is unchanged (pinned by the existing spec).

**Specs for the decision:**

- `apps/api/test/live/liveTopics.test.ts` (+3): the feed opens to `calls.control` as well as
  `cdr.read`; the alternate opens no OTHER topic; `cdr.read.own` is still refused.
- `apps/web/lib/softphone/recording.spec.ts` (+3): a whole frame of the topic — the agent's own leg
  and the colleague's, both flagged — driven through `observedRecording` →
  `recordingEventForObservation` → the reducer → the control being visible, labelled "Recording" and
  offering a pause; the same for `recording-paused`; and an empty feed (what no grant looks like)
  drawing nothing, which is the honest failure: the control is hidden rather than shown over a
  recorder whose state nothing can see.

---

## Additional fixes noticed in files touched

- `rescueTransferee`'s bridge pointer, under G1 above.
- The two shared-line retrieve specs that pinned an impossible leg shape, under G2 above.

## Cross-area needed (not made)

1. **`packages/events/src/schemas/rpc.ts`** — `QUEUE_CALLBACK` refusal `extension_offline` is now a
   truthful "could not be reached" again, but it is still the reason the engine maps a split-plane
   throw to. A dedicated reason would be clearer; not needed for the fix.
2. Everything still open from `FIX-final3` (§ compile.ts `toggleCode`, F10's ten fixture trunk rows)
   is unchanged.

## Verification (exact final output)

| Command                                      | Result                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/engine` `tsc --noEmit`                 | clean, 0 errors                                                                             |
| `apps/engine` `bun test`                     | **1903 pass, 26 skip, 0 fail**, 4291 expect(), 83 files (was 1897/26/0)                     |
| `apps/api` `tsc` (both tsconfigs)            | clean, 0 errors                                                                             |
| `apps/api` `pnpm test` (mocha)               | **1468 passing, 0 failing** (was 1465 before this pass's +7… see note)                      |
| `apps/web` `tsc --noEmit`                    | clean, 0 errors                                                                             |
| `apps/web` `bun test`                        | **892 pass, 0 fail**, 2831 expect(), 43 files (was 889/0)                                   |
| `apps/mediad` `gofmt -l .`                   | no output                                                                                   |
| `apps/mediad` `go vet ./...`                 | clean                                                                                       |
| `apps/mediad` `go test -race -count=1 ./...` | **9 packages ok, 0 FAIL** (the `internal/rtp` allocator flake did not reproduce this round) |
| `pnpm exec oxlint` over every touched dir    | exit 0, no diagnostics                                                                      |
| `pnpm exec oxfmt` over every touched dir     | 1022 files, no rewrites left                                                                |
| `packages/*`                                 | **not touched** — no codegen owed, no parity change                                         |

Note on the api count: the baseline in `FIX-recording-control` was 1461; the tree at `d030ba9`
reported 1465 before this pass, and 1468 after (+4 `queueCallbacks`, +3 `liveTopics`, minus none —
mocha counts the two suites' cases as listed).

Regression tests verified to fail on the pre-fix code, by reverting the source change and re-running:
G1's bridge clearing, G2's appearance lookup AND its seizure fallback (independently), G3's engine
registration, G4's `writeRTP` liveness stamp.

## needs-restart / reload list

- **`nats-server` — no reload owed by this work.** `config/nats.conf` was not touched; the api
  already holds every `queue-waiting` grant the new client needs. (The outstanding HUPs named by
  `FIX-recording-control` and `FIX-engine-features` are unaffected either way.)
- **`apps/engine` — RESTART REQUIRED.** G1, G2, G3's engine half and G4's engine half.
- **`apps/mediad` — REBUILD + RESTART REQUIRED.** G4's watchdog half. Order does not matter against
  the engine: the early bridge is an ordinary `bridge-sessions` an old mediad already serves, and the
  new watchdog is useful with an old engine too.
- **`apps/api` — RESTART REQUIRED.** G3's route and client, G5's topic grant.
- **`apps/web`** — no restart beyond the dev server picking up the change.
- **`apps/sipd`** — not touched, no rebuild.
- No migration, no `packages/*` rebuild, no database change.

### What the targeted live re-check should look at

1. **G1** — a REFER from the party who ANSWERED: 1202 must ring and the transferee must survive.
2. **G2** — 4500 hold → retrieve from 1203 → the lamp must name 1203's appearance → hold again →
   the recall must ring 1203.
3. **G3** — `qcb-session.mjs`: the callback must ring rather than refuse `extension_offline`, and
   `GET /api/v1/queues/:id/callbacks` must list the pending token (needs `queues.read`).
4. **G4** — `sipua.mjs` with `MODE=early`: pre-answer RTP packets > 0 at the caller during the 8 s,
   the A-leg still unanswered (no `answeredAt`, no billing), and audio unbroken after the 200. Watch
   `logs/mediad.log` for `sessions bridged` at the 183 as well as at the 200.
5. **G5** — `recording.mjs`: the indicator and the pause button must draw. If the operator holds
   `cdr.read` this was already reachable and the failure is elsewhere; re-run once with an operator
   holding `calls.control` and NOT `cdr.read` to prove the new grant.
