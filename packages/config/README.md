# @optimiq-voice/config

The single validated view of the process environment. Nothing else in the monorepo reads
`process.env` directly — import `env` from here instead.

## What it does, in order

1. Loads the **one** dotenv file: the repository root `.env`. Nothing above the repo root is
   ever read, and there is no `.env.local` cascade.
2. Hydrates `APP_ENV_CONTENT` (a secret-manager blob, either a JSON object or a
   dotenv-formatted string). It only fills in **unset** keys — real process env always wins.
3. Aliases the transitional `API_DATABASE_URL` / `API_NATS_URL` onto the canonical
   `DATABASE_URL` / `NATS_URL`.
4. Parses everything through a Zod v4 schema. Booleans use a strict `z.stringbool`
   (`true`/`1` vs `false`/`0`/empty) — `z.coerce.boolean()` would treat `"false"` as true.
5. Runs `assertEnvInvariants`, which throws on cross-field violations and, in production, on
   any secret still carrying a `.env.example` placeholder.

A failure at any step throws at import time. The process never boots half-configured.

## Exports

```ts
import { env, getEnvVar, getEnvEntries } from "@optimiq-voice/config";
```

- `env` — the parsed, typed, defaulted environment.
- `getEnvVar(key)` — raw string lookup for keys outside the schema (tooling, migrations).
- `getEnvEntries()` — every raw string entry, for passing an environment to a child process.

## Production invariants

Production refuses to start unless: `DATABASE_URL`, `NATS_URL` and `AUTH_SECRET` (≥32 chars)
are set; `AUTH_URL` and `API_APP_URL` are HTTPS; `ROUTR_EXTERNAL_ADDRS`,
`ASTERISK_SIPPROXY_HOST` and `RTPENGINE_PUBLIC_IP` are real addresses rather than the
`/* Set to … */` marker; and no ARI/SIP/Postgres/Influx/cloak secret still equals its
`.env.example` placeholder. RTP port ranges are checked in every environment.

## Adding a variable

Add it to `envSchema` in `src/env.ts` with an explicit default or `.optional()`. If it only
makes sense together with another variable, put that rule in `src/env-invariants.ts` and add
a spec — never a runtime `if` scattered across a service.

## Commands

```sh
pnpm --filter @optimiq-voice/config build
pnpm --filter @optimiq-voice/config typecheck
bun test packages/config/src
```
