# `@optimiq-voice/engine`

The call engine — the PBX brain from plan §3.2. NestJS 11 + Fastify 5 + Effect 4, ESM.

It turns media-server events into domain state transitions, publishes the resulting facts on the
NATS backbone, mirrors live channel state into JetStream KV, and emits one CDR per finished leg.

## What works end to end today

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

- **Routing.** The organization's compiled routing artifact is read from the `routing-cache` KV
  bucket (watched for updates, version-guarded), with `rpc.routing.v1.resolve` as the miss path.
  `packages/routing`'s resolvers turn the call's facts into an `ExecutionPlan`, and the
  {@link PlanWalker} executes it — see the next section.
- **Dial and bridge.** Extensions and ring groups are originated over ARI and bridged on answer,
  with `LOSE_RACE` cleanup for the losers of a ring-all.

**Not here yet:** queues, conferences, park, attended/blind transfer, real voicemail (boxes, MWI,
email), answer confirmation, B-leg CDRs, and the session-protocol server. Every one of them is
named in the walk's `notes`, so a call that hit a gap says so in the log rather than looking like a
routing bug.

## Routing

```
inbound INVITE on a DID
        │
        ▼  Stasis(optimiq-engine), with OPTIMIQ_ORG_ID set by the dialplan
  RoutingArtifactSource
        │  memory ──▶ routing-cache KV ──▶ rpc.routing.v1.resolve
        ▼
  resolveInbound / resolveInternal / resolveOutbound   (@optimiq-voice/routing)
        │
        ▼  ExecutionPlan { entryNodeId, nodes }
    PlanWalker ──▶ VerbExecutor ──▶ MediaPort
        │
        └──▶ calls.evt.v1.* per step, cdr.leg.write with destinationType/Ref
```

**`RoutingArtifactSource`** (`src/routing/routing-artifact.source.ts`) is three layers deep:
in-process memory, then the KV bucket, then the RPC. Invalidation is a KV **watch**, not a TTL —
`apps/api` writes the artifact in the same unit of work as the row change, so its `put` *is* the
invalidation signal. The bucket's 1 h TTL stays a backstop. A watch that dies drops every memory
copy, because an engine that stopped hearing about changes must not keep serving the last thing it
heard as if it were current. An artifact whose `artifactVersion` this release does not understand
is discarded and recompiled, never walked best-effort.

**`PlanWalker`** (`src/routing/plan-walker.ts`) walks the node table as an explicit loop with a step
budget, because the table is a graph: an IVR option may point back at its parent menu, and a
recursive walker would express that as a stack overflow on a live call.

| Node kind                      | Status                                                             |
| ------------------------------ | ------------------------------------------------------------------ |
| `extension`                    | Originate, bridge on answer; busy / no-answer / not-registered branches |
| `ring-group`                   | `simultaneous` (multi-originate, first answer wins, losers get `LOSE_RACE`) and `sequential` (per-member timeout, `ignoreBusy`) |
| `ivr-menu`                     | Greeting + `gather`, option dispatch, separate invalid / timeout budgets, submenu recursion |
| `time-condition`               | Evaluated against the WALK's instant, so a caller who sits in an IVR across 17:00 gets the after-hours branch |
| `trunk-dial`                   | Ordered failover honouring `continueOnCauses` (a closed allow-list, never "every cause") |
| `external`                     | Dialled when literal; REFUSED with `OUTGOING_CALL_BARRED` when it needs outbound routing |
| `playback` / `hangup`          | Direct verb mapping                                                 |
| `voicemail`                    | **Placeholder** — greeting + ARI record + `channel.record.*`; no mailbox, MWI or email |
| `feature-code`                 | **Placeholder** — `*97` serves the voicemail placeholder, everything else announces and hangs up |
| `queue` `conference` `park` `application` | **Stub** — announce and hang up with `FACILITY_NOT_IMPLEMENTED` |

**The A-leg is never answered early.** A `hangup` terminal (a blocked caller, an unallocated DID)
tears the leg down without answering, and an extension's B-leg has to answer before the A-leg does
— an implicit answer starts billing a caller for a call nobody picked up.

**`CallSignalBus`** (`src/routing/call-signals.ts`) joins the walker's straight-line code to the
ARI event stream. The walker subscribes to a leg's key BEFORE it originates, which is also how the
orchestrator tells a B-leg's `StasisStart` from a new inbound call: a watched key means "this is
ours, do not file it as a call of its own".

### Known gaps

- **There is no DID → organization index.** The engine reads `OPTIMIQ_ORG_ID` off the channel and
  rejects the call with `INVALID_PROFILE` when it is absent — it does not look the DID up, because
  nothing in the system exposes that mapping yet. Development sets it from the container's
  environment (see `apps/asterisk/config/extensions.conf`); production needs either the SIP edge to
  stamp an `X-Optimiq-Org-Id` header or a real index. **This is the blocker for multi-tenant
  inbound.**
- **IVR direct dial** needs a second, `internal`-context resolve the walker cannot make from a
  plan alone; digits that match no option are treated as invalid and the gap is reported.
- **Call-block `voicemail` action** is flagged by the resolver but has no mailbox to divert to.
- **B-legs get events but no CDR.** One `cdr.leg.write` per call, for the A-leg.

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
| `ENGINE_INBOUND_ANNOUNCEMENT`    | unset                   | Pre-routing only; a plan overrides it                |
| `ENGINE_ROUTING_ENABLED`         | `true`                  | Off leaves the pre-routing ring/answer program       |
| `ENGINE_ROUTING_RPC_TIMEOUT_MS`  | `2000`                  | Deadline for `rpc.routing.v1.resolve`                |
| `ENGINE_EXTENSION_DIAL_TEMPLATE` | `PJSIP/{number}`        | `{number}` is substituted                            |
| `ENGINE_TRUNK_DIAL_TEMPLATE`     | `PJSIP/{number}@{trunk}`| `{number}` and `{trunk}` are substituted             |
| `ENGINE_DEFAULT_RING_TIMEOUT_SECONDS` | `30`               | When neither node nor member specifies one           |
| `ENGINE_PROMPT_MEDIA_PREFIX`     | `sound:`                | How a bare prompt id is rendered                     |
| `ENGINE_UNAVAILABLE_ANNOUNCEMENT`| `sound:unavailable`     | Unresolvable media and the stubbed node kinds        |
| `ENGINE_VOICEMAIL_GREETING`      | `sound:unavailable`     | Placeholder until per-box greetings exist            |
| `ENGINE_RECORDING_FORMAT`        | `wav`                   |                                                      |

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
pnpm --filter @optimiq-voice/engine test              # 315 pure specs, no Docker
pnpm --filter @optimiq-voice/engine test:integration  # + 4 against real Asterisk + NATS
```

The pure suite drives whole calls through the orchestrator and the plan walker with fake ports —
arrival, answer, DTMF, routing, dial, bridge, IVR retries, trunk failover, hangup, CDR, KV
lifecycle and drain — with no Asterisk, no NATS and no clock control. `*.fake.ts` files are spec
scaffolding, excluded from `tsconfig.build.json` and never shipped in `dist`.

The integration suite starts `nats:2.11-alpine -js` and an `apps/asterisk` container, seeds a
routing artifact straight into the `routing-cache` KV bucket, boots the engine against both, and
drives real calls into the `optimiq-inbound` context. It asserts the whole chain: DID → inbound
resolve → IVR → timeout branch → extension → an originated B-leg → `channel.bridged`, the
`calls.evt.*` events arriving in order and schema-valid on their own call's subject, the `channels`
KV entry appearing and clearing, and one `cdr.leg.write` carrying
`destinationType: "extension"`. A second call proves an unrouted DID is rejected with
`UNALLOCATED_NUMBER`, never answered, and files a CDR that honestly says `unknown`. Set
`NATS_INTEGRATION_URL` / `ARI_INTEGRATION_URL` to use services you already run; only containers the
suite started are removed.

### Four defects this suite found

It is the first thing in the system that read the bytes off the broker rather than the publisher's
intent, and it immediately paid for itself:

1. **Call events were published wrapped.** Nest's NATS transport serializes `emit` as
   `{ pattern, data }`, so every `calls.evt.v1.*` message had the envelope one level below where
   `packages/events` says it is — unreadable by `validateEvent`, by the `CALLS` stream's consumers
   and by anything generated from `packages/events-go`. Fixed with an envelope-only serializer on
   the events client (`src/nats/envelope.serializer.ts`); the rpc client keeps Nest's default,
   because the responder on the other end needs the packet shape.
2. **A narrow ARI subscription lost every engine-initiated teardown.** `StasisEnd` unsubscribes the
   channel, so the `ChannelDestroyed` that publishes `channel.hangup`, `channel.destroyed` and the
   CDR arrived to nobody. Every leg is now explicitly subscribed to (`MediaPort.watchChannel`).
3. **The engine's own hangup cause was overwritten.** Asterisk answers a local `DELETE /channels`
   with a generic `ChannelHangupRequest`, and the cause is first-wins — so a call the routing walk
   ended with `UNALLOCATED_NUMBER` was filed as `NORMAL_UNSPECIFIED`, blamed on the caller. The
   cause is now fixed before the media server is told.
4. **`CALL_EVENTS_CLIENT` did not resolve outside `NatsModule`.** A module's imports are private;
   `ClientsModule` is now re-exported.

## Running the stack

```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d nats asterisk engine
```

`compose.yaml` sets `OPTIMIQ_DEV_ORG_ID` on BOTH the asterisk container (which stamps it onto every
inbound channel with `${ENV(...)}`) and the engine (as `ENGINE_DEFAULT_ORGANIZATION_ID`). Leave it
unset and inbound calls are rejected with `INVALID_PROFILE`, which is the correct behaviour for a
box nobody has told which tenant it serves.

`nats` runs with `-js`: JetStream is not the image's default, and without it the stream and KV
definitions cannot be applied and every `cdr.leg.write` is refused.

Set `OPTIMIQ_DEV_ENDPOINTS=true` for two registrable extensions (1001 / 1002) with static
credentials — development only; `run.sh` deletes the file otherwise.
