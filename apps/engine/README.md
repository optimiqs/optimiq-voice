# `@optimiq-voice/engine`

The call engine — the PBX brain from plan §3.2. NestJS 11 + Fastify 5 + Effect 4, ESM.

It turns media-server events into domain state transitions, publishes the resulting facts on the
NATS backbone, mirrors live channel state into JetStream KV, and emits one CDR per finished leg.

## The P2 slice

This is the T0 substrate, not the PBX. What works end to end today:

- **Inbound call arrival.** `StasisStart` → a `ChannelAggregate` built on
  `@optimiq-voice/telephony`'s state machines → `channel.created` on
  `calls.evt.v1.<org>.<call>.channel.created`.
- **Progress and answer.** ARI channel states map to the user-visible call state that drives BLF;
  `channel.ringing` and `channel.answered` are published, and the billing clock starts at answer.
- **DTMF.** Each digit is published as `channel.dtmf` and queued for a `gather`.
- **Teardown.** `channel.hangup` (why) → `channel.destroyed` (that) → `cdr.leg.write` (what it
  cost), then the KV entry is cleared.
- **Verbs.** `answer`, `ringing`, `play`, `gather` and `hangup` of the 28-verb session protocol.
  The other 23 return a typed `UnsupportedVerbFailure` — an honest answer, not a silent no-op.
- **Drain.** Stop admitting calls, wait for the live ones, then hang up the stragglers with
  `NORMAL_TEMPORARY_FAILURE`.

**Not here yet:** routing (inbound routes, IVR, ring groups, queues), dial/bridge/transfer,
recording, and the session-protocol server. Those are P3. The P2 inbound program is deliberately
trivial — `ringing` → `answer` → optional announcement — so that the event chain, the state
machines, the KV mirror and the CDR can be proven before anything interesting is layered on top.

## Architecture

```
   Asterisk 22 ──ARI events──▶ AriConnectionService ──▶ ChannelOrchestrator
        ▲                                                │  │  │
        │                                                │  │  └─▶ JetStreamService
   MediaPort ◀── VerbExecutor (Effect) ◀──runtime────────┘  │      · channels KV (put/delete)
   (AriMediaAdapter)                                        │      · cdr.leg.write (acked publish)
                                                            └─▶ CallEventPublisher
                                                                 · calls.evt.v1.* (Nest NATS)
```

**`MediaPort`** (`src/ari/media-port.ts`) is the seam the whole media strategy rests on. It speaks
domain vocabulary — `HangupCause`, milliseconds, playback references — never ARI's. Swapping in
`apps/mediad` is a change to one `useFactory` in `ari.module.ts` and nothing else.

**Two NATS clients, on purpose.** Per the owner decision in plan §3.5 there is no custom NATS
framework: call lifecycle events go through NestJS's NATS transport (a core publish; the `CALLS`
stream ingests them anyway, and paying for a per-event ack would put a round trip in the call
path), while KV and the CDR use the raw `nats` JetStream API. The CDR needs the ack: the `CDR`
stream is `discard: new` precisely so an overflowing broker refuses the write instead of silently
dropping revenue, and a core publish cannot see that refusal. The publish carries the envelope's
UUID v7 as `msgID`, so a retry is deduplicated rather than billed twice.

**Identifiers are deterministic.** `legIdForAriChannel` / `callIdForAriChannel` derive UUIDs from
the media server's channel id, so an engine that restarts mid-call arrives at the same ids as the
one that died — which is what makes the KV snapshot usable for failover instead of decorative.

## Configuration

| Variable                         | Default                 | Notes                                                |
| -------------------------------- | ----------------------- | ---------------------------------------------------- |
| `ARI_URL`                        | `http://localhost:8088` | With or without `/ari`                               |
| `ARI_USERNAME` / `ARI_PASSWORD`  | `ari` / — (required)    | A missing password stops the process at boot         |
| `ARI_APP`                        | `optimiq-engine`        | The `Stasis()` application name                      |
| `ARI_SUBSCRIBE_ALL`              | `false`                 | `true` means one engine sees every tenant's channels |
| `NATS_URL`                       | `nats://localhost:4222` |                                                      |
| `ENGINE_ENSURE_STREAMS`          | `true`                  | Applies the `@optimiq-voice/events` definitions      |
| `ENGINE_PORT` / `ENGINE_HOST`    | `4010` / `0.0.0.0`      | `/healthz` and `/livez` only                         |
| `ENGINE_DEFAULT_ORGANIZATION_ID` | unset                   | Dev only — see below                                 |
| `ENGINE_DRAIN_TIMEOUT_MS`        | `30000`                 |                                                      |
| `ENGINE_INBOUND_ANNOUNCEMENT`    | unset                   | e.g. `sound:unavailable`                             |

**The dialplan must set `OPTIMIQ_ORG_ID`** to the tenant's UUID before `Stasis()`. A call with no
resolvable organization is REJECTED with `INVALID_PROFILE`, never filed under a guess: a
mis-attributed CDR is both a billing error and a tenant-isolation breach, and both are silent.
`ENGINE_DEFAULT_ORGANIZATION_ID` provides a single-tenant development fallback and should be unset
in production.

## Health

`GET /healthz` — `200` when the ARI event socket is open, NATS is connected and the instance is not
draining; `503` otherwise. A draining instance reports `503` on purpose: it must keep serving its
live calls while a load balancer takes it out of rotation.

`GET /livez` — `200` while the process is up. Deliberately dependency-free: a liveness probe that
fails on a broker blip restarts a healthy process and turns a blip into an outage.

## Tests

```sh
pnpm --filter @optimiq-voice/engine test              # 131 pure specs, no Docker
pnpm --filter @optimiq-voice/engine test:integration  # + 3 against real Asterisk + NATS
```

The pure suite drives whole calls through the orchestrator with fake ports — arrival, answer, DTMF,
hangup, CDR, KV lifecycle and drain — with no Asterisk, no NATS and no clock control.

The integration suite starts `nats:2.11-alpine -js` and an `apps/asterisk` container, boots the
engine against both, originates a real call, and asserts that the `calls.evt.*` events arrive in
order and schema-valid, that the `channels` KV entry appears and then clears, and that exactly one
`cdr.leg.write` is published with an answered disposition. Set `NATS_INTEGRATION_URL` /
`ARI_INTEGRATION_URL` to use services you already run; only containers the suite started are
removed.
