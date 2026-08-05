## 1. Extract shared cross-cutting concerns from api

- [ ] 1.1 Move the Identity public-method allow-list into a reusable export (consumed by both the api and the standalone service)
- [ ] 1.2 Extract the accept-invite HTTP bridge so it can run beside the standalone service
- [ ] 1.3 Confirm `apps/api` still composes Identity using the extracted helpers (no behavior change)

## 2. Make `packages/identity` runnable

- [ ] 2.1 Add a server entrypoint to `packages/identity` (exposed via a `./server` subpath export and a `serve` bin) that calls `buildIdentityService(config)` and binds a `@grpc/grpc-js` server with the auth interceptor + allow-list
- [ ] 2.2 Keep the package's main export server-free so library importers (e.g. `api`) pull no server runtime
- [ ] 2.3 Add a gRPC health service and serve the accept-invite HTTP bridge; optional default-user seeding (`upsertDefaultUser`) gated on configuration

## 3. Configuration

- [ ] 3.1 Load and validate `IdentityConfig` from environment/file; fail fast with a clear error on missing/invalid required values
- [ ] 3.2 Document every configuration key (db, encryption key, RS256 keys, issuer/audience, expirations, OAuth2, verification/2FA, SMTP, port)

## 4. Database provisioning

- [ ] 4.1 Ship the Identity Drizzle schema + migrations with the service
- [ ] 4.2 Provide a `migrate`/`db-provision` entrypoint so consumers never vendor the schema

## 5. Packaging & release

- [ ] 5.1 Add a Dockerfile and publish an image (e.g. `ghcr.io/optimiq-voice/identity`) via CI
- [ ] 5.2 Provide a compose example wiring the service + Postgres + a dev mailer

## 6. Verification

- [ ] 6.1 The service starts, serves the `optimiq_voice.identity.v1beta2` surface on the configured port, and reports healthy
- [ ] 6.2 Allow-listed methods (sign-up, login, get-public-key) work without a token; non-allow-listed methods require a valid access token
- [ ] 6.3 A fresh database is provisioned by the entrypoint and the end-to-end sign-up → login → create-workspace flow succeeds against the standalone service
