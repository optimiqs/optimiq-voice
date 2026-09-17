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
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /out/sipd ./apps/sipd/cmd/sipd

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /out/sipd /usr/local/bin/sipd
USER 1001:1001
ENV SIPD_HEALTH_ADDR=0.0.0.0:9090
EXPOSE 5060/tcp 5060/udp 5061/tcp 5088/tcp 5088/udp 8089/tcp 9090/tcp
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD ["/usr/local/bin/sipd", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/sipd"]
