# NET-sipd — networking performance pass, apps/sipd

Area: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/sipd` (Go 1.26, sipgo v1.4.3, nats.go v1.52.0).
Machine: Apple M5 Max, 18 cores, macOS, shared with other agents — absolute latency is noisy, allocs/op and
broker-round-trips/op are not, and the report leans on those.

---

## 1. The harness

Three new build-tagged files in `apps/sipd`, all gated on `RUN_SIPD_LOAD=1` **and** `NATS_SERVER_BIN`:

| file                    | what it is                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `load_harness_test.go`  | broker bootstrap, stream provisioning, the fake `rpc.sip.v1.credential` responder, the `stats` summary type, and `profileRun` (CPU + heap + block + mutex + goroutine profiles per scenario) |
| `load_register_test.go` | scenario 1 — the REGISTER storm, over UDP, TCP and WebSocket                                                                                                                                 |
| `load_invite_test.go`   | scenario 2 — the INVITE lifecycle with a fake engine                                                                                                                                         |

Everything drives the **real** server on **real loopback sockets** against a **real JetStream broker**: the production
`credentials.NATSStore` with its cache, the production `kv.NATSStore`, the production JetStream publishers, sipgo's own
transport and transaction layers. Nothing is mocked below the engine seam.

### How to run it

```sh
cd apps/sipd
NATS_SERVER_BIN=<path>/nats-server RUN_SIPD_LOAD=1 \
  go test -count=1 -tags load -run TestLoad -timeout 20m -v .

# with profiles (CPU/heap/block/mutex/goroutine per scenario)
NATS_SERVER_BIN=<path>/nats-server RUN_SIPD_LOAD=1 \
  SIPD_LOAD_PROFILE_DIR=/tmp/sipd-prof SIPD_LOAD_PASSES=6 \
  go test -count=1 -tags load -run TestLoad -timeout 20m -v .
```

The rig is sensitive to machine load: the cold pass of a REGISTER storm makes 1000 distinct credential RPCs, and the
contract deadline for those is 500 ms (`TimeoutSipCredentialRPC`). On a saturated box that deadline is missed and the
scenario correctly reports failed registrations. Run it when the machine is otherwise idle.

`SIPD_LOAD_PASSES` (default 1) repeats the steady-state pass so a CPU profile over a fleet that registers in forty
milliseconds has enough samples to mean anything. **Do not combine a high pass count with profiling**: the rig sets
`SetBlockProfileRate(1)` and `SetMutexProfileFraction(1)`, which slows the process enough that the cold pass can exceed
the credential RPC's 500 ms contract timeout on a loaded machine. 6 passes with profiling, 25 without, is the shape that
works here.

### Micro-benchmarks

| file                                    | what it measures                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `internal/registrar/auth_bench_test.go` | `Challenge`, `ParseAuthorization`, `VerifyRequest`, `nonceGuard.accept` — the whole per-request digest budget |
| `internal/profile/acl_bench_test.go`    | `ACL.Match` hit and miss at 8 / 64 / 512 entries                                                              |

```sh
cd apps/sipd
go test -run XXX -bench . -benchmem -count=6 ./internal/registrar/ ./internal/profile/ | benchstat -
```

All benchmarks use `for b.Loop()`.

---

## 2. Before-profiles (top frames)

REGISTER storm, UDP, 1000 AORs × 26 passes, 64 concurrent.

**CPU (top 15)** — the process is I/O plus garbage collector; there is no hot business function.

```
 3.23s 26.58%  syscall.rawsyscalln
 2.59s 21.32%  runtime.usleep
 1.02s  8.40%  runtime.procyieldAsm
 1.02s  8.40%  runtime.tryDeferToSpanScan
 0.63s  5.19%  runtime.kevent
 0.55s  4.53%  runtime.pthread_cond_wait
 0.49s  4.03%  runtime.madvise
 0.46s  3.79%  runtime.(*unwinder).resolveInternal
 0.35s  2.88%  runtime.pthread_cond_signal
 0.22s  1.81%  runtime.scanObjectsSmall
 0.10s  0.82%  runtime.pcvalue
 0.09s  0.74%  runtime.memclrNoHeapPointers
 0.05s  0.41%  runtime.(*lfstack).pop
 0.04s  0.33%  runtime.scanObject
 0.04s  0.33%  runtime.scanObjectSmall
                 ... runtime.gcDrain cum 3.69s = 30.37%
```

`gcDrain` at **30% cumulative** is the headline: at ~770 allocations per REGISTER and ~25k REGISTER/s the collector is
the largest single consumer of CPU. That makes allocation count, not any particular function, the CPU lever.

**Block (top frames)** — where the SIP handler goroutine actually waits.

```
28.65s 60.84%  runtime.selectgo        <- 100% from nats.Conn.requestWithContext
 8.39s 17.81%  internal/poll.fdMutex.rwlock   <- sipgo ServerTx.Respond on the single UDP socket
 6.71s 14.26%  sync.Mutex.Lock
 0.97s  2.06%  runtime.chanrecv2
 0.95s  2.02%  sync.Cond.Wait
```

**60.8% of all block time is a broker round trip inside the SIP transaction.**

**Mutex (top contexts)** — one lock, `nats.Conn.mu`:

```
41.78%  nats.Conn.createNewRequestAndSend
26.64%  nats.Conn.flusher
14.96%  sipgo transactionStore.unlock
12.93%  nats.Conn.publish
 3.69%  nats.Conn.respHandler
```

**Allocations (`alloc_objects`)** — `registrar.HandleRegister` is **55.86% cumulative**. Inside it:
`log.With` 1.26M objects (~5.5% of the whole process), `updateRegistration` 27.6%, `okWithBinding` 4.4%,
`icholy/digest` header parsing 5.3% + 5.4%, sipgo's `HeadersParser.ParseHeader` 13.2%.

Counted on the wire, the pre-fix REGISTER refresh cost **3 broker round trips**: KV `Get`, KV CAS `Update`,
JetStream `Publish`. All three synchronous, all three between the phone's REGISTER and its 200 OK.

INVITE lifecycle before-profile: block time 67% `selectgo`, again the admission RPC and the synchronous
`sip.evt.v1` publishes; `invite.handleInitialInvite`'s `log.With` chain 2.91% of dialog allocations.

---

## 3. Fixes

### 3.1 Registration and dialog events publish asynchronously

`internal/events/events.go`, `internal/sipevents/sipevents.go`, `cmd/sipd/main.go`.

`js.Publish` → `js.PublishAsync`. The JetStream context in `cmd/sipd` now carries
`WithPublishAsyncErrHandler` (logs the subject, the `Nats-Msg-Id` and the error), `WithPublishAsyncMaxPending`
(`SIPD_PUBLISH_ASYNC_MAX_PENDING`, default 4096) and `WithPublishAsyncTimeout`
(`SIPD_PUBLISH_ASYNC_TIMEOUT`, default 30s). Shutdown drains outstanding acks via a new `flushPublishes`, registered
before the connection `Drain` so the ordering is flush-then-drain.

**Correctness.** Delivery is unchanged: same connection, same subject, same `Nats-Msg-Id`, so the stream's duplicate
window still collapses a retry — `dialog.terminated` is still one CDR row, not two. What changes is _when_ a failed ack
is learned. That is safe here because **neither caller ever acted on a publish error**: `registrar.publishRegistered`
and `invite.Handler.publish` both log and continue, and neither ever retried. So the durability guarantee is identical
and only the reporting path moved, from a return value nobody used to a handler that names the message. Backpressure is
preserved by the pending bound: a stalled broker blocks the publisher rather than growing memory. Shutdown is the one
place where async could have lost something, and `flushPublishes` closes it.

**Numbers.** INVITE lifecycle, 300 concurrent dialogs, median of 3 runs of 4 passes each (this fix alone, everything
else held constant):

|                           | sync publish | async publish | delta      |
| ------------------------- | ------------ | ------------- | ---------- |
| dialogs/s                 | 7,197        | 10,264        | **+42.6%** |
| p50 INVITE→BYE-200        | 8.40 ms      | 6.03 ms       | **−28.2%** |
| p99                       | 11.43 ms     | 8.06 ms       | **−29.5%** |
| allocs/dialog             | 1,342        | 1,346         | unchanged  |
| goroutines after teardown | 3,674        | 3,676         | unchanged  |

### 3.2 A re-REGISTER CASes against the revision this process committed

`internal/kv/kv.go` (new `Hint` interface + `SetHint`), `internal/registrar/registrar.go` (new `LastKnown`),
`cmd/sipd/main.go` (`bindings.SetHint(reg)`).

`NATSStore.Update` used to `Get` and then CAS — two round trips — even when the value it read back was one this
process had just written. The registrar already holds every binding it granted, at the revision it committed, because
the expiry sweep needs the exact deadline. That table is now a `kv.Hint`, and the **first** attempt of `Update` builds
on it instead of reading.

**Correctness.** The hint is only ever a guess for attempt zero. A stale revision is refused by the server exactly as a
lost race would be, the loop falls through to a real `Get`, and the callback re-runs on the true value. The no-op
short-circuit (`bytes.Equal` against the stored bytes) is deliberately **skipped** on a hinted attempt, because a local
copy matching does not prove the server agrees. Recognising the refusal needed one new case:
`jetstream.JSErrCodeStreamWrongLastSequence` (via `errors.AsType[*jetstream.APIError]`), which the loop had never had to
handle before because it only ever CAS'd against a revision it had just read.

**Tests** (`registration_atomic_integration_test.go`, real broker):
`TestUpdateWithAStaleHintStillCommitsAgainstTheRealRevision` seeds two writes so the hint names a superseded revision,
and asserts the committed value was built from the _other writer's_ value — a lost race stays lost.
`TestUpdateWithAFreshHintSkipsTheRead` asserts a hinted refresh spends **exactly 1** broker round trip.
`internal/registrar/hint_test.go` covers `LastKnown` after a REGISTER, after a de-REGISTER, and on an unbuildable key.

### 3.3 The request-scoped logger is built only when a line is written

`internal/registrar/registrar.go`, `internal/registrar/contacts.go`.

`HandleRegister` called `slog.Logger.With` twice per request (four attributes, then the AOR) and passed the result down.
The success path logs nothing, so that was ~39 allocations per registration for attributes no handler ever wrote —
5.5% of all allocations in the process under a storm. Replaced by a `requestLog` value that holds the request pointer
and materialises the child logger on first emit. Call sites are unchanged (`log.Info(...)` etc. are methods on it), so
every log line still carries method / peer / transport / sipCallId / aor exactly as before.

### 3.4 Sized UDP socket buffers, and a private pprof listener

`cmd/sipd/main.go`, `internal/config/config.go`.

sipgo's `ListenAndServe` binds the UDP socket with the kernel default receive buffer (~200 KiB on Linux) and one
goroutine drains it. A fleet re-registering after a network blip delivers a burst faster than it can be parsed, and the
overflow is silently dropped datagrams — phones that take a retransmission round to register. `serveUDP` now binds the
socket itself, sizes it through `runtime-go/netbuf.Tune` at `SIPD_SOCKET_BUFFER_BYTES` (default 4 MiB, `0` to leave the
kernel default), logs the sizes the kernel actually granted, and hands the socket to `server.ServeUDP`. A kernel that
refuses the size logs a warning and continues. `run()` also applies `runtime-go/proclimit.ApplyMemoryLimit` at boot.

`SIPD_PPROF_ADDR` (empty = off) starts a `net/http/pprof` listener. `config.Load` **refuses** any address that is not
explicitly loopback — a wildcard, an empty host, a hostname or an external IP is a configuration error, not an
operator's choice, because these handlers dump heap contents and goroutine stacks and a SIP edge's heap holds
credentials in flight. It is a listener of its own rather than a route on the health server because `/healthz` is safe
to expose to a load balancer and a heap dump is not (see Cross-area for the alternative).

TCP was checked and left alone: Go enables `TCP_NODELAY` on every `net.TCPConn` by default, which is what a SIP stack
wants, and there is nothing to set.

### 3.5 Combined: the REGISTER storm

1000 distinct AORs, 64 concurrent, UDP, steady-state refresh pass. Same session, same broker, back-to-back A/B with
all three register-path fixes toggled together; median of 3 runs of 6 passes.

|                                   | before   | after    | delta      |
| --------------------------------- | -------- | -------- | ---------- |
| registrations/s                   | 27,043   | 32,422   | **+19.9%** |
| p50 challenge+auth                | 1.956 ms | 1.666 ms | −14.8%     |
| p90                               | 3.442 ms | 2.783 ms | −19.1%     |
| p99                               | 6.749 ms | 4.841 ms | **−28.3%** |
| allocs / REGISTER                 | 765.6    | 662.6    | **−13.5%** |
| B / REGISTER                      | 75,905   | 68,512   | −9.7%      |
| **broker round trips / REGISTER** | **3.00** | **2.00** | **−33%**   |

Latency here is the noisiest column (other agents were loading the machine); the round-trip count and the allocation
count are exact. Across the other transports, in a separate run: TCP 26.9k → 48.6k regs/s, WebSocket 24.5k → 37.6k —
directionally the same, but those two were measured in different sessions and should be read as corroboration, not as
precise figures.

Credential cache: **1000 RPCs served for 26,000 registrations** — one per account, then nothing. The positive cache and
the `singleflight` collapse are doing their job and need no change.

---

## 4. Measured and NOT worth changing

- **`ACL.Match`** — 0 allocations at every size. Worst-case hit 39 ns / 171 ns / 1.21 µs at 8 / 64 / 512 entries; the
  scanner's case (miss, full walk) 40 ns / 169 ns / 1.15 µs. At 512 entries and 10k refused INVITE/s that is ~1.2% of
  one core. The linear scan is fine; a prefix trie would buy nothing measurable and would complicate a security
  boundary.
- **`nonceGuard.accept`** — 64 ns, 1 alloc, one mutex. Never appeared in the mutex profile. The bounded map and the
  rate-limited sweep behave as designed.
- **Double `CheckNonce`** — `authorize` checks the nonce, then `Verify` checks it again: two HMAC-SHA256 over ~40 bytes,
  ~600 ns of a ~1.7 ms request. `VerifyRequest` is also called directly (the trunk authoriser, the unit suite), so
  removing the inner check would be a real correctness risk for no measurable gain. Left alone.
- **sipgo transaction retention** — the goroutine count climbs ~2 per REGISTER and settles rather than growing without
  bound; it is Timer J (32 s, RFC 3261 §17.2.2) doing what the RFC requires. At a realistic 1000 phones on a 300 s
  expiry (~3.3 REGISTER/s) that is ~107 goroutines. Not a leak, not worth touching, and upstream anyway.
- **TCP_NODELAY** — already on by default in Go.
- **`internal/trunk/status.go` still publishes synchronously.** Deliberate, not an oversight: a trunk registration
  status transition happens once per trunk state change, not once per call, and it is not on a SIP request path. There
  is no measurement that would justify moving it, and a synchronous publisher whose error the caller can see is the
  better default for a low-rate subject.
- **`registrar.Sweep`** — already filters on the locally-held deadline before spending a KV round trip, so a sweep costs
  one `Update` per _expired_ binding, not per tracked one. Confirmed by the round-trip counters staying at 2.00/REGISTER
  through 26 passes with 1000 tracked bindings and a 5 s sweep interval.

## 5. Measured, real, and deliberately NOT done

- **`icholy/digest` header parsing — 52 allocs / 7.2 KB / 2.09 µs per `ParseAuthorization`**, about 8% of a REGISTER's
  allocations and the single largest remaining item. The whole per-request digest budget is
  `Challenge` 1.02 µs / 30 allocs + `ParseAuthorization` 2.09 µs / 52 allocs + `VerifyRequest` 0.99 µs / 18 allocs
  ≈ 4.1 µs / 100 allocs. Fixing it means writing our own RFC 7616 auth-param parser. That is a security-sensitive
  rewrite and I would not land it inside a performance pass without a fuzz corpus; the benchmark is in the repo so
  whoever does it has a before number.
- **`invite.handleInitialInvite`'s `log.With` chain — 2.91% of dialog allocations.** The same fix as §3.3, but the
  INVITE handler adds fields conditionally across many branches (`profile`, `trunkId`, `legId`, `replacesLegId`), so the
  fixed-field `requestLog` shape does not transfer. ~39 allocs of 1,345 per dialog did not justify a refactor of a
  1,200-line handler in this pass.
- **`internal/poll.fdMutex.rwlock` — 47% of block time after the other fixes.** Every response write on the single
  `*net.UDPConn` serialises on the Go runtime's fd lock. Removing it means `SO_REUSEPORT` with one socket and one
  reader per core, which is an architectural change to the listener model (and interacts with how a load balancer
  hashes dialogs). Named here with a number so it can be argued on its own.

## 6. Not built

Two of the four scenarios in the brief are **not** in the harness:

- **Carrier INVITE with 401/407 auth retry.** The trunk-ACL admission half is reachable — `startInviteEdge` already
  takes a carrier CIDR and builds the external profile — but the outbound leg to a carrier that challenges needs a fake
  carrier UAS driving `trunk.NewClientRegistrar` / the outbound INVITE path, which is a separate rig.
- **SUBSCRIBE/NOTIFY presence fan-out to 500 watchers.** Needs the subscribe handler wired onto the load edge, 500
  registered watchers each with a socket that accepts inbound NOTIFY requests (the rig's `phone` only reads responses),
  and presence KV churn to drive `Handler.OnPresence`.

Both are additive to the existing harness rather than new infrastructure. They are called out rather than approximated
because a half-rig produces numbers that look like measurements and are not.

## 7. Cross-area needed

- **`packages/runtime-go/health.Start`** builds its own `http.ServeMux` with no extension point, so sipd could not put
  pprof on the private health listener and starts a second one instead. A `health.Options{ExtraRoutes: ...}` (or a
  returned mux) would let every data-plane service expose gated pprof on the one private port it already has. That
  package is the mediad-rtp agent's area.
- **`packages/runtime-go` shared helpers — checked at the end of this work and ADOPTED.** The mediad-rtp agent added
  `runtime-go/netbuf` and `runtime-go/proclimit`, so `serveUDP` now calls `netbuf.Tune(conn, bytes, bytes)` instead of
  its own `SetReadBuffer`/`SetWriteBuffer` pair (and logs the sizes the kernel actually granted, which Linux clamps and
  doubles), and `run()` calls `proclimit.ApplyMemoryLimit(os.Getenv, proclimit.DefaultHeadroomPercent)` at boot — sipd
  previously set no `GOMEMLIMIT` at all, so container memory pressure was an OOM kill that drops every dialog the
  instance holds rather than recoverable GC pressure. No changes were made inside `packages/runtime-go`.
- **`rpc.sip.v1.credential` responder throughput.** The rig's first fake responder used a single callback subscription
  and could not clear 1000 cold lookups inside the 500 ms `TimeoutSipCredentialRPC`; it needed a dedicated connection
  and 16 workers. That is a property of the _responder_, and apps/api's real one is a NestJS handler. Worth checking
  that it is not serialised the same way, because a fleet cold-start is exactly this shape.

## 8. Comment cleanup

Applied the repo comment policy to every file this pass edited (whole file, not just the changed hunks): essay
sections, banner separators, history/process prose and multi-paragraph justifications removed; godoc, package docs,
every RFC reference, the security-boundary reasoning and the locking/ordering invariants kept.

| file                                    | before | after |
| --------------------------------------- | ------ | ----- |
| `cmd/sipd/main.go`                      | 225    | 147   |
| `internal/config/config.go`             | 241    | 176   |
| `internal/kv/kv.go`                     | 132    | 91    |
| `internal/registrar/registrar.go`       | 162    | 92    |
| `internal/registrar/contacts.go`        | 0      | 0     |
| `internal/events/events.go`             | 31     | 29    |
| `internal/sipevents/sipevents.go`       | 62     | 42    |
| `load_harness_test.go`                  | 74     | 52    |
| `load_register_test.go`                 | 57     | 36    |
| `load_invite_test.go`                   | 38     | 26    |
| `internal/registrar/auth_bench_test.go` | 15     | 6     |
| `internal/profile/acl_bench_test.go`    | 6      | 4     |

Comment-only; no executable line changed in that pass, and the full suite is green after it.

## 9. Modern Go guidelines applied

`sync_waitgroup_go` (`group.Go` replaces every `Add`/`go func`/`defer Done` trio in `cmd/sipd/main.go` and in the
harness worker pools), `testing_b_loop` (every new benchmark uses `for b.Loop()`), `testing_t_context` (`t.Context()`
in the load scenarios instead of a hand-rolled cancel), `atomic_types` (`atomic.Int64` for the rig's request counters
instead of a mutex-guarded int), `range_over_int` (`for range n` in the pools and `for attempt := range 16` in the CAS
loop), `errors_as_type` (`errors.AsType[*jetstream.APIError]` in the new `isWrongLastSequence`), `context_after_func`
(`context.AfterFunc` closes the UDP listener and the pprof server on shutdown), `slices_sort` / `slices_clone`
(latency quantiles and the recording publishers' getters), `strings_split_seq` and `bytes_cut` (the harness's TCP
message framer), and `min_max` where a hand-rolled comparison appeared.

## 10. Verification

```
cd apps/sipd
gofmt -l .                      -> (clean, no output)
go vet ./...                    -> clean
go vet -tags integration ./...  -> clean
go vet -tags load .             -> clean
go test -race ./...             -> ok, 18 packages (2 with no test files)
RUN_SIPD_INTEGRATION=1 NATS_SERVER_BIN=... go test -count=1 -tags integration -timeout 10m .
                                -> ok  11.584s
RUN_SIPD_LOAD=1 NATS_SERVER_BIN=... go test -count=1 -tags load -run TestLoad -timeout 20m .
                                -> ok (register storm ×3 transports, invite lifecycle)
go test -run XXX -bench . -benchmem -count=5 ./internal/registrar/ ./internal/profile/
                                -> ok
```

New tests: 3 in `internal/registrar/hint_test.go`, 2 in `registration_atomic_integration_test.go`,
4 benchmarks in `internal/registrar/auth_bench_test.go`, 2 (× 3 sizes) in `internal/profile/acl_bench_test.go`.
