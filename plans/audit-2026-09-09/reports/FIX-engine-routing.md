# FIX — engine-routing

## P0

**#1 AOR fallback applied to off-net targets — FIXED**

- `routing/plan-walker.ts`: added `DialAttempt.onNet`; replaced the three
  `attempt.target ?? this.aorTargetFor(...)` sites with a new `targetFor(attempt)` that derives an
  AOR only when `onNet === true`. Set `onNet: true` at the six extension-number sites (intercom,
  paging fan-out, `extensionNode`, `screenCall`, follow-me extension hop, ring-group member).
  `followMeAttempt`'s trunk branch now carries `target: {kind:"trunk", trunkId, number}` like
  `trunkDialNode`. `externalNode` carries no target (no trunk id exists there) — the composite
  refuses by name, which is the honest failure.
- `queue/queue-session.ts`: `QueueDialAttempt.onNet` added and set from
  `agent.extensionNumber !== undefined`; `dialQueueAgents` forwards it.
- Tests: `plan-walker-follow-me.spec.ts` (off-net hop keeps the trunk target under a realm),
  `plan-walker.spec.ts` (external node gets no target under a realm),
  `plan-walker-queue.spec.ts` (agent AOR only when the roster gave an extension number).

**#2 `void` on rejectable promises — FIXED**

- `queue-session.ts`: new `detach(work, what)` helper (catch → `call.note`); used for both
  `startWrapUp` call sites and the previously-`void`ed `retryOwnedTransition` in
  `scheduleReleaseRetry`.
- `plan-walker.ts`: `void poll()` in `holdForModerator` now `.catch`es into `this.log`.

## P1 — all fixed

- **Publisher drops `resumed` / `exitKey`** — `queue-event-publisher.service.ts`: widened both
  parameter types (`resumed`, `exitKey`, `reason: "exit-key"`) and spread them into the payload.
  New spec `queue-event-publisher.service.spec.ts` (4 tests).
- **`retryOwnedTransition` retried forever** — `queue-session.ts`: `RELEASE_RETRY_MAX_ATTEMPTS = 30`;
  on exhaustion the entry is deleted, a note is filed and the promise resolves `false`. Test in
  `queue-session.spec.ts`.
- **Routing-artifact cache unbounded, `at` dead** — `routing-artifact.source.ts`: `at` is now used —
  `CACHE_TTL_MS` (1 h, mirroring the bucket) makes a stale entry a miss, and `CACHE_MAX_ENTRIES`
  (500) evicts least-recently-remembered in `remember`. Same bound applied to
  `queue-membership.source.ts` via a new private `remember(key, membership)`.
- **`C x A` agent-state KV gets per second** — `agent-state.store.ts`: `readStates` now shares a
  per-(org + sorted roster) snapshot for `ROSTER_CACHE_TTL_MS` (250 ms), cached before the await so
  concurrent callers de-dup; every successful write calls `invalidateRosterReads(orgId)`, so a
  reservation is never read stale. Expired entries pruned on each miss. Stale "two cached reads"
  comment in `queue-session.ts` corrected. Two tests in `agent-state.store.spec.ts`.
- **`rankOf` re-sorted the line per caller per pass** — `queue-waiting.ts`: rank is now counted in one
  linear pass (`compareWaiting` is a total order, so "how many sort ahead of me" is the index) — no
  copy, no sort. Existing rank tests cover it.
- **Failed `addToBridge` leaked the bridge** — `plan-walker.ts`: `bridgeWith`'s catch now calls
  `destroyBridgeQuietly(bridgeId)` first. `conferenceNode` does the same but **only when
  `joined.created`** — destroying a room another member is already talking in would end their
  meeting, which the audit's "same shape" wording does not account for. Test in `plan-walker.spec.ts`.

## P2

- **`started` vs originated in `dialSimultaneous` — FIXED** (routing side): new `originated` set,
  added immediately before `this.originate`, and used by the cleanup loop instead of `started`.
  Cross-area: the bogus `LOSE_RACE` record itself is filed by `OriginatedLegHooks` in `calls/`; no
  change needed there now that the call is not made.
- **`upsertWaiting` evicted an already-queued caller at the cap — FIXED** (`queue-waiting.ts`): the
  cap now applies only to a genuine insertion. Test added.
- **`releaseAll` applied one leg's cause to every agent — FIXED**: `releaseAll` takes an optional
  `causeAgentId`; the `failed` branch passes `outcome.agentId`, everyone else is released with no
  penalty. Test added. (Did not widen `QueueDialOutcome` to a per-attempt list — that is the larger
  refactor the audit offered as the alternative.)
- **`waitingCount` always 0 with a bucket — FIXED** (`queue-waiting.store.ts`): a `lastCounts` map is
  written on every successful mutate (both paths) and summed. Documented that it counts the shared
  line, not this process's callers. Test added. Cross-area: whichever `/healthz` handler reads it
  needs no change.
- **`isStaffing` counted an auto-benched agent — FIXED** (`agent-state.ts`): an `unavailable` entry
  with `reason === "max-no-answer"` no longer counts; a manual one still does. Test added.
- **`extensionNodeFor` full scan — FIXED**: lazily-built `WeakMap<nodes, Map<number, node>>` index on
  the walker, first-wins on duplicates as before.
- **`holdForModerator` 10-minute timer — FIXED**: the expiry is a clearable `setTimeout` (as
  `armProgressTimeout` already does) and is cleared after the race.
- **`random` sorted before shuffling — FIXED** (`queue-strategy.ts`): sort removed, comment says the
  strategy discards tier order deliberately.

Nothing skipped, nothing found wrong.

## Additional

- `plan-walker.ts`: the doc block above `aorTargetFor` was rewritten so it describes the function it
  is attached to (the split into `targetFor`/`aorTargetFor` would otherwise have left it stale).

## Cross-area needed

- None blocking. Noted for the `calls/` owner: the `LOSE_RACE` leg-hook record for never-originated
  ring-group members is now not produced at all, so no fix is needed on that side.
- No env var was added for the two new cache bounds (`CACHE_MAX_ENTRIES`, `ROSTER_CACHE_TTL_MS`) —
  `config/` is another agent's area; they are module constants. Promote them to `EngineEnv` later if
  wanted.

## Verification

- `pnpm --filter @optimiq-voice/engine run typecheck` — clean, no output.
- `pnpm --filter @optimiq-voice/engine run test` — **1571 pass, 0 fail**, 3520 expect() calls,
  70 files (was 1552/0 before the change; +19 new assertions-bearing tests).
- `pnpm exec oxlint apps/engine/src/routing apps/engine/src/queue` — 0 findings, 68 files.
- `pnpm exec oxfmt` on both dirs — clean.
