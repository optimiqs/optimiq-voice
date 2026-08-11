# `apps/mediad` — the Go media plane

**Status:** **rungs 1 and 2 shipped** — SDP offer/answer, bridged G.711 calls with RFC 4733 DTMF,
WAV file playback with barge-in, an RTP session directory in NATS KV, and a lifecycle event family. The contract is promoted to
`packages/events` as `rpc.media.v1.*` + `media.evt.v1.*`, and `apps/engine` has a real
`MediadMediaPort` behind `ENGINE_MEDIA_DRIVER=ari|mediad` (default `ari`). **Asterisk 22 is still
the media plane for every deployment that has not opted in, and for every rung above 2 in all of
them.**
**Plan refs:** §3.3 (polyglot), §3.4 option E + option table, §3.5 (NATS), PG (parallel Go track), §8 risk 1.
**Peer:** `apps/sipd` (SIP edge, same track, same idiom).

This document is the map for the whole `mediad` effort: the order capabilities are cut over in, the
seam in `apps/engine` that must hold while they are, the wire protocol between the two, and how
parity with Asterisk is proven rather than asserted. It also records what the first wave actually
built and what it deliberately did not.

The plan's claim (§8 risk 1) is that "the engine-facing contract is identical for `media-ari` and
`mediad`, so there is zero engine churn at swap". §3 below showed that was true of commands and
false of events. **That gap is now closed**: `apps/engine/src/media/media-event.ts` holds a
twelve-member domain `MediaEvent` union, `calls/ari-mapping.ts` translates ARI into it, and
`media/mediad-event-mapping.ts` translates `mediad` into it. Neither the orchestrator nor the verb
executor mentions either media server.

---

## 1. Scope, and where the service is

`mediad` v1 scope, per §3.4: RTP, G.711/Opus/G.722, bridges, play/record, DTMF (RFC 4733), MOH —
behind the same engine contract as `packages/media-ari`, cut over per capability.

**Rungs 0, 1 and 2 are built.** Rung 1's negotiation half arrived with rung 2, because bridging
needs SDP; its playback half is this wave. What exists:

- a port-pair allocator over a configured range, which **binds** rather than counts;
- an RTP `Session` that receives, learns its far end from the packets themselves, and can put audio
  back on the wire;
- SDP offer/answer for G.711 with RFC 4733 negotiated rather than assumed;
- a two-party RELAY, which is what a bridged call is;
- WAV decoding to G.711, 20 ms packetisation, and a session that sources frames from a file
  instead of a socket — replacing the peer's audio while it plays and resuming the relay after;
- a promoted `rpc.media.v1.*` command surface and a `media.evt.v1.*` lifecycle family;
- a NATS KV session directory, so a second instance can route or refuse correctly;
- a drain that does not leak ports and says on the wire that it cost audio.

Everything above that — playback, recording, mixing — is a consumer of exactly those pieces.
Playback is a session sourcing frames from a file instead of from a socket. Recording is a session
teeing them. Building the substrate first, and proving it with tests, is what made bridging cheap.

**Library choice.** Pion, as §3.4 requires, but _only_ the pieces that are needed:
`github.com/pion/rtp` for packet marshal/unmarshal and `github.com/pion/sdp/v3` for parsing an
offer. The ANSWER is written by hand rather than marshalled: it is twelve lines, every one of them
is a decision this service has to be able to justify, and going through a generic object model would
hide which of them `mediad` actually controls.
**Not `pion/webrtc`** — that pulls ICE, DTLS-SRTP, SCTP and a full peer-connection state machine to
solve a problem we do not have. SIP endpoints send plain RTP over UDP to an address in an SDP `c=`
line. If a WebRTC softphone (§7 T3) ever needs a real `PeerConnection`, that is a separate ingress
in front of the same session model, argued for on its own merits.

---

## 2. The capability cutover ladder

Per §3.4's sequencing rule, cutover is **per capability**, not per service. Asterisk keeps serving
everything not yet on a proven rung. Each rung is independently revertible by configuration.

| #   | Rung                                | What it adds                                                                         | Why here                                                                                                                        | Gate                                                                                            |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0   | **Substrate** _(done)_              | Port allocation, RTP receive/send, latching, control surface, drain                  | Everything else consumes it                                                                                                     | Unit suite, race-clean                                                                          |
| 1   | **SDP + one-legged media** _(done)_ | `pion/sdp` offer/answer, real negotiation, `inactive`/`sendrecv`, playback of a file | The first rung that requires signalling integration; forces the sipd↔mediad boundary (§5) to be real                            | A call answered by mediad hears a prompt; MOS on the prompt                                     |
| 2   | **Bridged calls** _(done)_          | Two sessions forwarding to each other; the minimal op set in §3.3                    | §3.4's named first cutover. Two-party audio is ~80% of PBX traffic                                                              | Engine integration suite green against mediad; SIPp basic-call; MOS/jitter vs Asterisk baseline |
| 3   | **DTMF (RFC 4733)**                 | Digit detection out of the telephone-event stream, emitted as an engine event        | IVR, voicemail PINs and attended transfer all break without it. Shipped near-free by rung 2 (the payload already flows)         | Every DTMF unit test in the engine passes against mediad                                        |
| 4   | **Recording**                       | Tee a session's frames to a container; the `snoop` primitive                         | §3.4's second named rung. Needs no mixing — a tap on a bridged leg hears both parties                                           | Byte-comparable recording of a scripted call; retention/S3 path unchanged                       |
| 5   | **MOH + park/hold**                 | A session sourcing from a loop instead of a peer                                     | Small once rung 1 exists (playback with a different source)                                                                     | Held-call audio; re-INVITE interop                                                              |
| 6   | **Conference mix-minus**            | N-way mixing, per-participant minus-self                                             | §3.4's third rung, and the hard one — this is where jambonz/LiveKit spent years. Needs a jitter buffer (§6) to sound acceptable | MOS at 3/5/10 participants; CPU per conference                                                  |
| 7   | **Opus / G.722 + transcoding**      | Wideband, and the first real DSP                                                     | Deliberately after mixing: a mixer must decode anyway, so the codec layer is cheaper to build once mixing forces it             | Interop matrix; CPU per transcoded leg                                                          |
| 8   | **T.38**                            | Fax                                                                                  | §3.4 says last, and it is right: fax is a different protocol wearing RTP's clothes, low volume, high fiddliness                 | A real fax round trip                                                                           |

Asterisk is retired (§P6) only after rung 8. `packages/media-ari` and `apps/asterisk` stay until
then — they are the media plane, not scaffolding to delete early.

---

## 3. The engine seam

### 3.1 What exists: the command seam

`apps/engine/src/media/media-port.ts` defines `MediaPort`, and its own doc comment states the
contract this whole effort depends on:

> `packages/media-ari` implements it today; `mediad`'s client will implement it tomorrow; the verb
> executor above it never learns which.

It is genuinely good. The vocabulary is domain vocabulary — `HangupCause`, milliseconds, playback
refs — and `apps/engine/src/media/ari-media.adapter.ts` is the only file allowed to know ARI's shape.
24 methods, in three plan-phase groups:

- **P2 (call basics):** `answer`, `ring`, `play`, `stopPlayback`, `hangup`, `getVariable`,
  `setVariable`, `channelExists`, `watchChannel`
- **P3 (routing executor):** `originate`, `createBridge`, `addToBridge`, `removeFromBridge`,
  `destroyBridge`, `record`, `stopRecording`, `startMusicOnHold`, `stopMusicOnHold`
- **P4 (call control):** `hold`, `unhold`, `mute`, `unmute`, `sendDtmf`, `snoop`

`MediadMediaPort implements MediaPort` now sits next to `AriMediaAdapter` and is selected by
`ENGINE_MEDIA_DRIVER`. **This half of the swap really is free — for the operations the media plane
can serve.** The coverage map at rung 2:

| `MediaPort` method                                                        | `mediad`                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `createBridge`                                                            | local bookkeeping — a relay with no members is nothing on the wire    |
| `addToBridge`                                                             | `rpc.media.v1.bridge-sessions`, at exactly two members                |
| `removeFromBridge`, `destroyBridge`                                       | `rpc.media.v1.unbridge-sessions`                                      |
| `hangup`                                                                  | `rpc.media.v1.release-session` — the MEDIA half of a teardown         |
| `channelExists`                                                           | the adapter's own session registry                                    |
| `watchChannel`                                                            | satisfied by construction: `mediad` events are org-wide, not per-leg  |
| `play`                                                                    | `rpc.media.v1.start-playback` — a session sourcing frames from a file |
| `stopPlayback`                                                            | `rpc.media.v1.stop-playback`, keyed by reference alone                |
| `answer`, `ring`, `originate`                                             | **refused** — signalling, which `apps/sipd` owns (§5)                 |
| `getVariable`, `setVariable`                                              | **refused** — channel variables are a dialplan concept                |
| `sendDtmf`                                                                | **refused** — rung 3                                                  |
| `record`, `stopRecording`, `snoop`                                        | **refused** — rung 4                                                  |
| `startMusicOnHold`, `stopMusicOnHold`, `hold`, `unhold`, `mute`, `unmute` | **refused** — rung 5                                                  |

A refusal is a typed `MediaOperationNotSupportedError` naming the operation, the capability and the
rung, and it **never silently no-ops**. A media plane that quietly accepted `record` and did nothing
would produce a call that connects, sounds perfect and has no recording — discovered days later by
somebody who needed it, with nothing in any log to say why. The same silence on `startMusicOnHold`
is a held caller listening to nothing and hanging up. Those are the worst defects a telephony system
has, because they are invisible at the moment they happen.

`play` is supported for the media refs the engine actually emits — `sound:`, which is what
`apps/engine/src/routing/media-refs.ts` renders every domain `MediaRef` into. Asterisk's GENERATOR
schemes (`tone:`, `digits:`, `number:`, `characters:`) are refused at the wire with `not_supported`
and the scheme named. That is a `MediaCommandRefusedError` at the seam rather than a capability
refusal, and the distinction is real: the operation exists, this media plane cannot serve that
argument, and the engine can route the leg to a plane that can.

**`allocateSession` is NOT on `MediaPort`**, deliberately: `MediaPort` is the vocabulary of an
engine driving a media server that also terminates SIP, and it has no concept of an SDP offer
because Asterisk never showed it one. It is a method on `MediadMediaPort` alone, for the
`apps/sipd` path to call, so that `AriMediaAdapter` never has to throw from an interface method it
could not implement.

### 3.2 The event seam — closed

`MediaPort` was commands only. The orchestrator imported `AriEvent` from `@optimiq-voice/media-ari`
and branched on Asterisk's own event-type strings in ~47 places, which meant the swap the plan rests
on was only half available: a `mediad` cutover would have required either rewriting the orchestrator
on live calls, or making `mediad` emit synthetic ARI events forever — embedding Asterisk's
vocabulary permanently in the service built to replace it.

**Done, in the wave before this one:**

1. `apps/engine/src/media/media-event.ts` defines `MediaEvent`, a twelve-member domain union.
2. `calls/ari-mapping.ts` gained `toMediaEvent(ariEvent)`, applied at the edge by
   `AriConnectionService` so nothing above it ever holds an `AriEvent`.
3. The orchestrator consumes `MediaEvent`, proved by the existing integration suite with Asterisk
   still in place — a pure refactor with no media risk, which was the whole point of doing it first.
4. `media/mediad-event-mapping.ts` now does the same for `mediad`. Neither side mentions the other.

The engine's `ari/` directory was renamed `media/` as part of it (open question 1, §10).

**The asymmetry worth knowing about:** `mediad` publishes two events and the union gains one
member. `session.ended` becomes `leg-ended` — the member the CDR is written from. `session.rtp-timeout`
maps to NOTHING, because it is the diagnosis that immediately precedes a `session.ended` whose reason
is `rtp-timeout`, and raising both would tear the leg down twice: once on the warning and once on the
fact it warned about. The reason survives on the `leg-ended` it caused, which is where a consumer
asking "why did that call drop" looks.

A media plane has no Q.850 opinion — it never saw a SIP response — so `mediad-event-mapping.ts`
picks the closest cause it can DEFEND from the reason `mediad` did report (`released` → 16
NORMAL_CLEARING, `rtp-timeout` → 41 NORMAL_TEMPORARY_FAILURE, `idle-reaped` → 102
RECOVERY_ON_TIMER_EXPIRE, `drained` → 44 REQUESTED_CHAN_UNAVAIL). That is a translation, which is
what the mapping layer is for; the alternative would be `mediad` inventing a signalling cause it has
no evidence for and putting that fiction in the shared contract.

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

Promoted, and defined in `packages/events/src/schemas/rpc.ts` + `src/subjects.ts`:

| Subject                          | Kind               | Deadline |
| -------------------------------- | ------------------ | -------- |
| `rpc.media.v1.allocate-session`  | core request-reply | 500 ms   |
| `rpc.media.v1.bridge-sessions`   | core request-reply | 500 ms   |
| `rpc.media.v1.unbridge-sessions` | core request-reply | 500 ms   |
| `rpc.media.v1.release-session`   | core request-reply | 500 ms   |
| `rpc.media.v1.start-playback`    | core request-reply | 1000 ms  |
| `rpc.media.v1.stop-playback`     | core request-reply | 500 ms   |

`start-playback` is the only command with a deadline over 500 ms, and the reason is visible in the
handler: it READS A FILE off disk and encodes it before it answers, where every other command binds
a socket or moves a pointer. It is still on a call path — the caller is listening to silence until
the prompt starts — so it is bounded well inside the second at which a person assumes the menu is
broken.

`stop-playback` carries a `playbackRef` and NOTHING ELSE, because `MediaPort.stopPlayback(playbackRef)`
has nothing else to give: barge-in stops a prompt from a handler holding a reference. So `mediad`
indexes live playbacks by reference. Threading a session id onto the engine's interface purely so
this payload could carry one would be shaping the seam around a lookup the media plane can do itself.

| Subject                                                | Kind              | Stream  |
| ------------------------------------------------------ | ----------------- | ------- |
| `media.evt.v1.<orgId>.<sessionId>.session.ended`       | JetStream publish | `MEDIA` |
| `media.evt.v1.<orgId>.<sessionId>.session.rtp-timeout` | JetStream publish | `MEDIA` |
| `media.evt.v1.<orgId>.<sessionId>.playback.finished`   | JetStream publish | `MEDIA` |

**`playback.finished` maps to no `MediaEvent` member, and that is a MIRROR of the ARI path rather
than a gap.** `MediaPort.play` returns as soon as audio has STARTED — the verb executor says so, and
barge-in depends on it — so nothing above the seam ever waited for a prompt to end. `toMediaEvent`
already drops Asterisk's `PlaybackFinished` for that reason, and `toMediaEventFromMediad` answers
`undefined` for this one. A union member nobody branches on is a shape two media servers would have
to agree on for no reason.

It is published anyway, for the same reason `session.rtp-timeout` is published while mapping to
nothing: `reason: error` is a caller sitting in silence where a menu should be, on a call that is
otherwise perfectly healthy, and nothing else on this backbone records it — the command already
answered `ok`, the session is still up, no CDR field mentions it. `playedMs` is on it because the
engine's `PlaybackResult.elapsedMs` measures how long the COMMAND took, and on a barge-in those two
numbers are not close.

The `v0` subjects are gone. Nothing outside `mediad` and the engine's client ever depended on them,
which is exactly the property `v0` in the name was there to buy.

**The engine reads the events with a CORE subscription** on `media.evt.v1.>`, even though a
JetStream stream captures them. That is not a contradiction: a JetStream publish is a publish, so a
core subscriber sees it live while the stream keeps it for whoever needs it later. The engine wants
the former — a leg to tear down NOW — and must not pay for a durable consumer's ack round trip on
the call path to get it.

### 4.3 The promotion, and the criteria it had to meet

The subjects were deliberately absent from `packages/events` while the media plane was a walking
skeleton: the command set bridged-call parity actually needs was not knowable until a real
capability had been built against it, and promoting a guess would have frozen the guess.

**All four criteria are now met, so the contract is promoted:**

1. ✅ Rung 2 (bridged calls) works end to end — see §9.
2. ✅ The command set is the one rung 2 forced, not a guess: `allocate-session` carries SDP because
   negotiation needed it, and `bridge`/`unbridge` are separate because a transfer needs to separate
   legs without ending them.
3. ✅ SDP is in the payloads. The v0 `{port, ssrc}` stub is gone.
4. ✅ The engine has a real `MediadMediaPort` (`apps/engine/src/media/mediad-media.port.ts`), so
   there is a second implementer to disagree.

Promoted shape: Zod in `packages/events/src/schemas/rpc.ts` (commands) and
`src/schemas/media-events.ts` (events), Go structs generated into `packages/events-go`, with the
codegen drift gate in CI enforcing that the two languages cannot diverge.

**The raw-NATS obligation is now recorded on the schema itself**, on
`mediaAllocateSessionRequestSchema`, because this is the first subject family whose caller is
TypeScript and whose responder is Go — the direction where `ClientProxy` is the idiomatic thing to
reach for and is wrong.

### 4.4 Payloads

`allocate-session` — request / reply:

```jsonc
{ "sessionId": "018f…", "orgId": "018f…", "callId": "018f…",
  "sdpOffer": "v=0\r\no=- …", "direction": "sendrecv" }

{ "ok": true, "sessionId": "018f…", "sdpAnswer": "v=0\r\n…",
  "instanceId": "mediad-7c9f", "address": "203.0.113.10",
  "rtpPort": 30000, "rtcpPort": 30001, "ssrc": 4277009102,
  "codec": "PCMU", "telephoneEventPayloadType": 101 }
```

Four properties are load-bearing:

- **`sessionId` is caller-assigned.** Same reason `OriginateRequest.channelId` is client-assigned at
  the `MediaPort` seam: the caller must be able to release a session whose reply it never received.
- **Allocate is idempotent on `sessionId`.** A retry returns the same session and does not open a
  second port. Without this, every timed-out allocate leaks one.
- **`orgId` is required**, and it is not decoration: it is the subject token the session's lifecycle
  events are published under. A session allocated without one would end silently.
- **A refusal is a reply, never a silence**, with a stable machine-readable `reason` the engine
  branches on: `bad_request`, `capacity`, `shutting_down`, `unknown_session`, `wrong_instance`,
  `not_supported`, `internal`. `wrong_instance` is answerable only because of the session directory
  (§6.1) — without it a second instance could not tell "never existed" from "belongs to my
  neighbour", and those need opposite recoveries.

`not_supported` is the honest expression of a per-capability cutover: a rung `mediad` has not
reached is refused by name, and the engine routes that leg to Asterisk.

`address` is `MEDIAD_PUBLIC_IP`, never the bind address — it is what goes in an SDP `c=` line.

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

**Bridging is a RELAY, and the header rewrite is the interesting part.** Two sessions, each
forwarding what it receives out of the other's socket. The PAYLOAD is passed through byte for byte —
that is what makes rung 2 achievable with no DSP, and it is what carries RFC 4733 DTMF for free,
since a telephone-event payload is just bytes to a relay. The HEADER is not, and each rewritten
field is a separate decision:

- **SSRC becomes the outgoing session's own.** Two legs are two independent RTP sessions; handing
  leg B a stream stamped with leg A's SSRC would make B's jitter buffer see the synchronisation
  source change every time the bridge is re-pointed (an attended transfer), which endpoints handle
  by resetting — an audible click at best. One stable SSRC per leg for the life of the leg is what
  an endpoint expects.
- **Sequence numbers become the outgoing session's own**, incrementing by one per forwarded packet.
  Passing A's through would leak A's losses into B's statistics and, worse, make the sequence space
  JUMP on a re-bridge, which a jitter buffer reads as catastrophic loss and answers with concealment
  noise.
- **Timestamp is kept.** It is the frame's sampling instant and a relay does not resample, so it is
  still true. Rewriting it would be inventing a clock.
- **Marker is kept.** On a telephone-event payload it is the start-of-digit flag; dropping it turns
  every DTMF press into one an IVR cannot detect.
- **Payload type is translated for telephone-event ONLY.** G.711 is refused at bridge time when the
  two legs disagree (see §7), so the audio type always matches. The RFC 4733 type is dynamic and the
  two legs routinely land on different numbers — 101 and 96 are both common — and the payload FORMAT
  is identical, so renumbering is correct and is the whole reason DTMF survives a bridge between two
  phones that negotiated differently.

**Two silences, and they are different events.** A session that RECEIVED audio and then stopped is
an RTP TIMEOUT: a call still up as far as the signalling plane is concerned, whose parties can no
longer hear each other. A session that NEVER received a packet and aged out is a LEAK: the engine
allocated it and stopped knowing about it. Reporting them as one event would make every abandoned
call setup look like a media failure, so they have separate windows (`MEDIAD_RTP_TIMEOUT`, default
30s; `MEDIAD_SESSION_IDLE_TIMEOUT`, default 60s) and separate reasons on the wire.

### 6.0 Playback: where the frames come from, and what they replace (rung 1)

**Playback is a session sourcing frames from a file instead of from a socket.** Everything below the
source is the machinery rung 0 already built: the same socket, the same SSRC, the same sequence
counter, the same 20 ms cadence.

**Where the audio lives: a MOUNTED DIRECTORY, `MEDIAD_SOUNDS_DIR`.** This is the wave's largest
decision and the repo had already made it once. `apps/engine/src/routing/media-refs.ts` states, at
length, that the only way object-store audio becomes playable is for the store to be _visible to the
media server as a filesystem_, and that "inventing a fetch-and-stage step inside the engine would put
a download on the call path". `MediaRefSettings.objectMediaRoot` is that mount for Asterisk;
`MEDIAD_SOUNDS_DIR` is the same mount for `mediad`, which is what lets ONE `sound:` string resolve on
either plane while both are serving calls — the property a per-capability cutover depends on.

Fetching over HTTP from the API's streaming endpoint was the alternative, and loses on three counts
in increasing order of seriousness:

1. It puts a network round trip, a TLS handshake and an object-store read inside `play`, on a call
   path where the caller hears every millisecond as silence before the menu.
2. It gives `mediad` a control-plane credential. `config/nats.conf` spends a paragraph on the
   opposite policy — "apps/mediad cannot read `rpc.sip.v1.credential`… the process with the widest
   network exposure on the platform, since it terminates RTP from the internet" — and an API token in
   this process would undo it for exactly the reason it was granted.
3. It makes the media plane a client of the control plane, which §5 spends its whole length keeping
   apart.

**The cost, stated plainly:** a deployment must mount the prompt store on every `mediad` host, and a
prompt uploaded through the API is playable only once that mount sees it. That is an operational
dependency, and it is the same one Asterisk already has. `MEDIAD_SOUNDS_DIR` has NO DEFAULT: an
instance without one refuses every playback `not_supported` by name, and the engine routes those legs
to Asterisk. A default pointing at a directory that probably does not exist would turn one clear
refusal into a per-call "no such file".

**Format: WAV, 8 kHz, mono, PCM16 / µ-law / A-law.** The container is walked chunk by chunk rather
than assumed to be the canonical 44 bytes, because real files carry `LIST`/`INFO` from a tagging tool,
`fact` from sox, and `WAVE_FORMAT_EXTENSIBLE` from anything Windows wrote. Wrong rate, wrong channel
count and unknown format tags are REFUSED rather than resampled or downmixed — v1 has no DSP on the
call path and a 44.1 kHz prompt is the single likeliest thing to be dropped in a prompt directory by
mistake, so it fails as `not_supported` and Asterisk plays it.

**Conversion into the leg's companding law happens ONCE, at playback start, and is not the
transcoding §7 refuses.** §7's rule is about the RELAY: two live legs, packet by packet, on the call
path. This is a static file converted before a single frame is scheduled. Without it a leg that
answered A-law could never hear a prompt, because libraries are stored in one law and phones
negotiate whichever they like. A file already in the leg's law is passed through byte for byte.

**Playback REPLACES the peer's audio towards the played-to leg; it does not mix.** A session has ONE
outbound stream — one SSRC, one sequence space, one socket. Interleaving the peer's frames into a
prompt would put two unrelated timestamp clocks under one SSRC, which is precisely what a jitter
buffer cannot untangle; the receiver would hear both, badly, with concealment noise between them. Real
mixing means summing two DECODED signals, which needs a decode, a jitter buffer to align them and an
encode — rung 6, and the reason rung 6 is late in the ladder.

**What replace does NOT interrupt is the direction that carries DTMF out of the played-to leg**, and
that is the point rather than a happy accident. A caller pressing 1 while the menu is still talking
sends RFC 4733 INTO the session, and that path — receive, relay, the peer's forward — is untouched by
playback. Barge-in works because digits keep flowing while the prompt plays, which is the entire
reason `gather` calls `play` and `stopPlayback` around one collection. Suppression applies only to
what is written OUT of the playing session's socket. A peer's own telephone-event packets are dropped
along with its audio for the duration, deliberately: the party being played a prompt is by
construction not the party a digit from the far side is aimed at, and admitting one packet from the
peer's clock would reintroduce the problem above.

**Two header details carry the transition.** The prompt continues the session's own timestamp rather
than restarting at zero, because sending a stream's clock BACKWARDS is read by some endpoints as a
restart and answered by flushing the buffer — clipping the first syllable of every prompt. And the
marker bit is set on the first played frame AND on the first relayed frame after the prompt ends,
which is RFC 3550's start-of-talkspurt flag doing exactly its job: the outbound stream changes
timestamp clocks at both edges, and a receiver told "new talkspurt" resumes cleanly where one left to
infer a discontinuity answers with concealment noise.

**Deferred, and named rather than forgotten:** no clip cache (every start re-reads and re-encodes;
the obvious next step, and one with an invalidation question attached), no raw headerless `.ul`/`.al`
files, no `tone:`/`digits:` synthesiser, no per-language prompt variants — `language` is on the
contract and ignored, so the two drivers do not silently disagree about what was asked for.

### 6.1 The session directory (open question 2, answered)

`rpc.media.v1.*` is served by a QUEUE GROUP, so NATS hands each request to whichever `mediad` is
free. Right for `allocate-session`; wrong for every command after it, because a session lives on
exactly ONE instance — its sockets are bound there and its relay goroutines run there.

**The answer is a NATS KV directory**, `media-sessions`, keyed by session id alone, mapping to the
owning `instanceId` plus the tenant, the call, the advertised address/port and the bridge. Written
on allocate, updated on bridge, **deleted on release** — and the delete is part of the wire contract
rather than an implementation detail, because an entry that outlives its session is an instance name
the engine keeps routing dead commands to.

The alternative — the allocate reply carrying an instance-specific subject the engine uses
thereafter — is simpler and needs no lookup, but it puts routing state in the engine, where an
engine restart loses it and every live call becomes uncommandable. The directory survives that, and
it is the substrate open question 3 needs, because draining means MOVING sessions and you cannot
move what you cannot enumerate.

Keyed by session id and NOT organization-scoped, which makes it the second exception after
`did-index` — and for the same reason: the READER does not know the tenant. A `mediad` handed a
`bridge-sessions` carrying two session ids has no org to scope a lookup with, and threading one onto
every command purely so the key could be prefixed would be shaping the wire around a key format. The
org travels in the value.

It is a DIRECTORY, not a claim: nothing races for a media session, so there is no `expiresAt` and no
heartbeat, unlike `park-claims`. The bucket's six-hour TTL (matching `channels`, because a session
lives exactly as long as a call leg) is a backstop.

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

**RTCP** is bound but not read. Bound anyway, because an unbound odd port is one an unrelated
process can take, and the day RTCP is implemented the pairing would already be broken on exactly the
hosts that had been running longest.

---

## 7. Codec plan

**v1 is G.711 passthrough. No transcoding. Bytes in, same bytes out.**

- PCMU (PT 0) and PCMA (PT 8) are the two payload types every endpoint on earth supports, so
  passthrough covers the bridged-call cutover without a single DSP operation.
- RFC 4733 telephone-event rides alongside for DTMF, and is **negotiated rather than assumed**: the
  type is dynamic, real endpoints offer 96, 100 and 101, and a session forwarding DTMF under a type
  the far end never agreed to produces digits the far end drops — an IVR that "randomly" ignores
  keypresses. Each session carries whatever its own answer settled on, and the relay renumbers
  between two legs that chose differently (§6).
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

Today `apps/engine/src/media/media-port.fake.ts` backs nine unit specs, `AriMediaAdapter` has no spec
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

## 9. What the waves shipped

### 9.1 Rung 1 — playback (this wave)

```
packages/events/
├── src/subjects.ts               rpc.media.v1.start-playback / stop-playback,
│                                 playback.finished in MEDIA_SESSION_EVENTS
├── src/schemas/rpc.ts            the two command contracts
└── src/schemas/media-events.ts   playback.finished + MEDIA_PLAYBACK_END_REASONS

packages/events-go/               regenerated: MediaStartPlayback/StopPlayback structs,
                                  MediaPlaybackFinishedData, parity.json

apps/mediad/
├── internal/audio/               NEW. WAV parse (chunk walker, EXTENSIBLE, PCM16/µ-law/A-law),
│                                 G.711 codecs, 20 ms framing, the MEDIAD_SOUNDS_DIR library
├── internal/rtp/playback.go      NEW. Paced frame source, replace-the-peer, marker handoff,
│                                 stop/supersede, the playback index on Manager
├── internal/control/handlers.go  start-playback / stop-playback
├── internal/control/lifecycle.go playback.finished announcer
└── internal/config/              MEDIAD_SOUNDS_DIR

apps/engine/src/media/
├── mediad-media.port.ts          play / stopPlayback implemented; coverage map now 9 of 24
└── mediad-event-mapping.ts       playback.finished -> undefined, mirroring the ARI path
```

**Configuration added.** `MEDIAD_SOUNDS_DIR` (no default — an unconfigured instance refuses every
playback by name). Nothing engine-side: `play` and `stopPlayback` were already on `MediaPort`.

**Verified.** `apps/mediad` 243 tests race-clean (up from 162); `packages/events` 270;
`packages/events-go` parity green with byte-reproducible codegen; `apps/engine` 941 unit specs (up
from 932) plus the integration suite unchanged on the ARI path. A live round trip against a real
broker running the repo's real `config/nats.conf` — so the permission diff was exercised, not
asserted — proved the whole wire twice: allocate → SDP answer on a real port → `start-playback` of a
generated 400 ms µ-law WAV → 20 RTP frames on a test socket, contiguous sequence numbers, +160
timestamps per frame, marker on the first, 160-byte G.711 payloads → `playback.finished` with
`reason: completed, playedMs: 400`; and the barge-in variant, where a `stop-playback` after 6 frames
produced zero further frames and `reason: stopped, playedMs: 120`. A `tone://` ref was refused
`not_supported` with the scheme named, a missing prompt `bad_request`, and a stop of a finished
playback answered `ok: true, stopped: false`.

### 9.2 Rung 2 — bridged calls

```
packages/events/
├── src/subjects.ts               media.evt.v1 root, MEDIA_SESSION_EVENTS, rpc.media.v1.* subjects
├── src/schemas/rpc.ts            the four command contracts + MEDIA_REFUSAL_REASONS
├── src/schemas/media-events.ts   session.ended / session.rtp-timeout payloads
├── src/schemas/live-state.ts     mediaSessionDirectoryEntrySchema
└── src/streams.ts                MEDIA stream, media-sessions KV, kvKeyFor.mediaSession

packages/events-go/               regenerated: media_events_gen.go, rpc_gen.go, registry_gen.go,
                                  parity.json — plus hand-written media_sessions.go, MediaStream,
                                  MediaSessionsKV, MediaSubject/Filters, MediaSessionKVKey

apps/mediad/
├── internal/sdp/                 offer parse + answer build; G.711 + RFC 4733 negotiation
├── internal/rtp/                 relay (peer pointers, header rewrite), bridge/unbridge,
│                                 per-session negotiated payload types, two-window reaper
├── internal/directory/           the media-sessions KV directory (+ an in-memory fake)
├── internal/events/              JetStream lifecycle publisher (sipd's shape) (+ a recorder)
├── internal/control/             rpc.media.v1.* handlers + the LifecycleAnnouncer
└── internal/config/              MEDIAD_INSTANCE_ID, MEDIAD_RTP_TIMEOUT, MEDIAD_ECHO_DIAGNOSTIC

apps/engine/src/media/
├── mediad-media.port.ts          MediadMediaPort implements MediaPort (coverage map in §3.1)
├── mediad-transport.ts           raw NatsConnection.request(), never a ClientProxy
├── mediad-event-mapping.ts       media.evt.v1.* -> the MediaEvent union
├── mediad.service.ts             boot probe, event subscription, lifecycle
├── media-not-supported.error.ts  the typed refusals
└── ari.module.ts                 ENGINE_MEDIA_DRIVER picks the plane
```

**Configuration added.** `MEDIAD_INSTANCE_ID` (hostname-pid by default — stable, distinct,
readable), `MEDIAD_RTP_TIMEOUT` (30s), `MEDIAD_ECHO_DIAGNOSTIC` (false). Engine-side:
`ENGINE_MEDIA_DRIVER` (**`ari` by default — zero behaviour change unless an operator opts in**) and
`ENGINE_MEDIAD_RPC_TIMEOUT_MS` (500).

**Refuses to boot rather than degrading.** `ENGINE_MEDIA_DRIVER=mediad` with no `mediad` listening
is a process that does not start, proved by a real request on a real subject (a `release-session`
for an id nothing holds, which changes no state and any live instance answers in microseconds). The
alternative — booting and failing per call — is the failure mode this design keeps rejecting: a
service that looks healthy and answers no calls, discovered by a customer rather than by a deploy.

**Verified.** `apps/mediad` 162 tests race-clean; `packages/events` 246; `packages/events-go`
parity green with byte-reproducible codegen; `apps/engine` 842 unit specs (up from 799) plus the
9/9 integration suite unchanged on the ARI path. A live round-trip against the real broker proved
the whole wire: raw TS request → Go responder → SDP answer on the session's real port → directory
entry → bridge → refusal with a machine-readable reason → release → directory cleaned →
`media.evt.v1.…session.ended` with `reason: released` on a core subscription.

**Still not touched:** `compose.yaml`. A `mediad` service arrives when a deployment actually routes
a call to it, which needs `apps/sipd`'s proxy — see §10 question 4.

## 10. Open questions

**Answered in this wave:**

1. ~~**Where does the `MediaEvent` union live?**~~ **`apps/engine/src/media/media-event.ts`**, and
   the engine's `ari/` directory was renamed `media/` as part of the same refactor. `packages/telephony`
   lost: the union's members are chosen by what the ORCHESTRATOR consumes — a member nobody branches
   on is a shape two media servers would have to agree on for no reason — so it belongs with its
   consumer. The domain package holds values (`HangupCause`, `CallState`), which the union's fields
   use; that split has held.

2. ~~**How does the engine address a specific `mediad` instance?**~~ **A NATS KV session directory**,
   `media-sessions`. Full reasoning in §6.1. The reply-subject alternative lost because it puts
   routing state in the engine, where a restart loses it.

3. ~~**Is echo mode worth keeping past rung 1?**~~ **Kept, behind `MEDIAD_ECHO_DIAGNOSTIC`.** It is
   now unreachable from the wire — no field in `allocate-session` selects it — so it can never be
   hit by a production call path, which was the whole concern. It costs one branch in the packet
   path and buys the simplest possible smoke test of a real deployment's ports and NAT with no
   second party. A deployment that leaves the flag on serves NO working calls (every leg hears
   itself), so it is warned about on every boot.

**Still open, and honestly so:**

3. **What does graceful drain mean for a media server?** Unchanged, and now one dependency closer:
   the session directory exists, so an instance can enumerate what it holds and another can find it.
   What is still missing is the MOVE — repointing a far end needs an authenticated re-INVITE from
   the signalling plane, so this cannot be finished inside `mediad` at all. Today a drain closes
   live sessions and says so on the wire (`session.ended` with `reason: drained`), which is the
   honest description of "calls on this instance lose audio". **This must be solved before `mediad`
   carries production traffic, not after.**

4. **Does `sipd`'s proxy wave need to know about `mediad`?** §5 still says no — the engine is the
   courier — and this wave did not test it, because there is no INVITE path yet. It is now the
   BLOCKING question rather than a background one: `MediadMediaPort` refuses `answer`, `ring` and
   `originate` by design, so nothing can drive a whole call through `mediad` until `sipd` terminates
   the dialog and hands the engine an offer. Re-test the post-dial delay of the extra hop when it
   lands; if it is material, the coupling has to be argued for explicitly rather than discovered.

5. **RTCP: when?** Still bound and unread. It carries the receiver reports that are the only in-band
   signal of call quality, and §8.4's MOS/jitter gate wants them. It did not block rung 2 — a relay
   forwards RTP whether or not it reads RTCP — so it moves to the rung that first needs a quality
   number it cannot get from anywhere else.

6. **NEW: rung 1's gate is half met, and the missing half is not `mediad`'s to close.** The ladder
   gates rung 1 on "a call answered by mediad hears a prompt; MOS on the prompt". What is proved is
   that the right bytes reach the right socket with the right headers at the right cadence — a live
   round trip against a real broker, twenty frames, contiguous sequence numbers, +160 timestamps,
   the marker where RFC 3550 wants it. What is NOT proved is a PHONE hearing it, because there is no
   INVITE path yet: that is blocking question 4 below, and it is the same gap rung 2 has. The MOS
   half is question 6.

   Two smaller things are deferred deliberately and named here so they are decisions rather than
   omissions. **There is no clip cache** — every `start-playback` re-reads and re-encodes the file,
   which is a disk read and a table lookup per byte inside a 1 s command, fine at rung 1 volumes and
   the obvious first optimisation when it is not. It is deferred rather than built because a cache
   has an invalidation question attached (a prompt re-uploaded through the API must not keep playing
   the old audio), and answering that badly is worse than reading a file. **There is no playback
   QUEUE**: a second `start-playback` on a session supersedes the first, which finishes `stopped`.
   Queueing would make a caller who pressed a digit listen to the rest of the old menu before the
   new one started.

7. **NEW: what proves the audio is GOOD, not just correct?** §8.4 gates rungs 2 and 6 on MOS and
   jitter against an Asterisk baseline on the same hardware. This wave proved CORRECTNESS — the
   right bytes reach the right socket with the right header — and measured nothing. The relay adds
   no jitter buffer and no transcoding, so the expected delta is a few hundred microseconds of
   forwarding latency, but "expected" is not "measured", and the whole point of the gate is that
   absolute MOS numbers are meaningless while the delta against the thing being replaced is not.
   **Rung 2 is not cut over until this exists.**

8. **NEW: the `MediaPort` conformance suite (§8.1) still does not exist.** There is now a second
   implementation to run it against, which is exactly the condition that made it worth building —
   `describeMediaPortConformance(makePort)` invoked against the fake, against `AriMediaAdapter`, and
   against `MediadMediaPort`. Without it, "the seam holds" is proved by two separate suites that
   could drift, rather than by one suite two implementations must both satisfy.
