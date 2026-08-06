# Identity Service Removal — Cutover Plan

**Date:** 2026-08-05 · **Phase:** written in P0, executed in P1 · **Status:** **COMPLETE.**
Steps 1, 1.5, 2, 3, 4 and 5 were done on 2026-08-05; Steps **6, 7, 8 and 9** were completed on
**2026-08-06** in the legacy-removal wave described below. Nothing in this plan is outstanding.

> **Steps 6-9 — completed 2026-08-06 (legacy removal, wave 2).** The outcome differs from what
> Steps 7 and 9 anticipated in one important way: rather than _swapping_ the SDK, dashboard and CLI
> onto better-auth, they were **deleted**, along with every other consumer of the gRPC surface. The
> owner decision was that all legacy goes and nothing pre-cutover is honoured, which made most of
> Step 7 unnecessary and turned Step 9 into a straight deletion.
>
> - **Step 6 (SIP connect token / keys).** Retired by deleting Routr. `apps/sipd` is the SIP edge
>   and derives credentials over `rpc.sip.v1.credential`; `.scripts/gen-keypair.sh` and the
>   `generate:keypair` script are gone, and no process reads `.keys/*.pem`.
> - **Step 7 (SDK / dashboard / CLI swap).** Not swapped — deleted: `packages/sdk`, `apps/ctl`,
>   `apps/dashboard`, `apps/mcp`. `apps/web` is the only client, and it speaks HTTP to
>   `/api/auth/*` and `/api/v1/*`.
> - **Step 8 (infrastructure and config).** `routr`, `rtpengine`, `influxdb`, `envoy` and
>   `autoheal` are out of both compose files; `config/envoy*.yaml`, `config/integrations*.json`
>   and `etc/log4j2.yaml` are deleted; `API_IDENTITY_*`, `API_AUTHZ_*`, `API_TWILIO_*`,
>   `API_INFLUXDB_*`, `INFLUXDB_*`, `ROUTR_*`, `RTPENGINE_*`, `AUTOPILOT_*`, `MCP_*`,
>   `API_SIGNALING_SERVER` and `API_CLOAK_ENCRYPTION_KEY` are out of both env templates and out of
>   `packages/config`. The shipped `api` service gained the variables it was silently missing —
>   `AUTH_SECRET`, `AUTH_URL`, `PBX_DATABASE_URL`, `CDR_DATABASE_URL`, `NATS_URL` and the media
>   roots — without which the stack booted with no product surface at all.
> - **Step 9 (deletion list).** Executed in full, plus the packages the list did not name because
>   they were not identity-specific: `authz`, `streams`, `logger`, `types`, `common`, `sipnet`,
>   `voice`, `apps/autopilot`. The `legacy_*` tables were dropped by
>   `packages/db/drizzle/20260806164358_drop_legacy_identity_mapping`, and the five legacy
>   `apps/api` tables (`applications`, `secrets`, `tts_services`, `stt_services`,
>   `intelligence_services`, plus `products` and the three enums) by
>   `apps/api/drizzle/20260806164427_drop_legacy_api_tables`. Both are applied.
>
> **The one thing that did NOT die on schedule:** `packages/voice`'s `createCallTokenVerifier` was
> new-platform code, not legacy. It moved to `packages/auth/src/call-token-verifier.ts` before the
> package was deleted; `verify:call-token` still passes 27/27 through it. Its gRPC interceptor
> (`createJwksAuthInterceptor`) was deleted with the transport it served.

The custom RS256 gRPC identity service is retired and replaced by **better-auth 1.6.23**
(`packages/auth`) on the **base database** (`packages/db`). This document enumerates everything
that currently depends on identity and the ordered steps to remove each.

> **Executed so far** (2026-08-05): better-auth is mounted in `apps/api` alongside the existing
> gRPC identity path; `apps/api` has been migrated to the oikos ES-module toolchain and to
> `drizzle-orm@1.0.0-rc.4`; the five `SYSTEM_ROLE_TEMPLATES` are registered with better-auth's
> organization access control; the session guard is **global and deny-by-default** over every Nest
> HTTP route, and it now accepts **`x-api-key`** as a tenant principal alongside the cookie and the
> bearer token; `packages/voice` verifies per-call tokens against `/api/auth/jwks`; **the legacy
> `fnidentity` dataset migrates into better-auth organizations** (Step 2) and **`apps/api` mints
> every per-call token with better-auth** (Step 4 item 4) — the identity signer has no callers
> left on the call path.
>
> **New (Step 5, and the Step 3 remainder it unblocked).** Every telephony table in the `apps/api`
> database carries `organization_id uuid not null`, backfilled from the Step 2 ledger and enforced
> by PostgreSQL row-level security under a non-inheriting `api_tenant_tls` role; the boot sequence
> refuses to start if that contract has drifted. `getAccessKeyIdFromCall` — the client-supplied
> tenant header 18 handlers filtered by — **is deleted**, along with `withAccess` and
> `hasAccessToResource` and their _existence-implies-access_ defect. The tenant on the gRPC wire is
> now derived from the verified token and stamped by the server.
>
> `packages/identity-client` is **deleted**. `apps/identity`, `packages/identity`,
> `packages/common/src/identity/` and the `fnidentity` database are still in place — the gRPC
> servers `RuntimeHostService` starts continue to authenticate through them.

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
5. ~~Per-resource ownership: `withAccess` → `hasAccessToResource`~~ — **DELETED 2026-08-05**
   (Step 3 item 4). It compared the token's `access[].accessKeyId` list to the resource's
   `extended.accessKeyId` JSONB column, and opened with `if (!extended) return true`, so a missing
   resource GRANTED access (`packages/identity/src/utils/hasAccessToResource.ts:26`). Both files
   are gone; see Step 3 item 4 for what replaced them.
6. ~~18 handlers additionally call `getAccessKeyIdFromCall(call)`~~ — **DELETED 2026-08-05**
   (Step 3 item 2). The count was 18, not 17: `apps/api` ×10, `packages/sipnet` ×6,
   `packages/authz` ×1, `apps/autopilot` ×1, plus 6 inside `packages/identity` itself.

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

### Step 1 — Mount better-auth in `apps/api` (additive, nothing removed) — **DONE 2026-08-05**

- [x] 1. Add `@optimiq-voice/auth` + `@optimiq-voice/db` to `apps/api` (also `@optimiq-voice/config`,
      `better-auth`, `postgres`).
- [x] 2. Create the base-DB client (`createDatabaseClient`) and call `createAuth({ database: adminDb, … })`.
      **Email delivery is a console/log STUB** (`src/auth/auth-email.delivery.mts`) — the SMTP helpers in
      `apps/api/src/core/` are not wired yet. Carried into Step 8.
- [x] 3. `SessionOrganizationRepository.findMembership` (`src/auth/auth.repository.mts`) passed as
      `organizationRepository`; `session.activeOrganizationId` is stamped on session create — verified.
- [x] 4. Mount the handler on Fastify at `/api/auth/*` (`auth.handler(request)`).
- [ ] 5. Run `packages/db` migrations in the api container (`bun run scripts/migrate.ts --expected-stage <stage>`).
      Not started — `apps/api/Dockerfile` and `compose*.yaml` are untouched (belongs with Step 8).
- [x] 6. **Gate** — `pnpm --filter @optimiq-voice/api verify:auth` (**38/38** checks as of
      2026-08-05, 26 originally; real Postgres 17):
      sign up → session cookie → `/api/v1/me` → create organization → `/api/v1/me` with the org →
      `/api/v1/organizations` → invite + accept → re-sign-in proves the session hook → guard 403 for a
      `member`, 200 for the `owner` → 401 anonymous → `/api/auth/jwks` served → **(added with the
      role AC, checks 27-38)** promote the member to `manager` through
      `/api/auth/organization/update-member-role`, assert `/api/v1/me` reports `manager` with 43
      permissions and that the guard now returns 200 on the `members.read` route the bare member
      was refused; demote to `agent`, assert 15 permissions and 403 again; assert an unregistered
      role id is still rejected.
      **Not yet exercised:** API-key issuance and `/api/auth/token` (see the api-key blocker in
      Step 3), and email verification by clicking the link (delivery is stubbed; the gate flips
      `user.email_verified` directly to reach the invitation flow).

Also delivered early, out of Step 3: `@RequirePermissions(...)` + `RequirePermissionsGuard`
(item 3 of Step 3). It was opt-in per controller at that point; it is **global and deny-by-default**
as of Step 3 — see below.

#### Step 1 implementation notes

**What was built** (`apps/api/src/auth/`, all additive):

| File                                                                 | Role                                                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `auth.config.mts`                                                    | Env → `AuthSliceConfig`, entirely from `@optimiq-voice/config`                         |
| `auth-email.delivery.mts`                                            | **STUB** logging delivery                                                              |
| `auth.repository.mts`                                                | Membership / organization / member reads                                               |
| `role-permissions.mts`                                               | `member.role` → `SYSTEM_ROLE_TEMPLATES` → `Permission[]`                               |
| `auth.platform.mts`                                                  | `createDatabaseClient` + `createAuth` + repository, owns the pool                      |
| `app-session.mts`                                                    | The only place a session is written to / read from the request                         |
| `auth-http.plugin.mts`                                               | `/api/auth/*` route + session `preHandler` hook                                        |
| `auth.service.mts`                                                   | Transport-agnostic reads (takes `AppSession`, never a request)                         |
| `require-permissions.{decorator,guard}.mts`, `session.decorator.mts` | `@RequirePermissions()`, `@Session()`                                                  |
| `me.controller.mts`, `organizations.controller.mts`                  | `GET /api/v1/me`, `GET /api/v1/organizations`, `GET /api/v1/organizations/:id/members` |
| `auth.module.mts`, `auth-bootstrap.mts`, `index.mts`                 | Nest module + the ESM entry point `main.ts` loads                                      |
| `auth-esm.bridge.ts`                                                 | The one CommonJS → ESM hop (see below)                                                 |

**Mount mechanism.** A raw Fastify route `/api/auth/*` registered on the instance returned by
`app.getHttpAdapter().getInstance()` in `main.ts`, _after_ `NestFactory.create` and _before_
`listen`. The handler converts the Fastify request into a WHATWG `Request`, calls
`auth.handler(request)` and writes the `Response` back (`getSetCookie()` is used so multiple
`Set-Cookie` headers survive). `toNodeHandler` from `better-auth/node` is deliberately **not**
used — it writes to the raw `ServerResponse` behind Fastify's back and would bypass reply
lifecycle hooks (`onSend` security headers, `Cache-Control: no-store`). `fromNodeHeaders` from
the same module _is_ used, for both the handler and the session hook.

**Three findings that shaped the remaining steps** (1 and 2 are now RESOLVED — see Step 1.5):

1. ~~**`apps/api` cannot import the P0 packages.**~~ **RESOLVED 2026-08-05.** `apps/api` compiled
   with the repository-root tsconfig (`module: commonjs`, `moduleResolution: node`), whose
   resolver predates `exports` maps, so `@optimiq-voice/{auth,db,config}` were unresolvable and
   their extension-less relative imports raised `TS2835`. The slice was therefore a separate
   ES-module program (`src/auth/tsconfig.json`) emitting `dist/auth/*.mjs`, crossed once through
   `src/auth/auth-esm.bridge.ts`. `apps/api` is now an ES-module package on the oikos tsconfig;
   the bridge, the slice tsconfig and the `.mts` split are deleted.
2. ~~**Two Drizzle majors coexist in `apps/api`.**~~ **RESOLVED 2026-08-05.** `apps/api` is on
   `drizzle-orm@1.0.0-rc.4` (`catalog:`) like `@optimiq-voice/{auth,db}`. Step 5 (RLS +
   `withTenantScope`) is unblocked. The auth slice still reads through better-auth's own adapter
   (`auth.$context.adapter`); moving it to a Drizzle handle is optional now, not forced.
3. ~~**`member.role` → permissions is ambiguous.**~~ **RESOLVED 2026-08-05.** better-auth stored
   only `owner` / `admin` / `member`, while `SYSTEM_ROLE_TEMPLATES` has five ids, so
   `role-permissions.ts`'s least-privilege fallback meant a bare `member` could only ever be the
   `user` template (11 permissions). `packages/auth` now registers all five templates with the
   organization plugin's access control (`src/access-control.ts`), so `manager` / `agent` / `user`
   are assignable and resolve to their own templates. `role-permissions.ts` needed **no change**,
   exactly as predicted. See "Step 4 blocker — RESOLVED" below.

Smaller notes:

- `packages/config` names the base URL **`AUTH_URL`**, not `AUTH_BASE_URL`. The slice reads
  `DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL`, `AUTH_COOKIE_DOMAIN`, `AUTH_COOKIE_SAMESITE`,
  `AUTH_SESSION_TTL_SECONDS` and `API_APP_URL`; it adds no env parsing of its own. When all
  three of the first are absent the slice does not mount and the API boots exactly as before.
- `requireEmailVerification` and `rateLimit` are enabled **only** when `NODE_ENV=production`,
  because email delivery is still a stub. Both revert to unconditional once §2 SMTP is wired.
- The guard resolves the membership row on every protected request. Cache it on the session
  (or stamp the role alongside `activeOrganizationId`) before this reaches real traffic.
- `.env.example` / `.env.example.dev` / `compose*.yaml` were **not** touched — that is Step 8.

### Step 1.5 — `apps/api` modernization (ESM · unified slice · drizzle 1.0) — **DONE 2026-08-05**

Findings 1 and 2 above were prerequisites for Steps 3-5. All three pieces landed together.

#### 1.5.a ES modules and the oikos tsconfig

- `apps/api/package.json` is `"type": "module"`, `main` `./dist/index.js`.
- `tsconfig.json` extends `../../tsconfig.base.json` (`module: preserve`, `moduleResolution:
bundler`, ES2022, decorators). It `include`s `src`, `test`, `scripts` and `drizzle.config.ts`
  because `tsx` and `mocha --import tsx` resolve exactly one tsconfig from the working directory
  and apply it only to matching files.
- `tsconfig.build.json` narrows to `src` and emits; `build` is
  `tsc -p tsconfig.build.json && node ../../.scripts/rewrite-esm-specifiers.mjs`, the same
  two-step build `packages/db` and `packages/auth` use. Relative specifiers stay extension-less
  in source; the rewrite script appends `.js` in `dist`.
- Project references are gone — `tsc -b` became `tsc -p`. Dependency ordering is turbo's
  `build.dependsOn: ["^build"]`, which already covered it.
- **Strictness is deliberately unchanged.** `tsconfig.base.json` sets `strict: true`; the ~180
  files inherited from the CommonJS era were written against a config with `noImplicitAny: false`
  and no `strictNullChecks`, and turning it on surfaces ~170 errors that are a separate,
  behaviour-touching cleanup. `tsconfig.json` therefore re-relaxes
  `strict` / `strictNullChecks` / `noImplicitAny` / `strictBindCallApply`, and a second project
  **`tsconfig.strict.json`** keeps the full oikos contract over `src/auth/**` and `scripts/**` —
  the code that was written against it — so new code cannot regress. `pnpm typecheck` runs both.
  Grow `tsconfig.strict.json`'s `include` directory by directory; delete it once it covers `src`.
  (`src/runtime/**` is not in it: it imports `src/core/`, which drags in the whole legacy graph.)
- Node-only globals ported: `__filename` → `import.meta.filename` (52 sites, all `getLogger`
  calls), `__dirname` → `import.meta.dirname` (`src/envs.ts`, the root `.env` lookup).
- `isolatedModules` forced 34 type re-exports to `export type` across 10 files.

**CJS interop, audited exhaustively.** Every bare specifier in the _emitted_ `dist/**/*.js` (i.e.
every binding that survives type elision) was imported under Node's ES-module loader and its
bindings checked. Exactly four packages needed anything:

| package              | problem                                                          | fix                                                                             |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `@routr/sdk`         | `module.exports = { default: {...} }`; Node ignores `__esModule` | unwrap `.default` explicitly in `src/core/upsertDefaultPeer.ts`                 |
| `wavefile`           | no detectable named **or** default export                        | `createRequire(import.meta.url)` in `src/voice/tts/utils/convertUlawToPCM16.ts` |
| `@deepgram/sdk`      | was `require()`d behind an `any`                                 | real named import; surfaced a live bug (below)                                  |
| everything else (44) | none                                                             | —                                                                               |

The proto-generated CommonJS in `@optimiq-voice/common` loads correctly under Node ESM — verified
by booting `tsx src/main.ts` and watching all 11 gRPC services register.

#### 1.5.b The auth slice is unified

`src/auth/*.mts` → `*.ts`; `src/auth/tsconfig.json` and `src/auth/auth-esm.bridge.ts` deleted;
`main.ts` now statically imports `./auth/auth-bootstrap`. `src/runtime/app-runtime.mts` → `.ts`
and its `../../node_modules/effect/dist/index.js` escape hatch became ordinary
`effect/{Context,Effect,Layer,Schema}` sub-path imports. `scripts/verify-auth-slice.mts` →
`.ts`. Behaviour is identical: **`verify:auth` still passes 26/26.**

#### 1.5.c drizzle-orm 0.45.2 → 1.0.0-rc.4 (`catalog:`), drizzle-kit likewise

Drizzle usage in `apps/api` is confined to `src/core/db.ts`, `src/core/db/schema.ts`,
`drizzle.config.ts` and `scripts/db-provision.mjs`; every caller goes through the Prisma-shaped
`db.*` facade, whose call signatures are unchanged. Three API changes mattered:

1. **`relations()` → `defineRelations()`.** The per-table helpers are gone from the root export
   (they survive at `drizzle-orm/_relations` for compatibility). `schema.ts` now exports a
   `tables` map and one `relations` graph built with `defineRelations(tables, (r) => …)`. drizzle
   1.0 no longer infers the inverse side of a relation, so both directions are spelled out with
   `from`/`to`.
2. **`drizzle(pool, { schema })` → `drizzle({ client: pool, relations })`.** The positional
   `(client, config)` overload is gone, and relational metadata is passed as `relations`, not
   `schema`.
3. **`NodePgDatabase<typeof schema>` → `NodePgDatabase<typeof schema.relations>`.** The generic
   parameter is the relations graph now, not the table map. `select` / `insert` / `update` /
   `delete` / `transaction` / `onConflictDoUpdate` / `.returning()` are all unchanged, so the
   ~600 lines of facade body needed no edits.

**The migration folder had to be converted too, and the conversion is production-safe.**
drizzle-orm 1.0's migrator refuses a `drizzle/meta/_journal.json` outright
(`"We detected that you have old drizzle-kit migration folders"`), and it reads
`drizzle/<YYYYMMDDHHMMSS>_<name>/migration.sql` instead of `drizzle/NNNN_<name>.sql`.
`drizzle-kit up` performed the conversion:

```
apps/api/drizzle/0000_baseline.sql          →  apps/api/drizzle/20260805032410_baseline/migration.sql
apps/api/drizzle/meta/0000_snapshot.json    →  apps/api/drizzle/20260805032410_baseline/snapshot.json  (v7 → v8)
apps/api/drizzle/meta/_journal.json         →  deleted (the folder name carries the timestamp)
```

`migration.sql` is **byte-identical** to the old `0000_baseline.sql`, and the folder timestamp
`20260805032410` reproduces the journal's `when: 1785900250156` exactly
(`Date.UTC(...) === 1785900250000 === trunc(when)`). Both matter, because drizzle 1.0 ships a
first-class upgrade for an existing `__drizzle_migrations_api` table
(`drizzle-orm/up-migrations/pg.js`): it matches each pre-1.0 row to a local migration by
`created_at` millis (hash as the tiebreak), adds the `name` / `applied_at` columns and backfills
`name`. Verified end to end against real PostgreSQL:

1. fresh database → `db:deploy` applies the baseline, 8 tables, one row named
   `20260805032410_baseline`;
2. that row rewound to the pre-1.0 shape (`name` / `applied_at` dropped, `created_at` restored to
   `1785900250156`) → `db:deploy` **upgrades the table in place, re-applies no DDL**;
3. a third `db:deploy` is a no-op.

`apps/api/scripts/db-provision.mjs` needed one edit for the same reason as `db.ts`:
`drizzle(client)` → `drizzle({ client })`.

> ⚠️ ~~**Known artifact — the next `db:generate` will not be empty.**~~ **RESOLVED 2026-08-05,
> option (b).** drizzle-kit 1.0 diffed the converted snapshot against the schema and emitted four
> cosmetic `ALTER COLUMN … SET DATA TYPE timestamp(3)` statements for
> `applications.{created_at,updated_at}` and `secrets.{created_at,updated_at}` — the v7→v8 snapshot
> conversion wrote `"timestamp (3)"` where 1.0's own serializer writes `"timestamp(3)"`. There was
> no structural drift, which also confirmed the `defineRelations` rewrite changed no DDL. The four
> entries in `20260805032410_baseline/snapshot.json` were hand-corrected (option (b)) rather than
> taking option (a)'s no-op normalization migration, which would have cost a table rewrite lock on
> the two busiest tables for zero change. Step 5's `db:generate` then emitted exactly the
> `organization_id` columns and nothing else — which is how the fix was verified.

#### 1.5.d Test suite

Kept on **mocha** rather than migrated to `bun:test`: the 30 spec files are dense in
`chai` + `sinon-chai` assertions and a framework swap would have been pure churn on top of an
already large module migration. `apps/api/.mocharc.json` (`--import tsx`) plus a `test` script
make `pnpm --filter @optimiq-voice/api test` self-contained. **50 passing, 2 pending** (up from
44 — `test/voice/dialHandler.test.ts` was dead before, see below).

Three test-level repairs, all pre-existing breakage rather than migration fallout:

- `test/voice/dialHandler.test.ts` imported `@optimiq-voice/voice/test/helpers`, a package
  `apps/api` does not depend on. The whole file threw at load and took the suite with it. The
  import was one fixture constant; it now lives in `test/voice/helper.ts`.
- `test/voice/createVoiceClient.test.ts` called `createCreateVoiceClient(container, null)` — an
  arity error, invisible because the old `tsconfig.json` **excluded `test/`** from the program.
- The same file's `instanceOf` assertion: under `mocha --import tsx`, a module reached by a
  hoisted static import and the same module reached by `await import(...)` are evaluated into two
  separate registries, so the statically imported class was never the constructor the factory
  used. Both are now pulled from the same dynamic graph. **This affects assertions only** —
  plain `node --import tsx` does not exhibit it, and neither does the built `dist`.

#### 1.5.e Bugs found and fixed while porting

- **`src/voice/stt/Deepgram.ts` never closed its websocket.** All six teardown paths called
  `connection.destroy()`, which does not exist on `ListenLiveClient`; five were wrapped in a
  `try/catch` that logged "error destroying connection" every time, and the sixth
  (after `resolve()` in `transcribe`) was unguarded. Now `connection.disconnect()`. This was
  invisible while the SDK was imported through `require()` behind an implicit `any`.

#### 1.5.f Bugs found and NOT fixed (owned elsewhere / out of scope)

- `packages/common/src/utils/assertEnvsAreSet.ts` calls `process.exit(1)` after `logger.error`.
  With `LOGS_LEVEL=none` the process dies silently with no output at all — the failure mode when
  the root `.env` is missing is a bare exit code 1 from any test run. It should throw.
- `apps/api` reads three paths relative to the **process working directory**
  (`API_IDENTITY_{PRIVATE,PUBLIC}_KEY_PATH`, `API_INTEGRATIONS_FILE`), so any script whose cwd is
  `apps/api` rather than the repository root cannot find them. The `test` script pins them
  explicitly; `start:dev` still inherits whatever the root `.env` says.
- `config/integrations.json` is referenced by `.env.example.dev` but only
  `config/integrations.example.json` exists, so a fresh checkout cannot boot the runtime.

### Step 2 — Data migration `fnidentity` → base DB — **DONE 2026-08-05**

- [x] 1. `users` → `user` (+ `account` rows under `providerId: "credential"`), `workspaces` →
      `organization`, `workspaceMembers` → `member` / `invitation`, `apiKeys` → `apikey` with
      `referenceId = organization.id`.
- [x] 2. Persist an `accessKeyId → organization.id` mapping table; it is the join key for Step 5.
- [x] 3. Decrypt `@47ng/cloak` fields on read. `verificationCodes` are **not** carried over.
- [x] 4. **Gate:** every existing user can sign in with their existing password; every workspace
      has exactly one owner. `verify:identity-migration` — **19/19**, including live sign-ins.

#### What shipped

| file                                                          | role                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/db/src/schema/legacy/legacy-identity-schema.ts`     | `legacy_workspace_organization` + `legacy_user_account` — the mapping ledger |
| `packages/db/drizzle/20260805222217_legacy_identity_mapping/` | its migration                                                                |
| `apps/api/scripts/identity-migration/plan.ts`                 | the mapping RULES, I/O-free                                                  |
| `apps/api/scripts/migrate-identity-to-organizations.ts`       | the adapter: reads `fnidentity`, writes the base database                    |
| `apps/api/scripts/verify-identity-migration.ts`               | the gate                                                                     |
| `apps/api/test/auth/identityMigrationPlan.test.ts`            | 19 cases over the rules, no database                                         |
| `apps/api/src/auth/legacy-access-key.repository.ts`           | the runtime reader of the mapping, cached both ways                          |

Scripts: `pnpm --filter @optimiq-voice/api migrate:identity [-- --dry-run|--seed-fixtures|--drop-fixtures|--json]`
and `pnpm --filter @optimiq-voice/api verify:identity-migration`.

**Properties of the migration.** Transactional (one target transaction; `--dry-run` is the same
code path with a forced rollback, so a rehearsal hits every constraint the real run will).
Rerunnable — the two mapping tables are its ledger, so a second run reports `usersLinked` /
`organizationsLinked` / `membersExisting` and writes nothing. Empty-source safe: a missing or
empty `fnidentity` is a normal outcome, not an error. `--seed-fixtures` writes a deliberately
adversarial synthetic dataset into the _source_ (two workspaces whose names collide on a slug, an
owner with no `workspace_members` row, a `PENDING` invitee, a legacy-`USER`-role member, a
duplicate membership, an api key), so the rules can be proven on a machine whose `fnidentity` is
empty; `--drop-fixtures` removes exactly those rows.

#### Three corrections to this step as originally written

1. **There is no bcrypt hash.** Item 1 said users move over "with the bcrypt hash". They do not:
   `packages/identity` stores passwords **reversibly** — `db.ts` cloak-`encrypt()`s on write
   (`:468`, `:522`, `:540`) and `decrypt()`s on read (`:255`), and
   `createExchangeCredentials.ts:28` compares the decrypted value to the submitted one with
   `!==`, a plaintext comparison. The migration therefore decrypts and **re-hashes** with
   better-auth's own `hashPassword` (scrypt, from `better-auth/crypto`). A straight column copy
   would have produced accounts nobody could log into — i.e. the gate as written was
   unreachable, and is now reachable and green.
2. **One mapping table was not enough.** A `US…` key identified a _person_ and never scoped a
   telephony row, so mapping it to an organization is meaningless. There are two tables:
   `legacy_workspace_organization` (`WO…` → `organization.id`, the Step 5 join key) and
   `legacy_user_account` (`US…` → `user.id`, plus `password_migrated` so a credential that could
   not be decrypted is _recorded_ rather than silently lost).
3. **API keys keep their secret.** The legacy `accessKeySecret` is 64 characters, exactly
   `@better-auth/api-key`'s `defaultKeyLength`, and the plugin stores `base64url(sha256(key))`.
   The migration decrypts the legacy secret and stores that hash, so an existing integration
   keeps working by moving the same secret from the old exchange to the `x-api-key` header.
   Migrated keys are written with `rate_limit_enabled = false` on purpose: the plugin's default
   is 10 requests/day, which would throttle every migrated integration into failure on day one.

#### Mapping rules worth knowing

- Legacy role → membership role: `WORKSPACE_OWNER`→`owner`, `WORKSPACE_ADMIN`→`admin`,
  `WORKSPACE_MEMBER`/`USER`→`member`, and **anything unrecognised → `member`**. Only the three
  built-ins are produced; the legacy enum has no notion of `manager`/`agent`/`user`, so assigning
  one would be a privilege _guess_. Operators re-grade afterwards through
  `/api/auth/organization/update-member-role`, which accepts all five ids since the Step 4 role
  access control landed.
- `workspaces.owner_ref` is synthesised as an `owner` membership unconditionally and wins every
  role contest, which is what makes "exactly one owner" true by construction rather than by luck.
- `PENDING` memberships become `invitation` rows, not `member` rows.
- `organization.slug` is `not null unique` and the legacy table has no slug: it is derived from
  the name (NFKD, diacritics stripped, kebab-cased, never empty) and collision-suffixed.
- Blocking defects **abort the transaction** instead of being skipped: a duplicate email, a
  workspace whose owner does not exist, a workspace access key that is not a `WO…` key, an api
  key pointing at a missing workspace.

#### Gate, run 2026-08-05 — `verify:identity-migration` **19/19**

It re-reads `fnidentity`, walks the mapping row for row, and then **boots the live auth slice and
signs every migrated user in over HTTP with the password decrypted from the legacy table** —
neither half of the plan's gate is provable by reading rows. It also verifies a migrated API key
through `auth.api.verifyApiKey`, which is the only way to know the migration's local
re-implementation of `defaultKeyHasher` agrees with the plugin's. Local run: 5 users (5 sign-ins,
0 resets required), 3 organizations (3 with exactly one owner), 5 members, 1 invitation, 1 api key.

### Step 3 — Replace `createAuthInterceptor` with a session guard — **DONE 2026-08-05**

- [x] 1. New `apps/api` guard: resolve the caller in order — session cookie →
      `Authorization: Bearer` (bearer plugin) → `x-api-key` (apiKey plugin). **All three are done.**
      Cookie and bearer are handled inside `auth.api.getSession`; `x-api-key` is resolved
      explicitly by `createApiKeySessionResolver` (see the ex-blocker below, now RESOLVED).
- [x] 2. `requireActiveOrganizationId(session)` supplies the tenant id on the HTTP surface; the
      voice server's interceptor stamps the organization id from a signed claim
      (`ORGANIZATION_METADATA_KEY`); and **`getAccessKeyIdFromCall` is deleted** — the gRPC surface
      now gets the same treatment from `apps/api/src/core/createTenancyInterceptor.ts`. See
      "Step 3 items 2/4/5 — what shipped" below.
- [x] 3. `@RequirePermissions(...)` over `PERMISSIONS` / `SYSTEM_ROLE_TEMPLATES`, **global and
      deny-by-default**.
- [x] 4. `withAccess` / `hasAccessToResource` are **deleted**. `apps/api`'s 3 sites moved to RLS
      scoping (`db.forOrganization(...)`); `packages/sipnet`'s 3 sites moved to
      `withTenantResourceAccess`, which cannot use RLS because those rows live in **Routr's**
      database. The _existence-implies-access_ defect is closed in both.
- [x] 5. **Gate:** a cross-tenant request is refused. `verify:auth` checks 14 assert it on the
      HTTP surface for **both** principal kinds (403 for an `x-api-key` caller and for a session
      cookie asking for a different organization's members). The gRPC half is asserted by
      `verify:tenancy` section 5 — the owning tenant reads its own application, another tenant
      reading the same ref gets `null` — and by `test/core/tenancyInterceptor.test.ts`.

#### Step 3 items 2 / 4 / 5 — what shipped (2026-08-05)

The block recorded here previously was a **data** block: the 18 direct `getAccessKeyIdFromCall`
sites did not merely _read_ a tenant id, they **filtered rows by it**, and
`applications.access_key_id` / `secrets.access_key_id` still held the `WO…` string. Step 5 item 1
rewrote those columns, so the swap could finally happen without emptying every list query — and
`verify:tenancy` proves it did not, by running the pre-rewrite SQL and the rewritten facade side
by side for every tenant.

**The tenant is no longer client-supplied.** `apps/api/src/core/createTenancyInterceptor.ts` is
installed on every gRPC service after `createAuthInterceptor`. It reads the token, resolves the
organization, and `metadata.set`s it — overwriting whatever arrived on the wire — exactly as
`packages/voice`'s `createJwksAuthInterceptor` has done since Step 4 item 2.

| token shape                            | tenant claim                         | resolution           |
| -------------------------------------- | ------------------------------------ | -------------------- |
| better-auth per-call token (Step 4)    | `organizationId`                     | used directly        |
| better-auth token, legacy claim slot   | `accessKeyId` = an `organization.id` | used directly        |
| legacy identity token (SDK, CLI, dash) | `access[].accessKeyId` = a `WO…` key | Step 2 ledger lookup |

The third row is why the interceptor is asynchronous — the decision is deferred inside
`onReceiveMetadata`, so the call does not reach a handler until `proceed(metadata)` runs.
`LegacyAccessKeyRepository` memoises both directions, so it is a map hit after the first call for
a tenant.

**The cross-tenant gate.** A caller may still send `accesskeyid` (every released SDK does). It is
no longer trusted, but it is not ignored: if it resolves to a different organization than the token
does, the call is refused with `PERMISSION_DENIED` rather than quietly served against the token's
tenant. Same posture `AuthService.resolveRoleIn` takes on the HTTP surface for an `x-api-key`
principal. A token with no resolvable tenant ends the call — there is deliberately no unscoped
fallback, because the identity-era behaviour (`accessKeyId === undefined` passed straight into a
`where`) _was_ the cross-tenant read.

**Two vocabularies, one source.** `packages/common/src/tenancy/` is a new directory —
**not** `src/identity/`, which is deleted wholesale in Step 9 (sequencing rule 4). It exports:

| symbol                       | meaning                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `getOrganizationIdFromCall`  | the canonical tenant. Throws rather than returning `undefined`.    |
| `getTenantAccessKeyFromCall` | the server-resolved `WO…` key, falling back to the organization id |
| `stamp*` / `find*`           | what the interceptor writes, and the non-throwing reads            |

The second one exists because two consumers still speak the legacy vocabulary and **neither is a
table this migration owns**: Routr verifies the SIP/WebRTC connect token `createCreateTestToken`
signs and matches it against `extended.accessKeyId` on its own rows, and `packages/sipnet` reads
and writes those same rows. Step 6 recommendation (b) — adopted — keeps the SIP edge out of this
migration; Routr's JSONB is rewritten when `apps/sipd` replaces it in Phase 6. For a tenant created
after the cutover there is no `WO…` key and both helpers return the organization id, so the two
vocabularies converge and sipnet needs no second code path.

**`withAccess` is gone, and so is its defect.** It is replaced by two different things, because
the two groups of resources are not alike:

| resource                                  | before                               | after                                                            |
| ----------------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `apps/api` applications / secrets         | `withAccess` + `hasAccessToResource` | `db.forOrganization(orgId)` — PostgreSQL RLS decides visibility  |
| `packages/sipnet` agents/domains/trunks/… | same                                 | `withTenantResourceAccess` — explicit check, Routr owns the rows |

For the first group the row is not "found but refused"; outside the tenant's transaction scope it
**does not exist**, so `getFn` raises the ordinary `NOT_FOUND` and enumeration is closed as a side
effect. For the second, RLS is unavailable, so the check stays in application code — but a resource
with no recorded owner, or one that cannot be read, is now **refused** rather than allowed, and it
compares against the key resolved from the _verified_ token rather than `jwtDecode`'s output.

**Deleted this pass:** `packages/common/src/identity/getAccessKeyIdFromCall.ts`,
`packages/identity/src/utils/withAccess.ts`,
`packages/identity/src/utils/hasAccessToResource.ts`, and the `@optimiq-voice/identity` dependency

- tsconfig project reference from `packages/sipnet`. `createAuthInterceptor` keeps a **private,
  unexported** copy of the header read, because its `tokenHasAccessKeyId` cross-check runs _before_
  the tenancy interceptor overwrites the header, which is precisely what that check wants to compare
  against. It dies with the module in Step 9.

**One behaviour change worth knowing.** `packages/authz`'s `createCheckMethodAuthorized` now reads
the organization **lazily, inside `start`**, rather than in the interceptor body: the tenancy
interceptor resolves asynchronously and stamps the shared `Metadata` instance, so a read taken
while the interceptor chain is still being built would see nothing. `runServices` therefore
installs it after the tenancy interceptor, and an unscoped call is denied rather than passed
through. `AUTHZ_SERVICE_ENABLED` is off by default.

#### Step 3 — what shipped (HTTP surface)

`RequirePermissionsGuard` is registered once as an `APP_GUARD` by `AuthModule`, so it covers every
Nest HTTP route in `apps/api`, including ones added later. Three changes make that safe:

| before                                                | after                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| `@UseGuards(RequirePermissionsGuard)` per controller  | one `{ provide: APP_GUARD, useExisting: RequirePermissionsGuard }`              |
| no `@RequirePermissions` metadata ⇒ **route is open** | no metadata ⇒ **an authenticated session is required**                          |
| no way to declare a route anonymous                   | `@PublicRoute()` (`src/auth/public-route.decorator.ts`), explicit and greppable |

Registering it in `AuthModule` rather than `main.ts` keeps the existing escape hatch intact: an
environment without `DATABASE_URL` / `AUTH_SECRET` / `AUTH_URL` boots `AppModule` alone and behaves
exactly as before. The `/api/auth/*` routes are raw Fastify routes registered outside Nest's
router, so they never reach a guard.

Two pre-existing routes were audited and marked `@PublicRoute()` with the reason at the call site:

- `GET /api/identity/accept-invite` — the link in an invitation email, clicked by someone with no
  session. The `token` query parameter is the credential. Dies in Step 9.
- `GET /api/recordings/:id` — **anonymous, and not safe.** `apps/autopilot` builds
  `${AUTOPILOT_RECORDING_BASE_URL}/<appRef>_<mediaSessionRef>.wav`
  (`src/handleVoiceRequest.ts:134`) and posts it to a customer's `eventsHook` webhook, so the
  fetcher is a third party with no session; guarding it would break every conversation-ended
  webhook. `resolve()` + the `dirname` check stop path traversal, but nothing stops enumeration.
  **Follow-up (not part of this cutover): mint a signed, expiring URL alongside the recording.**

Verification: `apps/api/test/auth/requirePermissionsGuard.test.ts` (7 cases — public bypass,
anonymous denial of an undecorated route, authenticated pass, missing organization, insufficient
role, sufficient role + resolved-access stamping, unscoped-grant-covers-scoped) plus
`verify:auth`'s live 401/403/200 checks.

#### Step 3 ex-blocker — `x-api-key` and `references: "organization"` — **RESOLVED 2026-08-05**

`@better-auth/api-key@1.6.23` promotes an API key into a session in a `before` hook, but only for
keys that reference a **user**:

```js
// dist/index.mjs:2353-2356
if ((config.references ?? "user") !== "user") {
	throw APIError.from("UNAUTHORIZED", API_KEY_ERROR_CODES.INVALID_REFERENCE_ID_FROM_API_KEY);
}
const user = await ctx.context.internalAdapter.findUserById(apiKey.referenceId);
```

`packages/auth` configures `apiKey({ references: "organization" })` deliberately. **Option (a) —
the recommendation — shipped**: `createApiKeySessionResolver` in `src/auth/auth-http.plugin.ts`
calls `auth.api.verifyApiKey` and synthesises the `AppSession` itself. No plugin change, no data
model change, and `references: "organization"` keeps its cascade-on-organization-delete.

Consequences, stated because they are the shape of the abstraction rather than shortcuts:

| property                       | value                                | why                                                                                                         |
| ------------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `session.activeOrganizationId` | the key's `referenceId`              | exactly the tenant claim the guard and every org-scoped repository need, and the caller cannot influence it |
| `activeOrganizationRole`       | `admin`                              | **never `owner`** — a programmatic credential must not be able to delete the organization that issued it    |
| `user.id` / `session.userId`   | the key's id                         | there is no person behind an API key                                                                        |
| `user.email`                   | `""`, and `user.role` is `"api-key"` | anything attributing an action to a human must check this rather than assume a `user` row exists            |
| persistence                    | none                                 | no `session` row is written, so key traffic cannot inflate the session table                                |

Two collaborating changes were required and are worth knowing about:

- `AuthService.resolveAccess` treats a role already on the session as authoritative and skips the
  membership lookup. This is not a cache — it is how a principal with no `member` row is
  represented. Cookie and bearer sessions never carry it, so their path is byte-identical.
- `AuthService.listMembers` now goes through `resolveRoleIn(organizationId, session)`, which keeps
  the cross-tenant gate honest for both principal kinds: a **user** principal re-reads the `member`
  row (so a removed member loses access on the next request, not at session refresh), and a
  **tenant** principal must have asked for the organization its key references.

Coverage: `apps/api/test/auth/apiKeySession.test.ts` (9 cases) plus `verify:auth` section 14 (11
live checks: creation, `referenceId` is the organization, session resolution, admin-not-owner,
not-a-person, a guarded route, cross-tenant refusal for both principal kinds, tampered key).

#### Step 3 fallout — the root mocha suite, repaired 2026-08-06

Commit `415d14659` re-enabled decorators in the root tsconfig, which un-masked a transform crash
that had been swallowing the root run. Underneath it were **21 failures**, all one defect: Step 3
item 2 replaced `getAccessKeyIdFromCall` — which returned `undefined` for an unscoped call — with
`getTenantAccessKeyFromCall` / `getOrganizationIdFromCall`, which **throw**
`MissingTenantScopeError`. Every fixture that stamped only `token` therefore produced `INTERNAL`
before the handler body ran, and the assertions saw `{ code: 13 }` where they expected the real
answer.

Disposition, per suite. **Nothing was deleted or skipped**: the honest reading of the deletion
list is that Step 9 is gated on Steps 1-8 (7 and 8 are not started), so `packages/identity` may
not be retired yet — and it is not dead code either, `apps/api/src/core/services.ts:24` still
registers `buildIdentityService`. Its handlers had already been rewired to
`getTenantAccessKeyFromCall` by Step 3; only their fixtures lagged.

| suite                                                          | disposition | what changed                              |
| -------------------------------------------------------------- | ----------- | ----------------------------------------- |
| `@identity[apikeys/createApiKey]` (2)                          | fixed       | fixture stamps the server-resolved tenant |
| `@identity[workspace/inviteUserToWorkspace]` (3)               | fixed       | same                                      |
| `@identity[workspace/removeUserFromWorkspace]` (2)             | fixed       | same                                      |
| `@identity[workspace/resendWorkspaceMembershipInvitation]` (1) | fixed       | same                                      |
| `@sipnet[sipnet/createNumber]` (2)                             | fixed       | fixture stamps `organizationid` too       |
| `@sipnet[resources/{create,delete,get,list,update}]` (11)      | fixed       | stamps + the two semantic changes below   |

Two fixtures record a **behaviour change** rather than a missing stamp, and both are Step 3 item 4
working as designed:

1. `getResource`'s not-found message is `withTenantResourceAccess`'s own (`Domain not found: 123`),
   not `handleError`'s `The requested resource was not found` — the ownership check now answers
   **before** the SDK's error reaches `handleError`, because a read that fails is not an
   authorisation however it failed.
2. Cross-tenant is `NOT_FOUND`, not `PERMISSION_DENIED`, and carries the **same message** as an
   absent row. Confirming a foreign ref exists would make the endpoint an enumeration oracle.

Three cases were **added** to `getResource`, because those are exactly the properties `withAccess`
did not have and nothing else pins: a foreign-owned row is refused and leaks nothing; a row with
no recorded owner is refused (the `if (!extended) return true` defect, now closed); and an
unscoped call is refused **without reading anything** — `getDomain` is never called.

The shared fixtures are `packages/identity/test/utils.ts` (`createScopedMetadata`) and
`packages/sipnet/test/testCall.ts`. Both stamp through the real `stampOrganizationIdOnCall` /
`stampTenantAccessKeyOnCall` rather than literal header strings, so the metadata key names cannot
drift between `createTenancyInterceptor` and the suites that stand in for it.

Root `pnpm test`: **564 passing, 3 pending, 0 failing** (was 540 / 3 / 21).

### Step 4 — Per-call and service tokens — **DONE 2026-08-05**

- [x] 1. Replace `createGenerateCallAccessToken` with the better-auth jwt plugin: a short-lived
      (`30s`) token whose payload carries `organizationId` and the application ref.
- [x] 2. `packages/voice/src/VoiceServer.ts`: JWKS verification via
      `jose.createRemoteJWKSet(new URL("/api/auth/jwks", AUTH_URL))`.
- [x] 3. `apps/autopilot`: keeps consuming `sessionToken`; only the verification path changed.
      `AUTOPILOT_SKIP_IDENTITY` is retired in favour of `AUTH_URL`.
- [x] 4. **The minter is flipped.** `apps/api/src/voice/createCreateVoiceClient.ts` mints through
      better-auth; `createGenerateCallAccessToken` and `identityConfig` are gone from that file
      and the identity signer has **no callers left on the call path**.
      **Residual gate:** the plan's wording — "an inbound call reaches an autopilot application
      end to end" — needs Asterisk + Routr + a real SIP call, which this environment cannot run.
      Everything short of the SIP leg is proven: see below.

#### Step 4 item 4 — what shipped (2026-08-05)

The flip landed **together with Step 2**, as this plan required — the voice server has been
verifying JWKS-signed tokens since item 2, so shipping the minter separately would have left it
verifying tokens the API did not mint.

| before                                                         | after                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `createGenerateCallAccessToken(identityConfig)` at module load | `createCallAccessTokenMinter(platform)` per call                         |
| RS256 over `.keys/private.pem`                                 | the `jwks` key better-auth manages, published at `/api/auth/jwks`        |
| tenant = the `WO…` access key `createContainer` returns        | tenant = `organization.id`, resolved through the Step 2 mapping          |
| no call binding                                                | `callRef` binds the token to one call                                    |
| a missing key file meant a crash at import                     | no auth slice, or an unmapped access key, means **no token and no call** |

**How the ARI dispatcher reaches better-auth.** `RuntimeHostService` starts the legacy runtime
(gRPC servers, ARI dispatcher, NATS) from `onApplicationBootstrap`, outside the Nest container, so
nothing there can inject `AUTH_PLATFORM`. `src/auth/auth-platform.registry.ts` is a process-global
handle that `AuthModule` publishes in its constructor and clears on shutdown. The alternatives
were worse: a second `AuthPlatform` would open a second PostgreSQL pool and a second JWKS cache
against the same database, and rewriting the ARI path into Nest providers is the P1 slice rewrite,
not a step of this cutover. The registry fails **closed** (`requireAuthRuntime` throws) and
disappears when the voice path becomes a feature slice.

**`skipTokenVerification` is unchanged and still correct.** It is set only when
`NODE_ENV=development` **and** no `AUTH_URL` is configured (`apps/autopilot/src/envs.ts:45`).
With the minter flipped, an integration environment no longer needs it at all — the API mints what
the voice server verifies — so it is now purely the local-development escape hatch it was written
to be.

**Verification.** `apps/api/test/voice/createVoiceClient.test.ts` grew from 1 case to 3: the happy
path now asserts the signed payload carries `organizationId` / `accessKeyId` = the organization
(not the legacy `WO…` key) plus `appRef` / `callRef`, and two new cases assert it fails closed
when the access key was never migrated (`UnmappedAccessKeyError`) and when the auth slice is not
mounted (`AuthRuntimeUnavailableError`). `verify:call-token` (27/27) still proves the minter and
the real `packages/voice` verifier agree over live HTTP.

#### Step 4 item 1 — what shipped

`apps/api/src/auth/call-token.service.ts`. Minting goes through **`auth.api.signJWT`**, a
`serverOnly` endpoint of better-auth's jwt plugin that signs an arbitrary payload with the active
JWKS key — no session, no HTTP round trip. The plugin's `definePayload` hook is deliberately not
used: it derives claims from a session, and a call has none.

Surface:

- `buildCallAccessTokenClaims(request)` — pure, throws `CallAccessTokenScopeError` if any of
  `organizationId` / `appRef` / `callRef` is blank.
- `createCallAccessTokenMinter(platform)` — the closure form.
- `CallTokenService` — the Nest provider, exported from `AuthModule`.

**Claim mapping.** The payload is a strict superset of the identity-era one, so `packages/voice`
can move to JWKS verification without simultaneously moving off the `access[]` shape:

| legacy `createGenerateCallAccessToken`             | new                                                            |
| -------------------------------------------------- | -------------------------------------------------------------- |
| `iss` = `API_IDENTITY_ISSUER`                      | `iss` = the jwt plugin's issuer (`AUTH_URL`)                   |
| `sub` = `appRef`                                   | `sub` = `appRef` — **unchanged**                               |
| `aud` = `API_IDENTITY_AUDIENCE`                    | `aud` = `"optimiq-voice/voice"`                                |
| `tokenUse: "access"`                               | `tokenUse: "access"` — **unchanged**                           |
| `accessKeyId` = workspace `WO…` key                | `accessKeyId` = `organization.id` (same slot)                  |
| `access: [{ accessKeyId, role: "VOICE_SERVICE" }]` | same shape, organization id inside                             |
| —                                                  | `organizationId` — the canonical tenant claim                  |
| —                                                  | `appRef` — explicit, no longer only in `sub`                   |
| —                                                  | `callRef` — **new**, binds the token to one call               |
| `iat` (stamped by `jsonwebtoken`)                  | `iat` stamped explicitly (the plugin sets only `exp`)          |
| RS256 with `.keys/private.pem`                     | the jwks key (EdDSA by default), published at `/api/auth/jwks` |
| `expiresIn: "30s"`                                 | `"30s"` — **unchanged**                                        |

`accessKeyId` and `access[]` deliberately carry the organization id during coexistence: every
consumer of them (`hasAccess`, `tokenHasAccessKeyId` in `packages/common/src/identity/`) only
compares them for equality against the tenant identifier on the wire, so the value changes and
the shape does not. Both claims die with `packages/common/src/identity/` in Step 9.

**Verification.**

- `apps/api/test/auth/callTokenClaims.test.ts` — pins the claim contract, no I/O.
- `pnpm --filter @optimiq-voice/api verify:call-token` — **18/18**. Boots the slice against real
  PostgreSQL, mints a token, fetches `GET /api/auth/jwks`, verifies with
  `jose.createLocalJWKSet` + `jwtVerify`, asserts every claim, and proves a re-signed payload is
  rejected. This is exactly the verification item 2 will put in `VoiceServer.ts`.
  (It reuses `verify-auth-slice.ts`'s `AUTH_SECRET` on purpose: the jwt plugin encrypts the JWKS
  private key with it, so two scripts against one database must agree.)

#### Step 4 items 2 and 3 — what shipped (2026-08-05)

`packages/voice/src/callTokenVerifier.ts` (the logic) and
`packages/voice/src/createJwksAuthInterceptor.ts` (the gRPC adapter) replace
`getPublicKey(config.identityAddress)` + `createAuthInterceptor`. `getPublicKey` now has **zero
consumers**; `@optimiq-voice/identity` is gone from `packages/voice/package.json`.

| before                                                          | after                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `getPublicKey(identityAddress)` gRPC round trip at server start | nothing at start; `createRemoteJWKSet` fetches on first call and caches                                                   |
| RS256 PEM from `.keys/public.pem` via the identity service      | whatever `/api/auth/jwks` publishes (EdDSA by default), rotation-aware                                                    |
| `ServerConfig.identityAddress` (default `api.optimiq.health`)   | `ServerConfig.authUrl`, **no default** — misconfiguration fails closed                                                    |
| `ServerConfig.skipIdentity` / `AUTOPILOT_SKIP_IDENTITY`         | `ServerConfig.skipTokenVerification`, set only when `NODE_ENV=development` **and** no `AUTH_URL`                          |
| tenant read from the client-supplied `accesskeyid` metadata key | tenant read from the signed `organizationId` claim and **stamped onto** `organizationid` metadata, overwriting the caller |
| `hasAccess(decoded, path)` against `roles.ts`                   | none — one method, and `aud: "optimiq-voice/voice"` on a 30 s per-call token IS the decision                              |

Two mechanical notes worth keeping:

- **Verification is asynchronous now.** The identity-era interceptor could decide synchronously
  because it already held the PEM. `createJwksAuthInterceptor` defers the decision inside
  `onReceiveMetadata`: the call does not reach the handler until `next(metadata)` runs, and a
  rejection ends it with `UNAUTHENTICATED` first.
- **`jose@6` is ESM-only and `packages/voice` emits CommonJS.** Its tsconfig moved to
  `module: node16` / `moduleResolution: node16`, which reads jose's `exports` map for types and —
  because the package has no `"type": "module"` — still emits CommonJS, with `import()` left
  intact rather than downlevelled to `require`. jose is therefore genuinely loaded as ESM at
  runtime (verified against the built `dist`). A static import would be TS1479; the type-only
  import carries `with { "resolution-mode": "import" }` for the same reason.

`apps/autopilot` keeps consuming `sessionToken` unchanged (`loadAssistantFromAPI.ts` still replays
it into `Applications/GetApplication`); only `envs.ts`, `server.ts` and `voiceServerSetup.ts`
moved to `AUTH_URL`.

**Gate, run 2026-08-05:** `pnpm --filter @optimiq-voice/api verify:call-token` → **27/27** (18
before). Section 6 boots the auth slice, mints a token, then runs
`createCallTokenVerifier({ authUrl })` — the real one `VoiceServer` uses — over real HTTP against
the live JWKS: accepts the fresh token and reads `organizationId` / `appRef` / `callRef`; rejects a
missing token, a garbage token, a re-signed payload and a wrong audience; and refuses to be
constructed without an `AUTH_URL`.

**What still gates the live call path (item 4) — RESOLVED except the SIP leg.** The minter is
flipped (see "Step 4 item 4 — what shipped" above). The only unexercised part is the physical
call: Asterisk answering, the dialplan setting `APP_REF` / `CALL_REF`, Routr routing, and
autopilot replaying `sessionToken` into `Applications/GetApplication`. Re-run
`verify:call-token` plus one real inbound call in an environment that has Asterisk and Routr to
close it.

#### Step 4 blocker — role access control in `packages/auth` — **RESOLVED 2026-08-05**

Finding 3 (only 3 of the 5 `SYSTEM_ROLE_TEMPLATES` reachable) could not be fixed from `apps/api`,
because `createAuth` hard-coded its `plugins` array. It is fixed in `packages/auth` as the plan
prescribed:

- `packages/auth/src/access-control.ts` — `buildOrganizationStatements()` merges
  `defaultStatements` with `buildAccessControlStatements()` (which was, until now, referenced by
  nothing) and **hard-errors on a resource collision**; `buildOrganizationAccessControl()` builds
  the `AccessControl` and a roles map that starts from `defaultRoles` and layers each template on
  top of the plugin statements its `membershipRole` already carried.
- `CreateAuthOptions.organizationRoles?: boolean | { creatorRole?: SystemRoleId }`, **default
  enabled**. `organizationRoles: false` restores better-auth's three built-ins verbatim.
- `creatorRole` stays `"owner"`, and `owner` / `admin` / `member` all stay resolvable.

The merge is not cosmetic: better-auth resolves roles as `options.roles || defaultRoles`
(`dist/plugins/organization/has-permission.mjs:7`) — a **replacement**. A roles map built only
from the registry would leave `owner` without `invitation: ["create"]` and break invitations.
Specs assert `defaultStatements` survives the merge and that `owner`/`admin` keep
`invitation.create` while `manager`/`agent` do not.

The unlock is concrete: `invite-member` and `update-member-role` validate the requested role
against `Object.keys(defaultRoles) ∪ Object.keys(options.roles)`
(`dist/plugins/organization/routes/crud-members.mjs:258`, `crud-invites.mjs:104-122`) and returned
`ROLE_NOT_FOUND: manager` before this landed — a failure reproduced and then fixed inside
`verify:auth` (checks 27-38). `apps/api/src/auth/role-permissions.ts` needed **no change**, as
predicted: `manager` resolves to 43 permissions and `agent` to 15, instead of both falling back to
`user`'s 11.

Coverage: `packages/auth` bun specs **170** (151 before) — `access-control.spec.ts` is new (14
cases) and `auth.spec.ts` gained 5 composition assertions.

### Step 5 — Enable RLS on org-scoped tables — **DONE 2026-08-05**

1. [x] Add `organization_id uuid not null` to every telephony table; backfill from the Step 2
       mapping via `extended->>'accessKeyId'` / `access_key_id`. **The legacy column is kept for
       now** — see "Why `access_key_id` is not dropped yet" below; it dies in Step 9 with the
       ledger.
2. [x] Create the tenant role, per-table policies (`tenantOrganizationScope`) and grants for the
       `apps/api` database. (Already true for `packages/pbx-db` and `packages/cdr-db`.)
3. [x] Wire `assertTenantRlsPreflight` into `apps/api` boot **before** the server is created.
4. [x] Route every org-scoped repository through `withTenantScope`.
5. [x] **Gate:** `db:preflight:tenant-rls` runs and is clean — now for three databases, not two.

#### Correction — `packages/pbx-db` exists, and its RLS is live

The blocker recorded here previously said "`packages/pbx-db` is referenced by the root
`db:generate` / `db:migrate` scripts but does not exist in the workspace." **That is wrong.**
Verified 2026-08-05 against the local stack:

- `packages/pbx-db/` is a complete bounded-context package — `src/schema/` (20 files),
  `src/tenant.ts`, `src/rls-preflight-plan.ts`, `src/pbx-tenant-rls.integration.spec.ts`,
  `scripts/{migrate,tenant-rls-preflight}.ts`, and two migrations
  (`20260805204846_pbx_baseline`, `20260805204916_pbx_tenant_grants`).
- The live `optimiq_pbx` database on `:5433` has **35 tables**, the `pbx_tenant_tls` role and 36
  policies. `optimiq_cdr` has `cdr_tenant_tls` and 3 tenant tables.
- Both pass the preflight: `expected 35 / introspected 35 / errors []` and
  `expected 3 / introspected 3 / errors []`.

#### Item 5 — what shipped

`packages/db/scripts/tenant-rls-preflight.ts` (the missing script `db:preflight:tenant-rls` has
pointed at since P0) plus `packages/db/src/rls-preflight-plan.ts`.

It is a **shared runner**, not a base-DB-specific script, because `packages/pbx-db` and
`packages/cdr-db` already had near-identical copies:

```
# this database's own contract
DATABASE_URL=… bun run scripts/tenant-rls-preflight.ts

# any bounded context
bun run scripts/tenant-rls-preflight.ts \
  --plan-module ../../pbx-db/src/rls-preflight-plan --plan-export PBX_TENANT_RLS_PLAN \
  --url postgresql://…/optimiq_pbx --require-tables
```

Two design notes:

- **`--plan-module` is a dynamic `import()`, not a static one.** The oikos rule is that the base
  package owns shared infrastructure and context DBs depend on it, never the reverse
  (`plans/reference/oikos-conventions.md` §5). A static import of `@optimiq-voice/pbx-db` here
  would invert that; naming the module at the call site does not.
- **An empty plan is not silently a pass.** `evaluateTenantRlsPreflight` returns `ok: true` for a
  plan with no expectations, which would make a misconfigured invocation indistinguishable from a
  green gate. The JSON output carries `planEmpty`, and `--require-tables` turns an empty plan into
  a non-zero exit.

`BASE_TENANT_RLS_PLAN` is **deliberately empty**: this database holds only platform-global tables.
`organization` and `member` _define_ the tenant boundary rather than living inside one, and a
policy on them would make the very lookups that resolve a session unrunnable. The two Step 2
`legacy_*` mapping tables are likewise platform-global and die in Step 9.

#### The environment that was missing — provisioned 2026-08-05

The `apps/api` database did not exist on this machine, which is why items 1-4 were blocked.
`optimiq-voice` now lives on the same `:5433` container as `optimiq` (base), `optimiq_pbx`,
`optimiq_cdr` and `fnidentity`; `node scripts/db-provision.mjs` applies the four legacy Prisma
migrations plus the drizzle folder. The fixture set is a two-step chain, so it is a function of the
Step 2 machinery rather than a second constant that can drift:

```
API_CLOAK_ENCRYPTION_KEY=… migrate:identity -- --seed-fixtures   # 3 tenants in the ledger
backfill:tenancy -- --seed-fixtures                              # 6 applications, 6 tts, 6 secrets
```

#### Item 1 — the column rewrite, in three phases

Sequencing rule 2 says data before enforcement, and the reason `NOT NULL` cannot simply be declared
is that **the mapping lives in a different database**. `legacy_workspace_organization` is in the
base database better-auth owns; a drizzle migration for `apps/api` has one connection and no way to
reach it. So the join happens in application code that holds both, and the constraint is a separate
phase behind a guard:

| phase | artifact                                                   | what it does                                                          |
| ----- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| 1     | `drizzle/20260805225315_tenancy_organization_id/`          | adds `organization_id uuid` **nullable** + a btree index, to 5 tables |
| 2     | `scripts/backfill-tenancy-organization-id.ts`              | joins the ledger, writes the column                                   |
| 3     | `drizzle/20260805225550_tenancy_organization_id_not_null/` | **guarded** `SET NOT NULL`                                            |

Phase 3's guard is the mechanical form of the rule. It counts NULLs per table in a `DO` block and
`RAISE EXCEPTION`s with the exact command to run. On a fresh install there are no rows, so it is
trivially satisfied and lands through the ordinary deploy path; on an existing install with
un-backfilled rows the **deploy fails there**, loudly, with phase 1 still committed so the backfill
can proceed and the deploy be retried. It deliberately does **not** no-op when rows remain — a
silent skip would ship an unenforced tenant column, which is the outcome the whole sequence exists
to prevent. `--finalize` on the backfill applies the same `ALTER` (idempotent) after verifying, so
the operator path is `db:deploy` → `backfill:tenancy --finalize` → `db:deploy`.

**Five tables, not two.** `applications` and `secrets` carry the tenant themselves; `tts_services`,
`stt_services` and `intelligence_services` hang off an application by `application_ref` and
inherit it, which is why the backfill has a source pass and a derived pass in that order.
`products` is excluded on purpose: it is a platform-global catalogue seeded at boot by the owning
principal, it has no tenant, and it gets neither a grant nor a policy.

**Backfill properties** (the contract Step 2's migration established, kept):

- **Transactional**, with `--dry-run` as the same code path plus a forced rollback.
- **Rerunnable** — only `organization_id is null` rows are considered; a second run reports
  `alreadyScoped` and writes nothing. Verified by running it twice.
- **Never guesses.** `scripts/tenancy/plan.ts` is the I/O-free rule set and it is total:
  `mapped` (ledger hit), `self` (the value is already a _known_ organization id — a row written
  after the cutover), `blank`, `unmapped`. A well-formed uuid that is not a known organization is
  **unmapped**, not accepted, so a stray value cannot become a tenant nobody can administer. An
  unresolved row stays NULL, is counted and is printed, and blocks `--finalize`.
- **Additive** — `access_key_id` is untouched.

**Why `access_key_id` is not dropped yet.** The plan's item 1 said "drop the legacy column". Doing
that now would break three things that are explicitly out of Step 5's scope: the SIP connect token
Routr verifies (Step 6 recommendation (b)), `packages/sipnet`'s reads of Routr's `extended` JSONB,
and the `legacy_workspace_organization` ledger's usefulness for re-deriving the backfill in another
environment (§ Step 9 already says the ledger must outlive the rewrite for exactly this reason).
It is on the Step 9 list instead. Rows written after the cutover store the **organization id** in
`access_key_id`, the same coexistence trick Step 4 applied to the token's `accessKeyId` claim, so
the column is a legacy artifact rather than a second source of truth.

#### Items 2 and 3 — the RLS posture for `apps/api`

`api_tenant_tls`, `NOINHERIT`, one `<table>_tenant_isolation` policy per table, `USING` and
`WITH CHECK` both `organization_id = nullif(current_setting('api_tenant_tls.organization_id',
true), '')::uuid`. Identical in shape to `packages/pbx-db`, and asserted by the same shared
introspector. `drizzle/20260805225715_api_tenant_rls/` is generated from `src/core/db/schema.ts`;
`drizzle/20260805225800_api_tenant_grants/` is hand-written because privileges cannot be expressed
in a Drizzle schema.

Three deliberate departures from the pbx precedent:

1. **`CREATE ROLE` is wrapped in an existence check.** PostgreSQL roles are _cluster_-wide while
   migrations are per-database, so two `apps/api` databases in one cluster (staging plus a restore)
   would otherwise fail the second deploy on a role that already exists and is already correct.
2. **The role and the policy predicate are rebuilt from string helpers, not imported as objects.**
   `apps/api` pulls in `pg` / `@types/pg` and `packages/db` does not, so pnpm resolves two separate
   (structurally identical, nominally incompatible) instances of `drizzle-orm@1.0.0-rc.4` — the
   same gotcha `legacy-access-key.repository.ts` documented. Handing a `pgRole()` built by one to a
   `pgPolicy({ to })` imported from the other is a type error, and drizzle-kit would be serialising
   an object from a foreign registry. Only `createTenantDatabaseContext` / `buildTenantScopeSql`
   cross the boundary, because they are pure functions over strings; `src/core/db/tenant.ts` holds
   the rebuild and `test/core/tenantContext.test.ts` pins the two representations together so they
   cannot drift.
3. **`forceRowSecurity` stays false.** The migration principal owns these tables and must keep
   bypassing RLS, or migrations and the `products` seed could not run.

Item 3 is `assertTenantRlsPreflight` in `main.ts`, **before `NestFactory.create`**. A policy that
silently failed to apply looks exactly like one that works, until the day it does not; booting is
the last moment that can be turned into a refusal to start rather than a leak.

#### Item 4 — what "route every org-scoped repository through `withTenantScope`" turned into

The note here previously said item 4 "still has nothing to route", because `apps/api` has no
repositories — every caller goes through the Prisma-shaped `db.*` facade in `src/core/db.ts`. That
was true, and it stayed true; what changed is that the facade now has a tenant-scoped door:

```ts
db.forOrganization(organizationId).application.findMany({ where: { organizationId }, … })
```

`forOrganization` returns a `TenantDatabase` — a `Pick` of the facade that **omits `product`**,
because a tenant transaction must not touch the platform-global catalogue and the type should say
so before PostgreSQL does. Each delegate method opens its own transaction, issues
`set local role api_tenant_tls` and `set_config(..., true)`, and runs the existing facade body
inside it. Per-call rather than a long-lived scoped handle: a gRPC handler does one or two reads,
and a transaction that outlived the statement would pin a pool connection for the whole request.
Both statements are transaction-scoped, so a pooled connection is restored on commit or rollback
and one tenant's scope can never leak into the next checkout.

The explicit `where: { organizationId }` filters are kept alongside RLS rather than replaced by it.
They are what `verify:tenancy` compares against the pre-rewrite SQL; RLS is the enforcement that
does not depend on anyone remembering to write them.

**A consequence worth stating.** `createGetFnUtil` in both `applications/` and `secrets/` now takes
`(organizationId, ref)`. Outside the tenant's scope the row is genuinely absent, so a cross-tenant
`GET` / `UPDATE` / `DELETE` raises `NOT_FOUND` rather than `PERMISSION_DENIED`. That is not a
downgrade — it is what closes enumeration, and it is the same answer a caller gets for a ref that
never existed.

**And one deletion the Step 4 notes predicted.** `IntegrationsContainer` carries `organizationId`
straight from `applications.organization_id` now, so `createCreateVoiceClient`'s per-call ledger
round trip — and the `UnmappedAccessKeyError` it could raise — is gone from the inbound-call path.

#### Gate — `verify:tenancy` **22/22**

`pnpm --filter @optimiq-voice/api verify:tenancy` is the new gate, and its core is a **before/after
list-parity proof** rather than an assertion:

- the **legacy** query shape is reproduced in raw SQL exactly as `src/core/db.ts` wrote it before
  this step (`where access_key_id = $1`, same paging);
- the **new** shape goes through the real, rewritten facade, including `forOrganization(...)`, so
  it runs as `api_tenant_tls` under row-level security;
- for every tenant in the ledger, on a full page and on a partial page, the two must agree.

Sections 4 and 5 then prove the half parity cannot: the tenant role sees exactly its own rows
(2 of 6 per tenant on the local fixtures), an **unscoped** tenant transaction sees **zero** — a
denial, never a leak — a foreign ref reads back as `null` rather than "found but refused", and a
blank organization id is refused before a transaction opens.

One thing the gate deliberately does **not** assert: that a partial page returns the _same_ row
before and after. Neither query has an `ORDER BY` on the non-cursor path (recorded in §6), so two
executions may legitimately differ; what must hold, and is asserted, is that every row on the page
belongs to the tenant that asked for it.

#### The three-phase sequence, exercised on throwaway databases

Asserting the guard's behaviour is not the same as running it, so both paths were run end to end
against real PostgreSQL and then dropped:

| scenario                                                | result                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **fresh install** — empty database, `db:deploy`         | all 5 migrations apply in one pass; `organization_id` lands `NOT NULL`                  |
| **existing install** — one row with an unmigrated `WO…` | deploy **fails at phase 3**; phases 1-2 stay committed (2 rows in the migrations table) |
| `backfill:tenancy --finalize` on that database          | refuses: `applications: 1 row(s) have an access_key_id that maps to no organization`    |
| after remediating the row, backfill, then `db:deploy`   | `mapped=1`, deploy completes, 5 migrations recorded                                     |

That is the whole point of splitting the constraint out of the migration that declares it: the bad
case is a failed deploy with the remediation command in the error, and it is recoverable by running
that command.

### Step 6 — SIP connect token / key retirement (independent track)

1. `createCreateTestToken` must keep producing a token **Routr can verify**. Either
   (a) keep RSA and configure the jwt plugin with `algorithm: "RS256"`, exporting the
   better-auth JWKS public key to `.keys/public.pem` for Routr, or
   (b) leave the SIP connect token on its own dedicated RSA keypair until Routr is replaced by
   `apps/sipd` in Phase 6.
   **Recommendation: (b) — ADOPTED 2026-08-05.** It decouples the auth cutover from the SIP edge
   entirely; the only cost is one narrowly scoped keypair that dies with Routr.
2. Only after (a) or (b) is settled may `.scripts/gen-keypair.sh` change or be removed.

**Consequences of adopting (b), recorded so nothing removes the keypair by accident.** The RSA
keypair now has exactly **one** remaining purpose in the repository: the SIP/WebRTC connect token
that `apps/api/src/applications/createCreateTestToken.ts` signs and Routr verifies
(`compose.yaml:102,122`, `compose.dev.yaml:52`). Everything else that used to read it is gone —
`packages/voice` verifies through JWKS (Step 4 item 2), and as of Step 4 item 4 the per-call
signer does too. `.scripts/gen-keypair.sh`, `API_IDENTITY_{PRIVATE,PUBLIC}_KEY_PATH` and
`generate:keypair` / `prestart:services` / `pretest` therefore stay until Routr is replaced by
`apps/sipd` in Phase 6, and Step 8 item 2 must **not** delete those two variables with the rest of
the `API_IDENTITY_*` block. This is the only reason `apps/api` still depends on `jsonwebtoken`.

### Step 7 — SDK / dashboard / CLI swap

> **Not started; unblocked but deliberately deferred (2026-08-05).** Its hard prerequisite —
> "the SDK and CLI move to API-key auth" — is now satisfied: `x-api-key` resolves to a
> tenant-scoped session (Step 3), and Step 2 migrated every legacy `accessKeySecret` into a
> working better-auth key, so an existing integration keeps its credential and only changes how it
> presents it. What is NOT resolved is the target surface: `apps/web` is being built in parallel
> and item 5 ("regenerate the SDK from the OpenAPI document once REST replaces gRPC-web") means
> `packages/sdk` should be regenerated rather than hand-ported. Doing items 1-4 by hand now would
> be rewritten within the same phase.

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

> **Not started (2026-08-05).** Item 4 (`db:generate` / `db:migrate` point at `@optimiq-voice/db`
> only) and item 5 (drop `fnidentity`) share one precondition, stated in §5: _the Step 2 backfill
> must be verified in every environment_. It is verified in exactly one — this development stack —
> so the `fnidentity` fan-out in the root `package.json` deliberately stays.
>
> **The per-environment sequence is now longer, and its order matters.** Provisioning the `apps/api`
> database is done here (Step 5), but every other environment must run, in this order:
> `db:deploy` (phase 1 lands, phase 3 fails loudly if there are rows) → `migrate:identity` →
> `verify:identity-migration` → `backfill:tenancy --dry-run` → `backfill:tenancy --finalize` →
> `db:deploy` → `verify:tenancy`. Only **then** items 3-5 of this step, in one change.
>
> Item 2 must keep `API_IDENTITY_PRIVATE_KEY_PATH` / `API_IDENTITY_PUBLIC_KEY_PATH` — see the
> Step 6 note; every other `API_IDENTITY_*` variable in §2.7 is now unreferenced by the auth path.

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
packages/identity-client/                        # DELETED 2026-08-05
packages/common/src/identity/                    # 12 files: interceptor, roles, token utils
                                                 #   getPublicKey.ts already has zero consumers
packages/common/src/protos/identity.proto
packages/types/src/identity.types.ts             # + its re-export in packages/types/src/index.ts
packages/sdk/src/generated/{node,web}/identity*  # regenerated surface
packages/sdk/src/{Users,Workspaces,ApiKeys}.ts   # replaced by better-auth client calls
packages/sdk/src/client/{TokenRefresherNode,TokenRefresherWeb,isJwtExpired}.ts
.github/workflows/publish-identity.yaml
.github/workflows/release.yaml                   # remove the publish-identity job + its needs entry (:122-126, :139)
.scripts/gen-code-proto.sh                       # remove the identity_pb / IdentityServiceClientPb targets (:26, :44)
.oxfmtrc.json                                    # DONE 2026-08-05 (identity-client ignore removed)
packages/sipnet/package.json                     # DONE 2026-08-05 (dependency + tsconfig project
                                                 #   reference removed; packages/voice DONE too)
apps/api/src/core/identityConfig.ts
apps/api/src/http/identity-invite.controller.ts  # replaced by better-auth accept-invitation
openspec/changes/{identity-client,identity-standalone-service}/  # archive
packages/{identity,identity-client}/.lerna-changed-buster-249

# added 2026-08-05 — the Step 2 coexistence artifacts, deleted WITH fnidentity
packages/db/src/schema/legacy/                   # legacy_workspace_organization, legacy_user_account
apps/api/scripts/identity-migration/             # + migrate-identity-to-organizations.ts,
apps/api/scripts/verify-identity-migration.ts    #   verify-identity-migration.ts
apps/api/src/auth/legacy-access-key.repository.ts
apps/api/src/auth/auth-platform.registry.ts      # only once the voice path is a Nest feature slice

# added 2026-08-05 — the Step 5 coexistence artifacts
applications.access_key_id  /  secrets.access_key_id   # a `drop column` migration in apps/api;
                                                 #   see "Why access_key_id is not dropped yet"
apps/api/scripts/tenancy/ + backfill-tenancy-organization-id.ts   # the backfill and its rules
packages/common/src/tenancy/getTenantAccessKeyFromCall            # dies with Routr (Phase 6),
packages/sipnet/src/resources/withTenantResourceAccess.ts         #   NOT with fnidentity
```

**Two different clocks.** The `legacy_*` tables and the backfill machinery die with `fnidentity`.
`getTenantAccessKeyFromCall` and `withTenantResourceAccess` die with **Routr**, in Phase 6, because
what they serve is Routr's `extended.accessKeyId` JSONB and the SIP connect token — neither of
which this migration owns (Step 6, recommendation (b)). Deleting them on the `fnidentity` clock
would break the SIP edge.

The `legacy_*` tables need a `drop table` migration in `packages/db`, not just a source deletion.
Do it only after Step 5 item 1 has rewritten every telephony row to carry `organization_id` — the
mapping is the sole record of which `WO…` key became which organization, and once it is gone the
backfill cannot be re-derived.

Deprecate (do not delete) the published npm packages `@optimiq-voice/identity@0.22.3` and
`@optimiq-voice/identity-client@0.22.0`.

---

## 4. Sequencing rules

1. **Additive first.** better-auth is mounted and exercised (Step 1) before a single identity
   file changes. Both auth paths coexist for at least one deploy.
2. **Data before enforcement.** The `accessKeyId → organization.id` mapping (Step 2) must exist
   before the tenant column backfill (Step 5); RLS is enabled last so a bad backfill is
   recoverable rather than a lockout. **Made mechanical 2026-08-05:** the tenant column lands
   nullable in one migration, is backfilled by a script that can reach both databases, and only
   then does a _separate, guarded_ migration apply `NOT NULL` — failing the deploy with the exact
   remediation command rather than either skipping silently or locking anyone out. The same rule is
   why the 18 `getAccessKeyIdFromCall` sites could not be swapped until the columns were rewritten:
   swapping first would have turned every list query into an empty result.
3. **The SIP connect token is not part of this migration** (Step 6, recommendation (b)). It is
   the only thing forcing RSA-2048 on the system and it dies with Routr.
4. **`packages/common/src/identity/` is deleted last.** It is the actual auth implementation; the
   `packages/identity` deletion is cosmetic by comparison.
5. Every step ends with an explicit gate; no step ships without it.

## 5. Cheap wins — **ALL TAKEN 2026-08-05**

- [x] Remove `@optimiq-voice/identity` from `packages/voice/package.json` — it is never imported.
- [x] Remove the empty `import {} from "@optimiq-voice/identity";` in
      `apps/api/src/secrets/listSecrets.ts:9`.
- [x] Delete `packages/identity-client` (zero consumers, zero lockfile importers) and its
      `.oxfmtrc.json` ignore entry. Its `openspec/changes/identity-client/` archive and the
      `.lerna-changed-buster-249` marker remain on the Step 9 list.

The root `package.json` `db:generate` / `db:migrate` still fan out to `@optimiq-voice/identity`;
that is Step 8 item 4 and is deliberately **not** done here — the `fnidentity` database must stay
provisioned until the Step 2 backfill is verified in every environment.

## 6. Bugs and gaps found during the cutover

Fixed:

- **`packages/common/src/utils/assertEnvsAreSet.ts` called `process.exit(1)`** after `logger.error`,
  so with `LOGS_LEVEL=none` — every test run — a missing root `.env` produced exit code 1 and no
  output at all. It now throws `MissingEnvironmentError` and reports **all** missing variables
  rather than only the first. All five call sites are module-level (`apps/api/src/envs.ts`,
  `apps/autopilot/src/envs.ts`, `apps/mcp/src/env.ts`); none catch it, so the process still dies —
  it just says why now.

- **No SIP domain could be created at all.** `packages/common/src/validators/sipnet/domains.ts`
  matched `/^[a-zA-Z0-9-]+(\.[a-zA-Z]{2,})+$/`, which permits a hyphen **only in the first label**,
  while its second refinement requires every domain to end with `ROOT_DOMAIN`. That was survivable
  when the root domain was `fonoster.local` and became a total outage of `Domains/CreateDomain`
  when it became `optimiq-voice.local`: after the rename **no string satisfies both refinements**.
  The expression is now an ordinary hostname check (labels start/end alphanumeric, hyphens inside,
  alphabetic TLD ≥ 2). Found by the sipnet `createResource` suite once the root mocha run started
  executing again — it is not tenancy fallout, and it predates this cutover.

Also fixed, as a consequence of Step 3 item 4:

- **`hasAccessToResource` granted access to a resource that did not exist**
  (`if (!extended) return true`). Both call paths are rewritten: `apps/api`'s resources are behind
  row-level security, so a foreign ref is genuinely absent; `packages/sipnet`'s
  `withTenantResourceAccess` **refuses** a resource with no recorded owner and one that cannot be
  read. `withAccess.ts` and `hasAccessToResource.ts` are deleted.

Open, out of scope here:

- **`findMany` has no `ORDER BY` on the non-cursor path.** `db.application.findMany` /
  `db.secret.findMany` order results only when a `cursor` is supplied, so a `take` smaller than the
  result set returns an arbitrary page and paging without a cursor is not stable. Pre-existing —
  the rewrite reproduced it exactly rather than changing behaviour under cover of a tenancy change
  — and it is why `verify:tenancy`'s partial-page check asserts containment rather than equality.
  Fix with `orderBy(asc(ref))` on both branches; it needs its own before/after check because it
  changes which rows a client sees on page 1.
- **A `ZodError` from `validOrThrow` surfaces as `INTERNAL` (13), not `INVALID_ARGUMENT` (3).**
  `createCreateApplication` and `createUpdateApplication` compose bare `withErrorHandling` rather
  than `withErrorHandlingAndValidation`, so the error reaches `handleError` unmapped. Pre-existing;
  found while updating the handler tests.
- **The InfluxDB CDR measurement's `accessKeyId` tag spans the cutover.** Points written before
  Step 4 flipped the minter carry the `WO…` key; points written after carry the organization id.
  `createFetchCalls` / `createFetchSingleCall` therefore filter on **both** values
  (`contains(value: r.accessKeyId, set: [...])`), which keeps a tenant's call history whole without
  rewriting a time-series store. InfluxDB is not one of the telephony tables Step 5 item 1 covers;
  if the dual filter is ever removed, history predating Step 4 disappears.
- **`config/integrations.json` does not exist.** `.env.example.dev:51` (`API_INTEGRATIONS_FILE`)
  and `:84` (`AUTOPILOT_INTEGRATIONS_FILE`) both point at it, but only
  `config/integrations.example.json` is committed, so a fresh checkout cannot boot the runtime —
  `assertFileExists(INTEGRATIONS_FILE)` in `apps/autopilot/src/envs.ts` kills the process. Fix by
  copying the example in a `postinstall`/bootstrap step or by pointing the example env at
  `integrations.example.json`. **Not created here** — the file is environment-specific.
- **`GET /api/recordings/:id` is anonymous and enumerable.** See the Step 3 notes; it needs a
  signed expiring URL, which is a media-pipeline change.
- ~~**`packages/db/scripts/tenant-rls-preflight.ts` is missing**~~ — **FIXED 2026-08-05**, see
  Step 5 item 5. It is now the shared runner for every bounded context.
- **`apps/api` reads `API_IDENTITY_{PRIVATE,PUBLIC}_KEY_PATH` and `API_INTEGRATIONS_FILE` relative
  to the process working directory**, so any script whose cwd is `apps/api` rather than the
  repository root cannot find them (carried over from Step 1.5.f).

---

## 7. Gate status (last run 2026-08-05, local stack on `:5433`)

| gate                          | command                                                                                                                                                            | result                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| api build                     | `pnpm --filter @optimiq-voice/api build`                                                                                                                           | pass                                                         |
| api typecheck (both projects) | `pnpm --filter @optimiq-voice/api typecheck`                                                                                                                       | pass                                                         |
| api unit tests                | `pnpm --filter @optimiq-voice/api test`                                                                                                                            | **411 passing**, 2 pending                                   |
| **root unit tests**           | `pnpm test`                                                                                                                                                        | **564 passing**, 3 pending, 0 failing (was 540 / 21 failing) |
| device provisioning           | `pnpm --filter @optimiq-voice/api verify:provisioning`                                                                                                             | **93/93**                                                    |
| PBX area                      | `pnpm --filter @optimiq-voice/api verify:pbx`                                                                                                                      | **148/148**                                                  |
| **SIP credential RPC**        | `pnpm --filter @optimiq-voice/api verify:sip-credentials`                                                                                                          | **17/17** (new)                                              |
| auth slice                    | `DATABASE_URL=… pnpm --filter @optimiq-voice/api verify:auth`                                                                                                      | **49/49** (was 38)                                           |
| per-call token                | `DATABASE_URL=… pnpm --filter @optimiq-voice/api verify:call-token`                                                                                                | **27/27**                                                    |
| **Step 2 data migration**     | `DATABASE_URL=… IDENTITY_DATABASE_URL=… API_CLOAK_ENCRYPTION_KEY=… pnpm --filter @optimiq-voice/api verify:identity-migration`                                     | **19/19**                                                    |
| **Step 5 tenancy + parity**   | `API_DATABASE_URL=… DATABASE_URL=… pnpm --filter @optimiq-voice/api verify:tenancy`                                                                                | **22/22** (new)                                              |
| `packages/auth`               | `pnpm --filter @optimiq-voice/auth test`                                                                                                                           | 170 pass                                                     |
| `packages/db`                 | `pnpm --filter @optimiq-voice/db test`                                                                                                                             | **93 pass**                                                  |
| tenant RLS — pbx              | `bun run scripts/tenant-rls-preflight.ts --plan-module ../../pbx-db/src/rls-preflight-plan --plan-export PBX_TENANT_RLS_PLAN --url …/optimiq_pbx --require-tables` | `ok`, 35/35                                                  |
| tenant RLS — cdr              | `… --plan-module ../../cdr-db/src/rls-preflight-plan --url …/optimiq_cdr --require-tables`                                                                         | `ok`, 3/3                                                    |
| **tenant RLS — api**          | `… --plan-module ../../../apps/api/src/core/db/rls-preflight-plan --plan-export API_TENANT_RLS_PLAN --url …/optimiq-voice --require-tables`                        | `ok`, 5/5 (new)                                              |
| repo                          | `pnpm exec turbo run build typecheck --filter='!@optimiq-voice/web' --filter='!@optimiq-voice/routing'`                                                            | 40/40                                                        |
| lint / format                 | `oxlint --disable-nested-config --deny-warnings <touched>` · `oxfmt --check <touched>`                                                                             | clean                                                        |

`@optimiq-voice/web` is excluded: it is being built in a parallel workstream and its typecheck is
red for reasons unrelated to this cutover (`invite-member-dialog.tsx`, `lib/auth-client.ts`,
`next.config.ts`). `@optimiq-voice/routing` is excluded for the same reason — it is a new,
still-untracked package from the telephony workstream whose only dependency is
`@optimiq-voice/telephony`, and its `src/cache.ts:168` typecheck failure predates and is untouched
by this work.

**Provisioning the local `apps/api` database from scratch**, for anyone reproducing the Step 5
gates:

```bash
psql -h localhost -p 5433 -U optimiq -d postgres -c 'CREATE DATABASE "optimiq-voice"'
cd apps/api
export API_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq-voice
export DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq
node scripts/db-provision.mjs                                   # all five migrations
API_CLOAK_ENCRYPTION_KEY=<from root .env> \
  pnpm exec tsx scripts/migrate-identity-to-organizations.ts --seed-fixtures
pnpm exec tsx scripts/backfill-tenancy-organization-id.ts --seed-fixtures
pnpm exec tsx scripts/verify-tenancy-backfill.ts                # 22/22
```

Export `API_CLOAK_ENCRYPTION_KEY` on its own rather than sourcing the whole root `.env` — the
verify scripts are self-configuring and a full `.env` overrides the placeholders they set.

**Residual gates that need infrastructure this environment does not have**

1. **Step 4 item 4, the SIP leg** — an inbound call through Asterisk + Routr reaching an autopilot
   application. Everything up to the SIP boundary is proven by `verify:call-token` (27/27, now
   through `@optimiq-voice/auth`'s verifier over live HTTP). **Superseded 2026-08-06:** Routr and
   the autopilot application are deleted, so this gate no longer has a subject. The call path it
   guarded is `apps/sipd` → `apps/asterisk` → `apps/engine`, whose own gates live in the master
   plan.
2. **Step 8 items 4-5** — "verified in every environment"; verified in one. Step 5's backfill has
   the same shape of residual: the column rewrite is proven against a three-tenant fixture set on
   this stack, and each other environment must run the sequence in the Step 8 note before its
   `NOT NULL` migration will pass.
3. **The gRPC surface has not been exercised end to end by a real client.** **Closed 2026-08-06,
   by deletion.** There is no gRPC surface, no interceptor chain, no `AUTHZ_SERVICE_ENABLED` and no
   SDK/CLI/dashboard build to point at one. The HTTP surface that replaced it is exercised by the
   ten `verify:*` suites (49 + 27 + 186 + 75 + 78 + 93 + 70 + 17 + 69 + 145 checks), every one of
   which drives the real Nest application against a real PostgreSQL.
