# E2E — AREA `sip` (non-browser SIP endpoints and the carrier edge)

Run against the standing local stack (STACK.md), 2026-09-09, HEAD `32b8499` + the fixes below.
Nothing was restarted. Artifacts: `<scratchpad>/e2e/artifacts/sip/`.

## What was built

A reusable SIP user agent for tests, in the sipd module, modelled on the `load_*_test.go` harness:

- `apps/sipd/internal/testutil/sipua/sipua.go` — UDP / TCP / TLS transport, digest, REGISTER with
  every knob the scenarios need (expiry, wrong password, foreign realm, un-REGISTER, raw bytes).
- `apps/sipd/internal/testutil/sipua/dialog.go` — INVITE (blocking and async), ACK, re-INVITE,
  BYE, CANCEL, inbound INVITE + responses, SDP helpers.
- `apps/sipd/internal/testutil/sipua/rtp.go` — an RTP endpoint that sends paced 20 ms G.711 frames
  and RFC 4733 events and measures what it receives (packets, per-payload-type counts, µ-law
  energy, SSRCs, sequence gaps, DTMF events). No new dependency; the µ-law codec is inline.

Scenarios live in `apps/sipd/e2e_*_test.go` behind `//go:build e2e` and `SIPD_E2E=1`, so neither
`go test ./...` nor the `integration` or `load` suites ever start them:

```sh
cd apps/sipd
SIPD_E2E=1 SIPD_E2E_PASS_1601=… SIPD_E2E_PASS_1602=… SIPD_E2E_PASS_1603=… \
  go test -tags e2e -run TestE2E -timeout 15m -v .
```

The browser leg is driven by `<scratchpad>/e2e/artifacts/sip/browser-leg.mjs` (Playwright, tone
instead of a microphone, `getStats()` for audio), the way `.scripts/local-stack/smoke-call.mjs` does.

Fixtures created (extensions 1601/1602/1603 in the realm-owning organization, plus my own
organization `01a08714-4235-70a9-8a48-7b9ce30adae1` for the tenant-isolation checks):
`setup.mjs`, `provisioning.mjs`, `trunk-setup.mjs`.

## Scenario table

| #   | Scenario                                                            | Expected                                      | Observed                                                                                                                                                  | Evidence                                     | Verdict                                         |
| --- | ------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| 1   | REGISTER, digest, UDP 5160                                          | 200 + Contact                                 | 200 in 14 ms, `expires=300`                                                                                                                               | `TestE2ERegisterTransports/udp`              | PASS                                            |
| 2   | REGISTER over TCP 5160                                              | 200                                           | 200 <1 ms                                                                                                                                                 | same test                                    | PASS                                            |
| 3   | REGISTER over TLS 5161 (self-signed, trusted in the client)         | 200                                           | 200 <1 ms, `transport=tls` binding                                                                                                                        | same test                                    | PASS                                            |
| 4   | Wrong password                                                      | 403, no binding                               | 403 Forbidden                                                                                                                                             | `TestE2ERegisterWrongPassword`               | PASS                                            |
| 4b  | …and an audit trail                                                 | a `sip_auth_event` row                        | **nothing recorded anywhere**                                                                                                                             | `select … from sip_auth_event`               | **FAIL — F2**                                   |
| 5   | Digest answered against a foreign realm                             | refusal                                       | 401 (re-challenge), never 200                                                                                                                             | `TestE2ERegisterRealmMismatch`               | PASS                                            |
| 6   | Unknown account                                                     | refusal indistinguishable from a bad password | 403 Forbidden                                                                                                                                             | `TestE2ERegisterUnknownUser`                 | PASS                                            |
| 7   | Expiry policy                                                       | clamp into the window                         | 1 s → 423 + `Min-Expires`; 300 → 300; 100000 → 3600                                                                                                       | `TestE2ERegisterExpiryPolicy`                | PASS                                            |
| 8   | Refresh                                                             | binding extended, not duplicated              | one contact per socket, `registeredAt` preserved                                                                                                          | KV dump                                      | PASS                                            |
| 9   | un-REGISTER (`Expires: 0`)                                          | 200, binding gone                             | 200, the contact is no longer listed                                                                                                                      | `TestE2EUnregister`                          | PASS                                            |
| 10  | Two devices on one extension                                        | both bindings live, both listed               | both listed in the 200 (one Contact header each)                                                                                                          | `TestE2ETwoDevicesOneExtension`              | PASS                                            |
| 11  | Per-device registration limit                                       | `extension.max_registrations` (3) enforced    | 5 devices → 3 bindings, oldest evicted                                                                                                                    | `TestE2ERegistrationLimit`                   | PASS                                            |
| 12  | Contact pinned to the right sipd instance                           | `sipdInstanceId` stamped on every contact     | `"sipdInstanceId":"e2e-sipd-1"` on all                                                                                                                    | `TestE2EDumpBindings`                        | PASS (single instance; multi-instance untested) |
| 13  | Phone → phone, G.711 both ways                                      | two-way audio, no loss                        | answered in 10 ms; 99/99 packets each way, energy ≈5088, **0 lost**, mediad relays (one SSRC per direction, ports in 32000–32999)                         | `TestE2EPhoneToPhoneCall`                    | PASS                                            |
| 14  | Phone → browser                                                     | browser rings, answers, audio both ways       | answered in 345 ms; phone received 250 PCMU packets, energy 20655, 0 lost; browser 249 in / 333 out, codec `audio/PCMU`                                   | `TestE2EPhoneToBrowser` + `browser-leg.json` | PASS                                            |
| 15  | Browser → phone                                                     | phone rings, answers, audio both ways         | INVITE in 3.1 s; phone received 307 packets, 0 lost; browser 299 in / 692 out                                                                             | `TestE2EBrowserToPhone`                      | PASS                                            |
| 16  | Hold / resume by re-INVITE from the phone                           | 200, direction flips, audio resumes           | hold → answer `recvonly`; resume → `sendrecv`; audio restarts (99 → 149 packets)                                                                          | `TestE2EPhoneToPhoneCall`                    | PASS                                            |
| 17  | DTMF, RFC 4733, from the phone                                      | event reaches the far end                     | event `5` received on payload type 101                                                                                                                    | same test                                    | PASS                                            |
| 18  | BYE from the caller                                                 | 200, both legs down                           | 200 OK                                                                                                                                                    | same test                                    | PASS                                            |
| 19  | CANCEL while ringing                                                | CANCEL 200, INVITE 487                        | `200 OK` for the CANCEL, then `487 Request Terminated` for the INVITE                                                                                     | `TestE2ECancelRace`                          | PASS                                            |
| 20  | NAT-ish `rport` / `received`                                        | echoed on responses                           | `;rport=56876;received=127.0.0.1` on every response                                                                                                       | traced payloads                              | PASS                                            |
| 21  | Malformed SIP (12 shapes × 20 rounds × 3 transports = 720 messages) | no crash, no leak                             | edge healthy; 400/401 or a silent drop each time; **+4 goroutines, +6437 heap objects** across the whole spray; a real REGISTER still succeeds afterwards | `TestE2EMalformedSIP`, pprof before/after    | PASS                                            |
| 22  | Provisioning URL renders a config                                   | 200, vendor format, real password             | 200 `text/plain`, 745 B, `cache-control: no-store`, contains exactly `deriveSipPassword(...)` and `PROVISION_SIP_SERVER`                                  | `provisioning.mjs`                           | PASS                                            |
| 22b | …at the URL the API advertises                                      | the phone can fetch it                        | **307 to the sign-in page** — `PROVISION_BASE_URL` is the web origin, which proxies only `/api/*`                                                         | `curl 127.0.0.1:3300/provision/…`            | **FAIL — F3**                                   |
| 23  | Structured payload route                                            | 200 JSON                                      | 200, accounts array with line/label                                                                                                                       | `provisioning.mjs`                           | PASS                                            |
| 24  | Wrong token secret / unknown reference                              | 404, indistinguishable                        | 404 `PROVISION_NOT_FOUND` both                                                                                                                            | same                                         | PASS                                            |
| 25  | Provisioning rate limit                                             | 429 + `Retry-After`                           | 429 after 9 fetches, `Retry-After: 60`, one `rate-limited` row (not one per refusal)                                                                      | same + `sip_auth_event`                      | PASS                                            |
| 26  | Provisioning IP allowlist                                           | a non-listed source is refused                | allowlist excluding 127.0.0.1 → 404; adding `127.0.0.1/32` → 200                                                                                          | `acl-allowlist.mjs`                          | PASS                                            |
| 27  | …and it is audited                                                  | `acl-denied` row for my tenant                | row present with `source_ip`, `account_ref`, matched reason                                                                                               | `sip_auth_event`                             | PASS                                            |
| 28  | Another organization is unaffected by my ACL rules                  | yes                                           | the smoke org's device still provisions 200 while my org is denied                                                                                        | same script                                  | PASS                                            |
| 29  | Softphone credential endpoint                                       | 200 with account + transport                  | 200, username/password/realm/`wssUrl`                                                                                                                     | `provisioning.mjs`                           | PASS                                            |
| 29b | …realm correctness for a tenant that owns no realm                  | should not hand out another tenant's realm    | hands out `local.test`, which resolves to a DIFFERENT organization                                                                                        | see F4                                       | **FAIL — F4**                                   |
| 30  | SIP ACL: an allow rule reaches the edge                             | carrier admitted                              | **the entry is in the `sip-acl` KV and sipd still refuses**: "refusing an INVITE from a source outside the trunk ACL"                                     | `TestE2EDumpACL` + sipd log                  | **FAIL — F1 (P0)**                              |
| 31  | SIP ACL: `scope=registration` at the edge                           | enforced, or documented as not                | silently ignored — sipd's `applies()` accepts only `scope=trunk`                                                                                          | `apps/sipd/internal/acl/acl.go:67`           | **FAIL — F5**                                   |
| 32  | A deny rule in one org does not break another                       | yes                                           | a `registration` deny for `127.0.0.1/32` in my org left 1601's REGISTER working                                                                           | ran while the deny existed                   | PASS (vacuously — see F5)                       |
| 33  | Carrier profile 5162: unauthenticated INVITE with no ACL match      | 403                                           | 403 Forbidden, logged with the peer                                                                                                                       | `TestE2ETrunkACLRefusesUnknownDID`           | PASS                                            |
| 34  | Carrier profile: inbound DID → extension                            | rings 1601                                    | blocked by F1 — no source can be admitted                                                                                                                 | `TestE2ETrunkInboundDID`                     | **BLOCKED**                                     |
| 35  | Outbound to a trunk with a 401/407 challenge                        | answered                                      | not run — blocked behind the same dead watch (`trunks` KV also shows 0)                                                                                   | —                                            | **BLOCKED**                                     |
| 36  | Trunk registration status in the UI, failover order                 | —                                             | not reached                                                                                                                                               | —                                            | NOT TESTED                                      |

Counts: **28 pass, 5 fail, 2 blocked, 1 not tested.**

## Findings

### F1 — P0: sipd's KV watches die on a broker restart and never recover

`sipd.log` line 28, at 11:34:14 after `nats disconnected / nats reconnected`:

```
nats: stream not found: recreating ordered consumer on connection [6] for subscription on "$KV.trunks.>"
nats: stream not found: recreating ordered consumer on connection [6] for subscription on "$KV.presence.>"
nats: stream not found: recreating ordered consumer on connection [6] for subscription on "$KV.sip-acl.>"
```

`acl.Watch` runs one `WatchAll` in a goroutine that returns when the updates channel closes, and
`watchWhenAvailable` only retries until the FIRST success — so once the stream ends, the compiled
ACL is frozen for the life of the process, with no error and no health signal.

Proved, not inferred: an entry written at 17:00:33 (`sip-acl` KV shows
`127-0-0-1-32 = {"network":"127.0.0.1/32","action":"allow","scope":"trunk","trunkId":…}`, and
`pbx_projection_outbox` shows it published) was still being refused by the edge at 17:01:14 —
90 minutes after the watch died. The same shape applies to `trunks` (directory shows 0 trunks) and
`presence`.

It fails CLOSED, so it is an outage rather than a hole: no carrier can be admitted, no trunk is
known, and the only cure is a sipd restart. Everything trunk-shaped in this brief is blocked on it.

**Fixed** in `apps/sipd/internal/acl/acl.go`: the watch now re-establishes itself with bounded
backoff when the update stream ends without the context being cancelled, keeping the last compiled
ACL in force while the replacement replays. Test:
`TestTheWatchSurvivesTheStreamEnding` in `apps/sipd/internal/acl/acl_test.go`. Needs a sipd restart
to verify against the live stack. The `trunks` and `presence` watchers have the same shape and were
NOT changed — they are other areas' code and would want the same treatment.

### F2 — P1: no SIP authentication failure is ever recorded

`sip_auth_event` exists, is well designed, and is written by exactly one caller — the provisioning
renderer. The registrar path writes nothing: `grep -rn "Audit" apps/sipd/internal` returns nothing,
and the API's credential responder only logs. So a credential spray against 5160/5161 leaves no row
in the tenant's attack log, and `unknown-account` / `bad-credentials` / `disabled-account` — three of
the seven event types the schema defines — are dead letters. `select distinct action from audit_log
where action like '%auth%'` is empty too.

**Partly fixed**, in `apps/api/src/pbx/sip-credentials/sip-credentials.service.ts`: a refusal for an
account the tenant does not have, or one that is disabled, now files `unknown-account` /
`disabled-account` with the source address (port stripped for the `inet` column) and the attempted
account. Tests in `apps/api/test/pbx/sipCredentials.test.ts`.

`bad-credentials` cannot be fixed there and is left open: this API answers with an ha1 and never sees
the digest, so only sipd knows a password was wrong — and there is no "registration refused" event in
`packages/events` for it to say so with. The clean shape is a new contract event on `sip.reg.v1`
carrying `{orgId, username, sourceAddress, transport, reason}` that the API consumes into the same
table; that is a generator + consumer change, so it is reported rather than made here.

### F3 — P1: the provisioning URL the API hands a phone does not resolve

`PROVISION_BASE_URL` is the public origin (here `http://127.0.0.1:3300`), and `devices.service.ts`
builds `configUrl` on it — but `apps/web/next.config.mjs` rewrites only `/api/:path*`. A handset
fetching its advertised `configUrl` gets a 307 to the sign-in page; against the API directly
(`:3200`) the identical request returns the correct 745-byte config. Silent on both sides.

**Fixed**: `apps/web/next.config.mjs` now also rewrites `/provision/:path*` to the API origin. Needs
a web restart to verify (Next did not pick the config change up live).

### F4 — P1: one deployment-wide SIP realm, handed to every tenant

`SIPD_REALM` is a single global value and `SipCredentialsService.resolveOrganizationForRealm` maps a
realm to exactly one organization (two claimants are refused outright). But `PROVISION_SIP_SERVER` is
also deployment-wide, so `/api/v1/me/softphone` in my own organization returned
`"realm":"local.test"` — a realm that belongs to a different tenant. The consequences:

- a softphone or provisioned phone in any organization other than the realm's owner is handed a
  credential that can never register, with no error anywhere;
- if two tenants happen to use the same extension number, the second tenant's user authenticates
  against the FIRST tenant's account, because the lookup is scoped by the realm's owner.

Not fixed — it is a tenancy model decision (`sip_domain` per tenant, or per-tenant
`PROVISION_SIP_SERVER` derived from the org's `sip/realm` setting), not a local bug. It is also why
every SIP scenario above had to run inside the realm-owning organization rather than my own.

### F5 — P1: `scope=registration` ACL entries are enforced nowhere

`apps/sipd/internal/acl/acl.go:67` — `applies()` returns true only for `scope=trunk`, and the
registrar consults no ACL at all. The API accepts, stores, audits and publishes `registration`-scoped
entries; nothing ever reads them. An operator writing "deny 203.0.113.0/24 from registering" gets a
201, an audit row, and no protection. `sip-acl.publisher.ts` publishes the scope to the bucket, so the
data is there; the edge simply filters it out.

Either the registrar should consult the ACL before challenging, or the API should refuse the scope.
Not fixed: which of those is right is a product decision.

### F6 — P2: the `sip-acl` read model is keyed by network alone

`kvKeyFor.sipAcl(network)` carries no organization, so two tenants writing the same CIDR contest one
key and the publisher's own doc says such a key is "published as nothing and reported". On a shared
edge that means tenant A can suppress tenant B's rule by writing the same network. It did not bite
here (only one trunk-scoped `127.0.0.1/32` existed), but it is a cross-tenant coupling on a security
boundary and is worth a key that carries the scope and the org.

### F7 — P2: `TestE2ETwoDevicesOneExtension`-shaped clients need multiple Contact headers

Not a product bug, recorded because it cost time: the 200 to a REGISTER carries ONE `Contact` header
per binding (correct, RFC 3261 §10.3), and a client reading only the first sees a single binding and
concludes the others were evicted.

### F8 — P2: noise in the logs during normal calls

Every answered call logs `WARN ACK missed` from sipgo's transaction layer, and forking to a stale
binding produces `WARN refusing an originate … connection refused` plus `WARN refusing a hangup
(unknown_dialog)` per dead contact — three warnings per unreachable device on every call. A stale
binding is ordinary (a laptop that closed its lid), so this is expected traffic logged at WARN.

## Fixes applied

| File                                                          | Change                                                                   | Test                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| `apps/sipd/internal/acl/acl.go`                               | the sip-acl watch re-establishes itself when the update stream ends (F1) | `TestTheWatchSurvivesTheStreamEnding`                 |
| `apps/api/src/pbx/sip-credentials/sip-credentials.service.ts` | records `unknown-account` / `disabled-account` in `sip_auth_event` (F2)  | 2 cases in `apps/api/test/pbx/sipCredentials.test.ts` |
| `apps/web/next.config.mjs`                                    | rewrites `/provision/:path*` to the API origin (F3)                      | verified by `curl` after a restart — pending          |
| `apps/sipd/internal/testutil/sipua/*`                         | new test user agent (helper, not a fix)                                  | used by every `e2e_*_test.go`                         |
| `apps/sipd/e2e_*_test.go`                                     | the scenarios above, tagged `e2e`                                        | —                                                     |

`gofmt -l .` clean, `go vet ./...` and `go vet -tags e2e ./...` clean, `go test -race ./internal/...`
green. `tsc --noEmit` clean for `apps/api`; `mocha test/pbx/sipCredentials.test.ts` 5 passing.
MODERN_GO guidance applied to the new Go (`sync.OnceFunc` for the ready latch, `min` for the backoff
ceiling, `range n`, `strings.SplitSeq`, `strings.CutPrefix`, `errors.As`, typed atomics, `t.Context()`).

## Needs restart to verify

1. **sipd** — the `acl.Watch` fix (F1). Until it restarts, no trunk scenario can run and the edge's
   ACL stays frozen and empty. After the restart, re-run:
   `SIPD_E2E=1 SIPD_E2E_DID=+15005550161 SIPD_E2E_PASS_1601=… go test -tags e2e -run TestE2ETrunk -v .`
2. **api** — the `sip_auth_event` fix (F2); it is `tsx src/main.ts` with no watch.
3. **web** — the `/provision` rewrite (F3).

## Left in the environment (please clean up after the trunk re-run)

- `sip_acl_entry` `01a0871d-359e-76f4-aa47-03cb78302343` — "sip-e2e carrier loopback",
  `127.0.0.1/32 allow scope=trunk` in org `01a08708-…326b0a`. It is inert today (F1), but **after a
  sipd restart it admits unauthenticated INVITEs from loopback to the external profile**, attributed
  to trunk `01a0871d-353f-7749-8548-f8b8bc13962f`. Delete it once scenario 34 has been run.
- Trunk "sip-e2e carrier", DID `+15005550161`, inbound route "sip-e2e inbound", extensions
  1601/1602/1603 in the smoke org; organization `01a08714-4235-70a9-8a48-7b9ce30adae1` with its own
  devices and two provisioning-scoped ACL entries. A `registration`-scoped deny probe was created and
  deleted again.

## Measurements

- REGISTER, warm: UDP 14 ms first / <1 ms after, TCP <1 ms, TLS <1 ms (handshake excluded).
- Phone→phone: INVITE to 200 OK **10–12 ms**; callee saw the INVITE at 6–7 ms.
- Phone→browser: INVITE to 200 OK **345–397 ms** (the browser has to render and answer).
- Audio, 2 s of 20 ms frames: 99 sent / 99 received in each direction, **0 sequence gaps**,
  energy ≈5088 (µ-law mean absolute sample). Browser leg: 249–307 packets, 0 lost, `audio/PCMU`.
- Media path: mediad relays rather than bridging directly — one SSRC per direction, ports in
  32000–32999, and the SSRC changes across it.
- Malformed spray, 720 messages: goroutines 47 → 51, HeapObjects 9685 → 16122, `/healthz` 200
  throughout, REGISTER still works. No leak attributable to the spray.
- API p50/p99 over 50 requests each: `/sip-acl-entries` 5.0/9.5 ms, `/devices` 5.1/9.7 ms,
  `/extensions` 4.8/8.2 ms, `/me/softphone` 4.3/6.6 ms.

## Not tested, and why

- **Outbound to a carrier with a 401/407 challenge, trunk registration status in the UI, trunk
  failover order** — all behind F1; the trunk directory at the edge is empty and no INVITE can be
  admitted or originated on the external profile until sipd restarts. `load_trunk_test.go` already
  covers the challenge/answer mechanics in-process, so what is missing is the live-stack path.
- **Multi-instance contact pinning** — one sipd runs; `sipdInstanceId` is stamped correctly, but the
  routing decision it exists for cannot be exercised with a single instance.
- **Real NAT** — everything is loopback, so `rport`/`received` are correct but trivially so; a
  symmetric-NAT rewrite path is untested.
- **Heavier fuzzing** — the corpus is 12 hand-written shapes at a light rate, per the brief. A
  `go-fuzz`/`testing.F` corpus against `sip.Parser` would be the next step and belongs in the sipd
  unit suite rather than against the shared stack.
