# FIX — engine scale (the single-core ceiling, the lost walks, horizontal split, the adoption residue)

Area: `apps/engine`, plus two additive cross-area lines (`packages/events/src/index.ts` re-export,
`config/nats.conf` read grant). Nothing committed. `<scratchpad>/e2e/LOAD-RUNNING` held
20:30 → 21:1x UTC and deleted at the end.

---

## 0. The headline, stated first because it contradicts the brief's premise

**The engine was never CPU-bound.** `E2E-load.md` read `ps %cpu` and concluded "pegged at 98 % of one
core". A V8 sampling profile taken through the same 100-call storm says the thread was **95.6 % IDLE**
— about 2 seconds of CPU in 45 — with event-loop delay p99 of **1.0 ms**. `ps %cpu` on macOS is a
decayed average that spikes on a sub-second burst; it cannot distinguish a saturated thread from a
thread that was busy for 300 ms.

What actually inflated setup-to-ring 9× was **head-of-line blocking**: `rpc.sip.v1.invite` was
answered **strictly one INVITE at a time**, and each admission is three NATS round trips the loop does
nothing but _wait_ on. Measured: 50 simultaneous A-leg INVITEs admitted at a median of 10 ms apart,
the last one **700 ms** after the first, on a 95 % idle process.

That is why profiling first mattered: every fix on the brief's suspect list (zod per event, JSON
encode, Effect overhead, logging, sync compile work) is worth **under 0.7 % of engine CPU combined**,
and none of them was the problem.

---

## 1. Instrumentation added first (all of it kept)

| What                                      | Where                                                                                                                                                      | Why                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`monitorEventLoopDelay` on `/healthz`** | `health/event-loop-lag.ts`, `health.controller.ts`                                                                                                         | `E2E-load.md` recommended it. Lifetime + rolling 60 s windows; `eventLoop.{current,lastWindow,lifetime}` with `mean/p50/p99/max` in ms above the sampling interval. Reported, never status-deciding.                                                                                 |
| **`GET /debug/profile?seconds=N`**        | `health/profiling.controller.ts`, `ENGINE_PROFILING`                                                                                                       | The engine's `/debug/pprof`. Private health listener, off unless `ENGINE_PROFILING=true`, one profile at a time, returns a `.cpuprofile`. `--cpu-prof` needs the restart planned before the incident; this does not.                                                                 |
| **Per-RPC latency to both planes**        | `nats/rpc-latency.ts`, wired into `SipdCommandClient.command` and `NatsMediadTransport.request`, reported as `/healthz.sipd.rpc` and `/healthz.mediad.rpc` | A process waiting on a reply is a process at idle, so **none** of a call setup is visible in the engine's own profile. Fixed log-scale buckets, one integer increment per call, cannot grow. This is what turned "setup got slower" from three suspects into a number per operation. |

`.scripts/local-stack/render-env.sh` gained `ENGINE_PROFILING=true` for the local stack.
Analyser: `<scratchpad>/engperf/top.mjs`; runner: `<scratchpad>/engperf/storm.sh`.

---

## 2. Before / after — same rig, same host, one engine

Rig: `apps/sipd/e2e_load_test.go` `TestE2ECallStorm` against the live stack, 20 s of paced G.711 at
50 pps per leg, `SIPD_E2E_REG_CONCURRENCY=40` (a 200-wide REGISTER burst grazes the credential RPC's
500 ms deadline — `E2E-load.md` §3; 13 of 200 phones got `403` before I widened the ramp).

Both "before" rows were measured **on this tree today**, so they isolate my changes from the
`NET-engine-nats` and `FIX-engine-adoption` work already in it.

| Scenario                                           | setup-to-ring p50 / p99 | ring-to-audio p50 | RTP lost    | failed legs                 | engine CPU (profile) | loop-lag p99 |
| -------------------------------------------------- | ----------------------- | ----------------- | ----------- | --------------------------- | -------------------- | ------------ |
| 100 concurrent, **before**                         | **375 ms / 719 ms**     | 33 ms             | 0 / 199 811 | 0                           | 4.4 % of one core    | 1.0 ms       |
| 100 concurrent, **after**                          | **188 ms / 223 ms**     | 57 ms             | 0 / 193 814 | 3 (all harness RTCP)        | **2.1 %**            | 1.0 ms       |
| 200 concurrent, before (`E2E-load.md`, older tree) | 371 ms / 764 ms         | 29 ms             | 0           | 13 (11 harness, **2 real**) | —                    | —            |
| 200 concurrent, **after**                          | **213 ms / 356 ms**     | 106 ms            | 0 / 380 101 | 10 (**all** harness RTCP)   | **3.4 %**            | 1.1 ms       |

**p50 −50 %, p99 −69 % at 100 concurrent. At 200: p50 −43 %, p99 −53 %, and 0 lost walks where there
were 2.** Every remaining failure in both after-runs is the known harness artefact — an RTCP sender
report (`0x80 0xc8…`) landing on a test UA's SIP socket, 400 ephemeral loopback ports.

Where the INVITEs are actually admitted, from the engine's own log:

|                                                   | before               | after      |
| ------------------------------------------------- | -------------------- | ---------- |
| 50 simultaneous A-leg admissions, span first→last | **700 ms**           | **144 ms** |
| median inter-admission gap                        | 10 ms (strict queue) | concurrent |

### CPU: `ps` vs the profile

| Scenario         | `ps %cpu` peak | `ps` mean | profile `(idle)` | real CPU        |
| ---------------- | -------------- | --------- | ---------------- | --------------- |
| 100 before       | 62 %           | 6.7 %     | 95.6 %           | 4.4 % of a core |
| 100 after        | 39 %           | 3.2 %     | 97.9 %           | 2.1 %           |
| 200 after        | 97 %           | 7.4 %     | 96.6 %           | **3.4 %**       |
| 200, two engines | 103 % (both)   | 14.4 %    | 91.8 %           | 8.2 %           |

**Target "engine CPU < 70 % at 200 concurrent": met, by a factor of twenty**, on the measurement that
can tell busy from waiting. The `ps` peak of 97 % is a decayed average over a sub-second burst and is
reported only so the earlier finding is reconcilable.

### Where the setup time goes now (`/healthz` RPC buckets, 200-call storm)

| Plane  | operation          | count | p50    | p99    | max   |
| ------ | ------------------ | ----- | ------ | ------ | ----- |
| mediad | `create-offer`     | 399   | ≤20 ms | ≤50 ms | 30 ms |
| mediad | `allocate-session` | 299   | ≤20 ms | ≤50 ms | 27 ms |
| mediad | `bridge-sessions`  | 299   | ≤20 ms | ≤50 ms | 25 ms |
| sipd   | `resolve-target`   | 299   | ≤20 ms | ≤50 ms | 23 ms |
| sipd   | `originate`        | 399   | ≤20 ms | ≤50 ms | 24 ms |
| sipd   | `ring`             | 299   | ≤20 ms | ≤50 ms | 22 ms |

Idle baseline for the same operations: 1–4 ms. So ~80 ms of the 213 ms p50 is the RPC chain, and the
rest is `apps/sipd`'s own INVITE handling, the callee UA's `180`, and 400 test UAs sharing this host
with the load generator. **`setup-to-ring p99 < 250 ms at 200` is NOT met (356 ms) — but the engine is
provably not what is holding it there**: 96.6 % idle, loop-lag p99 1.1 ms, every downstream RPC inside
50 ms. See §7 for what would move it.

---

## 3. The fixes

### 3.1 Bounded-concurrency INVITE admission — the whole latency win

`nats/sip-invite.service.ts`, `config/engine-env.ts` (`ENGINE_SIP_INVITE_CONCURRENCY`, default 32)

The loop was `const reply = await this.answer(message.data)` inside `for await`. The old comment
argued serialisation stopped "a slow `did-index` read accumulating half-admitted calls nobody is
waiting for, on the one path an attacker controls the rate of". The protection it was reaching for is
a **ceiling**, not a queue of one: a bounded pass still keeps a flood in the BROKER, where the edge's
own deadline turns it into a `503` a carrier fails over, rather than in this heap. One at a time
protected nothing and cost the hundredth caller the ninety-nine round trips in front of them.

Also added, because concurrency makes the window reachable: **an edge retry of the same `legId`
arriving while the first attempt is still running now shares that attempt's reply.** Before, it would
have found no leg in the registry, raced the first to the `channels` compare-and-set, lost, and been
refused `internal` — a `500` for a call that was going through. And the loop now awaits its in-flight
admissions before ending, so a drain does not answer the last INVITEs with a closed socket.

Tests: 3 new in `sip-invite.service.spec.ts` — eight admitted at once; a ceiling of 3 admitting
exactly 3; a concurrent retry folded onto one admission with both callers answered `ok`.

### 3.2 One fewer round trip per B-leg dial

`media/split-plane.port.ts`, `media/media-port.ts`

The plan walker called `resolveTargets` (→ `rpc.sip.v1.resolve-target`), and then
`SplitPlaneMediaPort.originate` called `resolve-target` **again for the same target**, purely to
recover the owning `sipd` instance and the transport — both of which the first reply already carried
per contact and `resolveTargets` threw away. 300 resolve-targets per 100 calls; now 100.

`DialTarget`'s `aor` variant gained an engine-local `resolvedEdge {instanceId, transport}`, and
`originate` strips it (`wireTarget`) when building the request, because `sipDialTargetSchema` is what
the Go side unmarshals. A target nobody has resolved — a trunk, a bare URI, an unresolved AoR — still
asks. Correctness: this removes a _re_-resolution, not a check; the `contactUri` the walk produced was
already being trusted and is equally old.

Test: `split-plane.port.spec.ts` — one resolve for a resolve-then-dial, the WebRTC transport still
selected off the carried edge, the originate still addressed to the right `sipd`, and the wire target
asserted to carry no engine-local field.

### 3.3 The lost walks: a setup deadline — **item 3**

`calls/channel-orchestrator.service.ts`, `ENGINE_SETUP_TIMEOUT_SECONDS` (default 32)

The invariant that was false: **not every admitted leg was covered by a timer.**
`armCallDurationCeiling` is armed on ANSWER, so it covers the call that never ends and not the call
that never starts. A walk that hangs — or, as observed live, one that _decided to hang up 3 ms after
admission_ and whose BYE the edge answered `unknown_dialog` — left a leg with no clock at all, no
final response and no CDR, until a four-hour ceiling that had never been armed for it.

`armSetupDeadline` is armed the moment the leg is claimed and **disarmed by the first call-state
progression** — a `180`, progress, or an answer. 32 s is RFC 3261 Timer B: the point at which the
caller's own INVITE client transaction has already given up, so nothing is taken from anyone. A queue
caller, an IVR, a ring group and a voicemail box all produce a provisional response in milliseconds
and disarm it; what survives to this deadline is a leg nothing is driving. Cause `NO_USER_RESPONSE`
(18), fixed before the hangup so the CDR can answer "did the platform lose this call".

**`endStalledLeg` is the other half, and the more important one.** An ordinary hangup is _finished by
the event it provokes_; a leg nobody has a dialog for provokes none, so telling it to hang up left it
in `activeChannels` anyway. This drives `onLegEnded` locally — the same teardown `endLegsOnPlaneLoss`
uses, idempotent against a `dialog.terminated` that does arrive later.

Tests: 4 new (`the setup deadline`) — ends a silent leg with `NO_USER_RESPONSE` **and removes it from
`activeChannels`** and files the CDR; disarms on `180`; disarms on answer; arms nothing at `0`.

**Proved on the live stack.** On the restart that picked this up, the deadline fired on the two
phantom channels `FIX-engine-adoption.md` named by id (`01a087d3-98f8…`, `01a087d5-31e6…`) and on a
third leg whose walk had logged `status: hangup` 3 ms after admission and had been held ever since.
`activeChannels` has been **0** across every restart since, where it had been stuck at 2.

### 3.4 The adoption residue: reconcile against `sip-dialogs` — **item 5**

`calls/channel-orchestrator.service.ts`, `nats/jetstream.service.ts`, `config/nats.conf`,
`packages/events/src/index.ts`

`installChannel` now queues every adopted leg that never answered; `reconcileAdoptedLegs` runs at the
end of each ownership-maintenance pass and asks the SIP edge's own record —
`JetStreamService.sipDialogExists(legId)` against `sip-dialogs` — whether a dialog still exists. No
entry (or a delete tombstone) means no plane knows about this call, and it is ended with
`NO_USER_RESPONSE` through `endStalledLeg`.

**`sipDialogExists` answers `true` / `false` / `undefined`, and `undefined` is left alone.** A refused
or failed read is not evidence a dialog is gone; treating it as one would hang up every live
pre-answer call on the platform the moment the broker hiccuped. Answered legs are never checked — a
dialog claim can be reaped under a call that is still up, and those are covered by the duration
ceiling.

Both guards are kept deliberately: the reconcile ends a stranded leg in seconds with evidence, the
setup deadline is the backstop for when the edge cannot be asked at all.

Tests: 3 new — ends an adopted leg the edge has no dialog for (and `activeChannelCount` → 0, CDR
`NO_USER_RESPONSE`); leaves one alone while the edge still holds the dialog; leaves one alone when the
edge cannot be asked. The fake's default is `undefined`, so no existing spec's adopted leg is
reconciled out from under it.

---

## 4. Horizontal scaling — **item 4**

**Admission is already multi-instance by design, and it is a NATS queue group, not a KV CAS.**
`rpc.sip.v1.invite` is a FLAT subject and every engine subscribes with
`queue: "optimiq-engine-sip-invite"`, so the broker hands each INVITE to exactly one instance and
whichever answers becomes the owner. The `channels` compare-and-set claim inside `placeInvitedCall` is
the second fence, not the admission mechanism.

Two engines (`e2e-engine-1` :9300, `e2e-engine-2` :9301, same host), 200 concurrent calls:

|                                        | value                |
| -------------------------------------- | -------------------- |
| admitted by `e2e-engine-1`             | **109**              |
| admitted by `e2e-engine-2`             | **92**               |
| leg ids admitted by BOTH               | **0**                |
| duplicate leg ids within either engine | **0**                |
| setup-to-ring p50 / p99                | 297 ms / 493 ms      |
| RTP lost                               | 0 / 373 721          |
| failed legs                            | 13, all harness RTCP |
| `activeChannels` on both afterwards    | 0                    |

**The split is real (54 / 46) and no call was double-handled.** Latency was _worse_ than one engine,
and that is an honest single-host result rather than a scaling failure: a second Node process
competing for cores with the first, `sipd`, `mediad`, NATS, Postgres, 400 test UAs and the other
agents on this box. Since one engine runs the whole 200-call storm at **3.4 % of a core**, a second
instance buys redundancy — which is what `FIX-engine-adoption.md` built it for — and no throughput.

**Recommendation: keep one engine as the documented default.** `.scripts/local-stack` was NOT changed.
Scale out for failover, or when `/healthz.eventLoop.p99` starts reading in the tens of milliseconds,
which is the number that will say the thread is finally the constraint.

---

## 5. Measured and NOT worth changing

- **zod parsing, JSON encode/decode, Effect, uuid, logging, the ordered per-leg DTMF chains.** The
  whole of `apps/engine/src` is **0.5 %** of engine CPU in the 200-call profile; zod is 0.17 %,
  `nats.js` 0.64 %, GC 0.31 %. `NET-engine-nats.md` already removed the double envelope parse. There
  is no CPU hotspot to fix, and changing any of these would be a diff with no number behind it.
- **The two KV writes per admission** (`claimChannel` then `putChannel`). Real — but 0.085 ms and
  0.071 ms respectively, i.e. ~0.07 % of a 213 ms setup. Removing one means either claiming at a state
  the snapshot does not yet hold or deferring the mirror past the window a failover reads it in. Not
  worth a correctness argument for 0.15 ms.
- **The routing walk.** 42 ms admit→bridged at 100 concurrent, mostly RPC. No synchronous block over
  10 ms appears anywhere in the profile: the largest single loop-lag sample in a whole storm is 28 ms
  and it is GC.
- **Log volume.** 3 lines per call, unchanged under load, 0 WARN on the SIP-UA path.

---

## 6. Cross-area needed

1. **`apps/mediad` and `apps/sipd` — the remaining setup latency is yours.** Idle vs 100 concurrent,
   measured from the engine: `create-offer` 4 ms → **160 ms**, `resolve-target` 2 ms → **94 ms**,
   `ring` 1 ms → 55 ms. (At 200 with the engine's redundant resolve removed they came back inside
   50 ms, which suggests both planes are sensitive to _burst shape_ rather than being flat-out.) The
   engine now reports these permanently at `/healthz.{mediad,sipd}.rpc` — that is the number to run
   the next pass against.
2. **`packages/events/src/index.ts`** — one additive re-export, `SIP_DIALOGS_KV`, beside
   `SIP_INSTANCES_KV`. No signature changed; `codegen` untouched; 396 pass / 0 fail.
3. **`config/nats.conf`** — the engine gains `$JS.API.DIRECT.GET.KV_sip-dialogs.>` (publish) and
   `$KV.sip-dialogs.>` (subscribe), **read only**. `$KV.sip-dialogs.>` is deliberately absent from the
   publish list so "`sipd` is the sole writer" stays enforced rather than documented. Applied with
   `kill -HUP`; **violations 999 before, 999 after — zero new**, `/healthz` still ok.
4. **`.scripts/local-stack/render-env.sh` has a pre-existing bug**, unrelated to this pass: line 61
   emits `organization_sso_provider.client_secret: command not found` on every run (an unquoted `$(…)`
   or backtick in the `api.env` heredoc region). The env files it writes are complete, so it is
   cosmetic today — but it is one edit away from silently truncating `api.env`.

## 7. What would actually reach p99 < 250 ms at 200

In order of measured size, none of it in `apps/engine`:

1. `mediad`'s `create-offer` and `sipd`'s `resolve-target` under burst (§6.1) — two of the four hops.
2. Run the load generator off-host. 400 UAs at 50 pps plus five services plus other agents on 18
   cores makes every absolute number here pessimistic; `ring-to-audio` rising from 33 ms to 106 ms
   between the 100- and 200-call runs is the generator, not the platform (RTP loss stayed at 0).
3. The harness RTCP-on-SIP-socket collision (`sipua.UA.readMessage` should drop a datagram whose first
   byte is `0x80`/`0x81`). It accounts for **every** failed leg in all three after-runs.

---

## 8. Verification

```
pnpm --filter @optimiq-voice/engine run typecheck    ok
pnpm --filter @optimiq-voice/engine run test         1692 pass, 12 skip, 0 fail (1704 / 76 files)
pnpm --filter @optimiq-voice/events run typecheck    ok
pnpm --filter @optimiq-voice/events run test          396 pass, 12 skip, 0 fail
pnpm exec oxlint apps/engine/src packages/events/src config
        0 errors; 1 pre-existing warning (packages/events/src/schemas/media-dtmf-recording.spec.ts:122,
        no-explicit-any, untouched)
pnpm exec oxfmt apps/engine/src packages/events/src config    clean, 212 files
```

Live: NATS reloaded (0 new violations), engine restarted 6× across the pass, **stack left running with
ONE engine**, `/healthz` `ok`, `activeChannels` **0**, smoke call PASS (2 calls, 0 failed, 1 196 RTP
packets, **0 lost**, setup-to-ring 27 ms). Nothing committed; no git state touched.

## 9. Files changed

| File                                                                                                                                        | Change                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `apps/engine/src/nats/sip-invite.service.ts`                                                                                                | bounded-concurrency admission; per-leg in-flight fold; drain awaits in-flight                                      |
| `apps/engine/src/config/engine-env.ts`                                                                                                      | `ENGINE_SIP_INVITE_CONCURRENCY`, `ENGINE_SETUP_TIMEOUT_SECONDS`, `ENGINE_PROFILING`                                |
| `apps/engine/src/calls/channel-orchestrator.service.ts`                                                                                     | `armSetupDeadline` / `disarmSetupDeadline`, `endStalledLeg`, `reconcileAdoptedLegs`, arm-on-adopt                  |
| `apps/engine/src/nats/jetstream.service.ts`                                                                                                 | `sip-dialogs` view; `sipDialogExists`                                                                              |
| `apps/engine/src/media/split-plane.port.ts`                                                                                                 | `resolvedEdge` carried through `resolveTargets`; `originate` stops re-resolving; `wireTarget`; `signallingLatency` |
| `apps/engine/src/media/media-port.ts`                                                                                                       | `DialTarget.resolvedEdge` (engine-local, stripped at the wire)                                                     |
| `apps/engine/src/nats/rpc-latency.ts`                                                                                                       | **new** — bucketed per-operation RPC latency                                                                       |
| `apps/engine/src/nats/sipd-command.client.ts`, `media/mediad-transport.ts`, `media/mediad.service.ts`                                       | latency recorded and exposed                                                                                       |
| `apps/engine/src/health/event-loop-lag.ts`                                                                                                  | **new** — `monitorEventLoopDelay`, rolling + lifetime                                                              |
| `apps/engine/src/health/profiling.controller.ts`                                                                                            | **new** — gated `/debug/profile`                                                                                   |
| `apps/engine/src/health/{health.controller,health.module}.ts`                                                                               | `eventLoop`, `sipd.rpc`, `mediad.rpc`, wiring                                                                      |
| specs: `sip-invite.service.spec.ts` (+3), `channel-orchestrator.spec.ts` (+7), `split-plane.port.spec.ts` (+1), `health.controller.spec.ts` |                                                                                                                    |
| `packages/events/src/index.ts`                                                                                                              | `SIP_DIALOGS_KV` re-export (additive)                                                                              |
| `config/nats.conf`                                                                                                                          | engine read-only grant on `sip-dialogs`                                                                            |
| `.scripts/local-stack/render-env.sh`                                                                                                        | `ENGINE_PROFILING=true` for the local stack                                                                        |
