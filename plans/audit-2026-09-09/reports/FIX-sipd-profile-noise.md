# FIX — sipd profile selection + log noise

Area: `apps/sipd/internal/profile`, `apps/sipd/internal/siplog` (new), the SIP parse/log sites, the
registrar/invite/command log lines. Nothing in `internal/dialog`, `internal/registrar` liveness or
`apps/engine` was touched. Nothing committed. **sipd was NOT restarted.**

---

## 1 — P0: profile selection fell back to the SENDER's address (FIXED)

### What was actually wrong — the audit was right, and it was worse than it said

`E2E-resilience.md` says sipgo never sets `Destination()` on an inbound request, so the listener fast
path in `profile.Set.For` was dead and selection always fell through to matching the SOURCE address
against each external profile's ACL.

That is true, and there is a second half the audit did not have. `Request.Destination()`
(`sipgo@v1.4.3/sip/request.go:207`) is **never empty**: when nothing set the field it falls back to
the Route header and then to the **Request-URI**, i.e. to text the SENDER wrote. So the "only
selector the sender cannot influence" was, in production, entirely sender-supplied. Anything that
trusts `req.Destination()` on an inbound message is trusting the attacker.

Proved, not inferred: `internal/profile/arrivals_transport_test.go` stands up a real sipgo server on
two loopback UDP listeners — internal on one, external (ACL `127.0.0.1/32` allow) on the other — and
sends the same OPTIONS from the same source to each. With the fix disabled, the datagram that landed
on the **internal** listener is classified `external`:

```
arrivals_transport_test.go:72: a datagram on the internal listener chose "external",
                               want the internal profile
```

With the fix, both land where they arrived.

### The fix

- **`internal/profile/arrivals.go` (new)** — `Arrivals`, a bounded, concurrency-safe table of
  `transport/peer → local listener address`, filled from sipgo's `TransportReadFilter`
  (`sip.WithTransportLayerReadFilter`). The filter runs on the reading goroutine immediately before
  the bytes are parsed and the message is handed to the handler (`sip/transport_udp.go:161`,
  `sip/transport_tcp.go:186`, `sip/transport_ws.go:218` — tls and wss go through the tcp/ws readers),
  so the entry a handler reads back is the one written for the message it is holding. It never
  inspects or rewrites the bytes. Bounded by two generations of `DefaultArrivalCapacity` (4096); the
  older is dropped whole, so churn of one-shot peers cannot grow it.
- **`internal/profile/profile.go`** —
  - `Set` gains `byPort` (`transport/port → profile`, `-1` when ambiguous) so a listener configured
    as `:5160` still matches a kernel-reported `0.0.0.0:5160`, and `arrivals`, attached by
    `TrackArrivals`.
  - `localAddrFor` reads the destination off the **embedded `MessageData`** and never off
    `req.Destination()` — that is the Request-URI fallback described above. In practice the address
    therefore comes from the arrivals table.
  - `For` selects by listener (exact, then port) and returns there; the source-ACL step now **skips
    any external profile that owns listeners** once the arrival socket is known. A listener-less
    external profile still matches by source, always — the default carrier configuration keeps
    working, which is the earlier fix the brief asked me to preserve.
- **`cmd/sipd/main.go`** — an `Arrivals` is built before the UA, installed as the transport read
  filter, and attached to the profile set in `newInviteHandler`.

### The residual hole, and the boot warning for it

When `SIPD_EXTERNAL_LISTEN_ADDR` is empty the external profile owns **no socket** and shares the
internal one. A carrier and a phone then arrive on the same listener, so the listener separates
nothing and the source ACL is the only discriminator left — the hole is a property of that
configuration, not of `For`. Making the internal profile win there would refuse every carrier, which
is exactly the regression the earlier fix repaired.

So `buildProfiles` now logs it **once at boot**, actionable and named:

> the external profile has no listener of its own; a trunk ACL entry will claim matching sources on
> the internal socket too. Set SIPD_EXTERNAL_LISTEN_ADDR to make the listener the trust boundary.

The local stack sets it (external udp/tcp 5162), so the stack itself is covered by the fix.

One existing assertion was **wrong and was changed**: `TestSetForSelectsAListenerlessExternalProfileBySource`
asserted "the local address still wins" for a listener-less external profile. That only ever held for
an explicitly stamped destination, which nothing inbound sets; in the shared configuration the source
must win or carriers break. The test now asserts that, with the reason and a pointer to the
listener-bound test.

### Tests

`internal/profile/arrivals_test.go` (new): key shape, transport in the key, bounded eviction, the
read filter passing bytes through unchanged, a nil table inert.
`internal/profile/arrivals_transport_test.go` (new): the real-socket proof above.
`internal/profile/profile_test.go`: `TestSetForPrefersTheArrivalListenerOverTheSourceACL` (internal
phone on the shared socket **with a matching trunk ACL entry** is still the internal profile and
still `AuthDigest`, on both udp and tcp; the carrier on the external listener is still admitted with
`ContextUntrusted`), `TestSetForFallsBackToTheListenerPort`,
`TestSetForStillAdmitsAListenerlessCarrierWithArrivalsInPlace`.

### The e2e trunk test was NOT run

`e2e_trunk_test.go` drives the **running** sipd, which predates this change and which I am not
allowed to restart, so it could only have exercised the old binary. Unit + real-socket integration
only. Listed under needs-restart below.

---

## 2 — Log noise: 7.2 WARN+ lines per call → zero on a healthy call

### The four biggest offenders are sipgo's, not sipd's

`failed to parse`, `ACK missed`, `WS ref went negative` and `TCP ref went negative` are all logged by
the library, at levels it chooses. They reach the process through `sip.DefaultLogger()`, which sipd
was implicitly handing its own handler via `slog.SetDefault`. So they are filtered where they enter:

**`internal/siplog` (new)** — an `slog.Handler` wrapper installed with `sip.SetDefaultLogger`:

| sipgo message                                   | was                            | now                                                                         | why                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed to parse`                               | ERROR **with the raw payload** | DEBUG, payload replaced by `bytes=<n> head=<hex of first 32>`, rate limited | the sender chose the level, the volume and the content                                                                                                                                                                                              |
| `ACK missed`                                    | WARN, one per answered call    | DEBUG                                                                       | the 2xx ACK is its own transaction (RFC 3261 §13.2.2.4) and this edge takes it on `server.OnAck`, so the INVITE transaction's ack channel is deliberately never drained — `sip/transaction_server_tx.go:138` fires on every answered call by design |
| `WS ref went negative`, `TCP ref went negative` | WARN                           | DEBUG                                                                       | sipgo's own connection refcounting, which sipd does not drive                                                                                                                                                                                       |

Rate limit: 5 records per minute per message, with `suppressedSinceLast` on the next one through, and
the key table cleared at 1024 entries. Anything with no rule passes through untouched.

**The per-source part of the rate limit is not possible without an upstream change, and I did not
fake it.** sipgo's parse-failure records carry no peer: `sip/transport_udp.go:228` logs only `data`
and `error`, and `sip/transport_tcp.go:237` the same, even though both have the address in hand a few
lines up. Pre-filtering the datagrams myself in the read filter would not help either — the 600
records on this stack are the malformed-SIP e2e case, i.e. **well-formed start lines** with bad CSeq
or truncated bodies, which no cheap sanity check separates from real traffic. The security half (raw
attacker bytes at ERROR) is fully closed; the limit is per-message-per-process. Upstream fix: add
`raddr` to those two log calls. See "Cross-area / upstream" below.

### The sipd-side lines

- **`internal/command/handlers.go`** — new `levelFor(reason)`: the refusals a healthy platform
  produces on its own (`unknown_dialog`, `dialog_gone`, `invalid_state`, `unregistered_target`,
  `no_route`, `shutting_down`) are INFO; `internal`, `bad_request`, `unknown_trunk`, `capacity` stay
  WARN. `refusing an originate` uses it. `refusing a hangup` uses it too, except that
  `unknown_dialog` drops to DEBUG — a hangup for a leg this edge never established is the **echo** of
  the originate refusal that immediately preceded it and says nothing new. Net: a stale WS binding
  costs **one INFO** where it cost 286 + 282 WARN.
- **`internal/invite/originate.go`** — `cannot re-index an outbound dialog on its remote tag` is
  DEBUG when the error is `dialog.ErrUnknownDialog` (a 200 racing a CANCEL or a hangup that landed
  first; there is nothing left to re-index) and stays WARN otherwise. 59 lines on this stack, all of
  them `dialog: no such dialog`.

### Deliberately left alone (genuinely actionable)

`cannot send a response` (41, "size of packet larger than MTU" — the fuzz case, and a real limit),
`SIP teardown did not receive a final response` (20), `ignoring an invalid trunk record`,
`cannot re-establish the presence watch`, `cannot publish a dialog event for a leg with no tenant`,
`refusing an INVITE from a source outside the trunk ACL`, the two boot warnings. None fires on a
healthy call.

### Result

On a healthy call the remaining WARN+ sources are all silent, and
`TestTheFilteredMessagesLeaveNothingAtInfo` asserts exactly that: the four sipgo messages produce
**zero bytes** at the default level. `TestAStaleBindingLeavesNoWarning` asserts the same for the
command path end to end.

### Tests

`internal/siplog/siplog_test.go` (new, 7 tests): downgrade + redaction (the excerpt is bounded and
contains neither `REGISTER` nor the planted secret), silence at INFO, pass-through for unruled
messages, the burst cap, the `suppressedSinceLast` count, the bounded key table, and shared limiter
across `WithAttrs`/`WithGroup`.
`internal/command/command_test.go`: `TestARefusalIsOnlyLoudWhenSomebodyCanActOnIt` (the level table)
and `TestAStaleBindingLeavesNoWarning`.

---

## Additional bugs found in files I touched

1. **`req.Destination()` is sender-controlled on inbound messages.** Written up above. sipd's only
   use was the profile fast path; it is gone. Worth grepping other services if any adopt sipgo.

## Cross-area / upstream needed

- **sipgo (vendored dependency, not this repo):** `sip/transport_udp.go:228` and
  `sip/transport_tcp.go:237` should log `raddr` on a parse failure, and should not log `data` at all.
  Until then a per-source parse-failure rate limit cannot be built from the record.
- **`apps/engine`:** `the sip edge refused a dialog command` — 571 lines, 2.37/call, the engine-side
  echo of the two sipd refusals now demoted here. It should take the same view of the expected
  reasons (`unknown_dialog`, `no_route`, `unregistered_target`, `dialog_gone`), or the pair stays
  three log lines for one fact across two services. Not mine.

## Needs a sipd restart to take effect

Everything above. Specifically, after a restart re-run:

- `TestE2ETrunkInboundDID` and `TestE2ETrunkACLRefusesUnknownDID` (with an ACL entry restored) —
  the carrier on the external listener 5162 must still be admitted.
- An internal 1601→1602 call **while a trunk ACL entry covers 127.0.0.1** — this is the scenario that
  broke before, and it must now be challenged on the internal profile and complete.
- A WARN+ line count over a smoke call: expect zero.
- Boot log: with `SIPD_EXTERNAL_LISTEN_ADDR` set (as the local stack does) the new listener warning
  must NOT appear.

## Verification

Run in `apps/sipd`, all clean:

```
gofmt -l .                    -> (no output)
go vet ./...                  -> ok
go vet -tags e2e ./...        -> ok
go vet -tags integration ./...-> ok
go test -race ./...           -> 20 packages ok, 0 fail, 3 [no test files]
```

Packages: acl, aor, cmd/sipd, command, config, credentials, dialog, invite, kv, lease, mwi, nat,
presence, profile, reaper, registrar, siplog, subscribe, transfer, trunk — all `ok`.
`events`, `sipevents`, `testutil/sipua` have no test files.

Note: `cmd/sipd/main.go`, `internal/lease` and the registrar files are being edited concurrently by
another agent; the tree compiled and the full suite passed at the moment of this run.
