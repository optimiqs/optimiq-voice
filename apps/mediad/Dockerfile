# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM golang:1.26-alpine3.22 AS build
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src
COPY go.work go.work.sum ./
COPY packages/events-go ./packages/events-go
COPY packages/runtime-go ./packages/runtime-go
COPY apps/sipd ./apps/sipd
COPY apps/mediad ./apps/mediad
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /out/mediad ./apps/mediad/cmd/mediad

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && mkdir -p /var/lib/optimiq/objects && chown 1001:1001 /var/lib/optimiq/objects
COPY --from=build /out/mediad /usr/local/bin/mediad
USER 1001:1001
ENV MEDIAD_HEALTH_ADDR=0.0.0.0:9091
EXPOSE 9091/tcp 30000-30999/udp
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD ["/usr/local/bin/mediad", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/mediad"]
