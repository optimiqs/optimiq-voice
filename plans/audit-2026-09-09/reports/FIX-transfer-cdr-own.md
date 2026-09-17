# FIX — attended transfer (engine) + `cdr.read.own` (api)

Two cross-area items handed over from `FIX-web-followups.md` §Cross-area needed 1 and 2.
Nothing committed, staged or stashed. No service restarted, no load run.

---

## 1. Attended transfer in the engine — FIXED

### What was actually missing

The engine already honours RFC 5589 §7 in its **INVITE** form: `authorizeInviteReplaces` +
`runReplacesProgram` in `channel-orchestrator.service.ts` take an INVITE carrying `Replaces` from
the transfer TARGET, bridge it into the peer's bridge and hang the replaced leg up with
`ATTENDED_TRANSFER`. What did not exist is the **REFER** form, which is what a browser softphone
sends: the transferor stays put and asks the engine to join the two calls it is holding. That
arrived on `rpc.sip.v1.transfer` and was refused `attended_unsupported` before anything was
resolved.

The refusal's stated reason ("a consultation it did not broker") was wrong on this platform and
that is the finding: the engine IS the B2BUA for both calls. A softphone consultation is an
ordinary second call of the engine's own, so both halves are legs it already holds.

### The join — `apps/engine/src/calls/call-control.ts`

New `CallControl.completeAttendedRefer(transferor, consultation, destination)` (+ the
`CallControlPort` entry). Arguments are the transferor's TWO legs — the one the REFER arrived in and
the one `Replaces` named; their peers (transferee, target) are the pair that survives.

- Guards first, all of which leave both calls exactly as found: both legs usable, not the same leg,
  no `CallControl`-brokered consultation already pending on the leg, a live transferee, a live
  target, a consultation bridge, and the two peers not being the same party.
- Then the join: the transferee moves into the CONSULTATION's bridge (as `completeTransfer` does —
  the target's media never stops), and only then are both transferor legs cleared of bridge/peer,
  marked `ATTENDED_TRANSFER` (801) and hung up. Clearing the peer pointers before the hangups is
  load-bearing: `endBridgePeer` would otherwise follow each hangup into the call just handed over.
- Failure paths are named and non-destructive. A mediad refusal on `addToBridge` puts the transferee
  back in its original bridge and returns `the transferee could not be joined to the target: …`;
  every guard returns its own sentence. Nothing is hung up on any failure path.
- Transfer state machine driven through `assertTransferTransition`
  (`initiated → completing → completed|failed`), so the join is committed at exactly one line.
- `call.transferred` is published on the transferee with `kind: "attended"`, the `Refer-To` user as
  `destination`, and `transferorLegId` / `targetLegId`. Blind transfer is untouched.

### The responder — `apps/engine/src/nats/sip-transfer.service.ts`

`SipTransferCallPath` gains two OPTIONAL members, `resolveReplacedDialog` and
`completeAttendedTransfer`. Optional is deliberate: a call path that supplies neither still answers
`attended_unsupported`, which is exactly what an unattached or a legacy path did.

New `completeAttended()` runs after the existing dialog/tenant/referrer ladder and adds:
`Replaces` → media channel (same `Call-ID` index), consultation leg live (`channel_gone` when the
consulted party hung up first), same tenant (`not_permitted`), **referrer is a party to the
consultation too** (`not_permitted`), and RFC 3891 §3 `early-only` against a confirmed dialog
(`not_permitted`). A refused join is `transfer_failed` with the call path's own sentence; a throw is
`internal`. `kind:"attended"` with no `Replaces` is now `bad_request` rather than being silently
treated as attended.

`isDialableTarget` is deliberately NOT consulted on this path — the target is already answered and
talking, so asking the dial plan would refuse legitimate transfers to anything reachable but not
dialable.

**Authorisation note.** The engine cannot match the `Replaces` triple (it indexes `Call-ID` only,
as `authorizeInviteReplaces` documents at length). It does not need to here: the REFER was
digest-authenticated at the edge and the referrer is checked to be a party to BOTH calls, which
refuses a phone that guessed a `Call-ID` regardless of tags.

### Wiring — `channel-orchestrator.service.ts`

`sipTransfer.attach({…})` gains `resolveReplacedDialog` (same `resolveSipDialog` index, same drain
rule) and `completeAttendedTransfer` → `control.completeAttendedRefer`.

### CDR — a deliberate deviation from the brief, stated plainly

The brief asked for "one callId". **Both surviving legs keep their own `callId`.** What links them
is the bridge-peer pointer, written in both directions here so whichever leg dies first names the
other on its record, plus `call.transferred` naming all three parties — which is exactly what the
existing INVITE-with-`Replaces` path does and what `completeTransfer` produces. Re-keying one
call's legs onto the other's id is not available from `CallControl`: the id is on the `channels` KV
snapshot and on every event both calls have already published (`call.started`, `channel.created`,
`channel.bridged`), and the API's CDR projection groups by it. A record that disagreed with its own
event stream is worse than two records that are each true. Making it one `callId` is a real change
and it belongs to the aggregate + the KV snapshot + the projection together, not to this fix.

### Tests

- `call-control.spec.ts` — new describe, 8 cases: the successful join (bridge move, both hangups
  with `ATTENDED_TRANSFER`, peer pointers in both directions, cleared before hangup, the published
  event), the mediad refusal restoring the original bridge with nothing hung up, target gone,
  transferor unbridged, `Replaces` naming the REFER's own dialog, both dialogs naming one party,
  tearing-down / unanswered legs, and a `CallControl`-brokered consultation already in progress.
- `sip-transfer.service.spec.ts` — 12 new/updated cases against the fake sipd wire: the join and its
  exact reply frame, the dial plan NOT being consulted, `bad_request` with no `Replaces`,
  `unknown_dialog`, `channel_gone`, cross-tenant, referrer-not-on-the-consultation, `early-only`,
  `transfer_failed`, and `internal` on both throws. The pre-existing "refuses an attended transfer"
  case is kept and retitled — it now documents a call path that cannot broker one.
- `media-port.fake.ts` — new `addToBridgeFails?: (bridgeId) => Error | undefined` option, keyed on
  the bridge so the restore step is observable (a blanket flag would let a runtime with no restore
  pass).

### Cross-area needed (engine item)

`packages/events/src/schemas/rpc.ts` — the doc comment on `SIP_TRANSFER_REFUSAL_REASONS.
attended_unsupported` is now stale ("a consultation it never brokered"). It should read: the call
path on this instance cannot join the two dialogs a `Replaces` names. **Comment only — no schema
field changes, no codegen.** The contract itself needed nothing: `replaces` (callId/toTag/fromTag/
earlyOnly) and `callTransferredDataSchema`'s `transferorLegId`/`targetLegId` were already there.

---

## 2. `GET /api/v1/cdr` honours `cdr.read.own` — FIXED

### The shape

The `.own` precedent exactly: the endpoint's floor drops to the SCOPED grant (which an unscoped
`cdr.read` holder satisfies by `hasPermission`'s substitution rule), and the SERVICE decides the
reach. Naming both in `@RequirePermissions` would have refused everybody — it is an AND, the manager
bundle holds `cdr.read`, the self-service bundle holds `cdr.read.own`, nobody holds the pair.

`GET /cdr`, `GET /cdr/calls/:callId` and `GET /cdr/:id` are now `@RequirePermissions("cdr.read.own")`.
`queue-stats` keeps `queues.monitor` (it names no call).

### What "own" means on a ledger with no user ids

`cdr-db` holds numbers and entity refs. The link is the user's EXTENSIONS, in the two spellings the
ledger records:

1. `from_number` / `to_number` — the same "either end of the leg" rule `legFilters` already applies
   to the `extension` query parameter; both columns are indexed with the organization.
2. `destination_type = 'extension' AND destination_ref IN (…)` — the legs the switch dialled to them
   through a ring group, a queue or a follow-me hop, whose `to_number` is not their extension. Number
   matching alone would drop most of an agent's inbound history.

### Files

- `apps/api/src/cdr/query/cdr-self-scope.ts` (new) — `OwnedParties`, `hasAnyParty`,
  `ownPartyFilter` (the SQL fragment) and `ownPartyMatcher` (the same question over a row already in
  hand; the sets are indexed once and closed over, not rebuilt per row).
- `apps/api/src/cdr/query/self-parties.ts` (new) — `CDR_SELF_PARTIES` token + `CdrSelfParties`
  interface, declared in the CDR area and injected `@Optional()`, the same seam as
  `retention-policy.ts` / `purge-audit.ts`.
- `apps/api/src/pbx/shared/self-ownership.ts` — new `ownedExtensionParties()`: one scope, one join
  `extension_user ⋈ extension`, returning ids and numbers together. Disabled extensions are included
  deliberately — this is a question about history. The file header's "CDR cannot be enforced here"
  paragraph is updated to say how it now is.
- `apps/api/src/pbx/shared/cdr-self-parties.service.ts` (new) + `pbx-cdr-ports.module.ts` — the
  implementation and its binding, alongside the two existing ports.
- `apps/api/src/cdr/query/cdr.repository.ts` — `listCallLegs(…, owned?)` and
  `getCallLeg(…, { owned? })` push the predicate. Additive, so an `extension=` parameter naming
  somebody else now intersects to nothing instead of reaching their calls. The tenant is still never
  a predicate.
- `apps/api/src/cdr/query/cdr.service.ts` — one private `narrowing()` returning
  `OwnedParties | undefined`; `list`, `get` and `getCall` consult it. **`getCall` returns the WHOLE
  tree once the caller is a party to ANY leg** — filtering leg by leg would hand a ring-group
  answerer their own B-leg with the originating leg missing and a timeline that starts nowhere.
  A holder with no extension gets an empty page (and no query is issued) / a 404, not a 403: holding
  no phone is an ordinary state.
- `apps/api/src/cdr/shared/cdr.errors.ts` — `CdrSelfScopeUnavailableException`
  (403 `CDR_SELF_SCOPE_UNAVAILABLE`) for a CDR area running WITHOUT the PBX area, where no link
  exists to resolve. It mirrors the PBX area's `SELF_SERVICE_SCOPE_FORBIDDEN` rather than importing
  it — `CdrModule` must keep booting without `@optimiq-voice/pbx-db`, so the service uses
  `hasPermission` directly rather than `holdsUnscoped` (same call, no cross-area runtime import).

`cdr.read` behaviour is bit-for-bit unchanged: `narrowing()` returns `undefined` and no additional
predicate, no extra query and no port call happens.

### Tests

- `apps/api/test/auth/permissionEnforcement.test.ts` — `cdr.read.own` REMOVED from
  `DOCUMENTED_UNENFORCED` (the suite's own "no stale entry" test now proves it is enforced), and the
  long note rewritten: seven of eight `.own` grants are enforced; `recordings.read.own` is the last
  one and is now described as one join behind rather than blocked.
- `apps/api/test/cdr/cdrSelfScope.test.ts` (new, 12 cases) — the predicate rendered as SQL text
  through a real Drizzle builder over the real schema (both number columns, the destination ref, and
  no `organization_id`), the row matcher in every direction including another user's extension, and
  the service in all three states: unscoped holder unnarrowed and never asked who they are; scoped
  holder narrowed with the port called once; scoped holder with no extension answered empty with no
  query; the narrowing carried into the single-leg read; a call tree returned whole on one matching
  leg; another user's call 404 for the scoped holder and 200 for the unscoped one; and 403
  `CDR_SELF_SCOPE_UNAVAILABLE` with no port.

### Note for the web agent

`GET /api/v1/cdr` now answers a plain extension holder, so the softphone's recents list
(`FIX-web-followups.md` (d)) renders for `cdr.read.own`. No web change is needed —
`PAGE_PERMISSIONS` already opens the page on either grant. The api must be restarted to pick this up.

---

## Verification (exact output)

| Check                                                         | Result                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/engine run typecheck`           | clean                                                                     |
| `pnpm --filter @optimiq-voice/engine run test`                | **1624 pass, 6 skip, 0 fail**, 3645 expect() calls, 1630 tests / 72 files |
| `pnpm --filter @optimiq-voice/api run typecheck`              | clean (both `tsconfig.json` and `tsconfig.strict.json`)                   |
| `apps/api` `pnpm run test`                                    | **1276 passing, 0 failing**                                               |
| `pnpm exec oxlint apps/engine/src apps/api/src apps/api/test` | clean (exit 0)                                                            |
| `pnpm exec oxfmt --check` on the same dirs                    | all matched files correctly formatted                                     |

Both suites were green on the tree at the moment of writing, so the resilience agent's restart of
`engine` and `api` will pick up a tree that typechecks and tests clean.

## Stack changes

None. No service started, stopped or restarted; no rows created or deleted; no git state touched.
