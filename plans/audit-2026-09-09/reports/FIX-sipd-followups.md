# FIX — sipd follow-ups (E2E-sip F1/F5/F2/F6, E2E-routing P1-1)

Nothing was committed, staged or restarted. Areas touched: `apps/sipd`, `packages/events`,
`packages/events-go`, `apps/api/src/pbx/security` (+ `pbx.module.ts`, `shared/projection-outbox.service.ts`,
`scripts/rebuild-sip-acl.ts` and their tests). `apps/api` media/prompts and `apps/web` untouched.

---

## 1 — KV watch resilience (E2E-sip F1, the two watches the earlier pass left)

**FIXED.** `acl.Watch`'s self-healing shape applied verbatim to both remaining watches.

| File                                      | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/sipd/internal/trunk/directory.go`   | `Watch` loops: `consume` reports stream-ended vs ctx-cancelled; on end it stops the old watcher, warns, backs off (`watchRetryMin` 1s → `watchRetryMax` 30s, reset on success) and re-`WatchAll`s. The Directory is never cleared, so the last good table stands while the replacement replays. `ready` is a `sync.OnceFunc`; `directory.changed()` still fires at every replay boundary, including a re-established one, so the trunk supervisor reconciles. |
| `apps/sipd/internal/presence/presence.go` | Same shape in `NATSStore.Watch`. The `<-chan Change` is created once OUTSIDE the loop and closed only when the goroutine returns — `internal/subscribe`'s `Run` sets its channel variable to nil on close, so a close is permanent deafness. Added an unexported `log` field (defaults to `slog.Default()`); `Store` and the public API are otherwise unchanged.                                                                                              |

Tests (`-race`, modelled on `TestTheWatchSurvivesTheStreamEnding`, using the same `stubBucket` /
`stubWatcher` / `stubEntry`):

- `trunk.TestTheWatchSurvivesTheStreamEnding` — a trunk present before the stream ended is still
  resolvable while the replacement replays, and an entry put on the second stream reaches the directory.
- `trunk.TestTheReplayAfterAReestablishReconciles` — `OnChange` fires again on the new replay boundary.
- `presence.TestTheWatchSurvivesTheStreamEnding` — a change on the second stream arrives on the SAME
  channel (asserts `ok` on receive, i.e. it was never closed).

**Flow control — confirmed, and the finding is not sipd's.** `config/nats.conf` grants `$JS.FC.>` in
all four permission blocks (api L434, engine L868, mediad L1000, sipd L1241). In the broker log every
one of the **980** `$JS.FC.*` Publish Violations belongs to `user:engine` (`nats.js`), and the last is
at **12:32:13** — all of them predate the grant. **Zero** FC violations for `user:sipd`; the only
sipd-user violation in the whole log is an `_INBOX` subscription from an out-of-process diagnostic
(`sipd-e2e-inspector`), not the daemon. So the Go client's KV watches get their FC replies through.
The engine needs a restart to stop emitting them; that is not this area.

---

## 2 — `scope=registration` SIP ACL enforcement (E2E-sip F5)

**FIXED.** Enforced on the REGISTER path with the same specificity-then-priority evaluation, trunk
scope behaviour unchanged.

- `internal/profile/acl.go` — new `NewWatchedBlocklist`, an evaluator whose default when nothing
  matches is **ADMIT**, and the one place that is correct. A trunk INVITE has no secret behind it, so
  the ACL IS the boundary and no-match must refuse. A REGISTER is digest-authenticated whatever the
  ACL says, so this list is a blocklist in FRONT of a credential; a default of refuse would mean one
  tenant writing one `registration` allow rule silently stopped every other tenant's phones, because
  the read model carries no organization an arriving REGISTER can be matched against. An `allow` entry
  therefore only carves an exception out of a broader `deny`, which the existing
  specificity-then-priority sort already orders. `Match` now honours the default on an empty ACL,
  refuses an unparseable source whatever the default is (or the blocklist is bypassed by malforming
  the address), and guards a nil receiver.
- `internal/acl/acl.go` — `applies(record, scope)` takes the scope; `ScopeRegistration` added beside
  `ScopeTrunk`; `Watcher.WithRegistrationACL(acl)` attaches the second evaluator, and `recompile`
  compiles **both scopes from one watch and one replay**, so the two can never disagree about which
  records they have seen. `SIPD_TRUNK_ACL` overrides stay trunk-only.
- `internal/registrar/registrar.go` — `Options.RegistrationACL`; `admitSource` runs FIRST in
  `HandleRegister`, before the AOR is parsed, before a credential lookup and before a challenge is
  minted, so a blocked network's REGISTER storm costs one longest-prefix match. Refusal is **403, not
  401** — the address is refused whatever credential it holds and a challenge would invite the retry
  loop the rule exists to stop.
- `cmd/sipd/main.go` — the registration ACL is built in `run` (the registrar is wired before the
  INVITE surface and serves REGISTER whether or not that surface exists) and passed through
  `inviteDeps` into `buildProfiles`, which attaches it to the same `sip-acl` watch. With
  `SIPD_INVITE` off there is no watch and the blocklist stays empty, admitting everything.

Tests: `internal/registrar/security_test.go` — deny refuses before any challenge (and emits no
registration event); a /32 allow beats a /24 deny; **a deny naming another tenant's network leaves
this source registering**; an empty ACL blocks nothing. Plus
`acl.TestTheTwoScopesCompileIntoSeparateEvaluators` — a registration entry never admits an INVITE, a
trunk entry never blocks a REGISTER, and a withdrawn deny stops blocking.

---

## 3 — Dead WebSocket contacts (E2E-routing P1-1)

**FIXED.** A WS binding now lives and dies with its connection, per RFC 7118 §5.2.

- `internal/registrar/reachability.go` — `ConnectionProbe` seam and `SweepUnreachable(ctx)`, run from
  `Run`'s existing sweep ticker (default 5 s, versus the 300 s registration expiry). It removes only
  `ws`/`wss` contacts stamped with **this** instance's `sipdInstanceId` whose peer connection is gone,
  re-checking inside the CAS so a device that re-registered between the filter and the write is not
  unbound. Removal publishes `registration.unregistered` with reason `client` — not `expired`, because
  the binding did not lapse — so presence and the live registrations view update.
- **UDP/TCP/TLS semantics are unchanged and deliberately so**: their contacts carry a routable
  address, a client may legitimately let a connection idle between calls, and sipgo opens a new one to
  deliver an INVITE. Reaping on connection close there would de-register working phones.
- `cmd/sipd/connections.go` — `transportProbe` over `userAgent.TransportLayer().GetConnection`.
  sipgo's `onConnClose` hook is **private and already claimed by its transaction layer**
  (`NewTransactionLayer` overwrites it on all four reliable transports), so there is no exported
  close hook without forking the library. The connection-pool entry for a peer is deleted when its
  read loop ends, which is exactly what a closed tab produces, so polling the pool from the sweep
  costs at most one sweep interval of staleness and no fork. `GetConnection` takes a reference, so the
  probe `TryClose()`s immediately — leaking one per contact per sweep would pin every socket a device
  ever had. The UA is now built just before the registrar so the probe can be handed to it (defer
  ordering is unchanged).

Tests: a live WS binding survives a sweep; once the socket closes it is removed from the location
service, exactly one `unregistered` (transport `ws`) is published and no `expired`; UDP bindings are
never swept; with no probe configured nothing is swept.

---

## 4 — `bad-credentials` SIP auth event (E2E-sip F2)

**FIXED, all three sides.** New contract event `auth-failed` on the registration family
(`sip.reg.v1.<orgId>.<aorHash>.auth-failed`, REGISTRATIONS stream).

**Contract** — `packages/events`:
`REGISTRATION_EVENTS` gained `auth-failed`; `registrationAuthFailedDataSchema`
(`aor`, `aorHash`, `transport`, `sourceAddress?`, `userAgent?`, `username`, `reason`) added to the
definitions map, the discriminated union and the schemas barrel; `registrationEntry("auth-failed",
"RegistrationAuthFailed")` added to `scripts/registry.ts` (whose `assertRegistryComplete()` would
otherwise have thrown at module scope — the completeness assertion works); a codegen sample added.
It carries no `contact` because nothing was bound. `reason` is
`bad-credentials | stale-nonce`; both are only reachable AFTER the account has been resolved, because
the subject needs an organization and an unresolved account has none. `pnpm --filter
@optimiq-voice/events run codegen` re-run and **idempotent** (a second run produced no further diff).
`packages/events-go/registration.go` gained the hand-written `NewRegistrationAuthFailedEnvelope`.

**Producer** — `apps/sipd`:
`internal/events` `Publisher` gained `AuthFailed` (JetStream + recording implementations).
`internal/registrar/authfailure.go` publishes it from the two post-lookup failure branches in
`authorize`: a digest that does not verify (wrong password, wrong request URI, unsupported
algorithm/qop) → `bad-credentials`; a **replayed nonce count** → `stale-nonce`, which is a captured
credential being re-sent rather than the honest expiry the rest of that branch handles. An ordinary
stale nonce is NOT reported — it is the silent-retry path every working phone takes. Nothing derived
from the offered password reaches the payload.
**Rate-bounded in sipd**, not in the consumer: one report per (source, account) per
`AuthFailureInterval` = 1 minute, in a table bounded at 10 000 entries that is swept and, if that is
not enough, cleared — an attacker choosing source ports chooses the key space, and it is the only
ceiling they cannot move. A spray is thousands of REGISTERs a second; an unbounded publisher would
make the attack one JetStream write per packet and `sip_auth_event` the disk it fills.

**Consumer** — `apps/api/src/pbx/security/sip-auth-event-consumer.service.ts` (new, registered in
`pbx.module.ts`): durable `pbx-sip-auth-event-writer` on REGISTRATIONS, filter
`sip.reg.v1.*.*.auth-failed`, `DeliverPolicy.New` (nothing to catch up; replaying a day of refused
REGISTERs on every boot would double-write an append-only ledger). Files `eventType:
"bad-credentials"`, `scope: "registration"`, `accountRef: username`, `sourceIp` with the port stripped
(bracketed IPv6 handled), `detail: {reason, aor}` — `stale-nonce` folds into `bad-credentials` because
that vocabulary is fixed by the Asterisk Security-Events mapping the schema header describes, and the
distinction survives in `detail`. Same `term`/`nak`/`ack` discipline and subject-vs-`orgId`
cross-check as `TrunkStatusConsumer`.

Tests: 6 in sipd (`security_test.go` — the event's fields and subject, the one-per-window bound with
the window advanced, and an accepted REGISTER reporting nothing) and 5 in
`apps/api/test/pbx/sipAuthEventConsumer.test.ts`.

---

## 4b — the `sip-acl` KV key was keyed by network alone (E2E-sip F6/P2)

**CONFIRMED and FIXED.** `kvKeyFor.sipAcl(network)` carried no organization and no scope, so two
tenants naming one CIDR — or one tenant naming it in both edge scopes — contended for a single key,
and under "absence is refusal" the loser's rule was published as nothing. One tenant could suppress
another's rule on a security boundary by writing the same network.

- `packages/events/src/streams.ts` — `sipAcl(orgId, scope, network)` → `<orgId>.<scope>.<folded network>`,
  which is `sip_acl_entry`'s unique index `(organization_id, scope, network)` spelled as subject
  tokens, so the projection is lossless. New `sipAclPrefix(orgId)` for a range read. The network fold
  (`.`, `/`, `:` → `-`, IPv6 included) is unchanged.
- `packages/events-go/streams.go` — `SIPACLKVKey(orgID, scope, network)` to match; parity vectors
  regenerated and green. **`apps/sipd` needed no reader change**: it watches the whole bucket and
  evaluates by network, because an arriving packet carries a source address and nothing else. Only
  `command_integration_test.go`'s key construction moved.
- `apps/api/src/pbx/security/sip-acl.publisher.ts` — the whole contention machinery is gone, because
  it is now unreachable: no `contended` map, no `SipAclConflict`, no `conflicts` counter or result
  field. The reconcile's whole-key-space walk (an O(n) scan over every ACL entry on the platform, per
  admin write — the header's own standing complaint) is now a `bucket.keys(sipAclPrefix(orgId))` range
  read. `lookup` takes `(organizationId, scope, network)`. Class header rewritten to say what the key
  now is and why.
- `apps/api/src/pbx/shared/projection-outbox.service.ts` and `pbx.module.ts` — the sip-acl
  "contested, therefore refused" throw and the `conflicts.length === 0` discharge guard removed (the
  did-index ones are untouched).
- `apps/api/scripts/rebuild-sip-acl.ts` — contention branch and report removed, header rewritten. It
  is also the repair for the key change itself: an entry left under an old-shape key has no row
  backing it and is removed by the same delete pass as any other orphan.
- Tests: `sipAclProjection.test.ts`'s two conflict tests are replaced by their inverses — the same
  network in both edge scopes now publishes **twice**, and a network another tenant also claims
  publishes ours without touching theirs. The fake bucket's `keys()` now honours the prefix filter,
  since the delete pass depends on it.

**Operational consequence:** existing `sip-acl` entries are under the old key shape. They are inert
(sipd compiles whatever the bucket holds, so they keep working until rewritten) and the next
`syncOrganization` for a tenant deletes its old-shape keys and writes the new ones;
`scripts/rebuild-sip-acl.ts` does the whole platform.

---

## 5 — SIP secret rotation knocks a phone offline for ~30 s (E2E-calling)

**FIXED.** The 30 s is `credentials.defaultPositiveTTL` exactly: the adapter re-REGISTERs with the new
password and sipd verifies it against the ha1 its cache still holds.

**There is no invalidation channel to subscribe to, and I checked rather than assumed.**
`rpc.sip.v1.credential` is pull-only with no paired push subject; `sip-credentials.service.ts` /
`.responder.ts` publish nothing on any path; there is no config-change subject root in
`packages/events` at all; the AUDIT stream has no producer in `apps/api` (a rotation writes a
Postgres `audit_log` row inside the mutation's transaction and nothing else); and
`packages/routing/src/snapshot.ts:17` excludes SIP credentials from the routing snapshot, so a pure
`sipSecretRef` rotation does not move `snapshotHash` and `projectionsOwedBy` does not even owe a
`routing-cache` publish. Of the five buckets `config/nats.conf` grants the `sipd` user, only `trunks`
carries a `secretRef`, and only for carrier trunks. So an extension/device rotation is not observable
to sipd today by any means, and making it observable would need a new subject **and** a new sipd
subscribe grant — a cross-area change for a 30 s window.

**The smallest correct change instead:** a failed digest is the only signal this edge ever gets that
its ha1 may be the previous one, so it now provokes exactly one re-ask.

- `internal/credentials/credentials.go` — new optional `Refresher` interface, documenting that there
  is no invalidation channel and that an implementation MUST rate-bound the re-ask.
- `internal/credentials/nats.go` — `NATSStore.Refresh(ctx, realm, username)`: evicts and re-asks, at
  most once per account per `RefreshInterval` (default **5 s**). When the bound refuses it returns the
  cached answer unchanged, so the caller re-verifies against what it already had and refuses — the
  same outcome as not having asked, with no RPC. The `lastRefresh` table is bounded and swept exactly
  like the cache, because its key space is attacker-chosen.
- `internal/registrar/registrar.go` + `authfailure.go` — on `ErrBadResponse` only (never on the stale
  or replay paths), `refresh` re-asks and re-verifies once; a **different** ha1 that verifies is
  accepted and logged, anything else falls straight through to the existing 403 and `auth-failed`
  report. A store that does not cache implements no `Refresher` and this is a no-op.

Cost of the bound: a spray against one account buys one extra RPC every 5 s, versus one per packet if
the re-ask were unbounded — which is the amplification the negative cache exists to prevent. Recovery
for a real rotation is the phone's very next REGISTER, in the same transaction, rather than 30 s.

Tests: `registrar.TestARotatedSecretIsPickedUpOnTheNextRegister` (200, exactly one re-ask, no
`auth-failed` published), `registrar.TestAWrongPasswordStillFailsAfterTheReFetch` (still 403, exactly
one re-ask, one `auth-failed`), `credentials.TestRefreshReAsksOncePerAccountPerInterval` (1 RPC, then
20 refreshes inside the window cost 0, then 1 after it), `credentials.TestTheRefreshTableIsBounded`.

---

## 6 — `WS ref went negative` (E2E-calling)

**It is sipgo's, not ours — pinned with a test, and it changed my task-3 probe.**

There are **71** of them in the log, and they are not scattered: they are monotonic on ONE peer
(`127.0.0.1:59139`, `ref: -1, -2, -3, …`) starting ~32 s after that connection's INVITE. The mechanism
is in the library, and it is one line:

```go
// sipgo/sip/transport_connection_pool.go:152 — CloseAndDelete
ref, _ := c.TryClose()   // release one
if ref > 0 { return c.Close() }
// sipgo/sip/transport_ws.go:333 — WSConnection.Close
c.refcount = 0           // ZEROED, not decremented
```

A server-side WS connection is pooled at `1 + TransportIdleConnection`, plus one reference per
in-flight transaction. When the socket dies the read loop's deferred `CloseAndDelete` hard-closes it
and **zeroes the count, discarding every reference still outstanding** — so each of those
transactions, terminating afterwards, releases against a count that already reached zero and drives
it one further negative, logging as it goes. It is noisy and it is safe: `TryClose` reports `0` at a
negative count and does not close twice.

**sipd does not double-release.** We call neither `Close` nor `TryClose` anywhere outside the probe I
added, and we hold no connection references of our own — everything is sipgo's transaction layer. The
warnings also predate the probe by a session.

**But it does interact with the probe, and that is now fixed.** A torn-down connection can sit in the
pool at a NEGATIVE count, and `pool.Get` hands it back regardless — so a probe that treated a pool hit
as "connected" would never sweep exactly the dead browser tabs the sweep exists for.
`cmd/sipd/connections.go` now reads the count instead: it takes the reference `GetConnection` gives
it, requires `Ref(0) > 1` (something other than the probe holds this connection), and gives the
reference back with `Ref(-1)` rather than `TryClose` — `TryClose` would CLOSE the socket if the probe
happened to hold the last reference, and tearing down a peer's connection is the transport layer's
business, not a probe's. The transport layer is now behind a small `connectionSource` interface so
this is testable without a socket.

Tests (`cmd/sipd/connections_test.go`):

- `TestAHardClosedConnectionKeepsGoingNegative` — pins the library behaviour against a REAL
  `sip.WSConnection`: release, hard close, then three further releases each report a clamped `0`
  while the count goes negative. A sipgo bump that changes this fails here rather than silently
  changing what the sweep sees.
- `TestTheProbeReadsAConnectionRatherThanTrustingAPoolHit` — live / hard-closed / already-negative /
  absent, and asserts every reference the probe took was given back and no count moved (a leak would
  pin every socket a device ever had; a double release would be the bug this file rules out).
- `TestAProbeWithNoTransportLayerAdmitsEverything` — nothing to ask means nothing is provably gone.

No fix is available on our side for the warnings themselves without forking sipgo; they are one WARN
per outstanding transaction on a socket that died, and they stop when the pool entry is deleted.

---

## Cross-area needed

1. ~~**`config/nats.conf` — the `api` user cannot open a consumer on REGISTRATIONS.**~~ **DONE** —
   the coordinator added the grants and reloaded the broker. Original finding, for the record: The block at
   L191 grants `$JS.API.STREAM.INFO/CREATE/UPDATE.REGISTRATIONS` but no `CONSUMER.*`, and the broker
   log already shows the new consumer being refused:
   `"optimiq-api-sip-auth-event" - "OPTIMIQ/user:api" - Publish Violation - Subject "$JS.API.CONSUMER.INFO.REGISTRATIONS.pbx-sip-auth-event-writer"`.
   Needed, mirroring the TRUNKS grants at L303-307:
   ```
   "$JS.API.CONSUMER.CREATE.REGISTRATIONS"
   "$JS.API.CONSUMER.CREATE.REGISTRATIONS.>"
   "$JS.API.CONSUMER.INFO.REGISTRATIONS.>"
   "$JS.API.CONSUMER.MSG.NEXT.REGISTRATIONS.>"
   ```
   Without it the `auth-failed` events were published and stored but never filed.
2. **`config/nats.conf` — nothing else.** `$JS.FC.>` is present for all four users; the engine's FC
   violations are stale and clear on an engine restart.

## Needs restart

1. **sipd** — everything in sections 1, 2, 3, 5, 6 and the producer half of 4. Until then: the trunks and
   presence watches stay dead after any broker restart, `registration`-scoped ACL entries are still
   ignored, WS bindings still fork to closed tabs, and no `auth-failed` is emitted.
2. **api** — the new consumer, and the sip-acl key change (the publisher only rewrites keys on the
   next sync for a tenant). Do the `config/nats.conf` grant first or the consumer will not attach.
3. **engine** — not required by anything here; it would clear the standing `$JS.FC.*` violations.

## Verification (exact output)

- `apps/sipd` (re-run after items 5 and 6): `gofmt -l .` — no output. `go vet ./...`,
  `go vet -tags e2e ./...`, `go vet -tags integration ./...` — all clean. `go test -race ./...` —
  **18 packages ok, 0 failures** (3 with no test files). All 19 new tests pass individually under
  `-race`.
- `packages/events`: `typecheck` clean; `test` — **389 pass, 12 skip, 0 fail**, 401 tests across 13
  files. `codegen` re-run twice, second run produced no diff.
- `packages/events-go`: `gofmt -l .` no output, `go vet ./...` clean, `go test -race ./...` — ok.
- `apps/api`: `typecheck` clean (both `tsconfig.json` and `tsconfig.strict.json`);
  `test` — **1261 passing, 0 failing** (1246 at the start of this pass).
- `pnpm exec oxlint` over the touched TS: one pre-existing `no-explicit-any` warning in
  `packages/events/src/schemas/media-dtmf-recording.spec.ts`, which I did not touch. `oxfmt` applied.

## Not done, and why

- **E2E-sip F4** (one deployment-wide SIP realm handed to every tenant) — a tenancy-model decision,
  out of scope here and unchanged.
- **A `bad-credentials` event for an account that exists nowhere** — the subject needs an
  organization and the credential lookup failed, so sipd has none to name. `apps/api`'s
  `SipCredentialsService` already files `unknown-account` / `disabled-account` from the lookup side.
- **A `registration`-scope ACL refusal is logged, not audited.** Same reason: the refusal happens
  before authentication, so there is no organization to file the row under.
