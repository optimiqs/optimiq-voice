# FIX — SIP hardening (sipd / mediad)

Area: `apps/sipd`, `apps/mediad`, plus additive contract fields in `packages/events`.
Nothing committed. No service restarted. Branch `feat/optimiq-pbx-phase0`.

---

## 1. P0 — REGISTER/INVITE credential-spray lockout — FIXED

`apps/sipd/internal/registrar/authfailure.go` throttled the audit ROW (one `auth-failed` per
(source, account) per minute) while the attempts themselves ran at full rate: one credential RPC and
one MD5 per packet. That is a denial of service against `rpc.sip.v1.credential` before it is a
password problem.

**New: `apps/sipd/internal/registrar/lockout.go`** — `Lockout`, a concurrency-safe failure counter
shared by every handler that authenticates.

- Two counters: per `(source, account)` (`Threshold`, default 5) and per source across all accounts
  (`SourceThreshold`, default 50) so a spray spread thin over a thousand extensions still trips.
- Exponential backoff: `Base` (30s) doubling on each successive lockout for the same key, capped at
  `Max` (30m). The shift is bounded before it is taken — `1<<63` on a `Duration` is negative, which
  would unlock rather than lock.
- Failures DURING a lockout do not extend it. A spray that ignores the 403 would otherwise hold
  itself locked out for ever, which reads as a permanent outage to the honest phone behind the same
  NAT.
- `Succeed` clears the ACCOUNT counter only. Clearing the source counter would let an attacker
  holding one valid account behind the address reset the distributed-spray cap on every REGISTER.
- Idle eviction (`Window`, 15m) plus a bounded table (`MaxTracked`, 20 000) swept then cleared —
  an attacker choosing source ports chooses the key space, so the ceiling must be one they cannot
  move. Same shape as the existing `nonceGuard`.
- Metrics-friendly monotonic counters via `Stats()`: `Failures`, `Lockouts`, `Refused` (refusals
  served with no credential lookup). Typed atomics, no lock on the read.
- `NewLockout` returns `nil` for a non-positive threshold and every method is nil-safe, so a
  deployment can disable it without a branch at each call site.

**Wired at both call sites, BEFORE the credential lookup**, and answered `403 Forbidden` —
byte-identical to the answer an unknown account gets, so there is no enumeration difference between
unknown and locked:

- `internal/registrar/registrar.go` `authorize()` — check, `Fail` on `ErrNotFound` and on a failed
  digest, `Succeed` on success (including the re-fetched-credential path).
- `internal/invite/handler.go` `authorize()` — the same three calls. One `Lockout` instance is built
  in `cmd/sipd/main.go` and passed to both, so a spray that alternated REGISTER and INVITE gets one
  budget rather than two.

**Event.** `registrationAuthFailedDataSchema` gains an additive optional `locked: boolean`
(`packages/events/src/schemas/registration-events.ts`), regenerated into
`packages/events-go/registration_events_gen.go`. `publishAuthFailure` takes a `locked` argument and
sets the field only when true — an explicit `false` on every ordinary refusal is noise in a table
whose purpose is being read by hand. The org and AOR needed for the org-scoped subject are
remembered on the failure counter, so a refusal served without a credential lookup is still
attributable; a lockout tripped entirely by attempts against accounts that resolve to nothing
publishes nothing, which is the pre-existing rule.

**Config** (`internal/config/config.go`, documented in `apps/sipd/README.md`):
`SIPD_AUTH_LOCKOUT_THRESHOLD` (5), `SIPD_AUTH_LOCKOUT_SOURCE_THRESHOLD` (50),
`SIPD_AUTH_LOCKOUT_BASE` (30s), `SIPD_AUTH_LOCKOUT_MAX` (30m), `SIPD_AUTH_LOCKOUT_WINDOW` (15m),
each validated at boot.

**Tests** — `internal/registrar/lockout_test.go` (new, 10 cases) and one case in
`internal/invite/handler_test.go`:

- threshold, exponential backoff to the ceiling, no extension during a lockout, source cap across
  accounts, success clears the account but not the source, idle-window reset, bounded table,
  concurrent use under `-race`, nil-safety when disabled.
- **`TestASprayOfAThousandWrongPasswordsCostsAHandfulOfLookups`** — the load-rig scenario at unit
  scale through the real REGISTER harness: 1 000 full challenge/answer rounds with wrong passwords,
  every one answered 403 with no `WWW-Authenticate`, asserting **at most 6 credential lookups**
  (actual: 3) and that a legitimate REGISTER succeeds once the window passes.
- `TestARepeatedlyRefusedInviteStopsReachingTheCredentialStore` — the INVITE half; 20 attempts, at
  most 4 lookups, nothing reaches the broker.

**Not done, deliberately:** `internal/subscribe` and `internal/transfer` authenticate the same way
and still cost one lookup per attempt. Both are mid-session surfaces reached only by an endpoint
that already registered, and the brief scoped this to REGISTER/INVITE. Wiring them is three lines
each against the same `Lockout` — recommended as a follow-up.

---

## 2. P1 — SDES-SRTP for SIP phones — FIXED (details in §5)

The sipd half needed no change, and that was verified rather than assumed: `sipd` carries SDP as
opaque bytes by contract (`sip-dialog-events.ts`, "why `sipd` never parses the bodies it carries"),
and a grep for SDP rewriting across `apps/sipd/internal` and `cmd` finds exactly one reader —
`internal/dialog/offer.go` extracting the direction attribute, which copies nothing and rewrites
nothing. `a=crypto` lines therefore ride through `sdpOffer`/`sdpAnswer` untouched in both
directions. The mediad work is §5.

---

## 3. P1 — STIR/SHAKEN visibility — FIXED

**Contract (additive).** `sipAttestationSchema` in `packages/events/src/schemas/rpc.ts`, hung on
`sipInviteRequestSchema.attestation` (optional). Fields: `level` (`A`/`B`/`C`), `verstat` (free
text, lower-cased — it is carrier-writable and an unrecognised value must reach a CDR rather than
fail an INVITE), `assertedIdentity`, `origId`, `signed`. The `Identity` JWS itself is deliberately
NOT carried: it is multi-kilobyte, this platform verifies no signature, and a field nobody checks
that looks like proof is worse than no field. No signing is implemented — that is carrier-side.

**New: `apps/sipd/internal/invite/attestation.go`.** Reads `P-Asserted-Identity` (RFC 3325), the
`verstat` parameter wherever the carrier hung it (PAI URI or From), and `Identity` (RFC 8224):
`attest`/`origid` from the header parameters first (the shape most carriers still send), falling
back to decoding the PASSporT payload — the middle base64url segment of the JWS — when they are
absent. The payload decode is bounded at 4 KiB so an attacker-chosen allocation cannot sit on the
INVITE path, and every parse failure contributes nothing rather than failing the call. A level
outside A/B/C is dropped rather than passed on as a value the contract's vocabulary does not admit.

**Populated ONLY for `AuthenticationTrunkACL`** (`internal/invite/intent.go`). A digest phone can
write a `P-Asserted-Identity` as easily as a `From`, so reading one from an internal call would hand
every extension a spoofing surface. Mapped onto the RPC in `internal/invite/client.go`.

**Tests** — `internal/invite/attestation_internal_test.go`: 7 header fixtures (nothing at all,
verstat on PAI, verstat on From, params on Identity, PASSporT payload fallback, unknown level
dropped, unparsable payload), the digest-vs-trunk gate, and the admission-request mapping including
the absent case.

**Cross-area (not done, off limits):** the engine must read `request.attestation` and land it on the
CDR row; `packages/cdr-db` needs the column. Nothing consumes the field yet — it is on the wire and
inert.

---

## 4. Early media — ASSESSED, plus one S-sized bug fixed

### What exists

The sipd dialog FSM implements early media completely: `TriggerLocalEarlyMedia`
(`internal/dialog/dialog.go:296`) commits the answer, and `TriggerLocalAnswer` repeats the committed
answer byte for byte when the 200 carries none, which is exactly RFC 3261 §13.2.1. `offerState`
retains the bytes for that purpose. `internal/invite/commands.go` `Ring()` already routes a
non-empty `sdpAnswer` to that trigger.

The single sipd-side blocker is five lines in `internal/command/handlers.go:84-89`: `HandleRing`
refuses `not_supported` for any 183 carrying a body. Removing that refusal makes the UAS path work.

### The bug found and fixed (S)

`TriggerRemoteEarly` (the UAC path — a carrier answering our INVITE with `183 + SDP`) committed the
answer into `offerState` but published a `progressed` effect with **no body and no status**, so
`internal/invite/executor.go:110-121` never set `HasEarlyMedia` or `SDPAnswer`. The engine therefore
received `dialog.progressed` with `hasEarlyMedia:false` and no `sdpAnswer` even when the carrier
sent one — a direct contract violation of `sipDialogProgressedDataSchema`, whose `sdpAnswer` is
documented as "present only on a UAC leg… so early media can be settled without a second round trip
back to the edge for bytes the edge is already holding".

Fixed in `internal/dialog/dialog.go` (the effect now carries `Status: in.Status, Body: in.Body`),
with `TestACarriersEarlyAnswerTravelsOnTheProgressedEffect` asserting both the 183-with-body and the
plain-180 cases. This is the piece the engine needs before it can stop deferring, and it was S.

### Plan for the rest (NOT implemented — it is M and crosses into engine and mediad)

1. **sipd (S).** Delete the `HandleRing` refusal; keep the `183` status check. Add a command test
   asserting the 183 goes out with the body and that the subsequent 200 repeats it verbatim. Extend
   the e2e SIP test to drive a 183+SDP.
2. **mediad (M).** `allocate-session` already produces an answer for an A-leg; early media needs
   that answer to become an ACTIVE one-way path before the call is answered. Two sub-parts:
   (a) accept `direction: "sendonly"` on allocate/create-offer, which is refused `not_supported`
   today (`mediaAllocateSessionRequestSchema` doc: "held legs are rung 5"); (b) let the bridge start
   relaying B→A while the A-leg dialog is still `Early`, which the RTP manager can already do — the
   gate is the engine, not the socket.
3. **engine (M, other agent's area).** On `dialog.progressed` with `hasEarlyMedia`, call
   `accept-answer` for the B-leg and bridge one-way to the A-leg, then issue `rpc.sip.v1.ring` with
   status 183 and mediad's answer on the A-leg. Two hazards to test: the 200 must repeat the same
   answer (sipd already guarantees this from its own record), and `billsec` must still start at
   `dialog.answered`, never at the 183 — a CDR that billed early media would be a refund queue.
4. **Proof.** One live carrier call to a busy/announcement destination, asserting audio energy at
   the caller before the 200, and a CDR whose `billsec` starts at the answer.

Estimate: sipd S, mediad M, engine M, one live scenario. Not started.

---

## 5. mediad — SDES-SRTP (RFC 4568, `AES_CM_128_HMAC_SHA1_80`) — FIXED

`internal/sdp/sdp.go` emitted `RTP/AVP` unconditionally, so every desk phone and trunk leg carried
plaintext RTP with no SDES support at all.

- **Parse** — new `internal/sdp/srtp.go`. `Offer.Crypto` takes the first `a=crypto` line whose suite
  is `AES_CM_128_HMAC_SHA1_80`; other suites are skipped, and an offer carrying only unsupported
  ones yields a zero `Crypto` rather than an error. Inline material must base64-decode to exactly 30
  bytes (16-byte key + 14-byte salt) or `ErrBadCryptoKey` is returned; `|lifetime|MKI` suffixes are
  tolerated and ignored. Crypto is read ONLY when the audio proto is SAVP/SAVPF, so a stray or
  malformed crypto line on an `RTP/AVP` offer cannot break a plain leg.
- **Build** — `Answer.Crypto` / `OfferParams.Crypto`. When set, the `m=` line becomes `RTP/SAVP` and
  exactly one `a=crypto:<the offered tag> AES_CM_128_HMAC_SHA1_80 inline:<30 fresh random bytes>`
  follows it. A zero `Crypto` renders byte-for-byte what it rendered before, asserted by two tests.
  Keys are drawn per leg from `crypto/rand`.
- **Policy** — `MEDIAD_SRTP_POLICY` = `prefer` (default) | `require` | `disable`, validated in
  `internal/config` and threaded to `control.ServerOptions`. New `internal/control/srtp.go`:
  `require` drops `RTP/AVP|AVPF` from the accepted transports and refuses with the EXISTING
  `ReasonNotSupported` before any port is bound (no new contract value invented); `disable` drops
  `RTP/SAVP`. `create-offer` originates SDES only under `require` — an offer names one transport, so
  offering SAVP under `prefer` would foreclose the plain-RTP fallback that policy exists for. The
  local key is parked on `Server.pendingSRTP` and completed by `accept-answer`; release clears it.
  This is the "prefer SRTP, allow RTP for UDP/TCP phones" default the brief asked for.
- **Actually encrypted** — `pion/srtp/v3` promoted from indirect to a direct require. New
  `internal/rtp/srtp.go`: independent send (local key) and receive (remote key, 64-packet replay
  window) contexts, each mutex-guarded because several goroutines produce one session's frames.
  Wired at the existing seam in `internal/rtp/transport.go`: `readRTP`/`readRTCP` decrypt in place,
  `writeRTP`/`writeRTCP` encrypt into pooled scratch. A packet failing the auth tag is returned as a
  zero-length read and counted malformed — the loop survives. `Session.srtp` is an `atomic.Pointer`
  so `accept-answer` can settle a B-leg's context while the read loop runs. A nil context behaves
  exactly as today.
- **Tests** — `internal/sdp/srtp_test.go` (supported/unsupported suite, lifetime+MKI, short key,
  non-base64, AVP-ignores-crypto, tag echo, single crypto line, unchanged plain bodies, offer round
  trip); `internal/rtp/srtp_test.go` with **real SRTP packets** through a live socket — protect with
  the far end's context, assert the plaintext echoes back protected and decryptable under our
  advertised key, and that a wrong-key packet and a plaintext downgrade are both dropped
  (`Malformed=1`, `PacketsReceived=0`, nothing echoed); `internal/control/srtp_test.go` (five policy
  paths); `internal/config/config_test.go` (default and invalid value).

**Not done:** the per-org / per-device SRTP flag the brief asked us to check for does not exist
anywhere in the codebase — there is no `srtp` column on `devices-schema.ts`, no org setting in
`org-settings.catalog.ts`. `MEDIAD_SRTP_POLICY` is the deployment-level stand-in; a per-leg policy
needs an additive `srtpPolicy` on `mediaAllocateSessionRequestSchema` plus engine and api work
(cross-area, listed below). The sipd test UA extended to offer SDES over TLS 5161 is owed and needs
a restart.

---

## Verification

`apps/mediad`:

```
gofmt -l .                      → clean
go vet ./...                    → clean
go vet -tags loadtest ./...     → clean
go test -race -count=1 ./...    → 7 packages ok, 0 fail (655 cases pass, 5 skip)
go test -race -tags loadtest ./internal/rtp/ → ok (19.1s)
```

`apps/sipd`:

```
gofmt -l .                 → clean
go vet ./...               → clean
go vet -tags load ./...    → clean
go vet -tags e2e ./...     → clean
go test -race -count=1 ./... → 20 packages ok, 0 fail, 3 with no test files
```

(One earlier run showed a flake in `internal/profile/TestArrivalsSelectTheProfileThroughARealSocket`
— a port-bind race inside `sipgo.Server.ListenAndServe`, in a file this pass did not touch. Green on
re-run and on every subsequent run.)

`packages/events`: `typecheck` clean; `bun test src` → **396 pass, 12 skip, 0 fail** (408 across 13
files). Codegen verified **idempotent** — a second `pnpm codegen` produces a byte-identical tree.
`codegen:check` fails only because it diffs generated output against git HEAD and this pass does not
commit; the generated Go is regenerated and in the working tree.

`packages/events-go`: `gofmt -l .` clean, `go vet ./...` clean, `go test -race ./...` ok.

`config/nats.conf`: **no change needed.** The `locked` field rides an existing subject on the
REGISTRATIONS stream and `attestation` is a field on the existing `rpc.sip.v1.invite` request; no
new subject, stream or bucket is introduced.

## needs-restart

- **sipd** — the lockout, the attestation capture and the UAC early-answer fix are all live-path
  changes and none of them are running on the stack. The load-rig proof of the spray was run at unit
  scale instead; the live scripted spray against 5160/5161 is still owed.
- **mediad** — see §5; the SDES test UA over TLS 5161 is owed for the same reason.

## Cross-area follow-ups

1. **engine** — consume `sipInviteRequest.attestation` and land it on the CDR; `packages/cdr-db`
   needs the column (attestation level, verstat, origid).
2. **engine** — early media, per §4 step 3.
3. **engine/api** — a per-org or per-device SRTP policy does not exist anywhere in the schema; see
   §5. A per-leg policy needs an additive optional `srtpPolicy` on
   `mediaAllocateSessionRequestSchema` / `mediaCreateOfferRequestSchema`, then engine plumbing and an
   org-setting or device column in apps/api.
4. **CAPABILITY-MATRIX** — the "SRTP" row can move from PARTIAL to "SDES on the SIP legs, policy
   deployment-wide" once a live TLS+SDES call is proved; "STIR/SHAKEN attestation" moves from
   MISSING to PARTIAL (captured at the edge, nothing consumes it yet); "Toll fraud — velocity /
   credential spray" moves from PARTIAL to implemented-unproven; "Early media" stays PARTIAL with
   the UAC data-loss half now closed.
5. **sipd (own area, deferred)** — the same lockout on `internal/subscribe` and `internal/transfer`.
