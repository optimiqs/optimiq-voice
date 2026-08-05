# Oikos-Care Stack & Conventions Reference (frozen 2026-08-05)

Extracted from the user's gold-standard repos (`~/Documents/oikos/oikos-care-backend`, `~/Documents/oikos/oikos-care-web`). Optimiq Voice copies these versions and patterns exactly (scope renamed `@optimiq-voice/*`).

## 1. Backend versions (pnpm catalog, exact where noted)

| Dep                                 | Version                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| Runtime                             | Bun ≥1.3.10; Node ≥22.12 <23; pnpm@10.28.1                                                    |
| effect                              | **4.0.0-beta.83** (EXACT, also in overrides; never the barrel import)                         |
| @effect/sql-pg                      | 4.0.0-beta.83                                                                                 |
| drizzle-orm / drizzle-kit           | **1.0.0-rc.4** (EXACT, overrides)                                                             |
| @nestjs/common,core,testing         | ^11.1.19 (+platform-fastify ^11.1.28)                                                         |
| fastify                             | ^5.8.5 (override 5.8.5)                                                                       |
| @nestjs/throttler                   | ^6.5.0                                                                                        |
| class-validator / class-transformer | ^0.14.3 / ^0.5.1                                                                              |
| zod                                 | ^4.4.3                                                                                        |
| jose                                | ^6.1.3                                                                                        |
| uuid                                | 11.1.1 (UUID v7 entity ids)                                                                   |
| postgres / pg                       | ^3.4.8 / ^8.20.0                                                                              |
| reflect-metadata                    | ^0.2.2 (bunfig preload)                                                                       |
| @sentry/nestjs                      | ^10.39.0                                                                                      |
| typescript                          | npm:@typescript/typescript6@^6.0.2; typescript-7 = npm:typescript@^7.0.2 (typecheck compiler) |
| oxlint / oxlint-tsgolint / oxfmt    | 1.76.0 / 7.0.2001 / 0.61.0                                                                    |
| turbo                               | ^2.9.14 · husky ^9 · lint-staged ^16                                                          |

## 2. Web versions

| Dep                                                                                                                                 | Version                                             |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Node ≥22 (nvm 24); pnpm@11.7.0                                                                                                      |
| next                                                                                                                                | **16.3.0** (EXACT)                                  |
| react / react-dom                                                                                                                   | ^19.2.6                                             |
| @base-ui/react                                                                                                                      | **1.7.0** (EXACT — Base UI, NOT Radix)              |
| tailwindcss / @tailwindcss/postcss                                                                                                  | ^4.3.0 (+typography ^0.5.20, tw-animate-css ^1.4.0) |
| cva ^0.7.1 · clsx ^2.1.1 · tailwind-merge ^3.6.0                                                                                    |
| @tanstack/react-form ^1.32.0 · react-query ^5.100.10 · react-table ^8.21.3 · react-virtual ^3.13.24                                 |
| zod ^4.4.3 · zustand ^5.0.13 · nuqs **2.9.0** · next-themes ^0.4.6 · motion ^12.38.0                                                |
| effect **4.0.0-beta.83** (client too, exact) · better-auth **1.6.23**                                                               |
| sonner ^2.0.7 · cmdk ^1.1.1 · recharts ^3.8.1 · date-fns ^4.1.0 · libphonenumber-js                                                 |
| babel-plugin-react-compiler 1.0.0 (Babel itself FORBIDDEN — SWC only)                                                               |
| vitest ^4.1.8 (+browser-playwright, coverage-v8) · playwright ^1.60.0 · storybook ^10.3.6 (@storybook/nextjs-vite)                  |
| oxlint 1.73.0 · oxfmt 0.58.0 · rustywind 0.25.2 · eslint ^10 (micro-config: only 3 React Compiler rules) · turbo ^2.10.8 · lefthook |

## 3. The Effect↔NestJS seam (packages/common/src/effect/)

- `memo-map.ts`: one process-wide `Layer.makeMemoMapUnsafe()` so shared layers build once.
- `runtime.ts`: `makeRuntime(service, layer)` → lazy `ManagedRuntime.make(Layer.provideMerge(layer, Observability.layer), { memoMap })`, throws if used after dispose.
- `module-runtime.ts`: `ModuleEffectRuntime implements OnApplicationShutdown` (disposes on Nest shutdown); `makeTestModuleRuntime` = isolated MemoMap per test.
- `run-effect.ts`: `runEffect(runtime, fn)` → `runPromiseExit`; on failure `Cause.findErrorOption`; rethrow HttpException as-is; duck-typed `value.toHttpException()`; else log `err_xxxxxxxx` opaque ref + throw 500 with that ref.
- Feature slice: `<feature>.module.ts` provides `ModuleEffectRuntime` under a **Symbol token** via useFactory · `<feature>.repository.ts` = `Context.Service` class + interface of Effect-returning methods + `make*(db)` closures wrapped `Effect.fn("Repo.method")` + `Layer.effect(...).pipe(Layer.provide(dbLayer))` + `Schema.TaggedErrorClass` failures each with `toHttpException()` · `<feature>.service.ts` = @Injectable, injects runtime, calls runEffect, pure shaping · `<feature>.controller.ts` = pure adapter (@RequirePermissions, ParseUUIDPipe, DTOs) · `dto/`, `<feature>.errors.ts`, `index.ts`.
- Effect NEVER leaks above the service. One `runEffect` per request path; parallel repo calls combined inside via `Effect.all` w/ bounded concurrency (never Promise.all of runEffects).
- Naming: `…Failure` (Effect, apps) / `…Exception` (HTTP boundary, extends HttpException) / `…Error` (packages). Never throw Nest exceptions below the service boundary.
- Consult `pnpm exec effect-solutions list|show <topic>` before writing Effect code (effect-solutions 0.5.3 devDep). `@effect/language-service` plugin in tsconfig.

## 4. Service rules

- Thin adapters / services own logic / repos own ALL Drizzle / single auth source (session → request.user).
- **Guard-then-execute**: validate everything before any write, ordered existence → business rules → authorization; specific domain exception per guard.
- **State machines**: `VALID_TRANSITIONS: Record<Status, Status[]>` const at top of service; terminal = `[]`; invalid → InvalidStateTransitionException. (Perfect fit for channel/call states.)
- Edge cases mandatory: empty arrays early-return, trim search, existence-check before insert (idempotency at business level), @Min/@Max bounds.
- Pagination: normalizePagination (page 1, limit 20, max 100) or `paged()` + `windowTotal` (`count(*) over ()`); response `{data,total,page,limit,totalPages}`; never unbounded.
- Tenant isolation: org-scoped repo methods take `organizationId` as FIRST param; services pass from session; repos never infer.
- UUID v7 ids (`packages/identifiers`: `createEntityId()`, `createDeterministicEntityId(key)` uuid-v3 w/ frozen namespace); plain strings, enforced at schema (`uuidV7PrimaryKey()`) + HTTP (`ParseUUIDPipe`).

## 5. Drizzle + RLS pattern (per bounded-context DB package)

- Shared primitives (base db package): `uuidV7PrimaryKey()`, `uuidEntityId()`, `tenantOrganizationIdColumn()`, `utcTimestamp()`, `auditTimestampColumns()` (createdAt/updatedAt w/ $onUpdateFn).
- Tables: `pgTable.withRLS(...)`, org FK `.references(..., { onDelete: "cascade" })`, status = `as const` tuple + `text().$type<T>()` (not pgEnum), org index + composites matching filter order, `check()` constraints, and `pgPolicy(name, { for: "all", to: tenantRole, using: tenantScope, withCheck: tenantScope })` where tenantScope = `organizationId = nullif(current_setting('<ctx>_tenant_tls.organization_id', true),'')::uuid`.
- Tenant role: `pgRole("<ctx>_tenant_tls", { inherit: false, … })`; append-only tables listed explicitly (2 policies) — for us: CDR + audit tables.
- `withTenantEffectTransaction(db, orgId, work)`: guard empty orgId → transaction → `set local role` → `set_config(setting, orgId, true)` → work. Raw db handle never escapes the package.
- Relations: drizzle-1.0 `defineRelations` grouped by domain; `drizzle-kit.ts` flat re-export for the kit.
- Config: `strict: true`, schema→`src/schema/drizzle-kit.ts`, out→`./drizzle`; **separate migration principal/URL** (owner) vs runtime principal (RLS-bound); `scripts/migrate.ts --expected-stage <stage>` guard; `db:check` composite (layout + conventions + identifier policy + kit check + drift). NO db:push/force/DDL-by-hand/rewriting applied migrations.
- Boot: `assertRuntimePrincipal()` RLS preflight in main.ts BEFORE NestFactory.create (rowSecurity, forceRowSecurity, owner, no-bypass, exact policy counts, role privileges); + `db:preflight:tenant-rls` script + `*-tenant-rls.integration.spec.ts`.
- Multi-DB: base package owns shared infra + connection budget allocation; context DBs (`pbx-db`, `cdr-db`) depend on base, never on each other; cross-context via contract packages/events, no cross-DB joins.

## 6. config / logging / auth

- `packages/config`: Zod v4 single root `.env`, `APP_ENV_CONTENT` JSON/dotenv hydration for secret managers, strict `z.stringbool({truthy:["true","1"],falsy:["false","0",""]})`, production invariant block that throws, exports only `env,getEnvVar,getEnvEntries`; lint bans `process.env` outside config/bootstrap.
- `packages/logging`: Pino AppLogger (Nest LoggerService), sensitive-key regex + value scrubbers (emails, E.164, JWTs, bearer, hex tokens, ?token=), max redaction depth 6, HttpLoggingInterceptor, Sentry tracing helpers.
- Auth: better-auth (oikos vendors it in `packages/auth` with ~20 subpath exports for patchability) + jose; session carries activeOrgId/activeRoleId/audience/permissions; cross-subdomain cookie config; CSRF token capture/replay; session-cookie cache version constant for mass invalidation.
- **Permissions**: `PERMISSIONS` flat const (`<resource>.<action>[.<scope>]` dotted strings) + `PERMISSION_CATALOG` + `SYSTEM_ROLE_TEMPLATES` in `packages/common/src/constants/permissions.ts`; `@RequirePermissions(...)` decorator + guard; **sync-permissions codegen script writes `apps/web/lib/permissions.generated.ts` into the web repo** — the cross-repo contract bridge.

## 7. main.ts bootstrap order

`import "./instrument"` (Sentry) → `import "reflect-metadata"` → DB/RLS preflight → NestFactory.create(FastifyAdapter) → helmet → cookie → compress → formbody → multipart → CORS → ValidationPipe(whitelist, forbidNonWhitelisted, transform) → global filters/interceptors → raw Fastify hooks (onRequest correlation-id; preHandler session + CSRF; onSend security headers, Cache-Control no-store) → listen({host:"0.0.0.0"}) → explicit single-shot SIGTERM/SIGINT with deadline timer (bypasses Nest signal hooks; unsubscribe → app.close → pool close → exit).

## 8. Tooling configs

- tsconfig: module "preserve", moduleResolution "bundler", target ES2022, types ["bun"], emitDecoratorMetadata + experimentalDecorators, useDefineForClassFields false, strictPropertyInitialization false, isolatedModules, incremental false, @effect/language-service plugin. Typecheck = `node node_modules/typescript-7/bin/tsc --noEmit`.
- oxfmt: tabs/2, 100 cols, LF, double quotes, semis, trailingComma all; backend `sortImports` with internalPattern ["@optimiq-voice/"] 4-group order; web sortImports FALSE (manual convention). Ignore drizzle/** and vendored dirs.
- oxlint: categories correctness=error; type-aware tsgolint; `no-restricted-imports` overrides (effect barrel ban; apps↛packages; packages/*/src deep-import ban); no-explicit-any error; staged config promotes explicit-module-boundary-types. Always `--disable-nested-config --deny-warnings`.
- turbo: globalDependencies on tsconfigs; explicit globalPassThroughEnv allow-list; test dependsOn ["^build","^test"] cache:false.
- bunfig preloads reflect-metadata for [run]+[test]. Hooks: backend husky (pre-commit lint-staged, pre-push typecheck, commit-msg); web lefthook (parallel:false, fixers stage_fixed, no-inline-comments + motion-token checks; pre-push: no-babel, unit tests, check, lint:hooks).
- Package exports: types→`./src/index.ts`, default→`./dist/index.js`; build swc+ESM-specifier rewrite or tsdown.
- Tests: bun:test; colocated `*.spec.ts`; custom runner isolates `mock.module(` specs per-process; `*.integration.spec.ts` gated by env + `--max-concurrency 1`; root `test/e2e/`; mock at repository boundary via shared test-double helper; supertest for e2e.

## 9. Web architecture rules

- App Router: route groups `(auth)`/`(organization)`/`admin`; route-private `_components/_hooks/_context.ts`; server components default; QueryClientProvider in the authenticated group layout (NOT root); root providers: ThemeProvider(attribute="class") → NuqsAdapter → auth/timezone → MotionConfig(reducedMotion="user").
- packages/ui: source-distributed on Base UI; subpath exports + `"./*"` wildcard; `cn` = clsx + extendTailwindMerge (custom shadow class groups); cva variants + shared focusRing; useRender/mergeProps polymorphism; memo.
- Tailwind v4 CSS-first: `@import "tailwindcss"`, `@source` the ui/icons packages, `@custom-variant dark (&:is(.dark *))`, `@custom-variant pointer-fine`, `@theme inline` mapping raw OKLCH tokens → `--color-*`. Semantic tokens only; `hover:bg-hover`/`hover:bg-hover-strong` transient, `bg-accent`/`bg-muted` persistent-selected; NO `dark:` literals in components. Motion via duration/easing tokens only (lint-checked).
- Forms: TanStack Form + colocated `*-schema.ts` (z.strictObject, shared field builders, z.input/z.output pair, exported defaults, schema straight into validators, focusFirstInvalidField, shared FormFooter). Never React Hook Form.
- Overlays: Dialog=create/edit, right Sheet=long editing, AlertDialog=confirm-only, CommandDialog=search; file suffix matches primitive.
- Data: React Query staleTime Infinity + **WebSocket-driven invalidation** (central `invalidation-keys.ts` maps backend events→query keys — PERFECT for PBX live state), gcTime 10min, no-retry on 4xx, BroadcastChannel cross-tab, per-domain `use-*-queries.ts` hooks with inline keys. State split: nuqs = URL/view state (custom createParser), zustand(+persist) = session-adjacent runtime, React Query = server state.
- Effect on client: no central effect/ folder; colocate service+Layer+errors in owning domain file; single `makeModuleRuntime(layer)` w/ shared MemoMap; export plain Promise fns; rethrow unwrapped failures so instanceof works.
- Testing: vitest two projects (unit=Node; storybook=headless Chromium via @vitest/browser-playwright + storybookTest); coverage ratchet thresholds; Storybook 10 nextjs-vite; separate Playwright e2e single-worker.
- `pnpm check` = oxlint + oxfmt --check + rustywind --check-formatted; `pnpm fix` applies all.
