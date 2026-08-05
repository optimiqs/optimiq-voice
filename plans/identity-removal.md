# Identity Service Removal — Cutover Plan

**Date:** 2026-08-05 · **Phase:** written in P0, executed in P1 · **Status:** PLAN ONLY — no identity code has been touched.

The custom RS256 gRPC identity service is retired and replaced by **better-auth 1.6.23**
(`packages/auth`) on the **base database** (`packages/db`). This document enumerates everything
that currently depends on identity and the ordered steps to remove each.

> **Nothing in this plan has been executed.** `apps/identity`, `packages/identity`,
> `packages/identity-client`, `packages/common/src/identity/` and the `fnidentity` database are
> all still in place and untouched.

---

## 1. What was built in P0 (the replacement is ready)

| Concern                      | Old                                                              | New                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Users, sessions, credentials | `packages/identity` + `fnidentity` DB                            | `packages/auth` `createAuth()` → `user` / `session` / `account` / `verification` in `packages/db`       |
| Tenant                       | `v_workspaces` + `accessKeyId` string on every row               | better-auth **organization** (`organization` / `member` / `invitation`), `session.activeOrganizationId` |
| API keys                     | `packages/identity` `apiKeys` table + `exchangeApiKey`           | `@better-auth/api-key` plugin, `references: "organization"`                                             |
| Service / per-call tokens    | `createGenerateCallAccessToken` signing with `.keys/private.pem` | better-auth **jwt** plugin (EdDSA by default), JWKS published at `/api/auth/jwks`                       |
| Non-browser auth             | `token` gRPC metadata                                            | **bearer** plugin (`Authorization: Bearer <session token>`) or an API key header                        |
| 2FA                          | `API_IDENTITY_TWO_FACTOR_AUTHENTICATION_REQUIRED` + Twilio       | **twoFactor** plugin (TOTP + backup codes)                                                              |
| Platform operator            | none                                                             | **admin** plugin (ban / impersonate / list users)                                                       |
| RBAC                         | `packages/common/src/identity/roles.ts` (path → role tables)     | `PERMISSIONS` / `PERMISSION_CATALOG` / `SYSTEM_ROLE_TEMPLATES` in `packages/auth/src/permissions.ts`    |
| Tenant enforcement           | app-code `accessKeyId` string comparison                         | Postgres RLS (`packages/db/src/tenant/`, `rls-preflight.ts`)                                            |

---

## 2. Blast radius (verified by repository survey, 2026-08-05)

### 2.1 The critical surprise

**The auth interceptor does not live in `packages/identity`.** It lives in
`packages/common/src/identity/` (12 files: `createAuthInterceptor.ts`, `decodeToken.ts`,
`getAccessKeyIdFromCall.ts`, `getPublicKey.ts`, `getTokenFromCall.ts`, `hasAccess.ts`,
`isValidToken.ts`, `roles.ts`, `tokenHasAccessKeyId.ts`, `errors.ts`, `types.ts`, `index.ts`).
Deleting `packages/identity` does **not** remove authentication — `packages/common` must be
migrated separately, and it is the piece with the widest consumer list (`apps/api`,
`apps/autopilot`, `packages/authz`, `packages/sipnet`, `packages/voice`).

### 2.2 Declared dependencies on `@optimiq-voice/identity`

| Package           | Real usage                                                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`        | 7 imports (`buildIdentityService`, `identityAllowList`, `withAccess` ×3, `createGenerateCallAccessToken`, `createUpdateMembershipStatus`) + 1 dead empty import in `src/secrets/listSecrets.ts` |
| `packages/sipnet` | 3 × `withAccess` (`resources/{get,update,delete}Resource.ts`)                                                                                                                                   |
| `packages/voice`  | **dead dependency — zero imports.** Drop immediately.                                                                                                                                           |

`@optimiq-voice/identity-client` has **zero consumers** anywhere in the repo. Deleting it is a
no-op for the build graph.

`apps/identity` has **no `package.json`** — it is only a `Dockerfile` packaging
`packages/identity`, built solely by `.github/workflows/publish-identity.yaml`. It is not
referenced by `compose.yaml` or `compose.dev.yaml`; identity runs **in-process inside the `api`
container**.

### 2.3 How a request authenticates today

1. `apps/api/src/core/runServices.ts:32` — `createAuthInterceptor(IDENTITY_PUBLIC_KEY, allowList)`.
   The public key is read **from disk at module load** (`apps/api/src/envs.ts:100-108`).
2. `getAccessKeyIdFromCall(call)` reads the gRPC metadata key **`accesskeyid`** — a
   _client-supplied header_. This is the only tenant scoping on the wire.
3. `getTokenFromCall(call)` reads metadata key `token`; `isValidToken` does `jwt.verify` (RS256)
   plus a manual `exp` check.
4. Authorization gate: `hasAccess(decoded, path)` against the role tables in
   `packages/common/src/identity/roles.ts`, then `tokenHasAccessKeyId(token, accessKeyId)` for
   paths in `workspaceResourceAccess` (50+) / `workspaceResourceOwnerOrAdminAccess` (4).
5. Per-resource ownership: `withAccess` → `hasAccessToResource` compares the token's
   `access[].accessKeyId` list to the resource's `extended.accessKeyId` JSONB column.
   **Known defect: if the resource does not exist, access is ALLOWED**
   (`packages/identity/src/utils/hasAccessToResource.ts:26`).
6. 17 handlers additionally call `getAccessKeyIdFromCall(call)` directly to scope list/create
   queries (`apps/api` ×10, `packages/sipnet` ×6, `packages/authz` ×1, `apps/autopilot` ×1).

`packages/voice/src/VoiceServer.ts:36` is the only consumer of `getPublicKey.ts` — it fetches
the identity public key over gRPC at startup (`config.identityAddress`, default
`api.optimiq.health`), unless `skipIdentity` is set (`apps/autopilot/src/envs.ts:38`,
`AUTOPILOT_SKIP_IDENTITY`).

### 2.4 `createGenerateCallAccessToken`

- Defined `packages/identity/src/utils/createGenerateCallAccessToken.ts`.
- Called **once**: `apps/api/src/voice/createCreateVoiceClient.ts:14` (factory), `:44` (call).
- Payload: `{ iss, sub: appRef, aud, tokenUse: ACCESS, accessKeyId, access: [{ accessKeyId, role: "VOICE_SERVICE" }] }`, RS256, **`expiresIn: "30s"`**.
- Flows: `VoiceClientImpl.config.sessionToken` → `GrpcClientHandler.ts:35` adds it as the `token`
  metadata on the outbound `Voice/CreateSession` call → `packages/voice/src/VoiceServer.ts`
  interceptor verifies it → `apps/autopilot/src/loadAssistantFromAPI.ts:31` reuses it to call
  back into `Applications/GetApplication`.
- `packages/streams` has **zero** auth coupling.

### 2.5 The second, less obvious signer

`apps/api/src/applications/createCreateTestToken.ts:51` signs a **SIP/WebRTC connect token**
with the same RSA private key (`{ accessKeyId, domain, signalingServer, targetAor,
allowedMethods: ["INVITE"] }`, 1h). **Routr verifies it** using the same public key
(`compose.yaml:102,122` — `CONNECT_VERIFIER_PUBLIC_KEY_PATH`, `./.keys/public.pem`;
`compose.dev.yaml:52`). _Changing the signing key or algorithm breaks SIP registration and
WebRTC test calls._ This is the highest-risk item in the cutover.

### 2.6 Keys

`.scripts/gen-keypair.sh` generates RSA-2048 `.keys/{private,public}.pem`, invoked by root
`package.json` `generate:keypair` / `prestart:services` / `pretest`, and by
`.github/workflows/publish-api.yaml:76`. Consumed by `apps/api/src/envs.ts`,
`identityConfig.ts`, `createCreateTestToken.ts`, `runServices.ts`,
`packages/identity/src/server/config.ts`, and **Routr**.

### 2.7 Environment variables to retire

`API_IDENTITY_DATABASE_URL`, `API_IDENTITY_ISSUER`, `API_IDENTITY_AUDIENCE`,
`API_IDENTITY_PRIVATE_KEY_PATH`, `API_IDENTITY_PUBLIC_KEY_PATH`,
`API_IDENTITY_ACCESS_TOKEN_EXPIRES_IN`, `API_IDENTITY_ID_TOKEN_EXPIRES_IN`,
`API_IDENTITY_REFRESH_TOKEN_EXPIRES_IN`, `API_IDENTITY_WORKSPACE_INVITE_URL`,
`API_IDENTITY_WORKSPACE_INVITE_FAIL_URL`, `API_IDENTITY_WORKSPACE_INVITE_EXPIRATION`,
`API_IDENTITY_CONTACT_VERIFICATION_REQUIRED`,
`API_IDENTITY_TWO_FACTOR_AUTHENTICATION_REQUIRED`, `API_IDENTITY_OAUTH2_GITHUB_ENABLED|_CLIENT_ID|_CLIENT_SECRET`,
`API_CLOAK_ENCRYPTION_KEY`, `AUTOPILOT_SKIP_IDENTITY`,
`MCP_WORKSPACE_ACCESS_KEY_ID` / `MCP_APIKEY_ACCESS_KEY_ID` / `MCP_APIKEY_ACCESS_KEY_SECRET`,
`DASHBOARD_AUTH_GITHUB_*`, `SERVER_DASHBOARD_SESSION_SECRET`.

Declared in `.env.example` (33-53, 64-65, 72), `.env.example.dev` (17-21, 30-48, 61-62, 69,
145-147), `compose.yaml` (10, 26-35), `compose.dev.yaml` (7-13, 18). Replacements already exist
in `packages/config`: `AUTH_SECRET`, `AUTH_URL`, `AUTH_COOKIE_DOMAIN`, `AUTH_COOKIE_SAMESITE`,
`AUTH_ISSUER`, `AUTH_SESSION_TTL_SECONDS`, `DATABASE_URL`.

### 2.8 Envoy

`config/envoy.yaml:27-41` and `config/envoy-tls.yaml:34-48` route the literal path
`/optimiq_voice.identity.v1beta2.Identity/SendVerificationCode` to `api-cluster` with a
dedicated SMS rate-limit filter (`stat_prefix: sms_verification_rate_limit`). There is **no
identity cluster** — both files send it to the api. When the RPC disappears the rate limit
silently stops applying; it must be re-anchored on the better-auth path
(`/api/auth/*`, specifically `/api/auth/send-verification-email` and the OTP routes).

### 2.9 The `fnidentity` database

Drizzle schema `packages/identity/src/db/schema.ts` (`users`, `workspaces`, `workspaceMembers`,
`apiKeys`, `verificationCodes`), `@47ng/cloak` field encryption, journal at
`packages/identity/drizzle/0000_baseline.sql` plus three legacy Prisma migrations reconciled by
`packages/identity/scripts/db-provision.mjs`. It is a _logical_ database on the shared
`postgres` container — no separate service. Root `package.json:28-29` `db:generate` / `db:migrate`
fan out to it, and `apps/api/Dockerfile:55` invokes
`node /service/node_modules/@optimiq-voice/identity/scripts/db-provision.mjs` in its CMD chain.

### 2.10 `accessKeyId` semantics that must be translated

Prefixes are hardcoded: `US` = user, `WO` = workspace
(`packages/common/src/identity/hasAccess.ts:15`,
`packages/identity/src/exchanges/exchangeTokens.ts:22`, `.env.example.dev:145`). **Every
telephony resource row carries an owning `accessKeyId` in its `extended` JSONB column.** The
migration must map each distinct workspace `accessKeyId` to a new `organization.id` (UUID v7)
and rewrite those JSONB values into a real `organization_id` column before RLS can be enabled.

---

## 3. Ordered cutover (Phase 1)

### Step 0 — Prerequisites (done in P0)

- [x] `packages/db` — primitives, tenant role/scope/transaction, RLS preflight, auth journal.
- [x] `packages/auth` — `createAuth()`, session helpers, permission registry.
- [x] Initial migration `packages/db/drizzle/*_auth_baseline`.
- [ ] Decide the JWT algorithm for the **Routr connect token** (see Step 6 — this gates the
      key retirement, not the auth cutover).

### Step 1 — Mount better-auth in `apps/api` (additive, nothing removed)

1. Add `@optimiq-voice/auth` + `@optimiq-voice/db` to `apps/api`.
2. Create the base-DB client (`createDatabaseClient`) and call `createAuth({ database: adminDb, … })`,
   wiring `email.sendVerification|sendReset|sendInvite` to the existing SMTP helpers in
   `apps/api/src/core/`.
3. Implement `SessionOrganizationRepository.findMembership` over the `member` table and pass it
   as `organizationRepository` so `session.activeOrganizationId` is stamped on session create.
4. Mount the handler on Fastify at `/api/auth/*` (`auth.handler(request)`).
5. Run `packages/db` migrations in the api container (`bun run scripts/migrate.ts --expected-stage <stage>`).
6. **Gate:** sign up, verify email, sign in, create organization, invite + accept, issue an API
   key, fetch `/api/auth/jwks` and `/api/auth/token`.

### Step 2 — Data migration `fnidentity` → base DB

1. One-shot script: `users` → `user` (+`account` rows with the bcrypt hash under
   `providerId: "credential"`), `workspaces` → `organization`, `workspaceMembers` → `member`
   (owner/admin/member), `apiKeys` → `apikey` with `referenceId = organization.id`.
2. Persist a `accessKeyId → organization.id` mapping table; it is the join key for Step 5.
3. Decrypt `@47ng/cloak` fields on read; store plaintext-equivalents only where better-auth
   expects them (email, name). Do **not** carry `verificationCodes` over.
4. **Gate:** every existing user can sign in with their existing password; every workspace has
   exactly one owner.

### Step 3 — Replace `createAuthInterceptor` with a session guard

1. New `apps/api` guard: resolve the caller in order — session cookie → `Authorization: Bearer`
   (bearer plugin) → `x-api-key` (apiKey plugin). Produce an `AppSession`.
2. `requireActiveOrganizationId(session)` supplies the tenant id; **delete
   `getAccessKeyIdFromCall`** — the tenant is never again read from a client-supplied header.
3. Implement `@RequirePermissions(...)` over `PERMISSIONS` / `SYSTEM_ROLE_TEMPLATES`, replacing
   `roles.ts`, `hasAccess.ts`, `workspaceResourceAccess`, `workspaceResourceOwnerOrAdminAccess`.
4. Replace `withAccess` / `hasAccessToResource` in `apps/api` (3 sites) and `packages/sipnet`
   (3 sites) with RLS scoping — and note that the _existence-implies-access_ defect disappears
   for free, because an out-of-tenant row is simply invisible.
5. **Gate:** the 17 direct `getAccessKeyIdFromCall` call sites are gone; a cross-tenant request
   returns 404/403 in an integration test.

### Step 4 — Per-call and service tokens

1. Replace `createGenerateCallAccessToken` with the better-auth jwt plugin: a short-lived
   (`30s`) token whose payload carries `organizationId` and the application ref.
2. `packages/voice/src/VoiceServer.ts`: replace `getPublicKey` over gRPC with JWKS verification
   via `jose.createRemoteJWKSet(new URL("/api/auth/jwks", AUTH_URL))`.
3. `apps/autopilot`: keep consuming `sessionToken`; only the verification path changes.
   Retire `AUTOPILOT_SKIP_IDENTITY` in favour of the standard auth env.
4. **Gate:** an inbound call reaches an autopilot application end to end with the new token.

### Step 5 — Enable RLS on org-scoped tables

1. Add `organization_id uuid not null` to every telephony table; backfill from the Step 2
   mapping table via `extended->>'accessKeyId'`; drop the JSONB `accessKeyId`.
2. Create the `pbx_tenant_tls` role, per-table policies (`tenantOrganizationScope`), and grants.
3. Wire `assertTenantRlsPreflight` into `apps/api` boot **before** the server is created.
4. Route every org-scoped repository through `withTenantScope`.
5. **Gate:** `db:preflight:tenant-rls` is clean; the tenant-RLS integration spec passes.

### Step 6 — SIP connect token / key retirement (independent track)

1. `createCreateTestToken` must keep producing a token **Routr can verify**. Either
   (a) keep RSA and configure the jwt plugin with `algorithm: "RS256"`, exporting the
   better-auth JWKS public key to `.keys/public.pem` for Routr, or
   (b) leave the SIP connect token on its own dedicated RSA keypair until Routr is replaced by
   `apps/sipd` in Phase 6.
   **Recommendation: (b).** It decouples the auth cutover from the SIP edge entirely; the only
   cost is one narrowly scoped keypair that dies with Routr.
2. Only after (a) or (b) is settled may `.scripts/gen-keypair.sh` change or be removed.

### Step 7 — SDK / dashboard / CLI swap

1. `packages/sdk`: replace `login`, `loginWithRefreshToken`, `loginWithApiKey`,
   `loginWithOauth2Code`, `logout`, `sendVerificationCode`, `verifyCode` in
   `src/client/AbstractClient.ts` with `better-auth/client`; delete `TokenRefresherNode|Web` and
   `isJwtExpired` (better-auth manages refresh). Replace `Users.ts`, `Workspaces.ts` and
   `ApiKeys.ts` with the better-auth organization/apiKey endpoints.
2. `apps/dashboard`: rewrite `src/auth/**` (login, logout, sign-up, profile, forgot/reset
   password, verification flow, GitHub OAuth), `src/workspaces/services/workspaces.service.ts`
   and `src/api-keys/services/api-keys.service.ts` against the new SDK. The dashboard is retired
   at P4 parity, so port only what is needed to keep it alive until then.
3. `apps/ctl`: `AuthenticatedCommand.ts` + `commands/workspaces/login.ts` +
   `commands/apikeys/*` move to API-key auth; drop `accessKeyId`.
4. `apps/mcp`: `src/utils/createClient.ts` — API key only; drop the three `MCP_*_ACCESS_KEY_*` vars.
5. Regenerate the SDK from the OpenAPI document once REST replaces gRPC-web (D2).

### Step 8 — Infrastructure and config

1. `config/envoy.yaml` + `config/envoy-tls.yaml`: re-anchor the SMS/verification rate-limit
   route on the better-auth path; delete the identity gRPC route.
2. `.env.example` / `.env.example.dev` / `compose.yaml` / `compose.dev.yaml`: delete the
   variables in §2.7, add `AUTH_SECRET` / `AUTH_URL` / `DATABASE_URL`.
3. `apps/api/Dockerfile:55`: drop the identity `db-provision.mjs` hop; run the `packages/db`
   migrate script instead.
4. Root `package.json`: `db:generate` / `db:migrate` point at `@optimiq-voice/db` only.
5. Drop `fnidentity` from the postgres container after the Step 2 backfill is verified in every
   environment.

### Step 9 — Deletion list (only after Steps 1-8 are green)

```
apps/identity/                                   # Dockerfile only; not in compose
packages/identity/                               # incl. drizzle/, migrations/, scripts/, 19 tests
packages/identity-client/                        # zero consumers today
packages/common/src/identity/                    # 12 files: interceptor, roles, token utils
packages/common/src/protos/identity.proto
packages/types/src/identity.types.ts             # + its re-export in packages/types/src/index.ts
packages/sdk/src/generated/{node,web}/identity*  # regenerated surface
packages/sdk/src/{Users,Workspaces,ApiKeys}.ts   # replaced by better-auth client calls
packages/sdk/src/client/{TokenRefresherNode,TokenRefresherWeb,isJwtExpired}.ts
.github/workflows/publish-identity.yaml
.github/workflows/release.yaml                   # remove the publish-identity job + its needs entry (:122-126, :139)
.scripts/gen-code-proto.sh                       # remove the identity_pb / IdentityServiceClientPb targets (:26, :44)
.oxfmtrc.json                                    # remove the packages/identity-client/proto/** ignore entry
packages/{voice,sipnet}/package.json             # remove the @optimiq-voice/identity dependency
apps/api/src/core/identityConfig.ts
apps/api/src/http/identity-invite.controller.ts  # replaced by better-auth accept-invitation
openspec/changes/{identity-client,identity-standalone-service}/  # archive
packages/{identity,identity-client}/.lerna-changed-buster-249
```

Deprecate (do not delete) the published npm packages `@optimiq-voice/identity@0.22.3` and
`@optimiq-voice/identity-client@0.22.0`.

---

## 4. Sequencing rules

1. **Additive first.** better-auth is mounted and exercised (Step 1) before a single identity
   file changes. Both auth paths coexist for at least one deploy.
2. **Data before enforcement.** The `accessKeyId → organization.id` mapping (Step 2) must exist
   before the tenant column backfill (Step 5); RLS is enabled last so a bad backfill is
   recoverable rather than a lockout.
3. **The SIP connect token is not part of this migration** (Step 6, recommendation (b)). It is
   the only thing forcing RSA-2048 on the system and it dies with Routr.
4. **`packages/common/src/identity/` is deleted last.** It is the actual auth implementation; the
   `packages/identity` deletion is cosmetic by comparison.
5. Every step ends with an explicit gate; no step ships without it.

## 5. Cheap wins available immediately (no cutover required)

- Remove `@optimiq-voice/identity` from `packages/voice/package.json` — it is never imported.
- Remove the empty `import {} from "@optimiq-voice/identity";` in
  `apps/api/src/secrets/listSecrets.ts:9`.
- `packages/identity-client` can be deleted at any time: zero consumers, zero lockfile importers.
