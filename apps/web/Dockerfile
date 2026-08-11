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
COPY tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY .scripts ./.scripts

# Filtered install: the web app's graph is `@optimiq-voice/{auth,pbx-db,routing,telnyx}` and their
# transitive workspace packages. Installing the whole workspace would also pull in the API's and
# the engine's dependency trees, which this image never runs.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline --filter @optimiq-voice/web...

##
# Build-time configuration.
#
# `API_PROXY_ORIGIN` is NOT a runtime knob. Next evaluates `rewrites()` during `next build` and
# bakes the destination into the standalone server's inlined config, so the origin the container
# proxies `/api/*` to is whatever was passed HERE — setting it on the running container does
# nothing. The default names the compose service, so the shipped image works unconfigured.
#
# `NEXT_PUBLIC_*` is inlined into the client bundle for the same reason. Never pass a secret.
##
ARG API_PROXY_ORIGIN=http://api:9876
ARG NEXT_PUBLIC_AUTH_BASE_URL=
ENV API_PROXY_ORIGIN=${API_PROXY_ORIGIN} \
    NEXT_PUBLIC_AUTH_BASE_URL=${NEXT_PUBLIC_AUTH_BASE_URL} \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

# `...` builds the workspace dependencies first. It is load-bearing rather than a convenience:
# every `@optimiq-voice/*` package resolves through its `exports` to `dist/`, and the web build's
# own `codegen` step imports `@optimiq-voice/auth/permissions` before a single page is compiled.
RUN pnpm --filter @optimiq-voice/web... run build

##
# Run stage
#
# No `pnpm deploy --prod` here, unlike the backend services. Next's `output: "standalone"` already
# emits a self-contained server carrying only the traced `node_modules` it actually reaches — a
# second, unpruned copy of the dependency tree would be both larger and wrong.
##
FROM node:22-slim

RUN groupadd -g 1001 appuser && useradd -u 1001 -g appuser -m appuser

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3100 \
    HOSTNAME=0.0.0.0

WORKDIR /service

# Paths inside the standalone output are relative to `outputFileTracingRoot` (the repository root),
# which is why the server lands at `apps/web/server.js` and not at the top level.
COPY --from=builder --chown=appuser:appuser /work/apps/web/.next/standalone ./
# The static chunks are deliberately excluded from the standalone trace — nothing imports them,
# the browser fetches them — so they must be copied in separately or every page loads unstyled.
COPY --from=builder --chown=appuser:appuser /work/apps/web/.next/static ./apps/web/.next/static

USER appuser

EXPOSE 3100

# Any non-5xx answer means the server is routing. `/` legitimately redirects a signed-out visitor
# to the sign-in page, so `response.ok` would report a healthy container as unhealthy.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "/service/apps/web/server.js"]
