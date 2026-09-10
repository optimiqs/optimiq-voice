# GAP2026 — AREA=security-fraud

Branch `feat/optimiq-pbx-phase0`. Nothing committed, staged or stashed.

**Stack state as I finish:** DOWN, and not by me. Another agent stopped the whole stack at 00:34 and
again after 00:40, mid-bring-up. Everything I restarted (sipd three times, mediad once) was healthy
after each of my restarts and is logged in `STACK.md`, and every live proof below was captured while
the stack was up. The broker's permission-violation count was **1009 before and after my SIGHUP**;
it stands at 1013 now, the four having appeared during the other agent's bring-up window, after my
last broker action.

## What already existed (verified before building)

| Claim in the brief      | Reality found                                                                                                                                                                                                                                                                                                                             | Action                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Toll classes            | Exist and are enforced. `TOLL_CLASSES` at `packages/pbx-db/src/schema/extensions-schema.ts:38`; rank + `tollClassCovers` at `packages/routing/src/snapshot.ts:63-82`; the gate is compile-time at `packages/routing/src/compile.ts:1358`, refusing with `TOLL_DENIED_CAUSE = "OUTGOING_CALL_BARRED"` (`compile.ts:202`).                  | Not rebuilt. The new spend/velocity controls sit **beside** it, not on top of it.                            |
| Concurrent-call ceiling | Exists. Org `maxConcurrentCalls` on table `orgLimit`, compiled at `apps/api/src/pbx/routing/snapshot-loader.ts:863` and enforced at Stasis admission in the engine with `SWITCH_CONGESTION`. Per-trunk `maxChannels` likewise.                                                                                                            | Not rebuilt. What was missing is a ceiling scoped to INTERNATIONAL calls, which is what the new policy adds. |
| SIP ACL                 | Exists and is proved live (`E2E-sip.md` #26-#28, `E2E-resilience.md`). CIDR only — no country concept.                                                                                                                                                                                                                                    | Not rebuilt. Geo blocking is added as a separate, country-shaped control.                                    |
| Registration lockout    | **Exists**, contrary to `CAPABILITY-MATRIX.md:182,229` which still calls it the standing gap. `apps/sipd/internal/registrar/lockout.go` + `SIPD_AUTH_LOCKOUT_THRESHOLD` (5 per source+account), `_SOURCE_THRESHOLD` (50), `_BASE` (30s, doubling), `_MAX` (30m), `_WINDOW` (15m), driven from `digest.go`. **Two matrix rows are stale.** | Not rebuilt. The rotation grace hooks into the same gate.                                                    |
| SDES / SRTP policy      | **Exists**, contrary to `CAPABILITY-MATRIX.md:138` which still says `sdp.go` only ever emits `RTP/AVP`. `MEDIAD_SRTP_POLICY` (prefer/require/disable, default `prefer`) and full SDES negotiation are in `apps/mediad/internal/control/srtp.go`; `TestE2ESDESOverTLS` passes live. **The matrix row is stale.**                           | Extended, not rebuilt: the policy was process-wide and is now per-leg.                                       |
| TLS listeners           | Exist (`SIPD_TLS`, `SIPD_WSS`), floor was **TLS 1.2**, one certificate loaded once at boot, no reload, no mTLS anywhere.                                                                                                                                                                                                                  | Rebuilt — see §1.                                                                                            |

## 1. TLS — floor, ciphers, hot reload, mutual TLS

**New package `apps/sipd/internal/siptls`** (`siptls.go`, `watch.go`, `siptls_test.go`).

- `ParseMinVersion` / `MinVersion` — the floor is **TLS 1.3 by default**. `SIPD_TLS_MIN_VERSION=1.2` is
  the only other accepted value, is refused if misspelt, and is logged at **WARN at boot**
  (`SIP TLS is admitting TLS 1.2 for legacy peers`). It applies to the TLS and WSS listeners **and** to
  outbound trunk connections, which previously had no configured TLS at all — `sipgo.NewUA` was built
  without `WithUserAgenTLSConfig`, so a `transport: "tls"` trunk dialled on the library default.
- `modernCipherSuites` / `modernCurves` — forward-secret AEAD suites only (ECDHE + GCM/ChaCha20) and
  X25519-first curve preference. Consulted only when the floor is lowered to 1.2, because Go does not
  let the 1.3 suites be configured; the point is that lowering the floor for one legacy handset does
  **not** re-admit CBC and static-RSA for everyone else. That is asserted by a test.
- `Reloader` — holds the certificate in an `atomic.Pointer[tls.Certificate]` behind the listener's
  `GetCertificate` hook, so **no socket is ever rebound**. `Reload()` is a no-op when size+mtime are
  unchanged, and a half-written or unparsable renewal is **refused with the previous certificate left
  in service**. `Watch(ctx, signals, interval)` reloads on **SIGHUP** and on a **file-change poll**
  (`SIPD_TLS_RELOAD_INTERVAL`, default 30s, `0` disables the poll).
- Mutual TLS for carrier trunks, both directions:
  - inbound — `SIPD_TLS_CLIENT_CA_FILE` makes the listeners ask for a client certificate
    (`VerifyClientCertIfGiven`), `SIPD_TLS_REQUIRE_CLIENT_CERT` promotes that to
    `RequireAndVerifyClientCert`, and `ServerOptions.VerifyPeer` is the seam a per-trunk pin hangs off
    once the chain has verified.
  - outbound — `SIPD_TRUNK_TLS_CERT_FILE`/`_KEY_FILE` is the client certificate this edge presents,
    and `SIPD_TRUNK_TLS_CA_FILE` is the CA **pin** applied in `VerifyConnection` under the SNI name
    dialled, replacing the system roots. A carrier that fails the pin is refused with the trunk named
    in the error.
  - One honest limitation, written into the package doc: `crypto/tls` hands the dialling side only the
    CA list the carrier asked for (RFC 8446 §4.4.2.1), never the destination, so per-trunk **client
    certificate** selection is by issuer (`SupportsCertificate`), not by trunk id. The per-trunk
    **pin** is by SNI and is exact.

Config (`apps/sipd/internal/config/config.go`) gained six variables with the file's existing
accumulate-and-fail-once validation: a client CA without a TLS listener, requiring a client certificate
with no CA to verify it against, and half a trunk client-certificate pair are all boot failures.
`apps/sipd/README.md`'s variable table documents all six.

**Tests — real TLS sockets, not mocks** (`internal/siptls/siptls_test.go`, a throwaway CA issuing real
leaves): TLS 1.2 refused by a 1.3 listener and 1.3 admitted; 1.2 admitted when the floor is lowered
_and_ the negotiated suite asserted to be forward-secret AEAD; the certificate swapped on a live
listener with a different serial served afterwards and the second reload a no-op; a truncated renewal
leaving the previous certificate in service; mutual TLS admitting a pinned carrier (with the subject
seen by `VerifyPeer`) and refusing both an anonymous client and one signed by another CA; the client
config offering its certificate and refusing a carrier that fails its pin, with the trunk named;
`LoadCAs` refusing an empty and a missing bundle; and `Watch` reloading on a signal and returning on
cancellation. `internal/config/config_test.go` gained the floor default/validation and the three
mutual-TLS coherence failures.

## 2. SRTP by default, per leg

`MEDIAD_SRTP_POLICY` already defaulted to `prefer`; it is now **documented** in a new
`apps/mediad/README.md` with a per-value matrix for inbound offers versus originated offers.

- **Per-leg override.** `srtpPolicy` (`prefer` | `require` | `disable`) is now an optional field on
  `rpc.media.v1.allocate-session`, `create-offer` and `accept-answer`. Absent means "use the
  process-wide policy", which is byte-for-byte what every existing caller gets — there is a
  six-subtest regression guard for exactly that. `acceptsProtocol`/`negotiateSDES`/`offerSDES` became
  free functions taking the resolved policy instead of reading `Server.srtpPolicy`.
- **Encryption state per leg.** `mediaEncryption` (`encrypted` | `plaintext`) is now on the success
  reply of those same three commands. It is derived from the SRTP context that was actually
  **installed** (`Local.IsSet() && !Pending`), not from the configured policy, so it is a fact about
  the leg rather than an intention — which is what a lock icon has to be. A B-leg reads `plaintext`
  between create-offer and accept-answer even under `require`. The WebRTC paths hard-set `encrypted`,
  DTLS-SRTP being mandatory there.
- **Per-trunk policy** (the coordinator's addition), end to end and additive:
  `trunk.srtp_policy` (nullable text, `TRUNK_SRTP_POLICIES = ["none","prefer","require"]`) →
  `createTrunkDto.srtpPolicy` → `TrunkDirectoryRow`/`projectTrunkDirectoryEntry` →
  `trunkDirectoryEntrySchema.srtpPolicy` → regenerated `packages/events-go` →
  `trunk.Config.SRTPPolicy` in sipd. NULL/absent means "the media plane decides", which is what every
  trunk written before the column existed means.
- **Contract**, in `packages/events/src/schemas/rpc.ts` and regenerated into
  `packages/events-go/rpc_gen.go`. Both new fields are `.optional()`, so the change is additive and
  the codegen is idempotent.

## 3. Toll fraud — the engine's enforcement seam

`apps/engine/src/routing` is the half I own; the policy, the counters, the detector and the CRUD are
in `apps/api` and are reported in §3b.

**New `apps/engine/src/routing/toll-fraud-guard.ts`** — `TollFraudGuardPort.authorize({
organizationId, extensionNumber?, dialedNumber, now }) => { kind: "allow" } | { kind: "refuse",
reason, detail }`, plus `TOLL_FRAUD_REFUSAL_CAUSE = "OUTGOING_CALL_BARRED"`.

Three decisions worth naming:

- **It is a port, not a function.** The ceilings come off the compiled artifact, the rolling counters
  out of `shared_rate_window`, and the "have we called this country before" fact is a row the same
  call is about to write. Only the middle third is pure, so the walker's dependency is "something
  that can answer this question" — which is what lets a spec answer it with a literal.
- **The cause is the one the toll-class gate already uses.** `OUTGOING_CALL_BARRED` (Q.850 21) is
  what `packages/routing`'s `TOLL_DENIED_CAUSE` carries. Both are "this caller may not reach this
  destination"; two causes would split one condition across two rows of every report. The _named_
  reason (`DESTINATION_COUNTRY_BLOCKED`, `INTERNATIONAL_MINUTES_EXCEEDED`, …) travels beside it — in
  the walk notes, the log and the fraud signal — because "call barred" alone cannot tell a tenant
  the difference between a limit that clears in an hour and one that never does.
- **It runs ahead of the outbound-PIN prompt**, in `plan-walker.ts`'s `trunkDialNode`, which is
  already ahead of the first INVITE and of `ringing`. A call the organization has decided it will not
  place should be refused without first making the caller key a code for it. A refusal takes the
  route's own `failoverNodeId` when it has one, and hangs up with the cause when it does not.
- **Absent port is today's behaviour, exactly.** That is asserted, not assumed.

Three specs in `plan-walker.spec.ts`: the refusal (nothing originated, cause and named detail
present, and the guard asked with the right org/extension/number), the failover branch, and the
allow + no-port arms.

**The implementation** is `apps/engine/src/routing/toll-fraud-guard.source.ts` —
`TollFraudGuardRpcPort`, asking the API over `rpc.pbx.v1.authorize-outbound` (contract
`AUTHORIZE_OUTBOUND_RPC` in `packages/events/src/schemas/rpc.ts`, 400 ms). Registered in
`routing.module.ts` as a provider and an export.

It **fails open**, and that is the one decision here to argue with: a timeout, a missing responder
and a malformed reply all allow the call. The failure being guarded against is a database that is
unwell, and an API outage that also barred every international call for every tenant would convert a
degraded control plane into a total outbound outage — strictly worse than the incident this gate
makes less likely. The overshoot is bounded rather than exploitable: the responder is what increments
the counters, so a call allowed by a failure is one the ceiling never counted, and a responder that
is answering is a responder that is counting. Six specs in `toll-fraud-guard.source.spec.ts`,
including a reason the engine has never heard of (the schema takes a plain string on purpose, so a
newer responder cannot have its refusal dropped into a fail-open allow).

**`config/nats.conf`** gained ONE subject in two grant lists — `rpc.pbx.v1.authorize-outbound`,
published by `engine`, subscribed by `api` — named individually rather than folded into a wildcard,
following the file's existing rule. Validated with the stack's own binary and applied with `kill
-HUP`: `Reloaded: authorization users` / `Reloaded: accounts`, the reloaded sha matching the
validated one, and **zero new permission violations** (1009 before, 1009 after). A copy of the file
as it was is at `<this dir>/nats.conf.before-security-fraud`.

**Not wired at the composition root.** `PlanWalkerDependencies` is assembled in
`apps/engine/src/calls/channel-orchestrator.service.ts`, which belongs to another agent this pass, so
the port is registered and unused. See "Cross-area needed" for the one-line change.

## 3b. Toll-fraud policy, anomaly detection and credential hygiene (apps/api)

**Policy and counters.** Three new pbx-db tables plus a generic counter, all additive and migrated
under the lock (`20260910050318_pbx_toll_fraud_controls` + `…050319_…_grants`, applied to the local
database):

- `toll_fraud_policy` — per org: `enabled`, `max_concurrent_international_calls`,
  `max_international_minutes_per_hour`, `max_international_minutes_per_day`, `allowed_countries`
  and `denied_countries` (jsonb, ISO-3166 alpha-2), `hold_first_call_to_new_country`,
  `off_hours_international_lock`, `off_hours_start_minute` (1200), `off_hours_end_minute` (420),
  `off_hours_timezone`, `auto_suspend_on_signal`.
- `extension_toll_fraud_override` — the same fields with NULL meaning _inherit_ and `0` meaning _no
  ceiling_, plus `outbound_suspended` / `suspended_reason` / `suspended_at`. An override may only
  LOOSEN what the org set — `mergeTollFraudPolicy` enforces that.
- `toll_fraud_country_seen` — what backs the first-call-to-a-new-country hold.
- `shared_rate_window` — the generic shared counter: `(organization_id, scope, key, window_start)`
  unique, incremented by a single `INSERT … ON CONFLICT DO UPDATE SET count = count + excluded.count
RETURNING count`. Atomic, no read-modify-write, and it QUEUES on the row lock rather than retrying
  — which is why it beat NATS KV, whose compare-and-set retry rate rises with exactly the traffic
  the counter exists to limit. `rolling()` reads the previous window weighted by elapsed fraction, so
  a fixed-window boundary cannot be spent twice.

**The decision** is `evaluateTollFraud` in `toll-fraud.policy.ts`, pure and table-tested, over
`e164-country.ts` — a hand-rolled longest-prefix E.164→ISO table with no new dependency, NANP split
by area code. Two choices worth naming: an **unresolvable** prefix is treated as INTERNATIONAL (a
global network, a satellite range or an audiotext code is the exact shape of a revenue-share fraud
number, and calling it domestic would put the highest-risk category outside every control), while a
number that is not E.164 at all — an extension, a feature code — is not international and is
allowed, because those never reach a carrier.

**Refusal reasons** (exact): `DESTINATION_COUNTRY_BLOCKED`, `OFF_HOURS_INTERNATIONAL_LOCK`,
`NEW_COUNTRY_HOLD`, `INTERNATIONAL_CONCURRENCY_EXCEEDED`, `INTERNATIONAL_MINUTES_EXCEEDED`,
`EXTENSION_OUTBOUND_SUSPENDED`.

**Anomaly detector** — `FraudAnomalyDetector`, hourly, `unref`'d, re-entrancy refused. Four findings
over the last hour: international-minutes spike (the tenant's own ceiling wins, else a 300-minute
floor), calls to high-risk prefixes, a short-call burst (≥12 legs with ≥60% under 20s to one
destination), and registrations from ≥6 distinct source IPs for one account (from `sip_auth_event`,
not CDR). Each emits the event, writes an audit row, and auto-suspends the extension's outbound only
when the org's `auto_suspend_on_signal` says so. CDR is reached through a port so the PBX area keeps
no cdr-db dependency. Tested against synthetic rows.

**The event**, additive: a new `security` webhook family —
`security.evt.v1.<orgId>.<subjectRef>.fraud-signal`, `subjectRef` being an extension id or `_org`,
on a new `SECURITY` stream with durable `pbx-webhook-security`.

**Credential hygiene** — `POST /api/v1/sip-credentials/extensions/:id/rotate`,
`…/device-lines/:id/rotate` and `…/extensions/:id/secret`. The grace stores the OLD `secretRef` plus
an expiry; while it holds, the credential reply carries `ha1Previous` **and is marked uncacheable**,
which is what lets the window actually close. Weak secrets are refused on a manual set (12 chars,
three of four character classes, a deny list with trailing-digit normalisation, repeated and
sequential runs).

**Permissions**: `toll-fraud.read`, `toll-fraud.write`, `security.rotate-credentials`.

**UI** (`apps/web`) — a new `fraud-controls` tab on the existing `/security` screen (chosen over
`settings/security` because the policy is its own table with its own grant, not an org-settings
category, and because the auth-failure log beside it is how you learn a credential leaked; this is
where you cap what the leak spends). A usage panel sits above the form, since a ceiling without the
current number beside it is unactionable. Country lists are a chip input over the 228 codes the API's
resolver can actually produce — not the full ISO list, which the API would refuse. The per-extension
override is a tri-state `inherit/on/off` section on the extension dialog, edit-only, and an untouched
extension sends nothing. Rotation is a dialog on the extensions row menu that states the grace
deadline in plain words and does **not** fake a copy-it-once secret — the password is derived from a
handle, so there is nothing to show. Its weak-secret rules mirror the server's file rule for rule.
22 web tests.

## Live proof

Captured against the running stack, sipd rebuilt from this tree.

**Baseline, before the change** — TLS 1.2 was accepted on 5161:

```
$ echo Q | openssl s_client -connect 127.0.0.1:5161 -tls1_2
New, TLSv1.2, Cipher is ECDHE-RSA-AES128-GCM-SHA256
```

**1. TLS 1.2 refused when the floor is 1.3.** sipd logs `SIP TLS floor minVersion=1.3` at boot, then:

```
$ echo Q | openssl s_client -connect 127.0.0.1:5161 -tls1_2
ssl3_read_bytes:tlsv1 alert protocol version:SSL alert number 70
New, (NONE), Cipher is (NONE)
$ echo Q | openssl s_client -connect 127.0.0.1:5161 -tls1_3
Protocol  : TLSv1.3   Cipher    : TLS_AES_128_GCM_SHA256
```

**2. Mutual TLS with the fake carrier.** With `SIPD_TLS_CLIENT_CA_FILE` pointing at a throwaway
`optimiq-carrier-ca`, sipd logs `SIP TLS accepts carrier client certificates … required=false` and the
handshake now carries a CertificateRequest naming that CA:

```
Acceptable client certificate CA names
CN=optimiq-carrier-ca
```

Three probes, each sending a real SIP OPTIONS over the completed connection:

```
pinned    HANDSHAKE-OK TLSv1.3 | first line: SIP/2.0 200 OK
rogue     REFUSED: SSLError [SSL: TLSV1_ALERT_UNKNOWN_CA] tlsv1 alert unknown ca
anonymous HANDSHAKE-OK TLSv1.3 | first line: SIP/2.0 200 OK
```

The anonymous arm is the point of `VerifyClientCertIfGiven`: turning mutual TLS on for carriers did
not lock the tenant's handsets out of the same listener.

**3. Certificate reload without dropping anything.** A TLS connection is opened and used, the PEM pair
is replaced in place, `SIGHUP` is sent, and then both connections are exercised:

```
held connection : cert d7d8c1efc80ca8ee | SIP/2.0 200 OK
new  connection : cert 08856a1f2c8f7fd8 | SIP/2.0 200 OK      <- the renewed certificate
held STILL WORKS: SIP/2.0 200 OK                              <- not dropped
same pid alive  : 86171 True                                  <- no restart
```

sipd logged `SIP TLS certificate reloaded trigger=signal`. No socket was rebound, so no registration
or dialog bound to a TLS/WSS connection was disturbed — which is the claim an ACME renewal needs.

**4. Per-leg SRTP, against the running mediad.** The process-wide policy on this stack is the default
`prefer`, so a plain offer is normally answered in plain RTP. Four `rpc.media.v1.allocate-session`
calls, differing only in the new field (`<scratchpad>/e2e/srtp-leg-probe.mjs`):

```
no policy, plain offer     ok=true  reason=-              mediaEncryption=plaintext  answer m=audio 32000 RTP/AVP 0 101
leg require, plain offer   ok=false reason=not_supported  err=unsupported audio transport: RTP/AVP
leg require, SAVP offer    ok=true  reason=-              mediaEncryption=encrypted  answer m=audio 32002 RTP/SAVP 0 101
leg disable, SAVP offer    ok=false reason=not_supported  err=unsupported audio transport: RTP/SAVP
```

Row 1 is the additive guarantee: with the field absent the answer is exactly what it was before. Rows
2 and 4 show the per-leg policy overriding the process-wide one in both directions, and row 3 is the
`encrypted` state a lock icon renders from.

**5. The live SIP suite still passes on the 1.3-only edge.** `apps/sipd` e2e against the running
stack: **12 PASS / 0 FAIL** of the runnable scenarios, including `TestE2ERegisterTransports` (which
registers over UDP, TCP **and TLS**), `TestE2ESDESOverTLS`, `TestE2EPhoneToPhoneCall`,
`TestE2EMalformedSIP`, `TestE2ERegistrationLimit` and `TestE2ETrunkACLRefusesUnknownDID`. The rest
skipped for want of their own fixtures, as they do on this stack normally.

## The coordinator's three additions

1. **Shared-state velocity counters.** `apps/api/src/pbx/calls/originate-rate-limit.ts` held its
   counters in this process's heap and said so — "three API replicas allow three times the configured
   rate". For a limiter whose stated job is to bound MONEY, a ceiling an operator multiplies every
   time they scale out is not a limitation to document, it is a defect. It now counts through
   `SharedRateWindowService` into `shared_rate_window`, one row per organization per minute under the
   row lock, so the ceiling means the same thing at any replica count. It **fails open** on a store
   error, for the reason above. `calls.service.ts` awaits it. Five specs, including a two-limiter arm
   that is explicitly "two API processes behind a load balancer" and would have passed twice the
   ceiling before.
2. **Per-trunk SRTP policy** — done, see §2.
3. **The migration lock** — observed. `packages/pbx-db` was generated under
   `<scratchpad>/e2e/MIGRATION-LOCK-pbx-db`; my `trunk.srtp_policy` column was in fact swept into the
   toll-fraud pack's migration (`20260910050318_pbx_toll_fraud_controls/migration.sql`, `ALTER TABLE
"trunk" ADD COLUMN "srtp_policy" text;`) because the schema file was already on disk when they ran
   generate. Verified live against the database rather than taken on trust:
   `select column_name, data_type, is_nullable … → srtp_policy | text | YES`. No journal was edited.

## 5b. The rotation grace, honoured on the edge (apps/sipd)

The api side of rotation is above; without the edge it is a control-plane fact only. `apps/sipd` now
honours it:

- `credentials.Credential.HA1Previous` — the digest of the pre-rotation secret, carried off
  `ha1Previous` on the credential reply and empty in the ordinary case.
- `registrar/digest.go` — when the current digest fails, the grace digest is tried **before** the
  existing stale-credential re-ask, because it costs nothing and answers the same question. An accept
  through the grace clears the lockout counter exactly as a normal accept does. All four methods
  (REGISTER, INVITE, SUBSCRIBE, REFER), not just REGISTER.
- `credentials/nats.go` — **a credential in its grace is NOT cached.** The window is minutes and only
  the api knows when it closes, so caching would keep the retired secret working for a whole positive
  TTL past the deadline the operator chose — the one property a grace must not have. The cost is one
  RPC per REGISTER for one account for a few minutes.

Five tests: the grace accepted for every method with no re-ask and no lockout, the old secret refused
once the api stops sending it, the current secret unaffected while a grace is open, the no-cache rule
(three lookups, three requests, empty cache), and the wire mapping in both directions.

## Not done, and why

- **The engine's use of the new per-leg SRTP policy and encryption state.** `apps/engine/src/calls`
  and `src/media` belong to other agents in this pass, so the contract is in place and unused: nothing
  yet passes `srtpPolicy` from a trunk row into `allocate-session`, and nothing yet carries
  `mediaEncryption` onto the channel snapshot. See "Cross-area needed".
- **`requireSrtpForTlsPhones`** is declared in the org-settings catalog (default `false` — turning it
  on refuses calls for handsets that speak no SRTP, so it must be an explicit tenant decision) and is
  **not consumed**. Deliberately not folded into `CompiledRoutingSettings`: an artifact field with no
  reader is a snapshot-hash change for every tenant in exchange for nothing.
- **`TollFraudGuardPort` is not handed to the walker** at the composition root, for the same
  ownership reason — one line, listed below.
- **Live proof of the toll-fraud refusal on a softphone, and of the fraud-signal webhook delivery.**
  Both need the api and the engine running against the new contract. The stack was torn down and is
  being brought back up by another agent while I write this (engine, api and web still stopped), so
  those two proofs are the ones I could not capture. Everything they depend on is proved at the unit
  and contract level, and the two commands to run are given below.

## Verification, final

| Area               | Command                                                      | Result                                                     |
| ------------------ | ------------------------------------------------------------ | ---------------------------------------------------------- |
| sipd               | `gofmt -l . && go vet ./... && go test -race -count=1 ./...` | clean / clean / **23 ok, 0 FAIL**                          |
| sipd (live)        | e2e suite, `-tags e2e`, against the running stack            | **12 PASS, 0 FAIL**, rest skipped                          |
| mediad             | `gofmt -l . && go vet ./... && go test -race -count=1 ./...` | clean / clean / all ok, **739 PASS, 0 FAIL**               |
| engine             | `typecheck`, `bun test src`                                  | clean / **2001 pass, 12 skip, 0 fail**                     |
| engine (mine)      | `bun test src/routing`                                       | **669 pass, 3 skip, 0 fail**                               |
| api                | `typecheck`, `test`, `check:di`                              | 1 error / **1754 passing, 1 failing** / clean, 216 classes |
| packages/events    | `typecheck`, `test`                                          | clean / **437 pass, 0 fail**                               |
| packages/events-go | `go build ./...`                                             | green                                                      |
| pbx-db / auth      | `test`                                                       | **117/0** / **243/0**                                      |
| web                | `typecheck`, `test`, `codegen:check`                         | 1 error / **979 pass, 12 fail** / up to date               |
| lint/format        | `oxlint` + `oxfmt` on every directory touched                | clean                                                      |

**Failures that are NOT this area's, each verified rather than assumed:**

- `packages/events-go` `go test` — 2 parity failures, both the **messaging** pack's: the generated
  golden carries `messaging:messaging.evt.v1` (from their `subjects.ts` edit) while the hand-written
  `subjects.go`/`streams.go` do not. `security` is present on both sides.
- api `webhookSelectors.test.ts:123` — the same `messaging` family missing from the unserved list.
- api typecheck — `packages/events/src/validate.ts(208,16)`, `ValidateEventResult` no longer narrowing
  on its boolean discriminant now that a twelfth event family exists. Proved not ours by removing the
  `security` family and re-running: the error stays.
- web — 12 `queueFormSchema`/`optionalReference` failures in `lib/pbx/schemas.spec.ts` and one type
  error in `lib/cdr/reporting.ts`, none of them in any file this area touched.
- `permissions.generated.ts` picked up 103 lines of another pack's `messaging.*`/`compliance.*`
  strings when web codegen was re-run. Codegen was instructed and `codegen:check` is green; the
  widened diff is noted rather than hidden.

## Cross-area needed

0. **`apps/engine/src/calls/channel-orchestrator.service.ts`** — hand the guard to the walker. One
   line beside `trunkCapacity` where `PlanWalkerDependencies` is assembled (~`:2983`):
   `tollFraudGuard: this.tollFraudGuard,` with `TollFraudGuardRpcPort` injected. It is exported from
   `RoutingModule`. Until then the gate is registered and unused, and outbound behaves exactly as it
   did before.
1. **`apps/engine/src/media/mediad-media.port.ts` and the split-plane port** — pass `srtpPolicy`
   through on allocate-session / create-offer / accept-answer (omit it to keep today's behaviour), and
   read `mediaEncryption` off the reply.
2. **`packages/telephony/src/channel.ts`** — add one member to `CHANNEL_FLAGS` (e.g. `encrypted`) and
   have `apps/engine/src/calls/channel-aggregate.ts` set it from the `mediaEncryption` above. The wire
   schema (`liveChannelSchema.flags` is `z.array(z.string())`) and the web store need no change; only
   the UI that labels flags does.
3. **`packages/routing` compile + `apps/engine/src/routing`** — the outbound trunk row's `srtpPolicy`
   has to reach the compiled `TrunkDialPlanNode`'s trunk attempt and then the media port; today it
   stops at `trunk.Config.SRTPPolicy` in sipd and at the KV entry.
4. **`packages/events-go`'s hand-written `subjects.go` / `streams.go` / `parity_test.go`** — the
   `messaging` family and `pbxQueueDisposition`/`pbxQueueSurvey`, by their owner. `go test` there is
   red for that reason alone.
5. **`packages/events/src/validate.ts`** — `ValidateEventResult` needs flattening (or an explicit
   discriminant) now that twelve families defeat TS's narrowing. It is a public type in a shared
   package; changing it mid-flight would be worse than flagging it.

## The two live proofs still owed

Both need api + engine up against this tree, which they were not while this was written:

```sh
# a geo-blocked destination refused on the softphone with the named cause
#   PUT /api/v1/toll-fraud/policy {"enabled":true,"deniedCountries":["RU"]}
#   then dial +79001234567 from a browser softphone in that org and expect
#   OUTGOING_CALL_BARRED with DESTINATION_COUNTRY_BLOCKED in the engine's walk notes.

# the fraud-signal webhook delivered on a synthetic spike
#   insert an hour of synthetic international call_legs for the org, run the detector,
#   and expect one delivery on security.evt.v1.<org>.<ref>.fraud-signal to a subscribed endpoint.
```
