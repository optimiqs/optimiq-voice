# Audit — AREA: engine-core (`apps/engine`: src/calls, src/media, src/nats, src/session, src/verbs, src/config, src/health, src/presence, main.ts, Dockerfile, package.json)

Read in full: `main.ts`, `Dockerfile`, `package.json`, `calls/channel-orchestrator.service.ts` (4239 l), `calls/call-control.ts` (2991 l, focused on lifecycle/timers/teardown), `media/split-plane.port.ts`, `media/mediad-media.port.ts`, `media/mediad-event-mapping.ts`, `media/mediad.service.ts`, `media/sipd.service.ts`, `media/startup-media-event-buffer.ts`, `nats/sipd-command.client.ts`, `nats/jetstream.service.ts`, `nats/channel-ownership.ts`, `routing/claim-timing.ts`, `health/health.controller.ts`, `config/engine-env.ts` (schema scan), plus the relevant specs.

Counts: **P0 3 · P1 6 · P2 4**

---

## P0

### [P0] The `sipd` dialog feed is invisible to `/healthz`, so a dead signalling subscription reports `ok` (confidence: high)

- Where: `apps/engine/src/health/health.controller.ts:37-46` (constructor) and `:68-100` (`report()`); `apps/engine/src/media/sipd.service.ts:166-176`
- Code:
  ```ts
  const mediaReady = mediaDriver === "mediad" ? this.mediad.isReady : ariConnected;
  return { status: mediaReady && natsReady && !draining ? "ok" : "degraded", ... }
  ```
  and, in `SipdService`, when the iterator ends: `this.subscriptionStateValue = "closed"; if (!this.draining) this.logger.warn(...)` — nothing else.
- Problem: `HealthController` injects `AriConnectionService`, `MediadService`, `JetStreamService`, `ParkHandoffService` — **not `SipdService`**. Under the split plane, `sip.evt.v1.>` is the ONLY source of `dialog.answered` / `dialog.terminated`. `SipdService.start()` never resubscribes if the async iterator terminates, and the failure surfaces as a single `warn` line. The controller's own doc comment states the rule this violates verbatim: "An engine whose command client works but whose selected event feed is down is the worst possible state: it looks alive, answers health checks, and silently loses call lifecycle."
- Failure scenario / cost: the sipd subscription ends (server-side unsub, permissions change, a throw escaping `for await`). `mediad.isReady` is still true (probe + media subscription fine), `natsReady` is true → `/healthz` returns 200, the pod stays in rotation and keeps admitting INVITEs. No leg ever ends: no `channel.hangup`, no `channel.destroyed`, **no CDR** (revenue), no `releaseEndedLeg` → mediad RTP ports held until idle-reaped, concurrency ceiling ratchets to zero. Silent until a customer reports it.
- Fix: inject `SipdService`; add `sipd: { selected, subscription, eventsReceived }` to the report, and fold it into `status`: `const signallingReady = !this.sipd.isSelected || this.sipd.subscriptionState === "subscribed";` then `status: mediaReady && signallingReady && natsReady && !draining`. Separately, have `SipdService`/`MediadService` attempt one resubscribe (or set a hard-fail flag) in the `finally` block rather than only logging.
- Cross-area: none.

### [P0] Live media events are dispatched fire-and-forget with no ordering, contradicting the bootstrap contract (confidence: high)

- Where: `apps/engine/src/media/startup-media-event-buffer.ts:32-42`
- Code:
  ```ts
  push(event: MediaEvent): void {
      if (this.direct) { void this.dispatch(event); return; }
  ```
- Problem: during recovery the buffer drains **serially** (`await this.dispatch(event)` in `drain()`), and `main.ts:26-27` states the guarantee: "Events received during recovery are then replayed serially in arrival order, so no terminal event can slip between the snapshot read and local admission." The moment `direct` flips true — i.e. for the entire life of the process — that guarantee is dropped: every event starts a new promise chain and interleaves at every `await` inside `ChannelOrchestrator.dispatch` (KV round trips, `events.publish`, `routing.get`). Both `MediadService` and `SipdService` feed the same buffer, so a `dialog.answered` from sipd and a `session.ended` from mediad for the same leg race each other.
- Failure scenario / cost: `onCallStateChanged` (which awaits `settleOutboundAnswer`, `events.publish`, `jetstream.putChannel`) is still in flight when `onLegEnded` for the same leg begins. `onLegEnded` runs `finishReporting` → `deleteChannel` + `registry.remove`, and the still-running `onCallStateChanged` then calls `putChannel` on the deleted key — the exact defect `recordDestination`'s own comment describes ("a live-channel entry for a call that was over"), reintroduced on the hot path. Also permits `markAnswered`/`armCallDurationCeiling` after teardown, and out-of-order DTMF into a `gather`.
- Fix: serialize per leg. Keep a `Map<string, Promise<void>>` keyed by the event's channel/session id in the buffer (or in `handleEvent`) and chain: `const prev = chain.get(id) ?? Promise.resolve(); const next = prev.catch(()=>{}).then(() => this.dispatch(event)); chain.set(id, next); void next.finally(() => { if (chain.get(id) === next) chain.delete(id); });`. Same shape as `JetStreamService.serializeChannelOperation`, which already solves this problem for KV writes.
- Cross-area: none (the buffer is engine-local).

### [P0] `ENGINE_INSTANCE_ID` defaults to the constant `"engine"`, collapsing channel-ownership fencing across replicas (confidence: medium)

- Where: `apps/engine/src/config/engine-env.ts:317` — `ENGINE_INSTANCE_ID: z.string().min(1).max(128).default("engine")`; consumed at `apps/engine/src/nats/jetstream.service.ts` (`withChannelOwnership(..., this.env.ENGINE_INSTANCE_ID, ...)`) and `adoptChannelAt`.
- Code:
  ```ts
  if (
  	ownership !== undefined &&
  	ownership.expiresAt > now &&
  	(ownership.instanceId !== this.env.ENGINE_INSTANCE_ID || !allowSameOwner)
  )
  	return "owned";
  ```
- Problem: `main.ts:38-40` only fills the id from `HOSTNAME`, and only when both are effectively unset; if neither is set the schema silently supplies a value **shared by every replica**. `main.ts`'s own comment says why that is fatal: "an instance id shared by two processes would mean each of them believing it owns the other's orbits." With a shared id, `adoptChannel(allowSameOwner=true)` — which the hydration path and the every-30s ownership maintenance both call for _every snapshot in the bucket_ — treats another live replica's unexpired lease as its own and adopts it.
- Failure scenario / cost: two engines outside a container runtime (systemd, bare `node dist/main.js`, a test harness) both boot as `"engine"`. Replica B's ownership maintenance walks the whole `channels` bucket, sees replica A's valid leases stamped `"engine"`, adopts them, and takes the KV revision. A's next `renewChannel`/`putChannel` gets a conflict → `fenceChannel` → A stops handling live calls it is still bridged to, and B holds registry state for legs whose media it cannot command. Split ownership, dropped calls, duplicate/missing CDRs — the exact outcome invariant 5 exists to prevent.
- Fix: make the variable required in production. Either drop the `.default("engine")` (leave it `z.string().min(1)` and let `main.ts`'s HOSTNAME fallback be the only default), or add a superRefine like the `ARI_PASSWORD` one at `engine-env.ts:364`: refuse to boot when `NODE_ENV === "production"` and the resolved id is the literal `"engine"`.
- Cross-area: deployment manifests / compose must set `ENGINE_INSTANCE_ID` or `HOSTNAME` (`.scripts/verify-platform-stack.mjs:113` already does).

---

## P1

### [P1] `MediadMediaPort.music` is never cleared on session release — unbounded growth, one entry per held-then-hungup call (confidence: high)

- Where: `apps/engine/src/media/mediad-media.port.ts:326-335` (`releaseSession`), `:180` (`music`), `:663-693`
- Code:
  ```ts
  async releaseSession(sessionId: string): Promise<boolean> {
      const response = await this.call(...);
      this.sessions.delete(sessionId);
      this.forgetMember(sessionId);
      return response.released;
  }
  ```
- Problem: `this.music.set(channelId, playbackRef)` in `startMusicOnHold` is only removed by `stopMusicOnHold`. A caller on hold-music who hangs up (a queue caller abandoning, a parked call that times out, a held party who gives up) never reaches `stopMusicOnHold`, so the entry survives the leg forever.
- Failure scenario / cost: a busy queue leaks one `Map` entry per abandoned caller. Over a long-lived pod this is unbounded heap growth in the media adapter with no upper bound and no eviction; there is no `forget`-style API a caller could use to fix it externally.
- Fix: add `this.music.delete(sessionId);` beside `this.sessions.delete(sessionId)` in `releaseSession`.
- Cross-area: none.

### [P1] A failed `release-session` leaves the session in the local registry forever, so `channelExists` lies (confidence: high)

- Where: `apps/engine/src/media/mediad-media.port.ts:326-335`
- Code:
  ```ts
  const response = await this.call(RPC_SUBJECTS.mediaReleaseSession, { sessionId }, ...);
  this.sessions.delete(sessionId);   // never reached when `call` throws
  ```
- Problem: `call()` throws `MediaCommandRefusedError` on `ok:false` and propagates transport timeouts. On either, the `sessions` set (and the bridge membership via `forgetMember`) keeps the dead session.
- Failure scenario / cost: `mediad` is briefly unreachable during a teardown storm; every leg torn down in that window stays in `sessions` permanently. `channelExists()` — used by callers to decide whether a leg still has media — answers `true` for legs that are gone, and the set grows without bound. Note `releaseSession` is also the reachability probe (`mediad.service.ts:148`), so probe ids also accumulate on the failure path.
- Fix: wrap in `try { await this.call(...) } finally { this.sessions.delete(sessionId); this.forgetMember(sessionId); }` and return `false` (or rethrow) after cleanup. Release is documented as idempotent, so forgetting locally on failure is safe.
- Cross-area: none.

### [P1] `SplitPlaneMediaPort.answer` leaks the allocated mediad session when signalling refuses (confidence: medium)

- Where: `apps/engine/src/media/split-plane.port.ts:320-357`
- Code:
  ```ts
  const allocation = await this.media.allocateSession({ ... });
  if (allocation.sdpAnswer === undefined) { throw new SplitPlaneLegStateError(...); }
  const reply = await this.signalling.answer(leg.instanceId, {...});
  if (!reply.ok) { throw new SplitPlaneSignallingRefusedError(...); }
  ```
- Problem: `originate` wraps its whole body in a `try/catch` that calls `this.hangup(...)` for exactly this reason ("An RPC timeout can leave a sent INVITE or allocated media behind"). `answer` has no such cleanup, and `sipd` refusing an answer is a **documented normal outcome** (§4.4, the CANCEL-lost-the-race branch — asserted by `split-plane.port.spec.ts:147`). The RTP port pair, the `media-sessions` directory entry and the local `sessions` membership stay behind.
- Failure scenario / cost: usually recovered, because a `dialog.terminated` for the same leg reaches `onLegEnded` → `releaseEndedLeg`. But when the terminate arrived _before_ the answer resolved (which is exactly the race that caused the refusal), the aggregate is already gone and the newly allocated session is orphaned until `mediad`'s idle reaper collects it. Under a CANCEL storm that is a sustained port-pool drain.
- Fix: mirror `originate`'s shape — wrap from `allocateSession` to the refusal check in `try/catch`, and on the catch path `await this.media.releaseSession(channelId)` (best-effort, logged) before rethrowing.
- Cross-area: none.

### [P1] Ownership maintenance rescans the entire cluster-wide `channels` bucket serially every ~30 s (confidence: high)

- Where: `apps/engine/src/calls/channel-orchestrator.service.ts:489-522` (`runChannelOwnershipMaintenance`), `apps/engine/src/nats/jetstream.service.ts` (`channelSnapshots`), `apps/engine/src/routing/claim-timing.ts` (`CLAIM_HEARTBEAT_INTERVAL_MS = 29_999`)
- Code:
  ```ts
  for (const aggregate of this.registry.all) { const renewed = await this.jetstream.renewChannel(...); }
  for await (const snapshot of this.jetstream.channelSnapshots()) { ... await this.hydrateChannel(snapshot, now); }
  ```
  and `channelSnapshots`: `const keys = await kv.keys(); for await (const key of keys) { const entry = await kv.get(key); ... }`
- Problem: three nested serial costs per tick. (a) one `kv.update` per locally-owned leg, sequential; (b) an N+1 over the _whole_ bucket — `keys()` then one `kv.get` per key, sequential; (c) `hydrateChannel` on every snapshot, including ones owned by other live replicas, each doing another `kv.get` inside `adoptChannelAt`. Total ≈ `L + 2·N` sequential KV round trips every 30 s, where N is the cluster-wide live-channel count, on every replica — i.e. `O(N·replicas)` KV traffic.
- Failure scenario / cost: 1 000 concurrent calls across the fleet and 4 replicas ⇒ ~8 000 sequential KV round trips per 30 s window. At 1 ms RTT one maintenance pass takes ~2 s per replica; at 5 ms it takes ~10 s, a third of the heartbeat interval, and a lease is only three intervals wide — a slow pass directly risks spurious fencing of live calls.
- Fix: (1) batch the renewals with bounded concurrency (`Promise.all` over chunks of ~16) rather than awaiting each; (2) use `kv.history()`/a watch-backed cache instead of `keys()`+per-key `get`, or at minimum fetch entries with bounded concurrency; (3) skip `hydrateChannel` for snapshots whose `channelOwnershipOf(...).expiresAt > now` and whose `instanceId` is not ours — the adoption pass only needs _expired or unowned_ snapshots.
- Cross-area: none.

### [P1] `ENGINE_CLAIM_HEARTBEAT_MS` does not apply to channel ownership (confidence: high)

- Where: `apps/engine/src/calls/channel-orchestrator.service.ts:594-598`, vs `apps/engine/src/routing/claim-heartbeat.service.ts:90`
- Code:
  ```ts
  this.ownershipMaintenanceTimer = setInterval(() => { ... }, CLAIM_HEARTBEAT_INTERVAL_MS);
  ```
  (the imported constant) while the park/conference heartbeat uses `this.env.ENGINE_CLAIM_HEARTBEAT_MS`.
- Problem: one knob, two behaviours. An operator who lowers `ENGINE_CLAIM_HEARTBEAT_MS` (the documented reason to do so being a slow or contended KV) speeds up park/conference claim renewal and leaves **channel** leases on the hard-coded 29 999 ms — the interval whose whole justification is "three opportunities before the 90 s lease expires". Combined with the P1 above, a slow maintenance pass then loses channel leases while the operator believes they tuned for exactly that.
- Failure scenario / cost: live legs get fenced (`fenceChannel` → the replica stops handling calls it is bridged to) on a cluster the operator explicitly tuned to prevent it.
- Fix: `}, this.env.ENGINE_CLAIM_HEARTBEAT_MS);` in `startOwnershipMaintenance`. Same constant is already the schema default, so behaviour is unchanged for anyone who has not set the variable.
- Cross-area: none.

### [P1] `claimChannel` losing to a _stale-but-unexpired_ key silently drops the call on the ARI path (confidence: medium)

- Where: `apps/engine/src/nats/jetstream.service.ts` `adoptChannelAt` (`if (entry === null || entry.value.length === 0) return "owned";`) and `channel-orchestrator.service.ts:787-800` (`onLegArrived`, the `claim !== "claimed"` branch)
- Code:
  ```ts
  if (claim !== "claimed") { this.logger.info({...}, "not admitting a leg this replica does not exclusively own"); return; }
  ```
- Problem: `adoptChannelAt` answers `"owned"` for a key that was **deleted between the failed `create` and the `get`** — a state that means "nobody owns it", not "somebody does". The `onLegArrived` branch then returns without hanging the channel up (deliberately: "Never hang up here"), so on ARI the channel is left up in Stasis with no aggregate, no registry entry, no duration ceiling and no teardown path.
- Failure scenario / cost: a leg that rings forever and is only ended by Asterisk's absolute timeout, with no CDR. `placeInvitedCall` at least turns this into a `500` the edge can act on; the ARI arrival path has no such recovery.
- Fix: distinguish the cases — return a third result (or retry the `create` once) when `entry === null`, since a vanished key means the claim can be retaken. Failing that, in `onLegArrived` treat a non-`claimed` outcome on the ARI plane as "watch and re-check once" rather than an unconditional silent return.
- Cross-area: none.

---

## P2

### [P2] `CallControl.onLegEnded` leaks a recording session (and its signal watcher) when the leg is not resolvable (confidence: medium)

- Where: `apps/engine/src/calls/call-control.ts` `onLegEnded`
- Code: `if (this.recordings.has(mediaChannelId) && leg !== undefined) { await this.stopRecording(leg); }`
- Problem: the tap branch immediately below handles a missing leg fine (`endTap` takes the session, not the leg), and the consultation branch has the same `leg !== undefined` guard. When `host.legFor` returns `undefined`, the `recordings` entry and its `signals.watch` subscription are never released — `activeOperationCount` (read by `/healthz`) never drops and the `CallSignalBus` retains a dead watcher.
- Fix: on the `leg === undefined` path, still `this.recordings.get(id)?.stopWatching(); this.recordings.delete(id);` so the watcher is released even when the record-stopped event cannot be published.
- Cross-area: none.

### [P2] Dead spread in `setConferenceLock`'s success result (confidence: high)

- Where: `apps/engine/src/calls/channel-orchestrator.service.ts:790`
- Code: `...(room === undefined ? {} : {}),`
- Problem: both branches are empty — the expression, and the `const room = this.conferences.room(...)` lookup one line above that exists only to feed it, are dead. Every sibling result builder in the file writes `...(room === undefined ? {} : { locked: room.locked })`, so this reads as a bug that got half-fixed by adding `locked: result.locked` above without removing the remnant.
- Fix: delete line 790 and the now-unused `room` lookup.
- Cross-area: none.

### [P2] `SplitPlaneMediaPort.resolveTargets` uses a fabricated leg id (confidence: high)

- Where: `apps/engine/src/media/split-plane.port.ts:253`
- Code: `const reply = await this.signalling.resolveTarget({ orgId, legId: "resolve-contacts", target });`
- Problem: `legId` is the field every refusal on this family is attributed by — `SipdCommandClient.refuse` echoes it specifically "because the caller's whole reason for asking was that leg and a refusal it cannot attribute is a log line nobody can act on". Every AOR resolution across every tenant logs and throws under the same literal string, so the one field that makes an edge refusal traceable is constant. `originate` passes the real `request.channelId` on the same RPC three methods later.
- Fix: thread the caller's channel id into `resolveTargets` (it has one — the walker calls it while planning a specific leg) and pass it as `legId`.
- Cross-area: none.

### [P2] `attemptFinishReporting` mutates the aggregate through six sequential `setVariable` calls with an upgrade-only branch that is hard to reason about (confidence: medium)

- Where: `apps/engine/src/calls/channel-orchestrator.service.ts:474-511`
- Code:
  ```ts
  if (!enteringReporting && !hasTerminalEventIds) { aggregate.setVariable(TERMINAL_EVENTS_PUBLISHED_VARIABLE, "true"); }
  else { if (variables[TERMINAL_HANGUP_EVENT_ID_VARIABLE] === undefined) { ... } ... }
  ```
- Problem: the branch reads `variables` captured _before_ the mutations while the `if`s below re-read `aggregate.snapshot.variables` — two views of the same map in one function. The `!enteringReporting && !hasTerminalEventIds` case exists only to preserve behaviour for snapshots written before terminal-event recovery shipped; it is a migration shim with no expiry, and it marks the terminal events as published without ever publishing them. A future reader recovering a pre-upgrade snapshot cannot tell from here whether the events were emitted.
- Fix: read `aggregate.snapshot.variables` once at the top and use that binding throughout; add a dated TODO (or a version stamp on the snapshot) so the legacy branch can be deleted rather than living indefinitely.
- Cross-area: none.

---

## Verified and deliberately NOT reported

- `SipdCommandClient` — no pending map, no inbox handling of its own; `connection.request` owns the timeout and every failure path (`no responders`, timeout, non-JSON) funnels through `refuse`. Timeouts come from `packages/events` rather than literals, as documented. Clean.
- `SplitPlaneMediaPort.originate` — the `catch` → `hangup` → `forget` cleanup is present and correct, including the resolved-instance case.
- `MediadService` / `SipdService` subscription setup — `connection.flush()` as a barrier before going live, per-message `try/catch` so one poison message cannot end the feed, `drain()` (not `unsubscribe()`) on shutdown. Correct.
- `JetStreamService.onApplicationShutdown` — `connection.drain()` flushes in-flight CDR publishes. Correct.
- `serializeChannelOperation` — per-key promise chain with correct `finally` cleanup; no leak.
- `mediad-event-mapping.ts` — cross-checked against `mediaEventSchema`; the subject/payload `sessionId` cross-check is present, the dropped events (`session.rtp-timeout`, `playback.finished`) are argued and match the ARI mapping's drops, and the Q.850 table is defensible.
- Duration ceilings, CDR retry timers, park timers, consultation/tap/recording watchers — all have matching disarm paths and are cleared in `drain()`/`clear()`/`fenceChannel`. `unref()` is applied consistently.
- `main.ts` shutdown ordering (drain → `app.close()` → exit, with an unref'd hard deadline) is correct and Nest's own shutdown hooks are correctly left disabled.
