# FIX-sipd

Area: `apps/sipd`. All checks below run from `apps/sipd`.

## P0

### P0 #1 external profile unreachable in its default configuration — FIXED

- `internal/profile/profile.go`: `Set.For` now detects a listener-less external profile (the
  documented `SIPD_EXTERNAL_LISTEN_ADDR=""` default), skips the transport-only early return when one
  exists, and evaluates every `KindExternal` profile's source ACL — not only those in `matches`. The
  local-address step and the "unknown stranger falls to internal and is challenged" step are
  unchanged. `For`'s doc comment updated.
- Test: `internal/profile/profile_test.go` → `TestSetForSelectsAListenerlessExternalProfileBySource`
  (carrier INVITE on the shared UDP socket resolves to `external`/`ContextUntrusted`; internal socket
  still wins; unknown source still falls to internal).

### P0 #2 data race: reaper reads live `*Dialog` off the owning goroutine — FIXED

- `internal/dialog/store.go`: the Store now keeps a rendered `Claim` VALUE per legId under `s.mu`
  (`claims map[string]Claim`), written by the OWNER via `Insert`, `Rebind` and a new `Store.Touch`.
  `Claims()` copies values and stamps a fresh `ExpiresAt`; it never touches a dialog.
- `internal/dialog/session.go`: `SessionOptions.OnUpdate` is called after every task and its effects,
  on the owning goroutine.
- `internal/invite/handler.go`, `internal/invite/originate.go`: wired `OnUpdate: h.dialogs.Touch`;
  `writeClaim` renders and `Touch`es on the owner.
- Test: `internal/dialog/store_test.go` → `TestClaimsDoNotRaceWithTheOwningGoroutine`. Verified it
  catches the original bug: reverting `Claims()` to the old body reports 3 `DATA RACE`s under `-race`.

### P0 #3 digest replay can bind an attacker's Contact — FIXED

- `internal/registrar/auth.go`: per-nonce nonce-count guard (`nonceGuard`), shared across the
  per-realm authenticators `ForRequest` derives. A nonce count must be strictly greater than the last
  accepted for that nonce; the guard is checked only AFTER the response verifies, so a wrong password
  cannot burn a count the honest device is about to use. Bounded (10k) with expiry-based sweeping,
  emptied rather than grown when full. `ErrNonceReplayed` wraps `ErrNonceStale`, so every existing
  caller re-challenges with `stale=true` and a legitimate device retries silently. The "What this
  does NOT do" comment was wrong and is replaced with an honest note (best-effort per instance; TLS
  is still the real boundary on an untrusted network).
- Also P2 qop-downgrade: `Verify` now refuses any `qop != "auth"` (`ErrQOPUnsupported`) rather than
  silently falling back to the RFC 2069 form the challenge never offered.
- Tests: `auth_test.go` → `TestAnAnswerCannotBeUsedTwiceWithTheSameNonceCount`,
  `TestAFailedAnswerDoesNotConsumeTheNonceCount`,
  `TestAQOPlessAnswerIsRefusedAgainstAQOPChallenge`; `registrar_test.go` →
  `TestAReplayedAuthorizationCannotBindAnAttackersContact` (the actual attack: replayed
  Authorization + attacker Contact → 401, victim binding intact).
- Tests fixed that asserted the old behaviour: `TestStaleRegisterCannotOverwriteOrRemoveCurrentContact`
  now expects 401 for a byte-identical replay and exercises the stale-CSeq guard with a genuinely
  re-authenticated (fresh nc, stale CSeq) REGISTER; `invite/handler_test.go` and
  `registrar_test.go` harnesses now use an incrementing nonce count where they reuse one nonce.

## P1

1. **Registrar.Sweep round trip per binding — FIXED.** `internal/registrar/registrar.go`: `Sweep`
   filters on the locally-held deadline (`lapsed`, which checks per-contact expiry when there are
   contacts) before spending a `kv.Update`. CAS callback re-check unchanged. Test: extended
   `TestSweeperExpiresLapsedBindings` to assert zero KV round trips before the deadline, via a new
   `kv.MemoryStore.Updates()` counter.
2. **Reaper lists the whole bucket every 30 s on every instance — PARTIALLY FIXED.**
   `internal/reaper/reaper.go`: the reap half now runs on its own longer, jittered interval
   (`ReapInterval`, default 2× the heartbeat interval) while the heartbeat keeps ticking; the first
   sweep still reaps immediately. That divides the steady listing load and de-synchronises the fleet.
   It does NOT remove the O(instances × fleet dialogs) shape — see "Deferred" below. Test:
   `TestTheReapListingDoesNotRunOnEverySweep`.
3. **Shutdown NOTIFY serial — FIXED.** `internal/subscribe/handler.go`: bounded worker pool
   (`notifyConcurrency` = 32) over the drained subscriptions, on the caller's context, abandoning the
   feed when the shutdown deadline passes. Test: `TestShutdownDeactivatesInParallel` (a gated
   notifier that would deadlock a sequential loop).
4. **Unbounded NOTIFY fan-out — FIXED.** Same file: `dispatch` acquires a `slots` semaphore
   (same limit) and drops-newest with a counted warning when saturated, which RFC 4235 versioning
   makes safe.
5. **Credential cache O(n) eviction under the lock — FIXED.** `internal/credentials/nats.go`:
   `evictLocked` sweeps at most once per `negativeTTL` and otherwise drops one arbitrary entry (O(1)).
   Test: `TestCacheEvictionSweepIsRateLimited`.
6. **No single-flight on the credential RPC — FIXED.** Same file: `golang.org/x/sync/singleflight`
   (promoted from indirect to direct in `go.mod`). The cache write happens INSIDE the flight, before
   the group key is released — otherwise a caller arriving in that window becomes a second leader
   (this was observable: the first version of the test measured 2 requests). Test:
   `TestConcurrentLookupsForOneAccountIssueOneRequest` (32 callers, 1 RPC). Needed one small seam:
   an `rpc` func field defaulted to `s.request`, in the same spirit as the existing `now`.
7. **ACL recompiles once per record during replay — FIXED.** `internal/acl/acl.go`: `Watcher.Suspend`
   / `Resume`; `Watch` suspends before the replay and resumes at the nil boundary (and on exit).
   Test: `TestSuspendDefersRecompilationUntilResume`.
8. **Readiness channel discarded — FIXED.** `cmd/sipd/main.go`: `buildProfiles` now returns a
   `ready` channel closed when the initial replay lands (however many attach attempts that took);
   `newInviteHandler` waits on it for a bounded 3 s (`aclReadyTimeout`) before registering the INVITE
   surface, logs a warning if it does not land, and the boot log now carries `aclLoaded` next to the
   `aclEntries` count that was previously always 0.
9. **`watchWhenAvailable` fixed 1 s, silent — FIXED.** `cmd/sipd/watch.go`: exponential backoff
   capped at 30 s, `Debug` on every attempt and `Warn` every tenth, attempt count on success. Test:
   `TestWatchBacksOffBetweenAttempts`.
10. **`legState.replacesLegID` written after publication — FIXED.** `internal/invite/handler.go`:
    `intent.ReplacesLegID` is already set before `createLeg`, so the field is now set in the
    `legState` literal — before `h.legs[...]` and before `tx.OnCancel`. No signature change.

## P2

- **acl package doc states the wrong evaluation order — FIXED.** `internal/acl/acl.go` package
  comment now says most-specific-prefix first, then priority, then deny-before-allow, with the
  worked `/24 deny` vs `/32 allow` example, and names `profile.ACL.store` as the authority.
- **qop downgrade — FIXED** (see P0 #3).
- **`duplicateListener` cannot see a TCP/WS collision — FIXED.** `internal/config/config.go`: claims
  are keyed by socket FAMILY + address (`udp` for UDP, `tcp` for TCP/TLS/WS/WSS) instead of skipping
  TCP. Tests: new case "TCP and WS on one address with UDP disabled", plus
  `TestUDPAndTCPMayShareOneAddress`. Note this also removes a false positive that existed before
  (UDP and TLS on one address were rejected; they are different sockets).
- **`Set.byListener` indexes the input slice — FIXED.** `internal/profile/profile.go`:
  `set.byListener[key] = len(set.profiles)`.
- **`config.ErrInvalid` unused — FIXED.** `Load` now wraps it. Test: `TestLoadFailuresWrapErrInvalid`.
- **`conn == nil` branch in main unreachable — PARTIALLY FIXED.** The `LogPublisher` branch at
  `main.go:254` is deleted (comment updated). The `if conn != nil` guard in `buildProfiles` is KEPT:
  removing it would also delete the `!watchConfigured && len(overrides) == 0` path and change which
  profiles are built, which is a behaviour change with no bug behind it.
- **Trunk gateways start registering at t=0 — FIXED.** `internal/trunk/supervisor.go`: the first
  `TriggerStart` is armed through the retry timer with a random fraction of `Backoff.Initial`.
- **`gatewayRunner.post` drops silently — FIXED.** Same file: a running runner now falls back to a
  1 s bounded send and logs the dropped trigger; the drop-outright path stays only for a stopped
  runner (which is what its doc comment always described).

## Additional fixes found while in these files

- `Store.Remove` did not drop the cached claim; added alongside the P0 #2 change (would otherwise
  have leaked claims for torn-down legs).
- `internal/dialog/store.go` `Rebind` now refreshes the cached claim, so a UAC's claim carries the
  remote tag it just learned rather than the incomplete triple.

## Deferred / not done

- **Reaper full-bucket listing (P1 #2), the structural half.** The audit's own first option — a
  `WatchAll` on `sip-dialogs` maintaining a local expiry-ordered index of foreign claims — is a new
  long-lived watcher with reconnect and replay handling, and its second option (a queue-group leader)
  needs a lease primitive that would mean writing a non-claim key into a contract-owned bucket. Both
  are larger than a surgical diff and neither is a correctness bug. What landed reduces the constant
  and de-synchronises the fleet; the structural fix is a follow-up.
- **Registrar sweep min-heap.** The brief asked for an expiry-ordered index. What landed is the
  audit's own suggested filter: the KV round trips (the actual cost) are gone; what remains is an
  in-memory map scan per interval, which is microseconds at fleet scale. A heap would need to be kept
  in sync with `trackChange` on every REGISTER for no measurable gain. One consequence worth
  reviewing: a binding another instance deleted now stays in `r.tracked` until its local deadline
  passes rather than being noticed on the next sweep. Bounded, and it costs nothing.

## Cross-area needed

- `packages/pbx-db/src/schema/security-schema.ts`: the `sip_acl_entry.priority` column comment says
  "lower first" without saying "first" is relative to prefix specificity. It should read that the
  most specific prefix wins first and priority is the tie-break within one specificity, matching the
  corrected `internal/acl` package doc.
- Ops docs: a deployment note that SIP over TLS (5061 / 8089) is required on any untrusted network.
  The nonce-count guard narrows the digest-replay window but is per-instance and best-effort.

## Verification

Run from `apps/sipd`:

- `gofmt -l .` → no output.
- `go vet ./...` → clean. `go vet -tags integration ./...` → clean.
- `go test -race ./...` → **18 packages pass, 0 fail** (`cmd/sipd`, `internal/{acl,aor,command,config,
credentials,dialog,invite,kv,mwi,nat,presence,profile,reaper,registrar,subscribe,transfer,trunk}`).
- `go.mod`: `golang.org/x/sync` moved from the indirect block to the direct one (`go mod tidy`).
  No other module changes.
- **Gated integration tests were NOT run**: this machine has neither Docker (`docker info` fails) nor
  a local `nats-server` binary, so the `//go:build integration` suites cannot start a broker. They do
  compile (`go vet -tags integration ./...`).
