# apps/sipd — the Go SIP edge

`sipd` is the SIP signalling edge of Optimiq Voice: the thing desk phones, softphones and (later)
carriers talk to. It is written in Go on [sipgo](https://github.com/emiago/sipgo), per the master
plan's polyglot decision (`plans/optimiq-voice-master-plan.md` §3.1, §3.4 option E) — TypeScript is
the default everywhere in this repo, and Go is used where the 2026 industry consensus is Go.

**Today it is a REGISTRAR, plus REFER.** That is deliberate: the first vertical proves the whole
path — SIP in, digest auth, a binding in NATS KV, typed events on JetStream, expiry — end to end,
before any of it carries a call. REFER joined it because a desk phone's TRANSFER key is signalling
and signalling terminates here: the engine can already transfer a call, it just had no way to be
asked by a telephone. `sipd` still carries no media and still holds no call state.

## Where it fits

```
     Desk phones / softphones / WebRTC              PSTN / carriers
                    │ SIP (UDP/TCP today; TLS/WSS next)      │
                    ▼                                        ▼
        ┌────────────────────────────────────────────────────────┐
        │  SIP EDGE — apps/sipd  ◀── you are here                 │
        │  registrar today; proxying next. Nothing sits in front. │
        └───────────────┬────────────────────────────────────────┘
                        │  registrations KV  ·  sip.reg.v1 events
                        ▼
        ┌────────────────────────────────────────────────────────┐
        │  NATS 2.11 JetStream + KV  (the backbone, plan §3.5)     │
        └───────────────┬────────────────────────────────────────┘
                        ▼
        ┌────────────────────────────────────────────────────────┐
        │  apps/engine (PBX brain)   ·   apps/api (control plane) │
        └────────────────────────────────────────────────────────┘
```

`sipd` replaces Routr in **P6**, once the registration and basic-call SIPp suites pass against it.
Until then it shadow-deploys: registration state lives in NATS KV from day one precisely so both
edges are swappable (plan §3.4, "sequencing rule").

It shares one contract with every TypeScript service through
[`packages/events-go`](../../packages/events-go), which is generated from the Zod schemas in
`packages/events` and drift-gated in CI. `sipd` never invents a subject, a payload shape or a KV key.

## What it does

| Behaviour                                                                                                 | Status |
| --------------------------------------------------------------------------------------------------------- | ------ |
| `REGISTER` with MD5 digest auth (`qop=auth`), 401 challenge + stale re-challenge                          | ✅     |
| Stateless nonce (HMAC over expiry + salt) — any instance verifies any instance's challenge                | ✅     |
| AOR ownership check: an account may only bind its own address of record                                   | ✅     |
| Expiry policy: min / max clamp, `423 Interval Too Brief` + `Min-Expires`, default interval                | ✅     |
| Contact `expires` parameter overriding the `Expires` header                                               | ✅     |
| De-registration on `Expires: 0`, and `Contact: *` + `Expires: 0`                                          | ✅     |
| Registration query (`REGISTER` with no `Contact`)                                                         | ✅     |
| Binding written to the `registrations` KV bucket                                                          | ✅     |
| `sip.reg.v1` `registered` / `unregistered` / `expired` events on the `REGISTRATIONS` stream               | ✅     |
| Background expiry sweeper + rehydration of another instance's bindings after a restart                    | ✅     |
| Credential lookup over `rpc.sip.v1.credential`, with a bounded positive+negative cache                    | ✅     |
| `REFER` — the desk phone's TRANSFER key: digest + registration check, `202`, `rpc.sip.v1.transfer`        | ✅     |
| RFC 3515 progress reporting: `Event: refer;id=<cseq>` + `message/sipfrag` NOTIFY (`100` then `200`/`503`) | ✅     |
| `OPTIONS` keepalive responder                                                                             | ✅     |
| UDP + TCP listeners, and TLS / WS / WSS (`SIPD_TLS`, `SIPD_WS`, `SIPD_WSS`)                               | ✅     |
| Everything else → `501 Not Implemented`                                                                   | ✅     |

### The INVITE surface (`SIPD_INVITE`, off by default)

The dialog layer and the INVITE admission path are built and tested. They are **off by default**,
and they must stay off until `apps/engine` serves `rpc.sip.v1.invite`: with no responder every call
is refused `503` after the admission deadline, and a `503` tells a carrier to retry _here_ shortly,
whereas the `501` the registrar answers today tells it this element does not place calls.

| Behaviour                                                                                          | Status |
| -------------------------------------------------------------------------------------------------- | ------ |
| UAS/UAC dialog state machine — Init/Proceeding/Early/Established/Confirmed/Terminating/Terminated  | ✅     |
| CANCEL after the 200 → `481`, and the dialog survives (RFC 3261 §9.2)                              | ✅     |
| BYE before the ACK, honoured, and the 2xx retransmission stopped (RFC 5407 §3.1.2)                 | ✅     |
| Hangup before the ACK → the BYE is DEFERRED until it arrives (RFC 3261 §15)                        | ✅     |
| Hangup before any provisional → the CANCEL is deferred (RFC 3261 §9.1)                             | ✅     |
| A hangup that races a 200 and loses → ACK then BYE, never a CANCEL                                 | ✅     |
| A second 2xx from a forked branch → ACK then BYE (RFC 3261 §13.2.2.4)                              | ✅     |
| RFC 6026 2xx-until-ACK retransmission, and the BYE at 64×T1 (RFC 3261 §13.3.1.4)                   | ✅     |
| RFC 3398 status → Q.850 cause, with an RFC 3326 `Reason` header winning over it                    | ✅     |
| re-INVITE and UPDATE: hold/unhold, target refresh, glare `491` (RFC 3261 §14.2), RFC 3311          | ✅     |
| Session timers (RFC 4028): negotiation, `422` + `Min-SE`, `420`, refresher role, expiry teardown   | ✅     |
| `Replaces` correlation and the replaced dialog's teardown on the 2xx (RFC 3891)                    | ✅     |
| SIP INFO DTMF (`application/dtmf-relay`)                                                           | ✅     |
| Internal / external listener PROFILES with distinct auth, NAT policy and routing context           | ✅     |
| Trunk source-address ACL, longest-prefix with priorities and deny-wins ties                        | ✅     |
| NAT: `rport`/`received`, Contact rewrite decisions, symmetric routing, media-latch hints           | ✅     |
| Outbound trunk registration FSM: backoff with jitter, failover, `trunk.status.changed` transitions | ✅     |
| Multi-contact AOR model: q-values, RFC 5626 instance/reg-id keys, `max_registrations` eviction     | ✅     |
| The engine seam itself — `rpc.sip.v1.invite` and the command surface                               | ❌     |
| Outbound INVITE (`originate`), and therefore any actual call                                       | ❌     |
| `sip.evt.v1` publishing (no subject, schema, stream or NATS grant yet — it logs instead)           | ❌     |
| STUN / TURN / ICE                                                                                  | ❌     |

### Explicitly NOT implemented yet

| Gap                                                                         | Why / when                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cache invalidation on a provisioning change**                             | The credential cache expires by TTL (seconds), so a disabled extension can still register for up to `SIPD_CREDENTIAL_CACHE_TTL`. `NATSStore.Forget` is the seam a JetStream consumer on the provisioning stream will attach to; that consumer belongs with the provisioning wave. |
| **Proxy / INVITE path**                                                     | The next PG wave. `sipd` answers 501 to INVITE rather than pretending.                                                                                                                                                                                                            |
| **SIP `Call-ID` → engine channel correlation**                              | The half of REFER that is not this repository's to fix yet. `apps/engine` records no `Call-ID` on a channel, so it answers `correlation_unavailable` and the edge reports `503` to the phone. Everything either side of that lookup works; see `internal/transfer/handler.go`.    |
| **Attended REFER (`Replaces`)**                                             | Parsed, carried on the contract as `kind: "attended"`, and refused `attended_unsupported` by the engine: joining two dialogs it never brokered is a different operation from the consultation transfer `CallControl` implements.                                                  |
| **A REFER subscription state machine**                                      | RFC 3515's two notifications are sent; `Refer-Sub: false` (RFC 4488) is not negotiated, SUBSCRIBE refreshes are not honoured, and notifications are not retried past the transaction layer's own timers. A blind transfer reaches its final state in under two seconds.           |
| **NAT traversal, `Record-Route`, `rport`/`received` rewriting on requests** | Comes with the proxy. Bindings already record the observed `sourceAddress`, which is the piece the proxy will need.                                                                                                                                                               |
| **DTLS-SRTP for the WSS softphone**                                         | `SIPD_WSS` delivers SIGNALLING for a browser client and no media: a WebRTC endpoint needs DTLS-SRTP and `apps/mediad` has no SRTP. Say so rather than shipping half a feature quietly.                                                                                            |
| **Multiple simultaneous contacts per AOR, on the wire**                     | The MODEL is built and tested (`internal/aor`): q-values, RFC 5626 instance keys, a cap with an eviction rule. The registrar still writes one binding, because the list-valued field needs adding to `registrationBindingSchema` in `packages/events` first.                      |
| **Multi-realm / multi-domain**                                              | One realm per process (`SIPD_REALM`). The `Registrar` holds no package-level state, so multi-realm is "construct more of them", not a rewrite.                                                                                                                                    |
| **Nonce-count replay tracking**                                             | Deliberate — see `internal/registrar/auth.go`. Rate limiting and the anti-fraud consumer on the `REGISTRATIONS` stream are the real mitigation, and they are control-plane concerns (plan §5 T1).                                                                                 |
| **`fail2ban`-style blocking**                                               | Same: `sipd` publishes the events, the control plane decides.                                                                                                                                                                                                                     |

## Configuration

Everything is environmental; there are no flags. Invalid configuration fails at boot with **every**
problem listed at once, not one per restart.

| Variable                               | Default                 | Notes                                                                                                                                                                                                             |
| -------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIPD_REALM`                           | — **required**          | Digest realm. Part of `HA1 = MD5(user:realm:pass)`, so changing it invalidates every credential. No default on purpose.                                                                                           |
| `SIPD_LISTEN_ADDR`                     | `0.0.0.0:5060`          | Bound by both transports.                                                                                                                                                                                         |
| `SIPD_UDP` / `SIPD_TCP`                | `true` / `true`         | Toggles. Leaving TCP off is not advisable: a REGISTER with a long Contact and several Vias exceeds the safe UDP MTU.                                                                                              |
| `SIPD_TLS` / `SIPD_WS` / `SIPD_WSS`    | `false`                 | The secure and WebSocket transports, each opt-in. `ws`/`wss` are RFC 7118 and are the ONLY transport a browser softphone has. TLS floors at 1.2.                                                                  |
| `SIPD_TLS_LISTEN_ADDR`                 | `0.0.0.0:5061`          | The conventional SIP-over-TLS port.                                                                                                                                                                               |
| `SIPD_WS_LISTEN_ADDR`                  | `0.0.0.0:5080`          | Plaintext WebSocket. A development origin only; anything a browser will load needs `wss`.                                                                                                                         |
| `SIPD_WSS_LISTEN_ADDR`                 | `0.0.0.0:8089`          | The conventional SIP-over-WSS port.                                                                                                                                                                               |
| `SIPD_TLS_CERT_FILE` / `_KEY_FILE`     | —                       | Required by `SIPD_TLS` and `SIPD_WSS`, and REFUSED when neither is on — a deployment with a certificate and no TLS believes it is encrypted and is not.                                                           |
| `SIPD_INVITE`                          | `false`                 | The INVITE surface. **Leave it off** until `apps/engine` serves `rpc.sip.v1.invite`; without a responder every call is refused `503`.                                                                             |
| `SIPD_INSTANCE_ID`                     | the hostname            | This process's identity on the backbone: it stamps every dialog claim and is the token engine commands are addressed at, because a dialog lives on ONE process.                                                   |
| `SIPD_SESSION_TIMERS`                  | `false`                 | RFC 4028. Off because a one-sided timer is worse than none, and because mediad's RTP timeout already reaps a far end that vanished. Mandatory in front of a carrier that offers `Supported: timer`.               |
| `SIPD_SESSION_EXPIRES` / `SIPD_MIN_SE` | `1800` / `90`           | Seconds. `SIPD_MIN_SE` may not go below 90 — RFC 4028 §4 sets that floor, and a shorter one turns every call into a re-INVITE storm.                                                                              |
| `SIPD_MAX_CONTACTS`                    | `5`                     | Simultaneous registrations per AOR. The enforcement point for `extension.maxRegistrations`.                                                                                                                       |
| `SIPD_TRUNK_ACL`                       | unset                   | `cidr[=trunkId]`, comma-separated. Empty builds NO external profile, so no unauthenticated INVITE can be admitted at all — the only safe default.                                                                 |
| `SIPD_EXTERNAL_LISTEN_ADDR`            | unset                   | A socket of its own for the carrier profile. Stronger than sharing one: the profile is then chosen by the address the packet ARRIVED on, which no sender can influence.                                           |
| `NATS_URL`                             | `nats://127.0.0.1:4222` | The backbone.                                                                                                                                                                                                     |
| `NATS_SIPD_USER` / `NATS_SIPD_PASS`    | unset                   | This process's own broker identity. `config/nats.conf` lets the `sipd` user publish `sip.reg.v1.>`, request `rpc.sip.v1.credential` and use the `registrations` bucket — nothing else. Half a pair fails at boot. |
| `NATS_USER` / `NATS_PASS`              | unset                   | The shared operator credential, used only when the pair above is absent. Both pairs unset is a broker with no authentication, which is what the SIPp rig runs.                                                    |
| `NATS_TLS_CA`                          | unset                   | Path to a CA bundle. Setting it enables TLS and pins that CA. Unset is a plaintext connection.                                                                                                                    |
| `NATS_TLS_ENABLED`                     | `false`                 | TLS against the system trust store, for a certificate from a public issuer. `NATS_TLS_CA` takes precedence.                                                                                                       |
| `SIPD_MIN_EXPIRES`                     | `60`                    | Seconds. Below this a REGISTER gets `423` + `Min-Expires`.                                                                                                                                                        |
| `SIPD_MAX_EXPIRES`                     | `3600`                  | Seconds. Above this the grant is silently clamped down.                                                                                                                                                           |
| `SIPD_DEFAULT_EXPIRES`                 | `300`                   | Seconds. Used when the REGISTER states no interval at all.                                                                                                                                                        |
| `SIPD_NONCE_TTL`                       | `1m`                    | Go duration. How long a challenge stays usable.                                                                                                                                                                   |
| `SIPD_NONCE_SECRET`                    | random per process      | **Set this fleet-wide before running more than one replica**, or a device challenged by instance A is rejected by instance B. 32+ random bytes.                                                                   |
| `SIPD_SWEEP_INTERVAL`                  | `5s`                    | How often lapsed bindings are noticed. Bounds event lateness, not binding lifetime.                                                                                                                               |
| `SIPD_CREDENTIAL_SOURCE`               | `file`                  | `file` (development / the SIPp rig) or `nats` (**production** — `rpc.sip.v1.credential` against `apps/api`).                                                                                                      |
| `SIPD_CREDENTIALS_FILE`                | —                       | Required when the source is `file`. See `config/credentials.example.json`.                                                                                                                                        |
| `SIPD_CREDENTIAL_TIMEOUT`              | `500ms`                 | Per-request deadline for the credential RPC — the contract's own. It sits inside a REGISTER transaction and a phone's retransmission timer starts at 500 ms, so a slower reply competes with the retry it caused. |
| `SIPD_CREDENTIAL_CACHE_TTL`            | `30s`                   | How long a resolved credential is reused. Short: the alternative to staleness is an account disabled minutes ago that still registers.                                                                            |
| `SIPD_CREDENTIAL_NEGATIVE_CACHE_TTL`   | `10s`                   | How long "no such account" / "disabled" is reused. This is the half that stops a username scanner becoming one database query per guess.                                                                          |
| `SIPD_CREDENTIAL_CACHE_MAX_ENTRIES`    | `10000`                 | Cache ceiling. An unbounded negative cache keyed on an attacker-chosen username is a memory amplifier.                                                                                                            |
| `SIPD_PROVISION_SECRET_KEY`            | —                       | **Normally unset.** Only the file store's derived form uses it (see below). Production sipd holds no derivation key at all.                                                                                       |
| `SIPD_USER_AGENT`                      | `optimiq-sipd`          | `Server:` / `User-Agent:` header.                                                                                                                                                                                 |
| `SIPD_LOG_LEVEL`                       | `info`                  | `debug` \| `info` \| `warn` \| `error`. Output is JSON on stdout (`log/slog`).                                                                                                                                    |
| `SIPD_SHUTDOWN_TIMEOUT`                | `10s`                   | Bounds graceful shutdown.                                                                                                                                                                                         |

## Running

```bash
# 1. A broker with JetStream.
docker run --rm -p 4222:4222 nats:2.11 -js

# 2. The streams and buckets. sipd does NOT create streams — provisioning is the control plane's
#    job (packages/events `ensureStreams` / `ensureKvBuckets`), because a data-plane edge that
#    created its own could silently bring one up with the wrong retention. It DOES open (creating
#    if absent) the `registrations` KV bucket from the shared definition, so a bare broker works
#    for registration; the REGISTRATIONS stream must exist for events to be retained.

# 3. sipd itself.
cd apps/sipd
SIPD_REALM=acme.example.com \
SIPD_CREDENTIALS_FILE=./config/credentials.example.json \
NATS_URL=nats://127.0.0.1:4222 \
SIPD_LOG_LEVEL=debug \
go run ./cmd/sipd
```

Point a softphone at `127.0.0.1:5060` with user `1001`, password `s3cret`, domain
`acme.example.com`. Then watch the backbone:

```bash
nats kv ls registrations                 # the binding
nats sub 'sip.reg.v1.>'                  # the transitions
```

## Credentials: how a provisioned phone comes to authenticate

This is the whole chain, because every link in it is in a different process and none of them can
be inspected from the others.

```text
  apps/api  ── renders a device config ──────────────────────────────────────────────┐
     │         password = base64url(hmac-sha256(PROVISION_SIP_SECRET_KEY,            │
     │                              "<orgId>:<extension.sip_secret_ref>"))[:24]      │
     │         (apps/api/src/provisioning/render/provision-secret.ts)                │
     ▼                                                                               ▼
  the phone fetches /provision/<token>/config and stores that password        nothing is stored:
     │                                                                        pbx-db holds a
     ▼                                                                        secret_ref, never
  REGISTER sip:acme.example.com  ──▶  sipd                                    a password
                                        │  401 + digest challenge
                                        │  the phone answers with MD5(...)
                                        │
                                        ├── rpc.sip.v1.credential ──▶ apps/api
                                        │     { realm, username }        │ realm → organization
                                        │                                │ username → device_line
                                        │                                │   or extension
                                        │     { found, enabled, orgId,   │ derive the SAME password
                                        │◀──   ha1, deviceId, ... } ─────┘ ha1 = MD5(user:realm:pw)
                                        │
                                        ▼
                               digest verified → binding in the `registrations` KV bucket
                                                 + sip.reg.v1.registered on the stream
```

### The derivation, and why the root key is not here

`extension.sip_secret_ref` is a **handle**, not a password — `packages/pbx-db`'s schema is explicit
that the plaintext is never stored. So the password is derived from a deployment-wide root key, and
both ends have to agree on it byte for byte, or every handset fails to register and reports nothing
an administrator can act on.

`internal/credentials/derive.go` is a byte-exact Go port of the TypeScript function, and
`derive_test.go` asserts it against `testdata/derive_parity.json` — **golden vectors emitted by the
TypeScript implementation itself**, exactly as `packages/events-go/testdata/parity.json` pins the
event contract:

```bash
pnpm --filter @optimiq-voice/api emit:sip-vectors             # regenerate
pnpm --filter @optimiq-voice/api emit:sip-vectors -- --check  # drift gate
```

Production sipd nevertheless **does not run that derivation**. `rpc.sip.v1.credential` returns a
ready-made HA1 that `apps/api` computed, so `PROVISION_SIP_SECRET_KEY` never leaves the control
plane. The root key derives every tenant's password; an edge that held it would turn a compromise
of the most internet-exposed process in the system into a total credential compromise. What arrives
here instead is bound to one `(username, realm)` pair and is useless for anything else.

`SIPD_PROVISION_SECRET_KEY` therefore exists for exactly one purpose: the **file store's derived
form**, so a development or SIPp-rig fixture gets the credential a real provisioned phone would
have been handed rather than a literal that silently drifts.

```jsonc
{
	"realm": "acme.example.com",
	"accounts": [
		// the ordinary fixture form
		{ "orgId": "018f…", "username": "1001", "password": "s3cret" },
		// the derived form — needs SIPD_PROVISION_SECRET_KEY
		{ "orgId": "018f…", "username": "1002", "secretRef": "ext/1002/sip" },
	],
}
```

### What the API side needs

| Where      | Variable / row                                                                       | Why                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api` | `PROVISION_SIP_SECRET_KEY`                                                           | The root key. The **same value** the renderer used; rotating it invalidates every provisioned phone at once, which is the correct response to a compromise and the reason it is a deployment variable.                                                                                                                                                          |
| `apps/api` | `PBX_DATABASE_URL`, `NATS_URL`                                                       | Without `NATS_URL` the PBX area mounts its REST surface and serves **no** RPC subjects, so no phone can register.                                                                                                                                                                                                                                               |
| `pbx-db`   | an `org_setting` row: `category='sip'`, `name='realm'`, `value='"acme.example.com"'` | **The realm → organization directory.** `rpc.sip.v1.credential` carries no tenant — resolving one is the whole request — so the API needs to know which organization owns the realm sipd challenges with. Without it every lookup is refused with a `reason` naming this row. Two organizations claiming one realm is refused rather than resolved arbitrarily. |
| `sipd`     | `SIPD_REALM`                                                                         | Must equal that `org_setting` value. It is inside `HA1`, so a mismatch is an authentication failure, not a routing one.                                                                                                                                                                                                                                         |

### Failure modes, and what each one looks like

| Situation                                               | sipd                                                          | Where to look                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nobody subscribed to the subject (an `apps/api` deploy) | `403`, `cannot look up the account … no responders available` | Not cached — the next REGISTER after the API returns succeeds.                                                                                                                |
| Realm not mapped to an organization                     | `403`                                                         | `apps/api` logs `refusing a credential lookup for an unmapped realm`. The phone learns nothing; the operator learns everything.                                               |
| Unknown extension, disabled extension, wrong password   | `403`, identical status **and** reason phrase                 | Deliberate: a distinguishable answer is an extension enumerator. `found` and `enabled` stay separate on the RPC so the API's logs and any admin UI can still tell them apart. |
| `PROVISION_SIP_SECRET_KEY` unset on the API             | `403`                                                         | The renderer already refuses to emit a config without it, so such a deployment has no provisioned phones anyway.                                                              |
| Realm changed on one side only                          | `403` for every account                                       | `HA1` is computed over the realm. Change it in both places and re-provision.                                                                                                  |

## Tests

```bash
# From the repo root (go.work covers apps/sipd and packages/events-go).
go vet ./apps/sipd/... ./packages/events-go/...
go test ./apps/sipd/... ./packages/events-go/...
gofmt -l ./apps/sipd ./packages/events-go     # must print nothing

# Integration suite: needs docker. Gated twice — build tag AND environment variable — so it never
# runs by accident. It starts one throwaway `nats:2.11 -js` container per test and removes it,
# including after a failure.
RUN_SIPD_INTEGRATION=1 go test -tags integration -timeout 10m ./apps/sipd/...
```

The unit tests drive the real SIP handler with wire-format requests (parsed by sipgo) and compute
their digest answers with `github.com/icholy/digest` — an independent client-side implementation of
RFC 2617 — so the server-side verifier is checked against something other than itself.

`golangci-lint` is not run here: installing it is a non-trivial toolchain addition and `go vet` plus
`gofmt` cover the failure modes that matter at this size. Add it when the proxy wave lands.

## Layout

```
cmd/sipd/main.go              wiring, signals, graceful shutdown
internal/config               environment → validated Config
internal/dialog               THE DIALOG LAYER — the state machine behind INVITE
  state.go                      State, Role, Trigger, and the pure transition table
  dialog.go                     Dialog + Apply: the effects each legal move produces
  effects.go                    the effect and event vocabularies
  identity.go                   the RFC 3261 §12 triple — data on the record, never the key
  cause.go                      RFC 3398 status→Q.850, RFC 3326 Reason, and the reverse
  offer.go                      offer/answer, hold direction, RFC 3261 §14.1 glare backoff
  timers.go                     RFC 4028 session-timer negotiation
  reinvite.go                   re-INVITE and UPDATE, target refresh, 491
  store.go                      the dialog table + the `sip-dialogs` claim and its reaper
  session.go                    one goroutine per dialog: the mailbox that decides the races
internal/invite               the INVITE surface: admission, mid-dialog methods, Replaces
  intent.go                     INVITE → CallIntent, a pure function of the message
  port.go                       the ENGINE SEAM: Port, Admission, the refusal table, two fakes
  handler.go                    profile → auth → parse → dialog → admission
  executor.go                   effects → the wire, incl. the RFC 6026 2xx loop
  requests.go                   BYE / ACK / CANCEL builders, and the NAT destination split
  replaces.go                   RFC 3891 correlation and the replaced dialog's teardown
internal/nat                  rport/received, Contact rewrite, media-latch hints, keepalive
internal/profile              the internal/external trust boundary, and the trunk ACL evaluator
internal/trunk                the outbound gateway registration FSM and its status events
internal/aor                  the multi-contact location model: q-values, caps, RFC 5626 keys
internal/credentials          Credential + Store
  credentials.go                the Store interface, Credential, HA1
  file.go                       FileStore — development / SIPp rig, incl. the derived form
  derive.go                     the shared provisioning derivation, byte-exact with apps/api
  nats.go                       NATSStore — rpc.sip.v1.credential, the production store
  testdata/derive_parity.json   golden vectors emitted BY the TypeScript implementation
internal/kv                   Binding + Store; the registrations KV bucket, plus an in-memory fake
internal/events               Publisher; JetStream publisher, plus a recording fake
internal/registrar            digest auth, expiry policy, REGISTER/OPTIONS handlers, expiry sweeper
integration_test.go           build-tagged end-to-end suite against a real broker and a real socket
credential_rpc_integration_test.go   the same, for the credential RPC and the derivation chain
```

Two design notes worth knowing before changing anything:

- **The nonce is stateless.** A registrar that keeps nonces in a map breaks the moment there are two
  replicas behind a load balancer. The nonce carries its own expiry plus an HMAC keyed by
  `SIPD_NONCE_SECRET`; verification is a recomputation. See `internal/registrar/auth.go`.
- **The credential root key lives in `apps/api`, not here.** The RPC returns an HA1 rather than a
  password or a `secretRef`, so the SIP edge holds nothing that derives another tenant's
  credential. `derive.go` exists to prove the two languages agree, and to let a dev fixture match
  what the renderer would have produced — not to run on the REGISTER path.
- **Expiry is a ticker over locally-granted bindings, not a KV watch.** The bucket's one-hour TTL is
  a backstop for a crashed registrar, not the expiry mechanism — granted intervals are 60–3600
  seconds, and waiting for the bucket would report a dead phone as reachable for up to an hour. A
  watch would also fire on every replica and publish one `expired` event per instance. See the `Run`
  doc comment in `internal/registrar/registrar.go`.
