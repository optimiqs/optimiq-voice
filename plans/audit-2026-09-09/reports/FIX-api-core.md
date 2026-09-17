# FIX report — AREA: api-core

## P0

### [P0] Unmatched WebSocket upgrade never destroyed — FIXED

- New `src/core/http/upgrade-router.ts`: `attachUpgradeHandler(server, claim)` installs exactly ONE
  `'upgrade'` listener per server (WeakMap-keyed claim list), offers each handshake to the claims in
  order, and `socket.destroy()`s what nobody claims. A rejecting claim also destroys.
- `LiveGateway.handleUpgrade` / `SessionGateway.handleUpgrade` now return `Promise<boolean>`
  (`false` = not our path, socket untouched). Both bootstraps register through the router; the two
  incorrect "Node destroys an upgrade nothing answered" comments are gone and replaced with the
  real rule. Both gateways keep their existing origin/session/permission flow unchanged.
- Test: `test/core/upgradeRouter.test.ts` (5 cases: destroys unclaimed, leaves claimed, falls
  through to the next claim, one listener for N gateways, destroys on a rejecting claim).

### [P0] Provisioning rate limit bypassed by every invalid-secret request — FIXED

- `provision.service.ts`: `limiter.consume(parsed.reference)` moved from step 5 to step 3 —
  immediately after the reference resolves, **before** `verifySecret`. Steps renumbered, and the
  class header now states the real trade (a reference-holder can burn a device's 60 s budget; that
  is cheaper than an unauthenticated unbounded write).
- Additional problem the audit did not name: the limiter refusal itself called `reject()`, which
  publishes `device.rejected` **and** writes a `sip_auth_event` row — on _every_ over-limit request.
  Moving the limiter earlier would have turned it into the unbounded write it exists to prevent. So
  `RateLimitVerdict` gained `firstRefusal`, and only the request that crosses the limit is logged,
  published and filed. One audit row per reference per minute, not per request.
- Test: `test/provisioning/provisioningToken.test.ts` — `firstRefusal` transition + window reset.

## P1

### [P1] IP allowlist silently skipped when the source IP cannot be parsed — FIXED

- `AllowlistVerdict` gained `evaluable: boolean`. `checkAllowlist` no longer collapses
  "unevaluable" into "no entries": on `isIP() === 0` it now runs a new tenant-scoped
  `hasAllowlistEntries()` count and returns `{ hasEntries: <truthful>, evaluable: false,
allowed: false }`, so an organization with a strict allowlist is refused rather than allowed.
  The refusal detail names the unevaluable address.

### [P1] Both gateways re-authenticate every connection every 25 s — FIXED

- New `LIVE_REVALIDATE_MS` / `SESSION_REVALIDATE_MS` (5 min) in the two protocol files, with the
  reasoning (session expiry is enforced by the session record; this is a revocation-latency knob).
- Both connections carry `lastRevalidatedAt`; the sweep still pings every 25 s but only calls
  `revalidate` once the interval has elapsed. 12× fewer auth-pool queries; ping/reap unchanged.
- Did NOT add the cross-gateway `session.token` cache — a shared TTL cache between two gateways is
  a new abstraction for a load the cadence change already removes an order of magnitude of.

### [P1] Fastify HTTP logger reads a `LOGS_LEVEL` nothing sets — FIXED

- `log-redaction.ts` reads `LOG_LEVEL ?? API_LOGS_LEVEL ?? LOGS_LEVEL ?? "info"`. Both false
  comments corrected (in `log-redaction.ts` and in `main.ts`). `LOG_LEVEL=silent` from the test
  script is now honoured.

### [P1] Per-organization SSO is a process-global namespace — FIXED (in-area part)

- `SsoService.create` catches the `23505` unique violation (walking `cause`) and answers **409**
  naming the conflict instead of a 500.
- Class header now states both limits honestly: `providerId` is platform-wide, and
  `/api/auth/sign-in/oauth2` is not org-scoped.
- While I was in the file the `packages/db` / `packages/auth` agents landed the tenant-binding half
  (`SsoProviderRow` lost `clientSecret`; `listEnabledSsoProviders` → `listEnabledSsoProvidersWithSecrets`;
  `SsoProviderConfig` now requires `organizationId` + `emailDomain`). I adapted apps/api to it:
  `auth.platform.ts` reads the secret-bearing list, passes `organizationId`/`emailDomain`, and
  **drops with a warning** any row whose `emailDomain` is empty — `createAuth` throws on one, and a
  single legacy row must not stop the auth slice booting. `sso.dto.ts` now makes `emailDomain`
  required on create and non-nullable on update. `toView`'s `hasClientSecret` is `true` (the
  projection no longer carries the secret at all).

### [P1] Boot failure sets an exit code but never exits — FIXED

- `main.ts` keeps a module-level `started` set right after `NestFactory.create`; the catch closes
  it (logging a close failure) and then `process.exit(1)`.

### [P1] `x-api-key` sessions ignore expiry and organization suspension — FIXED

- `auth-http.plugin.ts` rejects a key whose `result.key.expiresAt` is in the past, rather than
  trusting `verifyApiKey`. Test in `test/auth/apiKeySession.test.ts`.
- New `src/auth/organization-suspension.service.ts`: `readHierarchy(...).suspendedAt` behind a 15 s
  TTL cache with a sweep-on-write bound (4096 entries) and a `forget()` seam. Registered in
  `AuthModule`; `RequirePermissionsGuard` consults it for **every** principal after the tenant is
  resolved and before any permission is granted, throwing the new `OrganizationSuspendedException`
  (403). Test in `test/auth/requirePermissionsGuard.test.ts`.

## P2

- **strict tsconfig** — FIXED. Added `src/provisioning`, `src/session`, `test/provisioning`,
  `test/session`. The two `as string` casts are gone _properly_: `isRenderConfigured` is now a type
  predicate returning `env is ConfiguredProvisioningEnv`, the service narrows into a local and
  passes the narrowed env into `buildContext`. No `!`, no `as`.
- **`LiveConnection.alive` + topic-cap double count** — FIXED. `alive` deleted (field, both writes,
  the type). Both caps now count only what the connection holds (`topics.size` /
  `applications.size`), so a reconnecting client re-sending its full set is no longer refused
  topics it already has. Test in `test/session/sessionGateway.test.ts`.
- **mail subject control characters** — FIXED. `subject` and `bodyIntro` now carry
  `/^[^\p{Cc}\p{Cf}]+$/u`. Used a control-character class rather than the audit's suggested
  `[^\r\n -]+` (which would also have rejected spaces). Test: `test/mail/mailTemplateDto.test.ts`.
- **`content-disposition` filename quoting** — FIXED. New `quotedFileName` replaces `"`, `\`, `;`
  and control characters. Test in `test/storage/objectStore.test.ts`.
- **`MirroredObjectStore.archiveObject` content type** — FIXED. New
  `src/storage/object-content-type.ts` (`objectContentType`), exported from `src/storage`; used by
  `archiveObject` (`local.contentType ?? objectContentType(key)`) and by
  `cdr/recordings/recordings.service.ts`, whose private duplicate of the map was deleted.
- **`CdrService.get` `Number.isNaN` fallback** — FIXED. Removed; the DTO already guarantees a
  parseable ISO datetime, so a bad value is a 400 rather than a silent widening to a range scan.
- **`CdrExportWorker` double-counted failures** — PARTLY FIXED, PARTLY WRONG (see below). Removed
  `this.failed += 1` from `runOne`'s catch (`fail()` already counts, so `stats.failed` now means
  "abandoned"). Message now says `MAX_ATTEMPTS` rather than `job.attempts`.
- **`resolveRoleIn`'s dead `findMembership` branch** — SKIPPED. The fix the audit proposes
  (a `session.principal` marker, or stopping the guard mutating the session) changes the `AppSession`
  shape in `packages/auth`, which is off limits, and there is no security regression today.

## WRONG

- **[P2] `CdrExportWorker`'s `MAX_ATTEMPTS` is off by one.** It is not. `claimNextExportJob` does
  `attempts = attempts + 1` inside the claim, so claim _n_ returns `attempts === n`. With
  `> MAX_ATTEMPTS` (3), claims 1–3 do real work and claim 4 abandons — exactly three attempts. The
  audit's "abandons on the fifth claim" does not follow. I briefly changed it to `>=` (which would
  have cut it to two attempts), then reverted and left a comment recording the arithmetic.

## Additional fixes (noticed while in the files)

- The provisioning rate limiter's audit write / event publish were themselves unbounded (above).
- Three `RequirePermissionsGuard` constructions in tests needed the third argument
  (`test/auth/requirePermissionsGuard.test.ts`, `test/pbx/sipAclEntries.test.ts`,
  `test/pbx/auditLogQuery.test.ts` — the last two are in another area, touched only because my
  constructor change broke their compile; each got a 3-line `notSuspended()` stub).
- `test/provisioning/sharedLineDerivation.test.ts` updated for `buildContext`'s new env parameter.

## Cross-area needed

- `packages/db` — the SSO schema half of the P1: `organization_sso_provider.provider_id` needs a
  **composite** unique index `(organization_id, provider_id)` instead of the global one, so a
  tenant can register `okta` when another already has. Until then the 409 is the honest answer, not
  a fix. (The `organizationId`/`emailDomain` plumbing and the callback-time tenant check appear to
  have landed already while I worked.)
- `packages/auth` — for the `resolveRoleIn` P2: an explicit principal marker on `AppSession`
  (`principal: "api-key" | "user"`) so the guard's `activeOrganizationRole` stamp stops being
  overloaded as one.
- `ResellerService.setSuspended` could call `OrganizationSuspensionService.forget(childId)` to make
  a suspension take effect instantly rather than within 15 s. Left out because `ResellerService` is
  in my area but the coupling is only worth adding if the latency is judged too long.

## Verification

Run from a clean root `.env` (already present — nothing copied).

- `pnpm --filter @optimiq-voice/api run typecheck` → **PASS**, 0 errors (both `tsconfig.json` and
  `tsconfig.strict.json`, the latter now including `src/provisioning` and `src/session`).
- `pnpm --filter @optimiq-voice/api run test` → **1196 passing, 1 failing**. The single failure is
  `emergency consumer binding › the tenancy cross-check` in `src/pbx/emergency-addresses`, a file I
  never touched and another agent is editing concurrently. (Earlier in the session the same run had
  5 then 2 failures, all in `src/pbx` — branding-logo, fax, permission-enforcement — which
  disappeared as the pbx agents landed their work.)
- `pnpm exec oxlint <my dirs> apps/api/test` → **clean, 0 diagnostics**.
- `pnpm exec oxfmt apps/api/src apps/api/test` → 460 files, no changes needed.
