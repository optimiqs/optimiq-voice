# Audit — engine-routing

Area: `apps/engine/src/routing`, `apps/engine/src/queue` (+ specs). HEAD 724d9f1, branch
`feat/optimiq-pbx-phase0`. Read-only. Files read in full: `plan-walker.ts` (6555 l),
`queue-session.ts`, `queue-waiting.ts`, `queue-waiting.store.ts`, `queue-strategy.ts`,
`agent-state.ts`, `agent-state.store.ts`, `queue-membership.source.ts`,
`queue-event-publisher.service.ts`, `queue-registry.ts`, `routing-artifact.source.ts`,
`call-signals.ts`, `media-refs.ts`, `plan-destination.ts`, `trunk-selection.ts`,
`trunk-capacity.ts`, `claim-heartbeat.service.ts`, `claim-timing.ts`, both modules; skimmed the three
registries and the relevant specs.

Counts: **2 P0, 6 P1, 8 P2**.

---

### [P0] Off-net follow-me hops and `external` destinations are dialled as AOR lookups on the sipd plane (confidence: high)

- Where: `apps/engine/src/routing/plan-walker.ts:5893` and `:6268` (`attempt.target ?? this.aorTargetFor(attempt.destinationNumber)`), producers at `:3312-3330` (`followMeAttempt`, trunk branch) and `:3669-3684` (`externalNode`)
- Code:
  ```ts
  // dialOne / originate
  const target = attempt.target ?? this.aorTargetFor(attempt.destinationNumber);
  // aorTargetFor:
  return { kind: "aor", aor: `sip:${number}@${this.settings.sipRealm}` };
  ```
- Problem: `aorTargetFor` is applied as a blanket fallback to **every** `DialAttempt` that carries no
  explicit `target`. Only `trunkDialNode` sets one (`{kind:"trunk"}`). The off-net branch of
  `followMeAttempt` builds a `trunkDialTemplate` endpoint but returns **no `target`**; so does
  `externalNode`; so does `dialQueueAgents` (`:5470-5477`), whose `destinationNumber` is
  `agent.extensionNumber ?? agent.contact` (a raw dial string when the agent has no extension).
  With `ENGINE_SIP_REALM` (or an org realm) configured — which `channel-orchestrator.service.ts:1140`
  always does on the split plane — a hop to `+447700900123` becomes
  `{kind:"aor", aor:"sip:+447700900123@acme.example.com"}`.
  `dialOne`/`dialSimultaneous` then see `kind === "aor"` with no `contactUri` and call
  `MediaPort.resolveTargets`, i.e. `SplitPlanePort.resolveTargets` → `sipd`'s registration lookup
  (`media/split-plane.port.ts:243`).
- Failure scenario / cost: on the sipd plane, a user's follow-me ladder to their mobile is resolved
  against the tenant's `registrations` bucket. `resolveTarget` either refuses (the walker marks the
  route `unavailable` and reports `USER_NOT_REGISTERED`, `plan-walker.ts:5762`) or returns no
  contacts and sipd is asked to INVITE a fabricated AOR — never the carrier trunk the compiler
  chose. Off-net follow-me and every `external` destination silently stop working, and a queue agent
  whose roster contact is not an extension number is dialled against a nonsense AOR. Nothing in the
  suite covers it: `plan-walker.spec.ts:558/586/619` are the only `sipRealm` tests and all three are
  `extensionNode`.
- Fix: make the AOR fallback opt-in per site instead of global. Add a `readonly onNet?: boolean` (or
  a `targetKind`) to `DialAttempt`, set it only where an extension NUMBER is being dialled
  (`extensionNode`, `screenCall`, `intercomCode`, `ringGroupNode`, the `target.kind === "extension"`
  branch of `followMeAttempt`, `fanOutPage`), and change both call sites to
  `attempt.target ?? (attempt.onNet === true ? this.aorTargetFor(attempt.destinationNumber) : undefined)`.
  Minimal alternative: have `followMeAttempt`'s trunk branch and `externalNode` set
  `target: { kind: "trunk", trunkId: trunk.trunkId, number }` / `{ kind: "uri", ... }` explicitly and
  gate `aorTargetFor` on the attempt having been built from an extension node.
- Cross-area: none required for the fix; behaviour is observed through `media/split-plane.port.ts`
  and configured by `calls/channel-orchestrator.service.ts` (no change needed there).

### [P0] `void this.startWrapUp(...)` can raise an unhandled rejection from an ARI callback (confidence: medium)

- Where: `apps/engine/src/queue/queue-session.ts:936-938` and `:952`
- Code:
  ```ts
  const bridged = await this.call.bridge(mediaChannelId, () => {
  	void this.startWrapUp(membership, agentId);
  });
  ```
- Problem: `startWrapUp` → `transitionOwnedWithRetry` → `tryOwnedTransition` →
  `await this.services.agents.transition(request)`. `AgentStateStore.transition` swallows every
  bucket error, but its **last** statement is `await this.events.agentState(...)`
  (`agent-state.store.ts:328`) which is outside any try. It is safe today only because
  `QueueEventPublisher.publish` catches everything; any other `AgentStatePort`/`QueueEventPort`
  implementation (the fakes in `queue-services.fake.ts`, a future publisher, an injected DI
  decorator) that throws produces a rejection with no handler. The callback is invoked from
  `PlanWalker.bridgeWith`'s signal watcher (`plan-walker.ts:6348`), i.e. from the ARI event socket —
  the exact path `CallSignalBus`'s class comment says must never throw. `startWrapUp` also awaits
  `this.call.delay(...)` for the whole wrap-up window, so the rejection surfaces long after the walk
  has returned and cannot be attributed.
- Failure scenario / cost: one throwing port takes the whole engine process down mid-shift (Node ≥15
  default `unhandledRejection: throw`), dropping every live call.
- Fix: wrap the body of `startWrapUp` in `try { … } catch (error) { this.call.note(...) }`, or change
  both call sites to `void this.startWrapUp(...).catch((error) => this.call.note(...))`. Same for
  `void poll()` in `plan-walker.ts:4604`.
- Cross-area: none.

---

### [P1] `QueueEventPublisher` silently drops `resumed` and `exitKey` from the queue events (confidence: high)

- Where: `apps/engine/src/queue/queue-event-publisher.service.ts:58-73` and `:97-113`
- Code:
  ```ts
  async callerJoined(input: { … readonly callerNumber?: string }): Promise<void> {   // no `resumed`
      await this.publish("caller.joined", input.orgId, input.queueId, {
          callId: input.callId, legId: input.legId, position: …, priority: …,
  ```
- Problem: `QueueEventPort` (queue-session.ts:252-280) declares `resumed?: boolean` on
  `callerJoined` and `exitKey?: string` on `callerAbandoned`, `QueueSession` passes both
  (`queue-session.ts:1388`, `:695`), and the wire schema accepts both
  (`packages/events/src/schemas/queue-events.ts:35`, `:74-75`). The publisher's parameter types omit
  them and its bodies never spread them; TS method-parameter bivariance means `implements
QueueEventPort` still compiles. No spec exists for this class.
- Failure scenario / cost: `queue.caller.joined` never carries `resumed`, so no report can
  distinguish a restored abandoned caller from a fresh one — the whole abandoned-resume feature is
  invisible downstream. `queue.caller.abandoned` never carries `exitKey`, so "which key did people
  press to leave?" is unanswerable even though the schema field exists for it.
- Fix: widen both parameter types (`resumed?: boolean`; `reason` to include `"exit-key"`;
  `exitKey?: string`) and spread them into the `publish` payload exactly as `callerNumber` is.
- Cross-area: none — the schemas already support it.

### [P1] `retryOwnedTransition` retries forever with no give-up (confidence: high)

- Where: `apps/engine/src/queue/queue-session.ts:1250-1287`
- Code:
  ```ts
  if (result !== "retry") { … return; }
  schedule(Math.min(nextDelayMs * 2, RELEASE_RETRY_MAX_MS));
  ```
- Problem: the only exits are `succeeded` and `ownership-changed`. `tryOwnedTransition` returns
  `"retry"` whenever `readState` says `unavailable` — which is what `AgentStateStore.readState`
  returns for **any** unreadable bucket, including a permanently missing `agentState` KV view. There
  is no attempt cap and no deadline, so a deployment with the bucket unconfigured schedules an
  unref'd 5 s timer per agent per session, forever, each holding the `QueueSession`, the
  `QueueCandidate`, the membership snapshot and an unresolved promise alive.
- Failure scenario / cost: on a mis-provisioned or degraded broker every queued call permanently
  leaks one retry loop and one session graph per reserved agent. A single busy hour is thousands of
  live timers and retained sessions; the process never recovers without a restart.
- Fix: add a bounded budget — e.g. stop after `RELEASE_RETRY_MAX_ATTEMPTS` (or a wall-clock deadline
  of a few minutes), `delete` the entry from `transitionRetries`, resolve `false`, and
  `this.call.note(...)`. The agent's `availableAt` deadline already makes them eligible again
  (`isEligibleForDistribution`), so giving up is safe.
- Cross-area: none.

### [P1] The routing-artifact memory cache is unbounded and never re-verified (`CacheEntry.at` is dead) (confidence: high)

- Where: `apps/engine/src/routing/routing-artifact.source.ts:58-61`, `:66`, `:198-200`
- Code:
  ```ts
  interface CacheEntry { readonly artifact: RoutingArtifact; readonly at: number; }
  private readonly cache = new Map<string, CacheEntry>();
  private remember(a) { this.cache.set(a.organizationId, { artifact: a, at: Date.now() }); }
  ```
- Problem: `at` is written and read by nothing — no TTL, no max size, no LRU. Entries are only ever
  dropped by an explicit `invalidate`, by the watch dying, or by shutdown. On a multi-tenant fleet
  the map grows to one compiled artifact per organization ever routed (or ever `PUT` by any API
  instance, since the watch `remember`s every key), and each artifact is a full node table.
  The dead `at` field is evidence the freshness backstop the class comment describes ("the bucket's
  1 h TTL stays a backstop") was intended in memory and never implemented: a memory copy is served
  indefinitely with no re-verification while the watch is nominally alive.
- Failure scenario / cost: unbounded heap growth proportional to tenant count; a large fleet OOMs the
  engine. Secondly, `findTrunkEndpoint` (`:163-182`) scans every cached artifact's whole node table
  on each trunk `PeerStatusChange` — that scan's cost is also proportional to the unbounded cache.
- Fix: either delete `at` (and document that the watch is the only invalidation), or use it: add a
  `ROUTING_CACHE_MAX_ENTRIES` LRU eviction in `remember`, and treat an entry older than the bucket
  TTL as a miss in `get`. The same bound applies to `QueueMembershipSource.cache`.
- Cross-area: none.

### [P1] Agent states are read one KV `get` per agent per waiting caller per second (confidence: high)

- Where: `apps/engine/src/queue/queue-session.ts:608-611`; `apps/engine/src/queue/agent-state.store.ts:97-116`
- Code:
  ```ts
  const states = await this.services.agents.readStates(
  	this.call.organizationId,
  	membership.agents.map((agent) => agent.agentId),
  );
  ```
- Problem: `readStates` fans out to one `bucket.get` per agent, uncached. The session's loop comment
  (`queue-session.ts:20-24`) claims "each pass is two cached reads"; only the membership read is
  cached (`QueueMembershipSource`), and the agent-state read is `A` round trips. With `C` callers
  waiting on one instance and `A` agents on the roster the engine issues `C × A` KV gets **per poll
  interval (1 s)** — 50 callers on a 20-agent queue is 1000 gets/s from one process, and the busy
  hour is exactly when both numbers are large.
- Failure scenario / cost: broker saturation and rising poll latency during the traffic spike the
  queue exists for; the loop's own deadline arithmetic then drifts.
- Fix: add a short-TTL (≈250-500 ms) per-org snapshot cache in `AgentStateStore.readStates`, keyed by
  `orgId` + sorted agent ids, with the in-flight de-dup `QueueMembershipSource` already uses — or
  follow the same pattern and put a KV `watch()` on the `agent-state` bucket so states are pushed.
  Either way, correct the stale "two cached reads" comment.
- Cross-area: none.

### [P1] `rankOf` re-sorts the entire waiting line for every caller on every poll pass (confidence: high)

- Where: `apps/engine/src/queue/queue-waiting.ts:143-147`, `:126-131`; called from
  `queue-waiting.store.ts:319-332` (`viewOf`), which `QueueSession.announceIfDue` invokes each pass
  (`queue-session.ts:1328`)
- Code:
  ```ts
  export function rankOf(record, callId, now) {
      const ordered = orderedWaiting(record, now);      // [...entries].sort(compareWaiting)
      const index = ordered.findIndex((e) => e.callId === callId);
  ```
- Problem: `refresh` is called once per second per waiting caller, and each call parses the record,
  `pruneWaiting`s it (two filters), sorts all `N` entries and scans them, then `longestWaitMs`
  scans again. Per second the instance therefore does `O(N² log N)` comparisons plus `N` JSON parses
  of the whole record. `QUEUE_WAITING_MAX_ENTRIES` is the only bound.
- Failure scenario / cost: at N≈200 that is ~300k comparisons/s plus 200 full-record JSON parses/s
  on the call path, for a number that is used to decide one boolean (`mayOffer`) and, at most once a
  minute, an announcement.
- Fix: compute all ranks once per record read. Either have the store cache
  `(revision → ordered array)` and answer `rankOf` from an index built once, or return the whole
  ordered id list from `read` and let `viewOf` do a `Map` lookup. Simplest surgical version: memoise
  `orderedWaiting` on the parsed record object (a `WeakMap<QueueWaitingRecord, readonly Entry[]>`)
  so the sort happens once per read rather than once per `viewOf`.
- Cross-area: none.

### [P1] A failed `addToBridge` leaks the bridge on the media server (confidence: high)

- Where: `apps/engine/src/routing/plan-walker.ts:6322-6333` (`bridgeWith`); same shape at `:3875-3893` (`conferenceNode`)
- Code:
  ```ts
  await this.deps.media.createBridge({ bridgeId, name: `call-${…}` });
  await this.deps.media.addToBridge(bridgeId, [a, b]);
  } catch (error) {
      await this.hangupQuietly(peerMediaChannelId, "NORMAL_TEMPORARY_FAILURE");
      return { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" };   // bridge never destroyed
  ```
- Problem: `createBridge` can succeed and `addToBridge` fail (a channel that died in between is the
  normal case). The catch tears the peer leg down but never calls `destroyBridge`. `pagingNode`
  (`:2636-2643`) gets this right via `destroyBridgeQuietly`; `bridgeWith` and the conference join do
  not. `channel.setBridge` was not called yet either, so nothing downstream will clean it up.
- Failure scenario / cost: one orphaned mixing bridge per failed bridge attempt, accumulating on the
  media server for the life of the process — exactly the "failing leg leaves media allocated" case.
- Fix: `await this.destroyBridgeQuietly(bridgeId);` as the first statement of both catch blocks.
- Cross-area: none.

---

### [P2] `dialSimultaneous` hangs up legs that were started but never originated (confidence: medium)

- Where: `apps/engine/src/routing/plan-walker.ts:5753` (`started.add(index)`) vs `:5839-5844`
- Code:
  ```ts
  started.add(index);
  const work = (async () => { if (group === 0 && attempt.delaySeconds > 0) await Promise.race([…]);
      if (settled || this.abandoned) return;   // never originated, but `started` is set
  …
  if (!started.has(index) || channelId === winner || ended.has(index)) continue;
  await this.hangupQuietly(channelId, winner === undefined ? "ORIGINATOR_CANCEL" : "LOSE_RACE");
  ```
- Problem: a delayed ring-group member whose delay is still running when another member answers is
  marked `started` but has no channel. Cleanup calls `hangupQuietly`, which first calls
  `this.deps.legs?.hangingUp(channelId, "LOSE_RACE")` — filing a hangup cause for a media channel
  that was never `originated()`.
- Failure scenario / cost: spurious B-leg CDR / cause records and a guaranteed-to-fail media call per
  delayed member on every ring-all that settles early. Not fatal (`hangupQuietly` catches), but it
  pollutes the leg accounting `OriginatedLegHooks` exists to keep honest.
- Fix: track origination separately — set a `originated.add(index)` immediately before
  `await this.originate(...)` and test that (not `started`) in the cleanup loop.
- Cross-area: the wrong-cause record lands in `calls/` (`OriginatedLegHooks` implementation).

### [P2] `upsertWaiting` evicts an already-queued caller when the line is at its cap (confidence: high)

- Where: `apps/engine/src/queue/queue-waiting.ts:150-163`
- Code:
  ```ts
  const others = record.entries.filter((c) => c.callId !== entry.callId);
  if (others.length >= QUEUE_WAITING_MAX_ENTRIES) {
      return { ...record, entries: others, updatedAt: now };   // the caller's own entry is gone
  ```
- Problem: the comment says "the caller is still SERVED — they simply have no shared position", which
  is true for a _join_. For a _lease renewal_ of a caller already in the line, `others` excludes
  them, so the full-line branch **removes** them from a line they were legitimately in, and the next
  renewal cannot re-add them while the line stays full.
- Failure scenario / cost: at the cap, established callers are silently dropped from the shared line
  and their position collapses to "unknown" permanently; every caller behind them is told they are
  one place further forward than they are.
- Fix: short-circuit the renewal case — if `record.entries.length === others.length + 1` (the caller
  was present), always write `[...others, entry]` regardless of the cap; apply the cap only to a
  genuine insertion.
- Cross-area: none.

### [P2] `releaseAll` applies one leg's hangup cause as a penalty to every reserved agent (confidence: medium)

- Where: `apps/engine/src/queue/queue-session.ts:859-861`
- Code: `case "failed": { await this.releaseAll(pending, outcome.cause); break; }`
- Problem: on a ring-all, `QueueDialOutcome.failed` carries one `agentId` and one `cause` (the last
  leg to end, `plan-walker.ts:5676-5680`), but `releaseAll` applies `releaseFor(candidate, cause)` —
  and therefore that cause's penalty class and `noAnswerCount` increment — to **all** reserved
  candidates. One agent pressing decline gives the whole fanned-out set the `rejectDelaySeconds`
  penalty; one busy phone benches the rest with a busy delay and no no-answer increment.
- Failure scenario / cost: `maxNoAnswer` benching and the three configured delays are applied to
  agents whose phones behaved differently; a decline can take a whole tier out of distribution.
- Fix: extend `QueueDialOutcome.failed` (or add a per-attempt outcome list) so the session can
  release each agent with its own cause; failing that, release the named `agentId` with `cause` and
  the rest with `undefined` (no penalty).
- Cross-area: `QueueDialOutcome` is defined here but produced by `plan-walker.dialQueueAgents`; a
  richer shape touches `plan-walker.ts:5484-5507` only.

### [P2] `QueueWaitingStore.waitingCount` always reports 0 when a KV bucket is configured (confidence: high)

- Where: `apps/engine/src/queue/queue-waiting.store.ts:82-88`
- Code:
  ```ts
  get waitingCount(): number { let total = 0;
      for (const record of this.local.values()) total += record.entries.length; return total; }
  ```
- Problem: `this.local` is populated only on the no-bucket fallback path (`mutate`, `:212-219`). With
  JetStream configured — the deployed case — it stays empty, so the getter its own doc says
  "`/healthz` reads it" reports zero waiting callers no matter how many are queued.
- Failure scenario / cost: a health/ops signal that is silently and permanently wrong, i.e. worse
  than absent.
- Fix: keep the last `viewOf` result per `(org,queue)` from the bucket path too and sum
  `record.entries.length` from it, or drop the getter and expose `writes/conflicts/failures` only.
- Cross-area: whichever `/healthz` handler reads it (in `calls/` or the app root).

### [P2] `abandon()` announces a guessed position of 1 when the line is unreadable (confidence: high)

- Where: `apps/engine/src/queue/queue-session.ts:1401`
- Code: `position: Math.max(1, this.position),`
- Problem: `announceIfDue` (`:1350-1360`) and `exitKeyPressed` (`:696`) both go out of their way to
  omit an unknown position rather than guess — `exitKeyPressed` uses
  `...(this.position > 0 ? { position: this.position } : {})`. `abandon` does the opposite and files
  `position: 1` for a caller whose rank was never read. `publishJoined` at least documents the floor;
  `abandon` does not.
- Failure scenario / cost: SLA reports show a cluster of abandonments "at position 1" that are really
  KV read failures — the exact confusion the `position: 0` design was introduced to remove.
- Fix: use the `exitKeyPressed` spelling: `...(this.position > 0 ? { position: this.position } : {})`.
- Cross-area: none.

### [P2] `isStaffing` counts an auto-benched agent as staffing, defeating `maxWaitNoAgentSeconds` (confidence: medium)

- Where: `apps/engine/src/queue/agent-state.ts:171-173`; consumer `queue-session.ts:718-723`
- Code: `return entry !== undefined && entry.status !== "logged-out";`
- Problem: `releaseFor` writes `to: "unavailable", reason: "max-no-answer"` for an agent whose phone
  rang out `maxNoAnswer` times (`queue-session.ts:1126-1137`) — i.e. a handset the engine has decided
  is unplugged. `isStaffing` still counts them, so `deadlineReached`'s "is anybody working this
  queue at all" answers yes and the no-agent deadline never fires. The doc justifies including
  on-call / wrap-up / on-break, all of which are humans present; `unavailable(max-no-answer)` is not.
- Failure scenario / cost: a queue whose whole team's phones are unreachable holds callers for the
  full `maxWaitSeconds` instead of ejecting them after `maxWaitNoAgentSeconds`.
- Fix: exclude an `unavailable` entry whose `reason === "max-no-answer"` from `isStaffing` (keep a
  manually-set `unavailable` counted). One line, and it keeps the human/machine distinction the doc
  is actually arguing for.
- Cross-area: none.

### [P2] `extensionNodeFor` is a full linear scan of the artifact's node table (confidence: high)

- Where: `apps/engine/src/routing/plan-walker.ts:2066-2073`
- Code:
  ```ts
  for (const candidate of Object.values(input.plan.nodes)) {
      if (candidate.kind === "extension" && candidate.number === callerNumber) return candidate;
  ```
- Problem: `Object.values` materialises the entire node table on every call. Called from
  `screeningApplies` (every extension dial once screening is on), `currentFeatureState`,
  `redialCode`, and `intercomCode`. For a large tenant the node table is thousands of entries and
  this runs on the call setup path.
- Failure scenario / cost: an allocation and a full scan per screened call; O(nodes) where a Map
  lookup is natural. It also duplicates a lookup the artifact's number index already answers.
- Fix: build the number→node index once per walk (a lazily-initialised
  `private extensionsByNumber?: Map<string, ExtensionPlanNode>` populated on first use) and look up
  in it. Guard against duplicate numbers by keeping the first, as today.
- Cross-area: none.

### [P2] `holdForModerator` leaves a 10-minute timer and closure alive per held participant (confidence: medium)

- Where: `apps/engine/src/routing/plan-walker.ts:4614-4621`
- Code:
  ```ts
  const expiry = this.delay(this.settings.conferenceModeratorWaitMs).then(() => {
  	waiter.cancel();
  });
  await Promise.race([waiter.arrived, expiry]);
  polling = false;
  unwatch();
  waiter.cancel();
  ```
- Problem: `this.delay` has no cancellation, so the `conferenceModeratorWaitMs` timer (default
  600 000 ms) and its `.then` closure — which retains `waiter` and therefore the walker — survive
  for the full ten minutes even when a moderator arrives in the first second. Every other timer in
  this file is either `clearTimeout`ed or wrapped in a cancellable pair
  (`armProgressTimeout`, `awaitConfirmDigit`, `waitForRecording`).
- Failure scenario / cost: one retained walker + timer per participant who ever waits at a moderator
  gate, for ten minutes each; a busy meeting start pins the whole graph.
- Fix: reuse the existing cancellable pattern — build the expiry with the same shape as
  `awaitConfirmDigit` (a `{ promise, cancel }` pair over a `setTimeout` the caller clears) and
  `cancel()` it after the `Promise.race`.
- Cross-area: none.

### [P2] `random` strategy sorts before it shuffles (confidence: high)

- Where: `apps/engine/src/queue/queue-strategy.ts:294-296`
- Code: `return shuffled([...candidates].sort(compareByTier), input.random ?? Math.random);`
- Problem: a Fisher-Yates shuffle over an already-sorted array yields exactly the same distribution
  as one over the unsorted array; the `sort` is pure waste and it also misleads a reader into
  thinking the tier order survives (it does not).
- Failure scenario / cost: an `O(A log A)` sort per selection pass per waiting caller for no effect —
  and, more importantly, a comparator call that suggests a guarantee the strategy does not give.
- Fix: `return shuffled(candidates, input.random ?? Math.random);` and note in the doc that `random`
  deliberately discards the tier order (eligibility, which does honour tiers, is applied before it).
- Cross-area: none.
