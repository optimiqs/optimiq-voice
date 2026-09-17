# FIX — AREA: web-app (`apps/web/app`)

## P1

- **`useCdrCall` omits the range from its key** — FIXED. `lib/query-keys.ts` `cdrCall` now takes a
  third `query` argument (granted exception); `app/(app)/_hooks/use-cdr-queries.ts` passes
  `{ from, to }`. Same `cdrCall` prefix, so invalidation still matches.
- **Sign-up discards `redirectTo`** — FIXED. `app/(auth)/sign-up/page.tsx` is now a server Suspense
  shell (copied from `sign-in/page.tsx`) and the form moved to `sign-up/sign-up-form.tsx`, which
  reads `safeRedirectTarget(searchParams.get("redirectTo"))` and honours it on both exits (session →
  `redirectTo`; no session → `/verify-email?email=…&redirectTo=…`). The footer "Sign in" link carries
  it too. `verify-email-panel.tsx` now resends with `callbackURL: redirectTo`. `proxy.ts` redirects an
  already-signed-in visitor to the validated `redirectTo` instead of the overview.
- **Invalidation inside a `setState` updater** — FIXED. `use-live-queries.ts`: `onUpdate` is a pure
  updater again; the `queue-agents` invalidation moved to a `useEffect` keyed on the committed
  `state` identity (`applyUpdate` returns `previous` unchanged when nothing landed), with a
  first-commit guard.
- **Registered-device count has no clock** — FIXED. `useLiveRegistrations` gains the same guarded
  tick its siblings use — 30s, skipped when there is nothing to expire — and `tick` replaces
  `Date.now()` and is in the memo deps.
- **Pickers/rosters capped at 100** — PARTIALLY FIXED (roster half, in-area). New `usePbxRoster` in
  `_hooks/use-pbx-queries.ts` pages through the whole list at `MAX_PAGE_LIMIT`, bounded by
  `MAX_ROSTER_PAGES = 20` and reporting `complete`. All six roster sites switched
  (`queue-agents-panel`, `shared-line-detail`, `paging-group-detail`, `wallboard-screen`,
  `operator-panel`, `queue-detail`), so a 150-extension tenant now labels every row and the wallboard
  lists every queue. The two "Not in the first N" cells say "Not found" when the roster is complete.
  The PICKER half (`ResourceSelect` debounced `search`) is **cross-area** — see below.

## P2

- **branding `dangerouslySetInnerHTML`** — FIXED structurally. `settings/branding/page.tsx` now calls
  `deriveBrandRoles` and applies the light/dark role map as CSS custom properties via `style` on the
  preview box (`useTheme().resolvedTheme` picks the map). Deletes `scopedPreviewCss`, both `.replace`
  regexes, the `<style>` element, the `data-brand-preview` hook and the lint suppression.
- **`LiveProvider` subscribes before `welcome`** — FIXED. `live-context.tsx` tracks an explicit
  `welcomed` flag set in `onWelcome`; `permitted` is now `welcomed && allowedTopicKinds.includes(...)`,
  which also stops a session allowed zero kinds being treated as allowed everything.
- **`useLiveTopic` mutates a ref during render** — FIXED. `useRef` + `useLayoutEffect` latest-ref.
- **`useRevokeApiKey` omits `organizationId`** — WRONG (finding), header CORRECTED. Evidence:
  `@better-auth/api-key@1.6.23` `dist/index.mjs:883-950` — `deleteApiKeyBodySchema` is
  `{ configId?, keyId }`; the handler loads the key by id, derives `referenceId` from the ROW and
  calls `checkOrgApiKeyPermission` on it. There is no organization parameter to pass. The module
  header's "every call" claim was the wrong thing, and now states the exception and why.
- **`directory-dialog` shadows `setTimeout`** — FIXED. Renamed to
  `timeoutDestination`/`setTimeoutDestination` at all six sites, with the sibling's comment.
- **Provisioning-URL copy** — FIXED. `.catch(() => toast.error("Could not copy. Select the URL and
copy it manually."))`, and the 2s revert timer is held in a ref and cleared on unmount.
- **`SoftphoneProvider` context value** — FIXED. Wrapped in `useMemo` over the reducer state, the
  resolved credentials, the query flags and the (already stable) callbacks.
- **Follow-me errors keyed by index** — WRONG. Evidence: `extension-dialog.tsx:409-416` passes
  `onChange={(next) => { setFollowMe(next); setLocalErrors({}); }}`, and `FollowMeField`'s `onMove`
  and `onRemove` both go through `setTargets` → `onChange` — so `localErrors` IS cleared on every
  reorder and removal. The only other source is `server.errors`, and the dialog's own comment at
  `:141-142` records that the server cannot key per rung (`pbxFieldErrors` collapses
  `followMe.targets.0.destination` to `followMe`). Nothing stays pinned to a moved position.

## Additional

- Sign-up's "Sign in" footer link now preserves `redirectTo` (previously bare `routes.signIn`).

## Cross-area needed

- `apps/web/components/pbx/resource-select.tsx`: thread a debounced `search` into both the query and
  `queryKeys.pbxList`, so rows past the first 100 are selectable. Fixes every `ResourceSelect` /
  `PromptSelect` call site at once. `pbxListSearchParams` already sends `search`.
- `apps/web/lib/query-keys.ts:210` — done under the granted exception (noted for the lib agent).
- No test added: every spec in this package lives under `apps/web/lib` (32 files, all `lib/**`), there
  is no React/hook test harness, and `lib/` is another agent's area. All fixes here are in `app/`
  components and hooks.

## Verification

- `pnpm --filter @optimiq-voice/web run test` → **756 pass, 0 fail** (32 files).
- `pnpm exec oxlint apps/web/app apps/web/proxy.ts` → **exit 0, no diagnostics** (this is what
  `pnpm run lint` runs; the branding suppression is gone and the file is clean).
- `pnpm exec oxfmt apps/web/app apps/web/proxy.ts` → 212 files, clean.
- `pnpm --filter @optimiq-voice/web run typecheck` → **1 error, outside my area, twice in a row**:
  `lib/permissions.spec.ts(51,53)` — `"voicemail.write.own"` is not in the permission union. That is
  the lib/packages agent mid-flight (a spec asserting a permission the shared union does not yet
  export). Zero errors in `apps/web/app` or `proxy.ts`. Reported rather than fixed, per the brief.
