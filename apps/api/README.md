# @optimiq-voice/api

The Optimiq Voice control plane. NestJS 11 on a Fastify 5 adapter, Effect 4, Drizzle over Postgres.

It owns tenancy and authentication, the PBX configuration schema, provisioning, call detail records
and live call state — everything `apps/web` reads and writes, and the source the routing compiler
snapshots.

- gRPC on `50051`
- HTTP bridge on `9876` (what `apps/web` proxies `/api/*` to, which keeps the session cookie
  first-party)

## Boot preflights

`src/main.ts` refuses to start rather than serving in a state that looks fine and is not. Each check
runs before `NestFactory.create`:

- **Tenant RLS** — asserts the telephony database's tenant role, its grants and every per-table
  policy against `API_TENANT_RLS_PLAN`. A policy that silently failed to apply is indistinguishable
  from one that works until the day it leaks.
- **Mail** — the log-only fallback is legitimate in development and refused in production, because
  verification, password-reset and invitation messages are one-time links.
- **CDR** — asserted when the CDR area is enabled.

The environment itself is validated earlier still, at import of `@optimiq-voice/config`, which also
refuses production values left at their `.env.example` placeholders.

## Commands

```sh
pnpm --filter @optimiq-voice/api run start:dev   # nodemon + tsx against src/main.ts
pnpm --filter @optimiq-voice/api run build
pnpm --filter @optimiq-voice/api run test
pnpm --filter @optimiq-voice/api run typecheck   # tsconfig.json and tsconfig.strict.json
pnpm --filter @optimiq-voice/api run db:generate # drizzle-kit generate
pnpm --filter @optimiq-voice/api run db:deploy
```

Demo data: `seed:pbx`, `seed:cdr`.

`scripts/` also holds a set of `verify:*` end-to-end checks (`verify:auth`, `verify:pbx`,
`verify:cdr`, `verify:voicemail`, `verify:tenancy`, and others). They exercise a running stack —
Postgres, NATS and Asterisk — so they are deliberately not part of CI. Run them against
`pnpm run start:services` from the repository root.
