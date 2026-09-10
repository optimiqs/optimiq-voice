# FIX-integration-engine (apps/engine cross-area integration)

## 1. `resolveTargets` fabricated leg id — FIXED

- `src/media/media-port.ts`: `resolveTargets?(orgId, target, legId)`; doc says `legId` is the leg the
  resolution is done FOR (the A-leg the walker is planning).
- `src/media/split-plane.port.ts`: takes `legId` and passes it to `signalling.resolveTarget`; the
  literal `"resolve-contacts"` is gone from both the request and the refusal. The refusal's
  `operation` is now `"resolve-targets"` (it was `"originate"`, which was untrue — no originate had
  been attempted) and its `channelId` is the real leg.
- `src/routing/plan-walker.ts`: threads `this.deps.channel.channelId` (the same id the walker already
  uses as `legId` elsewhere, e.g. the recording events).
- Tests: new `describe("resolveTargets")` in `split-plane.port.spec.ts` — one asserts sipd is asked
  with the real leg id and that contacts group by descending `q`; one asserts the refusal message is
  attributed to that leg.

## 2. `verbRequiresAnswer` at the hold/park guard — FIXED

- `src/verbs/verb-executor.ts`: `VerbChannelContext` gains `isAnswered`, and the guard now refuses
  `hold`/`unhold`/`park`/`unpark` on a leg with a media path but no answer, with reason
  "the leg is in early media and has not answered", before any media command is issued. Previously
  such a verb passed `verbRequiresMediaPath` and then hit `assertCallStateTransition("early","held")`
  — an invariant throw the error's own doc says must never surface.
- `src/calls/channel-orchestrator.service.ts`: both `VerbChannelContext` literals set
  `isAnswered: aggregate.isAnswered`. Behaviour there is unchanged today (that path already sourced
  `hasMediaPath` from `isAnswered`); the guard closes the hole for any caller that starts reporting
  early media honestly, and for the session path an external application drives.
- Tests: `verb-executor.spec.ts` gains an `EARLY_MEDIA` context (media path, not answered), a loop
  refusing all four verbs with no media call issued, and a control asserting `play` still works there.

## 3. Generated presence / media-session value types — NOT APPLICABLE (verified)

`FIX-pkg-contracts.md`'s liveState item is about the Go mirrors in `packages/events-go`
(`ExtensionPresenceValue`, `MediaSessionDirectoryValue`) consumed by `apps/sipd`/`apps/mediad`. On the
TS side the engine already imports the canonical `ExtensionPresence` from `@optimiq-voice/events`
(`src/presence/presence.service.ts`); there is no hand-written mirror in `apps/engine` and no
`*Value` TS export to swap to. No change.

## 4. Other cross-area items landing in apps/engine

- `FIX-engine-core.md` item 2 (`ENGINE_INSTANCE_ID`/`HOSTNAME` must be set for non-container runs) is
  a deployment note, not code; `.scripts/verify-platform-stack.mjs` already sets it. No change.
- `FIX-engine-routing.md`: the `LOSE_RACE` leg-hook note explicitly needs no change in `calls/`;
  verified nothing produces that record for never-originated members.
- `FIX-engine-routing.md`: `CACHE_MAX_ENTRIES` / `ROSTER_CACHE_TTL_MS` were left as module constants
  rather than promoted to `EngineEnv`. SKIPPED deliberately: the report calls it optional, and adding
  two env knobs nobody sets widens the config surface for no behavioural gain.
- `FIX-engine-core.md`'s reported oxlint error in `src/queue/queue-event-publisher.service.spec.ts:33`
  (`no-unsafe-optional-chaining`) no longer reproduces — the queue agent's landed version uses
  `envelope?.data ?? {}`. `oxlint apps/engine/src` is now clean.
- The remaining cross-area items in `FIX-pkg-domain.md`/`FIX-pkg-contracts.md` live in `apps/api`,
  `packages/*`, `apps/sipd` and `apps/mediad` — outside this brief.

## Verification (exact)

- `pnpm exec turbo run build --filter=@optimiq-voice/{telephony,routing,events}` → 4 successful, 4 total.
- `pnpm --filter @optimiq-voice/engine run typecheck` → clean (`tsc --noEmit`, no output).
- `pnpm --filter @optimiq-voice/engine run test` → **1575 pass, 0 fail**, 3536 expect() calls, 70 files
  (baseline after the routing agent: 1571/0 — +4 new tests).
- `pnpm exec oxlint apps/engine/src` → exit 0, no diagnostics.
- `pnpm exec oxfmt apps/engine/src` → 163 files, clean.

No git state touched.
