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

RUN pnpm --filter @optimiq-voice/api... run build \
    && node .scripts/copy-hbs.cjs

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

# Extract database host and port from API_DATABASE_URL environment variable
CMD ["sh", "-c", "DB_HOST=$(echo $API_DATABASE_URL | sed -n 's/.*@\\([^:/]*\\)[:/].*/\\1/p') && DB_PORT=$(echo $API_DATABASE_URL | sed -n 's/.*:\\([0-9]*\\)\\/.*/\\1/p') && if [ -z \"$DB_PORT\" ]; then DB_PORT=5432; fi && dockerize -wait tcp://${DB_HOST}:${DB_PORT} -timeout 30s && node /service/scripts/db-provision.mjs && node /service/node_modules/@optimiq-voice/identity/scripts/db-provision.mjs && node /service/dist/core/seed.js && node /service/dist/index.js"]
