# FIX report — AREA web-lib (`apps/web` excluding `app/`)

## Findings

**[P0] `applyUpdate` never suppresses an unchanged KV `put`** — FIXED.
`lib/live/store.ts`: the `put` path now compares the parsed value against the held row and returns
`state` when identical (guarded on `state.loaded`, so a pre-snapshot put still flips `loaded`).
Added a private `sameLiveValue` structural compare — deep rather than shallow because `LiveChannel`
nests `profile`/`flags`; values come from `JSON.parse`, so no cycles. No signature change, so
`app/(app)/_hooks/use-live-queries.ts` needed no edit (cross-area avoided).
Tests: `lib/live/store.spec.ts` — republished identical registration returns the same object; a
changed field still applies.

**[P1] `applyClaimFrame` missing no-change guard** — FIXED.
`lib/live/store.ts`: new `sameConferenceClaim(a, b, now)` compares orgId/bridgeId/claimedAt/lock
fields and each contribution's `memberCount`/`moderatorPresent`, treating `expiresAt` as equal only
when both sides are still in the future (a lapsed lease changes `conferenceMemberCount`, so it must
go through). `Date.now()` is read inside the reducer because `applyConferenceUpdate`'s signature is
fixed by its `app/` call site.
Tests: rolled-forward lease returns the same object; an expired contribution and a moved member
count both apply.

**[P1] Every extra lease re-subscribes → O(N²) snapshots** — FIXED (option (a)).
`lib/live/client.ts`: the client caches the last snapshot per topic for the current connection and
replays it to the new lease only; it asks the server only when it holds none. Cache is cleared on
`onclose`, on `disconnect()`, and when a topic's last lease is released, so a snapshot from before a
reconnect is never replayed.
Tests: `lib/live/client.spec.ts` — replay without a subscribe frame; still subscribes when no
snapshot is held; does not replay across a reconnect.

**[P1] No liveness watchdog** — FIXED.
`lib/live/client.ts`: a timer armed on `onopen` and reset by every `onmessage`; on expiry
(`2 * LIVE_DEFAULT_HEARTBEAT_MS`) it closes the socket so the existing `onclose` → `scheduleReconnect`
path runs. Cleared on close, disconnect and destroy. `LIVE_DEFAULT_HEARTBEAT_MS` now has a real
reader.
Tests: silent socket is closed; exactly one watchdog is armed however many frames arrive; disarmed
once the socket is gone. (The spec harness now models timer handles/delays so `clearTimeoutFn`
actually clears.)

**[P1] Softphone `peerConfiguration` refuses the call on any credential change** — FIXED.
`lib/softphone/jssip-adapter.ts`: split the concerns. `webrtcSupported === false` and a changed
`sipUri` still throw (with distinct messages); a changed `password`/`authorizationUser` now updates
the UA at runtime (`ua.set(...)`) and re-`register()`s, then the call proceeds with the fresh ICE
servers. The adapter tracks its own current credentials rather than re-reading the immutable
`options.credentials`. `answer()`'s catch now emits `CALL_ENDED` with a reason before the 480, so a
declined incoming call is no longer invisible.
Tests: new `lib/softphone/jssip-adapter.spec.ts` (fake jssip via `mock.module`) — rotation
re-registers and answers; a changed account declines with 480 _and_ a `CALL_ENDED`; no rotation, no
re-register.

**[P2] `buildCallTree` dead cycle guard / legs lost in a parent cycle** — FIXED.
`lib/cdr/format.ts`: dropped the no-op `roots.filter(...)`; after the walk, any unvisited leg is
appended as an extra root. Existing "survives a cycle" test tightened to assert both legs are shown.

**[P2] No CSP / HSTS** — FIXED, report-only as the brief allows.
`next.config.mjs`: added `Strict-Transport-Security: max-age=63072000; includeSubDomains` and a
`Content-Security-Policy-Report-Only`. **Report-only on purpose**: two sources cannot be verified
from the codebase — the softphone's WSS listener is whatever `transport.wssUrl` the API reports per
deployment (`lib/softphone/credentials.ts`), and a recording `play-url` is a signed object-store URL
whose host belongs to the deployment's bucket. Both are widened to `wss:` / `https:` and the header
is documented with the narrowing step. `script-src` keeps `'unsafe-inline' 'unsafe-eval'` (Next's
inline bootstrap / dev), `style-src 'unsafe-inline'` for the brand `<style>`.

**[P2] Missing favicon** — FIXED in-area.
Added `apps/web/public/favicon.svg` and the run-stage `COPY … /work/apps/web/public ./apps/web/public`
in `apps/web/Dockerfile` (with a comment saying why `standalone` needs it). `app/layout.tsx` was not
touched — see Cross-area.

**[P2] Unencoded ids in request paths** — FIXED.
`lib/pbx/client.ts`: `encodeURIComponent(...)` on every id interpolated into a path (`id`,
`parentId`, `callFlowId`, `timeConditionId`, `pinSetId`, `entryId`, `boxId`, `messageId`,
`conferenceId`, `promptId`, `mohClassId`, `fileId`, `greetingId`) — 31 sites, matching the three
helpers that already did it. No double-encoding.

**[P2] `pbxListSearchParams` limit floor** — FIXED. `Math.min(MAX, Math.max(1, …))`, with a test.

## Skipped

Nothing was skipped, and no finding was found to be wrong.

## Additional fixes

- `lib/live/client.spec.ts`'s fake `clearTimeoutFn` was a no-op, so cleared timers stayed runnable —
  it now removes by handle. Latent, but it would have hidden a real timer leak.

## Cross-area needed

- `apps/web/app/layout.tsx:25` `icons: { icon: "/favicon.svg" }` is now valid (the file and the
  Dockerfile copy exist); no change required, reported only because the reference lives in `app/`.
- Optional, not required: if `apps/api/src/live` ever echoes a request `id` on `snapshot`, the
  fan-out could be narrowed server-side instead of by the client cache.

## Verification

- `bun test` (apps/web): **756 pass, 0 fail**, 2567 expect() calls, 32 files.
- `pnpm exec oxlint apps/web/lib apps/web/components`: exit 0, no diagnostics.
- `pnpm exec oxfmt apps/web/lib apps/web/components`: exit 0, 111 files.
- `pnpm --filter @optimiq-voice/web run typecheck`: 5 errors, **none in this area** — 4 in
  `app/(app)/settings/branding/page.tsx` (`deriveBrandRoles`, `resolvedTheme`, `scopedPreviewCss`
  undefined; that file is being edited concurrently and `lib/branding/theme.ts` still exports the
  symbols) and 1 in `packages/auth/src/session.ts:137` (`normalizeOrganizationId`). Both belong to
  other fix agents' areas.
