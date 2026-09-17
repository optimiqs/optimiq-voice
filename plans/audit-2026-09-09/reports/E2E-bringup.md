# Bring-up findings — product bugs and blockers

Everything below was hit while bringing the real platform up natively from HEAD 3bd98f2 and driving
a browser-to-browser call through it. Four are product bugs; two are mine, recorded because they
shaped the scripts.

---

## 1. `apps/sipd` serves the plaintext WebSocket listener over TLS — FIXED

**`apps/sipd/cmd/sipd/main.go:449`** (before the fix)

```go
case strings.HasSuffix(network, "s") && tlsConfig != nil:
    err = server.ListenAndServeTLS(listenCtx, network, addr, tlsConfig)
```

`listen()` is called with the networks `udp`, `tcp`, `tls`, `ws` and `wss`. `HasSuffix(network, "s")`
is true for **`ws`** as well as `tls` and `wss`. `tlsConfig` is non-nil whenever `SIPD_TLS` _or_
`SIPD_WSS` is set, so in any deployment that terminates WSS — which is every deployment that allows
browser calling — the plaintext `ws` listener is silently served as TLS.

**Evidence.** With `SIPD_WS=true` and `SIPD_WSS=true`, sipd logged the WS port under the wrong
network, having actually bound it as TLS:

```
{"msg":"listening","network":"wss","addr":"127.0.0.1:5188"}   <-- SIPD_WS_LISTEN_ADDR
{"msg":"listening","network":"wss","addr":"127.0.0.1:8189"}   <-- SIPD_WSS_LISTEN_ADDR
```

A client connecting with `ws://` gets a TLS handshake and fails, and nothing in the logs says why —
the listener reports itself as ready. The comment three lines above the call site
("Plaintext `ws` is for a development origin") states the intent the code does not implement.

**Fix applied** — name the two secure networks instead of pattern-matching the suffix:

```go
case (network == "tls" || network == "wss") && tlsConfig != nil:
```

**Verified.** After the fix the same configuration binds `127.0.0.1:5188` in the clear and
`127.0.0.1:8189` with TLS. A raw WebSocket upgrade on 5188 answers `HTTP/1.1 101 Switching
Protocols`; a TLS handshake on 8189 completes with `TLS_AES_128_GCM_SHA256`. `go build`, `go vet`
and `go test ./...` clean in `apps/sipd`; the WSS smoke call still passes end to end.

---

## 2. The PBX baseline migration is not idempotent across a shared cluster — FIXED

**`packages/pbx-db/drizzle/20260805204846_pbx_baseline/migration.sql:1`**

```sql
CREATE ROLE "pbx_tenant_tls" WITH NOINHERIT;
```

Postgres roles are **cluster-wide**, not per-database. Dropping and recreating `optimiq_pbx` in a
cluster that still holds the role — a restore-from-backup, a blue/green cutover, or simply resetting
a development database — fails the journal on its first statement:

```
DrizzleQueryError: Failed query: CREATE ROLE "pbx_tenant_tls" WITH NOINHERIT;
  cause: PostgresError: role "pbx_tenant_tls" already exists
```

This is not a hypothetical: the CDR and API baselines both carry a hand-written existence guard for
exactly this reason, with the comment _"roles are cluster-wide, and the CDR database shares a cluster
with the PBX database in every environment, so creation must tolerate a role that already exists."_
The PBX baseline was the one that was missed.

**Fix applied** — the same guard the other two journals already use, so all three now agree.

**Note on safety for existing installs:** drizzle's postgres-js migrator decides what to apply from
the migration folder's timestamp, not the stored hash, so editing an already-applied baseline does
not re-run it anywhere. This only changes what a _fresh_ install does.

---

## 3. `apps/engine`'s `start:dev` script cannot start the engine — NOT FIXED, reported

**`apps/engine/package.json`**: `"start:dev": "tsx watch src/main.ts"`

`tsx` compiles with esbuild, which does not implement `emitDecoratorMetadata`. The engine injects
most of its providers by **bare class type** (`private readonly jetstream: JetStreamService`, and
~40 more across `calls/`, `nats/`, `queue/`, `routing/`, `media/` and `health/`), which Nest resolves
from `design:paramtypes`. Without that metadata every such parameter arrives as `undefined` and the
container refuses to build:

```
Nest can't resolve dependencies of the SipRenegotiateService (Symbol(engine/Env), ?, Symbol(engine/MediaPort)).
```

The two tokens injected with an explicit `@Inject(...)` resolve; only the bare class fails. The
documented startup path is unaffected — `"start": "node dist/main.js"` works, and that is what this
stack runs — but the dev script has no chance of working as written.

`apps/api` is not affected: it uses an explicit `@Inject(...)` on every constructor parameter, which
is why its `start:dev` runs under `tsx` fine.

**Not fixed** because the choices are all larger than a bring-up change: swap the engine to
`ts-node`/`swc` for dev, or add `@Inject(X)` to roughly forty constructor parameters. Either is a
deliberate call for the engine's owners. The workaround is in `up.sh` with a comment pointing here.

---

## 4. `docs/native-calling-deployment.md` understates the runtime-role grants

The deployment doc tells an operator to _"grant connection, public-schema usage, table DML and
sequence usage"_ to the three runtime logins. Following that exactly produces an API that boots and
then cannot write a CDR:

```
could not warm the CDR partition horizon; it will be ensured per leg
  Failed query: select cdr_ensure_monthly_partition($1, $2::date)
  ERROR: permission denied for function cdr_ensure_monthly_partition
```

`cdr_ensure_monthly_partition` and `cdr_drop_partitions_before` are `SECURITY DEFINER` functions the
CDR leg writer calls at boot and again per leg, so the runtime login needs **EXECUTE** on them. The
message is logged at error level and then swallowed ("it will be ensured per leg"), so the failure
surfaces much later as missing call history rather than at startup.

**Handled in this stack** by granting `EXECUTE ON ALL FUNCTIONS IN SCHEMA public` plus the matching
default privilege in `.scripts/local-stack/provision-roles.sql`. **The documentation itself is not
changed** — the doc's grant list should gain the EXECUTE line, and arguably the CDR writer should
fail loudly at boot rather than log-and-continue, but both are the owners' calls.

---

## 5. `PROVISION_SIP_WSS_URL` forces TLS on a loopback development stack — observation, no change

`apps/api/src/provisioning/provisioning-env.ts:96` requires the URL to match `/^wss:\/\//`, and
`superRefine` makes it mandatory whenever `PROVISION_WEBRTC_ENABLED` is set. There is no way to run
browser calling against a plain `ws://` edge, even on loopback where the transport is not crossing
anything. That is the right default for a deployment and an obstacle for a local one: this stack has
to generate a self-signed certificate and launch Chromium with `--ignore-certificate-errors`.

Not a bug — the constraint is deliberate and documented — but it is the reason the plain WS listener
on 5188 exists in this stack and goes unused by the browser legs, and it is why bug #1 was invisible
until now: nothing in the repository's own test suites brings up `SIPD_WS` and `SIPD_WSS` together.

---

## 6. Two defects in my own scripts, fixed during bring-up

Recorded because both are the kind of thing that silently half-starts a stack:

- `lib.sh`'s `port_holder` ran `lsof | awk | sort | paste` under `set -o pipefail`. `lsof` exits 1
  when it matches nothing — which is the _normal_ case for a free port — so the whole pipeline
  failed and `set -e` killed `up.sh` immediately after the first port check, with no message.
- `up.sh` checked port availability before checking whether the service was already running under
  its own pid file, so a second `up.sh` aborted on "port already held by" naming its own process.
  Both port checks and the build steps are now conditioned on the service actually being down.

---

## Things I could not verify

- **Carrier / trunk paths.** sipd's external profile is listening on 5162 and the `sip-acl` and
  `trunks` buckets are populated, but no carrier is configured and no trunk call was placed.
- **TURN.** coturn was never started; both browser legs connected on host candidates over loopback,
  so the relay path and `PROVISION_TURN_*` are untested here.
- **Recording, voicemail, queues, ring groups, transfer, conferences.** The smoke call exercises
  extension-to-extension calling, hold/resume, hangup and CDR only. The object store is wired and
  writable but nothing has written a recording to it.
- **The live wallboard.** Not checked. "Wallboard" in this codebase is a _queue_ surface
  (`apps/api/src/pbx/queues/`), so it needs a queue, an agent and a queue call — none of which the
  extension-to-extension smoke call sets up. I removed a probe that would have reported a pass
  without proving anything. The brief's wallboard requirement is **not** met.
- **Anything about capacity, resilience or load.** Single instance of every service.
