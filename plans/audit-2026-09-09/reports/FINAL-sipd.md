# FINAL-sipd — the two missing load scenarios, comment sweep, modern Go, pprof adoption

Area: `/Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/sipd` (Go 1.26, sipgo v1.4.3, nats.go v1.52.0).
Machine: 18 cores, macOS, shared with other agents. Absolute latency is noisy; delivery ratios, allocation counts
and broker round-trip counts are not, and the report leans on those. Scenarios were run **sequentially**.

Continues `NET-sipd.md`, whose §6 listed these two scenarios as "not built".

---

## 1. What was added to the rig

Two new build-tagged files, additive to the existing harness (`load_harness_test.go`,
`load_register_test.go`, `load_invite_test.go`), gated on `RUN_SIPD_LOAD=1` **and** `NATS_SERVER_BIN`:

| file                    | scenario                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `load_trunk_test.go`    | 3 — carrier INVITE with a 407 challenge and an authenticated retry, 200 concurrent          |
| `load_presence_test.go` | 4 — SUBSCRIBE/NOTIFY presence fan-out, 500 watchers over 5 extensions, 50 and 200 changes/s |

Three small additions to shared harness code:

- `load_harness_test.go` gained `envInt` and a `SIPD_LOAD_LOG_LEVEL` knob on `loadLogger`
  (errors-only remains the default; the knob exists because a fan-out that silently delivers nothing
  is undebuggable at error level).
- `load_invite_test.go`'s `inviteEdge` now carries the `*trunk.Directory` the edge was already
  building, so the carrier scenario can install a trunk without a control plane behind it. No
  behaviour change to scenario 2.

### How to run them

```sh
cd apps/sipd
NATS_SERVER_BIN=<path>/nats-server RUN_SIPD_LOAD=1 \
  go test -count=1 -tags load -run TestLoad -timeout 20m -v .

# scenario 3 alone, with profiles and repeated passes
NATS_SERVER_BIN=<path>/nats-server RUN_SIPD_LOAD=1 SIPD_LOAD_PASSES=6 \
  SIPD_LOAD_PROFILE_DIR=/tmp/sipd-prof \
  go test -count=1 -tags load -run TestLoadTrunkInviteAuthRetry -timeout 10m -v .

# scenario 4 alone
NATS_SERVER_BIN=<path>/nats-server RUN_SIPD_LOAD=1 \
  go test -count=1 -tags load -run TestLoadPresenceFanout -timeout 15m -v .
```

Knobs the two new scenarios add: `SIPD_LOAD_NOTIFY_CONCURRENCY` (sweeps the fan-out bound so the
default can be chosen from a measurement) and `SIPD_LOAD_TRUNK_RPC_DELAY_MS` (models a control
plane that has to reach a secret manager).

---

## 2. Scenario 3 — carrier INVITE with a 407 auth retry

### What it drives

`rpc.sip.v1.originate` (real NATS request/reply onto the production command surface)
→ `invite.Handler.Originate` → trunk directory lookup → INVITE onto a real UDP socket
→ the fake carrier answers `100` then `407 Proxy Authentication Required` with a per-call nonce
→ `pumpInviteTransaction` sees the challenge → `retryOutboundAuthentication`
→ `trunk.NATSAuthorizer.Authorize` → `rpc.sip.v1.trunk-credential` (real responder, real HA1)
→ re-INVITE carrying `Proxy-Authorization` → `100` / `180` / `200 OK` with SDP → ACK.
Teardown per pass is `rpc.sip.v1.hangup`, untimed.

The carrier is a raw-UDP UAS rather than a sipgo one, so a peer built on the library under test does
not hide that library's costs. It **verifies** each retry: the `Proxy-Authorization` must name the
carrier's realm, the nonce issued for _that_ Call-ID, and the trunk's auth user, and the scenario
fails the test if any retry is refused. Completion is the ACK that confirms the 2xx, identified by
the dialog tag — the transaction layer also ACKs the 407, and taking that one as completion would
have measured the challenge instead of the whole retry (it did, in the first draft: 10.5 ms against
a real 7.3 ms, and the flow ended two round trips early).

Concurrency 200 dialogs (the brief's 100–300 band), 64 workers.

### Results (6 passes, `SIPD_LOAD_PASSES=6`, profiling on)

| pass     | calls/s | p50      | p90      | p99      | allocs/call | B/call | broker msgs/call (out) |
| -------- | ------- | -------- | -------- | -------- | ----------- | ------ | ---------------------- |
| 1 (cold) | 5,893   | 10.36 ms | 15.44 ms | 17.94 ms | 1,358       | 113 KB | 4.72                   |
| 2        | 7,438   | 8.69 ms  | 9.83 ms  | 11.07 ms | 1,341       | 108 KB | 4.72                   |
| 3        | 8,181   | 8.06 ms  | 9.00 ms  | 9.71 ms  | 1,333       | 107 KB | 4.69                   |
| 4        | 8,675   | 7.33 ms  | 8.85 ms  | 9.99 ms  | 1,335       | 107 KB | 4.73                   |
| 5        | 8,413   | 7.82 ms  | 10.13 ms | 10.93 ms | 1,336       | 107 KB | 4.75                   |
| 6        | 8,829   | 7.26 ms  | 7.99 ms  | 8.21 ms  | 1,331       | 106 KB | 4.69                   |

1,200 challenges issued, 1,200 authenticated INVITEs accepted, **0 refused**, 1,200 trunk-credential
RPCs served. Goroutines settle at 97 after teardown across 1,200 calls — sipgo transaction retention,
not growth.

Steady state: **~8,500 challenged carrier calls/s, p50 ~7.3 ms, 1,331 allocations per call,
4.7 broker messages per call.**

### Profiles (pass over 6 × 200 calls)

CPU — the process is syscalls and the runtime; no hot business function:

```
0.50s 38.76%  syscall.rawsyscalln
0.19s 14.73%  runtime.usleep
0.13s 10.08%  runtime.pthread_cond_wait
0.10s  7.75%  runtime.kevent
0.05s  3.88%  runtime.pthread_kill
0.04s  3.10%  runtime.madvise
0.04s  3.10%  runtime.pthread_cond_signal
0.04s  3.10%  runtime.scanObjectsSmall
0.02s  1.55%  runtime.scanObject
0.01s  0.78%  bufio.(*Reader).ReadRune
0.01s  0.78%  sipgo/sip.(*ClientTx).inviteStateProcceeding
0.01s  0.78%  sipgo/sip.addressStateHeaderParams
```

Block — 39.7% cum is `dialog.Session.run`'s `selectgo`, which is the session actor _waiting for work_
rather than contention; 5.6% is `nats.Conn.Request`, the trunk credential RPC:

```
77.88s 91.02%  runtime.selectgo        <- 39.66% cum from dialog.(*Session).run
 5.61s  6.55%  runtime.chanrecv2
 1.34s  1.57%  sync.(*Cond).Wait
                 nats.(*Conn).Request cum 4.79s = 5.59%
```

Mutex — 280 ms of contention across the whole 6-pass run. Nothing here is worth a change.

Allocation — no sipd frame above ~2%; the top of the profile is sipgo header parsing (11.5% cum),
the NATS reader and `encoding/json`.

### Fixes made: none, and why

The profiles show no sipd-side overhead on this path worth a code change. The one real overhead
found is architectural and security-sensitive, and is recorded in §5 with the measurement that
sizes it.

---

## 3. Scenario 4 — SUBSCRIBE/NOTIFY presence fan-out

### What it drives

500 synthetic BLF handsets, each on its own **unconnected** UDP socket (a NOTIFY is a new request
from sipd's client socket, so a connected socket would drop it). Each registers through the
production registrar — a SUBSCRIBE from an account with no live binding is refused 403, so the
registration is part of the scenario, not a shortcut — then subscribes to the `dialog` package for
one of five watched extensions (100 watchers each: a BLF wall is many phones on a few busy
extensions, which is what makes the fan-out wide). Each handset answers every NOTIFY with a 200, so
what is measured is delivery and not sipgo's T1 retransmission.

Presence churn is written to the **real `presence` KV bucket** by a separate connection playing the
engine, at 50/s and then 200/s for 8 s each. `subscribe.Handler.Run` watches that bucket for real.

**Correlation.** Each NOTIFY is matched back to the write that caused it through the RFC 4235
`version` attribute: the handler allocates it once per subscription per change, in the caller's
goroutine, _before_ the send goroutine starts — so a shed notification consumes a version too, and a
drop is a missing sample rather than a wrong latency. The acceptance notification's version is
captured per watcher as the base, and change _n_ on a watched extension arrives as `base+1+n`. Two
draft bugs were found and fixed by this: the search for `version="` was hitting the XML declaration's
`version="1.0"`, and the counter is cumulative over the subscription's life, so the change log has to
be cumulative too (it was per-rate at first, which made the second rate's latencies negative).

### The finding: two thirds of every fan-out was being shed

Before, at the shipped `notifyConcurrency = 32`:

| rate  | changes | NOTIFYs owed | delivered          | shed    | NOTIFY/s |
| ----- | ------- | ------------ | ------------------ | ------- | -------- |
| 50/s  | 387     | 38,700       | 12,897 (**33.3%**) | 25,803  | 460      |
| 200/s | 1,471   | 147,100      | 49,920 (**33.9%**) | 122,983 | 1,781    |

The constant's own comment said thirty-two was "well above the rate any real deployment changes state
at". The bound is per **NOTIFY**, not per change: one state transition on an extension with 100
busy-lamp watchers costs 100 concurrent client transactions. So the sizing argument was measuring the
wrong quantity, and a BLF wall — the exact deployment the package exists for — sheds most of its
notifications. Shedding is safe by design (RFC 4235 §3.3 has the watcher keep the higher version), but
"safe" here means lamps that lag, not lamps that lie, and two thirds is not a rounding error.

### Fix 4.1 — the fan-out bound is sized for watchers, and configurable

`internal/subscribe/handler.go`: `notifyConcurrency = 32` → `defaultNotifyConcurrency = 512`, with a
new `Options.NotifyConcurrency` (zero takes the default) and a new exported `Handler.Dropped()` so
the shedding is observable rather than only logged. `Shutdown`'s worker pool uses the same bound.

The value was chosen by sweeping it on the rig, not asserted:

| bound                 | 50/s delivered | 200/s delivered | NOTIFY/s at 200/s | shed    |
| --------------------- | -------------- | --------------- | ----------------- | ------- |
| 32 (before)           | 33.3%          | 33.9%           | 1,781             | 122,983 |
| 128                   | 100%           | 98.3%           | 5,579             | 2,779   |
| **512 (new default)** | **100%**       | **100%**        | **19,834**        | **0**   |
| 1024                  | 100%           | 100%            | 19,834            | 0       |

512 delivers everything at both rates; 1024 buys nothing and doubles the worst-case number of client
transactions an unreachable fleet can hold. **NOTIFY throughput 1,781/s → 19,834/s = 11.1×**, and
delivery 33.9% → 100%.

**Correctness.** Nothing about ordering, versioning or the shed policy changed — a saturated fan-out
still sheds rather than queues, for the reason it always did. What changed is where saturation
starts. The upper bound on concurrent client transactions is still fixed and still enforced by the
same semaphore, so an unreachable fleet is bounded at 512 transactions held for one notify timeout
instead of 32; that is the cost paid for the delivery. `Shutdown` gets the same widening, which
shortens a rolling deploy's deactivation sweep by the same factor.

**Tests** (`internal/subscribe/concurrency_test.go`):
`TestOneChangeReachesEveryWatcherWhenTheBoundAllowsIt` asserts one change reaches all 64 watchers
with nothing shed; `TestASaturatedFanOutShedsAndCountsWhatItShed` holds the single slot open and
asserts the other seven are shed _and counted_, so the policy is pinned rather than assumed.

### Fix 4.2 — one deadline per change, not one per watcher

`internal/subscribe/handler.go`: a new unexported `notifyBatch` holds the `context.WithTimeout`
derived from `h.baseCtx`; `OnPresence`, `OnMWI` and `Sweep` each create one and every notification
they dispatch shares it. It is released when the last notification in the batch finishes.

The before-profile named this directly: `context.WithTimeout` → `propagateCancel` was **23% of all
mutex delay** at 200 changes/s over 500 watchers. Every child of a long-lived cancellable context
takes that context's lock to register and again to unregister, and the old code created one child
_per watcher per change_.

|        | mutex delay from `context.WithTimeout`/`propagateCancel` |
| ------ | -------------------------------------------------------- |
| before | 199.9 ms of 869.6 ms = **23.0%**                         |
| after  | absent from the profile                                  |

**Correctness.** The notifications in a batch all start together and are all abandoned together, so
one shared deadline is the same behaviour as N identical deadlines started at the same instant. Base
context cancellation still propagates. The batch's context is cancelled only after its last
notification returns, so no notification is cut short, and a batch that dispatches nothing cancels
immediately.

### Results after both fixes

| rate  | changes | NOTIFYs owed | delivered      | p50     | p90     | p99     | allocs/NOTIFY | B/NOTIFY | NOTIFY/s |
| ----- | ------- | ------------ | -------------- | ------- | ------- | ------- | ------------- | -------- | -------- |
| 50/s  | 400     | 40,000       | 40,000 (100%)  | 1.91 ms | 3.60 ms | 8.84 ms | 222.9         | 17,058   | 4,968    |
| 200/s | 1,595   | 159,500      | 159,500 (100%) | 1.51 ms | 3.12 ms | 7.68 ms | 226.6         | 17,572   | 19,812   |

Allocations per delivered NOTIFY fell 263 → 227 and bytes 28.4 KB → 17.6 KB, because the shed path's
wasted body composition no longer has to be amortised over a third as many deliveries.

Latency rose from 0.76 ms to 1.5 ms p50 — expected and not a regression: before, the 33% that got
through were the ones that found a free slot immediately.

**Goroutines.** 537 at rest with 500 subscriptions established (one rig reader per watcher plus the
edge). During a fan-out the count reaches ~2,537, i.e. ~4 per in-flight NOTIFY, and returns to 537
when the transactions retire. After all 500 unsubscribe — and after `Handler.Wait` reports the
notification WaitGroup drained — the count sits at ~1,537 and falls to 537 shortly after: that is
sipgo holding each terminal NOTIFY's client transaction for Timer K, not a leak. It does not grow
across passes, which is the test that distinguishes the two.

### After-profiles

Mutex is now entirely sipgo's transaction-layer map lock — `NewClientTransaction` 59.8% cum,
`ClientTx.Terminate` 32.9% cum — which is upstream. Block is 46% `selectgo` and **34.6%
`internal/poll.fdMutex.rwlock`**: the single UDP socket's write lock, the same `SO_REUSEPORT` item
already recorded in `NET-sipd` §5, now visible from a second scenario. Allocation is sipgo header
parsing of the watchers' 200s (24.8% cum) and `BuildNotify` (10.4% cum); `dialogInfoBody`, which was
20.2% cum before, has dropped out of the top of the profile.

---

## 4. Measured and NOT worth changing

- **`Table.Watchers`** allocates a sorted slice per change (a key slice, a sort, a pointer slice).
  At 200 changes/s × 100 watchers this never appeared above the noise in any profile; the two-way
  index it exists to serve is doing its job.
- **`dialogInfoBody`'s `encoding/xml` marshal** — 20.2% of allocations before fix 4.1, out of the top
  of the profile after it. Replacing it with a hand-built string would mean hand-rolling the escaping
  of an entity and a resource that arrived from the wire, which is what the function's own comment
  refuses for a good reason. Not worth it at 19.8k NOTIFY/s.
- **`retryOutboundAuthentication`'s watchdog goroutine** (one per challenged carrier call, cancelling
  the credential lookup when the session ends). `context.AfterFunc` was tried and does not apply:
  `dialog.Session.Done()` is a channel, not a context. Left alone.
- **Mutex contention on the carrier path** — 280 ms total across 1,200 calls. Nothing to narrow.

## 5. Measured, real, and deliberately NOT done

- **The carrier credential is resolved by RPC once per CALL.** `trunk.NATSAuthorizer.Authorize` has
  no cache and no request collapsing, unlike `credentials.NATSStore`, which has both for subscriber
  HA1s. The nonce changes per call so the _digest_ is not cacheable, but the HA1 is: it is keyed by
  (org, trunk, realm, algorithm) and changes only when the carrier password does.

  Sensitivity, measured by delaying the rig's credential responder to model a control plane that has
  to reach a secret manager (3 passes each, steady-state pass quoted):

  | responder latency | calls/s | p50      |
  | ----------------- | ------- | -------- |
  | 0 ms              | 8,944   | 6.84 ms  |
  | 5 ms              | 2,809   | 21.39 ms |
  | 20 ms             | 732     | 83.92 ms |

  A 5 ms control-plane resolver costs **−69% throughput and +3.1× p50**; 20 ms costs −92% and
  +12×. Every challenged carrier call is serialised behind a control-plane round trip inside the
  carrier's own retransmission window, and a control plane that is slow or down takes outbound
  trunking with it.

  Not done here because it is a security-posture change, not a performance change: caching a carrier
  password-equivalent in the internet-facing SIP edge lengthens the window that secret lives in
  sipd's heap. The precedent exists (`credentials.NATSStore` caches subscriber HA1s), so the answer
  may well be yes — but it needs a TTL, an invalidation path from the trunk directory watch, and a
  decision made by whoever owns the secret boundary, not inside a performance pass. The rig now has
  the before number and the knob to re-measure with.

- **`icholy/digest` header parsing** — unchanged from `NET-sipd` §5. 52 allocs / 7.2 KB / 2.09 µs per
  `ParseAuthorization`. Still a security-sensitive rewrite (an RFC 7616 auth-param parser needs a
  fuzz corpus), still not attempted. `internal/trunk/auth.go` uses the same library for the carrier
  challenge, so the carrier path pays it too — visible in the scenario-3 allocation profile but well
  under the sipgo parsing above it.

- **`internal/poll.fdMutex.rwlock` — 34.6% of block time in scenario 4**, 47% in the register storm.
  Every write on the single `*net.UDPConn` serialises on the Go runtime's fd lock, and the NOTIFY
  fan-out is now a second workload that hits it hard. Removing it means `SO_REUSEPORT` with one
  socket and one reader per core: an architectural change to the listener model that interacts with
  how a load balancer hashes dialogs. Recorded, with a second measurement behind it.

- **sipgo's transaction-layer map lock** — 60% of mutex delay in scenario 4 after the fixes, split
  between `NewClientTransaction` and `Terminate`. Upstream, and the next ceiling on NOTIFY
  throughput above ~20k/s.

## 6. pprof now rides the private health listener

`packages/runtime-go/health` **does** expose the extension `NET-sipd` §7 asked for:
`health.WithPprof(bool)`, which registers the five `net/http/pprof` handlers on the health mux and
widens that server's write timeout so `go tool pprof -seconds=30` works. It was adopted.

- `internal/config/config.go`: `PProfAddr string` → `PProfEnabled bool` (`SIPD_PPROF`, off by
  default). `cmd/sipd/main.go`: `startPProf` and its second `http.Server` deleted; `health.Start` now
  takes `health.WithPprof(cfg.PProfEnabled)`.
- **The loopback gate is kept, and moves with the handlers**: `SIPD_PPROF` is refused unless
  `SIPD_HEALTH_ADDR` is set and names a loopback host. So enabling profiling on a health listener
  bound to `0.0.0.0` for a kubelet probe is a boot-time configuration error, exactly as a
  non-loopback `SIPD_PPROF_ADDR` used to be.
- `SIPD_PPROF_ADDR` is **refused** rather than ignored, with a message naming the replacement:
  silently dropping it would leave an operator profiling a port nothing is listening on.
- `README.md` updated. No changes were made inside `packages/runtime-go`.

**Test**: `internal/config/config_test.go` `TestPprofRequiresALoopbackHealthListener` — four refusal
cases (no health listener, wildcard health address, external health address, the retired variable)
and one acceptance.

## 7. Comment sweep

Applied the repo comment policy to every sipd Go file **not** among the twelve the networking pass
already swept. Comment-only: no executable line changed in this pass.

101 files, **6,260 → 4,184 comment lines, −2,076 (−33%)**.

| package                                    | files   | before    | after     | delta             |
| ------------------------------------------ | ------- | --------- | --------- | ----------------- |
| root package (integration suites)          | 5       | 266       | 222       | −44 (17%)         |
| `cmd/sipd` (watch.go, watch_test.go)       | 2       | 12        | 10        | −2                |
| `internal/acl`                             | 2       | 151       | 72        | −79 (52%)         |
| `internal/aor`                             | 3       | 217       | 140       | −77 (35%)         |
| `internal/command`                         | 3       | 318       | 186       | −132 (42%)        |
| `internal/config` (test only)              | 1       | 24        | 24        | 0                 |
| `internal/credentials`                     | 7       | 317       | 214       | −103 (32%)        |
| `internal/dialog`                          | 19      | 1,339     | 936       | −403 (30%)        |
| `internal/invite`                          | 18      | 1,177     | 711       | −466 (40%)        |
| `internal/kv` (test only)                  | 1       | 4         | 4         | 0                 |
| `internal/mwi`                             | 2       | 80        | 59        | −21 (26%)         |
| `internal/nat`                             | 2       | 185       | 113       | −72 (39%)         |
| `internal/presence`                        | 2       | 72        | 53        | −19 (26%)         |
| `internal/profile`                         | 3       | 226       | 144       | −82 (36%)         |
| `internal/reaper`                          | 2       | 166       | 116       | −50 (30%)         |
| `internal/registrar` (auth, expiry, tests) | 6       | 186       | 162       | −24 (13%)         |
| `internal/subscribe`                       | 7       | 608       | 441       | −167 (27%)        |
| `internal/transfer`                        | 7       | 381       | 259       | −122 (32%)        |
| `internal/trunk`                           | 9       | 531       | 318       | −213 (40%)        |
| **total**                                  | **101** | **6,260** | **4,184** | **−2,076 (−33%)** |

What went, consistently across every package: `// # Why …` headed design essays (keeping the invariant
and dropping the argument), decorative section banners (~25 of them), history and process prose
("used to", "until that lands", "it HAS LANDED", "the parity audit's row 1.26", "this wave", dead
phase names), references to plan documents and to source line numbers that no longer point anywhere,
and test comments the test's own name already stated. Kept: every RFC citation, every
security-boundary note, every ownership/locking/ordering invariant, `//go:build` lines (all five
`integration` tags verified intact), `//nolint` reasons, and the two new measurement-backed godocs on
`defaultNotifyConcurrency` and `notifyBatch`.

### Comments that were factually wrong, and were corrected

| file                                  | was                                                                                                                      | is                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `internal/trunk/directory.go`         | "swapped on every update … the map is replaced wholesale under a write lock"                                             | `Put`/`Remove` mutate in place under `d.mu`; the doc now says so                                            |
| `internal/trunk/gateway.go`           | `RefreshAfter` "floored at ten seconds"                                                                                  | ten seconds is the threshold that selects the fallback branch, not a floor on the result                    |
| `internal/transfer/handler.go`        | "HA2 is MD5(method:uri)"                                                                                                 | the algorithm is negotiated; `hash(method:uri)`                                                             |
| `internal/command/handlers.go`        | `HandleOriginate`'s godoc was attached to `HandleResolveTarget`, which had none                                          | each has its own, correct, doc                                                                              |
| `internal/command/command.go`         | "five command subjects", "four per-instance and one flat"                                                                | six handlers over seven subscriptions (four per-instance, two flat queue-grouped, `originate` on both)      |
| `internal/command/handlers.go`        | `commandTimeout`: "deliberately SHORTER than nothing and longer than the contract's deadline is not an option" (garbled) | states the actual invariant: the caller's budget is the real bound, this only stops handler-goroutine leaks |
| `internal/command/handlers.go`        | `OriginateQueueGroup` "the flat `originate` subject"                                                                     | it also carries `resolve-target`                                                                            |
| `internal/dialog/state.go`            | `roleAllows`: "the two lists are exhaustive … a trigger added later is refused loudly"                                   | there is no `default`; teardown and timeout triggers are legal for both roles                               |
| `internal/dialog/cause.go`            | "the canonical copy will live in packages/events-go; until that lands this is the copy"                                  | it already imports from `events-go`, ten lines above                                                        |
| `internal/dialog/store.go`            | `ClaimStore`: "now that the bucket exists … It has LANDED"                                                               | states what the seam is for                                                                                 |
| `internal/dialog/dialog.go`           | "the same bytes **line 550** committed"                                                                                  | dead line reference removed                                                                                 |
| `internal/dialog/identity.go`         | cited `dialog_server.go:144-160` in a vendored dependency                                                                | dead reference removed                                                                                      |
| `internal/invite/executor.go`         | `armSessionTimer`: "the other side arms the EXPIRY. Both end up here"                                                    | the code arms exactly one of the two                                                                        |
| `internal/invite/handler.go`          | `HandleCancel`: a matching CANCEL "never reaches here"                                                                   | it does, for a matched dialog; reworded to "did not match a live INVITE transaction"                        |
| `internal/invite/replaces.go`         | `correlateReplaces` documented 603 and 501 answers                                                                       | it returns only 481, 486 and 500                                                                            |
| `internal/invite/port.go`             | `refusals` "reproduces every row's justification"                                                                        | three rows carry none                                                                                       |
| `internal/mwi/mwi.go` + `mwi_test.go` | `voicemail.evt.v1.*.*.mwi.updated` "has six tokens"                                                                      | it has seven                                                                                                |
| `internal/credentials/credentials.go` | HA1 is "what apps/api will eventually return"                                                                            | apps/api already returns it                                                                                 |
| `internal/credentials/nats.go`        | `Forget`: "Nothing calls it yet"                                                                                         | states what the seam is for                                                                                 |
| `integration_test.go`                 | described the former 501 answer to `presence` as if current                                                              | states the current contract (489 + honest `Allow-Events`)                                                   |
| `command_integration_test.go`         | "W12.5's NATS surfaces" (dead phase name)                                                                                | "sipd's NATS surfaces"                                                                                      |
| `cmd/sipd/watch.go`                   | godoc did not start with the identifier                                                                                  | it does                                                                                                     |
| `internal/reaper/reaper.go`           | `Sweep`'s `#` heading abutted the summary, rendering as one run-on godoc paragraph                                       | restructured                                                                                                |

### Code that looks wrong and was NOT touched (comment-only pass; reported, per the policy)

- `internal/dialog/dialog.go` — `effectsFor`'s `TriggerLocalAck` case has two identical branches
  (`if from != StateEstablished { return X }; return X`); `hangupEffects`' `StateTerminating` default
  is the same shape (`if alreadyRequested { return nil }; return nil`), so `alreadyRequested` exists
  only to make the branch compile.
- `internal/command/handlers.go` — `HandleResolveTarget` reaches target resolution by asserting
  `s.dialogs` to an anonymous `interface{ ResolveTarget(...) }`. A typo in that signature degrades
  silently to a runtime `not_supported` instead of failing to compile, and the refusal path replies
  with `SipOriginateResponse` on a subject whose success path replies `SipResolveTargetResponse`.
- `internal/invite/handler.go` `Wait` and `internal/transfer/handler.go` `Wait` — both leak the
  waiting goroutine on the timeout path. Shutdown-only and bounded.
- `internal/invite/requests.go` `ClientRequester.Send` — a bare goroutine per non-ACK request, not
  tied to `backgroundWork`, so a shutdown `Wait` does not cover it.
- `internal/invite/originate.go` `pumpInviteTransaction` — after an auth retry the superseded
  transaction's `OnRetransmission` still writes into `retransmissions`, which nobody reads once the
  loop returns. Bounded at cap 16, so not a leak, but a retransmitted 2xx on the old transaction is
  dropped.
- `internal/invite/replaces.go` — a Replaces naming a dialog on another instance is answered 481,
  indistinguishable from a hung-up consultation call. (The comment was corrected; the mapping was not.)
- `internal/presence/presence.go` — `MemoryStore.Watch` hands the _same_ channel to every caller and
  never closes it. Test-only today.
- `internal/mwi/mwi.go` — `Updates`' `SetClosedHandler` closes `updates` while the message callback
  may still be sending on it: a send on a closed channel if the connection drops mid-decode. Also
  `fmt.Errorf` with no verbs where `errors.New` belongs.
- `internal/trunk/auth.go` — `case 401:` has an empty body (correct: it falls out of the switch
  leaving the WWW-Authenticate names), but reads as an accidental empty case.
- `internal/trunk/register.go` — `registrarURI` takes a `Config` it discards with `_ = config`.
- `internal/trunk/supervisor.go` — `gatewayRunner.arm` turns a legitimately-zero
  `ActionScheduleRefresh` into a one-second timer.
- `internal/acl/acl.go` — `recompile`'s error log indexes `keys` with an index from ranging
  `records`; correct only because `records` is built in `keys` order immediately above.
- `internal/aor/aor.go` — `func (s Set) Clear() Set { return Set{} }` ignores its receiver.
- `internal/subscribe/subscription.go` — the `Table` field is named `byResourc` (truncated).
- `cmd/sipd/watch.go` — `else` after a `return` (revive's indent-error-flow); redundant `if` guard
  around a `min` that already clamps.

## 8. Modern Go

Ran `run-tool.sh list --file-path` over every file before editing it and applied every guideline that
fit. Behaviour-neutral throughout: no exported API changed, no test assertion changed, and the suite
is green.

| guideline                                                      | where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync_waitgroup_go`                                            | `dialog/session.go`, `dialog/session_test.go` ×3, `dialog/store_test.go` ×2, `invite/handler.go`, `invite/originate.go`, `invite/executor.go` ×3, `subscribe/handler.go` ×3, `transfer/handler.go`, `trunk/supervisor.go` ×3, `credentials/nats_internal_test.go`                                                                                                                                                                                                                                             |
| `testing_t_context`                                            | `subscribe/handler_test.go` ×6, `invite/handler_test.go` ×5, `invite/publisher_internal_test.go` ×9, `invite/outbound_network_test.go`, `reaper/reaper_test.go` ×14, `dialog/session_test.go`, `dialog/store_test.go`, `trunk/gateway_test.go`, `transfer/handler_test.go` ×2, `credentials/credentials_test.go` ×5, `credentials/nats_internal_test.go`, `registrar/registrar_test.go`, `cmd/sipd/watch_test.go`, `integration_test.go`, `command_integration_test.go`, `credential_rpc_integration_test.go` |
| `slices_sort_func` / `slices_sorted` / `maps_keys_values_iter` | `subscribe/subscription.go` (`TakeExpired`, `sorted`), `dialog/claims.go`, `dialog/store.go` ×4, `trunk/directory.go`, `profile/acl.go`, `aor/aor.go`, `acl/acl.go` — `sort` import dropped from five files                                                                                                                                                                                                                                                                                                   |
| `slices_clone`                                                 | `dialog/session.go`, `invite/handler.go` ×2, `invite/handler_test.go` ×2, `port.go`, `transfer/handler_test.go` ×2, `trunk/status.go`, `reaper/reaper_test.go` ×2, `acl/acl.go` ×2, `aor/aor.go` ×3                                                                                                                                                                                                                                                                                                           |
| `slices_contains` (→ `ContainsFunc`)                           | `dialog/dialog.go`, `trunk/gateway.go`, `profile/profile.go`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `min_max`                                                      | `dialog/timers.go` ×3, `dialog/offer.go`, `invite/executor.go`, `trunk/gateway.go` ×3, `nat/nat.go`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `strings_split_seq` / `bytes.SplitSeq`                         | `dialog/offer.go`, `dialog/timers.go`, `invite/handler.go`, `invite/requests.go`, `nat/nat.go`                                                                                                                                                                                                                                                                                                                                                                                                                |
| `strings_cut`                                                  | `presence/presence.go` (`splitKey`'s hand-rolled byte scan)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `new_expression`                                               | `invite/client.go` ×3, `invite/publisher.go`, `trunk/status.go` ×2, `transfer/handler.go`, `reaper/reaper.go`, `command/command.go`, `acl/acl_test.go`, `load_trunk_test.go`                                                                                                                                                                                                                                                                                                                                  |
| `errors_as_type`                                               | `load_presence_test.go`, `load_trunk_test.go` (`err.(net.Error)` → `errors.AsType[net.Error]`)                                                                                                                                                                                                                                                                                                                                                                                                                |
| `cmp_or`                                                       | `invite/port.go` (the `orDefault` helper deleted), `subscribe/handler.go` (`NotifyConcurrency` default)                                                                                                                                                                                                                                                                                                                                                                                                       |
| `context_after_func`                                           | `mwi/mwi.go` (`Updates`' unsubscribe watchdog goroutine)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `range_over_int`                                               | `dialog/session_test.go` ×2, `aor/aor_test.go`, `aor/contacts_test.go`, `registrar/registrar_test.go`                                                                                                                                                                                                                                                                                                                                                                                                         |
| `clear`                                                        | `registrar/auth.go` (`nonceGuard.sweepLocked`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `bytes_clone`                                                  | `dialog/offer.go` ×2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `slices_reverse`                                               | `invite/requests.go` (`routeSetOf`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `slices_collect`                                               | `invite/outbound_network_test.go`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Deliberately skipped, with reasons: `min_max` on `trunk/supervisor.go`'s `if after <= 0 { after =
time.Second }` (would change behaviour for sub-second delays); `strings_split_seq` where the result
is index-addressed (`invite/replaces.go`, `trunk` `ParseReplaces`); `context_after_func` in
`invite/originate.go`'s `retryOutboundAuthentication` — `dialog.Session.Done()` is a channel, not a
context, so the guideline does not apply; `testing_b_loop` (the two existing benchmark files already
use `b.Loop()`); `json_omitzero` (every `omitempty` field in scope is a string or slice, which the
guideline says to leave); `atomic_types`, `errors_is`, `time_since`/`time_until` (already correct at
every call site).

## 9. Verification

All from `apps/sipd`, after every change in this pass.

```
gofmt -l .                                   -> (clean, no output)
go vet ./...                                 -> clean
go vet -tags integration ./...               -> clean
go vet -tags load ./...                      -> clean
go test -race ./...                          -> ok, 21 packages (2 with no test files), 0 failures

RUN_SIPD_INTEGRATION=1 NATS_SERVER_BIN=<...>/nats-server \
  go test -race -count=1 -tags integration -timeout 15m ./...
                                             -> ok, root package 13.716s; all 21 packages ok

RUN_SIPD_LOAD=1 NATS_SERVER_BIN=<...>/nats-server \
  go test -count=1 -tags load -run 'Load' -timeout 30m ./...
                                             -> ok, root package 24.056s
```

The gated load suite in that single run, all four scenarios, no failures and no re-run needed:

```
--- PASS: TestLoadInviteLifecycle (2.19s)
      dialogs-1: 300 ops (0 failed) = 5,338 dialogs/s, p50 10.04 ms, 1,426 allocs/op
--- PASS: TestLoadPresenceFanout (18.43s)
      churn-50ps:  40,000 of 40,000 NOTIFYs delivered (100%), 0 shed, 4,967 NOTIFY/s, p50 1.65 ms
      churn-200ps: 158,300 of 158,300 delivered (100%), 0 shed, 19,663 NOTIFY/s, p50 1.31 ms
--- PASS: TestLoadRegisterStorm (0.48s)
      udp cold 22,333 regs/s / refresh 34,668 (2.00 broker msgs per REGISTER)
      tcp cold 43,222 / refresh 46,334;  ws cold 29,722 / refresh 33,087
--- PASS: TestLoadTrunkInviteAuthRetry (2.67s)
      carrier-1: 200 of 200 challenged calls (0 failed) = 10,479 calls/s, p50 5.59 ms
```

**Noise, honestly.** Other agents were loading the same machine throughout. Latency figures move
10–30% between otherwise identical runs and single-pass throughput numbers (the `-run 'Load'` line
above shows 10,479 calls/s where the six-pass profiling run settled at ~8,500) should be read as
order-of-magnitude only. What is exact and reproducible across every run: the NOTIFY **delivery
ratio** (33% → 100%), the **shed count** (122,983 → 0), **allocations per operation**, **broker
messages per operation**, and the presence of `context.WithTimeout` in the mutex profile. The report
leans on those. The trunk scenario's "goroutines 180" in the combined run is higher than the 97 it
reports when run alone, because all four scenarios share one test process and sipgo transaction
retention from the earlier scenarios has not expired yet — not growth.

Test counts added by this pass: 2 in `internal/subscribe/concurrency_test.go`, 1 (5 sub-cases) in
`internal/config/config_test.go`, 2 gated load scenarios (`TestLoadTrunkInviteAuthRetry`,
`TestLoadPresenceFanout`).

Nothing was committed and git state was not otherwise touched. No changes were made inside
`packages/runtime-go`.
