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

# `...` builds the engine's workspace dependencies too (telephony, routing,
# events, media-ari, logging, effect-runtime, identifiers, config).
RUN pnpm --filter @optimiq-voice/engine... run build

RUN PNPM_CONFIG_INJECT_WORKSPACE_PACKAGES=true \
    pnpm --filter @optimiq-voice/engine deploy --prod /prod/engine

##
# Run stage
##
FROM node:22-slim

RUN groupadd -g 1001 appuser && useradd -u 1001 -g appuser -m appuser

WORKDIR /service

COPY --from=builder --chown=appuser:appuser /prod/engine ./

RUN apt-get update && apt-get install -y ca-certificates \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

USER appuser

# `/healthz` is answerable before the ARI socket opens, and reports `degraded`
# (503) while draining — which is exactly what an orchestrator should act on.
EXPOSE 4010
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.ENGINE_PORT||4010)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# No `dockerize -wait`: the engine is designed to come up against a broker and a
# media server that are not ready yet — the ARI socket reconnects, the routing
# watch retries with backoff, and `/healthz` tells the truth in the meantime.
CMD ["node", "/service/dist/main.js"]
