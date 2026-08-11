# apps/sipd — the Go SIP edge

`sipd` is the SIP signalling edge of Optimiq Voice: the thing desk phones, softphones and (later)
carriers talk to. It is written in Go on [sipgo](https://github.com/emiago/sipgo), per the master
plan's polyglot decision (`plans/optimiq-voice-master-plan.md` §3.1, §3.4 option E) — TypeScript is
the default everywhere in this repo, and Go is used where the 2026 industry consensus is Go.

**Today it is a REGISTRAR and nothing else.** That is deliberate: the first vertical proves the
whole path — SIP in, digest auth, a binding in NATS KV, typed events on JetStream, expiry — end to
end, before any of it carries a call.

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

| Behaviour                                                                                   | Status |
| ------------------------------------------------------------------------------------------- | ------ |
| `REGISTER` with MD5 digest auth (`qop=auth`), 401 challenge + stale re-challenge            | ✅     |
| Stateless nonce (HMAC over expiry + salt) — any instance verifies any instance's challenge  | ✅     |
| AOR ownership check: an account may only bind its own address of record                     | ✅     |
| Expiry policy: min / max clamp, `423 Interval Too Brief` + `Min-Expires`, default interval  | ✅     |
| Contact `expires` parameter overriding the `Expires` header                                 | ✅     |
| De-registration on `Expires: 0`, and `Contact: *` + `Expires: 0`                            | ✅     |
| Registration query (`REGISTER` with no `Contact`)                                           | ✅     |
| Binding written to the `registrations` KV bucket                                            | ✅     |
| `sip.reg.v1` `registered` / `unregistered` / `expired` events on the `REGISTRATIONS` stream | ✅     |
| Background expiry sweeper + rehydration of another instance's bindings after a restart      | ✅     |
| Credential lookup over `rpc.sip.v1.credential`, with a bounded positive+negative cache      | ✅     |
| `OPTIONS` keepalive responder                                                               | ✅     |
| UDP + TCP listeners                                                                         | ✅     |
| Everything else → `501 Not Implemented`                                                     | ✅     |

### Explicitly NOT implemented yet

| Gap                                                                         | Why / when                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cache invalidation on a provisioning change**                             | The credential cache expires by TTL (seconds), so a disabled extension can still register for up to `SIPD_CREDENTIAL_CACHE_TTL`. `NATSStore.Forget` is the seam a JetStream consumer on the provisioning stream will attach to; that consumer belongs with the provisioning wave. |
| **Proxy / INVITE path**                                                     | The next PG wave. `sipd` answers 501 to INVITE rather than pretending.                                                                                                                                                                                                            |
| **NAT traversal, `Record-Route`, `rport`/`received` rewriting on requests** | Comes with the proxy. Bindings already record the observed `sourceAddress`, which is the piece the proxy will need.                                                                                                                                                               |
| **TLS and WSS listeners**                                                   | sipgo supports both (`ListenAndServeTLS`); wiring plus certificate management is a deployment story, not a code one.                                                                                                                                                              |
| **Multiple simultaneous contacts per AOR**                                  | The location model is one binding per AOR. Forking to a desk phone _and_ a softphone needs a list-valued KV record; it is the first thing the proxy wave requires.                                                                                                                |
| **Multi-realm / multi-domain**                                              | One realm per process (`SIPD_REALM`). The `Registrar` holds no package-level state, so multi-realm is "construct more of them", not a rewrite.                                                                                                                                    |
| **Nonce-count replay tracking**                                             | Deliberate — see `internal/registrar/auth.go`. Rate limiting and the anti-fraud consumer on the `REGISTRATIONS` stream are the real mitigation, and they are control-plane concerns (plan §5 T1).                                                                                 |
| **`fail2ban`-style blocking**                                               | Same: `sipd` publishes the events, the control plane decides.                                                                                                                                                                                                                     |

## Configuration

Everything is environmental; there are no flags. Invalid configuration fails at boot with **every**
problem listed at once, not one per restart.

| Variable                             | Default                 | Notes                                                                                                                                                                                                             |
| ------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIPD_REALM`                         | — **required**          | Digest realm. Part of `HA1 = MD5(user:realm:pass)`, so changing it invalidates every credential. No default on purpose.                                                                                           |
| `SIPD_LISTEN_ADDR`                   | `0.0.0.0:5060`          | Bound by both transports.                                                                                                                                                                                         |
| `SIPD_UDP` / `SIPD_TCP`              | `true` / `true`         | Toggles. Leaving TCP off is not advisable: a REGISTER with a long Contact and several Vias exceeds the safe UDP MTU.                                                                                              |
| `NATS_URL`                           | `nats://127.0.0.1:4222` | The backbone.                                                                                                                                                                                                     |
| `NATS_SIPD_USER` / `NATS_SIPD_PASS`  | unset                   | This process's own broker identity. `config/nats.conf` lets the `sipd` user publish `sip.reg.v1.>`, request `rpc.sip.v1.credential` and use the `registrations` bucket — nothing else. Half a pair fails at boot. |
| `NATS_USER` / `NATS_PASS`            | unset                   | The shared operator credential, used only when the pair above is absent. Both pairs unset is a broker with no authentication, which is what the SIPp rig runs.                                                    |
| `NATS_TLS_CA`                        | unset                   | Path to a CA bundle. Setting it enables TLS and pins that CA. Unset is a plaintext connection.                                                                                                                    |
| `NATS_TLS_ENABLED`                   | `false`                 | TLS against the system trust store, for a certificate from a public issuer. `NATS_TLS_CA` takes precedence.                                                                                                       |
| `SIPD_MIN_EXPIRES`                   | `60`                    | Seconds. Below this a REGISTER gets `423` + `Min-Expires`.                                                                                                                                                        |
| `SIPD_MAX_EXPIRES`                   | `3600`                  | Seconds. Above this the grant is silently clamped down.                                                                                                                                                           |
| `SIPD_DEFAULT_EXPIRES`               | `300`                   | Seconds. Used when the REGISTER states no interval at all.                                                                                                                                                        |
| `SIPD_NONCE_TTL`                     | `1m`                    | Go duration. How long a challenge stays usable.                                                                                                                                                                   |
| `SIPD_NONCE_SECRET`                  | random per process      | **Set this fleet-wide before running more than one replica**, or a device challenged by instance A is rejected by instance B. 32+ random bytes.                                                                   |
| `SIPD_SWEEP_INTERVAL`                | `5s`                    | How often lapsed bindings are noticed. Bounds event lateness, not binding lifetime.                                                                                                                               |
| `SIPD_CREDENTIAL_SOURCE`             | `file`                  | `file` (development / the SIPp rig) or `nats` (**production** — `rpc.sip.v1.credential` against `apps/api`).                                                                                                      |
| `SIPD_CREDENTIALS_FILE`              | —                       | Required when the source is `file`. See `config/credentials.example.json`.                                                                                                                                        |
| `SIPD_CREDENTIAL_TIMEOUT`            | `500ms`                 | Per-request deadline for the credential RPC — the contract's own. It sits inside a REGISTER transaction and a phone's retransmission timer starts at 500 ms, so a slower reply competes with the retry it caused. |
| `SIPD_CREDENTIAL_CACHE_TTL`          | `30s`                   | How long a resolved credential is reused. Short: the alternative to staleness is an account disabled minutes ago that still registers.                                                                            |
| `SIPD_CREDENTIAL_NEGATIVE_CACHE_TTL` | `10s`                   | How long "no such account" / "disabled" is reused. This is the half that stops a username scanner becoming one database query per guess.                                                                          |
| `SIPD_CREDENTIAL_CACHE_MAX_ENTRIES`  | `10000`                 | Cache ceiling. An unbounded negative cache keyed on an attacker-chosen username is a memory amplifier.                                                                                                            |
| `SIPD_PROVISION_SECRET_KEY`          | —                       | **Normally unset.** Only the file store's derived form uses it (see below). Production sipd holds no derivation key at all.                                                                                       |
| `SIPD_USER_AGENT`                    | `optimiq-sipd`          | `Server:` / `User-Agent:` header.                                                                                                                                                                                 |
| `SIPD_LOG_LEVEL`                     | `info`                  | `debug` \| `info` \| `warn` \| `error`. Output is JSON on stdout (`log/slog`).                                                                                                                                    |
| `SIPD_SHUTDOWN_TIMEOUT`              | `10s`                   | Bounds graceful shutdown.                                                                                                                                                                                         |

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
