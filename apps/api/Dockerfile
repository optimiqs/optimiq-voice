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

ENV DOCKERIZE_VERSION=v0.7.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml lerna.json turbo.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json ./
COPY .scripts ./.scripts

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    apt-get update && apt-get install -y git wget \
    && pnpm install --frozen-lockfile --prefer-offline \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# There is no Handlebars template copy step. The legacy `.scripts/copy-hbs.cjs` existed to move the
# identity service's `.hbs` mail bodies into its `dist`; both the script and that package are
# deleted. This app's mail bodies are TypeScript template functions (`src/mail/mail-templates.ts`),
# which the compiler emits like any other module.
RUN pnpm --filter @optimiq-voice/api... run build

RUN PNPM_CONFIG_INJECT_WORKSPACE_PACKAGES=true pnpm --filter @optimiq-voice/api deploy --prod /prod/api \
  && wget https://github.com/jwilder/dockerize/releases/download/"$DOCKERIZE_VERSION"/dockerize-linux-amd64-"$DOCKERIZE_VERSION".tar.gz \
  && tar -C /usr/local/bin -xzvf dockerize-linux-amd64-"$DOCKERIZE_VERSION".tar.gz \
  && rm dockerize-linux-amd64-"$DOCKERIZE_VERSION".tar.gz

##
# Run stage
##
FROM node:22-slim

RUN groupadd -g 1001 appuser && useradd -u 1001 -g appuser -m appuser

WORKDIR /service

COPY --from=builder --chown=appuser:appuser /prod/api ./
COPY --from=builder --chown=appuser:appuser /usr/local/bin/dockerize /usr/local/bin/dockerize

RUN apt-get update && apt-get install -y ca-certificates \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

USER appuser

# Extract database host and port from API_DATABASE_URL environment variable.
#
# Two steps that used to run between the migration and the server are gone with the legacy
# platform: the identity service's own `db-provision.mjs` (which provisioned `fnidentity`), and
# `dist/core/seed.js` (which seeded a product catalogue and a default owner from `API_OWNER_*`).
# Sign-up is better-auth's now, and the PBX/CDR demo seeds are
# `pnpm --filter @optimiq-voice/api seed:pbx` / `seed:cdr` — developer tools, not a boot step.
#
# `scripts/db-provision.mjs` stays. It is this app's OWN drizzle migration runner against
# API_DATABASE_URL, and it is what applies `drizzle/20260806164427_drop_legacy_api_tables` to an
# existing deployment. Note that it migrates only the BASE database: `PBX_DATABASE_URL` and
# `CDR_DATABASE_URL` are migrated by `packages/pbx-db` and `packages/cdr-db` (`pnpm db:migrate`),
# which run outside this image.
CMD ["sh", "-c", "DB_HOST=$(echo $API_DATABASE_URL | sed -n 's/.*@\\([^:/]*\\)[:/].*/\\1/p') && DB_PORT=$(echo $API_DATABASE_URL | sed -n 's/.*:\\([0-9]*\\)\\/.*/\\1/p') && if [ -z \"$DB_PORT\" ]; then DB_PORT=5432; fi && dockerize -wait tcp://${DB_HOST}:${DB_PORT} -timeout 30s && node /service/scripts/db-provision.mjs && node /service/dist/index.js"]
