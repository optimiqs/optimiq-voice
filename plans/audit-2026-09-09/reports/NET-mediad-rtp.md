# NET-mediad-rtp — mediad RTP/audio/SDP packet path

Area: `apps/mediad/internal/rtp`, `internal/audio`, `internal/sdp`, `cmd/mediad`, `apps/mediad/Dockerfile`,
`packages/runtime-go`. Machine: Apple M5 Max, 18 cores, macOS, **other agents loading the same box throughout**.

## Headline

The RTP packet path is **syscall-bound, not CPU- or lock-bound**. Under load at 500 bridged pairs the CPU profile is
60% `syscall.rawsyscalln` and 21% runtime scheduler locks; the mutex profile contains **zero application mutexes** —
100% of it is `runtime.unlock` inside `findRunnable`/`injectglist`. So the wins available were allocations and
garbage, not lock scope, and that is what was taken:

| path                                                         | before                       | after                                                  |
| ------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------ |
| relay packet (parse → demux → rewrite → marshal), no syscall | 110.5 ns, 176 B, 1 alloc     | 99.3 ns, **0 B, 0 allocs** (−10.0% time, p=0.002)      |
| relay packet incl. real `WriteToUDP`                         | 2.73 µs, 178 B, 1 alloc      | ~unchanged time, **4 B, 0 allocs** (−97.8% B/op)       |
| conference tick, 8 members                                   | 35.3 µs, 3 940 B, 31 allocs  | 33.5 µs, **33 B, 8 allocs** (−99.2% B/op, −74% allocs) |
| conference tick, 32 members                                  | 150 µs, 15 760 B, 126 allocs | ~unchanged time, **134 B, 32 allocs** (−99.2% B/op)    |
| transcode one G.711 frame                                    | 557 ns, 160 B, 1 alloc       | 547 ns, **0 B, 0 allocs**                              |
| RTCP sender report                                           | 2.94 µs, 80 B, 2 allocs      | 2.60 µs, **0 B, 0 allocs** (−11.8% time)               |
| playback frame                                               | 3.42 µs, 180 B, 1 alloc      | 3.10 µs, 4 B, 1 alloc (−9.4% time)                     |

`benchstat`, `-count=6`, `-benchtime=50000x`. Allocation numbers are deterministic and trustworthy. **Time numbers are
noisy** — the syscall-bound benchmarks drifted ±20% _between_ runs on a shared box, so the only timing claims made
above are ones that survived an interleaved before/after re-run (`HandlePacketNoSyscall −10.0%`, p=0.002).

Steady-state, 500 bridged pairs, 50 pps per leg, 12 s, real loopback UDP:

```
frames sent=599366 delivered=600039        (0% loss)
mediad received=600366 sent=599869         (0% ingress loss, 0.08% relay loss = the two un-bridged latch frames)
goroutines baseline=2 loaded=5002 after-release=2      (no leak)
heap bytes baseline=433K loaded=9.86M after-release=3.27M
heap per session under load = 9 427 bytes
```

200 pairs: identical, 0% loss. 1000 pairs: 25–47% _ingress_ loss, but the run-to-run spread on the same setting is
20 points, and the harness itself is 4 000 extra goroutines doing 200 k syscalls/s on the same box — **1000 pairs is a
harness/box limit on macOS loopback, not a demonstrated mediad limit.** Report it as "unmeasured above 500".

## Harness — how to re-run

```bash
cd apps/mediad

# micro-benchmarks (internal/rtp/bench_test.go, internal/sdp/bench_test.go)
go test -run xxx -bench . -benchmem -count=6 ./internal/rtp/ ./internal/sdp/

# gated load test (internal/rtp/loadtest_test.go)
go test -tags loadtest -run TestLoad -v -timeout 600s ./internal/rtp/
MEDIAD_LOAD_PAIRS=500 MEDIAD_LOAD_SECONDS=20 MEDIAD_LOAD_SOCKET_BUFFER=524288 \
  go test -tags loadtest -run TestLoad -v -timeout 600s ./internal/rtp/

# profiles
go test -run xxx -bench . -cpuprofile cpu.out -memprofile mem.out ./internal/rtp/
go test -tags loadtest -run TestLoad -mutexprofile mutex.out -blockprofile block.out -cpuprofile cpu.out ./internal/rtp/
```

`bench_test.go` covers: the per-packet read→demux→bridge→write path (with and without the write syscall), the send
half alone, the full loopback round trip through `Session.Run`, the mixer tick at 8 and 32 members, transcode, jitter
push/pop, RTCP report generation, DTMF detection, playback frame scheduling and the recording write path.
`loadtest_test.go` reports delivered/sent frames, mediad's own ingress and relay counters, and goroutines and heap at
baseline, under load, and after every session is released — which is where a leak shows up. `internal/sdp/bench_test.go`
covers the allocate path's parse and build.

## Profiles before any change

**CPU, `BenchmarkHandlePacketRelay` + `BenchmarkMixTick8`** (top frames, 11.32 s of samples):

```
9.46s 83.57%  syscall.rawsyscalln
1.69s 14.93%  runtime.kevent
0.02s  0.18%  (*Conference).mixOnce                    cum 59.54%
   0     0%   (*Session).writeRTP                      cum 64.40%
   0     0%   net.(*UDPConn).WriteToUDP                cum 64.40%
   0     0%   internal/poll.(*FD).WriteToInet4         cum 64.40%
   0     0%   (*Session).sendMixFrame                  cum 59.10%
   0     0%   (*Session).handlePacket / relay / forward cum 5.30%
   0     0%   net.(*UDPConn).ReadFromUDP               cum 19.17%
```

Nothing in mediad's own code appears with flat time. The userspace half of the whole packet path is 110 ns against a
2 600 ns write syscall.

**CPU under load, 500 pairs, 12.9 s (50.5 s of samples, 391% CPU):**

```
30.56s 60.47%  syscall.rawsyscalln
 6.67s 13.20%  runtime.usleep
 6.55s 12.96%  runtime.pthread_cond_wait
 4.02s  7.95%  runtime.pthread_cond_signal
 2.28s  4.51%  runtime.kevent
 0.02s  0.04%  runtime.lock2                    cum 21.35%
    0     0%   (*Session).Run                   cum 27.25%   ← mediad's whole read loop
    0     0%   (*Session).forward/relay/writeRTP cum 17.19%
    0     0%   (*Session).readRTP               cum 10.05%
    0     0%   loadPhone.sendUntil/receiveUntil cum 35.56%   ← the harness itself
```

**Mutex, 500 pairs (21.3 s of delay):** `runtime.unlock` 88.2%, `_LostContendedRuntimeLock` 11.8%, reached through
`findRunnable` (60%), `injectglist` (26%), `mcall` (75%). **No `Session`, `Bridge`, `Manager`, `qualityState` or
`JitterBuffer` mutex appears at all.**

**Block, 500 pairs:** 100% `runtime.selectgo` — 50.6% `(*Session).RunRTCP.func2` (the per-session report ticker parked
on its select) and 49.3% the harness's own senders. Parked time, not contention.

## Fixes

### 1. Pool the outbound marshal buffer — `internal/rtp/transport.go`, `session.go`, `mixer.go`, `playback.go`

Every send path called `pionrtp.Packet.Marshal()`, which allocates a fresh slice per packet: 176–180 B at 50 pps per
leg, so ~50 k allocations/s and ~9 MB/s of garbage on a thousand-call instance. Replaced with `marshalOutbound` /
`releaseOutbound` over a `sync.Pool` of 1500-byte buffers and `Packet.MarshalTo`.

A pool rather than a per-session field because a session's outbound frames are produced by several goroutines (its
peer's read loop, its own playback loop, the conference mix loop) — a shared field would be a data race. The buffer's
lifetime is exactly one synchronous `writeRTP`; nothing retains it, and the recorder tap copies the _payload_, not the
marshalled packet. An oversized packet falls back to `Marshal`, so a relayed jumbo payload is still correct.

Correctness: byte-for-byte identical output. RTP ordering, the sequence/SSRC rewrite, the marker bit and the
telephone-event renumbering are untouched. Result: `HandlePacketRelay` 178 B/1 alloc → 4 B/0 allocs;
`HandlePacketNoSyscall` 176 B/1 alloc → **0 B/0 allocs** and −10.0% time (p=0.002, interleaved run).

### 2. Reuse the encoder output buffer — `internal/audio/codec.go`, `g711.go`

`FrameEncoder.EncodeFrame` allocated its output every frame. Both callers already consumed it synchronously, so the
interface now documents the buffer as the encoder's own, valid until the next `EncodeFrame` on the same encoder, and
`g711FrameCodec` / `g722FrameEncoder` reuse it (`encodeLinearInto`, the existing `G722Encoder.encodeInto`).

Correctness: one encoder belongs to one direction of one bridge or one seat in one room, so the window is a whole
20 ms and there is no second consumer. The mixer writes each member's frame out of that member's own socket before the
next tick; a transcoder's output is marshalled and written inside the same `forward()` call. The recorder, which is the
one consumer that keeps bytes, already copied. Result: `Transcode` 160 B/1 alloc → **0/0**; mixer share below.

### 3. Recycle jitter-buffer frames — `internal/rtp/jitter.go`, `mixer.go`

`JitterBuffer.Push` copies each arriving payload into a fresh 160-byte slice; that copy is dead the instant the mixer
has decoded it. Added a bounded free list and an explicit `Recycle`, called by `mixOnce` right after
`DecodeFrame` (which copies into the decoder's own scratch).

Correctness: `Pop` deletes from `pending` and returns the only reference; `mixOnce` is the single consumer and runs on
one goroutine. Recycling is the _consumer's_ call precisely because the producer cannot know when the frame is dead.
The free list is capped at the same ceiling `pending` has, so a stalled room cannot grow it. Ordering, late/duplicate
detection, priming and resync logic are untouched.

Fixes 2+3 together: `MixTick8` 3 940 B/31 allocs → **33 B/8 allocs**; `MixTick32` 15 760 B/126 allocs → **134 B/32
allocs**. Those are 50 ticks a second per room.

### 4. RTCP sender report: reuse the wire buffer and cache the peer address — `internal/rtp/rtcp.go`

`sendSenderReport` did `make([]byte, 28)` and built a fresh `net.UDPAddr` for the far end's odd port on every report.
Both are now fields on `qualityState`, the address rebuilt only if the latch pointer changes. Only the RTCP goroutine
touches them, and it builds one report at a time — which is why the cache needs no lock.

Correctness: the report bytes, the NTP timestamps, the LSR bookkeeping and the RTT computation are unchanged; a
session latches once, so the cached address is rebuilt at most once per leg. Result: 80 B/2 allocs → **0/0**, −11.8%
time (p=0.002).

### 5. Take the reaper off the packet path's mutex — `internal/rtp/session.go`, `manager.go`

`ReapIdle` walked every live session **while holding the Manager's global lock** and called `session.Idle()` and
`session.Stats()` on each — two acquisitions of a per-session mutex that the session's own packet path takes on every
packet. At a thousand sessions that is 2 000 contended acquisitions once a second, with the global lock held.
`LastPacketUnixMs` is now an `atomic.Int64` on the session; `Idle` and the reaper read it without `statsMu`, and
`Stats()` folds it back into the copied struct so the control surface is unchanged.

Correctness: the field was only ever written by the read goroutine and read by the reaper and the control surface —
never read together with another counter under one lock — so moving it to an atomic loses no consistency. Not visible
in a micro-benchmark; it is the thing the mutex profile would have shown at higher session counts.

### 6. UDP socket buffer sizing — `packages/runtime-go/netbuf`, `internal/rtp/allocator.go`, `cmd/mediad/main.go`

New shared `netbuf.Tune(conn, receive, send)` sets `SO_RCVBUF`/`SO_SNDBUF` and reports what the kernel actually
granted (Linux doubles the request and clamps to `net.core.rmem_max`). `Allocator.SocketBufferBytes` applies it to
both sockets of every allocated pair; `cmd/mediad` sets it from `MEDIAD_RTP_SOCKET_BUFFER_BYTES`, default 512 KiB.
A refusal is not fatal — the socket works at the kernel default.

**Honest measurement note:** at 1000 pairs, 64 KiB / 512 KiB / 2 MiB gave 27.9% / 47.6% / 28.4% ingress loss, and a
repeat of the same 512 KiB setting gave 25.4% — i.e. **the run-to-run spread exceeds the effect, so this change is not
backed by a number on this box.** It is kept as defensive hygiene (a strictly larger kernel buffer cannot cause loss,
and kernel-side overflow is invisible to every counter in the process) with an env var to turn it off. The sipd agent
can adopt `netbuf` as-is.

### 7. Container limits and a gated pprof endpoint — `packages/runtime-go/proclimit`, `health`, `cmd/mediad/main.go`

- Go 1.25+ already derives `GOMAXPROCS` from the cgroup CPU limit, so **nothing was added for it** — it is logged at
  boot instead. `GOMEMLIMIT` has no such default, so `proclimit.ApplyMemoryLimit` reads cgroup v2 `memory.max`
  (falling back to v1) and sets a soft limit 10% under it, deferring to an explicit `GOMEMLIMIT` and doing nothing
  when there is no cgroup limit.
- `health.WithPprof(true)` serves `net/http/pprof` **only on the private health listener**, off unless
  `MEDIAD_PPROF=true`. Registered on the health mux by hand rather than via `http.DefaultServeMux`, so it cannot leak
  onto another listener. The write timeout widens to two minutes only when pprof is on, or `-seconds=30` profiles
  would be truncated by the probe timeout. The reason it is gated at all is in the godoc: an open profiling endpoint
  is both a denial of service and a memory disclosure.

### 8. SDP on the allocate path — `internal/sdp/sdp.go`

Raised by the mediad-control agent: SDP is 55% of the allocate-session RPC's CPU and allocations. Benchmarked
(`internal/sdp/bench_test.go`), and the shape of it is a **duplicate parse**, not a slow parser. The handler calls
`sdp.AudioProtocol(offer)` to choose between the SIP and WebRTC paths and then `sdp.ParseOffer(offer)` for the codecs;
both run pion's `UnmarshalString` over the same string.

- `Offer.AudioProtocol` is now populated by `ParseOffer` from the same parsed media section, via a shared
  `audioProtocolOf` helper that `AudioProtocol` also uses — so the two are byte-identical by construction. Cost:
  +1 alloc / +8 B on `ParseOffer`. It lets the handler drop the second parse entirely (**cross-area**, below).
- `BuildAnswer` and `BuildOffer` now `Grow(512)` their `strings.Builder`; a real body is ~300 bytes and the builder
  was reallocating four times per call. Output is byte-identical — the existing golden tests cover it.

|                                                                  | before                      | after                                            |
| ---------------------------------------------------------------- | --------------------------- | ------------------------------------------------ |
| `ParseOffer`                                                     | 885 ns, 1 289 B, 16 allocs  | 890 ns, 1 297 B, 17 allocs                       |
| `BuildAnswer`                                                    | 569 ns, 936 B, 20 allocs    | 500 ns, **720 B, 16 allocs** (−12% time, −23% B) |
| `AudioProtocol`                                                  | 685 ns, 1 040 B, 15 allocs  | unchanged (kept as the standalone API)           |
| **allocate path, once the handler adopts `Offer.AudioProtocol`** | 2.14 µs, 3 265 B, 51 allocs | **1.39 µs, 2 017 B, 33 allocs (−35%)**           |

I did **not** rewrite `AudioProtocol` as a raw line scan even though it would remove the whole 685 ns. It would accept
SDP that pion rejects, changing which error text a malformed offer is refused with, and the win is 0.7 µs on a
per-call-setup path — not worth a behaviour change. An answer cache keyed on the offer bytes was also rejected: it
would make the builder stateful and needs an eviction policy to serve a saving of half a microsecond per call.

## Measured and NOT worth changing

- **Batched `recvmmsg`/`sendmmsg` (`golang.org/x/net/ipv4` ReadBatch/WriteBatch).** `x/net` is already an indirect
  dependency, so the cost would be acceptable — but batching does not apply here: mediad binds **one socket per
  session**, so there is no cross-session batch to build, and batching within one leg would mean holding frames,
  i.e. adding latency to a relay whose whole design point is not adding any. Separately, `WriteBatch` writes only a
  single message on non-Linux, so it cannot be measured on this box. **Not adopted; re-measure on Linux only if a
  future design multiplexes many legs onto one socket.**
- **Connected UDP sockets.** A micro-benchmark says `net.DialUDP` + `Write` is 2.41 µs against 3.50 µs for
  `WriteToUDP` — a real 31% saving on the dominant cost. Rejected anyway: `connect()` on the RTP socket would drop
  packets from other sources in the kernel, destroying the `ForeignSource` counter that proves the symmetric-RTP latch
  is doing its job, and connecting mid-stream races the read loop. It is worth revisiting **only** with a design that
  keeps the foreign-source evidence.
- **`WriteToUDPAddrPort` / `netip.AddrPort`.** 3.61 µs vs 3.50 µs for `WriteToUDP` — no gain, because `WriteToUDP`
  already allocates nothing (`4 B/0 allocs`; Go converts to a `sockaddr` on the stack). The `*net.UDPAddr` per
  `ReadFromUDP` likewise did not show up: the read path is 0 allocs/op after fix 1.
- **Per-packet closure allocations in `Session.count`.** Suspected, measured, not real: escape analysis keeps the
  `func(*Stats)` literals on the stack. The whole userspace path is now 0 allocs/op.
- **Lock scope in `Session`/`Bridge`/`Manager`.** The mutex profile at 500 pairs contains no application mutex. The
  existing split (`peerMu` RWMutex separate from `statsMu`, mix frames written outside `Conference.mu`) is already
  doing its job. Left alone.
- **A rewritten SDP parser, or an answer cache.** See fix 8: the duplicate parse was the real cost and it is removed
  structurally. What remains is ~1.4 µs and 33 allocs per _call setup_ — about 0.14 ms of CPU per second at 100 calls
  per second. Not worth trading byte-identical behaviour for.
- **Test port ranges.** Checked the reported `go test ./...` collision: `internal/webrtc` uses 37000-37199,
  `internal/control` 37400-37599, and `internal/rtp` 53000-53099, 54000-54309, 55000-55009, 56000-56379 (benchmarks
  41000-44999, load test 46000+). They are disjoint; `go test -race ./...` for the whole module ran green three times
  in a row with the default per-package parallelism. The failure the other agent saw was my own in-flight edit, not a
  port clash. One genuine flake was found and fixed in the test, not the code: `TestSessionEchoesG711` read the echoed
  packet off the wire and then asserted `PacketsSent == 1`, but `countSent` runs _after_ `writeRTP` returns — it now
  waits for the counter.
- **`Recording.enqueue` and `JitterBuffer.Push` standalone.** Both still 160 B/1 alloc in isolation. The recorder's
  copy is required (it crosses to another goroutine and outlives the read buffer) and its queue is already
  non-blocking; `Push`'s copy is recycled in the real path (fix 3) but not in the standalone benchmark, which is why
  that benchmark's number does not move.
- **DTMF injection's `Marshal`.** Same allocation as fix 1, left alone: a digit is a few hundred packets per keypress,
  not a per-frame cost, and the send path there deliberately reports errors rather than swallowing them.

## Not changed, recommended as a follow-up (needs a number I could not get here)

Each session runs **five goroutines and one 5-second `time.Ticker`**: RTP read, RTCP read, the RTCP report ticker, and
the manager's two wrappers. Measured cost: 5 002 goroutines at 500 pairs, 9 427 bytes of heap per session, and a mutex
profile that is _entirely_ runtime scheduler locks. Folding the report into the RTCP read loop with a read deadline
would remove one goroutine and one timer per session and would give RFC 3550 §6.3.1 interval randomisation for free
(the fixed 5 s interval today can synchronise reports across a mass re-registration). It needs a separate path for
sessions with a `PacketTransport` (a WebRTC read carries no deadline), which touches an area another agent owns, and I
could not demonstrate the win on a box this noisy. Recorded rather than done.

## Cross-area needed

- `internal/webrtc` (not mine): the `PacketTransport` read has no deadline, which is the one thing blocking the
  RTCP-goroutine removal above.
- `internal/control` (not mine): `handlers.go:63` and `handlers.go:371` call `sdp.AudioProtocol(...)` and then
  `sdp.ParseOffer(...)` on the same string, parsing it twice. `ParseOffer` now returns `Offer.AudioProtocol` with the
  identical value, so the first call can be dropped where an offer is parsed anyway — 685 ns and 15 allocs per
  allocate-session, ~35% of that RPC's SDP cost. Line 371 is on an answer, so check whether that path parses at all
  before changing it.
- `internal/config` (not mine): `MEDIAD_RTP_SOCKET_BUFFER_BYTES` and `MEDIAD_PPROF` are read directly in
  `cmd/mediad/main.go` rather than through `config.Load`, to stay inside my area. They belong in `config.Config` with
  the rest, and `config.Load` should validate them.
- `apps/sipd` (not mine): `packages/runtime-go/netbuf` and `packages/runtime-go/proclimit` are written to be shared;
  sipd should adopt both, and `health.WithPprof` for its own private listener.
- `apps/mediad/Dockerfile`: no change needed. It already builds with `-trimpath -ldflags='-s -w'`, runs as 1001, and
  exposes only the health port and the two UDP ranges. `MEDIAD_PPROF` is off by default and must stay unset there.

## Modern Go guidelines applied

Ran `run-tool.sh list --file-path` for the files I edited (the list is identical workspace-wide, go 1.26) and applied,
in code I wrote or touched:

- **testing_b_loop** — every benchmark in `internal/rtp/bench_test.go` and `internal/sdp/bench_test.go` uses
  `for b.Loop()` (and drops the now-redundant `b.ResetTimer`).
- **range_over_int** — `for range 50`, `for frame := range n`, `for index := range pairs`,
  `for index := range audio.FrameSamples` in the mixer line I touched.
- **sync_waitgroup_go** — `group.Go(...)` for the load harness's 2N phone goroutines, instead of `Add`/`go`/`Done`.
- **testing_t_context** — `t.Context()` for the load test's deadline and the new health-listener tests.
- **atomic_types** — `atomic.Int64` for `Session.lastPacket`, `atomic.Uint64` for the harness counters.
- **min_max** — `max(...)` in the load test's loss and per-session arithmetic.
- **any** — `sync.Pool.New` returns `any`.
- **errors_is** — kept on every error comparison in the new code.

Deliberately skipped: `range_over_int` on `allocator.go:108` (`for attempt := 0; attempt < a.Capacity(); attempt++`)
and `rtcp.go:182` — both are inside functions I did not touch, and the allocator one re-evaluates `a.Capacity()` per
iteration, so converting it would be a behaviour change rather than a modernisation. `clear()` would fit three
zeroing loops in `mixer.go`, but two of them are in `mixOnce` blocks I did not edit and the file was under a
concurrent comment sweep.

## Comment policy

Applied per COMMENT_POLICY.md to the files I edited, comments only, behaviour unchanged.

| file                                         | before    | after            |
| -------------------------------------------- | --------- | ---------------- |
| `internal/audio/codec.go`                    | 79        | 49               |
| `internal/audio/g711.go`                     | 49        | 30               |
| `cmd/mediad/main.go`                         | 61        | 40               |
| `internal/sdp/sdp.go`                        | 233       | 112              |
| `internal/rtp/session.go`                    | 413       | 221              |
| `internal/rtp/transport.go`                  | 27        | 15               |
| `internal/rtp/jitter.go`                     | 182       | 81               |
| `internal/rtp/rtcp.go`                       | 133       | 59               |
| `internal/rtp/allocator.go`                  | 75        | 37               |
| `internal/rtp/mixer.go`                      | 192       | 100              |
| `internal/rtp/playback.go`                   | 158       | 78               |
| `internal/rtp/manager.go`                    | 390       | 190              |
| `internal/rtp/bench_test.go`                 | 35        | 24               |
| `internal/rtp/loadtest_test.go`              | 17        | 15               |
| `internal/rtp/session_test.go`               | 62        | 32               |
| `packages/runtime-go/health/health.go`       | 15        | 13               |
| `packages/runtime-go/proclimit/proclimit.go` | 21        | 16               |
| `packages/runtime-go/netbuf/*.go`            | 18        | 14               |
| **swept total**                              | **2 072** | **1 084 (−48%)** |

Every file I edited is swept.

Comments found to be factually wrong (reported, code not touched):

- `internal/audio/codec.go`, `FormatOpus`: pointed at "the note on `NewFrameDecoder`", but the Opus explanation is on
  `Format.Transcodable`. Cross-reference corrected.
- `internal/audio/codec.go`, `padFrameInto`: claimed its return matches `padFrame` exactly, but a nil or wrong-sized
  `dst` falls through to `padFrameAlloc`, which _allocates_ for a short input where the buffer path reuses. Reworded
  to state only what holds.
- `internal/sdp/sdp.go`, `ErrNoCommonCodec` and `Offer.Codec`: both said "G.711", but the parser accepts G.722 and
  Opus as well. Comments corrected. **The error string itself is still wrong** — `"...(want PCMU or PCMA)"` omits
  G722 and opus — and that is a code literal, so it was left alone. Worth fixing separately.
- `internal/sdp/sdp.go` package doc asserted "G.711 PASSTHROUGH … bytes in, same bytes out" as the whole of
  negotiation, contradicting the `Codec` doc two lines below it. Stale since transcoding landed; rewritten.
- `internal/rtp/session_test.go`, `TestSessionDropsUnsupportedPayloadTypes`: said PT 9 (G.722) is one "v1 deliberately
  does not handle". `internal/audio` has a G.722 codec and `sdp.CodecG722` is negotiable; what makes PT 9 unsupported
  in that test is only that the session was created with `AudioPayloadType: PayloadTypePCMU`. Comment corrected.

- `internal/rtp/allocator.go`: `PortPair.RTCP` said "bound but not read from in v0" and the type doc said "mediad does
  not speak RTCP yet". Both false since `rtcp.go` reads the odd port and sends sender reports. Corrected.
- `internal/rtp/session.go`: the package doc and the payload-type block claimed "no transcoding in v1 — a codec
  mismatch is resolved in SDP negotiation by refusing the offer" and "G.711 only, PASSTHROUGH only", while
  `Session.transcode`, `prepareTranscoders` and `PayloadTypeG722` exist and `Manager.Bridge` installs translations.
  Corrected.
- `internal/rtp/manager.go`: `ErrCodecMismatch`'s prose described a refusal that no longer exists — it is now an alias
  for `ErrCannotTranscode`. Stale narrative dropped, `// Deprecated:` kept.

**Second latent code issue, reported not fixed:** `NewSession`'s `if format == FormatDefault` cannot tell "caller left
Format unset" from "caller explicitly passed FormatULaw", so an explicit `FormatULaw` with
`AudioPayloadType: PayloadTypePCMA` is silently rewritten to `FormatALaw`. The existing comment calls this intended,
so it was left alone.

**Latent code bug found while sweeping, not fixed (outside a measured change):** `sdp.BuildAnswer`'s guard
`if payloadType == 0 && answer.Codec != CodecPCMU` leaves `payloadType` at 0 for an Opus answer whose
`AudioPayloadType` was not set, because `CodecOpus.PayloadType()` also returns 0 — such an answer would be rendered
under PT 0. Every caller passes the offered type today, so it is latent.

## Verification

```
apps/mediad:            gofmt -l .  → clean
                        go vet ./...  → clean
                        go vet -tags loadtest ./internal/rtp/  → clean
                        go test -race ./internal/rtp/ ./internal/audio/ ./internal/sdp/  → ok
packages/runtime-go:    gofmt -l . → clean; go vet ./... → clean; go test ./... → ok
load test:              200 and 500 pairs, 0% loss, goroutines return to baseline after release
```
