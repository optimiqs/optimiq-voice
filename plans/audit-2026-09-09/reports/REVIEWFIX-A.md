# REVIEWFIX-A — mediad media path (R01, R08, R09, R10, R21)

All five findings verified against current code, all five FIXED. Every review probe for this area
passes; each assertion is promoted into a regression test beside the implementation.

## R01 · P1 · Recording pause could retain and later write paused audio — FIXED

Verified: `enqueue` had no pause check, and `mixOneFrame`'s paused branch dropped exactly one frame
per direction per 20 ms tick, so a backlog (queue depth 25) outlived the pause. The `paused` field's
comment claimed the opposite (R24 drift) — corrected.

Fix (`internal/rtp/recording.go`): a recording **epoch** (`atomic.Uint64`) bumped on every pause and
every resume, stamped on each frame **at capture** (`capturedFrame{epoch, payload}`, queues are now
`chan capturedFrame`).

- Capture side: `enqueue` reads the epoch _first_, then refuses while paused — a pause that wins the
  race leaves the frame stamped with an epoch consumption will refuse, which is the safe order.
- Consumption side: `takeFrame` drops any frame whose epoch is not current; the paused tick calls
  `discardStale`, which clears both queues and the assembled media time outright rather than draining
  one frame per tick.
- `SetPaused` bumps the epoch _before_ the flag, under `pauseMu`; `closePauses` bumps it on the
  implicit resume at finish. Audio refused by the pause is not counted in `Dropped()` (that counter
  still means "the queue was full").

Probe `TestReviewPauseDoesNotReplayPausedAudio`: PASS.
Tests added (`internal/rtp/mediapath_test.go`): `TestPausedAudioIsNeverWrittenHoweverFarTheQueueIsBehind`
(both directions, 10-frame backlog, 12 ticks after resume), `TestPausedAudioIsRefusedAtCaptureRatherThanCounted`.

**Note for reviewers:** the probe file's `Recording` literal (`received: make(chan []byte, 25)`) no
longer compiles by construction, since the epoch has to travel with the payload. It was run against
an adapted copy (only the two `make(chan …)` calls changed) to confirm PASS.

## R08 · P2 · Same-codec relay preserved the source's dynamic audio PT — FIXED

Verified at `session.go` `forward`: `payloadType` was only overwritten inside the transcoder branch,
so an Opus-111 → Opus-112 bridge put 111 on the wire.

Fix: the default branch now sets `payloadType = s.AudioPayloadType()` unconditionally, with encoding
left conditional on the transcoder — the zero-decode fast path is untouched, O(1) header work.
Unnegotiated types are still rejected upstream in `handlePacket.accepts`. `relay`'s doc comment
("Payload type is TRANSLATED for telephone-event only") was drift and is corrected.

Probe `TestReviewRelayTranslatesDynamicAudioPayload`: PASS.
Test added: `TestForwardTranslatesAudioOntoTheDestinationsNegotiatedPayloadType`.

## R09 · P2 · Codec/mixer/recorder assumed one packet = 20 ms — FIXED (relay + recorder), PARTIAL (mixer)

Verified: `FrameDecoder.DecodeFrame`/`FrameEncoder.EncodeFrame` both went through `padFrame`, so a
30 ms G.711 packet lost 10 ms in `Transcoder.Translate`; the recorder consumed one _packet_ per tick.

Fix — **decoding separated from packetisation** (`internal/audio/codec.go`):

- `FrameDecoder` gains `Decode(payload) []int16` (the samples actually carried) and `FrameEncoder`
  gains `Encode(samples) []byte` (exactly those samples). Both G.711 and G.722 implementations
  already had variable-length `*Into` helpers, so this is plumbing, not new DSP.
- `DecodeFrame`/`EncodeFrame` stay as the fixed 20 ms views — the mixer's contract is unchanged.
- `Transcoder.Translate` now uses `Decode`/`Encode`, so translation preserves media time exactly:
  10/20/30/60 ms in, the same duration out, codec state and RTP timestamps continuous. Every codec on
  this path carries one octet per 8 kHz sample, so no repacketisation buffer is needed; the
  transcode.go header comment that asserted "160 octets for 20 ms" is corrected.
- Recorder: `mixOneFrame` now assembles each 20 ms frame from a per-direction linear sample queue
  (`takeFrame`), so a sender on 30 ms packetisation produces a file whose duration is the call's
  duration instead of drifting 1.5× fast. The remainder at the tail of a stream is padded with
  silence rather than stalling. Buffers are recycled per direction; growth is bounded by the queue.

Probe `TestReviewTranscoderPreservesThirtyMilliseconds`: PASS.
Tests added: `TestDecodeAndEncodeKeepTheSampleCountTheyWereGiven` (audio, 3 codecs × 4 packetisations,
asserts both the exact and the frame view), `TestTranscoderPreservesTheSendersPacketisation`
(3 translation pairs × 4 packetisations), `TestARecordingConsumesArrivalsByMediaTimeRatherThanByPacket`.

**Partial / cross-area:** the _conference_ path still consumes one jitter-buffer payload per mixer
tick (`Member.receive` → `JitterBuffer.Push`, `mixer.go` → `Pop` → `DecodeFrame`). Making that
media-time-paced needs the member's arrival path to queue samples rather than packets, which lives in
`conference.go`/`mixer.go` — **agent B's files**. The codec primitives it needs (`Decode`) now exist.
See "Cross-area needed".

## R10 · P2 · An initially inactive session could not resume relay — FIXED

Verified: `Allocate` set `ModeInactive`, `ApplyDirection` only touched the mute atomics, and
`handlePacket` switched on the immutable `s.mode`.

Fix: **one mechanism, not two.** RFC 3264 `inactive` _is_ both direction gates up (see
`control.directionToMutes`), so `Session.Mode()` now derives the answer instead of storing a second
copy: an allocated-inactive session reports `ModeRelay` as soon as either gate comes down, and
`handlePacket` switches on `Mode()`. No new state, no atomic needed on the `mode` field, no
transition for `ApplyDirection` to keep in step — clearing the gates _is_ the resume. `sendonly` and
`recvonly` after an inactive offer now relay too, with the appropriate gate still suppressing.
`ModeInactive`'s and `ApplyDirection`'s doc comments say so.

I did **not** touch `Manager.Allocate` (agent C). `AllocateOptions.Inactive`'s comment there is now
slightly under-specified — see "Cross-area needed".

Probe `TestReviewResumeInactiveSession`: PASS.
Tests added: `TestAnInactiveSessionRelaysOnceARenegotiationClearsItsGates`,
`TestAnInactiveSessionStaysInactiveWhileBothGatesAreUp`.

## R21 · P2 · Jitter target changes never reached playout; reorder statistics misleading — FIXED

Both halves verified.

**Reorder counter** (`jitter.go` `Push`): counted every `sequence != j.next`, i.e. every ordinary
arrival ahead of the playout cursor. Now arrival order is tracked separately (`highest`/`seen`, wrap-
safe via `sequenceAfterOrEqual`) and only an arrival _behind_ a sequence already seen counts.

**Live playout**: a changed target only affected a later re-prime. Now the buffer carries explicit,
bounded playout debt:

- `deepenLocked(applyToPlayout)` replaces the shared `adaptOnLossLocked` body. An **underrun**
  already cost a tick of delay, so it owes nothing; a **late arrival** did not interrupt playout, so
  it owes one held tick (`grow++`).
- `Pop` spends that debt: `grow > 0` with frames buffered returns silence for one tick — not counted
  as loss — which is what puts the extra frame between arrival and playout.
- `comfortTickLocked` shrinking the target now owes a skip (`shrink++`); `Pop` skips one frame when
  the buffer is genuinely deeper than the new target, recycling it through the free list.
- Both are counted (`JitterStats.Stretched`, `JitterStats.Shrunk`) so the behaviour is assertable and
  visible in leg diagnostics. Bounded by the existing depth bounds; the map is untouched.

Probe `TestReviewInOrderJitterPacketsAreNotReordered`: PASS.
Tests added: `TestJitterBufferDoesNotCountInOrderArrivalsAsReordered`,
`TestJitterBufferCountsOnlyArrivalsBehindASequenceAlreadySeen`,
`TestJitterBufferAppliesADeepenedTargetToLivePlayout` (asserts the held tick, the retained frame, no
loss, and that playout resumes).

## R24-style comment drift fixed in files touched

- `recording.go`: the `paused` field comment and `mixOneFrame`'s doc both claimed the one-frame drain
  kept paused audio out of the file. It did not.
- `session.go`: `relay`'s doc claimed the payload type is translated for telephone-event only;
  `ModeInactive`'s doc did not say the gates outrank it.
- `transcode.go`: the header asserted "PCMU, PCMA and G.722 all produce 160 octets for 20 ms, so no
  repacketisation buffer is needed" — the second clause is true for a different reason than the first.
- `codec.go`: the package note and both interface docs promised a fixed-frame contract that is now
  one of two.
- `manager.go`: `ApplyDirection`'s doc now states that the gates are the only record of direction.

## Cross-area needed

1. **Agent B (`conference.go` / `mixer.go`)** — the R09 mixer half. `Member.receive` pushes whole
   packets into the jitter buffer and `mixOneFrame` pops one per tick, so a conference member on
   10/30/60 ms packetisation drifts. Use `audio.FrameDecoder.Decode` (new, exact sample count) and
   pace the seat by media time. I did not touch either file.
2. **Agent C (`manager.go` `Allocate` / `control/handlers.go`)** — comment only, no behaviour:
   `AllocateOptions.Inactive` ("puts the session in ModeInactive") and `directionToMutes`' table
   ("the session is additionally put in ModeInactive") should now say that `inactive` is both gates
   up and that the mode follows from them, per R10's fix.
3. **Shared test file** `internal/rtp/bench_test.go` — `benchRecording`'s channel literal had to
   follow `capturedFrame`. It is also being edited by agent B (`newMember`/`seat`); flagging the
   overlap.

## Verification

Module `apps/mediad`, run after every change:

- `gofmt -l .` → no output.
- `go vet ./...` → clean. `go vet -tags loadtest ./internal/rtp/` and `go build -tags loadtest ./...`
  → clean (the one build tag in the module).
- `go test -race -count=1 -p 1 ./...` → **10 packages: 8 ok, 2 no test files, 0 fail.**
  (audio, config, control, events, metrics, rtp, sdp, webrtc all `ok`; cmd/mediad and directory have
  no test files.)
- Review probes, adapted overlay, `-run TestReview…` on `./apps/mediad/internal/rtp`:
  `RelayTranslatesDynamicAudioPayload`, `PauseDoesNotReplayPausedAudio`,
  `TranscoderPreservesThirtyMilliseconds`, `ResumeInactiveSession`,
  `InOrderJitterPacketsAreNotReordered` → **5 PASS, 0 FAIL.**

One transient `TestBridgeRelaysAudioBothWays` failure was observed mid-run while agent B was writing
`conference.go`/`mixer.go`; it does not reproduce (re-ran the package with and without `-race`, clean).

No commits, no git state touched.
