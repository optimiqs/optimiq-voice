##
# Standalone Optimiq Voice Identity service.
#
# Configured entirely from a mounted JSON config file (no environment variables).
# Mount the config and keys at /service/config, e.g.:
#   docker run -v $PWD/config:/service/config:ro optimiq-voice/identity
##

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

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml lerna.json turbo.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json ./
COPY .scripts ./.scripts

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    apt-get update && apt-get install -y git \
    && pnpm install --frozen-lockfile --prefer-offline \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN pnpm --filter @optimiq-voice/identity... run build \
    && node .scripts/copy-hbs.cjs \
    && PNPM_CONFIG_INJECT_WORKSPACE_PACKAGES=true pnpm --filter @optimiq-voice/identity deploy --prod /prod/identity

##
# Run stage
##
FROM node:22-slim

RUN groupadd -g 1001 appuser && useradd -u 1001 -g appuser -m appuser

WORKDIR /service

COPY --from=builder --chown=appuser:appuser /prod/identity ./

RUN apt-get update && apt-get install -y ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

USER appuser

EXPOSE 50051 9000

# Provision the database from the mounted config, then start the service.
# No environment variables — everything comes from /service/config/identity.json.
CMD ["sh", "-c", "node scripts/db-provision.mjs --config /service/config/identity.json && node dist/server/index.js --config /service/config/identity.json"]
