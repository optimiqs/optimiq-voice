# FIX — the hung routing-artifact KV watch (E2E-records F4, P0)

## Root cause — PROVEN, and it is a broker permission, not a nats.js bug

**The engine's NATS user has no publish grant for `$JS.FC.>`, so the broker refuses the KV watch's
flow-control replies and stops pushing to it. Silently, and permanently.**

`kv.watch()` in nats.js 2.29.3 is an ordered push consumer created with `flow_control: true` and
`idle_heartbeat: 5s` (`lib/jetstream/kv.js` `watch()` → `copts.orderedConsumer()`). The broker
periodically asks the client to reopen the delivery window by publishing to
`$JS.FC.<stream>.<consumer>.<nonce>`; nats.js answers it in `_buildTypedSubscriptionOpts`'s
`protocolFilterFn` via `msg.respond()`. If that publish never lands, the broker stops delivering.
The subscription stays open, `sub.closed` never resolves, the iterator never ends, no error reaches
any callback — so `runWatchLoop`'s "the watch ended" branch is never taken, `invalidateAll` never
runs, and the 1 h `CACHE_TTL_MS` is the only backstop. Exactly the reported symptom.

### Evidence, from the live stack (no restart)

1. **The broker's own log, still repeating every 5 s** (`e2e/logs/nats.log`):

   ```
   [ERR] ... "v2.29.3:nats.js:optimiq-engine-jetstream" - "OPTIMIQ/user:engine" -
       Publish Violation - Subject "$JS.FC.KV_routing-cache.25X99USVU465ORLW5RI5CT.0N2H"
   ```

   `grep -o 'user:.*\$JS.FC.[A-Za-z_-]*' | sort -u` gives exactly two lines, both `user:engine`:
   `KV_routing-cache` and `KV_channels`.

2. **The consumer state** (`/jsz?consumers=1&config=1`), read live:

   ```
   name 25X99USVU465ORLW5RI5CT  created 16:37:36Z
   config: flow_control true, idle_heartbeat 5s, deliver_policy last_per_subject,
           filter $KV.routing-cache.*.artifact
   delivered: {consumer_seq 258, stream_seq 258, last_active 16:45:17.627Z}
   num_pending 11   num_ack_pending 0   push_bound TRUE
   ```

   `last_active` is 16:45:17 — the exact minute of the last `applied a routing artifact update from
KV` line. Eleven messages are sitting on the server that it will not push, to a subscription that
   is still bound.

3. **`config/nats.conf`** — the engine's publish allow-list enumerates `$JS.API.*` per stream and
   per bucket and grants `$JS.ACK.>`, but nothing matches `$JS.FC.>`. `grep -n 'JS.FC' config/nats.conf`
   returns nothing.

4. **Deterministic reproduction** (`scratchpad/fcrepro/repro.mjs`, and now the gated spec): a
   throwaway broker whose user has `publish: { allow: [">"], deny: ["$JS.FC.>"] }`, 400 KV writes:

   ```
   put=50  delivered=50 num_pending=0  dseq=50
   put=100 delivered=53 num_pending=20 dseq=53
   ...
   put=400 delivered=53 num_pending=20 dseq=53   push_bound=true
   ```

### Suspects ruled out, with evidence

| Suspect                                                                                        | Verdict                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `await` inside the for-await blocking the iterator                                             | **Wrong.** `applyWatchEntry` is fully synchronous.                                                                                                                                                                                                                                                                                                        |
| ordered-consumer reset surfacing as a stall                                                    | **Wrong.** A reset renames the consumer (`nuid`), moves it to `deliver_policy: StartSequence` with an `opt_start_seq`, and rebinds a new inbox. The live consumer is still the ORIGINAL: `last_per_subject`, `opt_start_seq` absent, created 16:37:36. No reset ever happened.                                                                            |
| lost `watch.stop()` / re-create race                                                           | **Wrong.** `watchAbort` is only invoked from shutdown, and `watching` never went false.                                                                                                                                                                                                                                                                   |
| backpressure from compile-on-apply                                                             | **Wrong.** Nothing on the apply path is async.                                                                                                                                                                                                                                                                                                            |
| unhandled rejection swallowed in the loop                                                      | **Wrong** as the cause, but real as a latent hole — fixed below.                                                                                                                                                                                                                                                                                          |
| **routing E2E agent's lead: "the API's restart re-makes the bucket and orphans the consumer"** | **Wrong.** `ensureKvBuckets` (`packages/events/src/streams.ts:1087`) only calls `streams.info` then `views.kv(...)`; it never deletes or purges. And a stream delete would have destroyed this consumer — instead the same consumer, created 16:37:36, is alive with `push_bound: true` and 11 pending. Reported back to that agent's finding as refuted. |

## The fix (apps/engine only)

The grant is the real fix and it is cross-area (below). What the engine can do is stop depending on
a watch to report its own death — so it now polls it.

- **`src/routing/routing-artifact.source.ts`**
  - `runStaleGuard()`: every `ENGINE_ROUTING_WATCH_PROBE_MS` it reads
    `bucket.status().streamInfo.state.last_seq` and compares it with the highest revision the
    current watch delivered (`watchRevision`, tracked in `applyWatchEntry` and reset on every
    re-establish). Two consecutive probes seeing the bucket ahead → `watchAbort()`, which ends the
    `for await` and takes the existing reconnect-and-`invalidateAll` path. One recovery path, not two.
  - Revisions and not wall-clock silence, deliberately: the other agent's `WATCH_SILENCE_MS` rule
    (kept, and it is the read-path safety net) cannot tell a wedged iterator from a tenant nobody is
    configuring. `last_seq` can, because every key in `routing-cache` is an `<org>.artifact` the
    watch's filter covers.
  - `settledRevision` stops a revision no watch can reach (a superseded, compacted-away write)
    from re-creating the watch every probe forever: it costs exactly one recovery.
  - The WARN names the cause and the missing grant, so the next person sees `$JS.FC.>` immediately.
  - `onModuleInit` now `.catch`es both detached loops — a throw was previously an unhandled
    rejection (a crash under `--unhandled-rejections=strict`, a silently absent watch otherwise).
  - Corrected the stale claim in the `WATCH_SILENCE_MS` note that blamed the API's bucket ensure.

- **`src/nats/jetstream.service.ts`** — `watchConnectionStatus()` drains `connection.status()` to the
  log. This is why the incident was invisible: nats.js reports a refused publish as a
  `PERMISSIONS_ERROR` on that iterator _only_ — not on the publishing call (fire-and-forget), not on
  the subscription it belongs to. Nothing in the engine consumed it. Logged at ERROR with the
  subject, and counted (`permissionViolationCount`).

- **`src/config/engine-env.ts`** — `ENGINE_ROUTING_WATCH_PROBE_MS`, default 15 s, max 5 min.

- **`src/health/health.controller.ts`** — `routing.staleRecoveries` added beside the records agent's
  `lastWatchEntryAt`.

### `/healthz`: reported, NOT status-deciding — and that is deliberate

I can't argue it is safe to make it status-deciding, so I didn't:

- The engine with a stalled watch routes calls correctly, just on configuration up to
  `WATCH_SILENCE_MS` old — and with that rule in place it falls back to a per-call KV read, so it is
  _current_. Degrading the status would pull a healthy call-handling instance out of a load balancer
  and abort rolling deploys over a condition that no longer affects correctness.
- The guard recovers automatically, so a status derived from it would flap.
- `staleRecoveries` is the right signal and it is monotonic: alert on `increase() > 0`, don't route
  on it. Same terms as `park`.

## Tests

- **`src/routing/routing-watch-stall.spec.ts`** (new, gated on `NATS_SERVER_BIN`) — real
  `nats-server` started with `publish: { allow: [">"], deny: ["$JS.FC.>"] }`, i.e. the shipped grant
  as it stands. Asserts both halves: the watch stalls (`watchRevision` 52 of 400) while
  `watching` is still `true` and nothing errored, and the guard then re-establishes it and the
  newest artifact arrives. `bench/broker.ts` gained `extraConfig` / `probe` options to allow it.

  ```
  WARN ... bucketRevision 400, watchRevision 52, staleRecoveries 1
  1 pass 0 fail
  ```

- **`src/routing/routing-artifact.source.spec.ts`** — 5 new cases against the fake bucket (which
  gained `status()` and revisions): re-establishes when the bucket moves past the watch; drops every
  memory copy when it does; leaves a quiet bucket alone however long it stays quiet; needs two
  consecutive probes so a write in flight is not a stall; re-establishes exactly once for an
  unreachable revision.

- **`src/health/health.controller.spec.ts`** — 1 new case: `staleRecoveries` is reported and the
  status stays `ok`.

## Cross-area needed (NOT done — `config/nats.conf` is off limits)

**The actual fix.** In `config/nats.conf`, the `$NATS_ENGINE_USER` publish allow-list needs:

```
              # Push-consumer flow control. A `kv.watch()` is an ordered consumer with
              # `flow_control: true`; the broker reopens its delivery window only when the client
              # answers on this subject, and a refusal stops delivery SILENTLY — no error, no
              # closed subscription, no end of iterator. Omitting it cost an hour of stale routing.
              "$JS.FC.>"
```

Two other identities need the same line, for the same reason — both run `kv.watch()`:

- `$NATS_API_USER` — `apps/api/src/live/live-hub.service.ts:316` watches `channels`. Every browser
  live-call panel goes quiet the same way.
- the engine's own `KV_channels` watch is already violating (see the log grep above), so the one
  `$JS.FC.>` line covers `apps/engine/src/queue/queue-membership.source.ts:245` too (queue/ is
  another agent's area; no code change is needed there once the grant lands).

Also noted, not mine: `jsz` shows an empty stream `KV_KV_routing-cache` — someone passed an
already-prefixed bucket name to `views.kv`. Harmless, but it is litter in the E2E broker.

## Verification

```
pnpm --filter @optimiq-voice/engine run typecheck     clean
pnpm --filter @optimiq-voice/engine run test          1593 pass, 6 skip, 0 fail (1599 across 72 files)
NATS_SERVER_BIN=... bun test src/routing/routing-watch-stall.spec.ts   1 pass, 0 fail
pnpm exec oxlint <changed files>                      exit 0, no diagnostics
pnpm exec oxfmt <changed files>                        8 files
```

## Needs an engine restart to verify

The running engine is HEAD-of-16:37 and still carries the wedged consumer. Nothing here takes effect
until it is rebuilt and restarted, and **I did not restart it** — other agents are mid-test.

When the stack is free:

1. Land the `$JS.FC.>` grant in `config/nats.conf` and reload the broker
   (`nats-server --signal reload=<pid>`, or restart it).
2. `kill $(cat <scratchpad>/e2e/pids/engine.pid)` then `.scripts/local-stack/up.sh engine`
   (`up.sh` rebuilds `dist` when the service is down).
3. `curl -s 127.0.0.1:9300/healthz | jq .routing` — expect `watching: true`,
   `staleRecoveries: 0`, and a `lastWatchEntryAt` within seconds of boot.
4. Save any routing change in the UI for the smoke org and confirm `lastWatchEntryAt` advances and
   `applied a routing artifact update from KV` appears in `engine.log`.
5. Confirm the fix at the source: `grep '\$JS.FC' <scratchpad>/e2e/logs/nats.log` must produce no
   NEW lines after the reload, and
   `curl -s 'http://127.0.0.1:8322/jsz?consumers=1' | jq` on `KV_routing-cache` must show
   `num_pending: 0` steady-state.
6. To prove the guard itself on the live stack without the grant: leave `config/nats.conf` alone,
   restart only the engine, write ~50 large artifacts to the bucket, and watch for
   `the routing-cache watch is alive but behind the bucket; re-establishing it` plus
   `routing.staleRecoveries` incrementing on `/healthz`.
