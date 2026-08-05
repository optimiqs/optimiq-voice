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

ARG DASHBOARD_VERSION
ARG DASHBOARD_EDITION
ARG DASHBOARD_API_URL
ARG DASHBOARD_ALLOW_INSECURE
ARG DASHBOARD_AUTH_GITHUB_ENABLED
ARG DASHBOARD_AUTH_GITHUB_CLIENT_ID
ARG DASHBOARD_AUTH_GITHUB_URL
ARG DASHBOARD_AUTH_GITHUB_CALLBACK_URL
ARG DASHBOARD_RESET_PASSWORD_URL
ENV DASHBOARD_VERSION=${DASHBOARD_VERSION} \
    DASHBOARD_EDITION=${DASHBOARD_EDITION} \
    DASHBOARD_API_URL=${DASHBOARD_API_URL} \
    DASHBOARD_ALLOW_INSECURE=${DASHBOARD_ALLOW_INSECURE} \
    DASHBOARD_AUTH_GITHUB_ENABLED=${DASHBOARD_AUTH_GITHUB_ENABLED} \
    DASHBOARD_AUTH_GITHUB_CLIENT_ID=${DASHBOARD_AUTH_GITHUB_CLIENT_ID} \
    DASHBOARD_AUTH_GITHUB_URL=${DASHBOARD_AUTH_GITHUB_URL} \
    DASHBOARD_AUTH_GITHUB_CALLBACK_URL=${DASHBOARD_AUTH_GITHUB_CALLBACK_URL} \
    DASHBOARD_RESET_PASSWORD_URL=${DASHBOARD_RESET_PASSWORD_URL}
RUN pnpm --filter @optimiq-voice/dashboard... run build \
    && PNPM_CONFIG_INJECT_WORKSPACE_PACKAGES=true pnpm --filter @optimiq-voice/dashboard deploy --prod /prod/dashboard

FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=3030

COPY --from=builder /prod/dashboard /app

WORKDIR /app

CMD ["node", "node_modules/@react-router/serve/bin.js", "build/server/index.js"]
