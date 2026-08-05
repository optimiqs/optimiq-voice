# @optimiq-voice/events

The NATS backbone **contract** package (`plans/optimiq-voice-master-plan.md` §3.5): the versioned
subject taxonomy, a Zod schema for every subject's payload, and the JetStream stream / KV bucket
definitions as declarative config.

**It contains no client code.** No connection manager, no publisher, no consumer wrapper, no
NestJS module. Applications own transport:

- **Events and request-reply** → NestJS `ClientsModule` / `@EventPattern` / `@MessagePattern` on
  the NATS transport, using the subjects and schemas from here.
- **Durable consumers and KV** → the raw `nats` JetStream API, using the definitions from here.

The only I/O in the package is `ensureStreams` / `ensureKvBuckets`, which apply the declarative
definitions to an already-connected `JetStreamManager`. That is config application, not a client.

## Subject taxonomy

Every subject carries its MAJOR version. Nothing outside `subjects.ts` concatenates one.

| Subject                                    | Stream         | Event names (subject tail)                                                                                                                                                                            |
| ------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calls.evt.v1.<orgId>.<callId>.<event>`    | `CALLS`        | `channel.created` · `channel.ringing` · `channel.early-media` · `channel.answered` · `channel.bridged` · `channel.unbridged` · `channel.held` · `channel.unheld` · `channel.dtmf` · `channel.record.started` · `channel.record.stopped` · `channel.hangup` · `channel.destroyed` |
| `sip.reg.v1.<orgId>.<aorHash>.<event>`     | `REGISTRATIONS`| `registered` · `unregistered` · `expired`                                                                                                                                                             |
| `queue.evt.v1.<orgId>.<queueId>.<event>`   | `QUEUES`       | `caller.joined` · `caller.answered` · `caller.abandoned` · `agent.state`                                                                                                                              |
| `cdr.leg.v1.<orgId>`                       | `CDR`          | type only: `cdr.leg.write`                                                                                                                                                                            |
| `audit.evt.v1.<orgId>`                     | `AUDIT`        | type only: `audit.recorded`                                                                                                                                                                           |
| `provision.evt.v1.<orgId>`                 | `PROVISION`    | type only: `device.requested` · `device.rendered` · `device.rejected`                                                                                                                                 |
| `rpc.routing.v1.resolve`                   | — (core NATS)  | request-reply                                                                                                                                                                                         |
| `rpc.authz.v1.check`                       | — (core NATS)  | request-reply                                                                                                                                                                                         |

Notes:

- **Event names are hierarchical and may contain dots** (`channel.record.started`), so the event
  occupies the subject's TAIL rather than one token. Filters that span events end in `>`.
- **`aorHash`** is the first 32 hex characters of `sha256(lowercased AOR)` — an AOR contains `@`
  and `:` and is PII-adjacent, so it is never a raw subject token. The full AOR is in the payload.
- **`_all`** (`QUEUE_SCOPE_ALL`) is the reserved queue token for an `agent.state` that is not
  specific to one queue.
- **`type` is unique within a family, not globally.** The subject selects the family; `registered`
  means nothing without `sip.reg.v1.…` around it. `validateEvent(subject, payload)` does exactly
  that resolution.

```ts
import { subjectFilterFor, subjectFor, parseSubject, matchesSubject } from "@optimiq-voice/events";

subjectFor.call(orgId, callId, "channel.hangup"); // publish
subjectFilterFor.callsInOrg(orgId); // consumer filter: calls.evt.v1.<org>.>
parseSubject(subject); // { kind: "call", orgId, callId, event }
matchesSubject("calls.evt.v1.>", subject); // NATS wildcard semantics, no broker needed
```

## Streams

| Stream          | Subjects                 | Retention | Discard | Max age | Max bytes | Dedupe window |
| --------------- | ------------------------ | --------- | ------- | ------- | --------- | ------------- |
| `CALLS`         | `calls.evt.v1.>`         | limits    | old     | 72 h    | 8 GiB     | 2 min         |
| `REGISTRATIONS` | `sip.reg.v1.>`           | limits    | old     | 24 h    | 1 GiB     | 2 min         |
| `QUEUES`        | `queue.evt.v1.>`         | limits    | old     | 7 d     | 2 GiB     | 2 min         |
| `CDR`           | `cdr.leg.v1.*`           | limits    | **new** | 30 d    | 16 GiB    | 10 min        |
| `AUDIT`         | `audit.evt.v1.*`         | limits    | **new** | 400 d   | 16 GiB    | 2 min         |
| `PROVISION`     | `provision.evt.v1.*`     | limits    | old     | 30 d    | 1 GiB     | 2 min         |

`discard: new` on `CDR` and `AUDIT` is deliberate. The other streams are live-state feeds where
dropping the oldest message is correct. Those two are ledgers — billing and compliance — so under
pressure they refuse the **write** and let the publisher retry and alert, rather than silently
deleting revenue or audit history.

All definitions ship `numReplicas: 1` (single-node dev). Production wraps them:
`ensureStreams(jsm, EVENT_STREAMS.map((s) => withReplicas(s, 3)))`.

## KV buckets

| Bucket          | TTL   | Storage | Key                              | Holds                                    |
| --------------- | ----- | ------- | -------------------------------- | ---------------------------------------- |
| `registrations` | 1 h   | file    | `<orgId>.<aorHash>`              | AOR → contact bindings                   |
| `channels`      | 6 h   | file    | `<orgId>.<callId>.<legId>`       | live channel state for failover/drain    |
| `presence`      | 5 min | memory  | `<orgId>.<extensionId>`          | BLF / device state                       |
| `agent-state`   | 12 h  | file    | `<orgId>.<agentId>`              | ACD agent availability                   |
| `routing-cache` | 1 h   | file    | `<orgId>.<artifact>[.<disc>]`    | compiled routing artifacts               |

Buckets hold **live state, never history**; the streams above are the replayable log. Every TTL is
a self-healing backstop so a crashed writer's entries evaporate instead of lying forever. For
`routing-cache` the TTL is *only* a backstop — correctness comes from the compiler deleting keys
on save.

Build keys with `kvKeyFor.*`; the same "never concatenate at a call site" rule as subjects.

## Envelope

```jsonc
{
  "id": "018f…",                      // uuid v7 — also the Nats-Msg-Id dedupe key
  "at": "2026-08-05T10:00:00.000Z",   // when it HAPPENED (UTC, offsets rejected)
  "orgId": "…",                       // must equal the subject's org token
  "subject": "calls.evt.v1.…",        // self-describing: survives a replay to a file
  "type": "channel.answered",         // unique within its family
  "source": "engine",                 // kebab-case service name
  "traceId": "…",                     // optional
  "correlationId": "…",               // optional
  "data": {}
}
```

### Evolution / versioning policy

- The **subject** carries the MAJOR version. A breaking payload change — removing a field,
  narrowing a type, changing a field's meaning — ships as `v2` subjects that run alongside `v1`
  until every consumer moves. `v1` is never broken in place.
- Within a major version, change is **additive only**: new optional fields, new event `type`s, new
  enum members. Producers may emit them at any time.
- Consumers therefore tolerate the unknown. Payload schemas use `z.object`, whose zod-4 default is
  to **strip** unknown keys, so an old consumer validates a newer producer's event and simply does
  not see the new field. `parseSubject` returns `event` as a plain `string` for the same reason.
- `cdr.leg.write` goes further and uses `z.looseObject`: unknown keys pass **through** to the CDR
  writer, which owns the column list.
- A new **required** field is a MAJOR change. There is deliberately no minor-version field in the
  envelope: a version number consumers branch on is a migration that never finishes.

## Where value domains live

| Domain                                                                                          | Owner                     |
| ------------------------------------------------------------------------------------------------ | ------------------------- |
| leg side, direction, hangup side, SIP transport, DTMF source, bridge mode, recording kind, agent status | **this package** (enums)  |
| hangup **cause** (66 names), destination type, disposition                                      | `@optimiq-voice/cdr-db`   |

`packages/events` must not depend on a database package — the whole point of the backbone is that
`apps/sipd` and `apps/mediad` (Go) and every TS service share one contract without dragging Drizzle
and a Postgres driver behind it. Even a `import type` would create that edge, because this
package's `types` entry points at `src/`.

So `hangupCause` is validated for **shape** here (`/^[A-Z][A-Z0-9_]*$/`) and for **membership** by
the CDR writer, which already depends on `cdr-db` and already stores the numeric `causeCode`
verbatim with a `NORMAL_UNSPECIFIED` fallback. Two consequences, both wanted: adding a hangup cause
is a one-package change, and a cause a carrier invented this morning reaches the CDR instead of
being terminated at the broker edge. Same reasoning for `destinationType` and `disposition`.

When `packages/telephony` lands (plan §3.3) it becomes the shared home for all of these, and both
`events` and `cdr-db` depend on it.

## Usage

```ts
import {
  ensureStreams,
  ensureKvBuckets,
  makeCallEvent,
  validateEvent,
  subjectFilterFor,
  CALLS_STREAM,
} from "@optimiq-voice/events";

// bootstrap (idempotent, safe on every boot)
const jsm = await nc.jetstreamManager();
await ensureStreams(jsm);
await ensureKvBuckets(jsm);

// publish — the subject is derived, never typed by hand
const event = makeCallEvent("channel.hangup", {
  orgId,
  callId,
  source: "engine",
  data: { legId, cause: "NORMAL_CLEARING", causeCode: 16, side: "caller" },
});
await jsm.jetstream().publish(event.subject, encode(JSON.stringify(event)), { msgID: event.id });

// consume — resolve the schema from the delivered subject
const parsed = validateEvent(msg.subject, JSON.parse(decode(msg.data)));
if (parsed.type === "channel.hangup") {
  // parsed.data is narrowed to the hangup payload
}
```

`safeValidateEvent` returns a result instead of throwing — prefer it inside a message callback so a
poison message is terminated and logged rather than becoming an unhandled rejection.

Validation also **cross-checks the subject**: the envelope's `subject` must equal the delivery
subject and its `orgId` must equal the subject's org token. That second check is a tenancy
guard — it stops an event from being scoped to the wrong tenant by a consumer. Disable it with
`{ crossCheckSubject: false }` when replaying an archive.

## Request-reply contracts

`ROUTING_RESOLVE_RPC` and `AUTHZ_CHECK_RPC` are subject + request schema + response schema + a
suggested timeout. Wire them with NestJS `@MessagePattern(ROUTING_RESOLVE_RPC.subject)` and a
`ClientProxy`. `rpc.media.*` arrives with `apps/mediad`.

## TODO — Go struct generation (blocked on `apps/mediad`)

Plan §3.5 requires generated Go structs from a single source, with a CI drift check. Deliberately
not built yet — generating structs for a service that does not exist would freeze the contract
against an imaginary consumer. The approach, recorded in `src/schemas/index.ts`:

1. `scripts/emit-json-schema.ts` — walk `EVENT_SCHEMAS_BY_FAMILY` and `RPC_CONTRACTS`, call
   `z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" })` (built into zod 4, no new
   dependency), write `schema/<family>.schema.json` plus a subject → file manifest.
2. `scripts/generate-go-structs.sh` — `go-jsonschema`/`quicktype` over that directory into
   `apps/mediad/internal/events/`.
3. CI gate: re-run both into a temp dir and `git diff --exit-code`. A schema change that forgets
   codegen fails the build.

## Commands

```sh
pnpm --filter @optimiq-voice/events build
pnpm --filter @optimiq-voice/events typecheck
bun test packages/events/src

# gated: starts a throwaway `nats:2.11-alpine -js` container on 4223 and removes it afterwards.
# Set NATS_INTEGRATION_URL to use an existing broker instead.
pnpm --filter @optimiq-voice/events test:integration
```
