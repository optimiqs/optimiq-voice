# apps/sipd — the Go SIP edge

`sipd` is the SIP signalling edge of Optimiq Voice: the thing desk phones, softphones and (later)
carriers talk to. It is written in Go on [sipgo](https://github.com/emiago/sipgo), per the master
plan's polyglot decision (`plans/optimiq-voice-master-plan.md` §3.1, §3.4 option E) — TypeScript is
the default everywhere in this repo, and Go is used where the 2026 industry consensus is Go.

`sipd` is a **stateful SIP element**. It registers devices, owns dialogs and their state machines,
serves presence and transfer, and survives the loss of one of its own instances. Two things it is
deliberately NOT:

- **Not a media endpoint.** No RTP, no SRTP, no ICE. It is an SDP _courier_: the only thing it reads
  out of a body is the RFC 4566 §6 direction attribute, because `dialog.held` and `dialog.resumed`
  can be learned nowhere else. Offers and answers travel on the engine RPC as opaque bytes, and it
  is `apps/engine` that hands them to `apps/mediad` — `sipd` never speaks to mediad directly.
- **Not a router.** Every call is admitted, progressed and ended by `apps/engine` over NATS RPC;
  `sipd` holds the SIP state those decisions are expressed through, and answers the phone.

REGISTER, OPTIONS, SUBSCRIBE/NOTIFY and REFER are always served. The INVITE surface is gated behind
`SIPD_INVITE`, default **off** — a DEPLOYMENT prerequisite rather than an unfinished feature:
turning it on requires a dialog-affine front end (a mid-dialog request landing on the wrong instance
is answered `481`) and the `trunks` and `sip-acl` buckets written by `apps/api`.

## Where it fits

```
     Desk phones / softphones / WebRTC              PSTN / carriers
                    │ SIP over UDP / TCP / TLS / WS / WSS     │
                    ▼                                         ▼
        ┌────────────────────────────────────────────────────────┐
        │  SIP EDGE — apps/sipd  ◀── you are here                 │
        │  registrar · dialogs · SDP relay · presence · transfer  │
        └───────────────┬────────────────────────────────────────┘
                        │  registrations / sip-dialogs / sip-instances KV
                        │  sip.reg.v1 · dialog.* · trunk.status.* events
                        │  rpc.sip.v1.{invite,ring,answer,hangup,transfer,…}
                        ▼
        ┌────────────────────────────────────────────────────────┐
        │  NATS 2.11 JetStream + KV  (the backbone, plan §3.5)     │
        └────────┬──────────────────────────────────┬────────────┘
                 ▼                                  ▼
        ┌──────────────────────┐        ┌──────────────────────────┐
        │ apps/engine (brain)  │        │ apps/mediad (RTP)        │
        │ routing, features    │◀──────▶│ the audio path           │
        └──────────────────────┘        └──────────────────────────┘
                 │
                 ▼  apps/api (control plane): credentials, trunks, ACLs
```

## What it does

### Always on

| Behaviour                                                                                                 | Status |
| --------------------------------------------------------------------------------------------------------- | ------ |
| `REGISTER` with MD5 digest auth (`qop=auth`), 401 challenge + stale re-challenge                          | ✅     |
| Stateless nonce (HMAC over expiry + salt) — any instance verifies any instance's challenge                | ✅     |
| Nonce-count replay guard: a repeated or decreasing `nc` is re-challenged as stale                         | ✅     |
| One shared digest pipeline for REGISTER / INVITE / SUBSCRIBE / REFER, with one throttle budget            | ✅     |
| Credential-spray lockout, keyed on the source HOST and a realm-scoped account                             | ✅     |
| AOR ownership check: an account may only bind, call, subscribe or transfer as itself                      | ✅     |
| Expiry policy: min / max clamp, `423 Interval Too Brief` + `Min-Expires`, default interval                | ✅     |
| Per-profile NAT clamp on the granted registration, so a pinhole outlives the binding                      | ✅     |
| Contact `expires` parameter overriding the `Expires` header                                               | ✅     |
| De-registration on `Expires: 0`, and `Contact: *` + `Expires: 0`                                          | ✅     |
| Registration query (`REGISTER` with no `Contact`)                                                         | ✅     |
| Multi-contact AOR on the wire: q-values, RFC 5626 instance/reg-id keys, `max_registrations` eviction      | ✅     |
| Binding written to the `registrations` KV bucket; rehydration of a predecessor's bindings at boot         | ✅     |
| `sip.reg.v1` `registered` / `unregistered` / `expired` / `auth-failed` on the `REGISTRATIONS` stream      | ✅     |
| Background expiry sweeper, and a WebSocket-connection sweep for bindings whose socket has gone            | ✅     |
| Credential lookup over `rpc.sip.v1.credential`, with a bounded positive+negative cache                    | ✅     |
| `credential.invalidated` on `provision.evt.v1.*` evicts that org's credential cache on the commit         | ✅     |
| A digest that fails re-fetches the credential ONCE and re-verifies, so a rotated secret is not refused    | ✅     |
| `SUBSCRIBE` / `NOTIFY` (RFC 6665) for `dialog` (RFC 4235 BLF) and `message-summary` (RFC 3842 MWI)        | ✅     |
| `REFER` — the desk phone's TRANSFER key: digest + registration check, `202`, `rpc.sip.v1.transfer`        | ✅     |
| RFC 3515 progress reporting: `Event: refer;id=<cseq>` + `message/sipfrag` NOTIFY (`100` then `200`/`503`) | ✅     |
| `OPTIONS` keepalive responder                                                                             | ✅     |
| UDP, TCP, TLS, WS and WSS listeners (`SIPD_TLS`, `SIPD_WS`, `SIPD_WSS`)                                   | ✅     |
| Prometheus metrics and a readiness/liveness endpoint on a private health listener                         | ✅     |
| Everything else → `501 Not Implemented`                                                                   | ✅     |

### The INVITE surface (`SIPD_INVITE`, off by default)

Off by default because it turns a registrar into a call-processing element with prerequisites the
deployment must already meet — see the note at the top. The code behind the flag is complete, not a
stub, and `apps/engine` serves the seam.

| Behaviour                                                                                           | Status |
| --------------------------------------------------------------------------------------------------- | ------ |
| UAS/UAC dialog state machine — Init/Proceeding/Early/Established/Confirmed/Terminating/Terminated   | ✅     |
| Admission over `rpc.sip.v1.invite`, with the engine's refusal vocabulary mapped to SIP statuses     | ✅     |
| The instance-scoped command surface: `rpc.sip.v1.{ring,answer,hangup,reinvite}`                     | ✅     |
| Outbound INVITE: `rpc.sip.v1.originate` and `rpc.sip.v1.resolve-target`, to an AOR, URI or trunk    | ✅     |
| `sip.evt.v1` dialog events (`progressed`/`answered`/`held`/`resumed`/`terminated`/`dtmf`)           | ✅     |
| Durable finalisation: a `dialog.terminated` is acknowledged by JetStream before its claim is freed  | ✅     |
| CANCEL after the 200 → `481`, and the dialog survives (RFC 3261 §9.2)                               | ✅     |
| BYE before the ACK, honoured, and the 2xx retransmission stopped (RFC 5407 §3.1.2)                  | ✅     |
| Hangup before the ACK → the BYE is DEFERRED until it arrives (RFC 3261 §15)                         | ✅     |
| Hangup before any provisional → the CANCEL is deferred (RFC 3261 §9.1)                              | ✅     |
| A hangup that races a 200 and loses → ACK then BYE, never a CANCEL                                  | ✅     |
| A second 2xx from a forked branch → ACK then BYE (RFC 3261 §13.2.2.4)                               | ✅     |
| RFC 6026 2xx-until-ACK retransmission, and the BYE at 64×T1 (RFC 3261 §13.3.1.4)                    | ✅     |
| RFC 3398 status → Q.850 cause, with an RFC 3326 `Reason` header winning over it                     | ✅     |
| re-INVITE and UPDATE: hold/unhold, target refresh, glare `491` (RFC 3261 §14.2), RFC 3311           | ✅     |
| Engine-initiated renegotiation over `rpc.sip.v1.reinvite`                                           | ✅     |
| Session timers (RFC 4028): negotiation, `422` + `Min-SE`, `420`, refresher role, expiry teardown    | ✅     |
| `Replaces` correlation and the replaced dialog's teardown on the 2xx (RFC 3891) — attended transfer | ✅     |
| STIR/SHAKEN `Identity` attestation parsing, carried on the admission request                        | ✅     |
| SIP INFO DTMF (`application/dtmf-relay`)                                                            | ✅     |
| Internal / external listener PROFILES with distinct auth, NAT policy and routing context            | ✅     |
| Per-message listener provenance, so a profile is chosen by the socket a datagram landed on          | ✅     |
| Trunk source-address ACL, longest-prefix with priorities and deny-wins ties                         | ✅     |
| NAT: `rport`/`received`, Contact rewrite decisions, symmetric routing, media-latch hints            | ✅     |
| Outbound trunk registration FSM: backoff with jitter, failover, `trunk.status.changed` transitions  | ✅     |

### Recovery: what happens when an instance dies

A dialog lives on ONE process (design §6.4), so losing that process must not lose the call silently.
Three records make that survivable, and all three are only written when the INVITE surface is on:

| Record                | Bucket          | Who reads it                                                                                         |
| --------------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| One claim per dialog  | `sip-dialogs`   | `internal/reaper`, which heartbeats this instance's claims and reaps a dead peer's                   |
| One lease per process | `sip-instances` | The reaper (a lapsed lease reaps in seconds rather than at the claim's own expiry) and `apps/engine` |
| One binding per AOR   | `registrations` | `registrar.Rehydrate` at boot, so a restart does not leave devices on the bucket's one-hour backstop |

A reaped claim publishes `dialog.terminated{reason: "instance-lost", cause: 41}` on the dead owner's
behalf — Q.850 41 "temporary failure", because filing a crash as normal clearing makes an
availability incident invisible in the CDR. `SweepPredecessor` runs once at boot and clears claims
stamped with THIS instance id by a previous incarnation, before any INVITE is admitted. Neither
bucket is fatal to open: `sip-dialogs` falls back to an in-memory claim store (with the reaper left
unwired) and a missing `sip-instances` skips the renewer, both with a warning.

### Explicitly NOT implemented

| Gap                                           | Why / when                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Any media at all — RTP, SRTP, DTLS, ICE**   | Not a gap: the media plane is `apps/mediad`. A WSS browser softphone therefore gets SIGNALLING and no audio until DTLS-SRTP exists in mediad; say so rather than shipping half a feature quietly. `internal/testutil/sipua` carries an SDES-SRTP implementation, which is a TEST UA and not a production dependency. |
| **STUN / TURN / ICE**                         | A media-plane concern, where the RTP sockets are. `internal/nat` decides Contact rewriting and media-latch hints and nothing else.                                                                                                                                                                                   |
| **Server-sent NAT keepalive (OPTIONS pings)** | Not implemented, and not promised. The pinhole mechanism here is the per-profile registration clamp, which needs no cooperation from the device; a paced OPTIONS pinger would need an ownership rule across the fleet that does not exist yet.                                                                       |
| **A REFER subscription state machine**        | RFC 3515's two notifications are sent; `Refer-Sub: false` (RFC 4488) is not negotiated, SUBSCRIBE refreshes are not honoured, and notifications are not retried past the transaction layer's own timers. A blind transfer reaches its final state in under two seconds.                                              |
| **Proxying / `Record-Route`**                 | `sipd` is a B2BUA at the edge, not a proxy. Mid-dialog requests are answered by the instance that owns the dialog, which is why the front end must be dialog-affine.                                                                                                                                                 |
| **`fail2ban`-style blocking**                 | `sipd` publishes `auth-failed` and enforces the local lockout; the control plane decides what to block. The `sip-acl` bucket is how a decision comes back.                                                                                                                                                           |
| **`golangci-lint`**                           | `go vet` plus `gofmt` cover the failure modes that matter at this size.                                                                                                                                                                                                                                              |

## Configuration

Everything is environmental; there are no flags. Invalid configuration fails at boot with **every**
problem listed at once, not one per restart.

| Variable                                 | Default                 | Notes                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIPD_REALM`                             | — **required**          | The digest realm used when a request names NO domain — a "no tenant matched" default, never a tenant's realm. A request that names one is challenged and looked up under THAT domain. Part of `HA1 = MD5(user:realm:pass)`, so changing it invalidates every credential derived against it. No default on purpose.                                        |
| `SIPD_LISTEN_ADDR`                       | `0.0.0.0:5060`          | Bound by both transports.                                                                                                                                                                                                                                                                                                                                 |
| `SIPD_UDP` / `SIPD_TCP`                  | `true` / `true`         | Toggles. Leaving TCP off is not advisable: a REGISTER with a long Contact and several Vias exceeds the safe UDP MTU.                                                                                                                                                                                                                                      |
| `SIPD_TLS` / `SIPD_WS` / `SIPD_WSS`      | `false`                 | The secure and WebSocket transports, each opt-in. `ws`/`wss` are RFC 7118 and are the ONLY transport a browser softphone has. TLS floors at 1.3 — see `SIPD_TLS_MIN_VERSION`.                                                                                                                                                                             |
| `SIPD_TLS_LISTEN_ADDR`                   | `0.0.0.0:5061`          | The conventional SIP-over-TLS port.                                                                                                                                                                                                                                                                                                                       |
| `SIPD_WS_LISTEN_ADDR`                    | `0.0.0.0:5080`          | Plaintext WebSocket. A development origin only; anything a browser will load needs `wss`.                                                                                                                                                                                                                                                                 |
| `SIPD_WSS_LISTEN_ADDR`                   | `0.0.0.0:8089`          | The conventional SIP-over-WSS port.                                                                                                                                                                                                                                                                                                                       |
| `SIPD_TLS_CERT_FILE` / `_KEY_FILE`       | —                       | Required by `SIPD_TLS` and `SIPD_WSS`, and REFUSED when neither is on — a deployment with a certificate and no TLS believes it is encrypted and is not.                                                                                                                                                                                                   |
| `SIPD_TLS_MIN_VERSION`                   | `1.3`                   | The negotiated floor for the TLS/WSS listeners AND for outbound trunk connections. `1.2` is the only other accepted value; it exists for handset stacks that cannot do 1.3, admits only forward-secret AEAD suites, and is logged at WARN at boot so a deployment cannot drift down quietly.                                                              |
| `SIPD_TLS_RELOAD_INTERVAL`               | `30s`                   | How often the certificate files are stat'd for an out-of-band renewal. `SIGHUP` reloads immediately regardless. A reload swaps the certificate a handshake reads; no socket is rebound, so live registrations and dialogs survive an ACME renewal. A half-written or unparsable renewal is refused and the previous certificate stays in service.         |
| `SIPD_TLS_CLIENT_CA_FILE`                | unset                   | PEM bundle a carrier's CLIENT certificate must chain to. Setting it makes the TLS/WSS listeners ASK for a client certificate (mutual TLS for carrier trunks). Refused when neither TLS nor WSS is on.                                                                                                                                                     |
| `SIPD_TLS_REQUIRE_CLIENT_CERT`           | `false`                 | Turns "verify if given" into "require and verify". Only for an edge that terminates carriers alone — a listener shared with handsets cannot demand one. Needs `SIPD_TLS_CLIENT_CA_FILE`.                                                                                                                                                                  |
| `SIPD_TRUNK_TLS_CERT_FILE` / `_KEY_FILE` | unset                   | The CLIENT certificate this edge presents to carriers that ask for one. Must be set together. Per-trunk selection is by the CA list the carrier names in its CertificateRequest (RFC 8446 §4.4.2.1).                                                                                                                                                      |
| `SIPD_TRUNK_TLS_CA_FILE`                 | unset                   | CA pin for outbound carrier certificates, replacing the system roots. Applied per destination under the SNI name dialled; a carrier that fails the pin is refused with the trunk named.                                                                                                                                                                   |
| `SIPD_INVITE`                            | `false`                 | The INVITE surface, and with it the dialog claims, the instance lease, the reaper, the trunk supervisor and the `rpc.sip.v1.*` command server. Off by default because it needs a dialog-affine front end and the `trunks` / `sip-acl` buckets, not because the code is unfinished.                                                                        |
| `SIPD_INSTANCE_ID`                       | the hostname            | This process's identity on the backbone: it stamps every dialog claim and is the token engine commands are addressed at, because a dialog lives on ONE process.                                                                                                                                                                                           |
| `SIPD_SESSION_TIMERS`                    | `false`                 | RFC 4028. Off because a one-sided timer is worse than none, and because mediad's RTP timeout already reaps a far end that vanished. Mandatory in front of a carrier that offers `Supported: timer`.                                                                                                                                                       |
| `SIPD_SESSION_EXPIRES` / `SIPD_MIN_SE`   | `1800` / `90`           | Seconds. `SIPD_MIN_SE` may not go below 90 — RFC 4028 §4 sets that floor, and a shorter one turns every call into a re-INVITE storm.                                                                                                                                                                                                                      |
| `SIPD_SUBSCRIBE_MIN_EXPIRES`             | `60`                    | Seconds. The SUBSCRIBE expiry floor; below it a subscription is refused `423`.                                                                                                                                                                                                                                                                            |
| `SIPD_SUBSCRIBE_MAX_EXPIRES`             | `600`                   | Seconds. Above this a subscription is silently clamped down.                                                                                                                                                                                                                                                                                              |
| `SIPD_SUBSCRIBE_DEFAULT_EXPIRES`         | `600`                   | Seconds. Used when the SUBSCRIBE states no interval.                                                                                                                                                                                                                                                                                                      |
| `SIPD_MAX_CONTACTS`                      | `5`                     | Simultaneous registrations per AOR. The enforcement point for `extension.maxRegistrations`.                                                                                                                                                                                                                                                               |
| `SIPD_TRUNK_ACL`                         | unset                   | `cidr[=trunkId]`, comma-separated. Empty builds NO external profile, so no unauthenticated INVITE can be admitted at all — the only safe default.                                                                                                                                                                                                         |
| `SIPD_EXTERNAL_LISTEN_ADDR`              | unset                   | A socket of its own for the carrier profile. Stronger than sharing one: the profile is then chosen by the address the packet ARRIVED on, which no sender can influence.                                                                                                                                                                                   |
| `NATS_URL`                               | `nats://127.0.0.1:4222` | The backbone.                                                                                                                                                                                                                                                                                                                                             |
| `NATS_SIPD_USER` / `NATS_SIPD_PASS`      | unset                   | This process's own broker identity. `config/nats.conf` lets the `sipd` user publish `sip.reg.v1.>`, request `rpc.sip.v1.credential` and use the `registrations` bucket — nothing else. Half a pair fails at boot.                                                                                                                                         |
| `NATS_USER` / `NATS_PASS`                | unset                   | The shared operator credential, used only when the pair above is absent. Both pairs unset is a broker with no authentication, which is what the SIPp rig runs.                                                                                                                                                                                            |
| `NATS_TLS_CA`                            | unset                   | Path to a CA bundle. Setting it enables TLS and pins that CA. Unset is a plaintext connection.                                                                                                                                                                                                                                                            |
| `NATS_TLS_ENABLED`                       | `false`                 | TLS against the system trust store, for a certificate from a public issuer. `NATS_TLS_CA` takes precedence.                                                                                                                                                                                                                                               |
| `SIPD_MIN_EXPIRES`                       | `60`                    | Seconds. Below this a REGISTER gets `423` + `Min-Expires`.                                                                                                                                                                                                                                                                                                |
| `SIPD_MAX_EXPIRES`                       | `3600`                  | Seconds. Above this the grant is silently clamped down.                                                                                                                                                                                                                                                                                                   |
| `SIPD_DEFAULT_EXPIRES`                   | `300`                   | Seconds. Used when the REGISTER states no interval at all.                                                                                                                                                                                                                                                                                                |
| `SIPD_NONCE_TTL`                         | `1m`                    | Go duration. How long a challenge stays usable.                                                                                                                                                                                                                                                                                                           |
| `SIPD_NONCE_SECRET`                      | random per process      | **Set this fleet-wide before running more than one replica**, or a device challenged by instance A is rejected by instance B. 32+ random bytes.                                                                                                                                                                                                           |
| `SIPD_SWEEP_INTERVAL`                    | `5s`                    | How often lapsed bindings are noticed. Bounds event lateness, not binding lifetime.                                                                                                                                                                                                                                                                       |
| `SIPD_AUTH_LOCKOUT_THRESHOLD`            | `5`                     | Digest failures on one (source, account) pair before a lockout opens. `0` disables credential-spray protection entirely, and every attempt then costs a credential lookup.                                                                                                                                                                                |
| `SIPD_AUTH_LOCKOUT_SOURCE_THRESHOLD`     | `50`                    | Digest failures from one source across ALL accounts before the address is locked. Catches a spray spread thin over many extensions. `0` disables the source cap.                                                                                                                                                                                          |
| `SIPD_AUTH_LOCKOUT_BASE`                 | `30s`                   | Go duration. The first lockout, doubled on each subsequent one for the same key.                                                                                                                                                                                                                                                                          |
| `SIPD_AUTH_LOCKOUT_MAX`                  | `30m`                   | Go duration. The ceiling on that doubling.                                                                                                                                                                                                                                                                                                                |
| `SIPD_AUTH_LOCKOUT_WINDOW`               | `15m`                   | Go duration. Idle time after which a failure counter is forgotten, so a morning typo is not one attempt from a lockout in the afternoon.                                                                                                                                                                                                                  |
| `SIPD_CREDENTIAL_SOURCE`                 | `file`                  | `file` (development / the SIPp rig) or `nats` (**production** — `rpc.sip.v1.credential` against `apps/api`).                                                                                                                                                                                                                                              |
| `SIPD_CREDENTIALS_FILE`                  | —                       | Required when the source is `file`. See `config/credentials.example.json`.                                                                                                                                                                                                                                                                                |
| `SIPD_CREDENTIAL_TIMEOUT`                | `500ms`                 | Per-request deadline for the credential RPC — the contract's own. It sits inside a REGISTER transaction and a phone's retransmission timer starts at 500 ms, so a slower reply competes with the retry it caused.                                                                                                                                         |
| `SIPD_CREDENTIAL_CACHE_TTL`              | `30s`                   | How long a resolved credential is reused. Short: the alternative to staleness is an account disabled minutes ago that still registers.                                                                                                                                                                                                                    |
| `SIPD_CREDENTIAL_NEGATIVE_CACHE_TTL`     | `10s`                   | How long "no such account" / "disabled" is reused. This is the half that stops a username scanner becoming one database query per guess.                                                                                                                                                                                                                  |
| `SIPD_CREDENTIAL_CACHE_MAX_ENTRIES`      | `10000`                 | Cache ceiling. An unbounded negative cache keyed on an attacker-chosen username is a memory amplifier.                                                                                                                                                                                                                                                    |
| `SIPD_PROVISION_SECRET_KEY`              | —                       | **Normally unset.** Only the file store's derived form uses it (see below). Production sipd holds no derivation key at all.                                                                                                                                                                                                                               |
| `SIPD_USER_AGENT`                        | `optimiq-sipd`          | `Server:` / `User-Agent:` header.                                                                                                                                                                                                                                                                                                                         |
| `SIPD_LOG_LEVEL`                         | `info`                  | `debug` \| `info` \| `warn` \| `error`. Output is JSON on stdout (`log/slog`).                                                                                                                                                                                                                                                                            |
| `SIPD_SHUTDOWN_TIMEOUT`                  | `10s`                   | Bounds graceful shutdown.                                                                                                                                                                                                                                                                                                                                 |
| `SIPD_SOCKET_BUFFER_BYTES`               | `4194304`               | `SO_RCVBUF` / `SO_SNDBUF` on the UDP listeners. `0` leaves the kernel default. A REGISTER burst arrives faster than one reader drains it, and the overflow is dropped datagrams.                                                                                                                                                                          |
| `SIPD_PUBLISH_ASYNC_MAX_PENDING`         | `4096`                  | Unacknowledged JetStream publishes allowed in flight. Reaching it blocks the publisher, which is the backpressure against a stalled broker.                                                                                                                                                                                                               |
| `SIPD_PUBLISH_ASYNC_TIMEOUT`             | `30s`                   | How long one unacknowledged publish is held before it is reported failed.                                                                                                                                                                                                                                                                                 |
| `SIPD_HEALTH_ADDR`                       | unset                   | The private listener carrying readiness, liveness, Prometheus `/metrics` and (optionally) pprof. Unset serves none of them. It is also the only input to the `sipd healthcheck` subcommand, which is what a container health check runs.                                                                                                                  |
| `SIPD_PPROF`                             | `false`                 | Serve `net/http/pprof` on the health listener. Requires `SIPD_HEALTH_ADDR` to name a **loopback** host — these handlers dump heap and goroutine state, so a wildcard or external health address is refused at boot. `SIPD_PPROF_ADDR` is no longer read and FAILS at boot if set, so a deployment cannot believe it moved the profiler somewhere private. |

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

| Where      | Variable / row                                                                       | Why                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api` | `PROVISION_SIP_SECRET_KEY`                                                           | The root key. The **same value** the renderer used; rotating it invalidates every provisioned phone at once, which is the correct response to a compromise and the reason it is a deployment variable.                                                                                                                                                                    |
| `apps/api` | `PBX_DATABASE_URL`, `NATS_URL`                                                       | Without `NATS_URL` the PBX area mounts its REST surface and serves **no** RPC subjects, so no phone can register.                                                                                                                                                                                                                                                         |
| `pbx-db`   | an `org_setting` row: `category='sip'`, `name='realm'`, `value='"acme.example.com"'` | **The realm → organization directory.** `rpc.sip.v1.credential` carries no tenant — resolving one is the whole request — so the API needs to know which organization owns the realm sipd challenges with. Without it every lookup is refused with a `reason` naming this row. Two organizations claiming one realm is refused rather than resolved arbitrarily.           |
| `sipd`     | `SIPD_REALM`                                                                         | Only the fallback for a request that names no domain. A phone that puts the organization's own domain in its To/From is challenged for THAT realm, which is how one edge serves several tenants; `SIPD_REALM` need equal an `org_setting` value only for such nameless requests. It is inside `HA1`, so a mismatch there is an authentication failure, not a routing one. |

### Failure modes, and what each one looks like

| Situation                                                                     | sipd                                                          | Where to look                                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nobody subscribed to the subject (an `apps/api` deploy), or the RPC times out | `503`, `cannot look up the account … no responders available` | Not cached — the next REGISTER after the API returns succeeds. `503` and not `403`: no answer is not a claim about the account, and a phone that gets `403` stops retrying.   |
| Realm not mapped to an organization                                           | `403`                                                         | `apps/api` logs `refusing a credential lookup for an unmapped realm`. The phone learns nothing; the operator learns everything.                                               |
| Unknown extension, disabled extension, wrong password                         | `403`, identical status **and** reason phrase                 | Deliberate: a distinguishable answer is an extension enumerator. `found` and `enabled` stay separate on the RPC so the API's logs and any admin UI can still tell them apart. |
| `PROVISION_SIP_SECRET_KEY` unset on the API                                   | `403`                                                         | The renderer already refuses to emit a config without it, so such a deployment has no provisioned phones anyway.                                                              |
| Realm changed on one side only                                                | `403` for every account                                       | `HA1` is computed over the realm. Change it in both places and re-provision.                                                                                                  |

## Tests

```bash
# From the repo root (go.work covers apps/sipd and packages/events-go).
go vet ./apps/sipd/... ./packages/events-go/...
go test -race ./apps/sipd/... ./packages/events-go/...
gofmt -l ./apps/sipd ./packages/events-go     # must print nothing

# Integration suite: needs docker. Gated twice — build tag AND environment variable — so it never
# runs by accident. It starts one throwaway `nats:2.11 -js` container per test and removes it,
# including after a failure.
RUN_SIPD_INTEGRATION=1 go test -tags integration -timeout 10m ./apps/sipd/...
```

Three build tags gate the slow suites, all off by default: `integration` (a real broker), `e2e`
(registration, calls, IVR, trunks, tenancy, resilience, robustness and SDES against a real socket)
and `load`. The e2e and load suites drive `internal/testutil/sipua`, an in-repo SIP UA with its own
RTP and SDES-SRTP implementation, so a call can be placed and its audio inspected without SIPp.

The unit tests drive the real SIP handlers with wire-format requests (parsed by sipgo) and compute
their digest answers with `github.com/icholy/digest` — an independent client-side implementation of
RFC 2617 — so the server-side verifier is checked against something other than itself.

## Layout

```
cmd/sipd/main.go              wiring, signals, graceful shutdown, the healthcheck subcommand
internal/config               environment → validated Config, every error reported at once
internal/dialog               THE DIALOG LAYER — the state machine behind INVITE
  state.go                      State, Role, Trigger, and the pure transition table
  dialog.go                     Dialog + Apply: the effects each legal move produces
  effects.go                    the effect and event vocabularies
  identity.go                   the RFC 3261 §12 triple — data on the record, never the key
  cause.go                      RFC 3398 status→Q.850, RFC 3326 Reason, and the reverse
  offer.go                      the ONLY SDP reading here: RFC 4566 §6 direction, for hold/resume
  timers.go                     RFC 4028 session-timer negotiation and the refresher role
  reinvite.go                   re-INVITE and UPDATE, target refresh, 491
  store.go                      the dialog table and its per-instance ownership
  claims.go                     the `sip-dialogs` claim store, in memory and over KV
  session.go                    one goroutine per dialog: the mailbox that decides the races
internal/invite               the INVITE surface: admission, mid-dialog methods, Replaces
  intent.go                     INVITE → CallIntent, a pure function of the message
  port.go                       the ENGINE SEAM: Port, Admission, the refusal table, two fakes
  handler.go                    profile → auth → parse → dialog → admission
  executor.go                   effects → the wire, incl. the RFC 6026 2xx loop
  requests.go                   BYE / ACK / CANCEL builders, and the NAT destination split
  originate.go                  outbound INVITE to an AOR, a URI or a trunk
  renegotiate.go                engine-initiated re-INVITE (`rpc.sip.v1.reinvite`)
  replaces.go                   RFC 3891 correlation and the replaced dialog's teardown
  attestation.go                STIR/SHAKEN `Identity` parsing, carried on admission
internal/command              the `rpc.sip.v1.*` responder: ring, answer, hangup, reinvite,
                              originate and resolve-target, instance-scoped and queue-grouped
internal/reaper               one ticker: heartbeat this instance's claims, reap a dead peer's
internal/lease                this process's liveness key in `sip-instances`
internal/sipevents            `sip.evt.v1` dialog events, and the acknowledged finaliser
internal/nat                  rport/received, Contact rewrite, media-latch hints, expiry clamp
internal/profile              the internal/external trust boundary, the trunk ACL evaluator, and
                              the per-message listener provenance the boundary is chosen by
internal/acl                  the `sip-acl` read model as a longest-prefix evaluator
internal/trunk                the outbound gateway registration FSM and its status events
internal/aor                  the multi-contact location model: q-values, caps, RFC 5626 keys
internal/subscribe            RFC 6665 SUBSCRIBE/NOTIFY: `dialog` (BLF) and `message-summary` (MWI)
internal/presence             the read-only `presence` bucket view the BLF package notifies from
internal/mwi                  `voicemail.evt.v1.*.mwi.updated` → RFC 3842 message counts
internal/transfer             REFER: authorize, `rpc.sip.v1.transfer`, RFC 3515 NOTIFY reporting
internal/credentials          Credential + Store
  credentials.go                the Store interface, Credential, HA1
  file.go                       FileStore — development / SIPp rig, incl. the derived form
  derive.go                     the shared provisioning derivation, byte-exact with apps/api
  nats.go                       NATSStore — rpc.sip.v1.credential, the production store
  invalidate.go                 the `provision.evt.v1.*` credential.invalidated subscription
  testdata/derive_parity.json   golden vectors emitted BY the TypeScript implementation
internal/kv                   Binding + Store; the registrations KV bucket, plus an in-memory fake
internal/events               Publisher for `sip.reg.v1`; JetStream publisher plus a recording fake
internal/registrar            digest auth, the shared DigestGate, the lockout, expiry policy,
                              REGISTER/OPTIONS handlers, the expiry sweeper and rehydration
internal/metrics              the Prometheus surface, wrapped around handlers from outside
internal/siplog               filters sipgo's own logging, so a malformed datagram is not an ERROR
internal/testutil/sipua       the in-repo test UA: SIP, RTP and SDES-SRTP. Tests only.
*_integration_test.go         build-tagged suites against a real broker
e2e_*_test.go                 build-tagged suites against a real broker AND a real socket
load_*_test.go                build-tagged load harnesses
```

Four design notes worth knowing before changing anything:

- **The nonce is stateless.** A registrar that keeps nonces in a map breaks the moment there are two
  replicas behind a load balancer. The nonce carries its own expiry plus an HMAC keyed by
  `SIPD_NONCE_SECRET`; verification is a recomputation. A small replay guard on top rejects a reused
  nonce count. See `internal/registrar/auth.go`.
- **One digest pipeline, four methods.** REGISTER, INVITE, SUBSCRIBE and REFER all run
  `registrar.DigestGate`, so they share one throttle budget, one realm-scoped account key and one
  source identity (the HOST, so NAT port churn cannot split a counter). Only the SIP responses are
  per method. See `internal/registrar/digest.go`.
- **The credential root key lives in `apps/api`, not here.** The RPC returns an HA1 rather than a
  password or a `secretRef`, so the SIP edge holds nothing that derives another tenant's
  credential. `derive.go` exists to prove the two languages agree, and to let a dev fixture match
  what the renderer would have produced — not to run on the REGISTER path.
- **Expiry is a ticker over locally-granted bindings, not a KV watch.** The bucket's one-hour TTL is
  a backstop for a crashed registrar, not the expiry mechanism — granted intervals are 60–3600
  seconds, and waiting for the bucket would report a dead phone as reachable for up to an hour. A
  watch would also fire on every replica and publish one `expired` event per instance. See the `Run`
  doc comment in `internal/registrar/registrar.go`.
