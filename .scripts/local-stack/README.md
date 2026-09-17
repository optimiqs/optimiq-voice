# Local end-to-end stack

The real platform — API, web, engine, sipd, mediad, NATS, Postgres — running on this machine on
ports shifted away from the defaults, so it can sit alongside a developer's own Postgres on 5432,
NATS on 4222 and dev server on 3000 without colliding with any of them.

Infrastructure that has no reason to be debuggable runs in Docker (Postgres only). Everything else
runs natively, so a service can be restarted, profiled or attached to on its own.

## Start, stop, look

```sh
.scripts/local-stack/up.sh           # everything; idempotent, only starts what is down
.scripts/local-stack/up.sh api       # just one service (postgres nats smtp mediad sipd engine api web)
.scripts/local-stack/status.sh       # port map, health codes, broker connections by user
.scripts/local-stack/logs.sh engine  # tail one service; no argument lists them
.scripts/local-stack/down.sh         # stop everything, keep the data
.scripts/local-stack/down.sh --purge # ... and drop the database volume and object store
```

`up.sh` refuses to start a service whose port is held by something else, and names the holder.

## Where things live

Nothing mutable is written into the checkout. State lives under `$STACK_HOME`, which defaults to the
session scratchpad and can be overridden in the environment:

| Path                  | Contents                                                     |
| --------------------- | ------------------------------------------------------------ |
| `$STACK_HOME/env`     | generated per-service env files and `secrets.env`             |
| `$STACK_HOME/logs`    | one log per service                                           |
| `$STACK_HOME/pids`    | one pid file per native service                               |
| `$STACK_HOME/objects` | the object store: recordings, prompts, voicemail             |
| `$STACK_HOME/mail`    | every message the SMTP fixture captured, as `.eml`            |
| `$STACK_HOME/certs`   | the self-signed certificate for the TLS and WSS listeners     |
| `$STACK_HOME/nats`    | the broker overlay config and its JetStream store             |

Secrets are generated once with `openssl rand` on the first `up.sh` and reused after that. Deleting
`secrets.env` regenerates them, which invalidates every existing session cookie and database login —
run `reset-db.sh` afterwards.

## Ports

`ports.env` is the single source of truth; `status.sh` prints the live map. See
`<scratchpad>/audit/STACK.md` for the full table with URLs.

## Configuration

`render-env.sh` writes one env file per service from `ports.env` plus `secrets.env`. Every variable a
process reads is written explicitly, on purpose: `packages/config` hydrates *unset* variables from
the repository root `.env`, a legacy file naming a 5432 Postgres and an Asterisk that is not part of
this stack, so a variable omitted here does not stay unset — it picks up the wrong value silently.

The broker runs the **real** `config/nats.conf`. `up.sh` symlinks it as `nats-base.conf` next to a
small overlay that `include`s it and then shifts the client port, the monitoring port and the store
directory (nats-server resolves an `include` relative to the including file and rejects an absolute
path, hence the symlink). The accounts, the five users and their per-service permission allow-lists
are therefore exactly the ones the deployment ships.

## Databases

Three databases in one container: `optimiq_voice`, `optimiq_pbx`, `optimiq_cdr`.

`up.sh` runs all four migration journals through `.scripts/migrate-platform.mjs`, then provisions the
three runtime logins with `provision-roles.sql` per `docs/native-calling-deployment.md`: `voice_api`,
`voice_pbx` and `voice_cdr`, non-superuser, with `voice_pbx` and `voice_cdr` additionally holding
BYPASSRLS and membership in their tenant role. Services connect as those logins; only the migration
job uses the owner.

To re-run migrations only, re-run `up.sh` — the journals are idempotent.

To start over:

```sh
.scripts/local-stack/reset-db.sh
```

That drops and recreates the three databases, re-migrates, re-provisions the roles, clears the
JetStream store and the object store, and restarts engine, api and web.

## Smoke call

```sh
MAIL_DIR=$STACK_HOME/mail node .scripts/local-stack/smoke-call.mjs
```

Signs up two users through the real web app, verifies the second one through the captured mail,
creates an organization and two extensions, registers two Playwright softphones over WSS, calls
1001 → 1002, answers, measures inbound RTP packets and audio energy on both legs, holds, resumes,
hangs up and reads back the call history.

It has to run against a fresh database: an organization's SIP domain is a deployment-wide unique
claim, so a second run cannot take `local.test` back. Run `reset-db.sh` first. (A second
organization does NOT need `local.test` — it registers under its own domain, and `STACK_REALM`
points this script at one; only this script's re-use of `local.test` is what needs the reset.)

Chromium is launched with `--ignore-certificate-errors` because the WSS listener presents the
self-signed certificate generated into `$STACK_HOME/certs`.
