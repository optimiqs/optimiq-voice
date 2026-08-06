# Optimiq Voice

[![ci](https://github.com/optimiqs/optimiq-voice/actions/workflows/ci.yaml/badge.svg)](https://github.com/optimiqs/optimiq-voice/actions/workflows/ci.yaml)
[![license](https://img.shields.io/github/license/optimiqs/optimiq-voice?color=%2347b96d)](./LICENSE)

A multi-tenant cloud phone system. One deployment serves many organizations: each gets its own
extensions, IVRs, ring groups, queues, conference rooms, voicemail, park lots, time conditions and
call detail records, isolated at the database level by row-level security rather than by convention.

Numbers arrive over SIP from a carrier, the routing compiler turns an organization's configuration
into a deterministic artifact, and the call engine walks that artifact against a real channel. Every
significant thing that happens on a call is a typed event on a NATS backbone, which is also how the
admin UI shows live state.

## Architecture

| Piece             | What it is                                                                                                                                                           | Where                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Control-plane API | NestJS 11 on Fastify 5, Effect 4, Drizzle + Postgres. One HTTP listener on 9876: `/api/auth/*` and `/api/v1/*`. Owns tenancy, auth, provisioning and the PBX schema. | `apps/api`                              |
| Admin frontend    | Next.js 16 App Router. Talks to the API through a same-origin proxy so the session cookie stays first-party.                                                         | `apps/web`                              |
| Call engine       | Turns Asterisk ARI events into domain state, walks the compiled routing artifact, publishes call events and emits one CDR per leg.                                   | `apps/engine`                           |
| SIP edge          | Go 1.26 SIP service. Today a registrar: digest auth, AOR bindings in NATS KV, `sip.reg.v1` transitions. Proxying is next.                                            | `apps/sipd`                             |
| Media server      | A dockerized Asterisk 22 (LTS) with generated `pjsip`/`ari` config. Scaffolding — the engine drives it over ARI.                                                     | `apps/asterisk`                         |
| Event backbone    | The versioned subject taxonomy, Zod event schemas and JetStream stream/KV definitions every service shares. A Go peer is generated from it and drift-gated in CI.    | `packages/events`, `packages/events-go` |
| Routing compiler  | Compiles a PBX configuration snapshot into a cacheable routing artifact and resolves inbound, internal and outbound calls against it.                                | `packages/routing`                      |
| Carrier           | Typed Telnyx API v2 client, with an in-package fake Telnyx server for tests.                                                                                         | `packages/telnyx`                       |

Postgres and NATS (JetStream) round out the runtime; both are in `compose.yaml`, which now
describes the whole stack and nothing else. The legacy platform's `routr`, `rtpengine`, `influxdb`,
`envoy`, `autopilot` and `dashboard` services have been deleted along with their code — `apps/web`
is the ingress, `apps/sipd` is the SIP edge, and call records live in Postgres
(`packages/cdr-db`), not in a metrics bucket.

## Repository layout

```
apps/
  api          control-plane API (NestJS + Fastify + Effect)
  web          admin frontend (Next.js 16) — the stack's ingress
  engine       ARI-driven call engine
  sipd         Go SIP edge (registrar)
  asterisk     Asterisk 22 image, config and run script
packages/
  auth         better-auth composition, permission registry, call-token verifier
  cdr-db       CDR bounded context: per-leg records, call events, recordings
  config       the one validated view of the environment
  db           schema primitives, tenant RLS wrappers, preflight harness
  effect-runtime  Effect <-> NestJS seam
  events       NATS contract (subjects, schemas, streams)
  events-go    generated Go peer of packages/events
  identifiers  UUID v7 entity identifiers
  logging      redacting Pino logger
  media-ari    typed Asterisk 22 ARI adapter (protocol only)
  pbx-db       telephony bounded context: PBX schema, RLS policies
  routing      routing compiler
  telephony    pure call domain: state machines, verbs, hangup causes
  telnyx       Telnyx client and fake server
config/        nats.conf — the broker's accounts and JetStream settings
openspec/      specifications and in-flight change proposals
plans/         migration plans and research notes
```

Nothing inherited from the platform this fork started as remains. The gRPC API and its identity,
authz, sipnet, streams, SDK, CLI, MCP, autopilot and dashboard companions were deleted rather than
carried; multi-tenancy is `organization.id` under row-level security, and there is no `accessKeyId`
anywhere in the tree. An AI-agent application returns later as a session-protocol consumer of
`apps/engine`, not as a resurrection of `apps/autopilot`.

## Quickstart

**Requirements:** Node >= 22.13.0, pnpm 11.20.0, Docker, and Go 1.26 to work on `apps/sipd`.
Package tests run under Bun (CI pins 1.3.11).

```bash
# 1. Configuration. This file is local-development only and every secret in it is public.
cp .env.example.dev .env

# 2. Dependencies.
pnpm install

# 3. Build. Workspace packages resolve through their built output, so this comes first.
pnpm run build

# 4. Infrastructure: Postgres, NATS and Asterisk, plus Adminer on :8282 and MailHog on :8025.
pnpm run start:services

# 5. Schema. Creates and migrates all three databases: base, PBX and CDR.
pnpm run db:migrate

# 6. The API's HTTP bridge on :9876.
pnpm run start:api

# 7. The admin frontend on :3100, in a second terminal.
pnpm --filter @optimiq-voice/web run dev
```

Sign up at <http://localhost:3100>; the first account creates its own organization. Mail is
delivered to MailHog, so verification, invitation and voicemail messages are real messages you can
open at <http://localhost:8025>.

Stop everything with `pnpm run stop:services`.

Optional demo data: `pnpm run db:seed`, `pnpm --filter @optimiq-voice/api run seed:pbx`,
`pnpm --filter @optimiq-voice/api run seed:cdr`.

## Everyday commands

```bash
pnpm run build            # turbo run build
pnpm run typecheck        # turbo run typecheck
pnpm run lint             # oxlint
pnpm run format           # oxfmt
pnpm run format:check     # oxfmt --check
pnpm run db:generate      # regenerate migrations across every schema package
```

Tests are split by runner: every package and `apps/web` / `apps/engine` use Bun, `apps/api` uses
Mocha, and `turbo run test` runs all of them. The root `pnpm test` is the pre-push gate and resolves
to the same `apps/api` files.

```bash
pnpm exec turbo run test                         # everything
pnpm --filter @optimiq-voice/engine run test     # bun test src
pnpm --filter @optimiq-voice/api run test        # mocha
pnpm run test                                    # root Mocha suite (needs .env)
cd apps/sipd && go test ./...                    # Go SIP edge
```

CI (`.github/workflows/ci.yaml`) runs `turbo run build`, `turbo run test` and `turbo run typecheck`,
checks that the Go event peer has not drifted from `packages/events`, and runs the Go module tests.
The `verify:*` scripts in `apps/api` and the `smoke:*` scripts in `apps/web` are not part of CI —
they need a live Postgres, NATS and Asterisk to run against.

## Running the whole stack in containers

`compose.yaml` is the deployment topology — `web`, `api`, `engine`, `asterisk`, `postgres` and
`nats`, with `web` on `WEB_PORT` (3100) as the only published port. `compose.dev.yaml` overlays
local builds, published ports and the two development-only containers (Adminer, MailHog).

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
```

For a real deployment, start from `.env.example` instead. It is the production template: it ships
placeholders rather than credentials, and `@optimiq-voice/config` refuses to boot a
`NODE_ENV=production` process that still carries them. The file lists which secrets that preflight
enforces and which it does not.

## Status

This is a platform under active migration, not a finished product. The routing compiler, the PBX
schema and the admin frontend are the mature parts. The call engine implements a subset of the
session protocol and reports the rest as unsupported rather than pretending; `apps/sipd` registers
endpoints but does not yet proxy calls; E911 addresses are stored but never sent to a carrier; and
container publishing beyond the Asterisk image is not wired up yet. Where something is not built,
the code and the UI say so.

## Contributing

Bugs, questions and discussion belong in
[GitHub Issues](https://github.com/optimiqs/optimiq-voice/issues).

<!-- readme: contributors -start -->
<!-- readme: contributors -end -->

## License

[MIT](./LICENSE)
