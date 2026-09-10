# FIX — AREA `pkg-data`

## Per finding

### [P0] Tenant SSO providers registered platform-wide — FIXED (packages side)

- `packages/auth/src/auth.ts`: `account.accountLinking.enabled: false` (a generic-OAuth identity can
  never attach to a pre-existing local user); `SsoProviderConfig` gains **required** `organizationId`
  and `emailDomain`; `buildGenericOAuthConfig` throws `SsoProviderConfigError` at boot for a row with
  no domain and installs a per-provider `mapProfileToUser` that rejects any asserted email outside
  that domain (runs before better-auth's user lookup, so the link never happens); new exported
  `resolveSsoProviderOrganizationId` / `assertSsoProviderOrganization` / `emailMatchesDomain`.
- `packages/db/src/platform-sso.ts`: `organizationId` and `emailDomain` were already selected, so the
  boot feed now carries them through.
- Specs: 6 new cases in `auth.spec.ts` (domain rejection incl. subdomain, boot refusal, linking off,
  org assertion both directions).

### [P1] Migrations inherit request-shaped timeouts — FIXED

`packages/{db,pbx-db,cdr-db}/scripts/migrate.ts` pass `statementTimeoutMs: 0` and
`idleInTransactionSessionTimeoutMs: 0`. New `client.spec.ts` case pins that 0 survives the `??`
defaulting. All three migrators re-run clean against a live Postgres.

### [P1] Integration specs never run in CI — SKIPPED (cross-area)

`.github/workflows/ci.yaml` is off limits. I ran both suites locally instead (see Verification) and
they found two real defects, listed below.

### [P1] SSO client secrets in the shared read projection — FIXED

`packages/db/src/platform-sso.ts`: `SsoProviderRow` no longer carries `clientSecret`; `COLUMNS` (used
by `listSsoProviders`, `readSsoProvider` and both `.returning()`) drops it. New `SsoProviderSecretRow`

- `listEnabledSsoProvidersWithSecrets` (renamed from `listEnabledSsoProviders`) is the only accessor
  that returns it — the platform bootstrap. Encryption at rest **not** done: it needs a key-management
  decision and a backfill of existing rows; flagged below.

### [P1] Preflight cannot detect an org-scoped table missing from the plan — FIXED

`packages/db/src/rls-preflight.ts`: the catalogue query no longer filters by the plan. It now selects
every ordinary/partitioned, non-partition table in the schema that has a live `organization_id`
column, or is named in the plan. Partitions are excluded by `relispartition` (the cdr plan's stated
intent). New optional `TenantRlsPreflightPlan.unscopedTables` is the explicit, reviewable exemption
list. Verified live: adding a stray `decoy(organization_id)` table to the pbx database turns the
preflight red with `decoy: table was introspected but is not part of the preflight plan`.

### [P1] Foreign keys are not tenant-composite — FIXED for the cascade references; the `set null` ones are BLOCKED

Converted 8 keys across 6 parents to `(organization_id, <child>) → (organization_id, id)` with a new
`tenantCompositeForeignKey` helper in `packages/pbx-db/src/tenant.ts`, and added
`<table>_organization_id_key` unique indexes on `device_profile`, `extension`, `shared_line`,
`paging_group`, `pin_set`, `trunk`. Migration `20260909055546_pbx_tenant_composite_foreign_keys`
(drizzle-kit generated, additive, applies clean).

Not converted, with evidence: `device.device_profile_id`, `device_line.extension_id`,
`voicemail_box.extension_id`, `queue_agent.extension_id`, `outbound_route.pin_set_id` are
`ON DELETE SET NULL`. A composite FK's `SET NULL` nulls **every** referencing column, including
`organization_id`, which is `NOT NULL` — the delete would then fail. PostgreSQL 15's
`ON DELETE SET NULL (column_list)` is the fix but drizzle-kit cannot express it, so a hand-written
constraint would drift from the snapshot on the next `generate`. Left as-is; see Cross-area.

### [P1] better-auth rate limiting in per-process memory — FIXED

`packages/auth/src/auth.ts`: new `buildRateLimitOptions` — `storage: "database"` by default (new
`rateLimitStorage` option for a host that later supplies `secondaryStorage`), plus tighter
`customRules` for `/sign-in/email` (10/60s) and the three `/two-factor/verify-*` paths and
`/forget-password` (5/60s). better-auth's `database` storage needs a `rateLimit` model, which did not
exist: added `rate_limit` (`id`, `key` unique, `count`, `last_request` bigint + index) to
`packages/db/src/schema/auth/credential-schema.ts`, into `authSchema` and the `@optimiq-voice/auth`
re-exports, with migration `20260909055409_auth_rate_limit`. `auth-schema.spec.ts` updated.

### [P2] `listChildOrganizations` counts members in JS — FIXED

`packages/db/src/platform-hierarchy.ts`: `count()` + `groupBy`. Dropped the now-unused `and` import.

### [P2] `cdr_export_job.object_key` is tenant-writable — FIXED

Added `cdr_export_job_object_key_check` pinning `exports/<organization_id>/<id>.csv`
(`packages/cdr-db/src/schema/export-schema.ts`, migration `20260909055607_cdr_export_object_key_check`).
Note the API already derives the key (`apps/api/src/cdr/exports/export-token.ts:exportObjectKey`), so
this is defence in depth rather than a live hole.

### [P2] `toCallTokenClaims` accepts legacy `accessKeyId` — FIXED

`packages/auth/src/call-token-verifier.ts`: both fallbacks and the `access[]` parsing removed.
Checked the minter first — `apps/api/src/auth/call-token.claims.ts` still emits `accessKeyId` and
`access[]`, but always alongside `organizationId`, so nothing that is minted today stops verifying.

### [P2] `isImpersonatedSession` reuses the org-id normalizer — FIXED

`packages/auth/src/session.ts`: helper renamed to `normalizeNonEmpty` and used in both places.

### [P2] `BASE_TENANT_RLS_PLAN` names a non-existent role — FIXED (differently)

The value cannot simply be dropped (`roleName` is required and the plan short-circuits while empty),
so the real failure mode was fixed instead: `has_schema_privilege` / `has_table_privilege` are now
guarded by `exists(select 1 from pg_roles …)`, so a missing role produces "lacks USAGE / lacks
required privileges" rather than an `undefined_object` driver error. The plan comment now says the
name is a placeholder and must be replaced when the first table lands.

### [P2] `hasChildren` redundant `isNotNull` — FIXED

## Additional fixes (found while working)

1. **`cdr_write_quarantine` was invisible to the gate.** With the preflight fixed it surfaced as an
   org-scoped table in neither list. It is deliberately unscoped (nullable `organization_id`, no
   tenant grants) — declared in the new `unscopedTables` and its stale header comment ("the preflight
   introspects the plan's tables by name, so an unlisted table is not a preflight failure") corrected.
2. **`cdr-tenant-rls.integration.spec.ts` asserted the wrong table set** — it expected 3 introspected
   tables while the plan has had 4 since `cdr_export_job` landed. It never ran, so it never failed.
   Corrected rather than deleted.
3. `pbx-db/src/schema/schema.spec.ts`: the paging/shared-line FK assertions read `columns[0]` and now
   assert the full composite shape; added a schema-wide invariant that every multi-column FK leads
   with `organization_id`, lands on `(organization_id, id)`, and that the parent carries the matching
   unique index.

## Cross-area needed

**`apps/api` (api-core agent) — required, the build fails without it:**

- `src/auth/auth.platform.ts:10` — import `listEnabledSsoProvidersWithSecrets` (not
  `listEnabledSsoProviders`) and `SsoProviderSecretRow` (not `SsoProviderRow`).
- `src/auth/auth.platform.ts:113` — the mapped `SsoProviderConfig` must now include
  `organizationId: row.organizationId` and `emailDomain: row.emailDomain`. A row with a null/blank
  `emailDomain` now throws `SsoProviderConfigError` at boot: either filter those rows out with a
  loud log, or (better) make `email_domain` required before a row may be `enabled` in
  `src/auth/sso/sso.service.ts`.
- `src/auth/sso/sso.service.ts:61` — `toView` must stop reading `row.clientSecret`; it is no longer
  on `SsoProviderRow` (the view was stripping it anyway).
- Sign-in/callback: call the exported `assertSsoProviderOrganization({ providers, providerId,
organizationId })` after the session resolves, so a session that landed in another tenant than the
  provider's owner is rejected. Pairs with your duplicate-`providerId` 409.
- Rate limiting now writes to the `rate_limit` table — no API code change, but the base migration
  must run before the new auth build boots.

**`.github/workflows/ci.yaml`:** add a `postgres:17` service job running `db:migrate:test` for the
three packages then `pnpm --filter @optimiq-voice/pbx-db --filter @optimiq-voice/cdr-db run
test:integration`. Both defects above were only visible there.

**`apps/web`:** `lib/permissions.generated.ts` is stale after `voicemail.write.own`; `pnpm --filter
@optimiq-voice/web run codegen` (the user said they will run it). Its `lib/permissions.spec.ts:51`
fails until then. I reverted the copy turbo's `web:build` regenerated so nothing outside my area is
left modified.

**Deferred, not done:** encrypting `organization_sso_provider.client_secret` at rest (key management

- backfill), and `ON DELETE SET NULL (column)` composite FKs for the five nullable references above.

## Extra task

`voicemail.write.own` added to `packages/auth/src/permissions.ts`: the `PERMISSIONS` list (after
`voicemail.write`), the `voicemail` catalog group ("Manage own mailbox"), and
`SELF_SERVICE_PERMISSIONS` — so it flows to `user`, `agent`, `manager`, `admin`, `owner`. The
registry's own invariants (three segments must have a flat parent; every `user`-role permission must
be `own`-scoped or read/monitor) pass unchanged. Web codegen NOT run.

## Verification

- `pnpm exec oxlint packages/{db,pbx-db,cdr-db,auth}` → exit 0. `oxfmt` → clean, 134 files.
- Unit: `@optimiq-voice/db` 96 pass / 0 fail; `pbx-db` 108 pass / 14 skip / 0 fail; `cdr-db` 73 pass /
  35 skip / 0 fail; `auth` 230 pass / 0 fail. Typecheck clean in all four.
- `pnpm exec turbo run build typecheck --filter=...` → 16/18 typecheck tasks pass. The two failures
  are the cross-area items above: `@optimiq-voice/api` (4 errors, listed) and `@optimiq-voice/web`
  (1 error, stale generated permissions).
- **Live Postgres was reachable** (local server on 5432, not the compose stack). Created three
  throwaway databases, ran all three `db:migrate:test` (clean, including the three new migrations),
  then: `pbx-db test:integration` 120 pass / 0 fail; `cdr-db test:integration` 100 pass / 0 fail
  (after the two fixes above); `tenant-rls-preflight` `ok:true` for both plans (pbx 55/55, cdr 4/4)
  and `ok:false` with the correct message for an injected unplanned tenant table. Databases dropped.
