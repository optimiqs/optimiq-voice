FROM node:22-alpine AS builder

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
RUN pnpm --filter @optimiq-voice/mcp... run build \
    && PNPM_CONFIG_INJECT_WORKSPACE_PACKAGES=true pnpm --filter @optimiq-voice/mcp deploy --prod /prod/mcp

FROM node:22-alpine AS release

ENV NODE_ENV=production

COPY --from=builder /prod/mcp /app

WORKDIR /app

ENTRYPOINT ["node", "dist/index.js"]
