# REVIEWFIX-D — sipd dialog (R02 R04 R05 R15 R22 R23)

Verified every finding against the working tree first; all six were real. No commits, no restarts.

## R02 · wrong remote tag matched an established dialog — FIXED

`internal/dialog/store.go`. The early index (`Call-ID + our tag`) was populated for EVERY dialog,
including UAS dialogs whose remote tag is known from the INVITE, and `MatchRequest` fell back to it
unconditionally. Fix keeps the index but restricts its membership to the only case that needs it:
`index()` writes `byEarly` only while `!Identity.Established()`, and `Rebind` deletes the early entry
when the remote tag arrives. An established dialog is therefore reachable only on the full RFC 3261
§12 triple; a UAC dialog is still reachable early (its CANCEL, Timer B, 100). No handler change was
needed, so early CANCEL/ACK/provisional paths are untouched.

- Probe `TestReviewWrongRemoteTagCannotMatch`: PASSES.
- Promoted: `internal/dialog/store_ownership_test.go` —
  `TestMatchRequestRefusesAWrongRemoteTagOnAnEstablishedDialog`,
  `TestMatchRequestUsesTheEarlyIndexOnlyWhileTheRemoteTagIsUnknown`.

## R05 · dialog store reads raced the dialog owner — FIXED

`internal/dialog/store.go`. `MatchEstablished` and `FindReplaced` read `dialog.state` (and OrgID /
AccountAOR) under the store mutex while `Dialog.Apply` writes it on the owning goroutine. The store
now keeps an owner-rendered immutable snapshot per leg (`view{state, orgID, accountAOR}`) alongside
the existing cached `Claim`, published by the owner in `Insert`/`Rebind`/`Touch`. `Touch` is already
called after every task via `SessionOptions.OnUpdate`, so the view is current by construction; the
state machine stays single-owner and no lock is held across I/O.

- Probe `TestReviewMembershipStateOwnershipRace` under `-race`: PASSES.
- Promoted: `TestStateDependentLookupsDoNotRaceTheDialogOwner` (same file).
- Tests that mutated a dialog directly now `Touch` the store (that is what the owner does).

## R04 · finalisation deleted recovery evidence before durable acknowledgement — FIXED

Adopted Agent C's `packages/runtime-go/ackpub` (checked and present).

- `internal/sipevents/sipevents.go`: `publish` now returns the `PubAckFuture`; new `AckPublisher`
  interface + `JetStreamPublisher.TerminatedAck` (publish and wait for the ack) and
  `PublishTerminatedAck` helper that falls back to the unacknowledged path for a publisher that
  cannot report acceptance.
- `internal/sipevents/finalize.go` (new): `Finalizer` — the pending-finalisation outbox. `Terminated`
  enqueues publish→wait-ack→delete-claim as ONE unit on an `ackpub.Publisher` keyed by leg (bounded
  concurrency, bounded attempts, exponential backoff, off the packet path). `Release` is what
  `Handler.forget` calls: it deletes the claim only when nothing is awaiting an acknowledgement for
  that leg. `Shutdown` drains.
- `internal/invite/publisher.go`: `NewFinalizingSink` routes `dialog.terminated` through the
  finalizer (`NewPublishingSink` unchanged, delegates with nil).
- `internal/invite/handler.go`: new `Options.Finalizer`; `forget` releases through it when set.
- `internal/reaper/reaper.go`: `publishTermination` now waits for the acknowledgement before the
  claim is deleted (the reaper is off the packet path, so it stays synchronous; the next sweep is its
  bounded retry).
- `cmd/sipd/main.go`: builds the finalizer, wires sink + handler, drains it at shutdown before the
  JetStream flush.
- Tests: `internal/sipevents/finalize_test.go` (claim released only after ack; unacknowledged
  termination keeps the claim; retry reuses the id; release without a termination deletes; a failed
  delete is retried with the publish) and `internal/reaper/finalisation_test.go`
  (`TestAnUnacknowledgedTerminationKeepsTheClaim`). Fixed `failingPublisher` in `reaper_test.go`,
  which embedded `RecordingPublisher` and so would have "succeeded" through the new ack path — the
  test was asserting the right thing against a double that no longer modelled failure.

## R23 · orphan termination retries had no stable id — FIXED

`packages/events-go/envelope.go`: new `DerivedEventID(parts...)` — UUID v5 over a fixed namespace
(codegen untouched; `EnvelopeInput.ID` already existed).
`internal/reaper/reaper.go`: `terminationID(claim)` derives the id from the leg INCARNATION (leg id +
owning instance + the dialog's `createdAt`) plus the termination kind, and it is passed as the
envelope ID, so `Nats-Msg-Id` is identical across sweeps and across two reapers.

- Test: `TestAnOrphanTerminationKeepsOneIDAcrossSweeps` (delete injected to fail; two sweeps; same id
  per leg, different ids across legs).

## R22 · serial heartbeats could starve the tail; live owners could be reaped — FIXED

`internal/reaper/reaper.go`:

- Separate budgets: `HeartbeatTimeout` / `ReapTimeout` options, each with its own context per sweep
  (default `Timeout`), so a slow bucket listing can no longer eat the heartbeat's time.
- Bounded parallel renewal: a `Workers` pool (default 16) over the claims — N×latency becomes
  ~N/W round trips.
- Fair continuation: `nextHeartbeat` cursor; a pass that fails or does not reach the tail returns the
  first unrenewed leg id and the next pass rotates to start there.
  `internal/dialog/store.go` — `Reapable`: when instance-lease evidence exists it is now the deciding
  evidence in BOTH directions. An expired per-call claim whose owner is listed live is left alone (a
  late heartbeat, not a dead call); with no lease evidence the claim's own lease still decides.
- Tests: `TestAStarvedHeartbeatResumesWhereItStopped`, `TestAnExpiredClaimOfALiveOwnerIsNotReaped`.

## R15 · session timers selected an unimplementable refresh obligation — FIXED by refusing it

Evidence for the choice: `EffectSendSessionRefresh` cannot build a refresh here at all — the
re-INVITE's offer comes from mediad by way of the engine, so implementing the transaction (422 retry,
glare, failure→termination, rearm) means a new engine command surface, which is outside this area and
outside a minimal diff. So the configuration is refused instead, and nothing silently promises a
refresh:

- `dialog.TimerPolicy.Validate()` + `ErrNoLocalRefresher`: `Enabled && PreferLocalRefresh` fails at
  boot. `cmd/sipd/main.go` now sets `PreferLocalRefresh: false` and calls `Validate`.
- `DefaultTimerPolicy` no longer volunteers as refresher.
- `refresherFor` keeps the RFC 4028 §7.2 mapping but declines a local refresher role at the end (one
  place to delete when the surface exists): a peer that names us is ANSWERED with the far end as
  refresher rather than being promised a refresh that never comes.
- `internal/invite/executor.go`: the now-unreachable `EffectSendSessionRefresh` returns an error
  naming `ErrNoLocalRefresher` instead of logging and reporting success.
- Tests: `internal/dialog/timers_refresher_test.go`; updated `timers_test.go` expectations that
  asserted the unimplementable local-refresher outcome.

## R24-style comment drift fixed in touched files

`sipevents.publish` no longer claims "sipd never retried a failed publish"; `Store.byEarly`,
`MatchRequest`, `MatchEstablished`, `FindReplaced`, `Touch`, `Reapable`, `reap` ordering and
`TimerPolicy.PreferLocalRefresh` comments now describe what the code does.

## Cross-area

- `packages/events-go/envelope.go`: added `DerivedEventID` (additive, no codegen touched). Other
  services may adopt it for their own retried events.
- `packages/runtime-go/ackpub`: adopted as-is, no changes requested.
- `cmd/sipd/main.go` touched (finalizer wiring, timer policy, `newInviteHandler` now returns the
  finalizer). Not claimed by another agent's brief; flagging it since main.go is shared ground.
- The engine/CDR consumer sees `dialog.terminated` for an orphan with a v5 (not v7) event id. Ids are
  opaque UUIDs everywhere I checked, but a consumer that assumes time-ordered ids should be told.

## Verification (final, exact)

- `cd apps/sipd && gofmt -l .` → clean.
- `go vet ./...`, `go vet -tags integration ./...`, `go vet -tags e2e ./...` → clean.
- `go test -race -count=1 -p 1 ./...` → 22 packages ok, 0 FAIL, 2 with no test files.
- `packages/events-go`: gofmt clean, vet clean, `go test` ok.
- `packages/runtime-go/ackpub`: `go test -race` ok (untouched).
- Review probes: `go test -overlay .../overlay.json -race -run TestReview ./apps/sipd/internal/dialog`
  → ok (both dialog probes pass).
