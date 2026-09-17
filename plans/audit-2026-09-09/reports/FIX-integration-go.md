# FIX — integration (Go data plane: apps/sipd, apps/mediad)

## 1. Cross-area contract adoption

### FIXED — `apps/sipd/internal/acl/acl.go` now uses the generated contract type

- `Record` is now `type Record = contract.SIPACLEntry` (alias, so the JSON round-trip keeps the
  generated `MarshalJSON`/`UnmarshalJSON` with `Extra` passthrough). The hand-written mirror is gone
  along with the fields the writer never emits (`id`, `description`) and the field name that was
  simply wrong (`organizationId` where the writer emits `orgId`).
- The doc comment claiming "there is no `sipAclEntrySchema`" is replaced with one that says the type
  IS the generated contract.
- `ScopeTrunk` is now `contract.SIPACLEntryScopeTrunk` (typed constant) rather than a loose `"trunk"`.
- An alias cannot carry methods, so `Record.Entry`/`Record.Applies`/`Record.label` became package
  functions `compile(r)`, `applies(r)`, `label(r)`; `deref` handles the generated `*string`
  optionals (`trunkId`, `name`). Behaviour is unchanged: same specificity/priority/deny rules, same
  scope+enabled filter, same `priorityOf` inversion.
- Tests updated to the contract shape: `internal/acl/acl_test.go` (`OrgID`, typed action/scope,
  `*string` trunk id) and `command_integration_test.go`. `TestTheSIPACLWatchDeliversAnEntry` now
  exercises the real wire shape end to end and passes against a live broker.

### LEFT — the presence and media-session KV mirrors (with reasons)

`apps/sipd/internal/presence.State = contract.ExtensionPresence` and
`apps/mediad/internal/directory.Entry = contract.MediaSessionDirectoryEntry` were NOT switched to
`ExtensionPresenceValue` / `MediaSessionDirectoryValue`. They are not pure drop-ins:

- optional strings are `*string` in the generated types (`writtenBy`; `legId`, `codec`, `bridgeId`)
  and plain `string` in the mirrors — every read and write site in both apps would need
  deref/address-of churn;
- timestamps are `float64` in the generated types (`updatedAt`, `allocatedAt`) and `int64` epoch
  milliseconds in the mirrors, which is a real numeric-precision decision, not a rename;
- presence `state` is the generated `ExtensionPresenceValueState`, a second vocabulary alongside the
  `PresenceDeviceState` that `packages/events-go/presence.go` already exports and that sipd's
  subscribe/NOTIFY path uses.
  That is a contract decision (which representation wins), not a mechanical swap, so it is left for
  the schema owner — see "Cross-area needed".

## 2. Gated integration suites

### How they locate a broker (and what was added)

`apps/sipd`'s five `//go:build integration` files are gated by `RUN_SIPD_INTEGRATION=1` and start
their own broker; both helpers were docker-only (`docker run nats:2.11 -js`, and a second one that
bind-mounts `config/nats.conf` with the twelve `NATS_*_USER/PASS` variables). There is no
`NATS_URL`-style hook and no testdata fixture. This machine has no docker, so `integration_test.go`
gained a local-binary path, used only when the env var is set:

- `NATS_SERVER_BIN=<path>` → `startNATS` spawns `<bin> -a 127.0.0.1 -p <free port> -js -sd <t.TempDir()>`;
  `startNATSWithPlatformConfig` spawns it with `-c config/nats.conf`, `-p`/`-m` on free ports.
- `requireIntegration` accepts either docker or `NATS_SERVER_BIN`; docker remains the default.
- One wrinkle, recorded in the helper's comment: `-sd` alongside the config's `jetstream { store_dir }`
  is rejected by nats-server as `Duplicate 'store_dir' configuration`. So under `-c` the file is
  copied to a temp path with the single line `store_dir: "/data"` rewritten and NOTHING else — every
  account, user and permission under test is the deployed one.
- Refactors extracted from the existing bodies: `waitForJetStream`, `waitForSipdLogin`, `freePort`,
  `startLocalNATS`, `startLocalNATSWithConfig`.

`apps/mediad` has no `integration` build tag and no broker-backed suite. Its only gated test is
`internal/control/browser_integration_test.go`, gated by `RUN_BROWSER_WEBRTC=1` plus
`PLAYWRIGHT_MODULE` — a real Chromium over WebRTC, no NATS involved.

### What ran, against what

Broker: `scratchpad/bin/nats-server` **v2.14.6**, JetStream on a free loopback port, per-test store
in `t.TempDir()`.

`cd apps/sipd && RUN_SIPD_INTEGRATION=1 NATS_SERVER_BIN=… go test -tags integration -race -timeout 15m -v .`
→ **14 tests, 14 PASS, 0 FAIL** (`ok … 12.538s`):
plain `-js` broker — TestCommandSubjectsAreReachableOnTheirInstanceToken,
TestOriginateIsReachableOnTheFlatSubject, TestAnOrphanedClaimIsReapedAcrossInstances,
TestTheSIPACLWatchDeliversAnEntry, TestTheTrunkDirectoryWatchDeliversARecord,
TestRegisterAuthenticatesAgainstACredentialDerivedByTheAPI,
TestRegisterFailsClosedWhenNobodyAnswersTheCredentialRPC, TestRegisterBindsPublishesAndExpires,
TestDeregisterRemovesTheBinding, TestOptionsAndUnsupportedMethodsOverTheWire,
TestBlfSubscriptionLightsFromThePresenceBucket;
**against `config/nats.conf`** (accounts + per-stream grants, `NATS_*_USER/PASS` set to `*-it` /
test password) — TestCarrierCredentialRepliesStayWithinSIPService,
TestSipdPresenceGrantsUnderThePlatformConfig, TestConcurrentRegistrationUpdatesAgainstProductionNATS.

`cd apps/mediad && RUN_BROWSER_WEBRTC=1 PLAYWRIGHT_MODULE=<repo>/node_modules/playwright go test -race -run TestChromiumWebRTCAudioAndRecording ./internal/control/`
→ **PASS**, both subtests (`browser-originated`, `server-originated`), `ok … 4.733s`.

### Permission violations

**No missing grant. `config/nats.conf` was NOT modified.** The one violation the run printed is the
assertion the test exists to make — sipd must not be able to forge a lamp:

```
nats: permissions violation: Permissions Violation for Publish to "$KV.presence.018f4f5e-1c2a-7a3b-9c4d-5e6f70819293.1002" on connection [8]
```

emitted inside `TestSipdPresenceGrantsUnderThePlatformConfig`, which PASSES on it. Everything the
sipd account legitimately needs under the rewritten per-stream grants — opening, reading and
`WatchAll`-ing `KV_presence` (bare `$JS.API.CONSUMER.CREATE.KV_presence` form included), the MWI
event family, the registrations stream under concurrent atomic updates, and the carrier-credential
RPC staying inside the SIP service — succeeded.

## 3. Additional fix found by running the suites

**`TestDeregisterRemovesTheBinding` asserted the pre-guard behaviour** — deterministic
`de-register = 401 Unauthorized`, 3/3 runs. The test re-sent the _same_ `Authorization` header for
the `Expires: 0` REGISTER, and the sipd fix agent's new RFC 2617 §3.2.1 nonce-count replay guard
(`internal/registrar/auth.go`, `ErrNonceReplayed`) correctly refuses a nonce count it has already
accepted. The guard is right; the test was wrong (a real phone increments `nc`). Fixed by giving
`sipClient` a monotonic `nonceCount` used by `authenticateAs`/`answerFor`, and answering the
challenge afresh for the de-register. This is a genuine catch: the guard shipped with no integration
coverage proving a _legitimate_ second request still succeeds — now it has some.

## Cross-area needed

- `packages/events` / `packages/events-go`: decide the representation for the presence and
  media-session KV values (pointer optionals vs empty string; `float64` vs `int64` millis;
  `ExtensionPresenceValueState` vs the existing `PresenceDeviceState`). Once the generated types
  match one of those, sipd's `presence.State` and mediad's `directory.Entry` aliases can point at
  them and `presence.go` / `media_sessions.go` mirrors can be deleted.
- CI: the sipd integration job can now run without a container runtime by setting `NATS_SERVER_BIN`
  to a `nats-server` on PATH; worth wiring so these suites stop being effectively never-run.

## Verification (exact final output)

- `packages/events-go`: `go build ./...` → clean (untouched).
- `apps/sipd`: `gofmt -l .` → no output. `go vet ./...` → clean. `go vet -tags integration ./...` →
  clean. `go test -race -count=1 ./...` → **18 packages ok, 0 FAIL** (2 packages have no test files).
  `go test -tags integration -race .` → **14/14 PASS**, `ok … 12.538s`.
- `apps/mediad`: `gofmt -l .` → no output. `go vet ./...` → clean. `go test -race ./...` →
  **6 packages ok, 0 FAIL** (audio, config, control, rtp, sdp, webrtc; 3 have no test files).
  Gated browser suite: **PASS**.
