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

- **Multi-tenant inbound.** A call that arrives with no organization on the channel is attributed by
  its dialled DID through the `did-index` KV bucket, which `apps/api` maintains when a number is
  provisioned. Two tenants' DIDs land in two tenants' artifacts, CDRs and event subjects.
- **B-leg CDRs.** Every leg the engine originates gets a `ChannelAggregate`, a `channel.created`, a
  KV mirror and a `cdr.leg.write` of its own, linked to the A-leg by `callId` and
  `originatingLegId`.
- **Voicemail.** A caller hears the box's **own** greeting (compiled into the plan node from
  `voicemail_greeting`, `temporary` beating `unavailable`), records, and the message is FILED — a
  `voicemail.message.left` on the `VOICEMAIL` stream carrying the box, the object key, the duration
  and the caller's identity.
- **The `*97` menu.** A mailbox with a PIN is challenged before it opens (three attempts, scrypt
  digest from the artifact), then the messages are read out newest-first with `1` next / `2` replay
  / `*` exit, driven by `rpc.voicemail.v1.list`.

- **Answer confirmation.** A follow-me hop or ring-group member marked `confirmRequired` is asked to
  press `1` before it is bridged, which is what stops a mobile's own voicemail from winning the call:
  silence, the wrong digit, a hangup or a media plane that cannot play the question all count as
  UNCONFIRMED, the leg is dropped, and the ladder carries on as though it had rung out.

**Not here yet:** park, attended/blind transfer, voicemail email delivery,
mailbox delete/save, and the session-protocol server. **Conferences are here, minimally** — see the
node table and the conference gaps below for exactly which parts. **And two things this wave built but
cannot yet run end to end**: the `rpc.voicemail.v1.list` responder (API side) and a mount that makes
object-store audio reachable by Asterisk — see "Known gaps". Every one of them is named in the
walk's `notes`, so a call that hit a gap says so in the log rather than looking like a routing bug.

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
`apps/api` writes the artifact in the same unit of work as the row change, so its `put` _is_ the
invalidation signal. The bucket's 1 h TTL stays a backstop. A watch that dies drops every memory
copy, because an engine that stopped hearing about changes must not keep serving the last thing it
heard as if it were current. An artifact whose `artifactVersion` this release does not understand
is discarded and recompiled, never walked best-effort.

**`PlanWalker`** (`src/routing/plan-walker.ts`) walks the node table as an explicit loop with a step
budget, because the table is a graph: an IVR option may point back at its parent menu, and a
recursive walker would express that as a stack overflow on a live call.

| Node kind                  | Status                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extension`                | Originate, bridge on answer; busy / no-answer / not-registered branches                                                                                                                                                                                                                                |
| `ring-group`               | `simultaneous` (multi-originate, first answer wins, losers get `LOSE_RACE`) and `sequential` (per-member timeout, `ignoreBusy`)                                                                                                                                                                        |
| `ivr-menu`                 | Greeting + `gather`, option dispatch, separate invalid / timeout budgets, submenu recursion                                                                                                                                                                                                            |
| `time-condition`           | Evaluated against the WALK's instant, so a caller who sits in an IVR across 17:00 gets the after-hours branch                                                                                                                                                                                          |
| `trunk-dial`               | Ordered failover honouring `continueOnCauses` (a closed allow-list, never "every cause")                                                                                                                                                                                                               |
| `external`                 | Dialled when literal; REFUSED with `OUTGOING_CALL_BARRED` when it needs outbound routing                                                                                                                                                                                                               |
| `playback` / `hangup`      | Direct verb mapping                                                                                                                                                                                                                                                                                    |
| `voicemail` (`leave`)      | The box's own greeting (`greetingMedia`, falling back to `ENGINE_VOICEMAIL_GREETING`) + ARI record + `channel.record.*` + `voicemail.message.left`; an empty or failed recording files nothing                                                                                                         |
| `voicemail` (`check`)      | PIN challenge when the box has one, mailbox number read back as `digits/*`, then message playback over `rpc.voicemail.v1.list` with `1` next / `2` replay / `*` exit                                                                                                                                   |
| `feature-code`             | `*97` opens the caller's own mailbox; a code with no mailbox behind it announces and refuses. Everything else announces and hangs up                                                                                                                                                                   |
| `conference`               | PIN gate (participant AND moderator digests, one challenge, three attempts, fail closed), join to a shared ARI mixing bridge, `waitForModerator` held on MOH OUTSIDE the bridge, `maxMembers`, `conference.joined` / `conference.left`. Needs `ConferenceRegistry`; without it, the announcement below |
| `trunk-dial` (`emergency`) | The ELIN wins over every caller-id override, and `call.emergency.dialed` is published BEFORE the first attempt — the Kari's Law notification seam                                                                                                                                                      |
| `park` `application`       | **Stub** — announce and hang up with `FACILITY_NOT_IMPLEMENTED`                                                                                                                                                                                                                                        |

**The A-leg is never answered early.** A `hangup` terminal (a blocked caller, an unallocated DID)
tears the leg down without answering, and an extension's B-leg has to answer before the A-leg does
— an implicit answer starts billing a caller for a call nobody picked up.

**`CallSignalBus`** (`src/routing/call-signals.ts`) joins the walker's straight-line code to the
ARI event stream. The walker subscribes to a leg's key BEFORE it originates, which is also how the
orchestrator tells a B-leg's `StasisStart` from a new inbound call: a watched key means "this is
ours, do not file it as a call of its own".

### Attributing a call to a tenant

An inbound INVITE from a carrier carries a dialled number and nothing that says whose it is, and
everything downstream of that moment is organization-scoped. Three sources are tried, in this order:

1. **`OPTIMIQ_ORG_ID` on the channel.** The strongest signal: the SIP edge or the dialplan already
   decided, with the INVITE in hand. A deployment where the edge stamps `X-Optimiq-Org-Id` lands
   here.
2. **The `did-index` KV bucket**, keyed by the DIGITS of the dialled number
   (`kvKeyFor.didIndex`, so `+441632960111`, `441632960111` and `+44 1632 960111` are one key).
   `apps/api` writes it after the commit that provisions the number, and rebuilds it with
   `pnpm --filter @optimiq-voice/api rebuild:did-index`.
3. **`ENGINE_DEFAULT_ORGANIZATION_ID`.** Development only, and LAST on purpose — above the index it
   would make a box with the variable set answer every tenant's DID as its own tenant, which is the
   bug the index exists to prevent, reintroduced by the fallback meant to make one box convenient.

Nothing else. A call none of the three attributes is REJECTED with `INVALID_PROFILE`.

The lookup is **not cached**, deliberately: every other read on this path is, because a stale
artifact merely routes a call the way it was routed a second ago, while a stale DID→org mapping
files a call under the wrong tenant — a billing error and an isolation breach at once, and both are
silent. One KV round trip is the price of not having one.

Two tenants cannot claim one DID: `phone_number.e164` carries a platform-wide unique index in
`pbx-db`, so Postgres refuses the second claim inside the write transaction. The bucket is a derived
read model of that column, and `DidIndexPublisher` REFUSES to move a key to a second organization
rather than resolving a conflict the database says cannot exist.

### Known gaps

- ~~**The did-index publish is after the commit.**~~ _Closed._ The publish is still after the
  commit, and has to be — publishing from inside the write transaction would put an index entry for
  a state that might roll back in front of live calls. What has changed is that the obligation is
  now recorded **in** that transaction: `pbx_projection_outbox` gets a row per owed projection,
  the after-commit publish marks it discharged, and a sweeper in `apps/api` republishes whatever the
  fast path failed to mark. The same table covers `routing-cache` and `queue-membership`. An API
  process that dies between the commit and the publish now costs up to one sweep interval
  (`PBX_OUTBOX_SWEEP_INTERVAL_MS`, 15 s by default) instead of costing a manual `rebuild:did-index`.
  The rebuild scripts remain, unchanged, for the failures an outbox cannot repair — a bucket lost to
  a fresh cluster, a restored snapshot, a `nats kv del`.
- **Hold-music classes need a generated `musiconhold.conf`.** The plan carries a class NAME, and
  `POST /channels/{id}/moh?mohClass=<name>` resolves it against the media server's configuration
  file rather than against a path — so tenant audio uploaded under `moh/<org>/<classId>/` is not
  playable until that file declares the class. `pnpm --filter @optimiq-voice/api
generate:musiconhold` renders it from `moh_class` and `apps/asterisk`'s `run.sh` picks it up at
  start; see `apps/asterisk/README.md` for the mount, the reload, and the one case it refuses (a
  class name two organizations claim — Asterisk's class namespace is global, so declaring either
  would play one tenant's hold music to another tenant's callers).
- **A conference room is a single-process room.** `ConferenceRegistry` is an in-memory map, so two
  engine instances behind one media server each create their own bridge for room `3001` and neither
  knows about the other: participants who land on different instances hear hold music and not each
  other, which reads as a media bug and is not one. Closing it needs a shared claim on the bridge id
  (KV, compare-and-set) plus an owner for cleanup when the claiming instance dies — the hard half.
  A single-instance deployment, which is what `compose.dev.yaml` and the integration harness run,
  has no split.
- **A conference does not record, mute, kick, lock or tone.** `ConferencePlanNode.recordEnabled` is
  read and reported in the walk's `notes`, never acted on; there are no in-conference DTMF controls,
  no participant list and no entry/exit tones. A tenant who ticked "record this room" is told so in
  the call log rather than finding out later.
- **The Kari's Law notification is published, not delivered.** `call.emergency.dialed` carries the
  dial string, the wire number, the caller, the ELIN presented and the dispatchable location's id,
  and it goes out before the first trunk attempt. Turning that into an email, a webhook or a screen
  pop at the front desk is a CONSUMER's job and is not built: the engine holds no tenant
  configuration and no SMTP handle, and a notification that lives inside one process is one a
  restart loses.
- **DID normalisation does not guess a dial plan.** `0044…` and `+44…` are different keys, because
  turning a national prefix into a country code needs to know which country the trunk is in. That
  belongs to the SIP edge.
- **ARI cannot fetch an object, and nothing in this repo mounts the store.** The compiler embeds a
  greeting as `object://<objectKey>` and the message read model returns the same. ARI's `play`
  accepts `sound:`, `recording:`, `number:`, `digits:`, `characters:` and `tone:` — **there is no
  HTTP media scheme** — so the only way that audio becomes playable is for the object store to be
  visible to Asterisk as a filesystem. Set `ENGINE_MEDIA_OBJECT_ROOT` to where it is mounted and
  greetings and messages play; leave it unset (the default, and the state of `compose.yaml`, which
  mounts no such volume) and both fall back to the configured announcement **and say so in the
  notes**. Deploying this means mounting the directory the API serves recordings from
  (`CDR_RECORDING_ROOT`) into the Asterisk container. Fetching-and-staging inside the engine was the
  alternative and was rejected: it puts a download on the call path.
- **Nothing answers `rpc.voicemail.v1.list`.** The contract, the Go structs and the engine client
  exist; the API-side responder does not. Until it does, a `*97` authenticates, reads the mailbox
  number back, and announces the mailbox as **unavailable** — deliberately never as "you have no
  messages", which is a far more damaging thing to tell somebody who has nine.
- **Nothing sets a voicemail PIN.** `voicemail_box.pin_hash` has no write path: the API excludes PIN
  fields from every DTO pending "a dedicated endpoint that hashes it", which does not exist. The
  digest format is now specified (`packages/routing` §3.1) and verified here, so the endpoint has a
  contract to write against — but until it ships every box has a null digest and `*97` keeps
  authenticating by the calling extension alone.
- **No delete and no save in the mailbox menu.** Both mutate `voicemail_message` state the engine
  cannot write. A `7` that appeared to delete a message that is still there is the worst outcome
  available, so the key is not offered.
- **The busy greeting is unreachable.** An extension's busy and no-answer branches compile to the
  same `voicemail:<id>:leave` node, so nothing here can tell the two apart. Splitting that node is a
  `packages/routing` change.
- **Voicemail email delivery** is not wired. `voicemail_box.email_mode` is likewise not compiled into
  the artifact, and delivery belongs to the control plane, which is where the `message.left` consumer
  is.
- **IVR direct dial** needs a second, `internal`-context resolve the walker cannot make from a
  plan alone; digits that match no option are treated as invalid and the gap is reported.
- **Call-block `voicemail` action** is flagged by the resolver but is not diverted to a mailbox.

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

| Variable                                | Default                       | Notes                                                                                       |
| --------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| `ARI_URL`                               | `http://localhost:8088`       | With or without `/ari`                                                                      |
| `ARI_USERNAME` / `ARI_PASSWORD`         | `ari` / — (required)          | A missing password stops the process at boot                                                |
| `ARI_APP`                               | `optimiq-engine`              | The `Stasis()` application name                                                             |
| `ARI_SUBSCRIBE_ALL`                     | `false`                       | `true` means one engine sees every tenant's channels                                        |
| `NATS_URL`                              | `nats://localhost:4222`       |                                                                                             |
| `NATS_ENGINE_USER` / `NATS_ENGINE_PASS` | unset                         | This process's own broker identity; see `config/nats.conf`                                  |
| `NATS_USER` / `NATS_PASS`               | unset                         | The shared operator credential — the fallback when the pair above is absent                 |
| `NATS_TLS_CA`                           | unset                         | CA bundle path. Enables TLS and pins that CA; unset is plaintext                            |
| `NATS_TLS_ENABLED`                      | `false`                       | TLS against the system trust store instead                                                  |
| `ENGINE_ENSURE_STREAMS`                 | `true`                        | Applies the `@optimiq-voice/events` definitions                                             |
| `ENGINE_PORT` / `ENGINE_HOST`           | `4010` / `0.0.0.0`            | `/healthz` and `/livez` only                                                                |
| `ENGINE_DEFAULT_ORGANIZATION_ID`        | unset                         | Dev only — see below                                                                        |
| `ENGINE_DRAIN_TIMEOUT_MS`               | `30000`                       |                                                                                             |
| `ENGINE_INBOUND_ANNOUNCEMENT`           | unset                         | Pre-routing only; a plan overrides it                                                       |
| `ENGINE_ROUTING_ENABLED`                | `true`                        | Off leaves the pre-routing ring/answer program                                              |
| `ENGINE_ROUTING_RPC_TIMEOUT_MS`         | `2000`                        | Deadline for `rpc.routing.v1.resolve`                                                       |
| `ENGINE_EXTENSION_DIAL_TEMPLATE`        | `PJSIP/{number}`              | `{number}` is substituted                                                                   |
| `ENGINE_TRUNK_DIAL_TEMPLATE`            | `PJSIP/{number}@{trunk}`      | `{number}` and `{trunk}` are substituted                                                    |
| `ENGINE_DEFAULT_RING_TIMEOUT_SECONDS`   | `30`                          | When neither node nor member specifies one                                                  |
| `ENGINE_PROMPT_MEDIA_PREFIX`            | `sound:`                      | How a bare prompt id is rendered                                                            |
| `ENGINE_UNAVAILABLE_ANNOUNCEMENT`       | `sound:unavailable`           | Unresolvable media and the stubbed node kinds                                               |
| `ENGINE_VOICEMAIL_GREETING`             | `sound:unavailable`           | Played when the box has no greeting of its own                                              |
| `ENGINE_MEDIA_OBJECT_ROOT`              | unset                         | Where the object store is mounted INSIDE Asterisk. Unset = greetings and messages fall back |
| `ENGINE_VOICEMAIL_PIN_PROMPT`           | `sound:vm-password`           | Asked before a mailbox with a PIN opens                                                     |
| `ENGINE_VOICEMAIL_PIN_INVALID_PROMPT`   | `sound:vm-incorrect`          | Played between failed attempts                                                              |
| `ENGINE_VOICEMAIL_PIN_ATTEMPTS`         | `3`                           | Then the call is refused with `CALL_REJECTED`                                               |
| `ENGINE_VOICEMAIL_MENU_TIMEOUT_MS`      | `5000`                        | Wait for a control digit after a message plays                                              |
| `ENGINE_VOICEMAIL_RPC_TIMEOUT_MS`       | `3000`                        | Deadline for `rpc.voicemail.v1.list`                                                        |
| `ENGINE_RECORDING_FORMAT`               | `wav`                         |                                                                                             |
| `ENGINE_CONFIRM_PROMPT`                 | `sound:screen-callee-options` | Asked of a leg that must confirm before it is bridged                                       |
| `ENGINE_CONFIRM_ACCEPT_DIGIT`           | `1`                           | The only digit that accepts; anything else declines                                         |
| `ENGINE_CONFIRM_ATTEMPTS`               | `2`                           | Prompts before the leg is given up on                                                       |
| `ENGINE_CONFIRM_TIMEOUT_MS`             | `15000`                       | How long one prompt waits for a digit                                                       |

**The dialplan no longer has to set `OPTIMIQ_ORG_ID`.** It still wins when it is set — see
"Attributing a call to a tenant" — but a carrier trunk pointed at `optimiq-inbound-untrusted`
resolves its tenant from the `did-index` bucket. A call none of the three sources attributes is
REJECTED with `INVALID_PROFILE`, never filed under a guess: a mis-attributed CDR is both a billing
error and a tenant-isolation breach, and both are silent. `ENGINE_DEFAULT_ORGANIZATION_ID` provides a
single-tenant development fallback and should be unset in production.

## Health

`GET /healthz` — `200` when the ARI event socket is open, NATS is connected and the instance is not
draining; `503` otherwise. A draining instance reports `503` on purpose: it must keep serving its
live calls while a load balancer takes it out of rotation.

`GET /livez` — `200` while the process is up. Deliberately dependency-free: a liveness probe that
fails on a broker blip restarts a healthy process and turns a blip into an outage.

## Tests

```sh
pnpm --filter @optimiq-voice/engine test              # 343 pure specs, no Docker
pnpm --filter @optimiq-voice/engine test:integration  # + 6 against real Asterisk + NATS
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
`destinationType: "extension"`, **plus a second `cdr.leg.write` for the leg it dialled**, carrying
`leg: "b"`, the same `callId` and the A-leg's id as `originatingLegId`. A second call proves an
unrouted DID is rejected with `UNALLOCATED_NUMBER`, never answered, and files a CDR that honestly
says `unknown`. A third and fourth drive `optimiq-inbound-untrusted` — a context that stamps NO
organization — with two tenants' DIDs and assert that each lands in its own tenant's artifact,
subjects and ledger while `ENGINE_DEFAULT_ORGANIZATION_ID` points at the other one. Set
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
