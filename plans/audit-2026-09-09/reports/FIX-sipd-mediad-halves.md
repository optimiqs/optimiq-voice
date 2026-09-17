# FIX — the sipd/mediad halves of the engine-feature work

Area: `apps/sipd`, `apps/mediad` only. Nothing committed, staged or stashed. No service restarted.
`apps/engine`, `apps/api`, `packages/*` read only and untouched.

---

## 1. sipd `deviceId` on the admission RPC — FIXED

`FIX-engine-features.md` cross-area §1 / `FIX-cdr-attestation-deviceid.md`. The contract field
(`SipInviteRequest.DeviceID`) already existed in `packages/events-go`; nothing populated it, so the
API's Ray Baum consumer always took the inference fallback.

- `internal/invite/intent.go` — `CallIntent.DeviceID` and `ParseOptions.DeviceID`, documented as
  identity and never authorisation; carried through `Parse`.
- `internal/invite/handler.go` — `parseOpts.DeviceID = credential.DeviceID`, in the
  `profile.AuthDigest` arm beside the existing `OrgID` / `CallerAOR` assignment. The trunk-ACL arm is
  untouched, so a trunk INVITE asserts no device (a trunk resolves no credential).
- `internal/invite/client.go` — `request.DeviceID = optional(intent.DeviceID)` beside `OrgID`, so an
  empty value is OMITTED rather than sent as `""` (the responder's `z.uuid()` would refuse it).

`credentials.Credential.DeviceID` was already populated from `sipCredentialResponseSchema.deviceId`
(`internal/credentials/nats.go:248`) — no credential-path change was needed.

Tests (`internal/invite/client_internal_test.go`): the trunk case asserts `deviceId` is omitted; the
digest case asserts it is carried verbatim.

## 2. sipd early-media refusal deleted, and the answer plumbed — FIXED

`FIX-engine-features.md` cross-area §2 / `FIX-sip-hardening.md` §4 step 1.

`internal/command/handlers.go` `HandleRing` refused `not_supported` for any provisional response
carrying a body AND then passed `""` to `dialogs.Ring` regardless — so deleting the refusal alone
would have sent a bodyless 183. Both halves fixed:

- the `not_supported` block is gone; the `status < 180 || status > 183` guard above it stays;
- the answer is read out of the request and passed to `s.dialogs.Ring(ctx, legID, status, answer)`,
  which routes it to `dialog.TriggerLocalEarlyMedia` (the trigger that commits the answer so the 200
  repeats it byte for byte, RFC 3261 §13.2.1 — already implemented in `internal/dialog`);
- **new refusal, narrower:** a body on anything but a 183 is `bad_request`. A 180 commits nothing and
  cannot answer an offer, and `Ring()`'s existing "reachable only when a caller bypasses the
  responder's refusal" comment would otherwise be the only thing keeping a 180+SDP off the wire.
- the `HandleRing` doc comment rewritten (it asserted the opposite).

Test: `TestRingRefusesEarlyMediaAndSaysWhy` replaced by
`TestRingCarriesAnEarlyAnswerOnA183AndRefusesOneOnA180` — asserts the 183 reaches the dialog layer
with the answer intact, and that a 180 carrying one is refused `bad_request`.

## 3. sipd CLIR + P-Asserted-Identity — FIXED

`FIX-clir.md` "The sipd half", implemented exactly as specified, in
`internal/invite/originate.go` `buildOriginateInvite`.

- **PAI on every outbound trunk INVITE, regardless of presentation** (RFC 3325 §7):
  `P-Asserted-Identity: "D" <sip:N@T>`, display name omitted when there is none. One `sip:` form, no
  `tel:` twin. Gated on `target.trunkID != ""` — never toward a registered UA, which is outside the
  trust domain. `T` is `target.from.Host`, which `resolveTrunk` already sets to the trunk's
  `SIPDomain` falling back to the proxy host — never to `anonymous.invalid`.
- **`restricted`**: `From: "Anonymous" <sip:anonymous@anonymous.invalid>;tag=…` (RFC 3323 §4.1.1.3,
  literally that reserved host; the local tag is still `h.newTag()`), the real identity still in PAI,
  and `Privacy: id` (§4.2 — not `user`). `Contact` untouched (transport), no `Remote-Party-ID`.
- **Internal legs**: the number is presented normally; a restricted internal leg is still anonymised
  in `From` + `Privacy: id`, but gets no PAI.
- **`allowed` or absent**: `From` unchanged, no `Privacy`. An unknown enum value never reaches here —
  the contract enum is closed at decode.
- New helper `assertedIdentity(displayName, uri)`. Both headers are appended before the
  caller-supplied `request.Headers` loop, so `headerAllowed` still refuses a caller-written
  `P-Asserted-Identity` / `Privacy` — the edge writes them, the engine only states intent.

Tests with wire assertions (`internal/invite/originate_internal_test.go`, 3 new):
`TestBuildOriginateInviteAssertsIdentityOnEveryTrunkInvite` (exact PAI string, From unchanged, no
Privacy), `…WithholdsTheNumberOnARestrictedTrunkInvite` (exact anonymous From, tag survives, PAI
carries the real number, `Privacy: id`, Contact still real, body not rewritten),
`…KeepsAssertedIdentityOffAnInternalLeg` (no PAI toward a UA; anonymised when restricted; normal and
Privacy-free when not).

## 4. mediad — the far end is seeded from the settled SDP — FIXED

`FIX-engine-features.md` cross-area §3 / `FIX-early-media-engine.md` gap 1. `session.remote` was
learn-only, so during early media (the caller sends nothing until the 200) `forward` bailed at the
`to == nil` guard and the announcement was dropped.

- `internal/rtp/session.go` — new `remoteLearned bool` beside `remote` (both under `remoteMu`), and
  `Session.SeedRemote(netip.AddrPort)`. Seeding only fills an unlatched session; an invalid, zero-port
  or unspecified address is a no-op. `latch` now keys on `remoteLearned` rather than `remote != nil`,
  so **symmetric-RTP learning still overrides a seed on the first packet** (the NAT case: the
  advertised address is private and only the rewritten one works) and, once learned, latches for good
  — the anti-takeover boundary is unchanged. `Remote()`'s doc updated.
- `internal/rtp/manager.go` — `Manager.SeedRemote(sessionID, addr)`, `ErrUnknownSession` for an id it
  does not hold.
- `internal/control/control.go` — `SeedRemote` on the `Sessions` port.
- `internal/control/handlers.go` — called at **allocate-session** with `offer.RemoteAddress` and at
  **accept-answer** with `answer.RemoteAddress` (both already parsed by `internal/sdp` and, until
  now, read by nobody). Best-effort: a failure is logged at DEBUG and never changes the reply.
  `create-offer` seeds nothing — mediad is the offerer there and there is no far end yet; its leg is
  seeded when `accept-answer` settles.

**Watchdog semantics preserved and asserted.** `ReapIdle` keys "silent" on
`session.lastPacket`/`Stats().PacketsReceived`, which seeding does not touch — an early-media leg
that has received nothing is still `!heardSomething`, so it can never be reported as an
`EndReasonRTPTimeout` media failure while the far end plays; only the long idle/leak backstop applies,
exactly as before. The test asserts `PacketsReceived == 0 && LastPacketUnixMs == 0` on the seeded leg
after it has been sent to.

Tests with real sockets, new `internal/rtp/earlymedia_test.go` (ports 56400–56459, over the existing
`bridgeRig`/`phone` loopback harness): a seeded leg receives its peer's audio having never sent a
packet; a seed of an unreachable private address is latched over by the first real packet and the
learned address then wins a second seed; an unknown session is refused. Plus
`internal/control/bleg_test.go` `TestNegotiationSeedsTheFarEndFromTheSettledSDP`: allocate seeds
`203.0.113.9:41000` from the offer's `c=`/`m=`, create-offer seeds nothing, accept-answer seeds
`198.51.100.7:40000` from the answer's.

`stubSessions` in `internal/control/control_test.go` gained `SeedRemote` + a `seeds()` accessor.

## 5. Other cross-area items — checked

- **Attestation (`FIX-sip-hardening.md` §3)**: already complete in sipd
  (`internal/invite/attestation.go`, gated to `AuthenticationTrunkACL`, mapped in `client.go`).
  Nothing further lands here; the consumers are engine/cdr-db and are done.
- **`FIX-go-concurrency.md` keyed runner**: left exactly as it is. `internal/command/command.go`'s
  `keyedRunner` and its `legId` ordering key are untouched; `HandleRing`'s change is inside the
  handler the runner already serialises per leg.

## SKIPPED (with reason)

- **`ApplyDirection` never moves the session mode** (`internal/rtp/manager.go:347-361`,
  `FIX-early-media-engine.md` mediad gap 2). Real but latent: the engine deliberately asks for
  `sendrecv` at the 183 and repeats that answer at the 200, so no live path promotes a narrowed leg.
  Promoting a session's mode mid-call touches the hold/mute gates and the RTP grace window; it is not
  a surgical change and has no behavioural gain for early media. Left as a documented follow-up.

## Cross-area needed (NOT done — outside sipd/mediad)

1. `packages/events/src/schemas/rpc.ts` ~1365 — `sipRingRequestSchema.sdpAnswer`'s doc still says
   "Refused `not_supported` until early media ships", and the paragraph above defers early media to a
   later slice. Both are now false. The accurate rule is: an answer is accepted on a 183 and refused
   `bad_request` on any other provisional status.
2. `packages/events/src/schemas/rpc.ts:1855-1861` — the claim that `direction: "sendonly"` is refused
   `not_supported` is stale; it is honoured (`internal/control/handlers.go`). Unchanged by this pass,
   still worth correcting.
3. Everything else in `FIX-engine-features.md`'s consolidated list (items 4–6: `packages/routing`
   feature-code actions and `ExtensionIndexEntry.outboundCallerIdPresentation`, the pbx-db column +
   API DTO + web toggle, the softphone `pauseRecord` affordance) is unchanged and still owed. Until
   the `packages/routing` half lands, sipd honours `callerIdPresentation` on the wire and only the
   engine's `OPTIMIQ_CLIR` override can set it.

## Verification (exact)

`apps/sipd`:

| Check                          | Result                                           |
| ------------------------------ | ------------------------------------------------ |
| `gofmt -l .`                   | clean                                            |
| `go vet ./...`                 | clean                                            |
| `go vet -tags load ./...`      | clean                                            |
| `go vet -tags e2e ./...`       | clean                                            |
| `go test -race -count=1 ./...` | **21 packages ok, 0 fail**, 3 with no test files |

`apps/mediad`:

| Check                                                   | Result                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `gofmt -l .`                                            | clean                                                      |
| `go vet ./...`                                          | clean                                                      |
| `go vet -tags loadtest ./...`                           | clean                                                      |
| `go test -race -count=1 ./...`                          | **8 packages ok, 1 fail** — `internal/rtp` only, see below |
| `go test -race -count=1 -tags loadtest ./internal/rtp/` | same one failure                                           |

The single failure is `TestConcurrentAllocateIssuesDistinctPorts`
(`internal/rtp/allocator_test.go:299`, "allocated 17 pairs concurrently, want the full capacity 20").
It is the documented environmental flake and **not this pass's**: the test binds the fixed range
52000–52039, and `lsof -nP -iUDP:52000-52039` shows a **running `sipd` process (pid 25251)** holding
52006, 52007, 52019, 52028 and others. It fails identically in isolation (`-run` that test alone,
0.167 s, no other test running) and this pass touched neither the allocator nor its test. Re-run once
as instructed — same result, same cause. Every other `internal/rtp` test, including the four new ones,
passes under `-race`.

## needs-restart

- **sipd** — `deviceId` on the admission RPC, the 183+SDP path, and PAI/CLIR on outbound trunk
  INVITEs are all live-path. Not restarted (a final restart round follows).
- **mediad** — the seeded far end. Not restarted.
- No NATS reload: no new subject, stream or field was introduced by this pass.
