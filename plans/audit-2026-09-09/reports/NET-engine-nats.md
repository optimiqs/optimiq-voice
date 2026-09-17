# NET-engine-nats — engine ↔ NATS/JetStream network pass

Area: `apps/engine` (all), `packages/events/src` + `scripts` (codegen), `packages/config` (NATS client options),
plus the coordinator's follow-on codegen task touching `packages/events-go`.
Machine: 18-core macOS, no Docker; other agents loading it concurrently, so absolute throughput is noisy —
prefer the CPU-floor microbenchmarks and profile shape.

## 1. Harness (kept in the repo)

`apps/engine/bench/` — four `bun` scripts against a REAL `nats-server` with JetStream on loopback, started by
`bench/broker.ts` from `NATS_SERVER_BIN` (Docker-free; the same variable `apps/sipd`'s integration tests read).
`broker.ts` also exports `percentiles()` and `lagSampler()` (10 ms event-loop-lag sampler).

```sh
export NATS_SERVER_BIN=/path/to/nats-server
bun apps/engine/bench/events-throughput.bench.ts        # BENCH_EVENTS, BENCH_RATES
bun apps/engine/bench/kv-roundtrip.bench.ts             # BENCH_CHANNELS
bun apps/engine/bench/sipd-rpc.bench.ts                 # BENCH_RPC_RATES, BENCH_RPC_REQUESTS
bun apps/engine/bench/call-storm.bench.ts               # BENCH_CALLS, BENCH_LEGS, BENCH_VALIDATE=full
```

1. **events-throughput** — `makeCallEvent` / `validateEvent` / `assertEventSubjectMatches` /
   `serializeEnvelopeOnly` CPU floor, then core publish at 1k–10k/s drained by a JetStream pull consumer on
   `CALLS` with explicit `ack()`, reporting end-to-end latency and loop lag.
2. **kv-roundtrip** — the real `JetStreamService`: `claimChannel`, `renewChannel`, `readChannel`,
   `channelSnapshots` (the recovery scan), `deleteChannel`, at 300 live channels.
3. **sipd-rpc** — the real `SipdCommandClient` against a fake `apps/sipd` responder speaking the bare contract
   struct, 500–2000 req/s, plus a 200-deep timeout sweep with no responder to exercise the pending map.
4. **call-storm** — 200–500 concurrent legs each walking a call's NATS work with the real classes
   (claim → ring → persist → answer → persist → 4 core event publishes → hangup → acked CDR publish → delete),
   with the ownership-maintenance scan running concurrently. `BENCH_VALIDATE=full` reproduces the pre-fix
   publisher for a same-sitting A/B. It deliberately does not construct `ChannelOrchestrator` (26 collaborators;
   it would measure the spec fakes as much as the network) — noted as a harness limitation.

Regression test: `apps/engine/src/nats/jetstream-channel-scan.spec.ts`, gated on `NATS_SERVER_BIN`.

## 2. Before profiles

`bun --cpu-prof` on call-storm, 20 000 calls at 400 concurrent legs (self time, top 15):

```
19.76% stringify (JSON)                 1.87% unsafeStringify  uuid/esm/stringify.js
 8.01% Error                            1.82% parseSubject     events/dist/subjects.js
 4.58% encode (TextEncoder)             1.61% processMsgArgs   nats/parser.js
 4.21% (anon)                           1.61% (anon)           zod/core/parse.js
 3.95% runChecks  zod/core/schemas.js   1.61% writeBuffered
 2.96% (anon)                           1.46% cancel           nats/muxsubscription.js
 2.55% (anon)                           1.40% (anon)           jetstream/jsclient.js
                                        1.35% subarray
```

zod (`runChecks` + `zod/core/parse` + `parseSubject`) = **7.4%**. `Error` 8.0% is nats.js building a timeout
`NatsError` eagerly per `request()` — inside the client, not ours.

`bun --cpu-prof` on sipd-rpc at 2000 req/s: `wait` 34.6%, `unsafeStringify` 6.0% (uuid, bench-side),
`encode` 4.7%, `Error` 4.0%, our `command()` 2.1%. The RPC client itself is not a hotspot.

## 3. Fixes

### 3.1 `channelSnapshots` read at most ONE channel — correctness, and 7× on the scan

`apps/engine/src/nats/jetstream.service.ts`

`kv.keys()` returns an ordered push consumer. Awaiting `kv.get(key)` — itself a JetStream request on the same
connection — inside its `for await` makes the ordered consumer see a gap and terminate. Isolated repro against a
real broker with 300 keys: `keys()` alone yields **300**; `keys()` with a `get` in the loop yields **1**.
Through `JetStreamService` the bench saw 20 and then 66 of 300.

That silently reduced failover recovery, and the adoption half of every ownership-maintenance tick, to a single
channel — a live-call bug, not a slow one.

Fix: drain the key listing first, then fetch values in bounded-concurrency batches of 64.

|                              | before                     | after                  |
| ---------------------------- | -------------------------- | ---------------------- |
| snapshots yielded (300 live) | 20, then 66                | **300, 300**           |
| scan wall time               | 6 ms (of the wrong answer) | 10 ms / 7 ms           |
| isolated 300-key scan        | 40.8 ms serial             | **5.5 ms** at batch 64 |

Correctness: order was never relied on (every consumer keys off the snapshot's own identity); each value is
still key-verified against `kvKeyFor.channel(...)` and a mismatch still logged and skipped; no write, claim or
lease semantics touched. Concurrency is bounded at 64 so one pass cannot flood the connection.
Test: `jetstream-channel-scan.spec.ts` asserts all 300 distinct channels come back.

### 3.2 The publish path parsed every envelope twice

`packages/events/src/validate.ts`, `packages/events/src/index.ts`, `apps/engine/src/nats/call-event-publisher.service.ts`

`makeCallEvent` parses the envelope against the schema, then `CallEventPublisher.publish` called
`validateEvent(envelope.subject, envelope)`, which selected the _same_ schema and parsed it again. The half that
is not redundant is the cross-check — wrong subject, and the tenancy one where `orgId` disagrees with the
subject's org token. New additive export `assertEventSubjectMatches(subject, envelope)` does exactly that check
and nothing else; the publisher calls it.

| per event                                         | before       | after              |
| ------------------------------------------------- | ------------ | ------------------ |
| `validateEvent`                                   | 0.60–0.72 µs | —                  |
| `assertEventSubjectMatches`                       | —            | **0.16–0.18 µs**   |
| publish-path CPU floor (make + check + serialize) | 1.46 µs      | **1.02 µs** (−30%) |

Call-storm A/B, 20 000 calls at 400 legs, 3 runs each (machine loaded, drifting):
`BENCH_VALIDATE=full` 7116 / 6293 / 5515 calls/s, p99 86 / 112 / 151 ms;
cross-check 7651 / 8457 / 9268 calls/s, p99 113 / 90 / 65 ms. Directionally clear, magnitude noise-dominated —
the honest figure is the microbenchmark above (4 events/call × 0.44 µs ≈ 1.8 µs/call).

Correctness: both cross-check failure modes keep their exact messages, keep hiding the payload from the public
`issues` array, and are covered by a new case in `validate.spec.ts`. Anything arriving over the wire is
unaffected — consumers still call `safeValidateEvent`, which parses first. The new function's doc says so.

### 3.3 Per-write codec allocation on the KV path

`jetstream.service.ts` constructed a `TextEncoder`/`TextDecoder` per channel write, per recovery read and per
CDR/voicemail publish — i.e. on every lease renewal of every live leg. Now module-level singletons (stateless,
re-entrant). Measured saving is small (0.036 → 0.024 µs/encode, 0.059 → 0.038 µs/decode) and it sits on the
highest-frequency path in the file; see §4 for why the same change was NOT made in six other files.

### 3.4 Generated-Go comments and `slices.Contains` (coordinator follow-on)

`packages/events/scripts/go-emitter.ts`, `packages/events/scripts/generate-go.ts`, `packages/events-go/presence.go`

- Header folded from 4 lines to 2, keeping the canonical `// Code generated … DO NOT EDIT.` first line verbatim
  and one provenance/regeneration line (×15 files).
- Package-doc essays trimmed in the hangup-cause, telephony, live-state and rpc emitters: kept the invariant,
  dropped the argument for it and the plan-document references.
- Emitted `Valid()` is now `func (v T) Valid() bool { return slices.Contains(TValues, v) }` (7 lines → 1, plus an
  emitted `import "slices"`); the mirrored hand-rolled loop at `presence.go:54` fixed the same way.

Comment lines in `packages/events-go/*_gen.go`: **870 → 817**. Per file, `rpc_gen.go` 301 → 296,
`call_events_gen.go` 129 → 127, `telephony_gen.go` 64 → 61, `hangup_causes_gen.go` 44 → 38, `live_state_gen.go`
59 → 56. The remainder is one-line godoc on ~90 exported identifiers, which the policy says to keep — the
volume there is inherent, not noise.

Verification: `pnpm --filter @optimiq-voice/events run codegen` run twice, second run byte-identical
(hash over `packages/events-go` + `packages/events/schema` unchanged). `gofmt -l .` clean, `go vet ./...` clean,
`go test -race ./...` ok (1.327 s). No exported Go signature changed, so `apps/sipd` / `apps/mediad` are
unaffected.

## 4. Measured, and NOT worth changing

- **`headers()` per sipd request.** Removing the empty header set is 80 696 → 82 305 req/s (2%, within noise) and
  would change the wire framing (HPUB → PUB) for a Go responder in another agent's area. Left alone.
- **`TextEncoder`/`TextDecoder` per call in six other engine files** (`claim-store`, `agent-state.store`,
  `queue-waiting.store`, `did-index.source`, `routing-artifact.source`, `queue-membership.source`). 0.02 µs/op;
  not worth the churn.
- **Serial JetStream publishes.** `publishCdrLeg` and `publishVoicemail` await the ack deliberately: both streams
  are `discard: new`, so an overflowing broker _refuses_ rather than drops, and a fire-and-forget publish cannot
  see the refusal. A dropped CDR is unbilled revenue and a dropped `voicemail.message.left` is audio nothing
  points at. Ack semantics matter here — kept, unchanged.
- **`AgentStateStore` roster reads.** Already a `Promise.all` fan-out behind a TTL cache that is populated before
  the first await, so concurrent callers share one fan-out. Nothing to fix.
- **`SipdCommandClient` pending map under timeouts.** 200 concurrent requests to a dead instance all refuse in
  5–13 ms (`no responders` 503, not the 500 ms deadline) with 0 active handles left. No leak, no timer churn.
- **Ownership maintenance renewals.** Already batched at bounded concurrency with an unexpired-lease skip; the
  adoption half was the broken part (§3.1).
- **`noEcho` / `pingInterval` / `maxPingOut` in `packages/config`.** The engine publishes call events and
  subscribes to media/sip events on disjoint subjects, so nothing is being echoed today — `noEcho` would be a
  change with no number behind it. `inboxPrefix` is already set per service. The nats.js ping defaults
  (120 s × 2) mean a dead broker can go unnoticed for ~4 minutes, which is an availability question rather than a
  network-overhead one — flagged, not changed.
- **Event subscriptions (`sipd.service`, `mediad.service`).** Reused decoder, plain async iteration, per-message
  try/catch, no per-message allocation beyond the parse. No queue group is correct: an event must reach the
  replica that owns the leg, and a queue group would deliver it to one arbitrary replica.

## 5. Steady-state numbers (after)

```
events   cpu-floor: makeCallEvent 0.77us  validateEvent 0.72us  crossCheck 0.18us  serialize 0.17us  wire 340B
         1000/s  -> 935/s   p50 0ms p99 7ms  loop-lag 0.69ms
         5000/s  -> 4810/s  p50 1ms p99 1ms  loop-lag 0.39ms
         10000/s -> 9616/s  p50 1ms p99 2ms  loop-lag 0.39ms   rss 165MB
kv       claim 0.085ms  renew 0.071ms  read 0.078ms  delete 0.071ms (mean, 300 channels)
         channelSnapshots 300/300 in 10ms then 7ms
rpc      500/s -> 4006/s p99 0.36ms | 1000/s -> 7801/s p99 0.35ms | 2000/s -> 14813/s p99 0.43ms
         timeout sweep 200/200 refused in 5ms, 0 handles
storm    20000 calls @400 legs in 2.00s (10020 calls/s)
         8.0 NATS round trips/call, 1505B events, 698B rpc on the wire
         p50 44.6ms p99 56.2ms  loop-lag mean 5.90ms max 25.3ms
         heap 59MB rss 415MB handles 0; after teardown heap 29MB handles 0
```

Per-call round trips are 8 and every one is load-bearing (claim, ring, 2 snapshot writes, answer, hangup, acked
CDR, delete). The four call events are core publishes and cost no round trip.

## 6. Cross-area needed

- **`packages/events` new export for `apps/api`.** `assertEventSubjectMatches(subject, envelope)` is additive;
  nothing existing changed signature. Any producer in `apps/api` that builds with a `make*Event` helper and then
  calls `validateEvent` on its own envelope can switch to it for the same ~0.5 µs/event. Consumers must NOT —
  they still need `safeValidateEvent`.
- **`apps/sipd` / `apps/mediad`.** No action; `Valid()` bodies changed but not signatures, and the generated
  headers/godoc are comment-only.
- **nats.js.** The eager per-request timeout `Error` (8% of storm CPU) and `uuid`'s `unsafeStringify` are library
  costs; nothing to do in this repo short of a client change.

## 7. Verification

```
pnpm --filter @optimiq-voice/events   run typecheck   ok
pnpm --filter @optimiq-voice/events   run test        400 tests, 388 pass, 12 skip, 0 fail
pnpm --filter @optimiq-voice/config   run typecheck   ok
pnpm --filter @optimiq-voice/config   run test        36 tests, 0 fail
pnpm --filter @optimiq-voice/engine   run typecheck   ok
pnpm --filter @optimiq-voice/engine   run test        1576 tests across 71 files, 0 fail
pnpm exec turbo run build typecheck --filter=...events --filter=...config   21/21 successful
pnpm --filter @optimiq-voice/events run codegen  (×2)  byte-identical
cd packages/events-go && gofmt -l .  (clean) && go vet ./...  (clean) && go test -race ./...  ok
oxlint apps/engine packages/events/src packages/events/scripts packages/config/src   0 errors
oxfmt  (same dirs)   clean
```

No git state touched; nothing committed.
