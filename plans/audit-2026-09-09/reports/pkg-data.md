# Audit — AREA `pkg-data`

Scope: `packages/db`, `packages/pbx-db`, `packages/cdr-db`, `packages/auth` (schemas, drizzle migrations,
RLS, repositories, specs, package.json). Branch `feat/optimiq-pbx-phase0`.

## What I verified and found CLEAN (so it is not re-audited)

- **Schema vs migration drift.** All 30 pbx / 7 cdr / 5 base migration directories have a `migration.sql`
  (`wc -l` reports 0 for single-line files with no trailing newline — those are NOT empty; I diffed the
  snapshots and each empty-looking one has real DDL: `phone_number_e164_global_key`,
  `extension.pickup_group`). The migration format is the new drizzle-kit per-directory layout
  (`migration.sql` + `snapshot.json`, no `meta/_journal.json`), which is what `drizzle-orm@1.0.0-rc.4`'s
  `migrator.js:8-12` expects. Cross-checking every column-name literal in `pbx-db/src/schema/*-schema.ts`
  against the latest snapshot's `ddl` found no source column missing from the snapshot, and the hand-written
  expression index/check in `20260908000024_pbx_sip_realm_ownership` matches
  `settings-schema.ts:79-90` exactly (so the next `drizzle-kit generate` will not try to drop it).
- **RLS policy completeness.** All 55 tables in the pbx snapshot carry policies; `PBX_TENANT_RLS_PLAN` is
  derived from `pbxTables` rather than hand-maintained; the introspector asserts policy _name, permissive,
  cmd, roles and predicate text_ per mode. `FORCE ROW LEVEL SECURITY` is asserted **in both directions**
  (`rls-preflight.ts:170-175`), which is right given the owner runs migrations, the partition functions and
  CDR enrichment. Grants are covered by `pbx-db/src/tenant-grants.spec.ts`, which correctly replays
  drop-then-regrant history for `user_setting`.
- **uuid v7 / timestamps.** `uuidV7PrimaryKey` is app-side v7 everywhere including better-auth
  (`auth.ts:327 advanced.database.generateId`); every timestamp is `timestamptz` and the session sets
  `TimeZone: UTC` (`db/src/client.ts:99`).
- **Invariants.** Global DID uniqueness (`phone_number_e164_global_key`), extension number per org,
  global SIP realm uniqueness (partial expression unique index), device provisioning-token-hash global
  uniqueness, `(organization_id, scope, network)` for ACLs — all present with correct reasoning.
- **Index coverage** for the API/engine read paths is unusually complete (keyset `(org, occurred_at, id)`
  on both ledgers, partial indexes for outbox/queue/recording/export worklists, partition-prunable
  `(org, queue_ref, started_at desc)`).
- `admin()` plugin privilege escalation via sign-up is NOT possible: better-auth marks `user.role`
  `input: false` (`plugins/admin/schema.mjs`).

---

### [P0] Tenant-configured SSO providers are registered platform-wide with no tenant or email-domain binding (confidence: medium)

- Where: `packages/db/src/platform-sso.ts:79-87`, `packages/auth/src/auth.ts:411-413`,
  consumed by `apps/api/src/auth/auth.platform.ts:105`
- Code:
  ```ts
  /** Every enabled provider across all organizations — what the auth boot feeds to `genericOAuth`. */
  export async function listEnabledSsoProviders(
  	db: AdminDatabase,
  ): Promise<readonly SsoProviderRow[]> {
  	return await db
  		.select(COLUMNS)
  		.from(organizationSsoProvider)
  		.where(eq(organizationSsoProvider.enabled, true));
  }
  ```
  ```ts
  ...(options.ssoProviders && options.ssoProviders.length > 0
      ? [genericOAuth({ config: buildGenericOAuthConfig(options.ssoProviders) })] : []),
  ```
- Problem: an SSO provider row is created per organization through the tenant CRUD surface, but the boot
  feed flattens **every** enabled row into one global `genericOAuth` config. The row's
  `organization_id` and `email_domain` (`organization-platform-schema.ts:145,155`) are never carried into
  the config or checked at callback time. better-auth then links the OAuth identity to an existing local
  user whenever the IdP asserts a verified email — `generic-oauth/routes.mjs:94`:
  `if (!c.context.trustedProviders.includes(provider.id) && !userInfo.emailVerified || …) throw UNAUTHORIZED`
  — i.e. `email_verified: true` from the IdP is sufficient. `activeOrganizationId` is then resolved from
  the _victim's_ membership by `createSessionOrganizationHook`, not from the provider's tenant.
- Failure scenario: tenant A's admin registers an IdP they control (any org admin holding the SSO write
  permission can). They initiate `/api/auth/sign-in/oauth2` with `providerId=<A's slug>`, their IdP returns
  `{ email: "cfo@tenantB.example", email_verified: true }`. better-auth links the account to tenant B's
  user and issues a session scoped to tenant B. Full cross-tenant account takeover from a self-service
  configuration screen.
- Fix (minimal, layered):
  1. Set `account.accountLinking.enabled: false` (or `trustedProviders: []` plus
     `allowDifferentEmails: false`) in `createAuth` so a generic-OAuth identity can never attach to a
     pre-existing local user.
  2. Enforce the domain the provider row already stores: reject the callback when the asserted email's
     domain is not the provider's `email_domain`, and require `email_domain` to be non-null and
     platform-verified before a row may be `enabled`.
  3. After sign-in, assert the resolved membership's organization equals the provider's
     `organization_id` (pass it through `SsoProviderConfig`).
- Cross-area: `apps/api/src/auth/auth.platform.ts` and `apps/api/src/auth/sso/sso.service.ts` (who may
  enable a provider); the `SsoProviderConfig` shape is exported from this package.

### [P1] Every migration runs under a 15 s `statement_timeout` and a 30 s idle-in-transaction timeout (confidence: high)

- Where: `packages/db/src/client.ts:86-99` + `packages/db/scripts/migrate.ts:60-66`
  (identically `packages/pbx-db/scripts/migrate.ts`, `packages/cdr-db/scripts/migrate.ts`)
- Code:
  ```ts
  statement_timeout: guardrails.statementTimeoutMs,            // default 15_000
  idle_in_transaction_session_timeout: guardrails.idleInTransactionSessionTimeoutMs, // 30_000
  ```
  ```ts
  const client = createPostgresClient({
  	url,
  	applicationName: "optimiq-voice-migrator",
  	poolMaxConnectionsOverride: 1,
  });
  ```
  The migrator only overrides the pool size; the runtime guardrails come along with it.
- Problem: `postgres.js` sends `connection` entries as startup parameters, so the migration session
  inherits the _request-shaped_ timeouts. DDL is not request-shaped.
- Failure scenario / cost: the first `CREATE UNIQUE INDEX` / `ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT`
  / backfill (`20260811182840_pbx_voicemail_transcription_backfill`) on a production-sized table that takes
  > 15 s is aborted with `57014`. Drizzle runs each migration in a transaction, so the deploy fails
  > mid-release and the migration must be re-driven by hand. It has not bitten yet only because no table is
  > large yet.
- Fix: in the three `scripts/migrate.ts`, pass `statementTimeoutMs: 0` and
  `idleInTransactionSessionTimeoutMs: 0` alongside `poolMaxConnectionsOverride: 1` (0 disables in
  PostgreSQL), or give `createPostgresClient` a `migration: true` preset that does so.
- Cross-area: none.

### [P1] The tenant-isolation and partitioning integration specs never run in CI (confidence: high)

- Where: `packages/pbx-db/package.json:38`, `packages/cdr-db/package.json:40`, `.github/workflows/ci.yaml:83`
- Code: `"test:integration": "RUN_DB_INTEGRATION_TESTS=true bun test src --max-concurrency 1"` — and CI runs
  only `pnpm exec turbo run test`. A repo-wide grep finds `RUN_DB_INTEGRATION_TESTS` in exactly those two
  `package.json` files and nowhere else.
- Problem: `pbx-tenant-rls.integration.spec.ts`, `cdr-tenant-rls.integration.spec.ts` and
  `cdr-partitioning.integration.spec.ts` are `describe.skipIf(!enabled)`, so they silently no-op. These are
  the _only_ tests that prove the properties they assert — the file header says so: "Proves tenant isolation
  against a live PostgreSQL, which is the only place it can be proven". The same is true of the partition
  functions and role grants, which `call-leg-schema.ts:60-66` explicitly says are pinned by these specs
  "instead of by the snapshot".
- Failure scenario / cost: a missing policy, a widened grant or a dropped partition function ships green.
  The boot preflight would catch the policy/grant classes at deploy time, but nothing catches the partition
  functions or the append-only privilege revocations before production.
- Fix: add a CI job with a `postgres:17` service that runs `db:migrate:test` for the three packages and then
  `pnpm --filter @optimiq-voice/pbx-db --filter @optimiq-voice/cdr-db run test:integration`.
- Cross-area: `.github/workflows/ci.yaml`.

### [P1] SSO client secrets are stored and returned in plaintext (confidence: high)

- Where: `packages/db/src/schema/platform/organization-platform-schema.ts:152`,
  `packages/db/src/platform-sso.ts:37-49`
- Code: `clientSecret: text("client_secret").notNull(),` and `clientSecret: organizationSsoProvider.clientSecret`
  is part of the shared `COLUMNS` projection every read (`listSsoProviders`, `readSsoProvider`,
  `listEnabledSsoProviders`, and both `.returning(COLUMNS)` mutations) selects.
- Problem: the schema comment says the secret "is stripped from every API read", but the _repository_ always
  returns it, so the stripping is a convention enforced somewhere else entirely. At rest the column is
  plaintext next to a table that any DB-level read (backup, replica, `adminDb` misuse) exposes. Contrast
  `device.provisioning_token_hash` and `pin_set_entry`, which both digest their secrets.
- Failure scenario / cost: one careless controller (or one `SELECT *` in an ops query) leaks every tenant's
  IdP client secret; a leaked secret plus the public `providerId` slug is enough to impersonate the platform
  to the IdP.
- Fix: encrypt at rest with the auth secret (better-auth already does this for `jwks.private_key`) and split
  the projection: a `SSO_PUBLIC_COLUMNS` used by `listSsoProviders`/`readSsoProvider`, with the secret only in
  the boot-feed `listEnabledSsoProviders` and the create/update paths.
- Cross-area: `apps/api/src/auth/sso/sso.service.ts` consumes `SsoProviderRow`.

### [P1] The preflight cannot detect an org-scoped table that is missing from the plan (confidence: high)

- Where: `packages/db/src/rls-preflight.ts:182-186` vs `:303-304`
- Code:
  ```ts
  for (const table of introspected.keys()) {
  	if (!expected.has(table))
  		errors.push(`${table}: table was introspected but is not part of the preflight plan`);
  }
  ```
  but the catalogue query is `where namespace.nspname = ${schemaName} and class.relname in ${client(tableNames)}`,
  and `tableNames` is built _from the plan_.
- Problem: the introspector can only ever return plan tables, so this branch is unreachable dead code. Two
  headers state the opposite guarantee as fact — `pbx-db/src/schema/tables.ts:41-42` ("the single list the RLS
  preflight plan is derived from, so a table added here without a policy fails preflight") and
  `pbx-db/src/rls-preflight-plan.ts:16-17` ("the preflight evaluator also reports any table it introspects
  that the plan does not cover"). `cdr-db`'s quarantine header relies on the same behaviour in the other
  direction.
- Failure scenario / cost: a new tenant table created by a migration but not added to `pbxTables` (or a
  `cdr-db` table not added to `cdrTenantRlsPreflightPlan`) ships with no policy, no grant assertion and a
  green boot preflight. The pbx side is partly saved by `tables.ts` also driving the Drizzle schema; the cdr
  plan is hand-maintained and has no such coupling.
- Fix: drop the `relname in (...)` filter and instead select every table in the schema that has an
  `organization_id` column (`join pg_attribute … where attname = 'organization_id'`), then run the existing
  two-way comparison. Cheap, and it makes the dead branch live.
- Cross-area: none (both plans consume the shared introspector).

### [P1] Intra-database foreign keys are not tenant-composite, so a cross-tenant reference is legal at the DB level (confidence: medium)

- Where: e.g. `pbx-db/src/schema/devices-schema.ts:137-139`, `queues-schema.ts:236-240`,
  `routing-schema.ts:114`, `numbers-schema.ts:52-54`, `shared-lines-schema.ts:107-111` (29 `onDelete` FKs)
- Code: `deviceProfileId: uuidEntityId("device_profile_id").references(() => deviceProfile.id, { onDelete: "set null" }),`
- Problem: PostgreSQL evaluates referential-integrity checks with RLS bypassed, and the RLS `WITH CHECK`
  only constrains the _row's own_ `organization_id`. Nothing in the database prevents
  `insert into device (organization_id = A, device_profile_id = <a profile owned by B>)`. Every guard is
  application-side (the repository's tenant-scoped lookup returning nothing → 404), i.e. one forgotten
  validation away.
- Failure scenario / cost: a create/update endpoint that accepts a referenced id without re-reading it under
  the tenant scope binds tenant A's device to tenant B's provisioning profile — B's config template (and via
  `device_line`/`extension`, B's routing) is then rendered for A's handset. The same shape applies to
  `outbound_route.pin_set_id` (a spending control) and `phone_number.emergency_address_id`.
- Fix (surgical, incremental): add `uniqueIndex(<table>_org_id_key).on(organizationId, id)` on referenced
  tables and change the FKs to composite
  `foreignKey({ columns: [organizationId, deviceProfileId], foreignColumns: [deviceProfile.organizationId, deviceProfile.id] })`.
  Worth doing at least for the security-relevant references (`pin_set_id`, `trunk_id`, `device_profile_id`,
  `extension_id`).
- Cross-area: `apps/api` repositories would need no change if they already scope their lookups; the migration
  would fail loudly if any existing row is cross-tenant, which is itself the audit.

### [P1] better-auth rate limiting uses the default in-memory store (confidence: medium)

- Where: `packages/auth/src/auth.ts:320`
- Code: `rateLimit: { enabled: options.rateLimitEnabled ?? true },`
- Problem: no `storage`/`customStorage` is supplied, so better-auth keeps counters in the process's memory.
  With N API replicas an attacker gets N × the limit, and every deploy/restart resets the window.
- Failure scenario / cost: credential stuffing against `/api/auth/sign-in/email` and OTP brute force against
  `/two-factor/verify-otp` are effectively unthrottled at any replica count > 1; the map is also unbounded
  per-process for the lifetime of the process.
- Fix: pass `rateLimit: { enabled, storage: "secondary-storage" }` and wire the Redis/valkey secondary
  storage the API already has, or `storage: "database"` (better-auth then uses the `rateLimit` table) as the
  zero-infrastructure option. Also set a tighter `customRules` for the sign-in and 2FA paths.
- Cross-area: `apps/api` supplies the storage adapter.

### [P2] `platform-hierarchy.listChildOrganizations` streams every member row to count them (confidence: high)

- Where: `packages/db/src/platform-hierarchy.ts:94-106`
- Code:
  ```ts
  const counts = await db.select({ organizationId: member.organizationId, userId: member.userId })
      .from(member).where(inArray(member.organizationId, rows.map((row) => row.organizationId)));
  const countByOrg = new Map<string, number>(); for (const row of counts) { … }
  ```
- Problem: the member count is computed in JS from the full member set of every child. A reseller with 200
  children of 50 seats each transfers 10 000 rows to produce 200 integers, on a list endpoint.
- Fix: `select({ organizationId: member.organizationId, count: count() }).from(member).where(inArray(...)).groupBy(member.organizationId)`.
- Cross-area: none.

### [P2] `cdr_export_job` gives the tenant role UPDATE over `object_key` and `status` (confidence: medium)

- Where: `packages/cdr-db/src/rls-preflight-plan.ts:36`, `src/schema/export-schema.ts:113,163-168`
- Code: `{ table: "cdr_export_job", mode: "read-write", forceRowSecurity: false }` with a single `FOR ALL` policy.
- Problem: the lifecycle argument in the header is sound for `status`/`attempts`/`claimed_at`, but
  `object_key` is the download pointer. Any code path reachable by a tenant that updates a job row can point
  it at `exports/<other-org>/<id>.csv`; RLS only checks the row's own `organization_id`.
- Failure scenario / cost: if the download endpoint streams `row.object_key` rather than deriving
  `exports/<session org>/<job id>.csv`, this is a cross-tenant read of a full CDR export.
- Fix: derive the object key from `(organization_id, id)` at download time and never trust the column, or add
  a check constraint `object_key is null or object_key = 'exports/' || organization_id || '/' || id || '.csv'`.
- Cross-area: the API's export download controller.

### [P2] `toCallTokenClaims` still accepts the legacy `accessKeyId` claim as the tenant id (confidence: medium)

- Where: `packages/auth/src/call-token-verifier.ts:88-101`
- Code:
  ```ts
  const organizationId =
  	readString(payload, "organizationId") ??
  	readString(payload, "accessKeyId") ??
  	legacyAccessKeyId;
  ```
- Problem: `definePayload` (`auth.ts:226-232`) mints only `sub`/`email`/`organizationId`, so the two fallbacks
  can only ever be satisfied by a token this platform no longer issues. Keeping them means any future JWT
  minted for another purpose that happens to carry an `accessKeyId` is silently accepted as a tenant claim,
  and the module comment ("`accessKeyId` … was client-supplied and was the only tenant scoping on the wire")
  is exactly the property being re-admitted.
- Fix: delete both fallbacks and the `access[]` parsing; require `organizationId`.
- Cross-area: any Go/engine verifier mirroring these claims (they read `organizationId`).

### [P2] `isImpersonatedSession` reuses the organization-id normalizer on `impersonatedBy` (confidence: high)

- Where: `packages/auth/src/session.ts:100-102`
- Code: `return Boolean(normalizeOrganizationId(session?.session.impersonatedBy));`
- Problem: works only because the helper is a generic trim-to-undefined; the name asserts a semantic
  (organization id) that the value is not (a user id). A future tightening of `normalizeOrganizationId` —
  a uuid check, say — silently turns every impersonated session into a non-impersonated one, and this
  predicate gates audit attribution.
- Fix: extract `normalizeNonEmpty(value)` and use it in both places.
- Cross-area: none.

### [P2] `BASE_TENANT_RLS_PLAN` names a role that does not exist and asserts nothing (confidence: medium)

- Where: `packages/db/src/rls-preflight-plan.ts:23-27`
- Code: `roleName: "optimiq_tenant_tls", schemaName: "public", expectations: []`
- Problem: the empty expectation list is correct and well argued, but `optimiq_tenant_tls` is not a role any
  migration creates (the contexts are `pbx_tenant_tls` / `cdr_tenant_tls`). If a table is ever added to this
  plan, every privilege assertion resolves against a non-existent role: `tenantRoleCanSet` degrades to
  `false` (handled), but `has_schema_privilege('optimiq_tenant_tls', …)` raises `undefined_object` and the
  preflight fails with a driver error rather than a diagnosis.
- Fix: either derive the name from a real `createTenantDatabaseContext(...)`, or leave the plan `roleName`
  unset until the first table lands.
- Cross-area: none.

### [P2] `hasChildren` carries a redundant predicate on a NOT NULL column (confidence: high)

- Where: `packages/db/src/platform-hierarchy.ts:266-271`
- Code: `and(eq(organizationHierarchy.parentOrganizationId, parentOrganizationId), isNotNull(organizationHierarchy.organizationId))`
- Problem: `organization_id` is `notNull()`; the extra clause reads as if it were guarding something and
  invites a reader to believe the column is nullable (it is `parent_organization_id` that is).
- Fix: drop the `isNotNull`.
- Cross-area: none.
