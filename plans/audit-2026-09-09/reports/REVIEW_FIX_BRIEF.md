# External review fix wave — shared brief

An independent review of apps/sipd and apps/mediad (report: output/sipd-mediad-review-2026-09-09/review.md in the repo
root; probes: probe_*_test.go + overlay.json + reproduce.sh in the same dir) found 24 issues R01–R24 with twelve failing
behavioural probes. Treat the review as credible but VERIFY each claim against the current code before changing it; if a
finding is wrong or already fixed, say so with evidence. Read FIX_PREAMBLE.md, MODERN_GO.md, COMMENT_POLICY.md,
STACK.md (this dir) — same standards: minimal diffs, tests for every behavioural change, race-clean, no narrative
comments, no restarts (a live round follows), no commits.

Probes: `go test -overlay output/sipd-mediad-review-2026-09-09/overlay.json -count=1 -run 'TestReview<Name>' ./apps/<mod>/internal/<pkg>`
runs one probe against the working tree without editing service files. Your finding is closed when its probe PASSES;
then PROMOTE the assertion into a focused regression test beside the implementation (own file, our naming) — the
overlay dir is not part of the repo. Where the review says "source-traced" there is no probe: write the failing test
first, then fix.

Ownership (disjoint; stay inside yours, report cross-area needs):

- A mediad-media: internal/rtp/{recording.go, session.go (forward/handlePacket/mode), transcode.go, jitter.go},
  internal/audio/codec.go, Manager.ApplyDirection/mode transitions. R01 R08 R09 R10 R21.
- B mediad-topology: internal/rtp/{manager.go bridge/unbridge/reap/indexes, conference.go, mixer.go, taps},
  internal/control/ownership.go orderingKey. R11 R12 R13 R14 R19 R20. Do NOT touch Manager.Allocate (C).
- C mediad-control + runners: internal/control/{handlers.go, srtp.go, lifecycle.go, runner.go}, a NEW
  internal/rtp/negotiation.go for session-owned negotiation state (only minimal calls added inside Manager.Allocate),
  packages/runtime-go (new bounded executor + acknowledged publisher primitives), apps/sipd/internal/command/runner.go
  (adopt the executor). R03 R06 R18.
- D sipd-dialog: internal/dialog/{store.go, dialog.go}, internal/reaper, internal/sipevents, invite/handler.go forget,
  invite/executor.go session refresh, packages/events-go envelope id helper if needed (codegen untouched). R02 R04 R05
  R15 R22 R23.
- E sipd-ingress: internal/profile (arrivals provenance + the flaky real-socket test), a shared digest authentication
  pipeline adopted by registrar/invite/subscribe/transfer, internal/nat wiring or removal, apps/sipd/README.md and
  comment drift in files you touch. R07 R16 R17 R24(sipd half).
  Every agent fixes R24-style comment drift in files it touches (a comment that promises a guarantee the code does not
  provide is a bug).

Verify: your module `gofmt -l . && go vet ./... (all tag sets) && go test -race -count=1 -p 1 ./...`; the review probes
for your findings; runtime-go if touched. Report to <this dir>/REVIEWFIX-<letter>.md (per finding: fixed/wrong/partial,
probe status, test added, cross-area) and return a compact summary.
