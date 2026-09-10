# FIX — final integration

Run: 2026-09-09 21:50 UTC onward, against the standing stack (`STACK.md`). Five items, from the
coordinator's brief. Nothing was committed, staged or stashed. `apps/api` was restarted once (logged
in `STACK.md`); no other service was.

_(Sections 2 and 5 are filled in below once their work landed; see "Verification" for the final
counts and "Needs a restart" for the one list that matters.)_

---

## 1. The orchestrator's two missing walker ports — DONE

`FIX-routing-features.md` "Cross-area needed" #1. Two features were finished and unit-tested on the
walker side and announced "not available" on every real call, because nothing handed the walk the
ports.

- **`apps/engine/src/calls/channel-orchestrator.service.ts`** — `ToggleFeatureRpcPort` and
  `SharedLineRegistry` injected `@Optional()` and LAST, for the reason every entry already at the end
  of that constructor gives: the spec harnesses construct this class positionally. `toggles:` is
  passed beside `features:`, `sharedLines:` beside `conferences:`. Both are exported from
  `RoutingModule`, which is `@Global`, so the deployed engine always has them.

- **One real bug found on the way.** `SharedLinePort` in `plan-walker.ts` declared the seizure holder
  as `{ extensionId?: string }`; `SharedLineRegistry` returns a `SharedLineState`, whose field is
  `heldByExtensionId`. The two had never been connected, so nothing had ever type-checked them
  against each other — passing the registry to the walker failed to compile. The port now names the
  field the registry actually writes (`plan-walker.ts`, and the fake in `plan-walker.spec.ts`).

- Tests: `channel-orchestrator-routing.spec.ts` — a new "the walker ports the orchestrator owns"
  block (2), asserting at the only layer that can see it that `*65` reaches the toggle port and that a
  shared-line node reaches the seizure registry. The harness gained `toggles`/`sharedLines` options.

---

## 3. Shared lines, the mid-call half — DONE

`FIX-routing-features.md` "Cross-area needed" #2, and `E2E-routing2.md` P1-3. The registry was
written and tested in full and **no call-path code called it**. All four halves now exist.

### Where each half lives, and why

- **`apps/engine/src/routing/shared-line-registry.ts`** — two additions.
  `seizureForCall(callId)` answers the only question a media event can ask: a desk phone pressing
  hold arrives as a channel, and what the orchestrator derives from a channel is a call id — nothing
  on the leg says "this call is on shared line X". A linear scan over the lines THIS instance holds,
  which is a handful, not the tenant's line count; an index would be four more places to keep
  consistent. `resume(orgId, lineId, seizing?)` is the inverse of `hold`: back to `seized`, hold
  clock dropped, recall cancelled, and optionally RE-POINTED at a different appearance.

- **`apps/engine/src/calls/call-control.ts`** — the four operations, beside park, whose machinery
  they reuse (`routeTransferee`, `legByLegId`, `setTimer`, `publishQuietly`).
  - `onSharedLineHold(leg, held)` — the phone-pressed hold, which is a different event from
    `CallControl.hold` (an application holding a leg) and is the one that has to reach the other
    appearances. **The KV write IS the publication**: the seizure lives in the shared claim bucket
    every instance and every BLF fan-out already watches, so moving it `seized → held` is what the
    other keys light from. There is no separate lamp event to invent. The recall is armed here and
    cancelled the moment the line is picked back up, by this appearance or another.
  - `retrieveSharedLine(leg, {sharedLineId})` — modelled on `unpark`, with three deliberate
    differences: the held party is addressed by DOMAIN leg id (that is what the seizure records, and
    a media channel id would not survive the call being re-created); the seizure is **re-pointed, not
    released and re-taken**, so the line never passes through a free state a third appearance could
    seize; and a bridge that fails puts the caller back on hold rather than stranding them.
  - `releaseSharedLine(orgId, callId, legId)` — the LEG is compared, not just the call. A
    shared-line call has at least two legs, and the appearance's leg ending is a blind transfer or a
    recall re-ring, not the end of the call. The line is freed when the leg the seizure NAMES ends.
  - `recallSharedLine` (private) — through the ordinary routing path at the seizing appearance's
    NUMBER, for the reason `returnParkedCall` gives: that appearance's leg is long gone, and routing
    to the number rings the phone as a new call would. The seizure is deliberately NOT released
    first — a freed line mid-recall would let a third appearance seize the caller out from under it.

- **`CallControlHost.sharedLineFor`** (implemented in the orchestrator) — the recall timeout and the
  appearance NUMBERS, which is the pair a seizure cannot carry: it records an extension id, and a
  recall has to ring a number. Same shape as `parkLotFor`, same reason.

- **`plan-walker.ts`** — `SharedLinePort.retrieve?` (optional) and a branch in `sharedLineNode`: a
  HELD line is a RETRIEVE, checked before the barge-in question because it is a different question —
  barge-in joins a conversation somebody is having, this picks up one nobody is on. The orchestrator
  composes the walker's port (`sharedLinePortFor`) so seize/release go straight to the registry and
  retrieve goes through call control, which owns the bridge.

- **Hooks**: `onPhoneHold` calls `onSharedLineHold` last, after the far end already has its music;
  the terminal-reporting path calls `releaseSharedLine` at the one point every ending call passes
  through, rather than on each of the several paths that can end one.

- Tests: `call-control.spec.ts` "shared lines, mid-call" (7 — hold arms and publishes, unhold cancels
  and resumes, a non-shared-line call is untouched, retrieve re-bridges and re-points, a line in use
  is refused, release only on the seizure's own leg, and the recall routes to the seizing number);
  `shared-line-registry.spec.ts` "resuming and finding a seizure" (5); `plan-walker.spec.ts` "shared
  lines" (+2 for the retrieve branch).

### Still not done, precisely

**Barge-in.** A barge-in-enabled line still rings the appearances as a new call and the walk says so
in its notes. Joining an existing conversation is a third operation (a multi-party bridge, not a
re-bridge) and it was not in the brief.

---

## 4. Feature-code defaults at organization creation — DONE, live

See the delegate's detail; summarised here because it is the one item proven end to end on the live
stack.

- **`packages/auth/src/auth.ts`** — a new `CreateAuthOptions.onOrganizationCreated?` wired to the
  organization plugin's **`organizationHooks.afterCreateOrganization`**. The brief named
  `organizationCreation.afterCreate`; that option does not exist in the installed better-auth
  1.6.23 — the hook block above is what does. Invoked inside a `try/catch` that swallows: a new
  organization without feature codes is recoverable, a failed signup is not.
- **`apps/api/src/auth/auth.platform.ts`** + **`feature-codes.service.ts`** — the handler is
  REGISTERED into a late-bound slot rather than injected, because `PbxModule` imports `AuthModule`
  and injecting would make the modules circular. It mirrors the existing `auth-platform.registry.ts`
  seam; it is not a new abstraction. `seedNewOrganization` calls the existing idempotent
  `seedDefaults` and never throws.
- Shape (a), service-direct, rather than (b) an event: `packages/events` had no suitable subject, and
  an internal HTTP call would have to mint a session for a user whose session does not yet point at
  the new organization.
- **Live** (api restarted 22:04 UTC): signed up, created organization `01a08834-3840-70cd-b8aa-…`,
  `api.log` → `"seeded the default feature codes for a new organization" created:20 skipped:0`;
  `GET /api/v1/feature-codes` → `total 20`; a second `POST …/defaults` → `created:0 skipped:20`.
- **Only organizations created after that restart are seeded.** Pre-existing ones still need the one
  POST.

---

## 2. Queue callback dialler — DONE

`FIX-routing-features.md` "Cross-area needed" #3 and #5. The caller half was finished; nothing placed
the call, because `rpc.engine.v1.originate` is `{fromExtension, to}` — an EXTENSION placing a call.

- **A sibling subject, `rpc.engine.v1.queue-callback`**, not a `fromQueue` variant of the originate.
  Folding them would make `fromExtension` optional on the surface click-to-call's toll-fraud check is
  authorised against, and a required field that became optional is one that stopped being checked.
  `packages/events` (subject, schemas, `QUEUE_CALLBACK_RPC`, registry, codegen — idempotent);
  `config/nats.conf` engine publish + subscribe grants.
- **`planQueueCallback`** (`apps/engine/src/calls/originate-plan.ts`) resolves **outbound only** — a
  number that rang in must not match the internal table, or the platform rings a desk phone while
  telling the customer it called them back. Caller-ID cascade: the queue's pinned id → the matched
  route → the org. Toll class **fails closed**: it comes from the queue's own number, and a queue
  without one is refused rather than handed an invented entitlement.
- **`placeQueueCallbackCall`** (`channel-orchestrator.service.ts`, mine) creates the leg. The answered
  customer is walked to the QUEUE's number, so the ordinary queue node and the ordinary distribution
  loop reach the ordinary agent — there is no second "connect the agent" path to keep in step.
- **`QueueCallbackDialerService`** never throws; every refusal becomes one `deferCallback`, which
  drops the token when the attempts are spent. `QueueCallbackScheduler` owns one 10 s `unref`'d
  interval, cleared on shutdown, with a re-entrancy guard; queues are registered when a promise is
  made rather than found by scanning the bucket.
- **CDR linking — decision: a `related_call_id` column, not `call_id` reuse.** A callback happens
  minutes later with its own answer, its own trunk and its own billing; reusing the queued call's id
  would make every duration in the ledger a sum over time the customer was not on the phone. Column +
  partial index on `call_legs`, migration `20260909220708_cdr_leg_related_call` **applied to the
  running Postgres**. The value travels as a channel variable (`OPTIMIQ_CDR_RELATED_CALL_ID`) so it
  survives the snapshot an instance reads after failover, and `cdr-leg.ts` writes it.
- Queue events `callback.placed` / `callback.failed`; publish failures are swallowed so reporting
  never stops a callback.
- Tests: `queue-callback.spec.ts`, `queue-callback.dialer.spec.ts`, `queue-callback.scheduler.spec.ts`,
  `queue-waiting.spec.ts`, `queue-session.spec.ts`, `originate-plan.spec.ts`, plus 3 in
  `channel-orchestrator-routing.spec.ts` for the call path itself.

### Two bugs found while wiring it

1. **The callback originated to a NUMBER, not an endpoint.** `planQueueCallback` returns
   `destination` (a number) and `planNodeId`; the first draft passed `destination` straight to
   `MediaPort.originate` as the endpoint. My orchestrator test caught it. It now resolves the
   `trunk-dial` node and builds the endpoint from `ENGINE_TRUNK_DIAL_TEMPLATE` plus the trunk name,
   with the structured `target: {kind:"trunk", …}` the walker's trunk dial carries.
2. **A fixture that matched a route and resolved to no plan.** `resolveOutbound` reads `rule.id` and
   `rule.destinationNodeId`; the outbound-rule fixtures in `originate-plan.spec.ts` (and my first
   draft of the orchestrator one) spell them `routeId` and `nodeId`. Such a rule still MATCHES and
   produces `plan: undefined`, which is exactly how the callback path came to be handed a route with
   no trunk on it. Mine is fixed and commented; **`originate-plan.spec.ts`'s is not**, so its
   "dials the customer through the org's outbound routing" case is passing without ever exercising
   `planNodeId`. Worth a follow-up.

### Known limit, stated rather than hidden

`placeQueueCallbackCall` takes the matched route's **first** trunk attempt. Trunk chains, capacity
ceilings and `continueOnCauses` failover are the plan walker's, and they need an A-leg to fail over
on — a callback has none until the customer answers. A tenant whose first trunk is down gets a
deferred attempt (which the runner retries) rather than an automatic hop to the second carrier.

---

## 5. Hot desking — DONE at every layer; one seam is somebody else's to prove

- **`packages/pbx-db`** — `device_line.home_extension_id` / `hot_desk_expires_at` /
  `hot_desk_login_at`, `extension.hot_desk_pin_set_id`, tenant-first index. Migration
  `20260909221002_pbx_hot_desking` **applied live**. A logout RESTORES the home binding; it never
  guesses one.
- **`packages/routing`** — `hotdesk-login` / `hotdesk-logout` actions, argument modes, seeded as
  `*31`/`*32`, new `hotdesk-logout-missing` diagnostic. **And the recompile gap the routing report
  flagged**: `device_line` was absent from `ROUTING_TABLE_TO_ENTITY`, so a binding write triggered no
  recompile at all. It is there now (`device` deliberately is not).
- **PIN** verified API-side against the existing `pin_set_entry.pin_hash`; the walker only GATHERS,
  modelled on `challengeOutboundPin`. Compiling a hot-desk gate into the artifact would broadcast
  every agent's digest on the routing KV bucket. A NULL `hot_desk_pin_set_id` fails closed.
- **`rpc.pbx.v1.hot-desk`**, mirroring the toggle-feature RPC; responder in
  `apps/api/src/pbx/extensions/`, engine port in `apps/engine/src/routing/hot-desk.source.ts`, and
  `hotDesk:` passed to the walk from the orchestrator (mine). Nothing on the path logs the payload —
  it carries a live PIN. A sweeper expires lapsed sessions under its own audit actor.
- **The device keeps its own SIP credentials — only routing changes.** This required a change, not
  just a comment: `sip-credentials.service.ts` now resolves a registration through
  `coalesce(home_extension_id, extension_id)`, so the digest username, `secret_ref` and HA1 follow
  the HOME binding while `routes_to` follows the live one. **I made the matching fix in
  `apps/api/src/provisioning/render/provision.repository.ts`**, which the hot-desk agent flagged and
  could not touch: its line join was on the live `extension_id`, so a config resync MID-SESSION would
  have rendered the logged-in agent's credentials into the phone's account — the phone would
  re-provision, re-REGISTER as somebody else, and stop being reachable at logout.
- **The device-identity blocker is gone.** `WalkerChannel.deviceId` already exists and is plumbed
  (`sipInviteRequestSchema.deviceId` → `OPTIMIQ_DEVICE_ID` → the orchestrator), landed by an earlier
  agent. The walker reads it and REFUSES a leg without one rather than falling back to the caller.
- **Live**: the credential invariant proved in a rolled-back transaction — digest username, secret
  ref and HA1 identical before login / during session / after restore, while `routes_to` moved and
  came back. A SIP UA proof needs the engine restart.

---

## The broker grant that would have silently defeated item 1

`rpc.pbx.v1.toggle-feature` **was in no grant list at all** — neither api-subscribe nor
engine-publish. So `*65`/`*64` would have been wired correctly by item 1 and still announced "not
available", with a Permissions Violation in the broker log rather than anything at the handset. Found
because the hot-desk agent hit the identical refusal on its own new subject.

`config/nats.conf` now grants `rpc.pbx.v1.toggle-feature` and `rpc.pbx.v1.hot-desk` on both sides.
**A `kill -HUP` is required and I did not perform it.**

---

## Verification

Every number below is the exact final line of the run, not an estimate.

| Check                                                         | Result                                                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine` typecheck                                            | pass                                                                                                                                              |
| `engine` test                                                 | **1845 pass, 12 skip, 0 fail**                                                                                                                    |
| `api` typecheck                                               | pass (both tsconfigs)                                                                                                                             |
| `api` test                                                    | **1429 passing, 0 failing**                                                                                                                       |
| `routing` typecheck / test                                    | pass / **919 pass, 0 fail**                                                                                                                       |
| `events` typecheck / test                                     | pass / **410 pass, 12 skip, 0 fail**                                                                                                              |
| `auth` typecheck / test                                       | pass / **233 pass, 0 fail**                                                                                                                       |
| `web` typecheck / test                                        | pass / **864 pass, 0 fail**                                                                                                                       |
| `telephony` test                                              | **259 pass, 0 fail**                                                                                                                              |
| `pbx-db` typecheck / test / `db:check`                        | pass / **112 pass, 14 skip, 0 fail** / "Everything's fine"                                                                                        |
| `cdr-db` typecheck / test / `db:check`                        | pass / **76 pass, 35 skip, 0 fail** / "Everything's fine"                                                                                         |
| `turbo run typecheck --filter=...events`                      | **16 successful, 16 total**                                                                                                                       |
| events codegen idempotency                                    | second run byte-identical (md5-matched)                                                                                                           |
| `oxlint` (engine, api, routing, events, auth, pbx-db, config) | 1 warning, pre-existing and not mine: `no-explicit-any` in `packages/events/src/schemas/media-dtmf-recording.spec.ts`, an earlier wave's new file |
| `oxfmt`                                                       | clean, 737 files                                                                                                                                  |

Nothing was committed, staged or stashed.

---

## Needs a restart — the exact list

1. **`apps/engine`** — REQUIRED for all of it. Items 1, 2, 3 and the walker half of 5 are compiled and
   unit-tested and none of them is live.
2. **NATS — `kill -HUP`, REQUIRED and must come BEFORE the api restart.** `config/nats.conf` gained
   `rpc.pbx.v1.toggle-feature` and `rpc.pbx.v1.hot-desk` (api-subscribe + engine-publish) and
   `rpc.engine.v1.queue-callback` (engine publish + subscribe). Until it is reloaded, `*65`, `*64`,
   `*31`, `*32` and every callback attempt are refused at the broker. **A HUP also applies whatever
   else is sitting in `config/nats.conf` at that moment** — the usual caveat.
3. **`apps/api`** — REQUIRED. It was restarted at 22:04 and again at 22:24 UTC, but both were BEFORE
   the nats.conf change, so its `rpc.pbx.v1.hot-desk` subscription is currently refused. It also
   needs restarting for the `relatedCallId` CDR mapping and the provisioning `coalesce` fix.
   `packages/events` and `packages/auth` `dist` were rebuilt; api runs from built output.
4. **`apps/web`** — not required (`next dev`, hot-reloaded).
5. **`apps/sipd`, `apps/mediad`, Postgres** — untouched. Both migrations are already applied.

## Left on the live stack

One test user `fcseed7037@local.test` and its organization `01a08834-3840-70cd-b8aa-083f6f1e9447`,
created only to prove the org-create hook. Both deletable.

## Outstanding, and deliberately not guessed at

- **`E2E-routing2.md` P1-4 — the park timeout recalls the WRONG party and drops the call.**
  `parkedByNumber` is recorded as the parked party rather than the parker, so a customer left on hold
  past the timeout is disconnected. Not in this brief's five items; the routing agent declined to
  guess the correct identity (it differs between the A-leg and B-leg park orientations) and guessing
  it here would break the case that currently works. Still a live P1.
- **Shared-line barge-in** — a barge-in-enabled line still rings the appearances as a new call and the
  walk says so in its notes. Joining a live conversation is a multi-party bridge, a third operation
  beyond hold/retrieve/recall.
- **Queue-callback trunk failover** — see the known limit under item 2.
- **`originate-plan.spec.ts`'s outbound fixture** spells `routeId`/`nodeId` instead of
  `id`/`destinationNodeId`, so it resolves to no plan and its callback case never exercises
  `planNodeId`. One-line fix, left because it is a spec another agent is mid-way through.
