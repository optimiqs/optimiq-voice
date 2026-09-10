# Infra audit — compose, NATS authz, Dockerfiles, CI, scripts, tooling

Area: `.github/workflows/*`, `compose*.yaml`, `config/*`, `.scripts/*`, `apps/*/Dockerfile`,
`.env*.example`, root tooling configs, `docs/native-calling-deployment.md`, `README.md`,
husky/lint-staged. Read-only. HEAD on `feat/optimiq-pbx-phase0`.

Overall the NATS permission model, the verify harnesses' cleanup, and the Dockerfile non-root /
multi-stage layering are in genuinely good shape — better than typical. The findings below are the
places where a stated invariant is not actually enforced.

---

### [P0] `$JS.API.>` publish grant makes the api and engine subject allow-lists decorative (confidence: high)

- Where: `config/nats.conf` (api publish block, `$JS.API.>`), and the engine publish block (`$JS.API.>`)
- Code:

```
  # api publish allow:            # engine publish allow:
  "$JS.API.>"                     "$JS.API.>"
  "$JS.ACK.>"                     "$JS.ACK.>"
```

- Problem: `$JS.API.>` is the whole JetStream control surface for the account. It includes
  `$JS.API.STREAM.DELETE.*`, `$JS.API.STREAM.PURGE.*`, `$JS.API.CONSUMER.DELETE.*.*`, and
  `$JS.API.DIRECT.GET.KV_<any bucket>.>` for **every** stream and KV bucket in `OPTIMIQ` —
  including `KV_registrations`, `KV_sip-dialogs`, `KV_media-sessions`, `KV_media-owners`,
  `KV_trunks`, `KV_sip-acl` and every event stream. `sipd` and `mediad` are, by contrast,
  enumerated bucket-by-bucket (`$JS.API.STREAM.INFO.KV_registrations`, `$JS.API.DIRECT.GET.KV_trunks.>`, …),
  which is the intended shape. The two Node services got a blanket grant instead.
- Failure scenario / cost: the file's own header says the engine "may NOT write the control plane's
  three KV buckets" and compose.yaml:264 repeats it. Neither holds. A compromised or buggy `engine`
  can `$JS.API.DIRECT.GET.KV_registrations.<key>` to read every tenant's AOR bindings, and
  `$JS.API.STREAM.PURGE.KV_routing-cache` / `.STREAM.DELETE.CDR` to destroy the dial plan and the
  billing record for every tenant at once. The carefully enumerated `subscribe` denials on
  `$KV.registrations.>` / `$KV.sip-dialogs.>` for the engine are bypassable through the same grant.
- Fix: replace `$JS.API.>` on both users with the enumerated set the sipd/mediad blocks already
  model — `$JS.API.INFO`, and per owned stream/bucket `STREAM.{INFO,CREATE,UPDATE,MSG.GET}`,
  `DIRECT.GET.<stream>.>`, `CONSUMER.{CREATE,INFO,DELETE,MSG.NEXT}.<stream>[.>]`. In particular do
  not grant `STREAM.DELETE.*` or `STREAM.PURGE.*` to a runtime service; those belong to the
  operator identity (`$NATS_USER`) only.
- Cross-area: none for the config itself; a follow-up run of `.scripts/verify-platform-stack.mjs`
  and `verify-media-cluster.mjs` (which run against the real `config/nats.conf`) is the regression
  gate, and they will name any subject the enumeration misses.

### [P1] `CDR_EXPORT_ROOT` defaults into an unwritable, unmounted path in the shipped voice stack (confidence: high)

- Where: `apps/api/src/cdr/shared/cdr-env.ts:220`, `compose.voice.yaml:73-77`, `apps/api/Dockerfile:45,58`
- Code:

```
  CDR_EXPORT_ROOT: z.string().min(1).default("/opt/optimiq-voice/exports"),
  # compose.voice.yaml api: volumes: - voice-objects:/var/lib/optimiq/objects   (only)
  # apps/api/Dockerfile:    USER appuser   (uid 1001)
```

- Problem: `compose.voice.yaml` sets `CDR_RECORDING_ROOT`, `PBX_MEDIA_OBJECT_ROOT` and
  `PBX_VOICEMAIL_MEDIA_ROOT` to the mounted volume but never sets `CDR_EXPORT_ROOT`, so it falls
  back to `/opt/optimiq-voice/exports`. In the runtime image `/opt` is `root:root 0755` and the
  process is uid 1001, so `local-object-store.ts:107`'s `mkdir(dirname(path), {recursive:true})`
  fails with `EACCES`. `.scripts/verify-platform-stack.mjs:107` explicitly sets
  `CDR_EXPORT_ROOT: "/tmp/exports"` — the harness works around exactly this and the compose file
  does not.
- Failure scenario / cost: every CDR CSV export in a real deployment fails at write time; if the
  path ever _were_ writable, exports would still live on the container filesystem and vanish on
  redeploy.
- Fix: add `CDR_EXPORT_ROOT: /var/lib/optimiq/exports` to the `api` service in `compose.voice.yaml`
  and mount a volume (or a second path under `voice-objects`) there; alternatively change the
  schema default to a path the image creates and chowns to `appuser`.
- Cross-area: the default value lives in `apps/api/src/cdr/shared/cdr-env.ts` (api area) if you
  prefer to fix it there rather than in compose.

### [P1] Base `compose.yaml` documents an object-store volume it does not mount (confidence: high)

- Where: `compose.yaml:113-137` vs `compose.yaml:181`
- Code:

```
      # One object store, mounted once. `CDR_RECORDING_ROOT` is the root ...
      # `STORAGE_DRIVER` defaults to `local` ... the volume above IS the store
      - CDR_RECORDING_ROOT
    ...
    # No volumes.
```

- Problem: the `api` service comment refers three times to "the volume above" / "the volume
  bind-mounted" and there is no volume on the service, nor any object-store mount on `asterisk` in
  this file. With `CDR_RECORDING_ROOT` unset the api defaults to `/opt/optimiq-voice/recordings`,
  which uid 1001 cannot create (same `EACCES` as above); with it set to a path inside the container
  the uploads are invisible to `asterisk`, whose `OPTIMIQ_MEDIA_OBJECT_ROOT` (`compose.yaml:240`)
  names a directory nothing mounts either.
- Failure scenario / cost: `docker compose -f compose.yaml up` — the file that is supposed to
  "describe the whole platform" — produces a stack where uploading a prompt either 500s or writes
  to ephemeral container storage and plays as silence on the call. `compose.dev.yaml:36` and
  `compose.voice.yaml:77` both add the mount; only the shipped base file is missing it.
- Fix: add a named volume (e.g. `media:`) mounted at a single path on both `api` and `asterisk`
  (ro on asterisk) and pin `CDR_RECORDING_ROOT` / `OPTIMIQ_MEDIA_OBJECT_ROOT` to it — mirroring
  what `compose.voice.yaml` already does with `voice-objects`. Or delete the misleading comments
  and state that the base file is not a runnable media deployment.
- Cross-area: none.

### [P1] `compose.yaml` pins image tags that no workflow ever publishes (confidence: high)

- Where: `compose.yaml:19,38,193,253`, `.github/workflows/publish-images.yaml:118`
- Code:

```
    image: optimiq-voice/web:0.1.0        # compose.yaml
    image: optimiq-voice/api:0.17.1
    images: ghcr.io/optimiqs/optimiq-voice/${{ matrix.app }}   # publish-images.yaml
```

- Problem: `publish-images.yaml` pushes `ghcr.io/optimiqs/optimiq-voice/{api,engine,web,sipd,mediad,migrations}`
  tagged from the git tag; `compose.yaml` names unqualified `optimiq-voice/*` at hand-maintained
  semver that nothing produces. Only `compose.voice.yaml` overrides the image to the GHCR name.
- Failure scenario / cost: `docker compose -f compose.yaml up` without the dev or voice overlay
  fails to pull every service; the four version strings are also dead metadata that will drift
  silently.
- Fix: change `compose.yaml` to `ghcr.io/optimiqs/optimiq-voice/<app>:${VOICE_IMAGE_TAG:-latest}`
  so the base file and the publish workflow name the same artifact, and drop the hand-kept semver.
- Cross-area: none.

### [P1] No Go test in CI runs with `-race` (confidence: high)

- Where: `.github/workflows/ci.yaml:135-152`
- Code:

```
      - name: Test apps/sipd
        working-directory: apps/sipd
        run: go test ./...
```

- Problem: all four Go modules (`apps/sipd`, `apps/mediad`, `packages/events-go`,
  `packages/runtime-go`) run `go test ./...` with no `-race`. These are the two most
  concurrency-dense processes in the repo — per-dialog goroutines, RTP read loops, KV watchers,
  instance-ownership maps. The only `-race` invocation anywhere is the single
  `TestChromiumWebRTCAudioAndRecording` run in `go-data-plane.yaml:71`, which is a browser test
  and is `paths`-filtered on top.
- Failure scenario / cost: data races in the media/SIP planes ship green. The cost of the fix is
  roughly 2-5x on four small suites — seconds, on a job that today is the fastest in the matrix.
- Fix: `go test -race ./...` in all four steps of the `go` job in `ci.yaml`.
- Cross-area: may surface pre-existing races in `apps/sipd` / `apps/mediad` (data-plane areas).

### [P1] `go-data-plane.yaml` never runs on the branches the team actually works on (confidence: high)

- Where: `.github/workflows/go-data-plane.yaml:9-11` vs `.github/workflows/ci.yaml:28-35`
- Code:

```
on:
  pull_request:
    branches:
      - main         # go-data-plane: main only
```

- Problem: `ci.yaml` runs on `main` **and** `feat/**` for both `push` and `pull_request`.
  `go-data-plane.yaml` runs only on pull requests targeting `main`, and never on push. So gofmt,
  `go vet`, the WebRTC audio test, the browser-calling verification and the tagged integration
  suites never execute on a feature branch — including this one, which touches
  `apps/engine/src/media/**`, `apps/engine/src/nats/sipd-command.client.ts` and
  `config/nats.conf`, all of which are in its own `paths` list.
- Failure scenario / cost: the expensive data-plane gate only fires at the final merge PR, which is
  the worst possible moment to discover a vet failure or a broken NATS permission set.
  `check-lint-and-format.yaml` has the same `main`-only restriction.
- Fix: add `- "feat/**"` to `go-data-plane.yaml` and `check-lint-and-format.yaml` `pull_request.branches`,
  matching `ci.yaml`. Also add a `concurrency: { group: go-data-plane-${{ github.ref }}, cancel-in-progress: true }`
  block — this workflow installs Chromium and builds the engine, and without it every push to an
  open PR stacks another full run.
- Cross-area: none.

### [P1] `pnpm format:check` skips the entire web app, all scripts and all tests (confidence: high)

- Where: `package.json:27,37`, `.oxlintrc.json` `ignorePatterns`
- Code:

```
  "format:check": "oxfmt --check \"apps/**/src/**/*.{...}\" \"packages/**/src/**/*.{...}\"",
```

- Problem: `apps/web` has no `src/` directory — its code lives in `app/`, `components/`, `lib/`,
  `proxy.ts`. The glob therefore matches nothing in the largest application. The same glob excludes
  `.scripts/`, every `apps/*/scripts/` and every `test/` tree. `.oxlintrc.json` additionally
  `ignorePatterns` `.scripts/**`, `**/test/**` and `**/*.test.ts`, so `pnpm lint` does not cover
  them either.
- Failure scenario / cost: the CI step added specifically because "formatting was never actually
  verified in CI" (`check-lint-and-format.yaml:33-35`) still does not verify the frontend. Only the
  husky `pre-commit` hook formats web files, and `git commit --no-verify` or any non-hook commit
  path bypasses it. Roughly 1000 lines of infra scripts are lint-exempt.
- Fix: widen both globs to `"apps/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"` /
  `"packages/**/*.{...}"` `".scripts/**/*.{mjs,mts}"` and rely on oxfmt's own ignore handling, and
  drop `.scripts/**` from `.oxlintrc.json` `ignorePatterns`.
- Cross-area: will produce a one-time formatting diff across `apps/web` and `.scripts`.

### [P1] Enabling browser calling via `MEDIAD_WEBRTC=true` alone crashes the API at boot (confidence: medium)

- Where: `compose.voice.yaml:68-69`, `apps/api/src/provisioning/provisioning-env.ts:158-162`
- Code:

```
      PROVISION_WEBRTC_ENABLED: ${MEDIAD_WEBRTC:-false}
      PROVISION_SIP_WSS_URL:                       # bare passthrough, empty if unset
```

```
  if (env.PROVISION_WEBRTC_ENABLED && env.PROVISION_SIP_WSS_URL === undefined) { ...issue... }
```

- Problem: one variable (`MEDIAD_WEBRTC`) drives three independent things — `mediad`'s ICE stack,
  and, through `PROVISION_WEBRTC_ENABLED`, an API schema refinement that _requires_
  `PROVISION_SIP_WSS_URL`. Nothing in the compose file couples them, and `SIPD_WSS` is a fourth
  separate flag. `.env.voice.example` happens to set all four consistently, so the failure only
  appears for an operator who flips `MEDIAD_WEBRTC` on an existing `.env.voice`.
- Failure scenario / cost: `MEDIAD_WEBRTC=true` without `PROVISION_SIP_WSS_URL` and `SIPD_WSS=true`
  takes the API from "WebRTC off" to "does not boot", with a zod issue rather than a message about
  the flag the operator actually set.
- Fix: in `compose.voice.yaml` derive the SIP-edge flag from the same variable
  (`SIPD_WSS: ${MEDIAD_WEBRTC:-false}`) and make `PROVISION_SIP_WSS_URL` required-if-enabled at the
  compose layer: `PROVISION_SIP_WSS_URL: ${PROVISION_SIP_WSS_URL:-}` plus a documented note, or use
  compose's `:?` form guarded by the profile. At minimum, document the four-flag set in
  `docs/native-calling-deployment.md`.
- Cross-area: the refinement itself is `apps/api/src/provisioning/provisioning-env.ts` (api area).

### [P2] The published `migrations` image is the unpruned root builder stage (confidence: high)

- Where: `.github/workflows/publish-images.yaml:65`, `apps/api/Dockerfile:4-38`
- Code:

```
  {"app":"migrations","dockerfile":"apps/api/Dockerfile","target":"builder","platforms":"..."}
```

- Problem: the `builder` stage has no `USER` directive (runs as root), carries the entire monorepo
  source, `git`, `wget`, the full dev dependency tree and the downloaded `dockerize` tarball's
  extraction. It is published to GHCR and run by `compose.voice.yaml`'s `migrate` service with the
  three **database owner** URLs. Every other image in this repo is a pruned `pnpm deploy --prod`
  runtime stage running as uid 1001.
- Failure scenario / cost: the one container that holds superuser-equivalent database credentials is
  also the largest attack surface and the only one running as root. Size cost is roughly an order of
  magnitude over the api runtime image.
- Fix: add an explicit `migrations` target to `apps/api/Dockerfile` — a slim stage carrying only
  `.scripts/migrate-platform.mjs`, `packages/{db,pbx-db,cdr-db}` migration folders + runners, `tsx`
  and `apps/api/scripts/db-provision.mjs` — with `USER appuser`, and point the matrix entry at it.
- Cross-area: none.

### [P2] `apps/api/Dockerfile` fetches `dockerize` over the network with no checksum (confidence: high)

- Where: `apps/api/Dockerfile:36-38`
- Code:

```
  && wget https://github.com/jwilder/dockerize/releases/download/"$DOCKERIZE_VERSION"/dockerize-linux-${TARGETARCH}-"$DOCKERIZE_VERSION".tar.gz \
  && tar -C /usr/local/bin -xzvf ...
```

- Problem: unverified third-party binary from a repository whose last release predates 2022, copied
  into the runtime image and executed by `CMD` as the process supervisor. No `sha256sum -c`, no
  pinned digest.
- Failure scenario / cost: a compromised or replaced release asset executes in every api container.
  It also makes the build non-hermetic — a GitHub outage breaks the release pipeline.
- Fix: either pin and verify (`echo "<sha256>  dockerize.tar.gz" | sha256sum -c -`), or drop
  `dockerize` entirely: `compose.voice.yaml` already overrides `command:` to skip it, and the
  `migrate` service's `service_completed_successfully` dependency is a stronger wait than a TCP probe.

### [P2] `.scripts/rewrite-esm-specifiers.mjs` silently emits a broken specifier when it cannot resolve (confidence: medium)

- Where: `.scripts/rewrite-esm-specifiers.mjs:29-37`
- Code:

```
  if (existsSync(path.join(resolved, "index.js"))) { return `${prefix}${specifier}/index.js${suffix}`; }
  return `${prefix}${specifier}.js${suffix}`;
```

- Problem: when neither `<spec>.js` nor `<spec>/index.js` exists, the script appends `.js` anyway
  and reports success. That happens for a directory import with a differently-named entry, a
  `.json` import that lost its extension, and any case where the build emitted into a different
  folder.
- Failure scenario / cost: the build is green and the container throws
  `ERR_MODULE_NOT_FOUND` at first import in production, with a path that never existed. The whole
  point of this script is to convert a `module: "preserve"` emit into runnable ESM; a specifier it
  could not resolve is exactly the case worth failing on.
- Fix: collect unresolved specifiers and `throw` with the list at the end of `rewriteEsmSpecifiers`,
  rather than emitting a guess.

### [P2] README describes a topology that no longer ships (confidence: high)

- Where: `README.md:22-23,41-42,126,136-137`
- Code:

```
| Media server | A dockerized Asterisk 22 (LTS) ... | `apps/asterisk` |
  cd apps/sipd && go test ./...                    # Go SIP edge
`compose.yaml` is the deployment topology — `web`, `api`, `engine`, `asterisk`, `postgres` and `nats`
```

- Problem: `apps/mediad` — the RTP/WebRTC media plane, one of the two Go services, with its own
  Dockerfile, published image and 2000 published UDP ports — is not mentioned anywhere in the
  README. Neither is `compose.voice.yaml` nor `docs/native-calling-deployment.md`, which together
  are the actual deployment story. Asterisk is presented as the media server while
  `compose.voice.yaml:4-5` puts it behind a `legacy-asterisk` profile and `ENGINE_MEDIA_DRIVER: mediad`
  routes media elsewhere.
- Failure scenario / cost: a new contributor following the README builds a mental model with no
  media plane in it, and runs `go test` on half the Go code.
- Fix: add `mediad` to the component table and the repo-layout list, add a `go test` line for it,
  and point the "Deployment" section at `compose.voice.yaml` + `docs/native-calling-deployment.md`
  with `compose.yaml` described as the base layer.

### [P2] `.env.voice.example` — the production template — defaults `VOICE_CERTS_DIR` to the dev CA directory (confidence: medium)

- Where: `.env.voice.example:50`, `config/certs/.gitignore`, `compose.voice.yaml:132,172`
- Code:

```
VOICE_CERTS_DIR=./config/certs
```

- Problem: `config/certs` is the output of `generate-dev-certs.sh` — a self-signed CA trusted only
  by the checkout. It is mounted into `sipd` (WSS listener) and `turn` (TURN/TLS) by
  `compose.voice.yaml`. `docs/native-calling-deployment.md:11` says to install the real chain
  "in `VOICE_CERTS_DIR`", so an operator who follows the docs and keeps the default overwrites a
  dev directory that `.gitignore` marks disposable.
- Failure scenario / cost: browsers refuse the WSS handshake against a dev CA and the failure
  presents as "softphone will not go online"; or the real production key ends up in a directory
  a developer script regenerates.
- Fix: change the example to a non-repo path (`VOICE_CERTS_DIR=/etc/optimiq/certs`) and leave the
  `./config/certs` default only in the compose fallback for development.

### [P2] Base `compose.yaml` has no healthchecks or dependency ordering at all (confidence: high)

- Where: `compose.yaml` (0 occurrences of `healthcheck`, 0 `depends_on`)
- Problem: `postgres` and `nats` carry no healthcheck in the shipped file — the `pg_isready` probe
  exists only in `compose.voice.yaml:8-12`. `web` has no `depends_on: api`, `api` has none on
  `postgres`/`nats`. The `engine`'s absence of `depends_on` is deliberate and documented
  (`compose.yaml:247-251`); the others are not. Two images already define their own `HEALTHCHECK`
  (`web`, `engine`, `sipd`, `mediad`), but `api` and `postgres` do not, so `docker compose ps`
  cannot report whether the API is serving.
- Failure scenario / cost: a `compose up` on the base file races — `api` starts before Postgres
  accepts connections, and only the `dockerize -wait` in the api `CMD` (which
  `compose.voice.yaml:42` overrides away) saves it.
- Fix: move the `postgres` healthcheck into `compose.yaml`, add a `nats` healthcheck
  (`nats-server --help`-free option: a TCP probe on 4222 or the `/healthz` monitoring endpoint if
  `http_port` is enabled), add a `HEALTHCHECK` to `apps/api/Dockerfile` hitting `:9876` the way
  `apps/web/Dockerfile:80` does, and give `web` a `depends_on: api`.

### [P2] `turbo.json` omits the lockfile from `globalDependencies` (confidence: medium)

- Where: `turbo.json:3`
- Code:

```
  "globalDependencies": ["tsconfig.json", "tsconfig.base.json"],
```

- Problem: turbo hashes the lockfile automatically for the packages it can attribute, but a change
  in a root `devDependency` (typescript, oxlint, turbo itself) or a `catalog:` version bump in
  `pnpm-workspace.yaml` does not invalidate `build`/`typecheck` outputs. `pnpm-workspace.yaml`
  carries a `catalog:` block that several packages resolve through.
- Failure scenario / cost: CI restores a turbo cache entry built against the previous TypeScript
  and reports a green typecheck for code that a fresh build would reject.
- Fix: add `"pnpm-workspace.yaml"` (and, if you want belt and braces, `"pnpm-lock.yaml"`) to
  `globalDependencies`. The `build`/`typecheck`/`test` task graph is otherwise correct:
  `typecheck` and `test` both depend on `^build`, which is required given
  `pnpm-workspace.yaml:6 linkWorkspacePackages: false`.

### [P2] Root `tsconfig.json` diverges from `tsconfig.base.json` on strictness and module system (confidence: medium)

- Where: `tsconfig.json`
- Code:

```
    "module": "commonjs", "target": "es6", "moduleResolution": "node",
    "noImplicitAny": false,
    // TODO: Enable strictNullChecks and strictPropertyInitialization
```

- Problem: root `package.json` is `"type": "module"` and `tsconfig.base.json` (which every package
  extends) is `module: "preserve"` + `strict: true`. The root config — which `tsx` resolves when the
  root mocha suite runs (`.mocharc.json` `node-option: import=tsx`) — is CommonJS, ES6-target and
  non-strict, and its `exclude` list does not exclude `apps`/`packages`, so it nominally claims the
  whole tree.
- Failure scenario / cost: the root mocha suite (the husky `pre-push` gate) type-checks the same
  sources under weaker rules than CI does, so a null-safety error can pass locally and fail in
  `turbo run typecheck`.
- Fix: make `tsconfig.json` `extends: "./tsconfig.base.json"` and override only what the root
  runner genuinely needs (`experimentalDecorators`, `emitDecoratorMetadata`), or delete it and give
  the root mocha run an explicit `tsconfig` pointing at the base.

---

## Checked and found correct (recorded so it is not re-audited)

- **NATS least privilege, subject level.** `mediad` cannot publish `rpc.sip.v1.credential` or
  `rpc.sip.v1.trunk-credential` — it has no path to SIP secrets. The api cannot publish
  `calls.evt.v1.>` or `cdr.leg.v1.*`; `sipd` cannot publish `calls.evt.v1.>`. The engine cannot
  answer any RPC it should not. `voicemail.evt.v1.*.*.mwi.updated` (7 tokens) matches
  `VoicemailSubject`'s shape exactly (`packages/events-go/subjects.go:331`).
- **Reply-inbox scoping is correct and deliberate.** Every service publishes `_INBOX.>` (required to
  answer a requester) but subscribes only to its own prefix, and
  `packages/config/src/nats-credentials.ts:233` sets `inboxPrefix: "_INBOX." + service` while the Go
  services use `nats.CustomInboxPrefix`. A service cannot receive another service's replies.
- **The api's missing `cdr.leg.v1.>` / `sip.reg.v1.>` subscribe grants are not a bug.**
  `webhook-dispatcher.service.ts:264` uses JetStream pull consumers (`consumers.consume()`), which
  deliver over the inbox rather than the source subject, so no subject-level subscribe permission is
  needed. (This _is_ however what `$JS.API.>` is covering for — see P0.)
- **`migrate-platform.mjs`'s missing per-database owner-URL fallback is handled downstream.**
  `packages/pbx-db/scripts/migrate.ts:26` falls back `PBX_DATABASE_MIGRATION_URL ?? PBX_DATABASE_URL`,
  so line 22's `!owner && !runtime` check is consistent with the runners.
- **The engine legitimately needs no object-store volume.** `ENGINE_MEDIA_OBJECT_ROOT` is only used
  to _construct_ a path string handed to the media server
  (`channel-orchestrator.service.ts:2255`, `routing/media-refs.ts:161`); the engine never opens the
  file. `compose.voice.yaml:90` setting it without a mount is correct.
- **The verify harnesses clean up properly.** `verify-platform-stack.mjs:329-336` and
  `verify-media-cluster.mjs`'s `finally` block remove every container, the network, child processes
  (SIGTERM then SIGKILL with a timer), sockets, NATS connections and the scratch directory, and log
  output is scrubbed of the generated password. All credentials are `randomBytes`-derived per run —
  none hardcoded. (The only gap: no SIGINT/SIGTERM handler, so a Ctrl-C or CI timeout leaks
  containers. Minor, not filed.)
- **No secrets in version control.** `config/certs/*.pem` are gitignored and `git ls-files` confirms
  only `.gitignore` and `generate-dev-certs.sh` are tracked. `config/turn/turnserver.conf` is
  gitignored with only the `.example` committed. `config/nats.conf` resolves all ten credentials
  from the environment, and an unresolved reference is a hard broker startup failure.
- **Env-var names match the readers.** Cross-checked `compose.voice.yaml`'s `SMTP_*` / `MAIL_FROM`
  against `apps/api/src/mail/mail-env.ts:116-122` (canonical names, with `API_SMTP_*` as the
  aliases `compose.yaml` uses) and every `PROVISION_*` against
  `apps/api/src/provisioning/provisioning-env.ts`. All present and correctly spelled. The
  `API_NATS_URL` + `NATS_URL` double-set in `compose.yaml:88-89` is genuinely required
  (`packages/config/src/env.ts` aliases one; `cdr-env.ts:73` reads the other directly).
- **`.dockerignore` is correct for these builds.** `node_modules`, `**/dist`, `**/.next`, `**/.turbo`
  and `.env*` are excluded so no stale local build shadows the image; the bare `scripts` entry on
  line 78 matches only a top-level directory, so `apps/api/scripts/db-provision.mjs` (which the api
  `CMD` runs) is still in the context.
- **`publish-images.yaml` mechanics.** `matrix.dockerfile || format(...)` and `matrix.target || ''`
  both behave correctly for the entries that omit those keys; `latest` moves only on a `v*` tag and a
  `workflow_dispatch` build is sha-tagged, so a manual rebuild cannot repoint `latest`. All actions
  are pinned to major versions; the coturn image in `compose.voice.yaml:162` is pinned by digest.
- **Coturn config.** `no-tcp-relay` disables RFC 6062 TCP _relay allocations_, not TCP transport to
  the TURN server, so it does not conflict with `BROWSER_TURN_TRANSPORT=tcp` in
  `go-data-plane.yaml:94`. The deny-all `denied-peer-ip` pair with a single `allowed-peer-ip` is the
  right shape. `network_mode: host` is documented as Linux-only and required for relay port
  preservation.
- **Non-root and healthchecks in images.** All five app Dockerfiles run as a non-root user
  (`appuser` uid 1001 / numeric `1001:1001`); `web`, `engine`, `sipd`, `mediad` and `asterisk` all
  define a `HEALTHCHECK`. Only `apps/api/Dockerfile` lacks one (folded into the P2 above).
