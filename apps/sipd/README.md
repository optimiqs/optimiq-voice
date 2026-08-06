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
        │  SIP EDGE                                              │
        │  scaffold: Routr (contained behind packages/sipnet)     │
        │  TARGET:   apps/sipd  ◀── you are here                  │
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

| Behaviour | Status |
| --- | --- |
| `REGISTER` with MD5 digest auth (`qop=auth`), 401 challenge + stale re-challenge | ✅ |
| Stateless nonce (HMAC over expiry + salt) — any instance verifies any instance's challenge | ✅ |
| AOR ownership check: an account may only bind its own address of record | ✅ |
| Expiry policy: min / max clamp, `423 Interval Too Brief` + `Min-Expires`, default interval | ✅ |
| Contact `expires` parameter overriding the `Expires` header | ✅ |
| De-registration on `Expires: 0`, and `Contact: *` + `Expires: 0` | ✅ |
| Registration query (`REGISTER` with no `Contact`) | ✅ |
| Binding written to the `registrations` KV bucket | ✅ |
| `sip.reg.v1` `registered` / `unregistered` / `expired` events on the `REGISTRATIONS` stream | ✅ |
| Background expiry sweeper + rehydration of another instance's bindings after a restart | ✅ |
| `OPTIONS` keepalive responder | ✅ |
| UDP + TCP listeners | ✅ |
| Everything else → `501 Not Implemented` | ✅ |

### Explicitly NOT implemented yet

| Gap | Why / when |
| --- | --- |
| **Credential lookup over NATS** | `SIPD_CREDENTIAL_SOURCE=file` is the only working store. The RPC contract (`rpc.sip.v1.credential`) does not exist in `packages/events` yet; `internal/credentials/nats.go` documents the intended request/response shape and fails loudly. |
| **Proxy / INVITE path** | The next PG wave. `sipd` answers 501 to INVITE rather than pretending. |
| **NAT traversal, `Record-Route`, `rport`/`received` rewriting on requests** | Comes with the proxy. Bindings already record the observed `sourceAddress`, which is the piece the proxy will need. |
| **TLS and WSS listeners** | sipgo supports both (`ListenAndServeTLS`); wiring plus certificate management is a deployment story, not a code one. |
| **Multiple simultaneous contacts per AOR** | The location model is one binding per AOR. Forking to a desk phone *and* a softphone needs a list-valued KV record; it is the first thing the proxy wave requires. |
| **Multi-realm / multi-domain** | One realm per process (`SIPD_REALM`). The `Registrar` holds no package-level state, so multi-realm is "construct more of them", not a rewrite. |
| **Nonce-count replay tracking** | Deliberate — see `internal/registrar/auth.go`. Rate limiting and the anti-fraud consumer on the `REGISTRATIONS` stream are the real mitigation, and they are control-plane concerns (plan §5 T1). |
| **`fail2ban`-style blocking** | Same: `sipd` publishes the events, the control plane decides. |

## Configuration

Everything is environmental; there are no flags. Invalid configuration fails at boot with **every**
problem listed at once, not one per restart.

| Variable | Default | Notes |
| --- | --- | --- |
| `SIPD_REALM` | — **required** | Digest realm. Part of `HA1 = MD5(user:realm:pass)`, so changing it invalidates every credential. No default on purpose. |
| `SIPD_LISTEN_ADDR` | `0.0.0.0:5060` | Bound by both transports. |
| `SIPD_UDP` / `SIPD_TCP` | `true` / `true` | Toggles. Leaving TCP off is not advisable: a REGISTER with a long Contact and several Vias exceeds the safe UDP MTU. |
| `NATS_URL` | `nats://127.0.0.1:4222` | The backbone. |
| `SIPD_MIN_EXPIRES` | `60` | Seconds. Below this a REGISTER gets `423` + `Min-Expires`. |
| `SIPD_MAX_EXPIRES` | `3600` | Seconds. Above this the grant is silently clamped down. |
| `SIPD_DEFAULT_EXPIRES` | `300` | Seconds. Used when the REGISTER states no interval at all. |
| `SIPD_NONCE_TTL` | `1m` | Go duration. How long a challenge stays usable. |
| `SIPD_NONCE_SECRET` | random per process | **Set this fleet-wide before running more than one replica**, or a device challenged by instance A is rejected by instance B. 32+ random bytes. |
| `SIPD_SWEEP_INTERVAL` | `5s` | How often lapsed bindings are noticed. Bounds event lateness, not binding lifetime. |
| `SIPD_CREDENTIAL_SOURCE` | `file` | `file` or `nats` (the latter is not implemented). |
| `SIPD_CREDENTIALS_FILE` | — | Required when the source is `file`. See `config/credentials.example.json`. |
| `SIPD_USER_AGENT` | `optimiq-sipd` | `Server:` / `User-Agent:` header. |
| `SIPD_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. Output is JSON on stdout (`log/slog`). |
| `SIPD_SHUTDOWN_TIMEOUT` | `10s` | Bounds graceful shutdown. |

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
internal/credentials          Credential + Store; FileStore (dev) and NATSStore (stub)
internal/kv                   Binding + Store; the registrations KV bucket, plus an in-memory fake
internal/events               Publisher; JetStream publisher, plus a recording fake
internal/registrar            digest auth, expiry policy, REGISTER/OPTIONS handlers, expiry sweeper
integration_test.go           build-tagged end-to-end suite against a real broker and a real socket
```

Two design notes worth knowing before changing anything:

- **The nonce is stateless.** A registrar that keeps nonces in a map breaks the moment there are two
  replicas behind a load balancer. The nonce carries its own expiry plus an HMAC keyed by
  `SIPD_NONCE_SECRET`; verification is a recomputation. See `internal/registrar/auth.go`.
- **Expiry is a ticker over locally-granted bindings, not a KV watch.** The bucket's one-hour TTL is
  a backstop for a crashed registrar, not the expiry mechanism — granted intervals are 60–3600
  seconds, and waiting for the bucket would report a dead phone as reachable for up to an hour. A
  watch would also fire on every replica and publish one `expired` event per instance. See the `Run`
  doc comment in `internal/registrar/registrar.go`.
