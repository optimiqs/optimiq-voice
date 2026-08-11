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

Broker credentials are checked as a PAIR rather than as two names: production needs either the
shared `NATS_USER` / `NATS_PASS` or one whole per-service pair (`NATS_API_*`, `NATS_ENGINE_*`,
`NATS_MEDIAD_*`, `NATS_SIPD_*`), because a split deployment ships each container only the identity
it uses. Every per-service password present is placeholder-checked whether or not this process is
the one that will connect with it.

## Broker identity and TLS

`natsCredentials(source, service?)` resolves the connection identity. With a service tag it prefers
`NATS_<SERVICE>_USER` / `NATS_<SERVICE>_PASS` — the least-privilege user `config/nats.conf` defines
for that service — and falls back to the shared pair, which is the operator identity the `nats` CLI
and the `pnpm verify:*` harnesses use. A HALF-SET pair throws, per pair: falling back from half a
service pair would silently promote the process onto the operator credential.

`natsTlsOptions(source)` resolves transport security and defaults to OFF. `NATS_TLS_CA` is a CA
bundle path — it enables TLS and pins that CA — and `NATS_TLS_ENABLED=true` is TLS against the
system trust store. `natsConnectionOptions(source, service?)` is both together, which is what every
first-party connection site spreads.

### What it does NOT cover

The placeholder check is exact string matching against `PLACEHOLDER_SECRETS`, so it catches a
value left as shipped and nothing else. It does not catch:

- **An unset variable that a service defaults in code.** `apps/api`'s `envs.ts` falls back to
  `"changeme"` for `API_OWNER_PASSWORD` and `API_ROUTR_DEFAULT_PEER_PASSWORD`; the second is not
  in `.env.example` at all, so it is that value in every deployment. Unset is not a placeholder,
  so neither is refused.
- **Secrets outside the checked list:** `INFLUXDB_INIT_TOKEN` / `API_INFLUXDB_INIT_TOKEN`, the
  passwords embedded in `API_DATABASE_URL`, `API_IDENTITY_DATABASE_URL` and `ROUTR_DATABASE_URL`,
  `SMTP_PASS` / `API_SMTP_AUTH_PASS`, `API_TWILIO_AUTH_TOKEN` and the `AUTOPILOT_*` keys.
- **A weak secret that is merely different.** Only `AUTH_SECRET` has a length rule.

The literal strings in `PLACEHOLDER_SECRETS` are load-bearing: they are what `.env.example`
ships. Changing a placeholder in one place without the other turns a loud startup failure into a
deployment running on a public password.

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
