# FIX — G4, pre-answer media (apps/mediad + apps/engine/src/media)

Area: `apps/mediad`, `apps/engine/src/media`, plus the single `relayEarlyMedia` call site in
`apps/engine/src/calls/channel-orchestrator.service.ts`. Nothing committed, staged or stashed.
No service restarted. `packages/events` and `config/nats.conf` **not touched** — see §4.

## Baseline

The previous agent (`FIX-final4.md`, G4 handover block) had already implemented G4 and left it
uncommitted. I reviewed it against the brief rather than re-implementing, kept it as the baseline,
and filled the two gaps below. No duplicate implementation exists in the tree.

## The fix as it now stands

**Engine.** `MediaPort.earlyMedia(channelId, relayFrom?)` — the optional second argument is the leg
whose early media this is (the callee's). `SplitPlaneMediaPort.earlyMedia` allocates the caller's
session and gets the `183` on the wire as before, then calls the new private `relayEarlyAudio`,
which issues `MediadMediaPort.bridgeEarly(caller, callee)`. That is the ordinary
`rpc.media.v1.bridge-sessions` under a bridge id derived from the caller's leg (`early-<sessionId>`),
so a chatty carrier's second `18x` re-issues the same command instead of opening a second relay —
which is also why the repeat branch of `earlyMedia` calls `relayEarlyAudio` before returning: the
first attempt may have got the `183` out and failed the bridge. The relay is best-effort: a refusal
is logged and the committed exchange is left alone, because the `200` bridges the pair anyway.
`channel-orchestrator.service.ts:3334` passes `mediaChannelId` as `relayFrom` — one argument, the
only line touched outside my area.

**mediad.** `Session.lastWrite` (atomic, stamped in `writeRTP`, the one choke point for every
outbound packet) and a `ReapIdle` clause: a leg that has never RECEIVED a packet but is putting its
peer's audio on the wire counts its idle from the last write. That is exactly a caller listening to
an announcement, and without it the idle backstop reaps the caller's session out from under the
audio it is relaying. The RTP-timeout branch is untouched — a leg that has heard nothing is still
never reported as a media failure.

**Two-way at the answer** needs no new code: `Manager.Bridge` detaches both sessions from whatever
bridge they were in before installing the new peers, so the walk's own bridge at the `200` replaces
`early-…` rather than leaving it behind. Now asserted (below).

**Billing** is untouched. `settleOutboundAnswer` + `relayEarlyMedia` run under
`nextCallState === "early"`; `markAnswered` / `channel.answered` / the duration ceiling stay under
`"active"`. Verified by reading the branch, and the pre-existing
`channel-orchestrator.spec.ts` case asserting no `channel.answered` until `active` still passes.

## Gaps I filled

1. **The "completes to two-way at the answer" proof was missing.** New real-socket `-race` test
   `TestTheEarlyRelayBecomesTwoWayAtTheAnswer` (`internal/rtp/earlymedia_test.go`, ports
   56480–56499): only the announcing leg latches, the caller's is seeded from its offer, B→A audio
   arrives while the caller has sent nothing; then the pair is re-bridged under the walk's id, the
   early bridge is asserted GONE (`Unbridge("early-leg-a")` → `false`), and audio is asserted in
   **both** directions afterwards.
2. **The A→B direction was undocumented.** The relay is symmetric where RFC 3960 §3.1 only asks for
   the announcement direction. I kept it symmetric and documented why on `bridgeEarly`: gating the
   caller's own packets would need a dialog state the media plane deliberately does not hold, and it
   buys nothing — a caller listening to an announcement sends nothing until they answer, and one
   that does send early is talking to a party already playing at them. Dropping A→B would also mean
   a mode the existing `ApplyDirection` cannot promote back (the documented latent bug in
   `FIX-sipd-mediad-halves.md` §SKIPPED).

The B→A-before-answer proof was already present and passing:
`TestASeededLegHearsItsPeerBeforeItHasSpoken` (seeded far end, caller has sent nothing, asserts the
announcement arrives AND that `PacketsReceived == 0`), plus
`TestTheIdleReaperLeavesALegThatIsRelayingEarlyMedia` (the reaper change, with an abandoned control
leg proving the backstop still reaps).

## Not needed

No `packages/events` change and no `config/nats.conf` grant. `mediaBridgeSessionsRequestSchema`
takes `bridgeId: z.string().min(1).max(128)` with no format constraint and `sessionIds` as a plain
array, and `Manager.Bridge` has no answered/active gate anywhere on the path
(`internal/control/handlers.go` → `internal/rtp/manager.go:512`). An `early: true` flag would have
been a field nothing branched on. Subject and stream set unchanged, so no broker HUP is owed.

## Verification (exact)

| Check                                               | Result                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/engine run typecheck` | clean                                                               |
| `pnpm --filter @optimiq-voice/engine run test`      | **1903 pass, 12 skip, 0 fail** (1915 tests, 82 files, 4291 expects) |
| `pnpm exec oxlint apps/engine/src/media`            | no diagnostics                                                      |
| `pnpm exec oxfmt apps/engine/src/media`             | 28 files, clean                                                     |
| `cd apps/mediad && gofmt -l .`                      | clean                                                               |
| `cd apps/mediad && go vet ./...`                    | clean                                                               |
| `cd apps/mediad && go test -race -count=1 ./...`    | **9 packages ok, 0 fail**, 2 with no test files                     |

No failures outside my files. `TestConcurrentAllocateIssuesDistinctPorts` — the port-range flake
`FIX-sipd-mediad-halves.md` recorded — did not recur this round.

## needs-restart

- **mediad** — `lastWrite` / the reaper clause are live-path. Not restarted.
- **engine** — the `183` now issues `bridge-sessions`. Not restarted.
- **sipd** — unchanged by this pass (it still needs the restart the earlier pass recorded).
- No NATS reload: no new subject, stream, field or grant.
