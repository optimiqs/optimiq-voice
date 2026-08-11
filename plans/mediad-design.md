# `apps/mediad` — the Go media plane

**Status:** walking skeleton shipped; no call is served by it. Asterisk 22 is still the media plane.
**Plan refs:** §3.3 (polyglot), §3.4 option E + option table, §3.5 (NATS), PG (parallel Go track), §8 risk 1.
**Peer:** `apps/sipd` (SIP edge, same track, same idiom).

This document is the map for the whole `mediad` effort: the order capabilities are cut over in, the
seam in `apps/engine` that must hold while they are, the wire protocol between the two, and how
parity with Asterisk is proven rather than asserted. It also records what the first wave actually
built and what it deliberately did not.

The plan's claim (§8 risk 1) is that "the engine-facing contract is identical for `media-ari` and
`mediad`, so there is zero engine churn at swap". **§3 below shows that is currently true of
commands and false of events.** Closing that gap is the first real piece of work, and it is work in
`apps/engine`, not in `mediad`.

---

## 1. Scope, and what v0 is

`mediad` v1 scope, per §3.4: RTP, G.711/Opus/G.722, bridges, play/record, DTMF (RFC 4733), MOH —
behind the same engine contract as `packages/media-ari`, cut over per capability.

**v0 (this wave) is a walking skeleton and nothing more.** It proves the packet substrate that every
capability above sits on:

- a port-pair allocator over a configured range, which **binds** rather than counts;
- an RTP `Session` that receives, learns its far end from the packets themselves, and can put audio
  back on the wire;
- a raw-NATS command surface that allocates and releases one;
- a drain that does not leak ports.

Everything above that — bridging, playback, recording, mixing — is a consumer of exactly those
pieces. Bridging is two sessions forwarding to each other. Playback is a session sourcing frames
from a file instead of from a socket. Recording is a session teeing them. Building the substrate
first, and proving it with tests, is what makes those cheap.

**Library choice.** Pion, as §3.4 requires, but _only_ the pieces that are needed:
`github.com/pion/rtp` today for packet marshal/unmarshal, `github.com/pion/sdp` when SDP lands.
**Not `pion/webrtc`** — that pulls ICE, DTLS-SRTP, SCTP and a full peer-connection state machine to
solve a problem we do not have. SIP endpoints send plain RTP over UDP to an address in an SDP `c=`
line. If a WebRTC softphone (§7 T3) ever needs a real `PeerConnection`, that is a separate ingress
in front of the same session model, argued for on its own merits.

---

## 2. The capability cutover ladder

Per §3.4's sequencing rule, cutover is **per capability**, not per service. Asterisk keeps serving
everything not yet on a proven rung. Each rung is independently revertible by configuration.

| #   | Rung                           | What it adds                                                                         | Why here                                                                                                                        | Gate                                                                                            |
| --- | ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0   | **Substrate** _(done)_         | Port allocation, RTP receive/send, latching, control surface, drain                  | Everything else consumes it                                                                                                     | Unit suite, race-clean                                                                          |
| 1   | **SDP + one-legged media**     | `pion/sdp` offer/answer, real negotiation, `inactive`/`sendrecv`, playback of a file | The first rung that requires signalling integration; forces the sipd↔mediad boundary (§5) to be real                            | A call answered by mediad hears a prompt; MOS on the prompt                                     |
| 2   | **Bridged calls**              | Two sessions forwarding to each other; the minimal op set in §3.3                    | §3.4's named first cutover. Two-party audio is ~80% of PBX traffic                                                              | Engine integration suite green against mediad; SIPp basic-call; MOS/jitter vs Asterisk baseline |
| 3   | **DTMF (RFC 4733)**            | Digit detection out of the telephone-event stream, emitted as an engine event        | IVR, voicemail PINs and attended transfer all break without it. Shipped near-free by rung 2 (the payload already flows)         | Every DTMF unit test in the engine passes against mediad                                        |
| 4   | **Recording**                  | Tee a session's frames to a container; the `snoop` primitive                         | §3.4's second named rung. Needs no mixing — a tap on a bridged leg hears both parties                                           | Byte-comparable recording of a scripted call; retention/S3 path unchanged                       |
| 5   | **MOH + park/hold**            | A session sourcing from a loop instead of a peer                                     | Small once rung 1 exists (playback with a different source)                                                                     | Held-call audio; re-INVITE interop                                                              |
| 6   | **Conference mix-minus**       | N-way mixing, per-participant minus-self                                             | §3.4's third rung, and the hard one — this is where jambonz/LiveKit spent years. Needs a jitter buffer (§6) to sound acceptable | MOS at 3/5/10 participants; CPU per conference                                                  |
| 7   | **Opus / G.722 + transcoding** | Wideband, and the first real DSP                                                     | Deliberately after mixing: a mixer must decode anyway, so the codec layer is cheaper to build once mixing forces it             | Interop matrix; CPU per transcoded leg                                                          |
| 8   | **T.38**                       | Fax                                                                                  | §3.4 says last, and it is right: fax is a different protocol wearing RTP's clothes, low volume, high fiddliness                 | A real fax round trip                                                                           |

Asterisk is retired (§P6) only after rung 8. `packages/media-ari` and `apps/asterisk` stay until
then — they are the media plane, not scaffolding to delete early.

---

## 3. The engine seam

### 3.1 What exists: the command seam

`apps/engine/src/ari/media-port.ts` defines `MediaPort`, and its own doc comment states the
contract this whole effort depends on:

> `packages/media-ari` implements it today; `mediad`'s client will implement it tomorrow; the verb
> executor above it never learns which.

It is genuinely good. The vocabulary is domain vocabulary — `HangupCause`, milliseconds, playback
refs — and `apps/engine/src/ari/ari-media.adapter.ts` is the only file allowed to know ARI's shape.
24 methods, in three plan-phase groups:

- **P2 (call basics):** `answer`, `ring`, `play`, `stopPlayback`, `hangup`, `getVariable`,
  `setVariable`, `channelExists`, `watchChannel`
- **P3 (routing executor):** `originate`, `createBridge`, `addToBridge`, `removeFromBridge`,
  `destroyBridge`, `record`, `stopRecording`, `startMusicOnHold`, `stopMusicOnHold`
- **P4 (call control):** `hold`, `unhold`, `mute`, `unmute`, `sendDtmf`, `snoop`

A `MediadMediaAdapter implements MediaPort` sitting next to `AriMediaAdapter`, translating to the
subjects in §4, is a drop-in. **This half of the swap really is free.**

### 3.2 What does not exist: the event seam — the main finding of this wave

`MediaPort` is **commands only**. Events are not behind it.

`apps/engine/src/calls/channel-orchestrator.service.ts` (1,793 lines) imports `AriChannel` and
`AriEvent` _directly_ from `@optimiq-voice/media-ari` and branches on ARI's own event-type strings —
`StasisStart`, `StasisEnd`, `ChannelStateChange`, `ChannelDestroyed`, and the rest of the 21-member
`ARI_EVENT_TYPES` union. There are ~47 such references. `AriConnectionService.setEventHandler`
is typed `(event: AriEvent) => void`.

`apps/engine/src/calls/ari-mapping.ts` translates _values_ (Q.850 causes, call directions, channel
states) and says it is "the layer that makes the media server swappable". It is — for values. The
**event union itself** is not translated anywhere.

So the plan's zero-churn claim holds for the command direction and does not hold for the event
direction. **A `mediad` cutover as the code stands today would either require rewriting the
orchestrator, or require `mediad` to emit synthetic ARI events** — which would embed Asterisk's
vocabulary permanently in a service built to replace it, and is the wrong answer.

**The work, and it belongs in `apps/engine` before rung 2:**

1. Define `MediaEvent` — a domain-shaped discriminated union — next to `MediaPort`.
2. Add `toMediaEvent(ariEvent): MediaEvent | undefined` to `ari-mapping.ts`, the file that already
   owns ARI→domain translation.
3. Change the orchestrator to consume `MediaEvent`. This is the large, boring, mechanical change,
   and it is a **pure refactor with Asterisk still in place** — provable by the existing engine
   integration suite, with no media risk.
4. `mediad` then emits `MediaEvent` natively and neither side ever mentions ARI.

Doing step 3 while Asterisk is still the only backend is the whole point: it de-risks the cutover by
separating "change the engine's internal shape" from "change the media server", instead of doing
both at once on live calls.

### 3.3 The minimal operation set for bridged-call parity (rung 2)

Not all 24 methods. Rung 2 needs exactly this, and the rest keep going to Asterisk:

**Commands:** `answer`, `ring`, `hangup`, `originate`, `createBridge`, `addToBridge`,
`removeFromBridge`, `destroyBridge`, `channelExists`, `watchChannel`, `getVariable`, `setVariable`,
`play`, `stopPlayback`.

`play`/`stopPlayback` are in the list because ringback and "the number you dialled is unavailable"
are part of a bridged call, not a later feature.

**Events:** leg-arrived (`StasisStart`), leg-gone (`StasisEnd`), answered
(`ChannelStateChange`→`Up`), destroyed-with-cause (`ChannelDestroyed` — **the CDR depends on this
one**, and on `watchChannel` keeping the subscription alive past `StasisEnd`), bridge
created/destroyed, channel entered/left bridge, playback started/finished, DTMF received.

**Explicitly NOT in rung 2:** `record`, `stopRecording`, `snoop` (rung 4), `startMusicOnHold`,
`stopMusicOnHold`, `hold`, `unhold` (rung 5), `mute`, `unmute`, `sendDtmf` (rung 3).

Note what `MediaPort` deliberately leaves out and `mediad` must therefore never grow: **transfer and
park are not media operations.** Both are compositions of the primitives above plus routing the
media server knows nothing about. A media server that implemented them would be making routing
decisions on the far side of the seam.

---

## 4. The wire protocol

### 4.1 Transport: raw NATS, and this is not negotiable

**Commands: NATS core request-reply.** Not JetStream. A command is a synchronous question inside a
call setup whose answer is worthless a second later; persisting it would be storage for a message
nobody will re-read. This mirrors `rpc.sip.v1.credential`, which is core request-reply for exactly
the same reason.

**Every cross-language `rpc.*` subject MUST be served by a raw NATS subscription, never a NestJS
`@MessagePattern`.** This is a measured rule, recorded at the head of
`packages/events/src/schemas/rpc.ts` and in §PG of the master plan. Nest's NATS transport frames
request-reply as:

```text
request   {"pattern":"<subject>","data":{…the schema…},"id":"…"}
reply     {"response":{…the schema…},"isDisposed":true,"id":"…"}
```

A request carrying the bare contract payload is **not answered at all** — it times out. That is
invisible while both ends are Nest and fatal the moment one end is Go. `apps/api` serves
`rpc.sip.v1.credential` raw for this reason.

**The obligation is symmetric, and this direction is new.** Every prior case had a Go _caller_ and a
TS _responder_. Here the engine (TS) is the **caller** and `mediad` (Go) the **responder**, so the
rule inverts: the engine's `mediad` client must issue a **raw** `NatsConnection.request()`, **not**
`ClientProxy.send()`. A `ClientProxy` would wrap the payload in the framing above and `mediad` would
reject it as malformed. `apps/engine` already holds a raw NATS connection
(`apps/engine/src/nats/`), so this costs nothing — but it must be written down, because
`ClientProxy` is the idiomatic Nest thing to reach for and it is wrong here.

**Events: JetStream.** Media-session lifecycle events (`media.session.*`) are durable, because the
CDR consumer reads them and a CDR that is missing because a broker restarted is a billing defect.
Published with the envelope id as `Nats-Msg-Id`, exactly as `apps/sipd/internal/events` does, so a
retried publish is collapsed by the stream's duplicate window rather than double-counted.

The split is the same one the platform already makes everywhere: **ask over core, tell over
JetStream.**

### 4.2 Subjects

v0, today, defined in `apps/mediad/internal/control/control.go`:

| Subject                 | Kind               | Deadline |
| ----------------------- | ------------------ | -------- |
| `rpc.media.v0.allocate` | core request-reply | 500 ms   |
| `rpc.media.v0.release`  | core request-reply | 500 ms   |

`v0` is load-bearing: it means _this shape will change and nothing outside `mediad` and the engine's
`mediad` client may depend on it._

### 4.3 Why the subjects are NOT in `packages/events` yet

**Deliberate, and it must stay that way until rung 2.** `packages/events/src/schemas/rpc.ts` already
says so:

> `rpc.media.*` (engine → `mediad`) is deliberately absent: it arrives with `apps/mediad`, and
> inventing its shape before the media plane exists would be fiction.

`packages/events` is consumed by `apps/api`, `apps/engine` and `packages/events-go`; a field added
there is a field every service compiles against, and the codegen drift gate in CI enforces it. The
command set that bridged-call parity actually needs is not known until a real capability has been
built against it, and promoting a guess would freeze the guess.

**Promotion criteria — all four, then it becomes `rpc.media.v1.*` in `packages/events`:**

1. Rung 2 (bridged calls) works end to end against a real endpoint.
2. The command set has been stable across one full capability (i.e. rung 3 added no field to it).
3. SDP is in the payloads, so the shape reflects real negotiation rather than the v0
   `{port, ssrc}` stub.
4. The engine has a real `MediadMediaAdapter`, so there is a second implementer to disagree.

Until then the v0 constants live in `mediad` and the engine's client hard-codes them. That is a
known, bounded, two-file duplication with a written expiry, which is a better trade than a shared
contract that is wrong.

### 4.4 Payloads (v0)

`allocate` — request / reply:

```jsonc
{ "sessionId": "018f…", "callId": "018f…", "mode": "echo" }

{ "ok": true, "sessionId": "018f…", "address": "203.0.113.10",
  "rtpPort": 30000, "rtcpPort": 30001, "ssrc": 4277009102,
  "mode": "echo", "payloadTypes": [0, 8, 101] }
```

Three properties are load-bearing and carry forward to v1:

- **`sessionId` is caller-assigned.** Same reason `OriginateRequest.channelId` is client-assigned at
  the `MediaPort` seam: the caller must be able to release a session whose reply it never received.
  A server-assigned id means a timed-out allocate leaves a port held under a name nobody knows.
- **Allocate is idempotent on `sessionId`.** A retry returns the same session and does not open a
  second port, and does not mutate a live session's mode. Without this, every timed-out allocate
  leaks a port.
- **A refusal is a reply, never a silence.** `{"ok": false, "reason": "...", "error": "..."}` with a
  stable machine-readable `reason` the engine branches on: `bad_request` (retrying the same bytes
  fails the same way), `capacity` (a load signal — try another instance or fail with congestion),
  `shutting_down` (do not retry _here_), `internal`. A responder that stays silent on a request it
  dislikes is indistinguishable from a crashed one, and the caller pays the full timeout to learn
  nothing.

`address` is `MEDIAD_PUBLIC_IP`, never the bind address — it is what goes in an SDP `c=` line.

---

## 5. Who owns signalling glue: sipd vs mediad

**`sipd` owns SIP. `mediad` owns media. Neither owns the other, and `apps/engine` owns the
decision.** Concretely:

- `sipd` terminates SIP, authenticates, and hands the engine the **SDP body as opaque bytes**. It
  does not parse SDP beyond what proxying requires, and it never picks a codec.
- `apps/engine` decides _what the call is_ — which is the whole point of the engine — and asks
  `mediad` for the media resources that decision implies.
- `mediad` produces the SDP **answer** and consumes the SDP **offer**. It is the only process that
  knows which ports are free, which payload types it can actually handle, and what address is
  reachable. Anything else would be a second source of truth about mediad's own capabilities.

The engine is the courier between them: it carries SDP from `sipd` to `mediad` and back. That looks
like an extra hop and it buys the property the whole architecture rests on — **the SIP edge and the
media plane are independently swappable, because neither has a direct dependency on the other.**
Registration and location already live in NATS KV for the same reason (§3.4 sequencing rule).

This also settles a question rung 1 would otherwise force: **`mediad` never speaks SIP.** No SIP
stack, no dialog state, no re-INVITE handling of its own. When a re-INVITE arrives (hold, codec
change, transfer), `sipd` sees it, the engine decides, and `mediad` gets a command. A media server
with a SIP stack in it is how you get two processes disagreeing about dialog state.

---

## 6. RTP session model

**Ports.** One session owns one **pair**: an even RTP port and the odd RTCP port above it
(RFC 3550 §11). Capacity is therefore _(max−min+1)/2_ sessions, not _(max−min+1)_.
`MEDIAD_RTP_PORT_MIN` must be even; an odd start misaligns every pair in the range.

The default range is **30000–30999** (500 sessions), chosen to be **disjoint from Asterisk's
10000–20000** (`ASTERISK_RTP_PORT_START/END`). Both run on the same host for the entire cutover, and
two media servers sharing a range is a race whose loser is a call.

The allocator **binds** rather than bookkeeps. A range is a promise about what `mediad` _may_ use,
not about what is free — Asterisk, a stray process, or a previous `mediad` in `TIME_WAIT` can all
hold a port inside it. A counting allocator would hand out an unbindable port and the failure would
surface as a call with no audio. Binding turns it into a skip.

Allocation is **round-robin, not lowest-free.** A call that just ended leaves the far end sending
for a few hundred milliseconds; handing its port straight to the next call means a stranger's audio
fragment arrives on a live session. Cycling the range makes the reuse interval hundreds of calls
instead of zero.

**SSRC** is drawn per session from `crypto/rand`, not `math/rand`. A predictable SSRC is the handle
for injecting audio into a call, since receivers key on it. It costs one 4-byte draw per call.

**The far end is learned, not configured** — symmetric RTP, RFC 4961. Behind NAT the SDP carries a
private address the endpoint sincerely believes in, and the only address that works is the one the
NAT rewrote. **The latch freezes after the first packet:** an implementation that re-latched would
let anyone who can guess a port take over a call with a single UDP packet. The cost is that an
endpoint legitimately changing address mid-call (Wi-Fi→LTE) is cut off; the right place to fix that
is an authenticated re-INVITE from the signalling plane, not a heuristic in the packet path.

**Jitter buffer: none in v1, and that is a real decision, not an omission.**

- Rungs 2–5 are **relay** paths. Packets are forwarded, not decoded. A jitter buffer on a relay adds
  latency to fix jitter the _receiving endpoint's own_ buffer is already going to fix — every SIP
  phone has one. Adding a second buffer in the middle makes the call worse.
- Rung 6 (conference mixing) is where one becomes **mandatory**: a mixer must align frames from N
  sources on a common clock, and without a buffer the mix is garbage. It arrives with mixing, sized
  adaptively, and it applies only to mixed sessions.
- This is why rung 6 is late in the ladder and why §8 risk 1 names conferencing as the hard part.

**Concurrency:** one goroutine per session, blocked on `ReadFromUDP`. The kernel does the
multiplexing, each call's latency is independent, and a parked goroutine costs a few kilobytes. If a
profile ever says otherwise, the replacement is batched reads (`recvmmsg`) behind the same method —
which is why the read loop is the only thing that touches the socket.

**RTCP** is bound but not read in v0. Bound anyway, because an unbound odd port is one an unrelated
process can take, and the day RTCP is implemented the pairing would already be broken on exactly the
hosts that had been running longest.

---

## 7. Codec plan

**v1 is G.711 passthrough. No transcoding. Bytes in, same bytes out.**

- PCMU (PT 0) and PCMA (PT 8) are the two payload types every endpoint on earth supports, so
  passthrough covers the bridged-call cutover without a single DSP operation.
- RFC 4733 telephone-event (PT 101) rides alongside for DTMF. v0 recognises 101 by convention; real
  negotiation reads it from the SDP `a=rtpmap` and lands with rung 1.
- **A codec mismatch is resolved in SDP negotiation by refusing the offer, not in the media path by
  resampling.** That is what makes rung 2 achievable: no DSP, no CPU cliff, no audio-quality
  regression to argue about against Asterisk.
- An unexpected payload type on a live session is counted as the negotiation bug it is and dropped,
  never reflected.

Opus and G.722 arrive at **rung 7**, after mixing — because a mixer has to decode anyway, so the
codec layer is cheapest to build when mixing has already forced the decode/encode path into
existence. Building transcoding first would mean building it twice.

---

## 8. How parity is proven against Asterisk

Three layers. The first does not exist yet and is the highest-value thing to build.

### 8.1 A `MediaPort` conformance suite (new — build this)

Today `apps/engine/src/ari/media-port.fake.ts` backs nine unit specs, `AriMediaAdapter` has no spec
of its own, and there is **no suite that runs the same assertions against two implementations**.

Build one: export `describeMediaPortConformance(makePort: () => MediaPort)` and invoke it three
times — against `makeFakeMediaPort()` (always), against `new AriMediaAdapter(client)` under
`RUN_ARI_INTEGRATION_TESTS`, and against the `mediad` client under a new
`RUN_MEDIAD_INTEGRATION_TESTS`. This is what turns "the seam holds" from a claim into a test, and
it is worth building _before_ `mediad` implements anything, because it pins Asterisk's real
behaviour as the specification.

### 8.2 The engine integration suite, backend-swapped (the parity gate)

`apps/engine/test/engine-integration.spec.ts` is already the plan's parity gate. It gates on
`RUN_ENGINE_INTEGRATION_TESTS=true`, starts `nats:2.11-alpine -js` and a built `apps/asterisk`, and
asserts **only domain-level outcomes** — NATS subjects, KV snapshots, CDR rows. That last property
is what makes it reusable: the same file, run with the media backend swapped, is the parity proof.
It needs no new assertions, only a backend switch.

`packages/media-ari/src/ari-integration.spec.ts` is the shape to copy for the media-level drive:
originate → `StasisStart` → variable round-trip → answer → `Up` → hangup with Q.850 cause 21 →
`ChannelDestroyed` with `cause === 21`, plus "destroying an already-destroyed bridge is a no-op".

### 8.3 Go-side tests in `mediad`

Unit tests need **no broker** — that is why the control handlers are pure `[]byte → []byte`
functions over a `Sessions` interface, the same line `sipd` draws (`credentialFromReply` is tested
in-package; the transport is left to the gated suite).

Integration tests follow `sipd` exactly: `//go:build integration` **and** an env gate, with a
throwaway Docker NATS container.

```go
//go:build integration
```

```go
if os.Getenv("RUN_MEDIAD_INTEGRATION") != "1" { t.Skip("…needs docker") }
```

`.github/workflows/go-data-plane.yaml` **already watches `apps/mediad/**`** in its `paths:` filter,
so this costs one env var on the existing job, not a new workflow.

### 8.4 Media quality

Unit and integration tests prove _correctness_; they say nothing about whether a call _sounds_ right.
Rungs 2 and 6 additionally gate on **MOS and jitter measured against an Asterisk baseline on the same
hardware and the same script** (§3.4 sequencing rule). Absolute MOS numbers are close to meaningless;
the delta against the thing being replaced is not.

### 8.5 Cross-language contract parity

When the subjects are promoted (§4.3), they inherit the repo's existing parity idiom: golden vectors
emitted _by_ the TypeScript source of truth and asserted _by_ Go — as
`packages/events-go/parity_test.go` and `apps/sipd/internal/credentials/derive_test.go` already do,
with the codegen drift gate in `ci.yaml`.

---

## 9. What this wave shipped

```
apps/mediad/
├── go.mod                        module; pion/rtp + nats.go only
├── cmd/mediad/main.go            boot, NATS connect, subscribe, drain (sipd's shape)
└── internal/
    ├── config/config.go          env parsing, fail-fast, collects every problem
    ├── rtp/
    │   ├── allocator.go          binding round-robin port-pair allocator
    │   ├── session.go            one leg: receive, latch, echo; pion/rtp codec
    │   └── manager.go            lifecycle, idempotent allocate, idle reaper, drain
    └── control/control.go        raw-NATS rpc.media.v0.allocate / .release
```

Plus `go.work` (added the `use` line the file had reserved for it) and this document.

**Configuration.** `MEDIAD_BIND_IP`, `MEDIAD_PUBLIC_IP` (**required** — no safe default, and a wrong
value fails as _silence_, not as an error), `MEDIAD_RTP_PORT_MIN`/`_MAX`,
`MEDIAD_SESSION_IDLE_TIMEOUT`, `MEDIAD_SHUTDOWN_TIMEOUT`, `MEDIAD_LOG_LEVEL`.

**The NATS variables are unprefixed** — `NATS_URL`, `NATS_USER`, `NATS_PASS` — matching `apps/api`,
`apps/engine` and `apps/sipd`. The broker credential is one platform-account identity; a
`MEDIAD_`-prefixed alias would be a second name for one secret to drift between. The RTP knobs are
prefixed because they genuinely belong to this process alone. _(This deviates from the wave brief's
literal `MEDIAD_NATS_URL`; the repo-wide convention and its documented rationale won.)_

**Not touched, deliberately:** `packages/events` (§4.3), `apps/engine`, `apps/sipd`, `compose.yaml`.
**No compose service yet** — one arrives with the first real capability, because a service in the
compose file that serves no call is a thing to keep running and debug for no benefit.

---

## 10. Open questions for the next wave

1. **Where does the `MediaEvent` union live?** §3.2's refactor needs a home for the domain event
   type. `apps/engine/src/ari/media-port.ts` (next to `MediaPort`, but the directory is named `ari`)
   or `packages/telephony` (the domain package, but the engine is its only consumer)? Leaning
   `packages/telephony`, and renaming the engine's `ari/` directory to `media/` as part of the same
   refactor.

2. **How does the engine address a _specific_ `mediad` instance?** v0 uses a queue group, so NATS
   picks any instance — correct for allocate, wrong for everything after it, because a session lives
   on exactly one instance. Options: the allocate reply carries an instance-specific subject the
   engine uses thereafter (simple, no lookup, but the engine holds routing state); or a session
   directory in NATS KV keyed by `sessionId` (survives an engine restart, costs a KV read per
   command). **The KV directory is probably right**, because it is also the substrate for question 3.

3. **What does graceful drain mean for a media server?** v0 closes live sessions at shutdown, and
   the honest description is _calls on this instance lose audio_. There is no "finish the last
   request" — a session ends when a call ends, and a call can last hours. Real graceful drain means
   moving sessions to another instance, which needs the KV directory _and_ a re-INVITE from the
   signalling plane to repoint the far end. This is a genuine design problem, not a TODO, and it
   should be solved before `mediad` carries production traffic — not after.

4. **Does `sipd`'s proxy wave need to know about `mediad` at all?** §5 says no — the engine is the
   courier. Worth re-testing against the actual INVITE path when `sipd`'s proxy lands, because if it
   turns out the engine hop adds meaningful post-dial delay, the answer changes and the coupling has
   to be argued for explicitly rather than discovered.

5. **Is echo mode worth keeping past rung 1?** It exists to prove the packet path without a second
   party. Once bridging works, a test can use two real sessions instead. Keeping it costs a branch
   in the hot loop; deleting it costs the simplest possible smoke test. Lean: keep it, but move it
   behind an explicit "diagnostic" flag so it can never be reached by a production call path.

6. **RTCP: when?** Bound but unread today. It carries the receiver reports that are the _only_
   in-band signal of call quality, and the MOS/jitter gate in §8.4 will want them. Probably rung 2,
   as read-only telemetry, before anything depends on it.
