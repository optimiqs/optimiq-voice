# REVIEWFIX-C — R03, R06, R18 (mediad control + runners + runtime-go primitives)

## R03 · Retried secure allocations advertise keys different from the live SRTP context — FIXED

Verified: `negotiateSDES` drew fresh key material before `Manager.Allocate`, which returns an existing
session without touching its context; `HandleCreateOffer` overwrote `pendingSRTP` on every retry.
Both probes reproduced before the change.

Negotiation is now session-owned and versioned:

- NEW `apps/mediad/internal/rtp/negotiation.go` — `Negotiation{Generation, Request, SDP, Local, Pending}`
  plus `Manager.Negotiate(sessionID, request, exchange)`. The exchange runs under a lock private to the
  session id (taken outside `Manager.mu`, so it may call `Allocate`), sees the committed negotiation and
  whether the request is byte-identical, and returns the negotiation to commit together with the
  `*SRTPContext` it implies. The SDP and the crypto context are installed in one step; the generation is
  assigned by the manager. A settle (`Request == ""`) carries the offer's identity forward so a later
  retry of that offer still replays.
- `apps/mediad/internal/rtp/manager.go` — two one-line calls: `negotiating.forget(sessionID)` when
  `Allocate` binds a session id afresh, and in `closeAndAnnounce` so the negotiation dies with the
  session on every end path (release, timeout, reap, drain). One field added to `Manager`.
- `apps/mediad/internal/control/handlers.go` — allocate and create-offer now run their whole
  bind-and-render inside the exchange. A replay skips key generation and answers with the committed
  body; a genuine renegotiation commits a new generation. New `renderAnswer` helper (extracted, not
  rewritten) and an `errRefusedInExchange` sentinel so handler-rendered refusals survive the callback.
- `apps/mediad/internal/control/srtp.go` — `negotiationRequest` (sha256 of the request bytes) is the
  retry identity; `settleOfferedSDES` now settles the PENDING generation through `Negotiate` instead of
  reading a `sync.Map`. `Server.pendingSRTP` and the release-time delete are gone; `Sessions.SettleSRTP`
  is removed from the control interface (nothing calls it any more).

Probe status: `TestReviewSDESAllocateRetryKeepsAnswer` and `TestReviewSDESCreateOfferRetryKeepsKey` PASS.
Tests added: `internal/control/negotiation_test.go` (retry replays the answer, 8 concurrent duplicates
agree on one answer, a `sendonly` renegotiation commits a new body, create-offer retry replays) and
`internal/rtp/negotiation_test.go` (replay, new generation, context installed on rekey, negotiation
forgotten with its session, pending settle keeps the offer's identity).

## R06 · Runners limit execution but leave waiting work unbounded — FIXED

Verified: both runners appended without a queue limit and started a goroutine per new key before taking
a slot; no admission failure, no enqueue deadline, no drain.

- NEW `packages/runtime-go/keyed` — one bounded executor: `MaxConcurrent`, `MaxPending`,
  `MaxPendingPerKey`, `EnqueueTimeout`; `Submit(keys []string, Task) error` returning `ErrOverloaded` /
  `ErrClosed`; `SubmitKey` for the single-key case; `Close` (admission), `Wait`, `Shutdown` (drain +
  cancel). A slot is taken BEFORE a task stops counting as pending, so goroutines waiting for one are
  bounded by `MaxPending` rather than by the number of distinct keys. A task whose enqueue deadline
  passed is still invoked, with an expired context, so the caller can answer its requester and do no
  work. Reservations are released via `defer`, so a panicking task cannot wedge a key.
- Multi-key reservation (per agent B's R11 request): a task runs only when it is first in line on every
  key it reserves, so `{a,b}` and `{b,c}` serialise while `{a}` and `{c}` run concurrently. It cannot
  deadlock — each key queue is in arrival order, so the oldest admitted task is first in line everywhere.
- `apps/mediad/internal/control/runner.go` and `apps/sipd/internal/command/runner.go` are now thin
  wrappers over it (limits: 256 concurrent, 4096 pending, 256 per key, 2s enqueue timeout). The runner
  API stays key-agnostic: `Submit(key)`, `SubmitKeys(keys)` (mediad), `SubmitContext`, `Drain`.
- Both NATS surfaces answer instead of dropping: admission failure → `capacity` (or `shutting_down`
  while draining), enqueue expiry → `capacity`, via new `refuseOverloaded` helpers.
- mediad now submits the FULL session set a request names (`request.sessions()`), falling back to B's
  `orderingKeyFor` for reference-only commands. `Server.DrainCommands(ctx)` is called from both mains
  after unsubscribe and before the session/dialog teardown.

Probe status: `TestReviewOverlappingCommandsSerialize` PASSES (it exercises B's ordering key; the
executor's own multi-key guarantee is covered by `TestIntersectingKeySetsSerialiseAndDisjointOnesDoNot`
and `TestASingleKeyWaitsForTheSetThatContainsIt` in `packages/runtime-go/keyed/executor_test.go`).
Tests added: 11 in `keyed/executor_test.go` (ordering, concurrency, total and per-key admission limits,
expired-deadline task, close/drain, shutdown cancellation, unique-key burst stays bounded, multi-key).

## R18 · Media lifecycle publication loses order and does not recover failures — FIXED

Verified: `publishAsync` started an independent goroutine per event, so `recording.finished` could reach
the broker after the `session.ended` that consumers tear the leg down on; `publish` logged failures with
no retry.

- NEW `packages/runtime-go/ackpub` — the acknowledged publisher, built on `keyed` rather than a
  scheduler of its own. `Event{ID, Key, Type, Critical, Publish}`, `Options{MaxConcurrent, MaxPending,
MaxPendingPerKey, Timeout, Attempts, Backoff, Failed, Logger}`, `Publish/Pending/Close/Wait/Shutdown`.
  Events sharing a key publish in submission order; critical events retry with exponential backoff to
  the attempt budget and keep their event id across attempts; telemetry is attempted once; anything
  unacknowledged goes to the `Failed` hook (the seam a durable outbox hangs off — this is the API for
  agent D's sipd finalization outbox).
- `apps/mediad/internal/control/lifecycle.go` adopts it, keyed by session id: `session.ended`,
  `recording.finished` and `dtmf.received` are critical; `session.rtp-timeout` and `playback.finished`
  are telemetry. The envelope id is generated once and reused across retries, landing in JetStream's
  duplicate window. `Wait(ctx)` now closes admission before waiting, so the drain cannot be outrun.

Tests added: `internal/control/lifecycle_order_test.go` (a held `recording.finished` still precedes
`session.ended`, a rejected digit is retried with the same event id, telemetry is published once,
`Wait` closes admission) and 6 in `packages/runtime-go/ackpub/ackpub_test.go`.

## Also fixed in files touched

- Comment drift (R24-style), including agent A's R10 request: `AllocateOptions.Inactive` and
  `directionToMutes` no longer claim `ModeInactive` is the record of direction — the two gates are, and
  the mode is derived from them. The allocate handler's own "no mode change" note updated to match.
- Removed the now-dead `Sessions.SettleSRTP` from the control interface and its stub.

## Cross-area needed

- `rtp.Manager.SettleSRTP` / `Session.SettleSRTP` are now unreferenced (agent A/B own those files). Safe
  to delete with `Session.srtp.CompareAndSwap` there; left in place to avoid touching their files.
- Agent B: mediad's runner accepts key sets (`SubmitKeys` / `SubmitContext([]string, …)`) and
  `Subscribe` already passes `request.sessions()`; if `orderingKeyFor` grows a set-returning form,
  swap that one expression in `control.go`.
- Agent D: adopt `packages/runtime-go/ackpub` for sipd's finalization outbox; the `Failed` hook is the
  "retain the claim" trigger, and `Publish` returning `ErrOverloaded`/`ErrClosed` means the event was
  never handed over.

## Verification (final, exact)

- `packages/runtime-go`: `gofmt -l .` clean, `go vet ./...` clean, `go test -race -count=1 ./...` →
  6/6 packages ok (ackpub, health, keyed, metrics, netbuf, proclimit), 0 fail.
- `apps/mediad`: `gofmt -l .` clean, `go vet ./...` clean, `go test -race -count=1 -p 1 ./...` →
  8 ok, 0 fail (audio, config, control, events, metrics, rtp, sdp, webrtc; cmd + directory have no tests).
  `go build -tags loadtest ./...` clean.
- `apps/sipd`: `gofmt -l internal/command` clean, `go vet ./...` clean, `go test -race -count=1 -p 1
./...` → 0 failures.
- Review probes: `go test -overlay … -run TestReview ./apps/mediad/internal/control` → ok (all three
  control probes pass).
