# FIX — AREA: engine-core (`apps/engine`, excluding `src/routing` and `src/queue`)

## P0

### [P0] sipd dialog feed invisible to `/healthz` — **FIXED**

- `src/health/health.controller.ts`: injected `SipdService`; added a `sipd { selected, subscription, eventsReceived }`
  section to `HealthReport`; folded `signallingReady = !isSelected || subscriptionState === "subscribed"` into `status`.
  Class doc gained the "why the sipd feed decides the status too" section next to the media one.
- Resubscribe: NOT added. `SipdService`'s `finally` already sets `subscriptionState = "closed"`, which is now exactly the
  hard-fail flag the audit offered as the alternative — the pod leaves rotation on the next probe. A blind resubscribe
  loop against a permissions failure would spin, and the recovery an operator wants there is a restart.
- Test: `src/health/health.controller.spec.ts` — degraded on a closed selected feed; ok on an idle unselected one.

### [P0] Live media events dispatched fire-and-forget with no ordering — **FIXED**

- `src/media/startup-media-event-buffer.ts`: `push` in direct mode now goes through `dispatchInOrder`, a per-key promise
  chain in the same shape as `JetStreamService.serializeChannelOperation` (the `catch` sits on the predecessor so one
  failed dispatch cannot cancel the event that ends the leg). Key is the leg (`channelId`, `channel.id` for
  `leg-arrived`), with `recording:<name>` / `endpoint:<name>` for the members that name no channel, so two unrelated
  calls never wait on each other. Added `settle()` for tests/teardown.
- Behaviour change: live dispatch is now deferred by microtasks rather than starting synchronously. One existing test
  asserted the synchronous shape and now awaits `settle()`.
- Tests: same-leg serialization, cross-leg independence, and "a throw does not stop the leg's next event".

### [P0] `ENGINE_INSTANCE_ID` defaults to `"engine"` — **FIXED**

- `src/config/engine-env.ts`: extracted `DEFAULT_ENGINE_INSTANCE_ID`, and added a `superRefine` clause (same shape as
  the `ARI_PASSWORD` one) refusing the literal default when `NODE_ENV === "production"`.
- `main.ts`'s HOSTNAME fallback is untouched and still wins: it writes `process.env.ENGINE_INSTANCE_ID` before
  `loadEngineEnv()`. `apps/engine/Dockerfile` sets `NODE_ENV=production`, and Docker/Kubernetes both set `HOSTNAME`, so
  containers are unaffected. No `.env` example or env doc lives under `apps/engine` (only `README.md`, which does not
  mention the variable).
- Tests: `src/config/engine-env.spec.ts` — refusal in production, acceptance with a supplied id.

## P1

- **`MediadMediaPort.music` never cleared on release — FIXED.** `music.delete(sessionId)` added to `releaseSession`'s
  cleanup (`src/media/mediad-media.port.ts`). No test: the map has no external accessor and the playback ref is derived
  from the channel id, so the leak is not observable through the port's own surface — any test would pass either way.
- **Failed `release-session` leaves the session registered — FIXED.** `releaseSession` now does the RPC in a `try` and
  forgets `sessions` / `music` / bridge membership in a `finally`; the error still propagates. Test:
  `mediad-media.port.spec.ts` — `channelExists` is `false` after a failed release.
- **`SplitPlaneMediaPort.answer` leaks the allocated session on refusal — FIXED.** Wrapped `allocateSession` through the
  refusal check in `try/catch`, mirroring `originate`: best-effort `releaseSession`, logged, then rethrow. Test:
  `split-plane.port.spec.ts` — the refusal path issues `media.release-session` and `channelExists` is `false`.
- **Ownership maintenance rescans the whole bucket serially — FIXED (2 of the 3 suggested).**
  `channel-orchestrator.service.ts`: renewals now run in bounded-concurrency batches of `OWNERSHIP_RENEWAL_BATCH` (16)
  instead of one await per owned leg; and the adoption pass now `continue`s over any snapshot carrying an unexpired
  lease held by another instance, which removes the second per-snapshot `kv.get` inside `adoptChannelAt` for the bulk
  of a busy cluster's bucket. Left alone: replacing `keys()` + per-key `get` in `JetStreamService.channelSnapshots`
  with a watch-backed cache — that is a real cache-coherency design, not a surgical fix, and the skip above already
  removes the round trip it was paying for on most keys.
- **`ENGINE_CLAIM_HEARTBEAT_MS` did not apply to channel ownership — FIXED.** `startOwnershipMaintenance` now uses
  `this.env.ENGINE_CLAIM_HEARTBEAT_MS`; the now-unused `CLAIM_HEARTBEAT_INTERVAL_MS` import was dropped. Default is the
  same constant, so unset deployments are unchanged.
- **`claimChannel` losing to a vanished key — FIXED.** `adoptChannelAt` now returns `"vanished"` (instead of `"owned"`)
  when the entry is absent or empty. `claimChannel` retries its `create` once on that, then gives up as `"unavailable"`;
  `adoptChannel` maps it to `"owned"` (nothing to adopt). Test in `jetstream.service.spec.ts` drives the exact race.

## P2

- **`onLegEnded` leaks a recording session when the leg is unresolvable — FIXED.** `src/calls/call-control.ts`: the
  `leg === undefined` path now releases the signal watcher and deletes the `recordings` entry.
- **Dead spread in `setConferenceLock` — FIXED.** Deleted `...(room === undefined ? {} : {})` and the `const room`
  lookup that only fed it.
- **`resolveTargets` fabricated leg id — SKIPPED (cross-area).** Threading a real leg id means changing the optional
  `resolveTargets(orgId, target)` signature on `MediaPort` and both call sites in `src/routing/plan-walker.ts`, which
  another agent owns this session. Adding an optional third parameter no caller passes would fix nothing. See
  "Cross-area needed".
- **`attemptFinishReporting` two views of one map — FIXED (partly).** `variables` is now read once (and copied) at the
  top and used for all six checks, replacing the three later `aggregate.snapshot.variables` re-reads; added a dated
  `TODO(2026-03)` on the legacy branch stating that it marks the terminal events published without publishing them.
  Not restructured further — the branch is behaviour-preserving on purpose.

## Additional fixes

None beyond the above; nothing else in the touched files looked clearly wrong.

## Cross-area needed

1. `src/routing/plan-walker.ts` (routing agent) + `src/media/media-port.ts`: widen `resolveTargets` to
   `resolveTargets(orgId, target, legId)` and pass the leg the walker is planning, so `SplitPlaneMediaPort.resolveTargets`
   can stop sending the literal `"resolve-contacts"` as the `legId` every AOR refusal is attributed by.
2. Deployment: any non-container production run of the engine (systemd, bare `node dist/main.js`) must now set
   `ENGINE_INSTANCE_ID` or `HOSTNAME`, or boot fails with a named error. `.scripts/verify-platform-stack.mjs:113`
   already sets it; container images get it from `HOSTNAME`.

## Verification

- `pnpm --filter @optimiq-voice/engine run typecheck` → clean (`tsc --noEmit`, no output).
- `pnpm --filter @optimiq-voice/engine run test` → **1562 pass, 0 fail**, 69 files.
- `pnpm exec oxlint` over my directories (`src/calls src/media src/nats src/config src/health src/session src/verbs
src/presence src/main.ts test`) → exit 0. A whole-`apps/engine/src` run reports one error in
  `src/queue/queue-event-publisher.service.spec.ts:33` (`no-unsafe-optional-chaining`), which belongs to the
  concurrently-edited queue area, not mine.
- `pnpm exec oxfmt apps/engine/src apps/engine/test` → applied; re-ran typecheck and tests afterwards.
