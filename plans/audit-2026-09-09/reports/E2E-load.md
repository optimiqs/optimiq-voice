# E2E — the LOAD wave (Phase 3)

Run 2026-09-09 19:55 → 20:40 UTC against the live stack, no service restarted. The marker
`<scratchpad>/e2e/LOAD-RUNNING` was held for the whole wave.

Harness: `apps/sipd/e2e_load_test.go` (build tag `e2e`, new) — `TestE2ECallStorm`,
`TestE2ERegistrationChurn`, `TestE2ECredentialRPCBurst`, driving the real `sipua` test UA over
loopback UDP against the real sipd/engine/mediad/api. Roster, sampler and runner live in
`<scratchpad>/load/` (`mkext.mjs`, `roster.mjs`, `derive.mjs`, `sample.sh`, `run.sh`, `http.sh`).

```sh
SIPD_E2E=1 SIPD_E2E_ROSTER=<scratchpad>/load/roster.json \
  SIPD_E2E_STORM_PAIRS=200 SIPD_E2E_STORM_SECONDS=20 SIPD_E2E_REG_CONCURRENCY=50 \
  go test -count=1 -tags e2e -run TestE2ECallStorm -v -timeout 20m .
```

Extensions **5000–6099** (1 100) were created through `POST /api/v1/extensions` in the smoke org
`01a08708-4cd4-76b9-b56d-d26ebf326b0a`, all under `sipSecretRef: secret://load-storm/<number>`.
Nothing belonging to another agent was touched.

---

## 1. Call storm

| Scenario         | N calls        | setup-to-ring p50 / p99 | ring-to-audio p50 / p99 | teardown p50 / p99 | RTP received   | loss  | failed legs             |
| ---------------- | -------------- | ----------------------- | ----------------------- | ------------------ | -------------- | ----- | ----------------------- |
| baseline         | 2              | 31 ms / 33 ms           | 27 ms / 31 ms           | <1 ms              | 1 026          | **0** | 0                       |
| storm-10         | 10             | 51.5 ms / 64.6 ms       | 25.8 ms / 29.7 ms       | 468 µs / 1.20 ms   | 19 980         | **0** | 0                       |
| storm-100        | 100            | **478 ms / 819 ms**     | 27.6 ms / 44.8 ms       | 340 µs / 1.53 ms   | 195 816        | **0** | 2 (harness)             |
| storm-200        | 200            | **371 ms / 764 ms**     | 28.6 ms / 35.5 ms       | 380 µs / 1.77 ms   | 373 670        | **0** | 13 (11 harness, 2 real) |
| churn + 50 calls | 750 over 5 min | 145 ms / 559 ms         | 8.0 ms / 38.4 ms        | 289 µs / 1.42 ms   | **11 989 728** | **0** | 0                       |

Each leg carried 20 s of paced G.711 at 50 pps in both directions.

**Zero RTP packets lost across 12.6 million.** Media is not the constraint at any point in this wave;
`ring-to-audio` barely moves from 10 to 200 concurrent calls. What degrades is **signalling setup**:
setup-to-ring goes 51 ms → 478 ms between 10 and 100 concurrent calls, a 9× inflation, and does not
get worse from 100 to 200 — the signature of a saturated single resource that is already flat.

### Failed legs, classified

| Failure                                                             | Count | Verdict                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BYE: sipua: parsing "\x80\xc8…"`                                   | 8 + 2 | **Harness.** An RTCP sender report (`0x80 0xc8`) arrived on a test UA's SIP socket; with 400 ephemeral loopback sockets an RTCP port collides with a SIP port. Not a product defect.                            |
| `INVITE: received a *sip.Request, want a response`                  | 3     | **Harness.** The UA's response read raced an inbound request on its own shared socket.                                                                                                                          |
| `the caller's INVITE ended <nil> (no response before the deadline)` | 2     | **Real.** At 200 concurrent the engine admitted 197 of 200 and finished 195 routing walks; 2 walks produced no final response inside the UA's 20 s. ~1 % at 200 concurrent, with the engine at ~96 % of a core. |

## 2. Resource use per scenario

| Scenario              | sipd | mediad | engine   | api  | nats  |
| --------------------- | ---- | ------ | -------- | ---- | ----- |
| storm-10 peak CPU %   | 0.0  | 6.5    | 0.2      | 0.4  | 0.3   |
| storm-100 peak CPU %  | 12.5 | 37.7   | **98.4** | 7.0  | 39.4  |
| storm-200 peak CPU %  | 43.9 | 88.9   | **95.9** | 33.7 | 107.4 |
| churn+50 peak CPU %   | 46.5 | 53.6   | **91.9** | 66.8 | 89.2  |
| storm-200 peak RSS MB | 58   | 39     | 162      | 269  | —     |
| churn peak RSS MB     | 114  | 32     | 280      | 285  | —     |

`%cpu` is per-process against one core (macOS `ps`), so >100 % means multi-core. **The engine is
the bottleneck: pegged at 98 % of ONE core at 100 concurrent calls, and no higher at 200 because it
cannot go higher.** Node is single-threaded and the routing walk runs on that thread. sipd, mediad
and NATS are all Go/C and spread across the 18 cores available; none of them is near its ceiling.

Note the load generator itself ran on the same host (400 UAs × 50 pps), so absolute CPU figures are
pessimistic for every service. The _shape_ — engine flat at one core while everything else scales —
is not affected by that.

### Goroutines and heap, before / peak / after

| Scenario                     | sipd goroutines | mediad goroutines | sipd heap | mediad heap |
| ---------------------------- | --------------- | ----------------- | --------- | ----------- |
| before                       | 49              | 43                | 2.6 MB    | 1.4 MB      |
| storm-100 peak               | 1 049           | 643               | 11.8 MB   | 4.9 MB      |
| storm-200 peak               | 2 236           | 1 219             | 22.4 MB   | 8.9 MB      |
| churn peak                   | **5 015**       | 343               | 54.2 MB   | 5.3 MB      |
| **after everything settled** | **50**          | **43**            | 11.5 MB   | 1.9 MB      |

**Goroutines return to baseline.** The `settled` snapshots taken 20 s after each storm still showed
349 / 636 / 2 183 — that is sipgo's transaction layer inside Timer J and the dialog reaper window,
not a leak: a later sample shows exactly 50 (baseline 49) and mediad never moved off 43.

sipd RSS stayed at 193 MB after the churn while its heap is 11.5 MB, i.e. Go has not returned freed
pages to the OS (darwin `MADV_FREE`). RSS overstates; the heap is the number that matters and it
came back.

### Broker, Postgres, event-loop lag

| Metric                                           | Value                                                      |
| ------------------------------------------------ | ---------------------------------------------------------- |
| NATS `slow_consumers`                            | **0** at every sample, every scenario                      |
| NATS connections                                 | flat at 26 throughout (api 22, engine 2, sipd 1, mediad 1) |
| Postgres backends, all DBs, during calls         | peak **10** total, 5 active                                |
| engine `/healthz` latency (event-loop-lag proxy) | max **7 ms** under full storm                              |
| api `/api/auth/ok` latency (same proxy)          | max **7 ms** under full storm                              |

Neither Node process _blocks_; the engine is CPU-saturated but its loop keeps turning, which is why
setup latency inflates smoothly rather than timing out.

The engine and api expose no event-loop-delay metric. `perf_hooks.monitorEventLoopDelay` on the
engine's `/healthz` would be a few lines — but `apps/engine/src/health/health.controller.ts` is the
file the ownership/adoption agent is editing, so it is off limits for this pass. **Recommended for
its owner.** The health-endpoint latency above is the substitute measurement.

### Log volume per call

| Scenario          | sipd       | mediad    | engine    | api       | WARN+          |
| ----------------- | ---------- | --------- | --------- | --------- | -------------- |
| storm-100         | 3.0 /call  | 6.0 /call | 3.0 /call | 0.2 /call | **0**          |
| storm-200         | 4.4 /call  | 6.9 /call | 2.9 /call | 0.2 /call | 100 (0.5/call) |
| churn (750 calls) | 14.4 /call | 8.1 /call | 3.1 /call | 0.8 /call | 6 936          |

On the pure SIP-UA path steady-state log noise is **essentially zero** — the 7.2 WARN/call in
`E2E-resilience.md` came from the browser/WS path (`ACK missed`, stale WS bindings), none of which
this wave provokes. The two WARN populations that did appear:

- **`SIP teardown did not receive a final response`** (100 at storm-200, 650 during churn) — my test
  UA never answers the BYE sipd sends it. **Harness artefact, not a product finding.**
- **`cannot look up the account`** (6 286 during churn) — real, and the subject of §3.

---

## 3. The finding: a REGISTER burst is answered `403`, and it should be `503`

### What happened

The first 100-pair storm failed before it started: **8 of 200 phones got `403 Forbidden` on
REGISTER**, and sipd logged

```
ERROR cannot look up the account username=5177
      error="credentials: credential lookup failed: rpc.sip.v1.credential: context deadline exceeded"
```

The credential RPC exceeded its 500 ms contract deadline (`TimeoutSipCredentialRPC`), and sipd
answered the phone `403`. **`403` is the wrong status.** RFC 3261 makes it "the server understood
the request and refuses to fulfil it; re-attempting will not help" — a handset that receives it
marks the account failed and stops. A backend that did not answer is not a claim about the account;
`503 Service Unavailable` is the retriable answer (§21.5.4). The consequence at scale is that one
slow window in the api can black out a fleet until somebody re-provisions it.

### The responder's actual capacity, measured

`TestE2ECredentialRPCBurst` fires N concurrent `rpc.sip.v1.credential` requests for distinct
accounts straight at the broker:

| Burst | p50     | p90     | p99        | over the 500 ms contract | throughput |
| ----- | ------- | ------- | ---------- | ------------------------ | ---------- |
| 1     | 12 ms   | 12 ms   | 12 ms      | 0                        | —          |
| 50    | 81 ms   | 123 ms  | 126 ms     | 0                        | 397/s      |
| 200   | 276 ms  | 436 ms  | **458 ms** | 0                        | 436/s      |
| 400   | 435 ms  | 739 ms  | 792 ms     | **162**                  | 503/s      |
| 800   | 836 ms  | 1.435 s | 1.563 s    | **575**                  | 509/s      |
| 1 000 | 1.026 s | 1.788 s | 1.960 s    | **778**                  | 508/s      |

**~510 lookups/s, flat from 400 concurrent upward**, with the api at ~76 % of one core and only
3–5 `optimiq_pbx` backends ever active out of a pool of 10. So the ceiling is the api's single
Node thread and `MAX_IN_FLIGHT = 32`, **not** the database pool. A 200-wide REGISTER burst lands at
p99 458 ms — inside the 500 ms deadline by 42 ms, which is exactly why 8 of 200 tipped over.

### And it recurs on every refresh cycle

The churn scenario (1 000 phones, 60 s expiry, refreshing at 30 s) produced **6 286
`cannot look up the account` errors** — 6 456 of 10 000 refreshes failed. The reason is structural:
`SIPD_CREDENTIAL_CACHE_TTL` defaults to **30 s** and a 60 s-expiry fleet refreshes at ~30 s, so
every refresh lands exactly at cache expiry and becomes an RPC. One thousand of them fire together.

I did **not** lengthen that TTL. Its comment states the tradeoff explicitly — "a longer positive TTL
lets an account disabled minutes ago still register" — and there is no disable-invalidation channel
to compensate. Trading a documented security property for throughput is not a change a load number
justifies.

### The fix applied

`403 → 503` on the infrastructure arm of the credential-lookup switch, at all four call sites. The
refusal arms (`ErrNotFound`, `ErrDisabled`) still answer an identical `403 Forbidden` so the
response cannot be used to enumerate extensions — that property is untouched.

| File                                        | Change                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/sipd/internal/registrar/registrar.go` | `statusUnavailable = 503`; REGISTER answers 503 when the lookup itself failed          |
| `apps/sipd/internal/invite/handler.go`      | same for INVITE (reuses the file's `statusServiceUnavail`)                             |
| `apps/sipd/internal/subscribe/handler.go`   | same for SUBSCRIBE                                                                     |
| `apps/sipd/internal/transfer/handler.go`    | same for REFER                                                                         |
| `apps/sipd/README.md`                       | the troubleshooting table said `403` for "nobody subscribed to the subject"; corrected |

Tests, one per surface:

- `internal/registrar/registrar_test.go` — `TestUnknownAccountAndForeignAORAreRefused/credential RPC unavailable`
- `internal/invite/handler_test.go` — `TestInviteWhenTheCredentialRPCIsUnavailable`
- `internal/subscribe/handler_test.go` — `TestSubscribeWhenTheCredentialRPCIsUnavailable`
- `internal/transfer/handler_test.go` — `TestReferWhenTheCredentialRPCIsUnavailable`

**Needs restart** — sipd, to take effect on the live stack. I did not restart it.

---

## 4. API HTTP under load

`autocannon -c 200 -d 20` with a real session cookie for the smoke org's owner. `/api/v1/live/snapshot`
does not exist as an HTTP route — the live snapshot is delivered over the WebSocket
(`live-gateway.ts`, `op:"snapshot"`), so the third hot endpoint measured is `/api/v1/cdr`.

| Endpoint                          | req/s | p50    | p97.5  | p99        | max    | errors         | api CPU % | peak backends (pool cap)           |
| --------------------------------- | ----- | ------ | ------ | ---------- | ------ | -------------- | --------- | ---------------------------------- |
| `GET /api/v1/extensions?limit=25` | 614   | 309 ms | 483 ms | **525 ms** | 713 ms | **0 / 12 278** | 155       | `voice_api` 5/10, `voice_pbx` 5/10 |
| `GET /api/v1/cdr?limit=25`        | 501   | 362 ms | 645 ms | **669 ms** | 693 ms | **0 / 10 011** | 137       | `voice_api` 5/10, `voice_cdr` 5/10 |
| `GET /api/v1/me/softphone`        | 773   | 242 ms | 370 ms | **502 ms** | 562 ms | **0 / 15 457** | 110       | `voice_api` 5/10, `voice_pbx` 5/10 |

**Zero errors on 37 746 requests.** Latency is queueing, not work: p50 ≈ 200 connections ÷ 614 req/s
≈ 326 ms, which is what the table shows.

### `AUTH_DATABASE_MAX_CONNECTIONS = 10` — is it the ceiling? No.

`pg_stat_activity`, sampled twice a second by database and role for the whole run:

| Pool                                 | Configured | Peak backends observed | Peak active |
| ------------------------------------ | ---------- | ---------------------- | ----------- |
| `optimiq_voice` / `voice_api` (auth) | 10         | **5**                  | 5           |
| `optimiq_pbx` / `voice_pbx`          | 10         | **5**                  | 4           |
| `optimiq_cdr` / `voice_cdr`          | 10         | **5**                  | 5           |

Every pool sat at half its cap at 200 connections and 773 req/s, on three different endpoints, with
no request errors and no connection-acquisition stalls. The api saturates its own CPU (110–155 % —
the Node thread plus libuv) long before it needs a sixth backend.

**Recommendation: leave `AUTH_DATABASE_MAX_CONNECTIONS` at 10.** The sizing rule the measurement
supports is that the pool must exceed the concurrent-query depth one Node thread can generate, and
that depth is ≤5 here. Raising it buys nothing at one replica and costs Postgres backends linearly
in replicas. The number to raise, if any single-replica throughput is wanted, is `MAX_IN_FLIGHT` in
`sip-credentials.responder.ts` — and even that only after profiling the api's CPU, which this wave
did not do.

---

## 5. What the numbers do NOT justify changing

- **The 22 api NATS connections.** Unchanged at 26 broker connections total through every scenario,
  `slow_consumers` 0 throughout. `E2E-resilience.md` already measured the reconnect storm at 1.1 s.
  No new evidence.
- **`SIPD_CREDENTIAL_CACHE_TTL = 30 s`.** See §3 — a documented security tradeoff, not a tuning knob.
- **`AUTH_DATABASE_MAX_CONNECTIONS`.** See §4 — measured at half its cap.
- **The four log lines the resilience brief named** (`ACK missed`, `WS ref went negative`, the
  `refusing a hangup` / `refusing an originate` pair). None appears on the SIP-UA path at all; they
  belong to the browser/WS path. Their rate per call is unchanged by load, so this wave adds no
  argument for touching them.

## 6. Remaining gaps

- **The engine's single-core ceiling is the headline and is not fixed here.** 98 % of one core at
  100 concurrent calls; setup-to-ring 9× worse between 10 and 100; ~1 % of routing walks unfinished
  at 200. The fix is either horizontal (more engine instances — which is what the ownership/adoption
  agent is building) or profiling the routing walk. `apps/engine` was off limits for this pass.
- **Event-loop-lag probe** on engine `/healthz` — recommended, not written, because that file is
  another agent's.
- **`KV_media-owners` reached 6 506 messages / 1.2 MB.** This wave added ~4.6 retained keys per
  call, confirming and quantifying the resilience report's "not emptied on teardown, bounded only by
  the 6 h TTL". At 200 concurrent calls sustained that is the bucket to watch against the 128 MiB cap.
- **RTCP-on-SIP-socket collisions in the test UA** (10 of 963 legs). A harness robustness fix:
  `sipua.UA.readMessage` should drop a datagram whose first byte is `0x80`/`0x81` rather than
  surfacing a parse error.

## 7. Verification

- `cd apps/sipd && gofmt -l .` — clean.
- `go vet ./...` and `go vet -tags e2e ./...` — clean.
- `go test -race ./...` — **all 20 packages ok, 0 failures** (`internal/registrar`, `internal/invite`,
  `internal/subscribe`, `internal/transfer` included, each carrying its new 503 test).
- No service was restarted. No git state touched. Nothing committed.

## 8. State left behind

- Extensions **5000–6099** in the smoke org, all `secret://load-storm/…`, all enabled. They hold no
  registrations now (the storm UAs are gone; the churn set's 60 s bindings have lapsed and been
  swept). Delete with `DELETE /api/v1/extensions/:id` if the roster is not wanted.
- `<scratchpad>/load/` holds the roster, samplers, autocannon output and every raw probe.
- `<scratchpad>/e2e/LOAD-RUNNING` deleted at the end of the wave.
- Stack running and healthy: sipd, mediad, engine, api, web, NATS, Postgres all green.
