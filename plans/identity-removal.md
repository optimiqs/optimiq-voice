# Identity Service Removal — Cutover Plan

**Date:** 2026-08-05 · **Phase:** written in P0, executed in P1 · **Status:** Step 1 (additive
mount) is **DONE** and all three of its blocking findings are **RESOLVED**; Step 3 is **DONE for
the HTTP surface** (the rest is blocked on Step 2); Step 4 items 1-3 are **DONE**, item 4 is
proven at verify-script level. Step 2 not started; **Step 5 is blocked on Step 2** (see the
blocker note there). Steps 6-9 not started.

The custom RS256 gRPC identity service is retired and replaced by **better-auth 1.6.23**
(`packages/auth`) on the **base database** (`packages/db`). This document enumerates everything
that currently depends on identity and the ordered steps to remove each.

> **Executed so far** (2026-08-05): better-auth is mounted in `apps/api` alongside the existing
> gRPC identity path; `apps/api` has been migrated to the oikos ES-module toolchain and to
> `drizzle-orm@1.0.0-rc.4`; the five `SYSTEM_ROLE_TEMPLATES` are registered with better-auth's
> organization access control, so `manager` / `agent` / `user` are assignable roles; the session
> guard is **global and deny-by-default** over every Nest HTTP route in `apps/api`; and
> `packages/voice` verifies per-call tokens against `/api/auth/jwks` instead of fetching an RS256
> public key from the identity service over gRPC. `packages/identity-client` is **deleted**
> (it had zero consumers). `apps/identity`, `packages/identity`, `packages/common/src/identity/`
> and the `fnidentity` database are still in place — the gRPC servers `RuntimeHostService` starts
> continue to authenticate through them. See "Step 1 implementation notes", "Step 1.5" and the
> per-step notes below.

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

**CJS interop, audited exhaustively.** Every bare specifier in the *emitted* `dist/**/*.js` (i.e.
every binding that survives type elision) was imported under Node's ES-module loader and its
bindings checked. Exactly four packages needed anything:

| package                | problem                                                          | fix                                                                       |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `@routr/sdk`           | `module.exports = { default: {...} }`; Node ignores `__esModule` | unwrap `.default` explicitly in `src/core/upsertDefaultPeer.ts`            |
| `wavefile`             | no detectable named **or** default export                        | `createRequire(import.meta.url)` in `src/voice/tts/utils/convertUlawToPCM16.ts` |
| `@deepgram/sdk`        | was `require()`d behind an `any`                                 | real named import; surfaced a live bug (below)                            |
| everything else (44)   | none                                                             | —                                                                          |

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

> ⚠️ **Known artifact — the next `db:generate` will not be empty.** drizzle-kit 1.0 diffs the
> converted snapshot against the schema and emits four cosmetic
> `ALTER COLUMN … SET DATA TYPE timestamp(3)` statements for
> `applications.{created_at,updated_at}` and `secrets.{created_at,updated_at}` — the v7→v8 snapshot
> conversion represents `timestamp(…, { precision: 3 })` differently than 1.0's own serializer.
> **There is no structural drift**: no table, column, index, constraint or enum differs, which
> also confirms the `defineRelations` rewrite changed no DDL. Two options, decide before the next
> schema change: (a) accept one no-op normalization migration so the snapshot becomes honest —
> costs a table rewrite lock on two tables; (b) hand-correct the `timestamp` entries in
> `20260805032410_baseline/snapshot.json`. It was deliberately **not** generated here.

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

### Step 2 — Data migration `fnidentity` → base DB

1. One-shot script: `users` → `user` (+`account` rows with the bcrypt hash under
   `providerId: "credential"`), `workspaces` → `organization`, `workspaceMembers` → `member`
   (owner/admin/member), `apiKeys` → `apikey` with `referenceId = organization.id`.
2. Persist a `accessKeyId → organization.id` mapping table; it is the join key for Step 5.
3. Decrypt `@47ng/cloak` fields on read; store plaintext-equivalents only where better-auth
   expects them (email, name). Do **not** carry `verificationCodes` over.
4. **Gate:** every existing user can sign in with their existing password; every workspace has
   exactly one owner.

### Step 3 — Replace `createAuthInterceptor` with a session guard — **HTTP SURFACE DONE 2026-08-05**

- [x] 1. New `apps/api` guard: resolve the caller in order — session cookie →
      `Authorization: Bearer` (bearer plugin) → `x-api-key` (apiKey plugin). Produce an
      `AppSession`. **Cookie and bearer are done** (both are handled inside
      `auth.api.getSession`, which the Fastify `preHandler` hook in `auth-http.plugin.ts` calls
      once per request). **`x-api-key` is BLOCKED — see the api-key blocker below.**
- [x] 2. ~~`requireActiveOrganizationId(session)` supplies the tenant id~~ — done on the HTTP
      surface: the guard reads the tenant from `session.activeOrganizationId` and the voice
      server's interceptor now stamps the organization id from a signed claim
      (`ORGANIZATION_METADATA_KEY`) rather than trusting the caller. **Deleting
      `getAccessKeyIdFromCall` is BLOCKED on Step 2** — the 17 gRPC call sites scope queries by
      the `WO…` access key that telephony rows still store, and there is no
      `accessKeyId → organization.id` mapping to swap them onto.
- [x] 3. Implement `@RequirePermissions(...)` over `PERMISSIONS` / `SYSTEM_ROLE_TEMPLATES`.
      Delivered early in Step 1, made **global and deny-by-default** here. `roles.ts`,
      `hasAccess.ts`, `workspaceResourceAccess` and `workspaceResourceOwnerOrAdminAccess` are
      still referenced by the gRPC interceptor and die with it in Step 9.
- [ ] 4. Replace `withAccess` / `hasAccessToResource` in `apps/api` (3 sites) and `packages/sipnet`
      (3 sites) with RLS scoping. **BLOCKED on Steps 2 and 5** (no tenant column exists yet). The
      _existence-implies-access_ defect therefore also still stands.
- [ ] 5. **Gate:** the 17 direct `getAccessKeyIdFromCall` call sites are gone; a cross-tenant
      request returns 404/403 in an integration test. **BLOCKED on Step 2.**

#### Step 3 — what shipped (HTTP surface)

`RequirePermissionsGuard` is registered once as an `APP_GUARD` by `AuthModule`, so it covers every
Nest HTTP route in `apps/api`, including ones added later. Three changes make that safe:

| before                                                      | after                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `@UseGuards(RequirePermissionsGuard)` per controller         | one `{ provide: APP_GUARD, useExisting: RequirePermissionsGuard }`        |
| no `@RequirePermissions` metadata ⇒ **route is open**        | no metadata ⇒ **an authenticated session is required**                    |
| no way to declare a route anonymous                          | `@PublicRoute()` (`src/auth/public-route.decorator.ts`), explicit and greppable |

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

#### Step 3 blocker — `x-api-key` cannot become a session with `references: "organization"`

`@better-auth/api-key@1.6.23` promotes an API key into a session in a `before` hook, but only for
keys that reference a **user**:

```js
// dist/index.mjs:2353-2356
if ((config.references ?? "user") !== "user") {
  throw APIError.from("UNAUTHORIZED", API_KEY_ERROR_CODES.INVALID_REFERENCE_ID_FROM_API_KEY);
}
const user = await ctx.context.internalAdapter.findUserById(apiKey.referenceId);
```

`packages/auth` configures `apiKey({ references: "organization" })` deliberately — keys belong to
the organization, not to whoever created them — so `auth.api.getSession` with an `x-api-key`
header **throws 401** instead of producing a session. Options, to decide before Step 7 (the SDK
and CLI move to API-key auth):

- (a) resolve the key explicitly with `auth.api.verifyApiKey` in the session hook and synthesise an
  `AppSession` whose `activeOrganizationId` is the key's `referenceId` — no plugin change, and it
  is the shape the API actually wants (a key is a tenant principal, not a user principal);
- (b) switch to `references: "user"` and carry the organization in key metadata — loses the
  cascade-on-organization-delete and re-introduces "keys belong to a person";
- (c) upstream a `references: "organization"` session path.

**Recommendation: (a).** It keeps the data model and is ~30 lines in `auth-http.plugin.ts`.

### Step 4 — Per-call and service tokens

- [x] 1. Replace `createGenerateCallAccessToken` with the better-auth jwt plugin: a short-lived
      (`30s`) token whose payload carries `organizationId` and the application ref.
      **DONE 2026-08-05, ADDITIVE — the live call path is untouched.**
- [x] 2. `packages/voice/src/VoiceServer.ts`: replace `getPublicKey` over gRPC with JWKS verification
      via `jose.createRemoteJWKSet(new URL("/api/auth/jwks", AUTH_URL))`. **DONE 2026-08-05.**
- [x] 3. `apps/autopilot`: keep consuming `sessionToken`; only the verification path changes.
      Retire `AUTOPILOT_SKIP_IDENTITY` in favour of the standard auth env. **DONE 2026-08-05.**
- [ ] 4. **Gate:** an inbound call reaches an autopilot application end to end with the new token.
      **PARTIAL — proven at verify-script level, not live.** `verify:call-token` (27/27) mints a token with
      the `apps/api` slice and verifies it with the *actual* `createCallTokenVerifier` from
      `@optimiq-voice/voice` against the live `/api/auth/jwks`. The live half additionally needs
      Asterisk + Routr and the `accessKeyId → organization.id` mapping from Step 2 (see "what
      still gates the live call path" below).

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

| legacy `createGenerateCallAccessToken`           | new                                                |
| ------------------------------------------------ | -------------------------------------------------- |
| `iss` = `API_IDENTITY_ISSUER`                    | `iss` = the jwt plugin's issuer (`AUTH_URL`)       |
| `sub` = `appRef`                                 | `sub` = `appRef` — **unchanged**                   |
| `aud` = `API_IDENTITY_AUDIENCE`                  | `aud` = `"optimiq-voice/voice"`                    |
| `tokenUse: "access"`                             | `tokenUse: "access"` — **unchanged**               |
| `accessKeyId` = workspace `WO…` key              | `accessKeyId` = `organization.id` (same slot)      |
| `access: [{ accessKeyId, role: "VOICE_SERVICE" }]` | same shape, organization id inside               |
| —                                                | `organizationId` — the canonical tenant claim      |
| —                                                | `appRef` — explicit, no longer only in `sub`       |
| —                                                | `callRef` — **new**, binds the token to one call   |
| `iat` (stamped by `jsonwebtoken`)                | `iat` stamped explicitly (the plugin sets only `exp`) |
| RS256 with `.keys/private.pem`                   | the jwks key (EdDSA by default), published at `/api/auth/jwks` |
| `expiresIn: "30s"`                               | `"30s"` — **unchanged**                            |

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

| before                                                             | after                                                              |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `getPublicKey(identityAddress)` gRPC round trip at server start     | nothing at start; `createRemoteJWKSet` fetches on first call and caches |
| RS256 PEM from `.keys/public.pem` via the identity service          | whatever `/api/auth/jwks` publishes (EdDSA by default), rotation-aware |
| `ServerConfig.identityAddress` (default `api.optimiq.health`)       | `ServerConfig.authUrl`, **no default** — misconfiguration fails closed |
| `ServerConfig.skipIdentity` / `AUTOPILOT_SKIP_IDENTITY`             | `ServerConfig.skipTokenVerification`, set only when `NODE_ENV=development` **and** no `AUTH_URL` |
| tenant read from the client-supplied `accesskeyid` metadata key     | tenant read from the signed `organizationId` claim and **stamped onto** `organizationid` metadata, overwriting the caller |
| `hasAccess(decoded, path)` against `roles.ts`                       | none — one method, and `aud: "optimiq-voice/voice"` on a 30 s per-call token IS the decision |

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

**What still gates the live call path (item 4).** `apps/api/src/voice/createCreateVoiceClient.ts`
still mints with `createGenerateCallAccessToken(identityConfig)`. Flipping it to
`CallTokenService.createCallAccessToken(...)` needs the organization id, which only exists after
Step 2's `accessKeyId → organization.id` mapping (`callRef` is already in scope there). Until then
the voice server verifies tokens the API does not yet mint, so `apps/autopilot` must keep running
with `skipTokenVerification` **or** the flip must land together with Step 2. Do not deploy the two
halves separately.

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

### Step 5 — Enable RLS on org-scoped tables — **BLOCKED ON STEP 2** (assessed 2026-08-05)

1. Add `organization_id uuid not null` to every telephony table; backfill from the Step 2
   mapping table via `extended->>'accessKeyId'`; drop the JSONB `accessKeyId`.
2. Create the `pbx_tenant_tls` role, per-table policies (`tenantOrganizationScope`), and grants.
3. Wire `assertTenantRlsPreflight` into `apps/api` boot **before** the server is created.
4. Route every org-scoped repository through `withTenantScope`.
5. **Gate:** `db:preflight:tenant-rls` is clean; the tenant-RLS integration spec passes.

> **Blocker, recorded 2026-08-05.** `drizzle-orm@1.0.0-rc.4` in `apps/api` (Step 1.5.c) unblocked
> the *toolchain*, not the *data*. Every item above is still gated:
>
> - **Item 1 is gated by sequencing rule 2.** `apps/api`'s two org-owned tables (`applications`,
>   `secrets`) carry `access_key_id text`, and there is no `accessKeyId → organization.id` mapping
>   to backfill from — that table is Step 2, which has not started. Adding
>   `organization_id uuid not null` before the mapping exists means either a lockout or a fake
>   backfill. (Note the plan's §2.10 describes an `extended` JSONB column; that shape is the
>   sipnet/Routr rows, not `apps/api`'s own schema. Both need the same mapping.)
> - **Item 2 has no home yet.** `pbx_tenant_tls` belongs to the PBX bounded-context database.
>   `packages/db` is the *base* package and deliberately owns only the auth tables plus the
>   generic tenant primitives (`tenant-role.ts`, `tenant-scope.ts`, `tenant-transaction.ts`,
>   `rls-preflight.ts`); its single migration is `20260805195722_auth_baseline` and it declares no
>   `pgRole`/`pgPolicy` at all. `packages/pbx-db` is referenced by the root `db:generate` /
>   `db:migrate` scripts but does not exist in the workspace.
> - **Item 4 has nothing to route.** `apps/api` has no org-scoped repositories; every caller goes
>   through the Prisma-shaped `db.*` facade in `src/core/db.ts`, keyed on `accessKeyId`. Those
>   become repositories in the P1 slice rewrite, not here.
> - **Item 5 cannot run.** `packages/db/package.json` declares
>   `"db:preflight:tenant-rls": "bun run scripts/tenant-rls-preflight.ts"` but
>   `packages/db/scripts/` contains only `migrate.ts` — the preflight script is missing. Write it
>   (it is a thin wrapper over the exported `runTenantRlsPreflight` +
>   `createPostgresTenantRlsIntrospector`) as the first task of this step.
>
> **Do Step 2 first.** Nothing here is worth forcing ahead of it: rule 2 exists precisely so a bad
> backfill is recoverable rather than a lockout.

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
packages/sipnet/package.json                     # remove the @optimiq-voice/identity dependency
                                                 #   (packages/voice: DONE 2026-08-05)
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

Open, out of scope here:

- **`config/integrations.json` does not exist.** `.env.example.dev:51` (`API_INTEGRATIONS_FILE`)
  and `:84` (`AUTOPILOT_INTEGRATIONS_FILE`) both point at it, but only
  `config/integrations.example.json` is committed, so a fresh checkout cannot boot the runtime —
  `assertFileExists(INTEGRATIONS_FILE)` in `apps/autopilot/src/envs.ts` kills the process. Fix by
  copying the example in a `postinstall`/bootstrap step or by pointing the example env at
  `integrations.example.json`. **Not created here** — the file is environment-specific.
- **`GET /api/recordings/:id` is anonymous and enumerable.** See the Step 3 notes; it needs a
  signed expiring URL, which is a media-pipeline change.
- **`packages/db/scripts/tenant-rls-preflight.ts` is missing** although `db:preflight:tenant-rls`
  invokes it. See the Step 5 blocker.
- **`apps/api` reads `API_IDENTITY_{PRIVATE,PUBLIC}_KEY_PATH` and `API_INTEGRATIONS_FILE` relative
  to the process working directory**, so any script whose cwd is `apps/api` rather than the
  repository root cannot find them (carried over from Step 1.5.f).
