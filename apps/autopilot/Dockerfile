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

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml lerna.json turbo.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

RUN pnpm --filter @optimiq-voice/autopilot... run build \
    && PNPM_CONFIG_INJECT_WORKSPACE_PACKAGES=true pnpm --filter @optimiq-voice/autopilot deploy --prod /prod/autopilot \
    && cp apps/autopilot/*.onnx /prod/autopilot/

##
# Run stage
##
FROM node:22-slim

ENV ASSISTANT=/opt/optimiq-voice/assistant.json

RUN groupadd -r appuser && useradd -r -g appuser -m -d /home/appuser appuser

COPY --from=builder --chown=appuser:appuser /prod/autopilot /home/appuser/autopilot

WORKDIR /home/appuser/autopilot

USER appuser

CMD ["node", "/home/appuser/autopilot/dist/server.js"]
