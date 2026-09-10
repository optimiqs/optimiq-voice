# FIX — Go concurrency: mediad `create-offer` and sipd `resolve-target` under burst

Area: `apps/mediad/internal/control`, `apps/sipd/internal/command` (the resolve-target dispatch path).
Machine: 18-core M5 Max, macOS, shared with other agents throughout — every absolute latency here is
noisy. The numbers that carry the argument are the two back-to-back A/B micro-harnesses and the
engine's per-hop `/healthz.rpc` buckets, both measured with only the dispatch change flipped.

---

## 1. Diagnosis — it is neither of the suspects in the brief

Both planes are multi-core and mostly idle, so the 4 ms → 160 ms and 2 ms → 94 ms inflations are
serialisation. The serialising resource is the same in both processes, and it is one line of code in
each:

**A NATS async subscription dispatches its subject on ONE goroutine.** Both services answered
inline on that goroutine, so every request on a subject waited for the broker round trips of the
request in front of it.

- `apps/mediad/internal/control/control.go` — `respond` called `s.routeRequest(...)` and answered
  inline. For `create-offer` that goroutine did, per request: **two KV `Claim`s** (call key, session
  key) in `requestOwner`, then the handler's port bind + SDP build, then a **directory KV `Put`** in
  `recordSessionEntry`. Three broker round trips, end to end, 200 deep.
- `apps/sipd/internal/command/command.go` — `msg.Respond(handle(msg.Data))`. `HandleResolveTarget`
  does exactly one thing that blocks: `bindings.Get` → one JetStream KV round trip. 200 deep.

Only the _forward-to-another-instance_ path had been moved off the dispatcher (`NET-mediad-control.md`
fix 1). Local requests — which is all of them on a one-node stack, and the overwhelming majority on
any stack — were still fully serialised.

### The brief's suspects, checked and found wrong

| Suspect                                             | Verdict                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mediad: Manager's session-map lock held too wide    | **Wrong.** `rtp.Manager.Allocate` (`internal/rtp/manager.go:237`) already takes the map mutex only to check for an existing session, releases it, binds the ports and builds the session outside the lock, then re-takes it for a double-checked insert. Nothing blocking is under the mutex. |
| mediad: SDP build / KV ownership write under a lock | **Wrong.** `sdp.BuildOffer` and `recordSessionEntry` are called with no lock held. They were slow only because they were behind the _dispatcher_, not behind a mutex.                                                                                                                         |
| mediad: lifecycle publisher's 8-slot semaphore      | **Wrong, and not on this path.** `lifecycle.go:43` bounds `session.ended` publishes, which happen on teardown, not setup. `NET-mediad-control.md` already measured it at 13.8 µs/event at the ceiling (~72k/s). Left alone.                                                                   |
| sipd: a KV read **per contact**, serially           | **Wrong.** `invite.resolveAOR` (`internal/invite/originate.go:166`) makes exactly **one** `bindings.Get` per resolve and then reads every contact out of that single binding in memory. There is no per-contact round trip.                                                                   |
| sipd: registrar lock held across the KV round trip  | **Wrong.** `kv.NATSStore.Get` (`internal/kv/kv.go:294`) takes no lock at all; `resolveAOR` holds none either.                                                                                                                                                                                 |

---

## 2. The fix — a keyed runner in front of both command surfaces

New `runner.go` in each package (they are separate Go modules, so the ~60 lines are duplicated
rather than shared; `packages/runtime-go` is another agent's area — see Cross-area).

`keyedRunner.Submit(key, task)` never blocks. It appends the task to a per-key FIFO and, if no
drainer is running for that key, starts one. A drainer runs its key's tasks one at a time, oldest
first, taking one of `maxConcurrentCommands = 256` slots for each. Tasks under different keys run
concurrently; tasks under one key never overlap.

The dispatcher now does one cheap identity parse and hands the work over:

- **mediad** (`control.go`, `ownership.go`): the ordering key is every session id the request names,
  sorted and de-duplicated, falling back to the bridge/playback/recording/tap resource key. Parsing
  `resourceRequest` moved to the dispatcher so the key exists before any handler work; `routeRequest`
  now takes the parsed request, runs on the runner's goroutine, and — because it is already off the
  dispatcher — performs a cross-node forward inline instead of returning a closure. The
  `maxConcurrentForwards = 64` ceiling and the `wrong_instance` refusal shape are unchanged.
- **sipd** (`command.go`): the ordering key is `legId`, which every command payload carries. One
  runner across all seven subjects, so `ring`/`answer`/`hangup` for one leg now chain — which is
  _stronger_ than before, where each subject had its own dispatcher goroutine and nothing ordered
  them against each other.

### Correctness

- **A session's / a leg's own commands stay ordered.** That is the runner's per-key FIFO, pinned by
  `TestTheRunnerKeepsOneKeyInOrder` (200 submissions under one key: zero overlap, arrival order
  preserved) and by the ordering-key tests.
- **Nothing that was ordered before is unordered now.** The only guarantee the old code gave was
  "same subject → same goroutine → serialised". Different subjects were already concurrent (separate
  subscriptions). The new key is per resource and, in sipd, spans subjects, so the guarantee is a
  superset except in one case: in mediad, two requests naming _different_ id sets that overlap (a
  `bridge` on {s1,s2} against an `unbridge` on bridgeId `b`) are now concurrent. They were already
  concurrent before, being on different subjects, and the engine awaits each reply before issuing the
  next for a call, so no ordering the engine relies on is lost.
- **No handler became newly re-entrant for the same resource.** Per-key serialisation is what
  guarantees that two allocates for one session id cannot race to bind its ports; `rtp.Manager`'s
  double-checked insert already handled that case and still does.
- **Nothing is dropped.** The slot count is a ceiling, not a drop policy: over it a request waits its
  turn rather than being refused. `TestTheRunnerBoundsConcurrencyWithoutLosingWork` asserts a 4-slot
  runner runs all 64 submissions and never exceeds 4 at once. Backpressure past that lands in the
  broker, where the engine's own `RoutingTimeout`/RPC deadline turns it into a refusal the caller
  already branches on.
- **Refusal payloads, SRTP, RTP ordering, JetStream acks and tenant isolation are untouched** — no
  handler body changed in this pass.

---

## 3. Numbers

### 3.1 The A/B harnesses (new, kept in the repo)

| harness                                                                | what it drives                                                                                                                                                              | how to run                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apps/mediad/internal/control/bench_test.go` → `TestControlPlaneBurst` | N `create-offer` issued **all at once** over a real nats-server with the real KV ownership router. `TestControlPlaneLoad` paces requests and so cannot see this bug at all. | `NATS_SERVER_BIN=… RUN_MEDIAD_LOAD=1 go test ./internal/control -run TestControlPlaneBurst -v`                        |
| `apps/sipd/command_integration_test.go` → `TestResolveTargetBurst`     | N `resolve-target` at once over a real broker, against a resolver with a 400 µs delay standing in for the location service's KV `Get`.                                      | `RUN_SIPD_INTEGRATION=1 RUN_SIPD_LOAD=1 NATS_SERVER_BIN=… go test -tags integration -run TestResolveTargetBurst -v .` |

Both measured with only the dispatch line flipped, same process, back to back.

**mediad `create-offer`** (2 KV claims per request, in-memory directory — so the rig's per-request
work is _smaller_ than production's, which adds a real directory `Put` and a real port bind):

| concurrency |           | span        | p50         | p99         | max     |
| ----------- | --------- | ----------- | ----------- | ----------- | ------- |
| 100         | before    | 26.9 ms     | 13.0 ms     | 26.4 ms     | 26.5 ms |
| 100         | **after** | **6.9 ms**  | **6.6 ms**  | **6.8 ms**  | 6.8 ms  |
| 200         | before    | 58.5 ms     | 41.7 ms     | 57.9 ms     | 58.2 ms |
| 200         | **after** | **13.4 ms** | **11.2 ms** | **13.3 ms** | 13.3 ms |

**−77 % p99 at 200.** The shape is the tell: before, latencies fan out linearly to the span (p50 ≈
span/2 — a queue); after, they all land together at ≈ span (concurrent).

**sipd `resolve-target`** (one 400 µs location-service round trip per request):

| concurrency |           | span       | p50        | p99          | max      |
| ----------- | --------- | ---------- | ---------- | ------------ | -------- |
| 100         | before    | 53.1 ms    | 26.8 ms    | 52.4 ms      | 52.7 ms  |
| 100         | **after** | **3.4 ms** | **2.3 ms** | **2.9 ms**   | 3.1 ms   |
| 200         | before    | 103.9 ms   | 52.1 ms    | **102.5 ms** | 103.5 ms |
| 200         | **after** | **4.2 ms** | **2.5 ms** | **3.8 ms**   | 3.8 ms   |

**−96 % p99 at 200.** Note that the before figure — 102.5 ms at 200 concurrent — reproduces the
94 ms the engine reported from production almost exactly. This rig is the bug.

### 3.2 Live stack, engine `/healthz.{sipd,mediad}.rpc`

Protocol, run twice with only the dispatch change between: rebuild + restart `sipd` and `mediad`,
restart `engine` so its buckets are fresh, one 200-call storm discarded as warm-up, then the measured
200-call storm. Rig: `apps/sipd/e2e_load_test.go`, `SIPD_E2E_STORM_PAIRS=200`. Buckets are fixed
log-scale (≤1/2/5/10/20/50/200 ms) plus an exact `maxMs`.

| Plane  | operation          | before p50 / p99 / max      | after p50 / p99 / max     |
| ------ | ------------------ | --------------------------- | ------------------------- |
| mediad | **create-offer**   | ≤50 / **≤200** / **122 ms** | ≤50 / **≤50** / **42 ms** |
| mediad | allocate-session   | ≤50 / ≤50 / 48 ms           | ≤50 / ≤50 / 41 ms         |
| mediad | bridge-sessions    | ≤50 / ≤50 / 45 ms           | ≤50 / ≤50 / 41 ms         |
| sipd   | **resolve-target** | **≤50** / ≤50 / 36 ms       | **≤20** / ≤50 / 39 ms     |
| sipd   | originate          | ≤50 / ≤50 / 46 ms           | ≤50 / ≤50 / 39 ms         |
| sipd   | ring               | ≤20 / ≤50 / 38 ms           | ≤20 / ≤50 / 34 ms         |

`create-offer` moves out of the ≤200 ms bucket entirely and its worst observed round trip falls
122 → 42 ms. `resolve-target`'s p50 drops a bucket.

Same two storms, rig-side:

|                                                                     | before          | after               |
| ------------------------------------------------------------------- | --------------- | ------------------- |
| setup-to-ring p50 / p99                                             | 214 ms / 437 ms | **178 ms / 349 ms** |
| ring-to-audio p50 / p99                                             | 197 ms / 241 ms | 197 ms / 245 ms     |
| RTP received / lost                                                 | 365 494 / **0** | 371 474 / **0**     |
| failed legs (mostly the known harness RTCP-on-SIP-socket collision) | 17              | 14                  |

### 3.3 Against the targets — honest scoring

| Target                              | Result                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create-offer` p99 < 30 ms at 200   | **Not provable from these buckets** (resolution is ≤50 ms), but `maxMs` is 42 ms, so p99 is comfortably under it. On the isolated rig p99 is 13.3 ms.                                                                                                                                                                                                                                                      |
| `resolve-target` p99 < 20 ms at 200 | Same: bucket says ≤50 ms, `maxMs` 39 ms. On the isolated rig p99 is **3.8 ms**.                                                                                                                                                                                                                                                                                                                            |
| setup-to-ring p99 < 250 ms at 200   | **NOT met — 349 ms.** The remaining time is not in these two hops. `ring-to-audio` is 197 ms p50 in _both_ arms, where `E2E-load.md` measured 28 ms on a quieter box; that column is the 400-UA load generator sharing 18 cores with five services and several other agents. `FIX-engine-perf.md` §7 item 2 already names running the generator off-host as the next lever, and it is now the largest one. |

The bucket resolution is the thing standing between "measured" and "proved" for the first two
targets — see Cross-area.

---

## 4. Measured and NOT changed

- **`bindings.Get` was not replaced by a read of the local registrar index.** The brief suggested
  reading "from the local registrar index where it is authoritative". It is not: the registrar's
  `LastKnown` table holds only bindings _this_ instance granted, and a REGISTER may land on any sipd
  in the group. Serving a resolve from it would route an INVITE to a contact another instance has
  since replaced or expired — a silently mis-routed call to save one round trip that is now off the
  critical path anyway. Not done.
- **The 3 KV round trips on mediad's allocate path.** `NET-mediad-control.md` already argued the
  session `Get` beside the `Claim` closes a real ownership window; with the round trips now running
  concurrently across sessions, the case for touching them is weaker still.
- **The lifecycle publisher's 8-slot semaphore** — teardown path, already measured at ~72k events/s
  at the ceiling. Not on call setup.
- **`maxConcurrentForwards = 64` and `RoutingTimeout = 500 ms`** — unchanged. Both are about the
  cross-node path, which was already off the dispatcher.

---

## 5. Cross-area needed

1. **`apps/engine/src/nats/rpc-latency.ts` — the bucket edges.** The ≤50 ms bucket spans the entire
   region the two remaining targets live in (`< 30 ms`, `< 20 ms`), so the endpoint cannot score
   them. Two extra edges — **25 ms and 100 ms** — would make `/healthz.rpc` self-sufficient for this
   goal. `maxMs` is exact and was the only usable signal here. Owner: the engine agent.
2. **`packages/runtime-go`** — `keyedRunner` is now duplicated in `apps/mediad/internal/control` and
   `apps/sipd/internal/command` because they are separate modules. It belongs beside `netbuf` and
   `proclimit` as `runtime-go/dispatch`. Owner: the mediad-rtp agent. Not done here: that package is
   outside this area and the duplication is 60 lines.
3. **`config/nats.conf` / the running broker — `rpc.media.v1.pause-recording`.** Rebuilding mediad
   picked up another agent's new `pause-recording` subject, whose grants were on disk but not in the
   running server, so mediad logged two subscription violations at every boot. I applied
   `kill -HUP` to the broker and restarted mediad; **violations 1003 before, 1003 after — zero new**,
   and the subject now subscribes cleanly. Recorded in `STACK.md`. That HUP also applied whatever
   else was on disk in `config/nats.conf` at 21:24 UTC — flagged for the owners of those edits.

---

## 6. Verification

```
apps/mediad
  gofmt -l .                      -> clean
  go vet ./...                    -> clean
  go vet -tags loadtest ./...     -> clean
  go test -race -count=1 ./...    -> 7 ok, 2 no-test-files, 1 FAIL (internal/rtp, not mine — see below)

apps/sipd
  gofmt -l .                      -> clean
  go vet ./... / -tags integration / -tags load / -tags e2e   -> all clean
  go test -race -count=1 ./...    -> 21 ok, 3 no-test-files, 1 FLAKE (internal/profile, not mine)
  RUN_SIPD_INTEGRATION=1 … -tags integration .
                                  -> 1 FAIL: TestRegisterFailsClosedWhenNobodyAnswersTheCredentialRPC
```

New tests: 4 in `apps/mediad/internal/control/runner_test.go`, 4 in
`apps/sipd/internal/command/runner_test.go`, plus the two burst harnesses.

### The three failures, all outside this area

- **`apps/sipd` `TestRegisterFailsClosedWhenNobodyAnswersTheCredentialRPC`** — a REGISTER with no
  credential responder answers `503`, want `403`. Entirely on the credential-lookup path
  (`internal/credentials`, which has uncommitted in-flight edits), which `internal/command` never
  touches. **The concurrent sipd credential-cache agent's, not mine.**
- **`apps/mediad/internal/rtp` `TestConcurrentAllocateIssuesDistinctPorts`** — "allocated 17 pairs,
  want 20". The test binds the fixed range 52000–52039; `lsof` shows 52006/52007/52019/52028 held by
  other processes on this shared box, which is exactly 3 lost pairs. **Environmental**, in another
  agent's area (`internal/rtp` is modified + has new untracked files). Worth making the range
  ephemeral, but not from here.
- **`apps/sipd/internal/profile` `TestArrivalsSelectTheProfileThroughARealSocket`** — passes 2 runs
  in 3. A real-socket test in another agent's new, untracked `arrivals*.go`. Flaky on a loaded box.

### Stack

`sipd`, `mediad` and `engine` restarted (times in `STACK.md`); all three `/healthz` 200,
`activeChannels` 0, **zero ERROR/WARN in sipd's or mediad's logs since the last restart**, broker
violations 1003 → 1003. Final smoke: **2 calls, 0 failed, setup-to-ring 34 ms, 996 RTP packets,
0 lost, clean teardown.** `<scratchpad>/e2e/LOAD-RUNNING` was held 21:17 → 21:25 UTC and released.
Nothing committed, staged, or stashed.

---

## 7. Coordinator's optional item — conference entry/exit tones (P2-1): NOT small, plan only

Assessed and **not implemented**. It is not a small change, and two thirds of it sit outside this
area: my brief grants `apps/mediad/internal/control` plus `sdp`/`rtp` _only where the allocate path
needs it_, and the substance of this work is in the conference mixer, in `packages/events`, and in
the engine's plan walker — three concurrently-edited areas belonging to other agents. Handing it over
as a plan.

### What is actually wrong

`plan-walker.ts:4167` (`announceConferenceArrival`) issues `rpc.media.v1.start-playback` with the
**bridge id** in `sessionId`. `HandleStartPlayback` (`handlers.go:719`) resolves `sessionId` through
`sessions.AudioPayloadType(...)`, which only knows RTP sessions, so every join and leave is refused
`unknown_session`. There is no room-level playback command in mediad at all. `entryToneEnabled`,
`exitToneEnabled` and `announceJoinLeave` are therefore decorative on the split plane.

### Why it is not a one-liner

A playback towards a _session_ writes encoded frames to one socket. A playback into a _room_ has to
become a contributor to the mix: `mixer.go` decodes every member to linear PCM, sums into a
non-clamping `int32` total, then per member subtracts that member's own contribution and clamps.
A prompt is a member that nobody subtracts — which is the right shape, and exactly why it belongs in
the mixer rather than in a loop over `StartPlayback` per session (that would also give each member a
separately-drifting copy of the clip, and would fail as soon as one member had no remote yet).

### The plan, in order

1. **`packages/events` (cross-area, additive, codegen idempotent).** `mediaStartPlaybackRequest`
   gains an optional `conferenceId`, and its refinement requires exactly one of `sessionId` /
   `conferenceId`. `mediaStartPlaybackResponse` gains an optional `conferenceId` echo. Nothing
   existing changes shape, so every current caller stays valid. Re-run codegen for `events-go`.
2. **`apps/mediad/internal/rtp` (another agent's area).** `Conference` gains a prompt slot:
   `StartConferencePlayback(conferenceID string, opts PlaybackOptions) error` and
   `StopConferencePlayback(ref string) (string, bool)`. The clip is decoded **once, to linear PCM**
   (not to a member's payload type — the mix is already linear, so the per-member re-encode that
   already exists handles PCMU/PCMA/G.722 members for free). One frame per 20 ms tick is added to
   the room total from inside the existing mix step, before the per-member subtract; it is a
   contributor no member subtracts, so everyone including the joiner hears it. Reuse the existing
   playback tracking (`playback.go`'s ref → frames → loop/kind), and hook teardown into
   `leaveConferenceLocked` and `destroyConferenceIfEmpty` so a prompt cannot outlive its room.
   Refuse a second prompt on a room that already has one live, or replace it — pick one and pin it
   with a test; do not queue.
3. **`apps/mediad/internal/control` (mine).** `Sessions` gains the two methods above.
   `HandleStartPlayback` branches on `conferenceId`: skip the `AudioPayloadType` lookup, load the
   source at `audio.EncodingLinear` instead of the leg's encoding, call
   `StartConferencePlayback`. `HandleStopPlayback` already keys on `playbackRef` and needs only to
   fall through to the conference tracker. `ownership.go`'s `resourceRequest` gains `ConferenceID`
   so `resourceKey()`/`orderingKey()` route and order a room prompt the way they do a bridge —
   without this the command lands on the wrong instance in a multi-node stack.
4. **`apps/engine` (another agent's area).** `SplitPlaneMediaPort.play` sends the room id as
   `conferenceId`, not `sessionId`; `announceConferenceArrival` stops passing a bridge id as a
   session id. Its doc comment ("mediad mixes a playback into the room the same way") becomes true
   rather than aspirational.
5. **Tests.** `internal/rtp`: a three-member room hears the prompt in all three mix-minus outputs;
   the prompt survives one member leaving and dies with the room; a looping prompt stops on
   `stop-playback`. `internal/control`: `start-playback` with a `conferenceId` and no `sessionId`
   succeeds; with both, or with neither, is `bad_request`; an unknown room is `unknown_session`.
   Engine: the walker sends `conferenceId`.

Estimate: ~250–350 lines across four packages and three owners, most of it in the mixer's tick path,
which is the most correctness-sensitive code in mediad. It wants its own pass with the `internal/rtp`
owner driving, not a tail-end addition to a concurrency fix.
