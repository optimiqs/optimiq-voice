# FIX — dev runner / decorator metadata parity

Covers `E2E-resilience.md` P0-2 (api: bare-class injections `undefined` under `tsx`) and
`E2E-bringup.md` bug 3 (engine `start:dev` cannot start at all).

## The decision

**`@swc-node/register` (1.12.1), loaded with `node --import @swc-node/register/esm-register`.**

Evidence for the choice, not assertion:

| option                              | moving parts                                                                                                                                                                                                                                                         | verdict    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `@swc-node/register`                | one devDependency; reads the app's own `tsconfig.json`, so `emitDecoratorMetadata: true` in `tsconfig.base.json` is honoured with no new config file                                                                                                                 | **chosen** |
| `tsc --watch` + `node --watch dist` | two long-lived processes per app, **and** the build is not `tsc` alone — `.scripts/rewrite-esm-specifiers.mjs` has to run after every emit to turn `module: "preserve"` output into runnable ESM. A watch mode would need that step wired in as a third moving part. | rejected   |
| `bun --watch src/main.ts`           | zero new deps and Bun does honour `emitDecoratorMetadata`, but it swaps the runtime. The brief is _semantically identical to production_, and production is Node.                                                                                                    | rejected   |

Measured, before anything was changed (`Reflect.getMetadata("design:paramtypes", …)`):

```
tsx      → SipRenegotiateService: undefined
swc-node → SipRenegotiateService: [ 'Object', 'JetStreamService', 'Object' ]
```

`.swcrc` was **not** added — swc-node reads the tsconfig resolved from cwd, and both apps' configs
already extend `tsconfig.base.json`, which already sets `emitDecoratorMetadata`. One fewer file to
drift.

## Changes

- `apps/api/package.json` — `start:dev` is now
  `node --watch --import @swc-node/register/esm-register src/main.ts` (was
  `nodemon --exec tsx --watch src src/main.ts`). New `check:di` script. `@swc-node/register` added.
- `apps/engine/package.json` — same `start:dev` (was `tsx watch src/main.ts`), same `check:di`,
  same devDependency.
- `package.json` (root) — `@swc-node/register` devDependency; `nodemon` and the root
  `nodemonConfig` block removed, they existed only for the api's old `start:dev` and nothing else
  in the repo referenced them.
- `pnpm-workspace.yaml` — `@swc/core` added to `onlyBuiltDependencies` / `allowBuilds`, otherwise
  `pnpm install` exits non-zero with `ERR_PNPM_IGNORED_BUILDS` and breaks CI's install step.
- `.mocharc.json` and `apps/api/.mocharc.json` — loader `tsx` → `@swc-node/register/esm-register`.
  The api's 1276 mocha tests were running under the same metadata-less loader as the dev server;
  they are now prod-faithful too. All 1276 still pass.
- `.scripts/check-di-metadata.mjs` (+ `.d.mts`) — the guard. Walks a Nest module graph's decorator
  metadata (`imports`/`providers`/`controllers`/`exports`, handling `forwardRef`, dynamic modules
  and `useClass`) and reports every constructor parameter that has neither `design:paramtypes` nor
  an explicit `@Inject`/`@Optional`. Nothing is instantiated and nothing is connected — it runs
  offline.
- `apps/api/scripts/check-di-metadata.ts`, `apps/engine/scripts/check-di-metadata.ts` — the
  per-app entry points. The api's `AppModule` is deliberately empty (`main.ts` composes the feature
  modules onto it conditionally), so the api entry lists `PbxModule`, `ProvisioningModule`,
  `LiveModule`, `SessionModule`, `CdrModule`, `PbxCdrPortsModule` — the set `main.ts` mounts.
- `apps/engine/tsconfig.json` — `include` gains `scripts/**/*`, so the new script is typechecked
  (the file's own header already claimed the project "includes everything they can reach").
- `.github/workflows/ci.yaml` — a `Dependency-injection metadata` step in the `workspace` job,
  after Build, running both `check:di` scripts.
- `.scripts/local-stack/up.sh` — api and engine go back to running **from source** under the
  metadata-emitting runner, dropping the two `pnpm run build` workarounds. `--watch` is
  deliberately left off in the stack: a stack meant to stay up should restart on `down.sh`/`up.sh`,
  not when an agent saves a file. Both comment blocks rewritten to say why the runner matters
  rather than why dist was needed.

## Proof

**The guard reproduces the exact bug.** Under the old runner:

```
$ node --import tsx apps/api/scripts/check-di-metadata.ts
api: 1 constructor parameter(s) Nest cannot resolve …
  - SipAuthEventConsumer: parameter 1 has no design:paramtypes and no @Inject

$ node --import tsx apps/engine/scripts/check-di-metadata.ts
engine: 53 constructor parameter(s) Nest cannot resolve …
```

Under the new one:

```
api:    186 injectable classes across 8 modules; every bare-class constructor parameter has design:paramtypes.
engine:  37 injectable classes across 9 modules; …
```

Both offline (`env -i`), both exit 0.

**Live boots against the running stack's env files, on alternate ports, dist processes untouched.**

- engine, `ENGINE_PORT=9399`, `env/engine.env`: `Nest application successfully started`, then
  `/healthz` → `{"status":"ok", … "media":{"driver":"mediad","ready":true}, "nats":{"connected":true},
"routing":{"watching":true,"cached":3}}`. Shut down cleanly on SIGTERM.
- api, `API_HTTP_BRIDGE_PORT=3299`, `env/api.env`: `Nest application successfully started`,
  CDR leg/recording writers running, `/api/auth/ok` → `{"ok":true}`, **zero** lines matching
  `error` in the whole boot log.
- The live stack was verified healthy again afterwards (`:3200/api/auth/ok`, `:9300/healthz`).

## One correction to the audit

`E2E-resilience.md` P0-2 says "at least a dozen providers have that shape" and names
`voicemail-consumer`, `ring-groups.controller`, `emergency-consumer`, etc. That is **wrong for the
api as it stands**: the graph walk finds exactly **one** — `SipAuthEventConsumer`. Every other
provider named there carries an explicit `@Inject(...)` on every constructor parameter (checked
directly, e.g. `VoicemailConsumer`'s six parameters are all `@Inject`-ed). The api's exposure was
one provider, which is precisely the one that surfaced. The engine's exposure was the 53 the guard
counts, which matches bug 3. The fix and the guard are unaffected either way.

## Not changed

- `apps/api`'s `verify:*` scripts stay on `tsx`: none of them constructs a Nest application (checked
  — no `NestFactory` or `@nestjs` import in `apps/api/scripts/*.ts`), so decorator metadata is
  irrelevant to them and switching would be churn.
- `docs/native-calling-deployment.md` — it has no dev-commands section (Configuration, web
  deployment shapes, migrations/principals, network paths, acceptance), and neither it nor
  `README.md` nor `.scripts/local-stack/README.md` mentions `start:dev`, `tsx` or `dist`. Nothing
  to update.
- No application source touched. No boot-time self-check added — `check:di` covers the same
  invariant without costing a millisecond of startup.

## Verification (exact output)

| check                                                          | result                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/api run typecheck`               | pass (both projects, no output)                                     |
| `pnpm --filter @optimiq-voice/api run test`                    | **1276 passing**, 0 failing                                         |
| `pnpm --filter @optimiq-voice/engine run typecheck`            | pass                                                                |
| `pnpm --filter @optimiq-voice/engine run test`                 | **1628 pass, 6 skip, 0 fail**, 3651 expects, 72 files               |
| `pnpm exec turbo run build`                                    | **16 successful, 16 total**                                         |
| root `pnpm test` glob under the new mocha loader               | **1276 passing**                                                    |
| `pnpm --filter … run check:di` (api, engine)                   | pass, exit 0                                                        |
| `pnpm exec oxlint` on the new files                            | clean                                                               |
| `pnpm exec oxfmt --check` on `.scripts` + both `scripts/` dirs | "All matched files use the correct format"                          |
| `bash -n .scripts/local-stack/up.sh`                           | ok                                                                  |
| `actionlint .github/workflows/ci.yaml`                         | ok                                                                  |
| `pnpm install`                                                 | exit 0 (was `ERR_PNPM_IGNORED_BUILDS` before the `@swc/core` allow) |

Nothing committed, staged or stashed.
