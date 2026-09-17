# FIX — sipd: `credential.invalidated` eviction + the load-test inbox prefix

Area: `apps/sipd` only. Nothing committed, staged or restarted; sipd is on the needs-restart list.

---

## 1 — Subscribe to `provision.evt.v1.*` and evict on `credential.invalidated`

**FIXED.** New `apps/sipd/internal/credentials/invalidate.go`, plus `EvictOrg` on `NATSStore`.

| File                                  | Change                                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `internal/credentials/invalidate.go`  | **new**. `OrgEvictor` interface; `InvalidationFilter = contract.AllProvisionFilter()` (`provision.evt.v1.*`); `WatchInvalidations(ctx, conn, cache, log)`; the self-healing loop; `applyInvalidation`. |
| `internal/credentials/nats.go`        | `EvictOrg(orgID) int` — drops every cached entry for the org and its `lastRefresh` bound; returns the count. `Forget`'s stale "a future JetStream invalidation consumer" comment corrected.            |
| `internal/credentials/credentials.go` | `Refresher`'s godoc said "there is no invalidation channel to subscribe to". There is now; rewritten as the backstop it has become.                                                                    |
| `cmd/sipd/main.go`                    | After `openCredentialStore`: if the store is an `OrgEvictor`, start the watch. The file store caches nothing and implements nothing, so the SIPp rig is unaffected.                                    |

**Core subscription, not a durable consumer** — same argument the MWI subject already makes in this
repo: a durable would replay a provisioning backlog at every restart and evict a warm cache for
changes applied hours ago. The grant added by the credential-cache agent (`config/nats.conf`, sipd
subscribe) is a subscribe grant only, so this is also the only shape it permits.

**Eviction is whole-organization**, because the payload is `{reason, dropped}` and names no account.
Rules in `EvictOrg`:

- a cached credential goes when `credential.OrgID` matches;
- a cached **refusal** goes too, whatever the org. `ErrNotFound` is an answer about a username no
  tenant owns, so it carries no org, and it is exactly what a re-enable or a rename has to clear.
  Their TTL is 10 s, so the cost of dropping another tenant's is one re-ask;
- the `lastRefresh` bound is deleted with the entry, otherwise the re-ask that follows an eviction
  can be refused by the 5 s rate bound;
- an empty/whitespace `orgId` drops nothing.
- **There is no realm→org map to drop**: sipd caches none — the org travels on the credential itself
  (`Credential.OrgID`), and the cache key is realm+username. Noted since the brief asked.

The one-shot `Refresh` path (§5 of `FIX-sipd-followups.md`) is untouched and stays as the backstop
for a missed message or an ungranted subject.

**Envelope handling** mirrors `internal/mwi`: `contract.UnmarshalRaw`, ignore any `type` that is not
`contract.EventTypeProvisionCredentialInvalidated` (the family also carries
`device.requested/rendered/rejected`), then `contract.CheckSubject` — an envelope claiming one org
delivered on another's subject would let one tenant's write empty another tenant's cache. Anything
unparsable or inconsistent is logged at warn and dropped.

**Self-healing**, the same shape as `acl.Watch` / `trunk.Watch` / `presence.NATSStore.Watch`:
`consumeInvalidations` reports whether the stream **ENDED** (the subscription's closed handler fired,
or the channel closed) rather than the context being cancelled; on an end it stops the old
subscription, warns, backs off `invalidationRetryMin` 1 s → `invalidationRetryMax` 30 s (reset on a
successful re-subscribe) and subscribes again. A cancelled context unsubscribes and returns. The
subscription is opened through a `subscribeInvalidations` func so the loop is testable without a
broker; the production implementation is `ChanSubscribe` (64-deep) + `SetClosedHandler` +
`FlushTimeout`, as `mwi.Updates` does.

### Tests (`-race`, in-package, `internal/credentials/invalidate_internal_test.go`)

- `TestEvictOrgDropsOneTenantAndLeavesTheOthers` — two orgs plus a cached refusal: the named org's
  two entries and the refusal go, the other org's entry stays, the `lastRefresh` bound goes, an
  empty orgId drops nothing.
- `TestAnInvalidationEventEvictsItsOrg` — a real envelope built with `contract.NewEnvelope` /
  `ProvisionSubject` evicts its org and only its org.
- `TestUnusableProvisioningMessagesEvictNothing` — four subtests: not JSON, an empty payload,
  `device.rendered` on the same subject, and an envelope whose orgId disagrees with its subject.
  Every one leaves all four cache entries in place.
- `TestTheInvalidationWatchSurvivesTheSubscriptionEnding` — an eviction on the first subscription,
  the server ends it, the watch re-subscribes and an eviction arrives on the second, in order.
- `TestTheInvalidationWatchStopsWithItsContext` — a cancelled context unsubscribes rather than
  leaking the goroutine.

---

## 2 — `e2e_load_test.go` missing `nats.CustomInboxPrefix`

**FIXED.** `TestE2ECredentialRPCBurst`'s `nats.Connect` now passes
`nats.CustomInboxPrefix("_INBOX.sipd")` (and a `nats.Name`), with a one-line comment saying why: the
`sipd` user may only subscribe to `_INBOX.sipd.>`, so a default-prefix reply inbox is refused and a
healthy responder reads as 400/400 failed.

**Checked every other test connection in the module.** `loadRoster` has no NATS connection (it reads
a roster file). The remaining offenders-by-omission are all fine:

- `e2e_bindings_test.go` (both connections) — already sets it;
- `integration_test.go`, `credential_integration_test.go`, `registration_atomic_integration_test.go` —
  the authenticated connections already set the prefix matching their user; the unauthenticated ones
  talk to the suite's own no-auth `nats-server` (no permissions at all);
- `load_*.go` — the `load` rig boots its own no-auth broker (`nats.Name` only, no `UserInfo`), so a
  prefix would be noise.

So it was exactly the one file the profile said it was.

---

## Additional

- `README.md`: one capability-table row for the new subscription, one line in the source map for
  `invalidate.go`.

## Cross-area needed

None. The `config/nats.conf` sipd subscribe grant for `provision.evt.v1.*` and the
`packages/events-go` constant were both already in place before this pass.

**Operational note:** sipd is on the needs-restart list and was not restarted, so this code is not
live on the stack yet. Nothing was verified against the running broker.

## Verification

```
cd apps/sipd
gofmt -l .                    (no output)
go vet ./...                  ok
go vet -tags e2e ./...        ok
go vet -tags load ./...       ok
go vet -tags integration ./... ok
go test -race ./...           24 packages: 21 ok, 3 [no test files], 0 FAIL
  internal/credentials        ok 2.671s
  the six new tests           PASS (5 top-level + 4 subtests), -count=1
```
