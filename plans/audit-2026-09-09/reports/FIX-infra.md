# FIX-infra

## Per finding

**[P0] `$JS.API.>` for api and engine — FIXED.** `config/nats.conf`. Both users are now enumerated
per stream and per bucket, in the sipd/mediad shape. The header's "WHY api AND engine GET
`$JS.API.>`" section is replaced with "HOW THE JETSTREAM API SURFACE IS SCOPED, FOR EVERY SERVICE",
which records what the prefix actually cost (STREAM.DELETE/PURGE, cross-bucket DIRECT.GET, account
introspection). The old rationale's fact — that KV `watch()`/`keys()` open anonymous consumers whose
names are subject tokens — is handled the way sipd already handled it: a `>` after the STREAM token
covers every consumer name and filter subject under that one asset.
Derived from `packages/events/src/streams.ts`, the `ensure*` call sites and the existing `$KV.`
grants:

- api streams: CALLS, CDR, PROVISION, QUEUES, TRUNKS, VOICEMAIL (INFO/CREATE/UPDATE + CONSUMER.* on
  all but PROVISION). api buckets (INFO/CREATE/UPDATE/MSG.GET/DIRECT.GET/CONSUMER.*): agent-state,
  channels, conference-claims, did-index, presence, queue-membership, queue-waiting, registrations,
  routing-cache, sip-acl, trunks. **Not** park-claims, shared-line-state, sip-dialogs,
  media-sessions, media-owners.
- engine: `ENGINE_ENSURE_STREAMS` applies the whole catalogue, so INFO/CREATE/UPDATE covers all ten
  streams and all sixteen buckets. The READ half (MSG.GET/DIRECT.GET/CONSUMER.*) is only the ten
  buckets `jetstream.service.ts` opens a view on — so the file's long-standing claim that the engine
  cannot read `registrations` / `sip-dialogs` / `trunks` / `sip-acl` / the media buckets is now
  enforced rather than merely stated.
- Neither user has STREAM.DELETE or STREAM.PURGE any more.

**Validation: none was possible.** No local docker daemon, no `nats-server` binary. There is no
nats.conf parser test in `packages/events` or `.scripts` (grepped). The `RUN_NATS_INTEGRATION_TESTS`
specs in `packages/events` connect to a bare broker with no accounts and do not describe the
permission model, so they are unaffected. `.scripts/verify-platform-stack.mjs` and
`verify-media-cluster.mjs` mount the real `config/nats.conf` and are the regression gate — **they
must be run before this lands.** Static checks done: brace depth 0, even quote count, no `$JS.API.>`
grant left.

**[P1] `CDR_EXPORT_ROOT` unwritable — FIXED (compose side).** `compose.yaml` api now sets
`CDR_EXPORT_ROOT=${CDR_EXPORT_ROOT:-/var/lib/optimiq/objects/exports}` and `compose.voice.yaml` pins
it to the same path under `voice-objects`. Cross-area: the schema default in
`apps/api/src/cdr/shared/cdr-env.ts:220` is still `/opt/optimiq-voice/exports`, which no image
creates or chowns.

**[P1] Base compose documents a volume it does not mount — FIXED.** `compose.yaml` gains an
`objects:` named volume mounted at `/var/lib/optimiq/objects` on `api` (rw) and `asterisk` (ro);
`CDR_RECORDING_ROOT` defaults onto it.

**[P1] Image tags nothing publishes — FIXED.** `web`, `api`, `engine` →
`ghcr.io/optimiqs/optimiq-voice/<app>:${VOICE_IMAGE_TAG:-latest}`; the hand-kept semver is gone.
`asterisk` was left as `optimiq-voice/asterisk:22` — `publish-asterisk.yaml:39-41` really does push
that unqualified Docker Hub name, so that one was not a bug.

**[P1] No `-race` in CI — FIXED.** All four Go steps in `ci.yaml`.

**[P1] go-data-plane / check-lint-and-format never run on `feat/**` — FIXED.** Both get
`- "feat/**"` (push and PR), both get a `concurrency` group.

**[P1] `format:check` skips apps/web — FIXED.** `package.json` `format` / `format:check` globs
widened to `apps/**/*` and `packages/**/*`. `.oxlintrc.json` no longer ignores `.scripts/**`.
`.scripts` is deliberately left out of the FORMATTER: `.oxfmtrc.json` ignores it and those files are
hand-packed one-statement-per-line; running oxfmt over them is a 6-file explosion with no gain, so I
left the ignore alone and dropped `.scripts` from the format glob instead of reformatting.
**Action required: `pnpm run format` must be run once repo-wide after every fix agent lands** — 36
pre-existing files fail the widened check, none of them in my area (list in the verification
section).

**[P1] `MEDIAD_WEBRTC` alone crashes the API — FIXED (compose + docs).** `compose.voice.yaml`
`SIPD_WSS: ${SIPD_WSS:-${MEDIAD_WEBRTC:-false}}` (verified with `docker compose config`), with the
three-consequence explanation on `PROVISION_WEBRTC_ENABLED`, and a new bullet in
`docs/native-calling-deployment.md`. Cross-area: the refinement in
`apps/api/src/provisioning/provisioning-env.ts:158-162` still fails with a zod issue naming
`PROVISION_SIP_WSS_URL` rather than the flag the operator set.

**[P2] migrations image is the root builder — FIXED.** New `migrations` stage in
`apps/api/Dockerfile`: `FROM node:22-slim`, corepack pnpm, `COPY --from=builder --chown=appuser
/work /work`, `USER appuser`. Not pruned, and the comment says why —
`.scripts/migrate-platform.mjs` runs `pnpm exec tsx packages/<name>/scripts/migrate.ts` from the
workspace root. `publish-images.yaml` matrix and `compose.voice.yaml` both retargeted.
**Not built:** no docker daemon here.

**[P2] unverified `dockerize` — FIXED by removal.** Dropped the download, the `wget` apt package and
the `-wait tcp://` wrapper from the api `CMD`. `compose.yaml` now has
`depends_on: postgres: {condition: service_healthy}` (a `pg_isready`, strictly stronger than a TCP
probe) and `compose.voice.yaml` already overrode the command.

**[P2] `rewrite-esm-specifiers.mjs` guesses — FIXED.** Unresolvable specifiers are collected and
thrown as one list; `.d.ts` counts as resolved so declaration-only imports don't false-positive.
`pnpm exec turbo run build --force` → 14/16 succeed, no throw from the script (the two failures are
other agents' in-flight edits, see below).

**[P2] README topology — FIXED.** `mediad` added to the component table and the layout tree;
Asterisk relabelled as the `legacy-asterisk` profile; `go test -race` lines for both Go apps; the
container section now describes `compose.yaml` as the base layer and points at `compose.voice.yaml`

- `docs/native-calling-deployment.md`; the stale "container publishing … is not wired up yet" and
  "sipd does not yet proxy calls" claims corrected.

**[P2] `.env.voice.example` VOICE_CERTS_DIR — FIXED.** `/etc/optimiq/certs`, with the reason; the
`./config/certs` fallback stays in compose for development. Matching note in the deployment doc.

**[P2] no healthchecks / depends_on in base compose — FIXED.** `postgres` gets the `pg_isready`
probe (moved up from voice), `nats` gets `/healthz` (which required enabling `http_port: 8222` in
`config/nats.conf` — unauthenticated, unpublished, statistics only, documented in the file), `api`
gets a `HEALTHCHECK` in its Dockerfile and `depends_on` on both, `web` gets
`depends_on: api: service_healthy`.

**[P2] `turbo.json` globalDependencies — FIXED.** Added `pnpm-workspace.yaml` and `pnpm-lock.yaml`.

**[P2] root `tsconfig.json` divergence — SKIPPED, and the stated failure is WRONG.** `.mocharc.json`
loads `tsx`, which type-STRIPS; it never type-checks. So "the root mocha suite type-checks the same
sources under weaker rules" does not happen — no rule in that file can let a null-safety error pass.
What remains is cosmetic divergence, and switching `module: commonjs` → `preserve` changes how tsx
transforms the root suite for no behavioural gain. Left alone.

## Additional fixes

- `.scripts/verify-platform-stack.mjs`: `fetch` was passed `body: undefined` on GET requests, which
  is the one real oxlint error the `.scripts` unignore surfaced. Now spread conditionally.

## Cross-area needed

1. `apps/api/src/cdr/shared/cdr-env.ts:220` — `CDR_EXPORT_ROOT` default `/opt/optimiq-voice/exports`
   is unwritable by uid 1001 in the runtime image. Change to a path the image creates and chowns.
2. `apps/api/src/provisioning/provisioning-env.ts:158-162` — the `PROVISION_WEBRTC_ENABLED` /
   `PROVISION_SIP_WSS_URL` refinement should name the operator-facing flag in its message.
3. **Repo-wide `pnpm run format` once all agents land** (36 files, listed by
   `pnpm run format:check`), otherwise `check-lint-and-format` goes red on `feat/**`.
4. Someone with a docker daemon must run `.scripts/verify-platform-stack.mjs` and
   `.scripts/verify-media-cluster.mjs` against the new `config/nats.conf`.

## Verification

- `docker compose -f compose.yaml config -q` → OK. Same with each of `compose.dev.yaml`,
  `compose.tls.yaml`, and `--env-file .env.voice.example -f compose.voice.yaml` → OK (4/4).
- `actionlint` → 1 finding, pre-existing: `go-data-plane.yaml:96` SC2155, in a script block I did
  not touch. 0 findings on `ci.yaml`, `check-lint-and-format.yaml`, `publish-images.yaml`.
- `pnpm exec oxlint .scripts` → 0 errors, 47 `no-explicit-any` warnings (all pre-existing, all in
  `verify-browser-calling.mts`). `pnpm run lint` → 2 errors, both pre-existing and outside my area:
  `apps/api/src/pbx/moh-classes/moh-classes.dto.ts:43` and
  `apps/api/src/pbx/media/musiconhold-conf.ts:124`, `no-control-regex`.
- `pnpm run format:check` → 36 files fail, 0 of them mine (24 `apps/api`, 2 `apps/web/scripts`, 10
  `packages/*`). All pre-existing debt newly exposed by the widened glob; see cross-area item 3.
- `pnpm exec turbo run build --force` → 14 successful, 16 total. The two failures are other agents'
  concurrent edits, not mine: `@optimiq-voice/api#build` (4 TS errors in `auth.platform.ts` /
  `sso/sso.service.ts` against `@optimiq-voice/db` exports being changed right now) and, on the
  first run only, `@optimiq-voice/telnyx#build`. Every package that reached
  `rewrite-esm-specifiers.mjs` passed it.
- `config/nats.conf`: brace depth 0, even quote count, zero `$JS.API.>` grants. Not parsed by a
  broker — see the P0 note.
