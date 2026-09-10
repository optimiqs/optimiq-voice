# FIX — second-engine ownership adoption (the P0 `FIX-plane-loss.md` recommended)

Area: `apps/engine`, `packages/events` (+ generated Go), `config/nats.conf`. Nothing committed.

---

## The finding, restated — and the part of it that was wrong

`FIX-plane-loss.md` reported: a second engine SIGKILLed mid-call, the call survived, and
`e2e-engine-1` "adopted nothing" — `activeChannels: 0` for the forty seconds observed, no CDR, and
`dialog.terminated` reaching a replica with no aggregate. It concluded that "hydration runs at boot
only; there is no watch on the bucket and no claim contest for an orphaned entry."

**Half of that is wrong, and the half that is wrong is the more interesting half.** A claim contest
already exists and already runs on a timer: `runChannelOwnershipMaintenance` iterates
`channelSnapshots()` every `ENGINE_CLAIM_HEARTBEAT_MS` and calls `hydrateChannel` on anything nobody
live owns. It did not fire because of a **horizon**, not a missing mechanism:

```
CHANNEL_OWNERSHIP_LEASE_MS = CLAIM_LEASE_MS = 90_000
```

The dead instance's channel lease had ~50 s left when the observation stopped at 40 s. A survivor
with no other evidence **must** respect an unexpired lease — an engine that adopted on a shorter
clock would take a busy peer's calls out from under it — so the refusal was correct. The lease is
ninety seconds because it is renewed by a heartbeat that rewrites EVERY live channel on the replica,
and that is also correct. The missing thing is _evidence that the owner is dead rather than slow_.

**And there was a second defect underneath it, which the report did not reach because adoption never
happened.** Even after a survivor adopts, `hydrateChannel` never rebuilt `SplitPlaneMediaPort`'s
per-leg record — and `SplitPlaneMediaPort.hangup` _tolerates_ a missing leg (`this.legs.get(...)?`,
not `require`). So an adopted call's BYE was **never sent to the edge**: the aggregate would be torn
down and the CDR filed while both phones were still up and still hearing each other. That bug also
applied to the boot-hydration path the report cites as "the documented recovery works" — it adopted
the aggregate but not the ability to end the call. Both are fixed and both are regression-tested.

---

## What was built

### 1. `engine-instances` — the symmetric lease (`packages/events`)

`engineInstanceLeaseSchema` + `isEngineInstanceLeaseExpired` (`live-state.ts`), `ENGINE_INSTANCES_KV`

- `kvKeyFor.engineInstance` (`streams.ts`), exports, codegen registration, and the hand-written Go
  mirror (`EngineInstancesKV`, `EngineInstanceKVKey`). 15 s TTL, history 1, file-backed, non-org-scoped
  — every value deliberately identical to `SIP_INSTANCES_KV`, and a test asserts the two horizons stay
  equal, because an operator should not have to hold two "a process is dead" clocks in mind.

Not merged into `sip-instances`, deliberately: the two record the same fact about two planes and
drive **opposite verdicts** — a dead `sipd` means its legs must be ENDED (a dialog cannot be
re-homed); a dead engine means its channels must be ADOPTED (nothing about a channel is bound to the
process that held it). Sharing a bucket would put those two verdicts one malformed value apart, and
would let an engine's write reach a reader that ends calls.

`pnpm codegen` re-run and **idempotent** — byte-identical tree on a second run.

### 2. `EngineLivenessService` (`apps/engine/src/nats/engine-liveness.service.ts`)

Writes this process's lease, renews every 5 s (TTL/3, so two writes may be lost before a peer may
call it dead), releases the key on graceful shutdown, and watches every peer's.

- **The first claim is fatal, later ones are not.** An instance that cannot assert its own liveness
  looks dead to every peer, so its live channels get contested out from under it — a split brain from
  a missing grant or bucket, which is a deployment fault and belongs at boot. A failed _renewal_ is a
  broker hiccup with two attempts left inside the horizon; killing a process holding live calls over
  one refused write would cause the outage it is avoiding. Both are on `/healthz`.
- **It never reports its own instance id**, however the key changes — including the DELETE it
  publishes on its own shutdown. Acting on that would run the peer-death path against ourselves and
  contest every channel this instance is actively serving. Tested.
- Contests are **chained, not parallel**: two dead peers at once would otherwise put two full
  cluster-wide listings on the connection at the same moment, and the second contest does strictly
  less work for having waited.

### 3. `InstanceLivenessWatcher` — the shared machinery, and `SipdLivenessService` refactored onto it

Rather than copy 200 lines, the watch + 2 s expiry sweep + report-once rule moved to
`nats/instance-liveness.watcher.ts`, and **both** services are now thin wrappers. The refactor is
proved by `sipd-liveness.service.spec.ts`'s existing 7 cases, unchanged and passing.

**Two real bugs found while doing it**, both in the live-proven sipd path:

- **Shutdown could hang for up to 30 s.** The backoff was a plain `setTimeout` the stop could not
  cut short, so a stop during a backoff (or a stop before the first `watch()` resolved) blocked
  `onApplicationShutdown`. Now the sleep is wakeable and the loop re-checks `stopped` immediately
  after `watch()` resolves. Found because two new tests timed out at exactly 5000 ms.

### 4. The lease-fenced CAS (`JetStreamService.adoptChannelFromInstance`)

The one operation that ignores the channel expiry, and the three fences that replace it:

1. the caller must **name** the dead instance, and a snapshot owned by anyone else — including the
   survivor that beat us to it — is refused `"owned"`, re-read fresh rather than trusted from the
   listing that produced it. A peer's death is never a licence to take a third party's calls.
2. the write is a **revision-fenced `update`** at the revision this pass read, so exactly one
   survivor wins when several contest;
3. a key that vanished reads `"vanished"`, not as a claim.

### 5. Adoption in the orchestrator, and the split-plane restoration

- `adoptChannelsOfInstance(deadInstanceId)` — contests every snapshot naming the dead peer, refuses
  when draining (anything adopted would go straight to the drain's straggler teardown, ending a live
  call the next survivor could have kept) and refuses its **own** id (a renewal this process failed
  to write is not a death; every channel named there is one it is serving). One INFO line per
  adoption naming the call — the line an operator greps for after a crash.
- `hydrateChannel` split into `installChannel(snapshot, claimWith)`, shared by boot hydration, the
  expiry-fenced watch path and the lease-fenced contest — one install path, three claim policies.
- **`SplitPlaneMediaPort.registerAdoptedLeg`**, called on every install. Restores the owning `sipd`
  instance (from `OPTIMIQ_SIPD_INSTANCE_ID`, which travels in the snapshot) and the leg's variable
  store (the SOURCE of truth on this plane — §3.4 — so an adopted leg with an empty store loses its
  recording flag and its CDR cause). The **SDP offer is deliberately not restored**: an adopted leg
  is already answered, `answer` is the only operation that wants it, and failing loudly beats
  answering a second call with a body from the first.

### 6. `ChannelWatchService` — the live signal (`nats/channel-watch.service.ts`)

Watches `channels` so a stranded call is noticed when it is written rather than at the next boot or
the next heartbeat's cluster-wide listing. Contests any snapshot whose owner's **channel** lease has
lapsed; ignores its own writes (every renewal of every channel it holds echoes back), live replicas'
snapshots, and deletes (a delete is a leg that ended). The periodic pass is deliberately KEPT — it
renews this instance's own leases and is the backstop for anything the watch missed.

**The stale guard is `FIX-engine-watch.md`'s pattern, for its reason.** A `kv.watch()` whose
flow-control reply the broker refuses stops delivering _silently_ — no error, no closed subscription,
no end of iterator. The guard compares the bucket's `last_seq` with the highest revision the watch
delivered; two consecutive probes behind re-establish it, and `settledRevision` stops an unreachable
revision costing more than one recovery. Wall-clock silence could not tell a wedged iterator from a
quiet cluster.

### 7. `/healthz.engine` — reported, NOT status-deciding

`instanceId`, `leaseHeld`, `leaseRenewFailures`, `watchingPeers`, `livePeers`, `peersLost`,
`channelsAdopted`, `channelWatch{watching,adopted,staleRecoveries,lastEntryAt}`.

Same terms as `routing.staleRecoveries`, and for the same argument: an instance whose own lease is
missing is still handling its calls **correctly** — the condition hurts only its peers — so degrading
the status would pull a healthy call-handling instance out of a load balancer and would flap as the
next renewal succeeds. Alert on `leaseHeld == false` and `increase(channelsAdopted) > 0`; do not
route on either. Tested.

### 8. `config/nats.conf` — the grants

The `engine-instances` block mirrors `sip-instances`, with **one deliberate difference**: the engine
is BOTH writer and reader here, so `$KV.engine-instances.>` IS granted. The identities that can write
it are exactly the identities whose liveness it records; `sipd`, `mediad` and the API get no grant on
it at all. No other user's grants were touched.

Reloaded with `kill -HUP $(cat <scratchpad>/e2e/pids/nats.pid)` on the running broker (the live
`e2e/nats/nats-base.conf` is a symlink to the repo file):

```
[INF] Trapped "hangup" signal
[INF] Reloaded: authorization users
[INF] Reloaded: accounts
[INF] Reloaded server configuration (sha256:ffbccab4…)
```

**Violations before the reload: 995. After: 995 — zero new**, and `/healthz` still `{"status":"ok"}`.

`$JS.FC.>` is now present for all four identities (landed by the routing agent), and the engine
already had the full `KV_channels` consumer set, so the new `channels` watch needed no further grant.

---

## Tests

| Spec                                             | Cases             | What would break it                                                                                                                                                                                               |
| ------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/events/src/schemas/live-state.spec.ts` | +4                | the lease horizon drifting from `sip-instances`'                                                                                                                                                                  |
| `packages/events/src/streams.spec.ts`            | +2                | the bucket missing from apply order or the key builder                                                                                                                                                            |
| `nats/engine-liveness.service.spec.ts`           | **8, new**        | first-claim-fatal; renewal-failure-tolerated; report-once; self-id ignored; sweep backstop; mismatched value ignored; lease released on shutdown                                                                  |
| `nats/channel-watch.service.spec.ts`             | **7, new**        | contest on a lapsed lease; own/live/delete ignored; two-probe stale guard; one recovery per unreachable revision; a quiet bucket left alone                                                                       |
| `calls/channel-orchestrator.spec.ts`             | +5                | **adopting past a still-valid channel lease** (reverting to `adoptChannel` fails it with `adopted 0` — the live behaviour exactly); exactly-one-survivor; third party untouched; own id refused; draining refused |
| `media/split-plane.port.spec.ts`                 | +3                | **the BYE for an adopted leg** (dropping `registerAdoptedLeg` empties `sipd.hangupCalls`); variables restored; `answer` still refuses                                                                             |
| `health/health.controller.spec.ts`               | +1                | a lost lease moving the status                                                                                                                                                                                    |
| `nats/engine-adoption.spec.ts`                   | **4, new, gated** | see below                                                                                                                                                                                                         |

### The gated spec, against a real `nats-server`

A fake bucket cannot prove this fix, because the fix rests on two things a fake does not have: a real
KV TTL expiring the dead instance's key, and a real revision-fenced `update` arbitrating two
contenders. Both are exercised.

```
NATS_SERVER_BIN=<scratchpad>/bin/nats-server bun test src/nats/engine-adoption.spec.ts
  4 pass, 0 fail   [16.39s]

WARN an engine replica stopped renewing its liveness lease
     {"instanceId":"engine-dead","why":"the lease expired"}
```

Two real `JetStreamService`s on one broker; the dead one claims a channel and its ownership lease is
asserted to still have **>60 s to run**; its renew timer is then cleared (SIGKILL, as the bucket sees
it: stops renewing, never releases). The survivor adopts inside the instance lease, and the `channels`
key flips to `engine-live`.

**A real finding from writing it:** the bucket's `max_age` is applied only when
`ENGINE_ENSURE_STREAMS` is set — `views.kv(name)` alone creates it with `max_age: 0`, and then the
server-side expiry half of the lease silently does not exist and only the client sweep is left. The
spec now asserts `max_age` explicitly. Verified on the LIVE broker that it is applied correctly
there: `KV_sip-instances max_age = 15000000000`.

---

## Proved LIVE

Two engines from the same env (`e2e-engine-2` on health port 9301, `node --import
@swc-node/register/esm-register src/main.ts` — the engine runs from SOURCE on this stack, not from
`dist`; `up.sh engine` does not rebuild a `dist` it never uses).

Boot, engine-1: `buckets:[… "sip-instances:present","engine-instances:created" …]` →
`claimed this engine's liveness lease {instanceId:"e2e-engine-1",ttlMs:15000}` →
`watching the engine-instances KV bucket for instance liveness` →
`watching the channels KV bucket for stranded calls`. Each engine then listed the other in
`/healthz.engine.livePeers`.

### The scenario, with timings

`TestE2EHoldACallOpen` (90 s), both legs owned by `e2e-engine-1` (`activeChannels` 2 vs 0).

```
20:19:41.577  SIGKILL e2e-engine-1
20:19:53.883  WARN  an engine replica stopped renewing its liveness lease
                    instanceId:"e2e-engine-1" why:"the lease expired"
20:19:53.938  INFO  adopted a channel from an engine replica that died  channelId 01a087d3-3b04…
20:19:53.939  INFO  adopted a channel from an engine replica that died  channelId 01a087d3-3b00…
20:19:53.939  WARN  finished contesting … candidates:2 adopted:2
```

**12.3 s from kill to both legs adopted** — the 15 s lease minus the renewal already banked, and
55 ms to contest and install both. Against the 90 s channel lease this replaces, and against the
"never, until a survivor is restarted" the audit measured. `/healthz` on the survivor:
`peersLost: 1, channelsAdopted: 2`.

### The half the audit could not reach: the BYE, and the CDR

The phone hung up at the end of the hold. `BYE -> 200 OK`; 4549 packets each way, **0 lost** for the
whole 91 s — the media never noticed. Both CDR legs were then filed **by the engine that adopted
them**:

```
 leg | direction | from | to   | hangup_cause    | code | disposition | billsec
 a   | internal  | 1601 | 1602 | NORMAL_CLEARING |   16 | answered    |    91.1
 b   | inbound   | 1601 | 1602 | NORMAL_CLEARING |   16 | answered    |    91.1
```

The full duration, billed, on both legs. This is the exact outcome the finding recorded as
impossible ("the call was never billed… no CDR row was written"), and it is the half that needed
`registerAdoptedLeg`: without it the aggregate is adopted but the BYE is never sent to the edge.

### The reverse direction, incidentally proved

Bringing `e2e-engine-1` back and stopping `e2e-engine-2` reproduced it symmetrically:
`an engine replica stopped renewing its liveness lease {instanceId:"e2e-engine-2"}` →
`candidates:2 adopted:2`. (engine-2 had to be `kill -9`'d after its graceful drain ran past the
window, so the lease EXPIRED rather than being released — which is why this ran the death path at all
and is a fair second sample.)

### Final state, and one honest residue

Stack running, **one engine**, smoke call `TestE2EHoldACallOpen` **PASS** (449 packets each way,
0 lost, `BYE -> 200 OK`), `/healthz` `ok`.

`activeChannels` settles at **2, not 0**, and they are not the smoke call — that one tore down
cleanly. They are two WSS legs admitted at 20:19:46, five seconds AFTER the SIGKILL, which `sipd`
then rejected at admission (`hangup cause:1, from:"proceeding"`). engine-2 held them, engine-2 was
force-killed mid-drain, and engine-1 correctly adopted them.

**This is a real limitation and it is not new to this change.** An adopted snapshot for a call the
SIP edge has already refused has no live dialog to reconcile against, so nothing tells the adopter
the call is over; `installChannel` drops a snapshot in state `destroyed`, but one abandoned in
`proceeding` is indistinguishable from a call that is genuinely still ringing. The same is true of
boot hydration and was true before this change. They are bounded by
`ENGINE_MAX_CALL_DURATION_SECONDS` (default 4 h), which is a long time to carry two phantom
channels in `activeChannels`. **Reconciling an adopted non-answered leg against `sip-dialogs` — which
already holds the edge's own record of whether the dialog exists — is the obvious next step and I did
not do it.**

### Restarts, and the broker

Logged in `STACK.md` round 4. `LOAD-RUNNING` was polled every 2 min and had cleared before any
engine was touched; the broker `kill -HUP` happened earlier and only ADDS grants, so it was safe
while the wave ran. Broker violations: **995 before my reload, 995 after** — zero new. They rose to
**999** afterwards from four `AUTHORIZATION_VIOLATION`s I caused myself with a throwaway
`nats://…` script that used the wrong credential while inspecting the `channels` bucket; no service
was involved and nothing was written.

## Files changed

| File                                                                            | Change                                                                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/events/src/schemas/live-state.ts`                                     | `engineInstanceLeaseSchema`, `isEngineInstanceLeaseExpired`                              |
| `packages/events/src/streams.ts`                                                | `ENGINE_INSTANCES_KV`, `kvKeyFor.engineInstance`, apply order                            |
| `packages/events/src/{index,schemas/index}.ts`, `scripts/registry.ts`           | exports + codegen registration                                                           |
| `packages/events-go/streams.go`                                                 | `EngineInstancesKV`, `EngineInstanceKVKey` (hand mirror)                                 |
| `packages/events-go/*_gen.go`, `packages/events/schema/**`                      | regenerated; idempotent                                                                  |
| `apps/engine/src/nats/instance-liveness.watcher.ts`                             | **new** — shared watch/sweep/report-once; wakeable backoff                               |
| `apps/engine/src/nats/engine-liveness.service.ts`                               | **new** — own lease + peer watch + chained contests                                      |
| `apps/engine/src/nats/channel-watch.service.ts`                                 | **new** — `channels` watch + revision stale guard                                        |
| `apps/engine/src/media/sipd-liveness.service.ts`                                | refactored onto the shared watcher                                                       |
| `apps/engine/src/nats/jetstream.service.ts`                                     | `engineInstances` view; `adoptChannelFromInstance`                                       |
| `apps/engine/src/media/split-plane.port.ts`                                     | `registerAdoptedLeg`                                                                     |
| `apps/engine/src/calls/channel-orchestrator.service.ts`                         | `adoptChannelsOfInstance`, `adoptOrphanedChannel`, `installChannel`, split-plane restore |
| `apps/engine/src/nats/nats.module.ts`, `main.ts`, `health/health.controller.ts` | wiring and `/healthz.engine`                                                             |
| `config/nats.conf`                                                              | `engine-instances` grants; reloaded, zero new violations                                 |

## Verification

- `apps/engine`: `tsc --noEmit` clean; `bun test` **1679 pass, 26 skip, 0 fail** (1705 across 77
  files); gated `engine-adoption.spec.ts` **4 pass, 0 fail**.
- `packages/events`: `tsc --noEmit` clean; `bun test src` **396 pass, 12 skip, 0 fail**;
  `turbo typecheck --filter=...@optimiq-voice/events` **16/16 successful**; `codegen` idempotent.
- `packages/events-go`: `gofmt -l` clean, `go vet` clean, `go test -race ./...` ok.
- `oxlint` on both areas: no new diagnostics (one pre-existing `no-explicit-any` warning in
  `packages/events/src/schemas/media-dtmf-recording.spec.ts`, untouched). `oxfmt` applied, 212 files.
