# REVIEWFIX-A2 — R09's remaining half: the conference mixer paced by media time

Scope: `apps/mediad/internal/rtp/mixer.go` only, plus a new test file
`apps/mediad/internal/rtp/mixerpacing_test.go`. `conference.go` needed no change — `Member` and
`mixOnce` both live in `mixer.go`. `internal/control` and `Manager.Allocate` untouched (agent C).

## The defect, confirmed

`mixOnce` did `frame, ok := member.jitter.Pop()` then `member.decoder.DecodeFrame(frame)` — one
**packet** per tick, forced to exactly `FrameSamples` by `padFrame`. So per 20 ms room tick a member
sending 30 ms packets contributed 20 ms of a 30 ms packet and threw the other 10 ms away (their
stream drifts 1.5× fast and then runs dry), and a member sending 10 ms packets contributed 10 ms of
audio padded with 10 ms of silence (half-speed, chopped). 60 ms members drained three times too
fast. Only 20 ms senders were mixed correctly. Reproduced directly — see "Before/after" below.

## Fix

A per-member **linear sample queue**, filled from as many arrivals as one tick of media time costs.

- `Member` gains `pending []int16` (mix-bus samples decoded but not yet mixed), allocated once in
  `newMember` at `cap = FrameSamples + maxPacketSamples` (new constant: 60 ms, the longest
  packetisation RFC 3551 §4.1 expects). The remainder a tick leaves is always shorter than one
  packet, so the queue never regrows.
- New `Member.takeContribution()` replaces the pop-decode-scale block inside `mixOnce`:
  pops and `audio.FrameDecoder.Decode`s (agent A's new exact-sample-count entry point, **not**
  `DecodeFrame`) until `pending` covers 20 ms, appends into the queue, recycles each jitter frame,
  writes the gained 20 ms into `contribution`, then shifts the remainder down inside the same
  backing array (`append(pending[:0], pending[FrameSamples:]...)` — a memmove, no allocation).
- A tick the buffer cannot cover is padded with silence rather than stalled: the room stays on its
  clock, and an empty queue is `clear(contribution)` exactly as before.
- **Timestamp continuity**: the decoder now sees every arrived sample exactly once and in order, so
  G.722's predictor and the resampler history stay continuous instead of being reset by discarded
  tail samples. Outbound timestamps are untouched — `sendMixFrame` still steps one 20 ms frame per
  tick off the session's own clock.
- **Nothing else moved.** `mixOnce`'s accumulate → mix-minus → restricted → clamp → encode structure,
  agent B's `restricted` sub-list and per-listener adjacency walk, the room lock scope (writes still
  collected into `c.pending` and sent outside `c.mu`), and the `total`/`mixed`/`out` scratch reuse
  are all unchanged. The only edits inside `mixOnce` are `member.takeContribution()` in place of the
  old five-statement block, and step 1 of its doc comment.

R24-style comment drift fixed in the file touched: `mixOnce`'s step 1 said "Each member's next frame
is popped, decoded" — that _was_ the bug's description; it now says 20 ms of media time is taken off
the member's queue, refilled from as many arrivals as that costs.

## Tests added — `internal/rtp/mixerpacing_test.go`

All three drive the mixer's clock by hand through the existing `confRig`, on real sockets.

1. `TestATickConsumesTwentyMillisecondsOfMediaWhateverThePacketisation` — 4 subtests
   (10/20/30/60 ms). A speaker whose every packet carries its own level, plus a silent listener; the
   first sample of the listener's mixed frame on tick _k_ must be media sample `k*160` of the
   speaker's stream. Expected packet index per tick: 10 ms `[0,2,4,6,8,10]`, 20 ms `[0..5]`, 30 ms
   `[0,0,1,2,2,3]`, 60 ms `[0,0,0,1,1,1]`.
2. `TestOneRoomMixesMembersOnDifferentPacketisations` — **mixed durations in one room**: four
   members at 10/20/30/60 ms, each a constant level, each hearing the sum of the other three on
   every one of 8 ticks. Catches the 30/60 ms members running dry.
3. `TestMediaTimePacingSurvivesReorderingAndLoss` — 30 ms packets with every neighbouring pair
   swapped and one packet never sent: the room keeps producing frames, a lost 30 ms packet costs at
   most two 20 ms frames, and the stream is not permanently skewed afterwards.

Two new `confRig` helpers: `packetise` (send N packets of an arbitrary sample count) and `latch`
(one sub-priming packet, so a pure listener's session has a remote address to write to).

Existing mixer/tap suites — mix-minus, saturation, gain, mute, the three supervision modes, tap
re-point, untap — pass unchanged and are the evidence that B's mix-minus/restricted routing survived.

**Before/after on the tests themselves** (mixer.go temporarily reverted to the packet-per-tick loop):
tests 1 and 2 FAIL on the old code across 10/30/60 ms (e.g. 30 ms tick 1 heard packet 1's level where
media time says packet 0; the mixed-room test loses three of four members from tick 4), and PASS on
the new. Test 3 passes either way — it is a robustness assertion, not a discriminator.

## Benchmark — `BenchmarkMixTick{8,32,128}`, `-benchtime 200x -count=3`, darwin/arm64 Apple M5 Max

Both columns measured in this session on this machine; "before" is the same working tree with only
the `mixOnce` block reverted, so the comparison isolates the change.

| members | before (median) | after (median) | allocs/op before → after |
| ------- | --------------- | -------------- | ------------------------ |
| 8       | 45.4 µs/op      | 46.4 µs/op     | 8 → 8                    |
| 32      | 167.6 µs/op     | 167.8 µs/op    | 33 → 33                  |
| 128     | 730.4 µs/op     | 661.7 µs/op    | 133 → 132                |

No regression, and no regression against REVIEWFIX-B's numbers (60.1 / 150.2 / ~550 µs — same
ordering and magnitude; the benchmark includes one real UDP write per member and is noisy at 8/32,
as B noted). `B/op` fell slightly at every size. Zero per-tick allocation from the sample queue is
what the unchanged allocs/op shows.

## Verification (`apps/mediad`)

- `gofmt -l internal/rtp internal/audio` → clean.
- `go vet ./internal/rtp/ ./internal/audio/` → clean, and clean under `-tags` `integration`, `e2e`,
  `load`, `loadtest`.
- `go test -race -count=1 -p 1 ./...` minus `internal/control` → **all ok** (audio, config, events,
  metrics, rtp, sdp, webrtc; cmd/mediad and directory have no test files). `internal/rtp` run 6× in
  a row, race-clean and stable.
- **Not mine, reported not fixed:** `internal/control` was uncompilable mid-run (agent C's
  `s.pendingSRTP`) and, once it compiled, one test there fails on an `a=sendonly` SDP answer. That
  package is agent C's and I did not touch it, so the module-wide `go vet ./...` /
  `go test ./...` lines cannot be reported green from here — everything outside `internal/control`
  is.
- One `TestBridgeRelaysAudioBothWays` failure was seen in a single run immediately after restoring
  a file mid-experiment; it did not reproduce in eight subsequent full-package runs (agent A
  recorded the same transient).

No restarts, no commits, no git state touched.
