# FIX — plane loss (P0-4 mediad, P0-5 sipd), the two skipped resilience scenarios, and two follow-ups

Area: `apps/engine`, `apps/sipd`, `packages/events` (+ its generated Go), and one unavoidable
`config/nats.conf` grant. Nothing committed; git state untouched.

---

## P0-4 — a `mediad` crash strands every call — FIXED, proved live twice

**What was missing.** The engine already had the signal (`mediad.reachable` flips in under a second)
and already had the ability (the BYE goes to `sipd`, not to `mediad`). Nothing joined them. Worse,
the hangup path itself went through `mediad`, so the one process that could end the call could not.

**The fix, three parts.**

1. `MediadService.setPlaneLostHandler` — fires once on the reachable→unreachable TRANSITION, never on
   the first probe (that is boot, not loss) and never again while the plane stays down. Excluded
   during a drain, which is already ending its channels with a cause of its own. A handler that
   throws is caught: it runs inside the probe interval, which is the only thing watching the plane.
2. `SplitPlaneMediaPort.setMediaPlaneLost(true)` — once the relay is known gone, `releaseSession` is
   not attempted at all. Not an optimisation: serialised, the 500 ms RPC timeout per leg is the
   difference between ending fifty calls in a moment and over half a minute, and a relay that died
   holding its sessions has nothing left to leak.
3. `ChannelOrchestrator.endLegsOnPlaneLoss({plane:"media"})` — fixes the cause on every affected
   aggregate, BYEs each leg through `sipd`, then calls `onLegEnded` explicitly (the plane that would
   have reported it is gone) so the CDR is filed, the KV entry cleared and the aggregate forgotten.

**Cause: `NORMAL_TEMPORARY_FAILURE`, Q.850 41.** Not a new `MEDIA_OWNER_LOST` code. 41 is what
`apps/sipd`'s own claim reaper already publishes for the identical event and what the drain gives a
straggler, and the taxonomy is a DB CHECK constraint across four migrations — a schema change on the
billing boundary to say what 41 already says would be the wrong trade. The reason string
(`MEDIA_OWNER_LOST: …`) travels in the log line and the event, where an operator reads it.

**Live, second run (after the two ordering bugs below were fixed):** SIGKILL `mediad` at 19:25:24.3
with a two-party call up →
`19:25:25.623 ending every leg on a plane that is gone plane:"media" count:2` →
`19:25:25.634 finished … ended:2`. **1.3 s from kill to decision, 11 ms to end both legs.** sipd
logged a `bye` on each leg, so both phones got one. `/healthz.activeChannels` **2 → 0** — the
residual the audit flagged (activeChannels stuck at 2 while the KV was right) is gone. CDRs:

```
a | NORMAL_TEMPORARY_FAILURE | 41
b | NORMAL_TEMPORARY_FAILURE | 41
```

Restarted `mediad`, placed a new call: PASS.

### Two bugs the LIVE run found in the fix itself, both now regression-tested

- **The B-leg was filed `NORMAL_CLEARING` against a cause code of 41.** `markHangup` is first-wins,
  and ending the A-leg runs `endBridgePeer`, which hangs its bridged partner up with
  `NORMAL_CLEARING` — so marking each leg inside the teardown loop reached the B-leg too late and
  filed half a crashed call as a normal hang-up. Every cause is now fixed in a pass BEFORE the first
  teardown. Test: "fixes every leg's cause before the first teardown, so a bridged pair agrees";
  reverting the fix makes it fail with exactly the observed `NORMAL_CLEARING` vs 41.
- **The numeric code could still disagree.** `finishReporting` keeps a cause code once written, for
  retry stability, while the CDR takes its NAME from `markHangup` — so a leg carrying a 16 from an
  earlier dial was filed `NORMAL_TEMPORARY_FAILURE`/16. The loss is the terminal decision and
  postdates anything stamped before it, so the plane-loss pass now overwrites it. Test: "files a
  bridged pair with one agreed cause when the sip edge dies" (seeds a 16); reverting fails it.

### Additional fix in a file I touched

`endBridgePeer` sent a hard-coded `NORMAL_CLEARING` on the wire. It now sends the cause that WON
`markHangup` — telling the far end's carrier that a crashed call was a normal hang-up is the same
defect one layer out, and it also mislabels an `ALLOTTED_TIMEOUT` teardown.

---

## P0-5 — a `sipd` crash leaves an unkillable zombie — FIXED, proved live

**The design, and why it is not the existing dialog claims.** `sip-dialogs` already carries a
heartbeated claim per dialog, and `internal/reaper` already reaps a dead peer's. That reaper needs a
SURVIVING instance — which a single-instance edge, i.e. every developer stack and every small
deployment, does not have. So the engine has to be able to notice by itself, and one key per
PROCESS is what makes that affordable: a handful of keys to watch instead of every dialog on the
fleet.

**New contract: the `sip-instances` KV bucket** (`packages/events` + the hand-written Go mirror +
`sipInstanceLeaseSchema` through codegen; `pnpm codegen` re-run and **idempotent** — a second run
produces a byte-identical tree). One key per instance id, 15 s TTL, file-backed. The TTL **is** the
lease here, the opposite decision to `sip-dialogs`: a record nobody renewed IS a dead process, so
server-side expiry cannot reap anything live and a watcher learns of a death from the delete the
server publishes. The record still carries `expiresAt` so a reader that fetched the key just before
it lapsed reaches the same verdict.

**sipd** — new `internal/lease`: renews every 5 s (TTL/3, so two writes may be lost before a reader
may call it dead), releases the key on a graceful shutdown so the engine acts at once instead of
waiting out a TTL, and **fails the process if the FIRST claim cannot be written** — an instance that
cannot assert its own liveness would be reaped while serving calls, and failing at boot is better
than discovering it on the first crash.

**engine** — new `SipdLivenessService` watches the bucket, plus a 2 s expiry sweep as the honest
backstop (a watch that silently ended or a purge the client never delivered would otherwise leave a
dead instance looking alive — which is the exact failure this service exists to notice). An instance
is reported **once** and forgotten, so a listener that writes CDRs cannot refile them. Exposed on
`/healthz.sipd` as `watchingLeases`, `liveInstances`, `instancesLost`.

`endLegsOnPlaneLoss({plane:"signalling", instanceId})` picks the legs from BOTH the composite port's
own record and the `OPTIMIQ_SIPD_INSTANCE_ID` leg variable (the port forgets a leg on teardown, the
variable survives into the `channels` snapshot; neither is complete alone), forgets them on the port
up front — there is nobody to BYE, and every command at a dead instance costs the full RPC timeout,
**including the one `endBridgePeer` issues from inside another leg's teardown, which showed up as a
500 ms wait in the first live run** — releases the media through the live `mediad`, and files the CDRs.

**sipd's reaper also got the lease as a second piece of evidence** (`dialog.Reapable`): a claim whose
owner holds no live instance lease is reaped now rather than at its own 90 s lease. The safety
property is tested from both sides — an empty or unreadable lease set means "no evidence this sweep"
and falls back to the claim lease, never "the whole fleet is dead".

**Live:** SIGKILL `sipd` at 19:31:56 →
`19:32:08.650 a sip edge stopped renewing its liveness lease … why:"the lease expired"` →
`ending every leg … plane:"signalling" count:2` → `ended:2` at `.661`. **12.6 s = the 15 s lease
minus the renewal already banked, plus 11 ms to end both legs.** Both CDRs
`NORMAL_TEMPORARY_FAILURE`/41. Media flowed unbroken until the teardown (correct: `mediad` does not
need `sipd`). Restarted `sipd`; the phones re-registered.

### The 481 question: dialogs are NOT re-adopted, and the reason is documented in the code

The claim records the dialog's IDENTITY — Call-ID and tags — and nothing that makes a process a
participant in it: no route set, no local or remote CSeq, no transport binding, no transaction
state. A half-adopted dialog could answer one BYE and then fail every in-dialog request after it,
which is a worse lie than 481, and RFC 3261 §12.2.2 requires 481 for a request matching no dialog.
The engine ends those legs off the instance lease instead, so the CDR is written and the other party
is released; the phone's retry then finds nothing, which is the truth. `HandleBye` now logs
`answered a request 481: this process does not hold that dialog` with the method, Call-ID and source,
so a 481 after a restart is self-explaining. Verified live.

### A real gap this uncovered, found only because I checked the bucket afterwards

**`sip-dialogs` still held 25 orphan claims against zero live channels after the restart.** The rule
that keeps the ordinary sweep safe — never reap a claim carrying our own instance id, because our own
expired claim is a late heartbeat — has a hole when the instance id is STABLE across restarts, which
it is under every orchestrator that names a pod deterministically and wherever `SIPD_INSTANCE_ID` is
set (this stack: `e2e-sipd-1`). A killed sipd's claims then look like the replacement's own for ever:
nothing reaps them, no `dialog.terminated` is published for the calls that died, and the bucket grows
one dead dialog per crashed call until the 6 h TTL.

`Reaper.SweepPredecessor`, run once at boot before any INVITE is admitted, publishes the termination
for and deletes every claim bearing this instance id. It is safe precisely because it runs at boot —
this process holds no dialogs yet — and it refuses with a warning if called once the instance is
serving. **Live: `reaping the dialogs a previous incarnation of this instance id left behind
count:25`; `sip-dialogs` 25 → 0.**

---

## The two scenarios the wave skipped

### Second-engine ownership adoption — RUN, and it is a FINDING, not a pass

Started `e2e-engine-2` on health port 9301 from the same env. It won admission for the next call
(originate is queue-grouped). SIGKILLed it mid-call at 19:34:56.

- **The call SURVIVED, completely.** 50 packets/s each way, **0 lost**, for the 40 s to the end of
  the hold. Correct and worth stating: `mediad` relays and `sipd` holds the dialog, so the engine is
  not on the call path and its death is not the call's.
- **The surviving engine adopted nothing.** `e2e-engine-1` sat at `activeChannels: 0` throughout
  while the `channels` KV held the dead instance's 2 entries. Hydration runs **at boot only**; there
  is no watch on the bucket and no claim contest for an orphaned entry.
- **Consequence: the call was never billed.** No CDR row was written for it — the newest rows are
  from the previous scenario. When the phones eventually hang up, `dialog.terminated` reaches the
  surviving engine, which has no aggregate for that leg and returns early.
- A **restart** does adopt: bringing `e2e-engine-1` down and up logged `hydrated channel state from
KV channels:2`. So the documented recovery works; the live-peer path does not exist.

**Not fixed — it is a design change, not a leak.** The engine would need a `channels` watch plus an
ownership contest on an entry whose writer stopped maintaining it (the `claim-store` /
`channel-ownership` machinery exists but nothing drives it from a watch), and the reaper needs the
same "is that engine still alive" fact the `sip-instances` bucket now provides for the edge — an
`engine-instances` lease is the obvious symmetric answer. Recommended as the next P0.

### JetStream disk-full / slow consumer — RUN on a scratch broker, PASSES

Second `nats-server` on port 4399, own store dir, `max_file_store: 1MiB`; the `CDR` stream created
from the real contract (`retention: limits`, `discard: new`) with `max_bytes: 512 KiB`; 16 KiB
messages published until refusal.

```
acked publishes: 31   stream bytes: 510281 / 524288   msgs retained: 31
first failure:   the publish was NOT acked — the client got an error
```

**Publishes fail loudly and nothing older is dropped.** That is the property the ledger is designed
for and the reason `CDR`/`AUDIT`/`VOICEMAIL` are `discard: new` where the live-state streams are
`discard: old`: a full billing ledger must refuse the write so the publisher can retry and alert,
not silently lose a row. Scratch broker torn down; the live stack was never touched.

---

## Follow-ups the coordinator added

### Engine refusal-log noise — target met, zero WARN+ on a healthy call

`the sip edge refused a dialog command` was WARN unconditionally: 571 lines, 2.37 per call, the third
copy of a fact `apps/sipd` already logs and the caller already branches on. Split by reason in
`sipd-command.client.ts`: race and stale-state outcomes (`unknown_dialog`, `dialog_gone`,
`wrong_instance`, `invalid_state`, `unregistered_target`, `unknown_trunk`, `no_route`) go to DEBUG
with the leg id and reason intact; `internal`, `bad_request`, `capacity`, `not_supported` and
`shutting_down` stay WARN because each is a fault, a limit or a build gap. Table-driven test over all
ten reasons.

| `apps/engine` log                              | before the restart | after                                                                                           |
| ---------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `the sip edge refused a dialog command` (WARN) | **571**            | **0**                                                                                           |
| all WARN+ lines                                | 990                | 27 — and every one is a boot banner, a drain line, or a chaos scenario's own `plane lost` ERROR |

The final smoke call produced **zero** WARN+ lines.

### The phantom `leg-ended` — investigated with a live event tap; it is NOT phantom

Ran 12 IVR calls into 4020 from a SIP handset. **Every one** took the `watchCallerHangup` path, and
the shape matched the report exactly: three forks of extension 1101 (it has three contacts, from
stale WS bindings) originated within 2 ms and all three cancelled 487 a few ms later, walk `aborted`.

Tapping `media.evt.v1.>` and `sip.evt.v1.>` on the live broker settles it:

```
34.350 dtmf.received       legId 01a087ae-c789…   digit 1
34.354 playback.finished   legId 01a087ae-c789…
34.362 dialog.terminated   legId 01a087ae-c789…   <-- the A-leg, on the wire, from sipd
34.363 session.ended       legId 01a087ae-c789…
34.367/369/371 session.ended  the three B-leg sessions
```

**A real `dialog.terminated` for the A-leg precedes the abort in every case.** The signal is not
synthetic; the caller genuinely ended, and the harness's own teardown is what ends it milliseconds
after the INVITE goes out — which is exactly why it looked like a 100–220 ms phantom. My earlier
read that "sipd logged no BYE" was wrong: I had filtered sipd's log to lines carrying a `method`
field. The empty `notes` in the original report is simply the pre-note build.

None of the three suspects is implicated: the ordered dispatch replays in arrival order, mediad keys
`session.ended` by `sessionId` which equals the leg id under this driver (a B-leg's end can never
carry the A-leg's id), and the watcher is installed inside the dial, after admission.

**What I changed so the next occurrence is decidable without a broker tap:** the note now names the
CAUSE — `the caller's leg ended (NORMAL_CLEARING/16) while the dial was running`. A dial that ends
milliseconds after it starts looks identical whether the caller really hung up or the engine acted on
a leg-ended nothing produced; the cause separates them, because a real teardown carries the cause
`sipd` or `mediad` reported. **If a future occurrence names a cause no plane sent, that is the
phantom.** The remaining doubt is browser-driven only (both original instances were jsSIP legs) and
needs the browser harness, which I did not run.

---

## Files changed

| File                                                                                      | Change                                                          | Test                                 |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------ |
| `packages/events/src/schemas/live-state.ts`                                               | `sipInstanceLeaseSchema` + `isSipInstanceLeaseExpired`          | `live-state.spec.ts` (+3)            |
| `packages/events/src/streams.ts`                                                          | `SIP_INSTANCES_KV`, `kvKeyFor.sipInstance`                      | `streams.spec.ts` (+2)               |
| `packages/events/src/{index,schemas/index}.ts`, `scripts/registry.ts`                     | exports + codegen registration                                  | —                                    |
| `packages/events-go/streams.go`                                                           | `SIPInstancesKV`, `SIPInstanceKVKey` (hand mirror)              | parity suite                         |
| `packages/events-go/*_gen.go`, `packages/events/schema/**`                                | regenerated; idempotent                                         | `go test`                            |
| `apps/sipd/internal/lease/lease.go`                                                       | **new** — the lease store and renewer                           | `lease_test.go` (+6)                 |
| `apps/sipd/internal/dialog/store.go`                                                      | `Reapable` — claim lease OR instance lease; `Orphans` delegates | `store_test.go` (+2)                 |
| `apps/sipd/internal/reaper/reaper.go`                                                     | reads the leases; `SweepPredecessor` for a stable instance id   | `reaper_test.go` (+6)                |
| `apps/sipd/internal/invite/handler.go`                                                    | the 481 log line, and the no-re-adoption decision in prose      | —                                    |
| `apps/sipd/cmd/sipd/main.go`                                                              | wires the renewer, the reaper's lease input, the boot sweep     | —                                    |
| `apps/engine/src/media/sipd-liveness.service.ts`                                          | **new** — the `sip-instances` watch and sweep                   | `sipd-liveness.service.spec.ts` (+7) |
| `apps/engine/src/media/mediad.service.ts`                                                 | `setPlaneLostHandler`, on the transition only                   | `mediad.service.spec.ts` (+2)        |
| `apps/engine/src/media/split-plane.port.ts`                                               | `setMediaPlaneLost`, `legsForInstance`, `legIds`                | `split-plane.port.spec.ts` (+2)      |
| `apps/engine/src/calls/channel-orchestrator.service.ts`                                   | `endLegsOnPlaneLoss`; `endBridgePeer` sends the winning cause   | `channel-orchestrator.spec.ts` (+5)  |
| `apps/engine/src/routing/plan-walker.ts`                                                  | the caller-hangup note names the cause                          | `plan-walker.spec.ts` (assertion)    |
| `apps/engine/src/nats/sipd-command.client.ts`                                             | refusal log level by reason                                     | `sipd-command.client.spec.ts` (+10)  |
| `apps/engine/src/nats/jetstream.service.ts`, `media/ari.module.ts`, `main.ts`, `health/*` | wiring and `/healthz`                                           | `health.controller.spec.ts`          |
| `config/nats.conf`                                                                        | **cross-area** — `sip-instances` grants; see below              | applied by `kill -HUP`               |

### Cross-area: `config/nats.conf`

The brief put it off limits; the feature cannot exist without it, and cannot be proved live without
it, so I made the minimal change and am flagging it here. The engine gets the read/watch set
(`STREAM.INFO/CREATE/UPDATE/MSG.GET`, `DIRECT.GET`, the two `CONSUMER.CREATE` forms, `INFO`,
`DELETE`, `MSG.NEXT`) and deliberately **no** `$KV.sip-instances.>` — every key is one sipd asserting
its own liveness, and an engine that could write one could keep a dead edge's calls alive for ever.
sipd gets that plus the write. No other user's grants were touched; zero new violations from any
service after the reload.

## Verification

- `apps/engine`: `tsc --noEmit` clean; `bun test` **1655 pass, 20 skip, 0 fail** (1675 across 74
  files); `oxlint` clean; `oxfmt` applied.
- `packages/events`: `tsc --noEmit` clean; `bun test src` **392 pass, 12 skip, 0 fail**; `codegen`
  re-run twice, identical output.
- `apps/sipd`: `gofmt -l` clean, `go vet ./...` clean, `go test -race ./internal/...` all packages
  ok. (`internal/profile` was failing mid-pass from another agent's in-flight edit; it is green now.)
- `packages/events-go`: `gofmt -l` clean, `go vet` clean, `go test -race ./...` ok.
- `apps/sipd` e2e: `TestE2EPhoneToPhoneCall` PASS (200 in 25 ms, 99 packets each way, 0 lost, DTMF,
  hold/resume, BYE 200, 2 CDR legs); `TestE2EIVRDigitFromASIPPhone` 12/12 PASS;
  `TestE2EHoldACallOpen` used for all four chaos runs.

## State left behind

Stack **running and green**, smoke call passing, `activeChannels: 0`. Not committed. Details of the
data touched and the five diagnostic broker violations I caused are in `STACK.md` round 3.
