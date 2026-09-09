##
# Build stage
##
FROM node:22-slim AS builder 
LABEL team="Optimiq Voice Team <team@optimiq.health>"

ARG PNPM_VERSION=11.20.0
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /work

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json tsconfig.base.json ./
COPY .scripts ./.scripts

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    apt-get update && apt-get install -y git \
    && pnpm install --frozen-lockfile --prefer-offline \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# There is no Handlebars template copy step. The legacy `.scripts/copy-hbs.cjs` existed to move the
# identity service's `.hbs` mail bodies into its `dist`; both the script and that package are
# deleted. This app's mail bodies are TypeScript template functions (`src/mail/mail-templates.ts`),
# which the compiler emits like any other module.
RUN pnpm --filter @optimiq-voice/api... run build

RUN PNPM_CONFIG_INJECT_WORKSPACE_PACKAGES=true pnpm --filter @optimiq-voice/api deploy --prod /prod/api

##
# Migration stage
##
# The image `publish-images.yaml` ships as `migrations` and `compose.voice.yaml` runs with the three
# database OWNER URLs. It used to be `builder` itself: root, with git, wget and the whole apt cache
# still in it. This stage is the same tree with none of that and a uid — the one container holding
# superuser-equivalent credentials should not also be the largest attack surface in the stack.
#
# It is NOT pruned to the three migration packages, and that is a limit rather than an oversight:
# `.scripts/migrate-platform.mjs` runs `pnpm exec tsx packages/<name>/scripts/migrate.ts` from the
# workspace root, so it needs the workspace — root manifest, lockfile, node_modules and all three
# `drizzle/` journals. Pruning it means giving that script its own deployable package first.
FROM node:22-slim AS migrations

ARG PNPM_VERSION=11.20.0
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production OPTIMIQ_SERVICE=migrations

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
  && groupadd -g 1001 appuser && useradd -u 1001 -g appuser -m appuser

WORKDIR /work

COPY --from=builder --chown=appuser:appuser /work /work

USER appuser

##
# Run stage
##
FROM node:22-slim

RUN groupadd -g 1001 appuser && useradd -u 1001 -g appuser -m appuser

ENV NODE_ENV=production OPTIMIQ_SERVICE=api

WORKDIR /service

COPY --from=builder --chown=appuser:appuser /prod/api ./

RUN apt-get update && apt-get install -y ca-certificates \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

USER appuser

# `docker compose ps` could not say whether this process was serving; `web` now waits on it.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:9876/api/auth/ok').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Extract database host and port from API_DATABASE_URL environment variable.
#
# Two steps that used to run between the migration and the server are gone with the legacy
# platform: the identity service's own `db-provision.mjs` (which provisioned `fnidentity`), and
# `dist/core/seed.js` (which seeded a product catalogue and a default owner from `API_OWNER_*`).
# Sign-up is better-auth's now, and the PBX/CDR demo seeds are
# `pnpm --filter @optimiq-voice/api seed:pbx` / `seed:cdr` — developer tools, not a boot step.
#
# `dockerize` is gone too, with the `-wait tcp://` probe that opened this command. It was an
# unverified third-party binary fetched over the network at build time — no checksum, no pinned
# digest, from a repository whose last release predates 2022 — executing as the process supervisor
# in every api container. What it bought was a TCP probe on Postgres, which `compose.yaml`'s
# `depends_on: postgres: condition: service_healthy` now does properly (a `pg_isready`, not an open
# socket), and which `compose.voice.yaml` already skipped by overriding `command`.
#
# `scripts/db-provision.mjs` stays. It is this app's OWN drizzle migration runner against
# API_DATABASE_URL, and it is what applies `drizzle/20260806164427_drop_legacy_api_tables` to an
# existing deployment. Note that it migrates only the BASE database: `PBX_DATABASE_URL` and
# `CDR_DATABASE_URL` are migrated by `packages/pbx-db` and `packages/cdr-db` (`pnpm db:migrate`),
# which run outside this image.
CMD ["sh", "-c", "node /service/scripts/db-provision.mjs && node /service/dist/index.js"]
