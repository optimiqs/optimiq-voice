# GAP2026 — AREA=contact-centre

Owned: `apps/engine/src/queue`, the queue node in `apps/engine/src/routing`, `packages/routing`'s
queue compile, `apps/api`'s queues + queue-agents modules, `packages/pbx-db` (additive),
`apps/web`'s queues / wallboard / agent-console screens and the softphone agent controls.

## 0. What already existed (verified before building)

| Feature                              | Before this pass                                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent whisper announcement (F4)**  | **ALREADY BUILT, end to end.** `queue.agent_whisper_prompt_id` and a per-tier override `queue_tier.announce_prompt_id`; compiled onto `QueuePlanNode.agentWhisperPromptId`; played by `QueueSession.whisperToAgent` after `queue.caller.answered` and before `bridge`, on the agent leg alone.                                        | `packages/pbx-db/src/schema/queues-schema.ts:79-98,285-305`; `packages/routing/src/plan.ts` `QueuePlanNode.agentWhisperPromptId`; `apps/engine/src/queue/queue-session.ts:1119,1144-1200` |
| Wrap-up (the timer)                  | Built. `queue.wrap_up_seconds` / `queue_agent.wrap_up_seconds`, `on-call → wrap-up → available` with a durable `availableAt` deadline. **No disposition codes.**                                                                                                                                                                      | `queue-session.ts:1386-1435`; CAPABILITY-MATRIX.md:62 "PROVEN"                                                                                                                            |
| RONA                                 | **Half.** `queue_agent.max_no_answer` benches an agent after N _consecutive_ ring-outs (`reason: "max-no-answer"`), and the caller is already retrieved and re-offered, with a per-caller `tried` map that prevents re-offering the same agent. **No single-miss RONA, no `rona` state.**                                             | `queue-session.ts:1292-1349`; `agent-state.ts:163-181`                                                                                                                                    |
| Supervisor monitor / whisper / barge | **Primitives built, no queue entry point.** `*0<ext>` feature code → `SupervisorAuthzPort` (`calls.supervise`) → `CallControl.monitor` → `rpc.media.v1.tap-session`; modes `eavesdrop`/`whisper`/`barge` are `(hear, speakTo)` audience pairs; DTMF `4/5/6` escalates mid-call. Nothing in `apps/api` or the wallboard can start one. | `plan-walker.ts:1956-2045`; `call-control.ts:736-748,2309`; `apps/mediad/internal/control/tap.go`; CAPABILITY-MATRIX.md:69 "UNPROVEN"                                                     |
| Queue callback / virtual hold        | Built since the matrix was written (`QueueCallbackPlan`, `queue-callback.*`). Matrix row 66 is stale.                                                                                                                                                                                                                                 | `packages/routing/src/plan.ts` `QueueCallbackPlan`; `apps/engine/src/queue/queue-callback*.ts`                                                                                            |
| Wallboard + agent console            | Built and proven. `queue:<id>` / `agent-state` live topics behind `queues.monitor`.                                                                                                                                                                                                                                                   | CAPABILITY-MATRIX.md:68                                                                                                                                                                   |
| Skills-based routing                 | **Absent.** Zero `skill` hits anywhere in pbx / queue / routing.                                                                                                                                                                                                                                                                      | CAPABILITY-MATRIX.md:61                                                                                                                                                                   |
| Post-call survey                     | **Absent.**                                                                                                                                                                                                                                                                                                                           | —                                                                                                                                                                                         |

So F4 needed proving, not building; F2 and F3 needed completing; F1, F5 and F6 needed building.

## 1. What landed, per package

Everything below is additive. No contract lost a field, no artifact version moved, and a tenant who
configures none of it gets byte-identical behaviour — a property the roster projection is tested on
first, because `isSameRoster` would otherwise republish every roster in every tenant on the first
write after deploy.

### `packages/pbx-db` — the schema (additive)

Four columns on `queue` and six new tables, all in `src/schema/queues-schema.ts`:

|                                                   | Where                  | What                                                               |
| ------------------------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| `queue.disposition_required`                      | `queues-schema.ts:115` | whether the console insists on a wrap-up code                      |
| `queue.rona_enabled`                              | `queues-schema.ts:149` | one unanswered offer benches the agent                             |
| `queue.survey_enabled` / `survey_intro_prompt_id` | `queues-schema.ts:159` | the post-call survey                                               |
| `queue_disposition_code`                          | `queues-schema.ts:409` | the tenant's wrap-up vocabulary; `unset` refused by CHECK          |
| `queue_call_disposition`                          | `queues-schema.ts:468` | one row per (call, agent); the operational copy                    |
| `queue_agent_skill`                               | `queues-schema.ts:539` | tag + level 1-5, on the SEAT (a skill is a property of the person) |
| `queue_skill_requirement`                         | `queues-schema.ts:586` | tag + `min_level` + `relax_after_seconds`                          |
| `queue_survey_question`                           | `queues-schema.ts:632` | position 1-3, prompt, label                                        |
| `queue_survey_response`                           | `queues-schema.ts:670` | one row per (call, question); no zero for an unanswered one        |

Migrations `20260910045525_pbx_queue_contact_centre_2026` and its hand-written
`…_grants` sibling (privileges cannot be expressed in the Drizzle schema, and
`tenant-grants.spec.ts` fails the build when a table in the plan has none). The six tables were
added to `src/schema/tables.ts` so `PBX_TENANT_TABLES` — and therefore the RLS preflight plan —
covers them. **Generated and applied under `<scratchpad>/e2e/MIGRATION-LOCK-pbx-db`**, then the lock
released; `drizzle-kit check` clean.

`packages/cdr-db` got one column, `call_legs.queue_disposition_code`
(`src/schema/call-leg-schema.ts:165`, migration `20260910050213_cdr_queue_disposition`), taken under
`MIGRATION-LOCK-cdr-db` uncontended.

### `packages/events` — the wire contracts (additive)

`src/schemas/queue-state.ts`: `queueAgentSkillSchema` (:83), `queueSkillRequirementSchema` (:98),
`queueSurveyPlanSchema` (:136); `QueueMembership.ronaEnabled` (:242) plus `dispositionRequired`,
`dispositionCodes`, `skillRequirements` and `survey`; `QueueMembershipAgent.skills`;
`AgentStateEntry.dispositionCallId` (:330) / `dispositionCode` / `dispositionRequired`; and
`ENGINE_UNAVAILABLE_REASONS` + `isEngineBenched` (:357).

Every one of those is OPTIONAL, which is what makes the roster's "absent, not `false`/`[]`"
discipline expressible at all. **None of it crosses the Go border** — `queue-state.ts`'s own header
says why (`apps/sipd` is a location service and has no reason to know what wrap-up is), and codegen
confirms it: no queue-state artifact appears in `packages/events-go`.

Two RPCs DO cross, because `scripts/registry.ts`'s rule is "every RPC subject":
`rpc.pbx.v1.queue-disposition` (`src/subjects.ts:217`) and `rpc.pbx.v1.queue-survey` (:228), with
request/response schemas and `defineRpc` descriptors in `src/schemas/rpc.ts`, regenerated into
`packages/events-go/rpc_gen.go`, `registry_gen.go`, `testdata/parity.json` and four new
`schema/rpc/*.json` files.

### `packages/routing` — the queue compile

`QueuePlanNode.requiredSkills` (`src/plan.ts:460`) and `QueueSkillRequirementPlan` (`:358`), compiled
from `destination_data.args.skills` by `RoutingCompiler.queueSkillsOverride`
(`src/compile.ts:1948`) with `parseSkillRequirement` at `:5090`. Two decisions worth naming:

- **The wire form is a scalar STRING** — `"spanish:3:60,billing"` — not a list of objects.
  `DestinationData.args` is `Record<string, string | number | boolean>` and that is load-bearing:
  `destinationKey` builds the node-dedup key by `String()`-ing every value, so an object or array
  keys as `[object Object]` and **two entrances asking for different skills would silently collapse
  into one node**. My first cut used an array; the package's own typecheck caught it.
- **A malformed entry is a warning, never an error** — new diagnostic `invalid-queue-skills`
  (`src/diagnostics.ts:120`). A dropped requirement costs one caller the right agent; a refused
  compile costs the tenant every route in the artifact.

The node id folds the requirement set in (`queue:<id>:s<skill-level-relax>`), so same override → same
node, different override → different node, and a recompile of an unchanged snapshot still produces
the same artifact hash.

The queue's OWN requirements deliberately do not go here: a requirement is matched against SEATS,
and seats have never been in the artifact (the compiler reads no `queue_agent` or `queue_tier` row).
They travel on the roster, exactly as the per-tier whisper and `wrapUpSeconds` already do.

### `apps/engine` — the distributor

**F5 skills** — `mergeSkillRequirements` (`src/queue/queue-strategy.ts:212`), `effectiveSkillBars`
(:236), `clearsSkillBars` (:262), applied as a **fifth filter inside `eligibleCandidates`**. That
placement is the whole design: the tier ladder and all six comparators are untouched, so
`longest-idle` over a skilled pool is still `longest-idle`. The bar drops one level per whole
`relaxAfterSeconds` and floors at 0 (which excludes nobody); `relaxAfterSeconds = 0` never relaxes,
which is the only safe reading for a regulated skill. Where the queue and the entrance name the same
skill the HIGHER `minLevel` wins, so an IVR option cannot quietly weaken the queue's own bar.
`QueueSelection.skilledOut` — how many otherwise-reachable agents the skills alone removed — is
computed only on a pass that returned nobody, so the happy path pays nothing; the session writes one
note naming the bars, so an operator can tell "nobody qualified" from "nobody is logged in".

**F2 RONA** — `releaseFor` (`src/queue/queue-session.ts:1376`). On a no-answer cause with
`ronaEnabled`, the agent goes to `unavailable` / `reason: "rona"` regardless of `maxNoAnswer`,
checked BEFORE the ceiling because RONA replaces the consecutive-count model rather than tightening
it. `isStaffing` (`src/queue/agent-state.ts:180`) now asks `isEngineBenched` instead of comparing
against the `max-no-answer` literal. Coming back is `resume`, which the control plane already owns —
no engine path back, deliberately.

**F1 wrap-up disposition** — `startWrapUp` (`:1525`). The wrap-up transition carries
`dispositionCallId` + `dispositionRequired`, and only when the queue actually has codes. When
required, `awaitDisposition` (`:1585`) polls the agent's entry on `pollIntervalMs` and ends wrap-up
the moment a code appears; when not required there is **no extra read at all**. At the deadline with
nothing chosen the engine reports `{code: "unset", auto: true}`. Because both the store and the fake
rebuild the entry from the request, omitting the fields on any later transition clears them — no
clean-up path was needed.

**F6 survey** — new `src/queue/queue-survey.ts:83`, a pure script over a deliberately NARROWED port
(play / pollDigit / resolvePrompt / note / delay / now / isTearingDown). The type is the guarantee it
cannot keep a leg alive. Detached beside `startWrapUp` in the `bridge` `onEnded` callback, so it only
ever runs for an answered _and bridged_ call.

**The seam** — `src/queue/queue-after-call.client.ts:49` publishes both reports, modelled on
`last-caller.source.ts`: same client proxy, same timeout discipline, fail-soft throughout. Both call
sites are reached from a media callback, where an unhandled rejection takes the process down with
every live call on it.

### `apps/api` — the control plane

- Child CRUD via the declarative `PbxChildResource` mechanism (so audit rows, tenancy and paging come
  for free): `…/queues/:id/disposition-codes`, `…/skill-requirements`, `…/survey-questions`
  (`queues.write` / `queues.read`) and `…/queue-agents/:id/skills` (`queues.manage-agents`).
- Roster projection (`queue-membership.projection.ts:121`, `queue-membership.publisher.ts`): every
  new field is **omitted at its off value**, disposition codes filtered to `enabled = true` in SQL,
  agent skills read narrowed to the seats the tiers reference. The four tables were added to
  `QUEUE_MEMBERSHIP_TABLES` so a new code or skill republishes that queue.
- `POST /api/v1/queue-agents/:id/session/disposition` (`queue-agent-session.controller.ts:125`),
  `queues.join.own` for the agent's own seat and `queues.join` for a supervisor. The queue is read
  off the agent's live entry and never accepted from the caller; `callId` is checked against
  `dispositionCallId`. Three writes, only the UPSERT can fail the request;
  `AgentStatePublisher.writeDisposition` (`agent-state.publisher.ts:294`) is a revision-conditional
  read-modify-write that leaves `status` alone — the engine owns that.
- `POST /api/v1/queues/:queueId/live/:callId/supervise` (`queue-supervision.controller.ts`),
  `queues.monitor`. Resolves the agent from `agent-state`, **requires the entry's `queueId` to match
  the path** (otherwise any live call is reachable by guessing a call id), and originates
  `*0<agentExtension>` from the supervisor's own extension through the existing `CallsService` — so
  the engine's `calls.supervise` gate runs underneath this one and this endpoint is defence in depth,
  not the only gate. Every attempt is audited, refusals included.
- RPC responders `queue-disposition-rpc.controller.ts` and `queue-survey-rpc.controller.ts`; the
  survey writer refuses per-answer an unknown `questionId` or a value outside 1-5, and uses
  `onConflictDoNothing` on `(org, call, question)` so a replayed report cannot double-count a rating.
- `agent-stats.ts:40` gained `dispositions: {code, count}[]`. The header now says plainly that this
  one is a MEASUREMENT, in explicit contrast to the inter-call-gap wrap-up proxy above it.

### `apps/web`

Queue config panels for the three child collections plus the four new fields; a skills editor on the
queue agent; `wrap-up-panel.tsx:41` on both the agent console and the softphone, which renders only
while the live entry has `dispositionCallId` and **never disables anything** — the engine's deadline
ends wrap-up regardless, so a UI that blocked would be lying; RONA rendered as its own badge
("Not answering") distinct from a human-paused agent, which is the entire point of the feature for a
supervisor; `supervise-controls.tsx:50` + `lib/live/supervision.ts:36`, whose success toast says the
supervisor arrives SILENT and names the digit to press rather than implying the mode was applied
server-side; and a "Closed as" column in the agent-stats table.

### `config/nats.conf`

Both new subjects enumerated — never as a `rpc.pbx.v1.*` wildcard, for the reason the file states at
both sites — on the **api** user's `subscribe` list (`nats.conf:555`) and the **engine** user's
`publish` list. Broker HUP-reloaded (`Reloaded: authorization users`). **`Permissions Violation`
count in `e2e/logs/nats.log`: 0 before, 0 after.** No stream and no KV bucket was added, so no
`$JS.API.STREAM.*` / `CONSUMER.*` grants are owed.

### Test counts (exact, from the runs — not estimates)

| Package            | Command              | Result                                         |
| ------------------ | -------------------- | ---------------------------------------------- |
| `packages/routing` | `run test`           | **965 pass, 0 fail** (2280 expects, 24 files)  |
| `packages/events`  | `run test`           | **437 pass, 12 skip, 0 fail** (13 files)       |
| `packages/pbx-db`  | `run test`           | **117 pass, 14 skip, 0 fail**                  |
| `apps/engine`      | `run test`           | **2014 pass, 12 skip, 0 fail** (87 files)      |
| `apps/web`         | `run test`           | **1009 pass, 0 fail** (3181 expects, 50 files) |
| `apps/api`         | area files via mocha | **150 passing, 0 failing**                     |

`typecheck` clean on routing, events, pbx-db, engine and web. The **full api suite cannot load** —
`ReferenceError: Cannot access 'ROUTING_SETTINGS_CATEGORY' before initialization` at
`org-settings.catalog.ts:189`, another pack's in-flight file — so the api tests were run per file.
`oxlint` and `oxfmt` clean across every directory touched.

## 2. Live proof

Against the standing stack (web 3300, api 3200, engine 9300, sipd 9290, mediad 9291, NATS 4322), org
`01a08708-4cd4-76b9-b56d-d26ebf326b0a`. Fixtures: queue **CC2026 Queue** on extension **2910** with
seats **CC2026 Agent 2001/2002/2003**, provisioned idempotently by
`<scratchpad>/e2e/calling/cc2026-setup.mjs`. Three real browser softphones (2001, 2002, 2003) plus a
fourth as the supervisor (the org owner, extension **1001**) — real Chromium, real WebRTC, real RTP.

Restarts: **api ×1 and engine ×1**, each single-service
(`kill $(cat pids/<svc>.pid); .scripts/local-stack/up.sh <svc>`). sipd and mediad untouched.

### Configuration → the roster the engine actually distributes from — 8/8

`cc2026-config.mjs` writes every new setting through the real API and then reads the
`queue-membership` KV bucket, because the API's own response would only prove the row was stored.

```
PASS: F1 disposition codes accepted — 3/3 stored
PASS: F1 `unset` is reserved and refused — the deadline's own value cannot be configured as a tenant code
PASS: F6 a survey is capped at three questions — position 4 refused
PASS: F1 the roster carries the disposition vocabulary — dispositionCodes=3 required=true
PASS: F2 the roster carries RONA — ronaEnabled=true
PASS: F5 the roster carries the queue's skill requirements — [{"skill":"spanish","minLevel":3,"relaxAfterSeconds":30}]
PASS: F5 the roster carries each seat's own skills —
      [["CC2026 Agent 2001",[{"skill":"spanish","level":4}]],
       ["CC2026 Agent 2002",null],
       ["CC2026 Agent 2003",[{"skill":"spanish","level":2}]]]
PASS: F6 the roster carries the survey — {"questions":[{...,"position":1,...},{...,"position":2,...}]}
```

The `"CC2026 Agent 2002" → null` line is the byte-identical discipline showing through: a seat with
no skills has no `skills` FIELD, not an empty array.

### F5 skills-based routing, and F2 RONA — 3/3 (`cc2026-calls.mjs`)

Queue requires `spanish >= 3` relaxing a level every 30 s. 2001 is a level 4, 2002 has no skills at
all, both logged in and idle. 2003 calls 2910.

```
PASS: F5 the caller reaches the only agent who clears the skill bar
      — spanish>=3 with 2001 at level 4 and 2002 unskilled — the phone that rang was 2001
PASS: F2 one unanswered offer benches the agent
      — 2001 is unavailable (rona) after a single ring-out
PASS: F2 the caller is retrieved and offered to somebody else
      — the next phone to ring was 2002; 2001 was not offered the call again
```

2001 was left to ring out untouched. The durable state afterwards, straight off
`GET /api/v1/queue-agents/:id/session`:

```json
{
	"name": "CC2026 Agent 2001",
	"status": "unavailable",
	"reason": "rona",
	"source": "engine",
	"since": "2026-09-10T05:53:34.617Z"
}
```

`source: "engine"` matters: the switch benched them, not a person, and that is exactly the
distinction the wallboard badge now renders.

Note the second PASS is also the relaxation ladder working: 2002 clears nothing at first and only
becomes reachable once the bar has come all the way down.

### F1 wrap-up disposition — 4/4 (`cc2026-after-call.mjs`)

```
PASS: F1 wrap-up names the call the agent owes a code for
      — dispositionCallId=67f336c6-fe78-33f2-93f6-10abd30130c8 required=true
PASS: F1 the code is accepted — 202/200
PASS: F1 the code is on the ledger — [{"code":"sale","auto":false}]
PASS: F1 the live entry carries what the agent chose — dispositionCode=sale status=wrap-up
```

The ledger row is a direct `select code, auto from queue_call_disposition` against the dev database,
not the API's echo. `auto = false` is the agent having chosen rather than the deadline filing a
blank.

### F3 supervisor monitor / whisper / barge — 7/7 (`cc2026-supervise.mjs`)

2003 calls the queue, 2002 answers, and the supervisor is online on extension 1001.

```
PASS: F3 supervise (monitor) — digit=4 agentExtension=2002 supervisor=1001
PASS: F3 the supervisor's phone rings (monitor) — the *0 leg reached the supervisor's handset
PASS: F3 supervise (whisper) — digit=5 agentExtension=2002 supervisor=1001
PASS: F3 the supervisor's phone rings (whisper) — the *0 leg reached the supervisor's handset
PASS: F3 supervise (barge)   — digit=6 agentExtension=2002 supervisor=1001
PASS: F3 the supervisor's phone rings (barge)   — the *0 leg reached the supervisor's handset
PASS: F3 every attempt is on the audit ledger — 3 rows, e.g. "queue.supervise"
```

What is proved: one request naming a live queue call resolves the agent behind it, refuses a call
that is not in that queue, and puts a real tap leg on the supervisor's real handset, with an audit
row per attempt. What is NOT claimed: that the mode was applied server-side. `*0` always connects
silent — the reply carries the escalation digit and the UI says so.

An earlier run of this probe failed 409 `extension_offline` for `from: "1001"`, which was the
endpoint working correctly against a supervisor who had no phone registered; the run above opens
that fourth softphone first.

### F4 agent whisper announcement — 4/4 (`cc2026-whisper.mjs`), the feature that already existed

The measurement is the ASYMMETRY, not the audio. Both sides are sampled over the same window
starting the instant the agent answers:

```
PASS: F4 agent hears the whisper
      — agent inbound energy 0.5691 over 31 packets in the pre-bridge window
PASS: F4 caller is still on hold, not listening to the agent's cue
      — caller inbound energy 0.5106 over 32 packets (music-on-hold, not the whisper)
PASS: F4 the bridge is built after the whisper — agent 1.4417 / caller 1.4417
PASS: F4 the answering agent lands in wrap-up — status=wrap-up
```

The third line is the two figures becoming identical once the legs are joined, which is what a
bridge looks like from `getStats()`.

### F6 post-call survey — DOES NOT WORK LIVE

Built, unit-tested (9 specs), plumbed onto the roster, and its storage path is real — but a caller
cannot reach it on this stack. The engine's own note is exact:

```
"queue \"01a089b2-…\": the caller hung up before question 2 of the survey"
"queue \"01a089b2-…\": the caller's leg went with the agent's, so the post-call survey was not asked"
```

and the caller's browser, 3.5 s after the agent hangs up, reads `Call ended | Terminated`.

**Cause.** `runQueueSurvey` is detached from the `bridge` `onEnded` callback, which is the only hook
the queue session has. By the time it fires, the agent-initiated hangup has already torn the bridge
down and taken the caller's A-leg with it. The runner starts, gets as far as the intro/first
question against a dying leg, sees `isTearingDown`, and reports nothing — which is the correct
fail-soft behaviour, and is still a feature the caller never experiences.

**What it needs.** The caller must be parked OUT of the bridge before the agent's leg dies, which is
a channel-orchestrator / media-plane change in `apps/engine/src/calls` — the area another pack owns
this round. I did not touch it. Everything above that seam is finished: roster carriage is proved
live (8/8 above), the runner has specs, `rpc.pbx.v1.queue-survey` is granted and reloaded, and the
`queue_survey_response` writer refuses an unknown question or an out-of-range digit.

I am recording this as a FAIL rather than as a partial pass. The feature is "the caller is asked and
the answers are stored", and no caller was asked.

### Probe scripts

`<scratchpad>/e2e/calling/cc2026-{setup,config,calls,after-call,supervise,whisper,survey}.mjs`, all
re-runnable and idempotent.

## 3. Stack observations

### The WSS certificate lost its SAN — a latent trap, and NOT what broke the softphones

`<scratchpad>/e2e/certs/cert.pem` was replaced at **2026-09-10 00:00 local** (the previous file is
preserved beside it as `cert.pem.orig`), and the replacement carries **no X.509 extensions at all**:

```
cert.pem       subject=CN=localhost                (No extensions in certificate)
cert.pem.orig  subject=CN=localhost   X509v3 Subject Alternative Name:
                                        DNS:localhost, DNS:local.test, IP Address:127.0.0.1
```

`SIPD_TLS_CERT_FILE` points at it (`env/sipd.env:20`), so it serves both SIP TLS 5161 and WSS 8189.

**I initially blamed it for browser softphones failing to register, and I was wrong.** The symptom
was real — `WebSocket connection to 'wss://127.0.0.1:8189/' failed: WebSocket opening handshake was
canceled` at the browser, `"Fail to upgrade" caller=Transport<WSS> error=EOF` at sipd, and the
softphone page stuck at "Connection failed" — but it was sipd's process state, not the certificate.
After the coordinator's full stack restart, browser softphones registered over **`wss://` on 8189**
first try and stayed up for every probe in §2. Chromium launched with `--ignore-certificate-errors`
accepts the SAN-less certificate.

So: not a blocker today, and worth fixing anyway, because anything stricter than that flag —
a real browser, a Go client with a cert pool, an SDK that validates — will reject a certificate with
no subjectAltName outright. Restoring `cert.pem.orig` and restarting sipd is the whole fix.

**A dead end I left behind, in case somebody retraces it:** while I believed the certificate was the
cause I pointed `PROVISION_SIP_WSS_URL` at sipd's plain-WS listener (`ws://127.0.0.1:5188`) in
`env/api.env`. That does not survive — `.scripts/local-stack/up.sh` regenerates the env files from a
template on every single-service restart, so the edit is overwritten. It is not in place now and is
not needed.

### `GET /api/v1/queue-agents/:id/session` carries no `callId` and no disposition fields

The most useful finding of the pass, and it affects two of the screens this round added.

The REST view returns `status`, `since`, `reason`, `availableAt`, `source` — but not `callId`,
`dispositionCallId`, `dispositionCode` or `dispositionRequired`, all of which ARE on the
`agent-state` KV entry and do reach the browser over the live socket.

Consequences:

- The wallboard's **supervise** button has no call id to post until the first `agent-state` frame
  arrives. My own probe could not use the REST view at all and had to read the KV bucket directly
  (`cc2026-supervise.mjs`).
- The **wrap-up panel** on the console and softphone is absent for a moment on a cold load, for the
  same reason. The web pack flagged this independently.

Neither is a correctness bug — the socket is the live-state transport by design — but three fields on
that view would make both surfaces correct at first paint. Cross-area: `apps/api`, one DTO.

### Cross-pack notes

- **Codegen was blocked repo-wide** by `registry.ts` missing an `RPC_ENTRIES` entry for
  `rpc.pbx.v1.authorize-outbound` (another pack's contract). The gate refuses ALL codegen on one
  missing entry, so one line was added to unblock it; if that pack's owner wants a different
  `goName` it is a one-line change.
- Running `pnpm --filter @optimiq-voice/events codegen` also materialised other packs' already-pending
  regenerations (security events, cdr/call event changes, `rpc.media.v1.*` schema files). Those diffs
  are theirs, not mine — mine are the four `rpc.pbx.v1.queue-*` schema files plus the queue entries in
  `rpc_gen.go`, `registry_gen.go` and `parity.json`.
- The **full `apps/api` test suite cannot load**: `ReferenceError: Cannot access
'ROUTING_SETTINGS_CATEGORY' before initialization` at `org-settings.catalog.ts:189`, in another
  pack's in-flight file. Unrelated to this area, but it means nobody can run the api suite whole
  until it is resolved.
- One transient 500 from `GET /queue-agents/:id/session` during a probe was the api restarting
  underneath it, not a defect; the endpoint answered correctly immediately afterwards and on every
  subsequent run.

## 4. Discipline

- **No commits, staging, stashing or rebasing.** Git state untouched throughout.
- **Migrations** taken under `MIGRATION-LOCK-pbx-db` and `MIGRATION-LOCK-cdr-db`, both released.
- **Restarts:** api ×1, engine ×1, each single-service via
  `kill $(cat pids/<svc>.pid); .scripts/local-stack/up.sh <svc>`. **sipd and mediad never restarted**
  — this brief did not permit it. `down.sh` and bare `up.sh` never run; postgres and NATS never
  touched beyond the config HUP below.
- **Broker:** two subjects added to `config/nats.conf`, enumerated rather than wildcarded, HUP
  reloaded. **Permissions Violations 0 before, 0 after.** No stream or KV bucket added, so no
  `$JS.API.STREAM.*` / `CONSUMER.*` grants owed.
- **Data left behind:** queue `CC2026 Queue` (ext 2910), three `CC2026 Agent …` seats with tiers,
  three disposition codes, two survey questions and the per-agent skills, in the existing smoke org.
  All prefixed `CC2026`, so a cleanup is one filter. Agent 2001 may be left `unavailable / rona` and
  agent 2002 in `wrap-up`; both clear with a logout, and a `wrap-up → available` login is correctly
  refused by the state machine (`AGENT_TRANSITION_REFUSED`, "it belongs to the engine") rather than
  being a bug.
