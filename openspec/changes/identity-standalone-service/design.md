# Design notes

## Reuse, don't fork

`buildIdentityService(config)` already returns `{ definition, handlers }`. The standalone
service is a thin bootstrap around it — the same shape `apps/api`'s `loadServices` uses,
minus the telephony services. The goal is **one** source of truth for the Identity allow-list and
the accept-invite bridge; today they live inside `apps/api` (`core/allowList.ts`,
`core/httpBridge.ts`). Extract them so both the monolith and the standalone service import them,
preventing drift.

## What the standalone service is NOT

- It does not start NATS, InfluxDB, Asterisk/ARI, or call management. Those are telephony concerns
  that stay in `apps/api`.
- It does not change the Identity domain logic or proto surface.

## Why extend `packages/identity` instead of a new package

`packages/identity` already owns the canonical Drizzle schema + migrations and exposes a `bin` — it is
half a service already. Creating a separate `packages/identity-service` would add a package whose only
job is to import the neighbor next door, and Optimiq Voice's convention is "libraries composed by one
api" (no per-service packages). The one real concern with making a library also runnable is
dependency bloat for pure-library importers; that is solved with package `exports`:

- `@optimiq-voice/identity` (main export) — the library: `buildIdentityService`, schema, helpers. Server-free.
- `@optimiq-voice/identity/server` (subpath export) + a `serve` bin — the runnable gRPC service.

So `api` keeps importing the library; the standalone deployment uses the `server` entry / bin / image.

## Configuration source

`IdentityConfig` (db URL, encryption key, RS256 key pair, issuer, audience, token expirations,
OAuth2, contact-verification/2FA flags, SMTP) is read from environment/file and validated at
startup. This mirrors how `apps/api` builds `identityConfig` from envs today, so the same
values map cleanly.

## Database ownership

`packages/identity/src/db/schema.ts` is the canonical schema. The service ships it plus migrations
and a provisioning entrypoint backed by Drizzle. Consumers point at the running service and never
need the database runtime.

## Reference implementation

QCobro already runs a working slim version of exactly this (a `buildIdentityService` → gRPC server
wrapper, config-from-file, a vendored schema for `db push`, and a Dockerfile). It is a proof of
concept for this change; the work here is to land that runner as the `packages/identity` server entry
(maintained upstream), with the allow-list/bridge reused rather than re-implemented, and the schema
consumed in place rather than vendored.
