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

# `node .scripts/copy-hbs.cjs` is no longer run here: it copies `packages/identity/src/templates`
# into that package's `dist`, and `apps/api` has not depended on `@optimiq-voice/identity` since
# the identity service was removed — so the package is not in this filter's closure and the
# templates are not in the deploy tree either. This app's mail bodies are TypeScript template
# functions (`src/mail/mail-templates.ts`), which the compiler emits like any other module.
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
# platform:
#
#   node /service/node_modules/@optimiq-voice/identity/scripts/db-provision.mjs
#     provisioned the `fnidentity` database for the deleted identity service. `apps/api` no longer
#     depends on `@optimiq-voice/identity`, so the path does not exist in the deploy tree at all.
#
#   node /service/dist/core/seed.js
#     seeded that database's product catalogue and the default owner/workspace from
#     `API_OWNER_*`. Its source (`src/core/seed.ts`) is deleted; sign-up is better-auth's, and the
#     PBX/CDR demo seeds are `pnpm --filter @optimiq-voice/api seed:pbx` / `seed:cdr`, which are
#     developer tools rather than a boot step.
#
# `scripts/db-provision.mjs` stays: it is this app's OWN drizzle migration runner against
# API_DATABASE_URL, and `main.ts`'s tenant-RLS preflight asserts the shape it produces.
CMD ["sh", "-c", "DB_HOST=$(echo $API_DATABASE_URL | sed -n 's/.*@\\([^:/]*\\)[:/].*/\\1/p') && DB_PORT=$(echo $API_DATABASE_URL | sed -n 's/.*:\\([0-9]*\\)\\/.*/\\1/p') && if [ -z \"$DB_PORT\" ]; then DB_PORT=5432; fi && dockerize -wait tcp://${DB_HOST}:${DB_PORT} -timeout 30s && node /service/scripts/db-provision.mjs && node /service/dist/index.js"]
