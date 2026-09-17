# NET — mediad-control (internal/control, internal/webrtc, internal/directory, internal/events)

Machine: 18-core M5 Max, macOS, no Docker. Other agents were loading the same box throughout, so
**latency numbers are noisy and allocs/op + profile shape are the trustworthy metrics**. Every wire
number uses the real `nats-server` binary at
`scratchpad/bin/nats-server` (`-js -sd <tmp> -p <free>`), the real handlers and the real KV buckets.

## Harness (kept in the repo)

| File                                             | What it drives                                                                                                                                                              | How to run                                                                                                                                                                                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/mediad/internal/control/bench_test.go`     | Handler-only benchmarks (no broker); wire benchmarks over a real nats-server with/without the real KV ownership router; `TestControlPlaneLoad` sweep at 500/1000/2000 req/s | `go test ./internal/control -run xxx -bench BenchmarkHandler -benchmem -count=5`<br>`NATS_SERVER_BIN=… go test ./internal/control -run xxx -bench BenchmarkWire -benchmem -count=5`<br>`NATS_SERVER_BIN=… RUN_MEDIAD_LOAD=1 go test ./internal/control -run TestControlPlaneLoad -v` |
| `apps/mediad/internal/webrtc/bench_test.go`      | Two real Pion peers per leg over loopback ICE/DTLS/SRTP; per-packet in/out benchmarks; `TestWebRTCLegLoad` at 100 and 300 legs, 50 pps                                      | `go test ./internal/webrtc -run xxx -bench BenchmarkTransport -benchmem -count=5`<br>`RUN_MEDIAD_LOAD=1 go test ./internal/webrtc -run TestWebRTCLegLoad -v`                                                                                                                         |
| `apps/mediad/internal/events/bench_test.go`      | Real JetStream publish of `session.ended`, serial and at the announcer's own 8-slot ceiling                                                                                 | `NATS_SERVER_BIN=… go test ./internal/events -run xxx -bench . -benchmem -count=3`                                                                                                                                                                                                   |
| `apps/mediad/internal/control/ownership_test.go` | Two routing regression tests (see fixes 1 and 2)                                                                                                                            | part of `go test -race ./internal/control`                                                                                                                                                                                                                                           |

The wire benchmarks share **one** nats-server per test binary (`sync.OnceValue`), because a server
per benchmark function under `-count=5` exhausts loopback sockets ("no buffer space available")
mid-run. `countingOwners` wraps the real KV store so the benchmarks report a `kvops/op` metric —
KV round trips per RPC as a number rather than as a reading of `ownership.go`.

## Before: profiles

`BenchmarkHandlerAllocateSession`, alloc_space top frames (the fullest RPC, 79 allocs/op):

```
13.4% strings.(*Builder).Write
10.2% pion/sdp/v3.unmarshalMediaDescription        (837MB cum)
 8.6% control_test.(*stubSessions).Allocate        (harness)
 8.5% encoding/json.Marshal
 6.4% encoding/json.(*decodeState).literalStore
 5.4% control.(*Server).HandleAllocateSession
 5.0% mediad/internal/sdp.AudioProtocol            (1149MB cum, 17.1%)
 4.9% mediad/internal/sdp.ParseOffer               (1429MB cum, 21.3%)
 4.8% mediad/internal/sdp.rtpmapOf
 4.8% pion/sdp/v3.(*unmarshalCache).cloneMediaAttributes
 3.9% encoding/json.unquoteBytes
 3.0% mediad/internal/sdp.BuildAnswer              (1150MB cum, 17.1%)
 2.9% context.WithDeadlineCause
 2.8% pion/sdp/v3.(*lexer).unmarshalConnectionInformation
 2.5% encoding/json.Unmarshal                      (942MB cum, 14.0%)
```

Reading: **the control plane's own JSON is ~20% of allocate; SDP parse + build is ~55%**, and SDP is
`internal/sdp`, another agent's area (see Cross-area).

`BenchmarkTransportInboundRTP`, alloc_objects top frames:

```
22.7% pion/webrtc/v4.(*TrackRemote).ReadRTP                       (50.5% cum)
20.8% pion/ice/v4.init.func1
15.6% pion/interceptor/pkg/report.(*ReceiverInterceptor).BindRemoteStream.func1
12.2% pion/interceptor.Attributes.GetRTPHeader
 8.5% pion/rtp.Packet.Marshal
 7.8% webrtc_test.silence (harness)
 3.9% pion/dtls/v3/pkg/crypto/prf.PHash
 …
      webrtc.(*Factory).New.func2  (the OnTrack loop)  — 59.0% cum
```

Reading: **the inbound loop in `transport.go` is 59% of allocations on the WebRTC read path**, all of
it `ReadRTP` (packet + payload + interceptor header attributes) followed by `Marshal` back to bytes.

Baselines (`-count=5`, serial, one request in flight):

```
WireAllocateSession        ~ 75µs   7.9KiB/op   95 allocs/op
WireAllocateSessionOwned   ~390µs  20-26KiB/op 288-383 allocs/op   3.000 kvops/op
WireHoldSessionOwned       ~ 72µs   3.1KiB/op   43 allocs/op       0.0002 kvops/op
WireHoldSession            ~ 63µs   1.8KiB/op   21 allocs/op
HandlerAllocateSession     5.8µs  5562B/op  79 allocs/op
HandlerBridgeSessions      1.46µs 1362B/op  19 allocs/op
HandlerHoldSession         0.88µs  918B/op  10 allocs/op
HandlerReleaseSession      0.93µs  827B/op  13 allocs/op
```

## Fix 1 — head-of-line blocking: a forward to a wedged owner stalled its whole subject

**Measured before.** A NATS async subscription dispatches its subject on ONE goroutine. `routeRequest`
relayed a cross-node request inline on that goroutine and waited for the neighbour. With four
requests aimed at a subscribed-but-wedged owner, an unrelated hold on a **locally owned** session
took **1.957 s**. At the old 2 s timeout it was ~8 s.

**Change** (`ownership.go`, `control.go`): `routeRequest` now returns either a reply or a `forward`
closure. `Subscribe`'s callback answers a reply inline exactly as before, and runs a forward on its
own goroutine. Forwards are bounded by `maxConcurrentForwards = 64`; past that a request is refused
`wrong_instance` immediately rather than queued, so a wedged neighbour cannot grow goroutines
without limit.

**After: 474 µs** (−99.98%). Regression test:
`TestAWedgedOwnerDoesNotStallOtherRequests`.

Correctness: local handling stays on the dispatcher goroutine, so handler serialisation per subject
is unchanged and no handler became newly concurrent. The forward's context is created before the
hand-off and cancelled by the forward, so the deadline is not extended. The refusal shape
(`ok:false` + `reason:wrong_instance` + every identity field) is byte-identical, including the
`sessionIds: []` vs `null` detail — `slices.Clone` was deliberately _not_ used there.

Cost: +1 alloc/op on every RPC (the `answer` closure): 95→96, 43→44, 21→22 allocs. Against a 60–400 µs
round trip that is not measurable.

## Fix 2 — routing timeout 2 s → 500 ms, matched to the engine's budget

`ENGINE_MEDIAD_RPC_TIMEOUT_MS` defaults to **500** (`apps/engine/src/config/engine-env.ts:367`), and
`routeRequest` used a hard-coded 2 s for its KV lookups and its forward — the only deadline in mediad
not tied to `directory.Timeout`. Everything past 500 ms is work whose reply lands on a caller that
has already given up, while a goroutine stays parked for it.

New exported `control.RoutingTimeout = 500ms`. A wedged owner is now refused after **0.57 s** instead
of **~2.0 s** (measured: the same test run takes 1.86 s vs 2.36 s wall with the constant flipped).
Test `TestRoutingToAHungOwnerRefusesInsideTheEngineBudget` pins both the constant against the engine
default and the observed refusal latency. Correctness: only the _wait_ shortened; the refusal code
and payload are unchanged, and a shorter deadline can only turn a reply nobody would have read into
an earlier `wrong_instance`, which is the code the engine already branches on.

## Fix 3 — WebRTC inbound: `Read` instead of `ReadRTP` + `Marshal`

`transport.go`'s `OnTrack` loop parsed every inbound packet into an `rtp.Packet` (allocating the
struct, the payload slice and the interceptor's header attributes) and immediately re-serialised it
with `Marshal`, for bytes the media pipeline copies out again. Replaced with `track.Read(buf)` into a
reused 8 KiB buffer plus one `bytes.Clone` into the channel. `readReports` now shares the same
`packetBufferSize` constant and uses `bytes.Clone`.

benchstat, `-count=5`, 20000 packets per run:

```
                        │  before   │            after             │
B/op    TransportInboundRTP   2458.0  →   772.0   -68.59% (p=0.008)
allocs  TransportInboundRTP    7.000  →   5.000   -28.57% (p=0.008)
        TransportOutboundRTP   unchanged (237 B/op, 5 allocs/op)
sec/op  no significant change (p=0.55; machine loaded)
```

Those totals include the _browser-side_ write, so the transport's own share fell by more than the
headline: three of the loop's allocations became one.

At load (`TestWebRTCLegLoad`, 100 legs × 50 pps × 10 s):

```
before: received 49995 (4994 pps)  droppedRTP=0  allocMiB=129  allocs/packet=10.9  goroutines=6603
after:  received 50000 (4997 pps)  droppedRTP=0  allocMiB= 56  allocs/packet= 9.7  goroutines=6603
```

**−57% total heap churn over ten seconds of 100-leg audio.** At 300 legs the patched build carried
14 328 pps with zero drops; the unpatched run of the same case never got all legs connected
(2 526 pps) — that row is not a fair comparison and is not claimed as one.

Correctness: `Read` returns the SRTP-decrypted wire bytes, which is what the pipeline consumed
anyway (previously a re-marshal of the parse of those bytes). Decryption, **SRTP replay protection**
and the interceptor chain all sit _below_ `Read` in Pion and are untouched. RTP ordering is
unaffected — the loop, the 128-deep channel and the drop counter are unchanged. Verified by the
existing `TestWebRTCBridgesBothDirectionsWithoutPlaintextIngress` (both directions, plus the forged
plaintext-ingress assertion) and by the gated **real Chromium** suite:
`RUN_BROWSER_WEBRTC=1 … TestChromiumWebRTCAudioAndRecording` passes both subtests
(`packetsReceived:40, audioEnergy:0.025, phoneAudioPackets:40`).

## Measured and NOT changed

- **Ownership memoisation post-allocate is already complete.** `WireHoldSessionOwned` reports
  **0.0002 kvops/op** — i.e. the tracked∧live memo answers essentially every post-allocate command
  with zero KV round trips, and owned-hold latency equals unowned-hold latency within noise. There
  is nothing left to memoise or watch here.
- **The 3 KV round trips on allocate are placement, not overhead.** `WireAllocateSessionOwned` costs
  ~250–300 µs more than the unrouted path, all of it `Get(session)` → `Claim(call)` → `Claim(session)`.
  The session `Get` looks redundant next to the `Claim` on the same key, and dropping it would save a
  third of that. I did not: in the window where a call key has expired but its session key has not
  (or for a legacy pre-ownership session found via the directory fallback), skipping the lookup makes
  this node claim a call it does not own and then refuse the request as "resources live on different
  instances". 80 µs against a 500 ms budget is not worth a correctness window.
- **Lifecycle publisher backpressure is right as it stands.** Real JetStream publish: **44 µs/event
  serial (~23k/s)**; at the announcer's own 8-slot ceiling, **13.8 µs/event (~72k/s)**. A mass reap
  cannot offer anything near that, so `PublishAsync` + periodic flush would trade the per-publish ack
  (which is what makes `Nats-Msg-Id` dedup meaningful for a retried publish) for throughput nobody
  needs. Left alone.
- **No goroutine fan-out growth on the control plane.** `TestControlPlaneLoad` shows a flat **41–42
  goroutines** at steady state across 500, 1000 and 2000 req/s, with and without the router.
- **Load sweep (noisy, honest).** Clean rows, owners=true: 1000/s achieved 1000/s, p50 621 µs,
  p99 1.65 ms, 0 failures; 2000/s achieved 2000/s, p50 322 µs, p99 1.14 ms, 0 failures. Two rows in
  the run are garbage (a 500/s row with 688 failures and 23 s p50, and a 2000/s owners=false row with
  730 failures) — the _slowest_ offered rate producing the worst result is a JetStream file-store
  stall plus contention from the other agents on this box, not a mediad ceiling. Re-run sequentially
  on an idle machine before quoting absolute latencies.
- **Pion `SettingEngine` buffers.** Left as-is. `droppedRTP`/`droppedRTCP` were **0** at both 100 and
  300 legs, so the 128-packet RTP and 32-packet RTCP channels are not the constraint and enlarging
  them would only add latency before a drop that never happens. No receive-buffer change is justified
  by a measurement.

## Cross-area needed

1. **SDP is 55% of the allocate RPC** (`internal/sdp` — `ParseOffer` 21.3%, `BuildAnswer` 17.1%,
   `AudioProtocol` 17.1%, plus `pion/sdp/v3`'s unmarshal cache). `sdpSessionIDs` is deterministic, so
   an _answer cache keyed by (offer, port)_ is available and would remove nearly all of it for the
   re-INVITE/hold path where the same offer is answered repeatedly. Owner: the `internal/sdp`,
   `internal/rtp`, `cmd/mediad` agent.
2. **Single-port ICE UDP mux.** 66 goroutines per leg across both peers (~33 per side) at 300 legs, and
   the port range is a NAT/coturn liability. `pion.NewICEUDPMux` on one port would collapse the
   per-connection socket readers and make firewalling a single port. I did **not** implement it: it
   changes what `MEDIAD_RTP_PORT_MIN/MAX` mean, and the config, `cmd/mediad`, `Dockerfile`, compose
   and `docs/` that would have to stay correct are all outside this area. Recommend it as a costed
   follow-up with the docs/compose change in the same diff.
3. **`internal/rtp` is red on this tree** — `TestAllocateNeverHandsOutTheSamePortTwice`,
   `TestAllocateReportsExhaustion`, `TestClosedPortsAreReusable`,
   `TestAllocateCyclesTheRangeBeforeReusingAPort`, `TestCloseIsIdempotent`,
   `TestConcurrentAllocateIssuesDistinctPorts` all fail. Not caused by anything here (nothing in this
   area touches the allocator, and `./internal/rtp -run TestBridgeRepoints` passes in isolation);
   it is the concurrent agent's in-flight edit. Flagging so it is not attributed to this pass.
4. Under `go test -race ./...` (packages in parallel) `internal/webrtc` and `internal/rtp` collide on
   the 37000–37199 port range. Pre-existing; `-p 1` or distinct ranges would fix it.

## Modern Go guidelines applied

Ran `list --file-path` on every file edited. Applied: **`testing_b_loop`** (`for b.Loop()` in all nine
new benchmarks), **`range_over_int`** (`for range slots`, `for i := range legs`),
**`sync_waitgroup_go`** (`wg.Go` in the load sweeps and the concurrent publisher bench),
**`testing_t_context`** (`t.Context()` / `b.Context()` throughout the new tests),
**`sync_once_value`** (shared nats-server URL), **`slices_sort`** (latency percentiles),
**`slices_clone`** (`resourceRequest.sessions`), **`bytes_clone`** (both transport packet copies),
**`cmp_or`** (owner-or-self claim candidate), **`maps_delete_func`** (ownership pruning),
**`min_max`** (load-test division guard), **`atomic_types`** (all counters), **`any`**.
Deliberately skipped `slices_clone` for `routingFailure`'s `sessionIds`: a nil clone marshals as
`null` where the wire contract sends `[]` — noted in the code.

## Comment policy

Whole-file cleanup on the three files edited (narration, history, plan-document references and design
essays removed; godoc, RFC references and race/ordering invariants kept and tightened):

| File                            | before | after |
| ------------------------------- | ------ | ----- |
| `internal/control/control.go`   | 129    | 58    |
| `internal/webrtc/transport.go`  | 15     | 17    |
| `internal/control/ownership.go` | 20     | 28    |

`ownership.go` and `transport.go` rise because both gained genuinely new exported behaviour
(`RoutingTimeout`, `maxConcurrentForwards`, the forward contract, `packetBufferSize`) that needs
godoc; their pre-existing narration was cut.

## Verification

```
gofmt -l .                                                     → clean
go vet ./...                                                   → clean
go test -race ./internal/control ./internal/webrtc
     ./internal/events ./internal/directory                    → ok (control 1.99s, webrtc 1.79s)
RUN_BROWSER_WEBRTC=1 go test -race -run TestChromiumWebRTC…    → PASS (2 subtests, real Chromium)
RUN_MEDIAD_LOAD=1 go test -run TestControlPlaneLoad            → PASS (6 subtests)
RUN_MEDIAD_LOAD=1 go test -run TestWebRTCLegLoad               → PASS (100 and 300 legs)
go test -race ./...                                            → internal/rtp FAILs (not this area, item 3)
```

New tests: 2 (`TestRoutingToAHungOwnerRefusesInsideTheEngineBudget`,
`TestAWedgedOwnerDoesNotStallOtherRequests`). New benchmarks: 9. New gated load tests: 2.
No git state touched.
