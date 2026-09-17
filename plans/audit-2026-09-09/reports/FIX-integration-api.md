# FIX-integration-api

Integration pass over `apps/api` for the cross-area items the seven fix agents left inside it.

## 1. `logoObjectKey` on the branding update DTO — FIXED (partly WRONG as stated)

`src/auth/branding/branding.dto.ts`. Dropping the field outright would have removed the only way to
CLEAR a logo: there is no `DELETE /branding/logo` route (the controller has `POST logo` and
`GET logo` only), and `PATCH /api/v1/branding` was it. So the field is now `z.null().optional()` —
a string is refused, `null` still clears the override. Key minting stays server-side in
`BrandingLogoUploadService`; the read-side prefix guard in `branding-logo.controller.ts` is intact
and is now defence-in-depth, as api-pbx-1 wanted. Test in `test/auth/branding.test.ts`.

## 2. Global media response hardening — FIXED

`src/media/media-response.ts`. `x-content-type-options: nosniff` and
`content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` now ride on the
`base` header set, so all six routes through `openMediaResponse` get them (branding logo, voicemail
messages, fax, prompts/media library, call recordings, CDR exports) on 200, 206 and 416 alike. The
branding controller's `@Header` decorators now merely restate them; left in place, they are not
wrong. Content-disposition sanitising was already correct (`quotedFileName` strips `"` `\` `;` and
control chars) — **confirmed**, existing test covers it. New test in `test/storage/objectStore.test.ts`.

## 3. Voicemail consumer tenancy check — api-pbx-1 was WRONG, api-pbx-2 is right; test ADDED

`voicemail-consumer.service.ts:243-273` compares `envelope.subject` to `message.subject` (the
envelope carries its own subject field, so this is not a self-comparison), then splits the DELIVERY
subject for `subjectOrgId`, refuses `subjectOrgId !== envelope.orgId`, and calls
`file(subjectOrgId, …)` which scopes `withTenantScope` by the subject's token. That is already the
required behaviour. It had no test at all, so I added
`test/pbx/voicemailConsumerTenancy.test.ts` (3 cases: scope taken from the subject, orgId
disagreement terminated without opening a scope, foreign delivery subject terminated).

## 4. `assertMayStore` on tenant object writes — FIXED

- `src/pbx/prompts/prompts.service.ts` — `OrgLimitsService` injected; `assertMayStore` called after
  the multipart read and before `store.put`.
- `src/pbx/voicemail-boxes/voicemail-greetings.service.ts` — same.
- `src/pbx/org-limits/org-limits.ts` header note rewritten to match reality, and to name honestly
  what is still NOT metered: the NATS voicemail consumer and the CDR export worker, both of which
  have no `AppSession` to meter against (they are the platform storing bytes on a tenant's behalf,
  not a tenant uploading). Fax inbound is the same shape.
- Test: `test/pbx/uploadStorageQuota.test.ts` — both paths refuse over-quota and leave the store
  untouched (order, not just presence).

## 5. `sip_acl_entry.trunkId` cross-tenant reference — FIXED

`src/pbx/security/sip-acl.service.ts` now overrides `create`/`update` and proves the trunk inside
the writer's own `withTenantScope` before the write, throwing
`PbxEntityNotFoundFailure({kind:"trunk"}).toHttpException()` (404) otherwise. `undefined` (leave
alone) and `null` (clear) short-circuit. The DTO comment claiming "the FK makes the id real; RLS
keeps the ROW this tenant's" was misleading — an FK check runs as the system and sees every
tenant's trunks — and is corrected. Three tests in `test/pbx/sipAclEntries.test.ts` across two
tenants, including "writes nothing".

Note: the generic `scalarReferences` machinery in `pbx.repository.ts` is a DELETE guard (inbound
references), not an existence check, so there was no shared seam to route through; the fix follows
the existing `requireMohClass` convention instead.

## 6. SSO — FIXED (callback assertion was missing; DTO half was already done)

- `assertSsoProviderOrganization` was exported from `packages/auth` and called by **nothing**.
  Now called: `AuthPlatform` carries the boot `ssoProviders` snapshot
  (`src/auth/auth.platform.ts`), and `src/auth/auth-http.plugin.ts` intercepts
  `/api/auth/oauth2/callback/:providerId` on the way OUT — resolves the session from the
  `Set-Cookie` better-auth just wrote and asserts the tenant against the provider's owner. A
  mismatch drops the cookies on the floor and answers 403 `SSO_TENANT_MISMATCH`, so the browser
  never receives the session and there is nothing to revoke. This is the only place that has both
  the provider slug (URL) and the session (cookie).
- DTO: `emailDomain` required at create and non-nullable on update — already correct, **confirmed**.
- Service: added the missing half — `SsoService.update` refuses (422) any patch that would leave an
  `enabled` row with no email domain, reading the existing row first. Without it a legacy row could
  be flipped on and then silently dropped at the next boot by `loadSsoProviders`.
- The `SsoService` class header claimed "nothing reads `emailDomain`; treat the column as
  documentation of intent, not a control" — now false twice over; rewritten.
- Tests: `test/auth/sso.test.ts` (6). The service's 422 is not directly tested — it would need to
  stub `packages/db`'s module-level `readSsoProvider`, which is not this suite's style.

## 7. CDR export root — FIXED (derived, the option infra pinned)

`compose.voice.yaml:84` pins `CDR_EXPORT_ROOT: /var/lib/optimiq/objects/exports` and
`CDR_RECORDING_ROOT: /var/lib/optimiq/objects` — i.e. exactly `<recording root>/exports`. So the
consistent option is derivation, not a boot-time writability probe. `src/cdr/shared/cdr-env.ts`
gains `withRecordingRootFallback`, the same overlay-before-parse shape `pbx-env.ts` uses for its
media roots (empty string counts as unset), and the literal default moved from
`/opt/optimiq-voice/exports` to `/opt/optimiq-voice/recordings/exports` so the un-pinned case also
lands under a root the image creates. A deployment that sets only `CDR_RECORDING_ROOT` now inherits
the writable volume instead of hitting EACCES on the first export somebody clicks.

## 8. Also from Cross-area, inside apps/api

- `src/provisioning/provisioning-env.ts` (FIX-infra #2) — both refinement messages now name the
  operator-facing variables (`PROVISION_SIP_WSS_URL is required when PROVISION_WEBRTC_ENABLED is
set`, `PROVISION_TURN_URLS and PROVISION_TURN_SECRET must be configured together`).
  `test/provisioning/softphone.test.ts:134` asserted the old wording; updated.
- FIX-pkg-data's four `apps/api` items (auth.platform imports, `organizationId`/`emailDomain` on the
  mapped config, `toView` no longer reading `clientSecret`, the null-domain filter) — **already
  landed** by api-core. Verified by reading; nothing to do.
- FIX-pkg-domain #1 (routing `explain` flag) — deliberately NOT actioned: it is a
  `packages/routing` change first, and landing only the `apps/api` half is meaningless.
- FIX-api-pbx-2 #6 (`apps/web` permission gates) — out of area.

## Verification (exact final counts)

Root `.env` was already present; nothing copied.

- `pnpm --filter @optimiq-voice/api run typecheck` → **PASS**, 0 errors (both `tsconfig.json` and
  `tsconfig.strict.json`).
- `pnpm --filter @optimiq-voice/api run test` → **1213 passing, 0 failing, 0 pending**. (Baseline at
  the start of this pass was 1196 passing / 1 failing — that failure was the softphone message
  assertion above, which I caused and fixed; api-core's emergency-addresses failure had already been
  resolved by another agent. +17 tests: 3 voicemail consumer, 3 sip-acl trunk, 2 upload quota,
  6 SSO, 1 branding DTO, 1 media headers, plus the existing suites' unchanged counts.)
- `pnpm exec oxlint apps/api` → **0 diagnostics**, exit 0.
- `pnpm exec oxfmt --check apps/api` → **490 files, all correctly formatted**.

## Cross-area still needed (not mine)

1. `packages/db` — composite unique index on `organization_sso_provider (organization_id,
provider_id)`; the global one still means the first tenant to claim `okta` owns the slug
   deployment-wide, and `SsoService.create`'s 409 is a description of that, not a fix.
2. `packages/auth` — the callback assertion in `auth-http.plugin.ts` is a mount-level interception
   because there is no hook that sees both the provider slug and the resolved session. If
   `createAuth` grew a `genericOAuth` sign-in hook carrying the provider id, the check belongs there
   and this interception should be deleted.
3. `packages/routing` — `explain?: boolean` on the three `Resolve*Input` types (FIX-pkg-domain #1);
   `routing.service.ts:196` then passes `explain: true`. Both halves must land together.
4. Repo-wide `pnpm run format` once every agent has landed (FIX-infra #3).
