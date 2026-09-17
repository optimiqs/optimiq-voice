# REVIEWFIX-E — sipd ingress (R07, R16, R17, R24 sipd half)

All four findings are "source-traced" in review.md; `probes.txt` contains no probe for any of them,
so each was verified by writing a failing regression test first, then fixing.

---

## R07 · Arrival metadata is associated with a peer, not a message — **FIXED (finding confirmed)**

**Verified.** `Arrivals` keyed `(transport, remote)` → latest local listener, and `Set.For` read it
back on the handler goroutine. sipgo's UDP reader (`sip/transport_udp.go:162`) runs the read filter
on the reading goroutine and then hands the parsed request to a background goroutine, and each
listener has its OWN reader goroutine — so a second datagram from one endpoint to another listener
overwrites the entry before the first handler looks. The doc comment claimed the opposite ("The
entry a handler reads back is therefore the one written for the message it is holding"), which is
R24-class drift on the same file.

**Fix** (`internal/profile/arrivals.go`, `profile.go`): carry the provenance ON the message.
`ReadFilter` now returns rewritten bytes for **datagram** transports: it strips any copy of
`X-Optimiq-Arrival` the sender wrote (line folding included) and inserts its own as the first
header, `"<transport>/<local addr>"`. `Set.localAddrFor` reads that stamp before falling back to the
table. The stamp is trusted only when `req.Transport()` is a datagram transport, so a header on a
stream transport is the sender's text and is ignored.

Stream transports keep the table deliberately: a TCP/TLS/WS read is an arbitrary slice of a stream,
so rewriting those bytes is unsafe — and there per-peer IS per-message, because a connection belongs
to one listener for its whole life. The body is copied verbatim, so `Content-Length` still describes
it, and nothing this process sends copies headers wholesale from an inbound request
(`invite/requests.go` copies named headers only; `originate.go` clones an outbound request), so the
stamp never leaks onto the wire.

**Tests** (`internal/profile/arrivals_stamp_test.go`, new): per-message provenance made deterministic
by reading and parsing both datagrams before asking for the first one's profile; a forged stamp
(plus a folded continuation) ignored and stripped; body preserved byte for byte; stream transports,
a nil local address and a datagram with no header terminator all left unrewritten.
Both new profile-selection tests FAIL on the old lookup order (checked by disabling the stamp read:
`the first datagram chose "external"`).

## R07b · `TestArrivalsSelectTheProfileThroughARealSocket` flakiness — **FIXED**

**Verified** from `profile-rerun.txt`: two failures at once — `the server never bound 127.0.0.1:57352`
(readiness) and a `-race` report inside sipgo.

**Fix** (`arrivals_transport_test.go`, rewritten): the test now binds its own `*net.UDPConn` on port
0 and calls `server.ServeUDP(conn)`. The socket IS the readiness signal, so nothing polls for a bind
another process may have taken; `ServeUDP`'s return is collected and asserted to be `net.ErrClosed`
after the test closes its sockets. It also now sends BOTH datagrams from ONE source socket and holds
the first handler until the second has been read and recorded, which is the R07 interleaving through
a real socket (it fails as `chose "internal"` for the external listener without the fix).

**Upstream race — pinned and documented, not fixed by us.** sipgo v1.4.3's `ListenAndServe`
(`server.go:97-129`) starts a cancellation goroutine that reads `connCloser` and the listening
connection at `server.go:102-108` while the same function writes them at `server.go:123-128`. That
is entirely inside the dependency. Using `ServeUDP` with a test-owned socket sidesteps it; the
reasoning is in the test's doc comment so nobody "simplifies" it back. **Note for the wave:**
production `cmd/sipd/main.go` already avoids it — `serveUDP` binds and calls `server.ServeUDP` — but
`main.go` still calls `server.ListenAndServe` for tcp/ws and `ListenAndServeTLS` for tls/wss, so the
upstream race is live on those paths at shutdown. Not fixed here (it would mean binding four more
socket types in main); flagged for whoever owns the sipgo bump.

## R16 · NAT keepalive and registration clamp are tested helpers with no consumer — **FIXED (decision: wire the clamp, remove the keepalive)**

**Verified.** `RegistrationInterval` and `KeepaliveDue` had only test callers, and REGISTER never
consulted the profile set at all (`cmd/sipd/main.go` builds the registrar before `buildProfiles`).

**Evidence for the decision:**

- There is **no configuration surface** for `KeepaliveMethod`, `KeepaliveInterval` or
  `MaxRegistrationInterval` — a repo-wide grep finds them only in `internal/nat` and its own tests.
  They were hard-coded defaults nothing could change or use.
- A server-sent OPTIONS keepalive needs binding enumeration, a fleet-wide ownership rule (which
  instance pings a binding another instance granted?) and a paced cancellable worker. That is a new
  subsystem, not a wiring change, for a P2 in a no-restart wave.
- The clamp needs no cooperation from the device and is the pinhole mechanism that actually works.

**Wired** the clamp: `registrar.NATPolicy` seam + `Options.NATPolicy` / `TrackNATPolicy`,
`clampGranted` applied in `contacts.go` right after `ExpiryPolicy.Grant`;
`profile.Set.MaxRegistrationInterval(req)` implements it (per-profile, selected by the same listener
provenance as everything else); `main.go` attaches the set to the registrar in `newInviteHandler`,
where the set is built. `granted == 0` (de-registration) is left alone and the result never drops
below `ExpiryPolicy.Min`.

**Removed** the unsupported promises: `KeepaliveMethod`, its constants, `Valid()`, `KeepaliveDue`,
the two `Policy` keepalive fields, the profile validation of the method, and the corresponding tests.
The `MaxRegistrationInterval` doc now states plainly that there is no server-sent keepalive.

**Tests**: `registrar_test.go` — `TestNATClampBoundsTheGrantedRegistration` (clamped grant reaches
both the binding AND the `Expires` header a device reads; a shorter request untouched; the minimum
floor honoured; `Expires: 0` still de-registers). `internal/profile` — the clamp follows the
arriving profile (300s internal, none external). The `Expires`-header assertion is the "verify the
actual REGISTER expiry response" half; it goes through the real handler and sipgo-parsed wire
requests, not a socket — noted rather than claimed.

## R17 · Four copied authentication flows that had diverged — **FIXED**

**Verified**, and worse than the summary: SUBSCRIBE and out-of-dialog REFER ran **no lockout at
all**, so a spray using them had an unthrottled budget and cost a credential RPC per packet; only
REGISTER re-fetched a rotated credential; every lockout key used `req.Source()` including port; and
the account key omitted the realm.

**Fix**: new `internal/registrar/digest.go` — `DigestGate.Authenticate(ctx, req, identity, aor)`,
one pipeline for nonce handling, realm check, identity binding, throttle accounting, credential
lookup, the stale-credential refresh and failure classification. It returns a `DigestResult` with a
`DigestOutcome` and **no SIP status**: each handler keeps its own responses, logs and events.
Adopted by `registrar.authorize`, `invite.authorize`, `subscribe.authorize` and `transfer.authorize`
(each now a switch over the outcome). `Options.Lockout` added to subscribe and transfer and wired in
`main.go` to the one process-wide lockout.

Behaviour changes, all deliberate:

- SUBSCRIBE and REFER now throttle and record failures, sharing the one budget.
- All four now re-fetch a rotated credential once and re-verify (`credentials.Refresher`).
- `SourceIdentity(req)` drops the port, so NAT/attacker port churn cannot split a counter. The
  `auth-failed` event rate limiter (`authfailure.go`) was keyed the same way and is fixed too.
- The lockout account key is `realm/username`, so two tenants' extension 1001 have separate counters.
- The now-dead `Registrar.refresh` and the unused stored `lockout` fields were removed.

**Tests** (`internal/registrar/digest_test.go`, new, 6 tests / 14 subtests): a wrong password through
every one of the four methods reaching the same outcome and the same org attribution; a spray that
alternates methods exhausting ONE budget and the fourth method then refused without a credential
lookup; source-port churn not buying a new budget; the same username in two realms keeping separate
counters; a rotated credential accepted after one refresh for every method; disabled account,
unknown account (still counted against the spray cap), a backend failure classified as retriable and
NOT counted against the account, no credentials at all, and an identity mismatch refused before the
directory is touched.

## R24 (sipd half) · Documentation and comments overstate guarantees — **FIXED**

`apps/sipd/README.md` rewritten (358 → 422 lines) against the implementation. What was false and is
now gone: "Today it is a REGISTRAR, plus REFER"; "`sipd` still carries no media and still holds no
call state"; the ❌ rows for the engine seam, outbound originate and `sip.evt.v1` publishing (all
three ship); the gap entries for nonce-count replay tracking, provisioning cache invalidation,
multi-contact AOR on the wire, attended REFER (`attended_unsupported` no longer exists anywhere) and
Call-ID→channel correlation (the engine indexes it); "UDP/TCP today; TLS/WSS next"; "registrar
today, proxying next"; "`sipd` answers 501 to INVITE rather than pretending".

New/corrected: an opening that states what it is (stateful SIP element) and the two things it is
deliberately not (SDP courier, not a negotiator — it never talks to mediad; not a router); a
"Recovery" section covering `sip-dialogs` claims, the `sip-instances` lease, rehydration,
`SweepPredecessor` and the two non-fatal degradations; an honest "Explicitly NOT implemented" table
(no media of any kind, no STUN/TURN/ICE, **no server-sent NAT keepalive**, no REFER subscription
state machine, no proxying); `SIPD_INVITE` re-explained as a deployment prerequisite rather than an
unfinished feature; the missing config rows `SIPD_HEALTH_ADDR` and the three
`SIPD_SUBSCRIBE_*_EXPIRES`, and the note that `SIPD_PPROF_ADDR` now fails at boot; the three build
tags (`integration`, `e2e`, `load`) and `internal/testutil/sipua`; a Layout section covering the
packages that did not exist when it was written (`command`, `reaper`, `lease`, `sipevents`,
`subscribe`, `presence`, `mwi`, `acl`, `metrics`, `siplog`, `testutil/sipua`).

Comment drift fixed in files touched: the `Arrivals` doc (claimed per-message identity it did not
provide); `Set.For` and `localAddrFor`; `nat.Policy.MaxRegistrationInterval`; the `Lockout` doc
(claimed to be shared by "every handler that authenticates" when two did not use it) and the matching
comment in `main.go`; the four `authorize` doc comments.

---

## Additional fixes noticed while in these files

- `authfailure.go` rate-limited the `auth-failed` event on `req.Source()` **with the port**, so a
  spray churning source port defeated the limiter entirely. Now keyed on the source host.
- `Registrar.refresh` and the unused `lockout` fields on `Registrar` and `invite.Handler` removed
  (dead after the gate landed).

## Cross-area needed

- **sipgo `ListenAndServe` race** (upstream, `server.go:102` vs `:123-128`): `main.go` still uses it
  for tcp/ws/tls/wss. Fixing means binding those sockets in `serveUDP`'s style, or bumping sipgo once
  a release carries the fix. Not attempted here.
- **`main.go`** is shared with the other agents; my edits are four small ones (the `registrar` field
  on `inviteDeps` + `TrackNATPolicy`, the `lockout` argument on `newTransferHandler` /
  `newSubscribeHandler`, and one comment).

## Verification (exact final output)

```
apps/sipd $ gofmt -l .            → (no output)
apps/sipd $ go vet ./...          → ok
apps/sipd $ go vet -tags integration ./...   → ok
apps/sipd $ go vet -tags e2e ./...           → ok
apps/sipd $ go vet -tags load ./...          → ok
apps/sipd $ go test -race -count=1 -p 1 ./...
  22 packages ok, 0 failures, 2 with no test files
  (cmd/sipd, acl, aor, command, config, credentials, dialog, invite, kv, lease, metrics, mwi, nat,
   presence, profile, reaper, registrar, sipevents, siplog, subscribe, transfer, trunk)
```

`internal/profile` also run at `-race -count=5` for the rewritten socket test: ok, no races, no
flakes. No probes exist for R07/R16/R17/R24; the new regression tests are the verification, and each
was confirmed to fail against the pre-fix behaviour before the fix was applied.
