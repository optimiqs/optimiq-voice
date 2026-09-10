# FINAL — apps/mediad + packages/runtime-go

Closes out the comment sweep, the modern-Go pass and the NET-mediad-rtp follow-ups for the whole
mediad module and runtime-go. No commits; working tree only.

## 1. Comment sweep (COMMENT_POLICY.md)

Comment lines per package, `cat $(find <pkg> -name '*.go') | grep -cE '^\s*//'`.

| package               | before    | after     | delta             |
| --------------------- | --------- | --------- | ----------------- |
| `internal/rtp`        | 2 355     | 1 779     | −576 (−24%)       |
| `internal/audio`      | 830       | 467       | −363 (−44%)       |
| `internal/sdp`        | 231       | 174       | −57 (−25%)        |
| `internal/config`     | 215       | 122       | −93 (−43%)        |
| `cmd/mediad`          | 40        | 34        | −6 (−15%)         |
| `packages/runtime-go` | 45        | 45        | 0                 |
| **swept this pass**   | **3 716** | **2 621** | **−1 095 (−29%)** |

Already swept in the earlier pass and left alone: `internal/control` (808), `internal/webrtc` (30),
`internal/directory` (57), `internal/events` (53). Within `internal/rtp`, `internal/audio` and
`internal/sdp` the files the previous agent had already swept were also left alone; only the 21 rtp
files, 14 audio files and 3 sdp test files still outstanding were touched.

`runtime-go` was fully swept previously and is already inside policy; nothing to remove.

Per-file detail for the newly swept files (before → after):

_internal/rtp_: conference 154→86, recording 160→99, hold 156→84, dtmfdetect 169→96, dtmf 122→75,
transcode 77→42, dtmfdetect_test 87→57, mixer_test 67→39, bridge_test 63→51, tap_test 52→36,
jitter_test 49→31, playback_test 48→34, hold_test 44→25, dtmf_test 42→33, rtcp_test 36→21,
recording_test 35→26, transcode_test 29→17, manager_test 26→19, loop_test 25→14,
terminate_test 24→12, allocator_test 23→15.

_internal/audio_: library 136→58, tone 125→56, g722 95→54, wavwriter 78→40, wav 72→46,
resample 61→33, wav_test 32→23, tone_test 31→18, g722_test 25→15, wavwriter_test 18→12,
resample_test 17→7, source_test 16→9, codec_test 14→8, library_test 12→9.

_internal/sdp_: sdp_test 38→24, codec_test 19→14, bench_test 0→0.
_internal/config_: config 180→106, config_test 35→16.

What went: rung/plan-document references and history prose ("used to", "before this wave", "RUNG 7
CHANGED THIS CASE"), design essays arguing for a decision rather than stating it (library.go's
HTTP-vs-mount argument, resample.go's mix-rate essay, g722.go's cgo/Opus rejection, config.go's
per-variable rationale paragraphs), section banners, and test prose restating the test name.
What stayed, tightened to 1–3 lines: godoc on every exported identifier, package docs reduced to
role plus invariants, RFC citations (3550 §11, 3551 §4.5.2, 3264 §5.1, 4566 §6, 4733 §2.5.1.2,
3605, 7587 §7), ownership/locking and race-ordering invariants, and the path-traversal note on
`audio.Resolve`.

### Comments corrected as factually wrong

- `internal/rtp/dtmf.go` — the RFC 4733 §2.5.1.2 marker-bit note sat above `SequenceNumber` in the
  header literal; moved above `Marker`, which is what it describes.
- `internal/rtp/session.go` — `FormatDefault`'s doc stated the intent but not its consequence; see
  §3(d), where the rule is now stated and pinned by a test.

No other comment was found to contradict its code. No generated files were in scope.

## 2. Modern Go guidelines applied

Behaviour-neutral throughout; no test assertion was changed to accommodate a rewrite.

**`slices.Clone`** — 17 sites: `internal/events/events.go` (5 accessors),
`internal/control/control_test.go` (11 accessors), `internal/rtp/mixer.go` `Members()`,
plus `internal/rtp/bridge_test.go` (3) and `audio/g722_test.go` (nested append → `append(slices.Clone(a), b...)`).

**Kept as `append([]T{}, …)` deliberately** — `internal/control/ownership.go:254`
(`routingFailure`'s `sessionIds`): a nil clone marshals as `null` where the wire contract sends
`[]`. The existing comment says so; left exactly as it was.

**`range` over int** — ~40 sites: `allocator.go:108` (see below), `rtcp.go:182`, `dtmf.go` (2),
`dtmfdetect.go`, `session.go:369`, `directory/owners.go:60`, `control/browser_integration_test.go:167`,
`control/lifecycle_test.go`, `audio/g722.go` (3), `audio/resample.go` (2), `audio/wavwriter.go`,
`audio/wav_test.go`, `audio/wavwriter_test.go` (2), and ~25 in the rtp tests.

`allocator.go:108` was previously skipped on the belief that `a.Capacity()` is re-evaluated per
iteration. It is `(a.high-a.low+1)/2` over immutable fields, so it is loop-invariant: hoisted to a
local and converted.

**`t.Context()`** — 6 sites: `webrtc/transport_test.go:28`, `control/browser_integration_test.go:44`,
`control/lifecycle_test.go:451`, `rtp/bridge_test.go:741`, `rtp/manager_test.go:387`,
`rtp/loadtest_test.go:124`, plus `runtime-go/health/health_test.go:11`.

**`strings.SplitSeq`** — `webrtc/transport.go:207` (`setupRole`), `audio/library.go` (`Resolve`'s
traversal check), `audio/tone.go` (2).

**`min` / `max`** — `manager.go` (`min(drainCloseWorkers, len(live))`), `dtmf.go` (2 clamps),
`dtmfdetect.go`, `recording.go` (`max(frames, 1)`), `audio/wavwriter.go` (`MixInto`).

**`clear`** — `mixer.go`, three zeroing loops (`member.contribution`, `mixed`, `c.total`).

**`wg.Go`** — `cmd/mediad/main.go` (reaper), `manager.go` (drain worker pool),
`rtp/manager_test.go`, `rtp/allocator_test.go`.

**`slices.Sorted` + `maps.Keys`** — `audio/tone.go` `StandardToneNames`, replacing a handwritten
insertion sort over the map keys.

**`errors.Is` / `errors.AsType`** — audited across the module; every error comparison already uses
`errors.Is`, and there is no `errors.As` call to convert. The `err == nil` sites are nil checks,
not sentinel comparisons.

### Deliberately skipped (with reasons)

- `rtp/playback.go` run loop — the body rewinds `index = -1` to loop the prompt, which a range loop
  cannot express. Converted, the loop tests failed, reverted, and a one-line note added so a later
  pass does not repeat it.
- `context.WithTimeout(context.Background(), …)` inside `t.Cleanup` / `b.Cleanup` bodies (8 sites) —
  `t.Context()` is cancelled _before_ cleanup runs, so the drain would receive a dead context.
- 1-based inclusive loops (`for i := 1; i <= n; i++`) and countdown/step loops in `g722.go`,
  `dtmf.go` and `rtcp.go:152` — not range-over-int shapes without changing the arithmetic.
- `audio/wav.go` `for index := copied; index < FrameSamples; index++` — not 0-based, and `clear`
  does not apply: the pad value is the encoding's silence byte, not zero.

## 3. Follow-ups from NET-mediad-rtp.md

### (a) Duplicate SDP parse in `internal/control/handlers.go`

Both paths did parse, so both were changed. `ParseOffer` returns `Offer.AudioProtocol`, so each
handler now parses once and reads the transport off the parse; the transport-only `sdp.AudioProtocol`
reader runs **only** when that parse failed — which is what preserves refusal precedence exactly:

- allocate (was :47 + :65) — a SAVPF offer still reaches `allocateWebRTC` even when its codecs are
  ones `ParseOffer` rejects, and an unsupported transport is still refused ahead of the codecs and
  ahead of a bad direction.
- accept-answer (was :322 + :346) — same shape; the WebRTC `AcceptAnswer` call still runs before any
  codec refusal is reported.

Tests added: `TestAnUnsupportedTransportIsRefusedAheadOfTheCodecs` and
`TestABadDirectionIsRefusedAheadOfTheCodecs` (control), both of which fail if the parse is reordered
naively. All pre-existing control tests pass unchanged.

### (b) `MEDIAD_RTP_SOCKET_BUFFER_BYTES` and `MEDIAD_PPROF` moved into `internal/config`

Now `Config.RTPSocketBufferBytes` (default `1<<19`, 0 = kernel default) and `Config.EnablePprof`
(default false), resolved through the package's own `intOr` / `boolOr` and validated in `Load`.
`cmd/mediad/main.go` lost both `os.Getenv` reads and its private `envInt` helper (and the now-unused
`strconv`/`strings` imports).

Defaults and meaning are identical. Validation is deliberately **stricter**, which is the point of
moving them: an unparseable value used to fall back silently, and is now a boot refusal collected
with every other configuration problem — consistent with all 15 other knobs. A negative buffer is
refused by name. `MEDIAD_PPROF` also widens from `strings.EqualFold(…, "true")` to
`strconv.ParseBool`, so `1`/`t`/`True` now work where they were silently false before; every
previously-valid value keeps its meaning.

Tests: `TestSocketBufferAndPprofAreConfigured`, `TestZeroSocketBufferLeavesTheKernelDefault`, two
new defaults assertions in `TestLoadDefaults`, and three new `TestLoadRejectsBadConfiguration`
cases (negative buffer, unparseable buffer, unparseable pprof switch).

### (c) RTCP-goroutine folding and single-port ICE mux

Not implemented, as instructed. Both remain recommendations in NET-mediad-rtp.md /
NET-mediad-control.md.

### (d) Extra items requested mid-task

1. **`ErrNoCommonCodec` named a stale codec set** ("want PCMU or PCMA" while G.722 and Opus are
   negotiable). The message is now built from `preferenceOrder`, so adding a codec cannot leave the
   refusal stale. Test: `TestNoCommonCodecNamesEveryNegotiableCodec`.
2. **`BuildAnswer` could render Opus under PT 0.** Added `Codec.IsDynamic`, `Answer.Validate` and the
   typed `ErrNoPayloadType`; the allocate handler validates before rendering and, on failure, logs,
   releases the port pair and refuses rather than emitting a body the far end would read as PCMU.
   `BuildAnswer` itself stays a pure renderer with an unchanged signature — the guard is the new
   `Validate` seam, so no caller or existing test had to change. Tests:
   `TestAnswerValidationRefusesADynamicCodecWithNoPayloadType`,
   `TestAnswerValidationAcceptsStaticCodecsWithoutAPayloadType`,
   `TestAnswerValidationRefusesAnUnnegotiatedAnswer` (new file `internal/sdp/negotiation_test.go`).
3. **`NewSession`'s `format == FormatDefault`.** Decision: **the payload type wins**, and the code
   was already doing that — it is the comment that was incomplete. `FormatDefault` now states the
   rule and its consequence explicitly (an explicit `FormatULaw` with `PayloadTypePCMA` yields an
   A-law session, because the payload type is what goes on the wire and both are derived from the
   same offer). No behaviour change. Test `TestTheStaticPayloadTypeDecidesTheFormat` pins all six
   cases, including that a non-µ-law explicit format survives a contradicting number and that Opus
   must be named rather than numbered.

## 4. Verification

```
apps/mediad
  gofmt -l .                                  → clean
  go vet ./...                                → clean
  go vet -tags loadtest ./internal/rtp/       → clean
  go test -race -count=1 ./...                → ok, all 7 test packages, one parallel run
                                                 (audio 1.5s, config 1.3s, control 1.9s,
                                                  events 2.0s, rtp 8.6s, sdp 1.9s, webrtc 2.3s)
  RUN_BROWSER_WEBRTC=1 go test -race -count=1
      -run TestChromium ./internal/control/   → PASS (2 subtests, real Chromium via Playwright)
  623 tests/subtests pass

packages/runtime-go
  gofmt -l .                                  → clean
  go vet ./...                                → clean
  go test -race -count=1 ./...                → ok (health, netbuf, proclimit); 8 tests pass
```

### On the reported internal/rtp ↔ internal/webrtc port collision

**Confirmed fixed.** `go test -race -count=1 ./...` runs all packages in parallel and is green;
`internal/webrtc` (37000–37199) and `internal/rtp` no longer contend.

**But a different, still-live flakiness was found.** A first `-count=1` run failed five
`internal/rtp` allocator tests with "every port pair in the configured range is in use
(0/5 from 51000-51009)". Cause: `lsof` showed UDP 51007 held by a _concurrently running_
`sipd.test -test.run=TestLoadPresenceFanout` from another agent's session. The rtp allocator tests
hardcode 51000–51009 (and 54000+), which sit inside the macOS ephemeral range 49152–65535, so any
other process on the machine can take one and the tests fail with an unrelated-looking exhaustion
error. Once that sipd test exited, the same command passed with no code change.

Recommendation (not implemented — it is a test-infrastructure change touching both modules): move
the mediad and sipd test port ranges below the ephemeral floor, or have the test allocator bind a
probe socket and skip/retry on a range it cannot fully claim. Left as a follow-up because it is
cross-area and unrelated to this pass.
