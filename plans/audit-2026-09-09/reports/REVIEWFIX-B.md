# REVIEWFIX-B — mediad topology (R11–R14, R19, R20)

Scope held: `apps/mediad/internal/rtp/{manager.go, conference.go, mixer.go}` and
`apps/mediad/internal/control/ownership.go`. `Manager.Allocate` untouched; `session.go`, `recording.go`,
`codec.go`, `jitter.go` untouched. Two files outside that list were touched and are called out below.

## R19 · Reverse indexes — FIXED

Verified: `unbridgeSessionLocked`/`BridgeOf` scanned `m.bridges`, `conferenceOfLocked` scanned every room
taking each room's lock, `leaveConferenceLocked` scanned rooms, tap cleanup scanned `m.taps` — all under
`m.mu`, and `ReapIdle` did the lot per expired session.

Added to `Manager`, written only beside their forward maps under `m.mu`:
`bridgeBySession`, `conferenceBySession`, `tapsBySession`, `tapsByConference`. `Bridge`, `detachLocked`,
`JoinConference`, `leaveConferenceLocked`, `DestroyConference`, `Tap`/`Untap` and `Drain` maintain them;
`BridgeOf`, `ConferenceOf`, `unbridgeSessionLocked` and `leaveConferenceLocked` are now O(1) plus the real
detach. Tap removal by session and by room went through two new helpers (`forgetTapLocked`,
`forgetTapsOfSessionLocked`) so the three tap indexes cannot drift.

Test added: `TestASessionIsInExactlyOneConversationThroughEveryTransition` walks a leg through
fresh → bridged → re-bridged → room → re-pointed → left and holds `BridgeOf`/`ConferenceOf`/`Unbridge` to
the same answer at each step. Benchmark `BenchmarkBridgeLookup` added (replaces the review's
`BenchmarkReviewMissingBridgeLookup`).

## R12 · Bridge-id re-use — FIXED (probe PASSES)

Verified: `Bridge` detached the two incoming sessions but never the pair already stored under `bridgeID`,
then overwrote the entry. `Bridge(shared,a,b); Bridge(shared,c,d); Unbridge(shared)` left a↔b relaying and
unaddressable.

`Bridge` now detaches whatever the id was bound to before it detaches the incoming sessions. Doc comment
updated to say so (R24-style drift: it promised "re-pointable" without this).

Probe: `TestReviewBridgeIDReplacementDetachesPreviousPair` PASSES.
Test added: `TestReusingABridgeIDForADifferentPairDetachesTheFirstOne`.

## R13 · Failed conference join — FIXED (probe PASSES)

Verified: `JoinConference` unbridged and left the current room, then called `conference.join`, which built
the codec pair and could refuse — an Opus leg asked into a mix lost its bridge to the error. There was also
an unlocked gap between fetching the session and seating it.

Restructured into prepare-then-commit:

- `newMember(session, opts)` (mixer.go) builds decoder/encoder/jitter and mutates nothing; it is the only
  step that can refuse and it now runs first, outside `m.mu`.
- `Conference.seat(prepared)` installs or re-points a seat and is infallible, so the commit needs no unwind.
- `JoinConference` re-acquires `m.mu`, re-checks `m.closed` and re-checks the session **by pointer** (an id
  can be released and reallocated while the codecs are built), then detaches and seats under the one lock.
  `destroyConferenceIfEmpty` is gone — a room created for a join can no longer fail to take it.

Probe: `TestReviewFailedConferenceJoinPreservesBridge` PASSES.
Test added: `TestARefusedConferenceJoinLeavesTheExistingConversationIntact` (bridge intact, `BridgeOf`
unchanged, no room left running).

## R14 · Empty-room cleanup — FIXED (probe PASSES)

Verified: `Bridge`, `JoinConference` and `ReapIdle` called `leaveConferenceLocked`, which did not do the
empty-room reap that public `LeaveConference`/`Release` did via `destroyConferenceIfEmpty`.

`leaveConferenceLocked` is now the single departure operation. It returns
`(conferenceID string, emptied *Conference, ok bool)`: a room the departure emptied is unindexed (with its
taps) inside the lock and **returned** rather than stopped, because `Stop` wakes the mix loop, which takes
the room lock. Every caller passes it to the new `stopEmptied` after releasing `m.mu` — in `Bridge` and
`JoinConference` via a defer registered _before_ the unlock defer, so it runs after it.

Probe: `TestReviewMovingLastMemberDestroysEmptyConference` PASSES.
Tests added: `TestEveryDepartureDestroysTheRoomItEmptied` (four subtests: explicit leave, release, move into
a bridge, move into another room — each asserting the room is unindexed **and** its mix loop's `Done()` is
closed) and `TestIdleReapingDestroysTheRoomItEmptied`.

## R20 · Quadratic unrestricted mix — FIXED

Verified: `mixOnce` called `addRestrictedLocked` for every unrestricted listener, and that scanned all of
`c.order`, so a plain room cost O(NF + N²) despite the accumulator's O(NF) design.

`Conference` now carries `restricted []string` — the sub-list of `order` whose `speakTo` is enumerated,
rebuilt by `refreshRestrictedLocked` on every seating change (`seat`, re-point, `leave`). `mixOnce` skips the
restricted pass entirely when it is empty, and `addRestrictedLocked` walks that list instead of the room.
Common case is O(NF); sparse special routing is O(NF + EF). Restricted _listeners_ keep their existing
per-listener adjacency walk. Nothing about mix-minus, gain, clamping or the writes-outside-the-lock rule
changed; existing mixer and tap suites (mix-minus, saturation, gain, mute, the three supervision modes,
tap re-point, untap) pass unchanged and are the correctness evidence.

## R11 · Overlapping resource sets — PARTIAL (probe PASSES)

Verified: `orderingKey` joined the whole sorted session set, so `{a,b}` and `{a}` produced different keys and
`bridge(a,b)` ran concurrently with `release(a)`.

`orderingKey` now returns one representative — the lowest id the request names — so any request naming a
subset that contains the representative lands on the same FIFO chain. Added `Server.orderingKeyFor`, which
resolves a reference-only command (`stop-playback`, `stop-recording`, `unbridge`, `untap`) back to the
session recorded under that resource key in the router's existing `tracked` index, so a stop chains behind
the start that created it instead of running beside it; an unseen reference falls back to the stable
resource key. `control.go`'s one `Submit` call site now uses it.

Probe: `TestReviewOverlappingCommandsSerialize` PASSES.
Test: `runner_test.go`'s ordering-key table updated to the new contract (renamed
`TestTheOrderingKeyNamesTheConversationARequestTouches`, with a subset-shares-the-pair's-chain row).

**Why partial.** Two requests whose session sets overlap but whose _lowest_ ids differ — `bridge(b,c)` and
`bridge(a,b)` — still get different chains. Closing that needs multi-resource reservation in the runner
(`Submit` taking a key set and reserving in canonical order), which is `internal/control/runner.go` —
**agent C's file**, and the review's own probe only exercises `orderingKey`. Cross-area request: C should
consider a `SubmitKeys([]string)` on `keyedRunner`; `orderingKey` can then go back to returning the full set.
Note this is an ordering guarantee, not a memory-safety one: every `Manager` topology operation is atomic
under `m.mu`, and with R12/R13/R14 fixed either interleaving of two overlapping bridges leaves a consistent
topology.

## Benchmarks (darwin/arm64, Apple M5 Max, Go 1.26.5)

Bridge lookup — `unbridgeSessionLocked` on a manager holding N unrelated bridges (before = the review's
`BenchmarkReviewMissingBridgeLookup`, re-measured on a HEAD worktree):

| bridges | before       | after      |
| ------- | ------------ | ---------- |
| 100     | 405.6 ns/op  | 6.17 ns/op |
| 1,000   | 5,205 ns/op  | 3.74 ns/op |
| 10,000  | 48,598 ns/op | 3.70 ns/op |

Mixer tick, `-benchtime 200x -count=3` (the benchmark includes one real UDP write per member, so it is
noisy; medians shown, 128 confirmed over 10 further runs at `-benchtime 500x`):

| members | before      | after       |
| ------- | ----------- | ----------- |
| 8       | 63.4 µs/op  | 60.1 µs/op  |
| 32      | 141.9 µs/op | 150.2 µs/op |
| 128     | ~700 µs/op  | ~550 µs/op  |

These are local microbenchmarks, not call-capacity numbers. 8 and 32 are inside the noise, as expected —
the N² term only becomes visible at 128, and even there the per-member socket write dominates.

## Files touched outside the stated ownership list

- `apps/mediad/internal/control/control.go` — one line, the `Submit` call site for `orderingKeyFor`.
- `apps/mediad/internal/control/runner_test.go` (agent C's file) — the ordering-key table is the test for my
  function; expectations updated to the new contract. Nothing else in it changed.
- `apps/mediad/internal/rtp/bench_test.go` — added `BenchmarkMixTick128` and `BenchmarkBridgeLookup`, adapted
  `benchConference` to `newMember`+`seat`. **Also** repaired `BenchmarkRecordingEnqueue`, which agent A's
  `capturedFrame` change to `recording.go` had left uncompilable (two `chan []byte` → `chan capturedFrame`);
  the package would not build otherwise. Agent A should confirm that is what they intended.

## Verification

- `gofmt -l .` clean; `go vet ./...` clean, and clean under `-tags integration`, `e2e`, `load`, `loadtest`.
- `go test -race -count=1 -p 1 ./...` in `apps/mediad` — all packages ok.
- Review probes for my findings: R11, R12, R13, R14 all PASS.
  R12/R13/R14 were run through a trimmed copy of `probe_2_test.go` (scratchpad `bprobe/`) for two reasons the
  probe file, not the implementation, is responsible for: it no longer compiles against agent A's
  `Recording` struct, and it hand-builds `&Manager{...}` as a literal, so it needs the new index maps added
  to that literal. Assertions are byte-identical otherwise, and all six are promoted into
  `apps/mediad/internal/rtp/topology_test.go`.
- No commits made.
