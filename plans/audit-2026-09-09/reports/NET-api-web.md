# NET-api-web — networking performance pass

Area: `apps/api` (all), `apps/web/lib` (live client, softphone adapter, API client), `apps/web/next.config.mjs`.
Branch `feat/optimiq-pbx-phase0`. Machine loaded by other agents throughout — absolute latency is noisy,
so the numbers to trust are per-event CPU, round-trip counts and ns/op, not wall clock.

## Harness (kept in the repo)

Two new runnable harnesses, plus one new test file.

### 1. `apps/api/scripts/bench-live-fanout.ts` — the live WS fan-out

Real `node:http` server, real `ws` handshake, real client sockets on loopback, the real `LiveGateway`.
Faked: the auth platform (a fan-out benchmark that measured `auth.api.getSession` would be measuring
Postgres) and `LiveHub`'s NATS upstreams — driven through the same `addListener` seam the real hub emits
on, so everything from `fanOut` down is the production code path byte for byte.

```
LOG_LEVEL=silent CLIENTS=500 EVENTS=5000 TOPICS=3 \
  pnpm --filter @optimiq-voice/api exec tsx scripts/bench-live-fanout.ts
```

Env: `CLIENTS` (500), `EVENTS` (5000), `TOPICS` (3), `PAYLOAD` (400 B).
Prints per-event CPU, frames and bytes delivered, RSS delta, gateway stats.

### 2. `apps/api/scripts/bench-live-snapshot.ts` — the subscribe-time KV read

Real NATS, because a benchmark of a round-trip count that makes no round trips measures nothing. It
seeds N registration rows and times `LiveHub.snapshot`, and **throws if the row count is short** — which
is how the correctness bug below was found and is what makes it a regression test as well as a benchmark.

```
scratchpad/bin/nats-server -js -sd /tmp/js -p 4333 &
LOG_LEVEL=silent NATS_URL=nats://127.0.0.1:4333 KEYS=300 ROUNDS=15 \
  pnpm --filter @optimiq-voice/api exec tsx scripts/bench-live-snapshot.ts
```

### 3. `apps/api/test/live/liveGateway.test.ts` — new, runs in `pnpm --filter @optimiq-voice/api run test`

Asserts the two fan-out properties nothing else could see: byte-identical frames to every subscriber of
a topic, and that a client which stops reading is closed rather than buffered without limit.

## Before profile (top frames)

`tsx --cpu-prof`, CLIENTS=300 EVENTS=3000, 5060 samples:

```
31.7%  (idle)
15.5%  end                thread-stream/index.js:430      (pino transport worker — harness noise)
13.0%  send               live/live-gateway.ts            ← JSON.stringify + socket.send
 8.2%  (program)
 5.8%  writev             (syscall)
 3.6%  (garbage collector)
 2.2%  writev
 2.0%  writevGeneric      node:internal/stream_base_commons
 1.1%  lineLengths        source_map_cache                (tsx noise)
 0.8%  compileSourceTextModule                            (tsx noise)
 0.6%  fanOut             live/live-gateway.ts
 0.5%  FastBuffer
 0.4%  readFileUtf8 / FastBuffer / waitForWorker
 0.3%  send               ws/lib/sender.js
 0.3%  writeOrBuffer      streams/writable
 0.3%  makeSyncRequest    esm/hooks
```

`send` is the whole story: with the module-load and pino-worker noise removed it is the largest
non-syscall frame, and it is dominated by a `JSON.stringify` run once per subscriber of the same object.

## Fixes

### 1. Encode once per topic, fan out the same string — `live-gateway.ts`

`fanOut` built and serialized a fresh `event` frame for every connection. The frame is a function of the
message and the topic name and nothing else, so with 500 tabs on one organization that was 500 encodes of
identical bytes per upstream event. Now encoded once per topic name into a cache scoped to a single
message (nothing stale can be served), and `send` is split into `send` (serialize) / `write` (emit an
already-serialized payload).

| CLIENTS=500 EVENTS=5000 | before   | after (2 runs) |
| ----------------------- | -------- | -------------- |
| wall ms                 | 3976     | 1086 / 1897    |
| **cpu µs/event**        | **1121** | **308 / 443**  |
| RSS delta MiB           | 2809     | 956 / 2017     |

2.5–3.6× less CPU per event. Correctness: the encoded frame is identical to what `send` produced —
proved by the new test asserting three subscribers receive byte-identical strings — and the cache lives
for one `fanOut` call, so a later message cannot reuse an earlier one's bytes. Tenant isolation is
untouched: the `organizationId` equality check still runs per connection, before any encode, and the
cache key is the topic name, which is per-connection state the org check has already gated.

### 2. Drop-or-close policy for slow WS clients — `live-gateway.ts`, `live-protocol.ts`

There was none. `ws`'s `send` never blocks — it appends to an in-process queue — so a suspended laptop
or a throttled tab cost the server unbounded memory while passing every other check, including the
heartbeat (pings queue behind the backlog, so a dead reader is only noticed after
`LIVE_HEARTBEAT_TIMEOUT_MS` = 55 s, by which time a busy tenant has queued tens of megabytes). The
harness showed it directly: 2.8 GiB RSS growth over 5000 events with 500 clients that could not drain.

Added `LIVE_MAX_BUFFERED_BYTES` (4 MiB ≈ 40 s of a busy tenant's stream) checked on **every** write, and
`LIVE_CLOSE_TOO_SLOW` (4003).

The reaction is a CLOSE, not a frame drop, and that is the load-bearing decision: a client maintains its
tables incrementally from `event` frames, so a silently dropped frame is a row that stays wrong until
something else touches it — whereas a close makes the client reconnect, re-`subscribe`, and take the
snapshot as truth, which the protocol already defines as a complete resynchronization. Bounded memory
bought with a reconnect instead of with a lie. Covered by the new test.

### 3. `LiveHub.snapshot` returned INCOMPLETE data — `live-hub.service.ts`

The most serious finding, and it is a correctness bug with a networking cause. The read was

```ts
for await (const key of await bucket.keys(filter)) {
  const entry = await bucket.get(key);   // request-reply INSIDE the ordered-consumer iteration
```

`bucket.keys()` is an ordered JetStream consumer. Suspending its iteration for a round trip on the same
connection makes it see a gap and reset, and the iterator ends early — silently. Against a 300-key
bucket the harness measured **46 rows, then 214 rows, on two consecutive runs**, with no error logged
anywhere. A wallboard opened on a partial registration table and had no way to know.

Fixed by draining the key list fully before reading any value, then reading values in bounded batches of
64 (`SNAPSHOT_READ_BATCH`) instead of one at a time.

| 300 keys, real nats-server on loopback | sequential (batch=1)       | batched (64)    |
| -------------------------------------- | -------------------------- | --------------- |
| rows returned                          | 300 (correct once drained) | 300             |
| p50 ms                                 | 122.1                      | 26.4 (8.1 warm) |
| p99 ms                                 | 153.5                      | 38.8 (9.6 warm) |
| broker round trips                     | 300                        | 5               |

4.6× on loopback; over a link with 1 ms RTT the sequential shape costs ≥300 ms of pure latency before a
wallboard's first paint, and this makes it ~5 ms. The batch is bounded rather than one `Promise.all` over
the whole bucket so a large tenant does not put thousands of simultaneous requests on the shared
connection — that would trade a slow snapshot for a stalled one. Tenant isolation is unchanged: the key
filter is still `<org>.>` and every value still goes through `parseKvValue`, which re-checks the org
inside the value.

### 4. Memoize `resolveRolePermissions` — `auth/role-permissions.ts`

Runs on **every authenticated HTTP request** (`RequirePermissionsGuard` → `resolveAccess`) and on every
live-socket revalidation. Expanding `owner` allocated a `Set` plus a 121-element array each time.

|       | before | after |
| ----- | ------ | ----- |
| ns/op | 1805   | 3     |

At 2000 req/s that is 3.6 ms/s of CPU and ~250 000 short-lived array slots per second saved. Safe to
cache without invalidation because it is a pure function of `SYSTEM_ROLE_TEMPLATES`, a module constant;
the key space is the `member.role` column and cannot be grown by a caller; the returned array is now
frozen because it is shared.

## Measured and NOT worth changing

- **`new TextDecoder()` per message** (~20 call sites across the PBX consumers and publishers).
  Measured: 93.6 ns/op per-call vs 51.9 ns/op shared (`Buffer.toString` is worse at 104.6). 42 ns saved
  per message ⇒ 0.004 % CPU at 1000 msg/s. Not worth touching twenty files.
- **`await import(...)` inside per-message handlers** (cdr-writer, voicemail, trunk, emergency
  consumers). A cached dynamic import measures 932 ns/op against 2 ns for a static reference — real, but
  0.09 % CPU at 1000 events/s, and each of those imports carries a comment saying it exists to work
  around `apps/api`'s relaxed `strictNullChecks`. Hoisting risks the typecheck for a tenth of a percent.
- **The web live client's per-message watchdog re-arm** (`apps/web/lib/live/client.ts`). Every frame does
  `clearTimeout` + `setTimeout`: 174 ns/op against 26 ns for a `Date.now()` stamp with one sliding-deadline
  check. Real (and one fewer `Timeout` object per message on the browser main thread), but 0.017 % CPU at
  1000 msg/s, and converting it requires injecting a clock into a well-tested watchdog. Left alone
  deliberately; the number is recorded so a future jank report has a starting point.
- **Session gateway fan-out.** Inspected, not optimized: unlike the live gateway its delivery is 1:1 —
  one connection per claimed application, one tap per live call — so there is no shared frame to encode
  once. It has the same missing-backpressure shape as the live gateway did, but a per-call event stream
  cannot realistically outrun a reader the way a tenant-wide KV feed can.
- **NATS pull consumers.** `consumer.consume()` with nats.js defaults (100 in flight, 30 s expiry) is a
  sensible batch. The webhook dispatcher already back-pressures correctly (`awaitSlot` before `spawn`,
  `max_ack_pending` = concurrency, `ack_wait` derived from the delivery budget rather than guessed). The
  voicemail / trunk / emergency consumers process serially, which is a throughput ceiling of one message
  at a time — but these are human-rate families (a voicemail left, a trunk flapping) and serial keeps
  per-mailbox ordering. No measured pressure, so no change.
- **`live-hub` KV watch teardown.** Ref counting is exact and `openSources` is asserted empty by
  `verify:live`; no leak found.

## Findings NOT fixed (needs a decision or is cross-area)

1. **The auth database pool is hardcoded to 10 and is the API's real concurrency ceiling.**
   `auth.config.ts` sets `maxConnections: 10`; `packages/db`'s `allocatePostgresConnectionBudget` halves
   it, so the postgres.js pool is **5 connections**. Every authenticated request goes through it twice
   (`auth.api.getSession`, then `findMembership`), as does every live-socket revalidation. Its two
   siblings are env-tunable (`PBX_DATABASE_MAX_CONNECTIONS`, `CDR_DATABASE_MAX_CONNECTIONS`, both
   defaulting to 10); this one is not tunable at all. I did not change the constant because I could not
   measure it (standing up better-auth + Postgres under load was out of budget with other agents on the
   box), and raising it blind is a guess.
2. **Fastify adapter options are all defaults** (`main.ts`): no `connectionTimeout` (0 = a slowloris can
   hold a socket forever), no `trustProxy` (so `request.ip` and rate limiting see the proxy, not the
   client), no compression or ETag on JSON list responses, and no response schemas — so Nest's
   `reply.send(object)` uses `JSON.stringify` rather than `fast-json-stringify`. All four are real, all
   four are behaviour changes I have no number for.
3. **JsSIP has no WS keepalive** (`apps/web/lib/softphone/jssip-adapter.ts`). JsSIP does not offer CRLF
   keepalive, so a proxy with a 60 s idle timeout will half-close the SIP socket and the UA recovers by
   re-REGISTERing. `connection_recovery_min/max_interval` are left at JsSIP's 2 s/30 s defaults, which
   at least bounds a reconnect storm. Noted rather than changed: any fix is a behaviour change I cannot
   measure without a proxy in the path.

## Cross-area needed

- `packages/config/src/env.ts`: add `AUTH_DATABASE_MAX_CONNECTIONS` (int, min 2, max 100, default 10) so
  `apps/api/src/auth/auth.config.ts` can stop hardcoding the auth pool size — finding 1 above. One line
  there, one line here.
- No NATS client-option change needed in `packages/config/nats-credentials` from this area.

## Verification

- `pnpm --filter @optimiq-voice/api run typecheck` — clean (both `tsconfig.json` and `tsconfig.strict.json`).
- `pnpm --filter @optimiq-voice/api run test` — **1215 passing, 0 failing** (was 1213 before; +2 new).
- `pnpm --filter @optimiq-voice/web run typecheck` — clean.
- `pnpm --filter @optimiq-voice/web run test` — **764 pass, 0 fail**, 2586 assertions.
- `oxlint` on `apps/api/src/live`, `apps/api/src/auth/role-permissions.ts`, `apps/api/scripts`,
  `apps/api/test/live` — exit 0.
- `oxfmt` on the same paths — 12 files formatted, applied.
- No commits, no git state touched.
