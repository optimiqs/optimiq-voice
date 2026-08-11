# `apps/mediad` — the Go media plane

**Status:** **rungs 1–4 shipped, rung 3 now complete on both sides** — SDP offer/answer, bridged
G.711 calls with RFC 4733 DTMF, WAV file playback with barge-in, DTMF generation AND DETECTION, WAV
recording of one or both directions, an RTP session directory in NATS KV, and a lifecycle event
family. The contract is promoted to `packages/events` as `rpc.media.v1.*` + `media.evt.v1.*`, and
`apps/engine` has a real `MediadMediaPort` behind `ENGINE_MEDIA_DRIVER=ari|mediad` (default `ari`).
**Asterisk 22 is still the media plane for every deployment that has not opted in, and for every
rung above 4 in all of them.**
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

**Rungs 0 through 4 are built.** Rung 1's negotiation half arrived with rung 2, because bridging
needs SDP; its playback half arrived next; rung 3's send half and rung 4 arrived together; rung 3's
receive half — detection — is this wave, and it is what completes the ladder up to rung 4. What
exists:

- a port-pair allocator over a configured range, which **binds** rather than counts;
- an RTP `Session` that receives, learns its far end from the packets themselves, and can put audio
  back on the wire;
- SDP offer/answer for G.711 with RFC 4733 negotiated rather than assumed;
- a two-party RELAY, which is what a bridged call is;
- WAV decoding to G.711, 20 ms packetisation, and a session that sources frames from a file
  instead of a socket — replacing the peer's audio while it plays and resuming the relay after;
- RFC 4733 digit GENERATION into the send path, under the leg's own negotiated payload type, and
  DETECTION out of the receive path — one keypress per digit, however many packets carried it;
- a WAV recorder that tees one direction or sums both, and finalises rather than truncating;
- a promoted `rpc.media.v1.*` command surface and a five-member `media.evt.v1.*` event family;
- a NATS KV session directory, so a second instance can route or refuse correctly;
- a drain that does not leak ports and says on the wire that it cost audio.

Everything above that — playback, recording, mixing — is a consumer of exactly those pieces.
Playback is a session sourcing frames from a file instead of from a socket. Recording is a session
teeing them. A generated digit is the same send path carrying an event rather than audio. Building
the substrate first, and proving it with tests, is what made all three cheap.

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

| #   | Rung                                | What it adds                                                                               | Why here                                                                                                                                                 | Gate                                                                                            |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0   | **Substrate** _(done)_              | Port allocation, RTP receive/send, latching, control surface, drain                        | Everything else consumes it                                                                                                                              | Unit suite, race-clean                                                                          |
| 1   | **SDP + one-legged media** _(done)_ | `pion/sdp` offer/answer, real negotiation, `inactive`/`sendrecv`, playback of a file       | The first rung that requires signalling integration; forces the sipd↔mediad boundary (§5) to be real                                                     | A call answered by mediad hears a prompt; MOS on the prompt                                     |
| 2   | **Bridged calls** _(done)_          | Two sessions forwarding to each other; the minimal op set in §3.3                          | §3.4's named first cutover. Two-party audio is ~80% of PBX traffic                                                                                       | Engine integration suite green against mediad; SIPp basic-call; MOS/jitter vs Asterisk baseline |
| 3   | **DTMF (RFC 4733)** _(done)_        | GENERATING digits into the send path, and DETECTING them out of the receive path           | IVR, voicemail PINs and attended transfer all break without it. Forwarding was free at rung 2; originating a digit was not, and neither was noticing one | Every DTMF unit test in the engine passes against mediad                                        |
| 4   | **Recording** _(done)_              | Tee a session to a WAV file — one direction or both, mixed. No `snoop` primitive: see §6.2 | §3.4's second named rung. A session already IS both directions, so the Asterisk tap channel has nothing to be                                            | Byte-comparable recording of a scripted call; retention/S3 path unchanged                       |
| 5   | **MOH + park/hold**                 | A session sourcing from a loop instead of a peer                                           | Small once rung 1 exists (playback with a different source)                                                                                              | Held-call audio; re-INVITE interop                                                              |
| 6   | **Conference mix-minus**            | N-way mixing, per-participant minus-self                                                   | §3.4's third rung, and the hard one — this is where jambonz/LiveKit spent years. Needs a jitter buffer (§6) to sound acceptable                          | MOS at 3/5/10 participants; CPU per conference                                                  |
| 7   | **Opus / G.722 + transcoding**      | Wideband, and the first real DSP                                                           | Deliberately after mixing: a mixer must decode anyway, so the codec layer is cheaper to build once mixing forces it                                      | Interop matrix; CPU per transcoded leg                                                          |
| 8   | **T.38**                            | Fax                                                                                        | §3.4 says last, and it is right: fax is a different protocol wearing RTP's clothes, low volume, high fiddliness                                          | A real fax round trip                                                                           |

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
can serve.** The coverage map at rung 4 — **12 of 24**:

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
| `sendDtmf`                                                                | `rpc.media.v1.send-dtmf` — RFC 4733 under the leg's own type          |
| `record`                                                                  | `rpc.media.v1.start-recording`, direction `receive` (§6.2)            |
| `stopRecording`                                                           | `rpc.media.v1.stop-recording`, keyed by reference alone               |
| `answer`, `ring`, `originate`                                             | **refused** — signalling, which `apps/sipd` owns (§5)                 |
| `getVariable`, `setVariable`                                              | **refused** — channel variables are a dialplan concept                |
| `snoop`                                                                   | **refused** — an Asterisk-ism this model does not need (§6.2)         |
| `startMusicOnHold`, `stopMusicOnHold`, `hold`, `unhold`, `mute`, `unmute` | **refused** — rung 5                                                  |

`snoop` is the only refusal on the list that is not a rung, and the distinction is load-bearing:
the capability behind it EXISTS here, under a different shape. See §6.2.

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

**The asymmetry worth knowing about:** `mediad` publishes five events and three of them map, to
members that all already existed. `session.ended` becomes `leg-ended` — the member the CDR is
written from. `recording.finished` splits into `recording-finished` / `recording-failed`.
`dtmf.received` becomes `dtmf-received`, which `calls/ari-mapping.ts` produces identically from
`ChannelDtmfReceived` — and that is why rung 3's receive half needed **zero** changes above
`src/media/`: the confirmation IVR, the feature-code collector and voicemail's digit collection all
read the orchestrator's `DtmfInbox`, and none of them can tell which plane filled it.
`session.rtp-timeout`
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
| `rpc.media.v1.send-dtmf`         | core request-reply | 500 ms   |
| `rpc.media.v1.start-recording`   | core request-reply | 1000 ms  |
| `rpc.media.v1.stop-recording`    | core request-reply | 500 ms   |

The two commands with a deadline over 500 ms are the two that touch a FILESYSTEM before they
answer, where every other command binds a socket or moves a pointer. `start-playback` reads a file
off disk and encodes it; `start-recording` is the mirror image — a directory tree to create, a file
to open and a header to write — and a reply that arrived before the file existed would let the
opening moments of a recording be dropped on the floor and reported as success. Both are still on a
call path, so both are bounded well inside the second at which a person assumes the feature is
broken.

**`send-dtmf` is 500 ms even though the DIGITS take seconds**, and that is the interesting one. It
answers when injection has STARTED, exactly as ARI's `POST /channels/{id}/dtmf` does — Asterisk
queues the frames and answers — because `MediaPort.sendDtmf` returns `void` and hands back no
handle, so a late reply tells a caller nothing an early one did not. Everything REFUSABLE (no such
session, no negotiated telephone-event type, an unsendable character, a far end that has not been
learned) is decided before the first packet, and `queuedMs` on the reply is how long the far end
will be receiving digits. There is deliberately no `stop-dtmf`: a string is bounded by construction
and there is no reference an engine could name to interrupt one.

`stop-playback` carries a `playbackRef` and NOTHING ELSE, because `MediaPort.stopPlayback(playbackRef)`
has nothing else to give: barge-in stops a prompt from a handler holding a reference. So `mediad`
indexes live playbacks by reference. Threading a session id onto the engine's interface purely so
this payload could carry one would be shaping the seam around a lookup the media plane can do itself.

| Subject                                                | Kind              | Stream  |
| ------------------------------------------------------ | ----------------- | ------- |
| `media.evt.v1.<orgId>.<sessionId>.session.ended`       | JetStream publish | `MEDIA` |
| `media.evt.v1.<orgId>.<sessionId>.session.rtp-timeout` | JetStream publish | `MEDIA` |
| `media.evt.v1.<orgId>.<sessionId>.playback.finished`   | JetStream publish | `MEDIA` |
| `media.evt.v1.<orgId>.<sessionId>.recording.finished`  | JetStream publish | `MEDIA` |
| `media.evt.v1.<orgId>.<sessionId>.dtmf.received`       | JetStream publish | `MEDIA` |

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
  (§6.3) — without it a second instance could not tell "never existed" from "belongs to my
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

### 6.1 DTMF generation: the digit nobody sent (rung 3)

Digits a party PRESSES have crossed a bridge since rung 2 — a telephone-event payload is just bytes
to a relay, and §6's header rewrite renumbers the payload type between two legs that negotiated
differently. What that path cannot do is ORIGINATE one, because there is no inbound packet to
forward, and an attended transfer punching an extension into a far-end IVR is exactly that.

**A digit occupies a SPAN of the outbound timestamp clock, not a point.** Every packet of one digit
carries the timestamp the digit STARTED at plus a duration field that grows by 160 per 20 ms frame;
that growing number is how a receiver reconstructs one tone from several packets, and a timestamp
that advanced per packet would be five separate tones. The marker bit goes on the first packet
(RFC 4733 §2.5.1.2's start-of-event flag, the one an IVR keys on) and the final packet carries the
END bit and is sent **three times back to back** (§2.5.1.4) — losing the only packet that says the
digit is over leaves the far end holding a tone open until its own timeout, which reads as one very
long keypress or as two digits where the caller pressed one.

**So a digit takes the outbound stream for its span**, exactly as a prompt does and for the
identical reason: one SSRC, one sequence space, one socket. Relayed audio and playback frames are
suppressed for the length of the string, counted (`SuppressedByDtmf`) rather than silently dropped,
and the marker is forced onto the first frame after it. A prompt overlapped by digits is CLIPPED by
the length of the digits rather than stretched — the playback keeps its schedule and reports the
audio the far end actually received in `playedMs`.

**A second string QUEUES behind the first**, which is the opposite of the playback rule and right
for the opposite reason: digits are a sequence, and a caller that sent "12" then "34" wants "1234".
Superseding would deliver "34"; interleaving would put one string's packets inside another's digit.

**A leg that negotiated no telephone-event type is refused `not_supported` by name**, never
approximated. The two alternatives are both worse than saying so: sending under a payload type the
far end never agreed to produces digits it silently drops — an IVR that "randomly" ignores
keypresses — and synthesising an audible tone into the G.711 stream means writing a tone generator,
which is the same deferral `tone://` carries at `start-playback`. The engine answers either by
routing the leg to Asterisk, which has both.

### 6.1.1 DTMF detection: one keypress out of many packets (rung 3's receive half)

**A digit is many packets and exactly one event, and that is the whole shape decision.** RFC 4733
spreads one keypress across an update packet every 20 ms — each carrying the timestamp the digit
STARTED at and a duration field that grows — followed by an END packet the sender transmits three
times back to back (§2.5.1.4, the same rule generation obeys above). A detector that published per
packet would turn a 100 ms press into eight events, and a `gather` collecting a four-digit PIN would
fill on the first one. So the de-duplication lives in `mediad`, below the wire contract, and
`media.evt.v1.<org>.<session>.dtmf.received` carries the DIGIT.

**The identity of a digit is its timestamp, not its marker bit.** Every packet of one digit shares
the start timestamp; the next digit gets a new one. That makes the timestamp a per-digit identity
that survives everything the network does, and it is why the detector never reads the marker at all:
the marker is one bit on ONE packet, so a detector keyed on it loses a whole keypress to a single
lost datagram and loses every keypress from a sender that forgets to set it — which is a real and
common bug. Interdigit sequencing is therefore free, and "11" is two presses rather than one long
one without any timer.

**Four ways a digit closes, and exactly one of them can fire per digit** — a single `surfaced` flag
on the in-flight digit is the gate all four share, so "exactly once" is a property of one line
rather than of four call sites agreeing:

- **the END bit**, the normal case. The second and third copies find the digit surfaced and are
  dropped. So does an update packet reordered BEHIND the END, and so does an END that arrived AHEAD
  of its own updates — the digit is surfaced on whichever packet with that timestamp says it is over.
- **the next digit.** A new start timestamp closes an unsurfaced predecessor, which is what makes a
  PIN typed at human speed survive the loss of all three END copies on one of its digits: the next
  key press recovers it in a few hundred milliseconds rather than at the cutoff.
- **the max-duration cutoff**, `DefaultDtmfMaxDigitDuration` = 5 s. It is evaluated on ARRIVING
  packets rather than by a timer per digit: while the leg is sending anything at all — and the audio
  that resumes the instant a tone ends is the common case — the deadline is met within one frame,
  with no goroutine and no clock to inject. Five seconds is far longer than any human keypress and
  comfortably inside the 8.19 s at which the 16-bit duration field wraps at 8 kHz, so a cut-off digit
  still carries a duration that means what it says.
- **the session ending.** The backstop for the genuinely degenerate case — a far end that began a
  tone and stopped sending entirely, so no arrival ever evaluates the cutoff. It is flushed on the
  teardown path BEFORE `session.ended`, because the engine tears the leg down on that event and a
  keypress announced after it reaches a consumer that has finished with the call.

**The reordering tolerance is exactly one digit deep, and that is a decision rather than a limit
nobody measured.** The detector remembers two timestamps: the digit arriving and the one before it.
A packet reordered anywhere inside its own digit is recognised and dropped, and so is one that
arrives after the next digit has started. A packet delayed past TWO digit boundaries would be read
as a third digit — and two digits apart is a tone plus an interdigit gap, on the order of 150–200 ms
even from a fast typist, which no path a call is still usable on reorders by. Remembering more would
mean a history whose size is a guess, defending against a network on which the audio has already
failed.

**Detection is a TAP, not a consumption, and one test asserts both halves.** The packet still goes
on to the relay, byte for byte, with rung 2's header rewrite renumbering the payload type between
two legs that negotiated differently — the far end of an attended transfer is entitled to hear the
key the caller pressed. And the event fires whether or not the session is bridged, exactly as ARI's
`ChannelDtmfReceived` fires on a channel in no bridge at all: a leg collecting a PIN has no peer, and
a detector wired into the forwarding path would be silent for precisely the case detection exists
for. The tap sits next to the recording tap in `handlePacket`, for the same reason.

**`durationMs` is the SENDER's number**, converted from the telephone-event duration field at the
8 kHz RTP clock, and never a wall clock at this end — that would fold this network's jitter into a
number describing somebody's finger. A cut-off digit reports the largest duration the sender claimed
rather than how long we waited. Largest and not latest, because RTP reorders and the field only ever
grows at the source.

**What is deliberately NOT on the wire:** the reason a digit closed. `mediad` records it
(`DtmfEndedBy`) for its own logs and tests, because "this keypress arrived without its END packet" is
the only evidence that an IVR's occasional slow response is the network rather than the IVR. It is
not in the contract, because the engine does not branch on it and a vocabulary two media planes must
agree on for nobody's benefit is exactly what §3.2 exists to prevent. There is no `dtmf.started`
either: the marker bit is a real signal, but `MediaPort` has no operation to hang on it, ARI raises
nothing equivalent, and a consumer handed both would have to decide which one a `gather` counts.

**Non-keypad events are dropped rather than translated.** RFC 4733 §3.2 codes 0–15 are the sixteen
DTMF keys; 16 is hook flash and everything above belongs to the tone tables in §4. A `gather`
matching on a string cannot contain any of them, so inventing a character would be handing the
dialplan something no rule can match. Lower-case is not emitted either — the value is compared
against dialplan digits, and two spellings of one key is a feature code that works on some phones.

**`terminateOn` is now implementable, and is deliberately not implemented in this wave.**
`start-recording` refuses it `not_supported` today because there was no way to see a digit; there now
is, and closing it is a recorder that stops on a detected digit plus one field threaded through the
handler. It is named as follow-up (§10 question 10) rather than folded in here, because voicemail —
the caller that needs it — also needs `beep`, which needs the tone generator §10 question 11 defers,
so implementing one of the two changes nothing about which plane serves a voicemail.

### 6.2 Recording: a session is already both directions (rung 4)

**There is no snoop channel, and there is nothing to add one for.** On Asterisk, recording a
conversation means creating a SNOOP channel that spies on `both` directions of a leg and recording
that; the snoop exists because ARI addresses everything by channel id, so a tap has to BE a channel
in order to be a thing a command can name. `mediad` has no such constraint — what a session
receives is the far party, what it sends is everything the far party was told — so the direction is
an **argument on the command**:

- `receive` — the far party only. The faithful mirror of ARI's `channels.record` on a plain channel,
  which is what the voicemail path uses: a mailbox message should hold the caller, not the greeting
  that was played at them.
- `both` — the snoop replacement. Both directions decoded, summed and written as one mono stream.

`MediaPort.snoop` therefore stays **refused, and it is the only refusal on the coverage map that is
not a rung**. Reproducing it would mean inventing a session with no port that publishes a
`leg-arrived` for a leg that does not exist — which is precisely the "emit synthetic ARI events
forever" outcome §3.2 exists to prevent.

**`both` is a real mix, and it is affordable here for the reason it is not affordable at rung 6.**
The recorder owns a 20 ms tick and samples one frame from each direction's queue, decodes to linear,
sums with saturation, and writes. Nothing downstream is waiting, the alignment error is bounded by
one frame, and a frame of skew is inaudible in a playback where it would be a defect in a live
conference. Rung 6's mixer is a different problem: N sources on a common clock, mix-minus per
participant, feeding live ears.

**It ticks rather than writing on arrival, and that is what makes the durations true.** An endpoint
doing silence suppression sends nothing while nobody speaks, so a write-on-arrival recording of a
30-second voicemail with two pauses is 22 seconds long and every word after the first pause is
early. A ticking recorder writes silence into the gaps — which is also the only way `maxSilenceMs`
can mean anything, since a direction that has STOPPED sending is exactly the case it must detect.

**Where the file goes: `MEDIAD_RECORDINGS_DIR/<orgId>/<callId>/<recordingRef>.wav`**, and every
token is one `mediad` already holds — the org and the call arrived on `allocate-session`. That is
not a coincidence but the whole design: it is byte-for-byte the object key `apps/engine` computes
for the same recording (`${organizationId}/${callId}/${recordingId}.${format}`) and byte-for-byte
what `apps/api`'s `CdrRecordingWriter` stats under `CDR_RECORDING_ROOT` before it archives. **One
mount, the same mount discipline `MEDIAD_SOUNDS_DIR` uses for prompts, and the existing archive
pipeline reads what `mediad` wrote with no change at all.** A path is never accepted from the
caller: the engine has nothing to say about a layout the media plane can derive, and a malformed or
hostile one is a write to an arbitrary directory.

Worth stating plainly, because it is an improvement rather than parity: the ARI path passes
`name: recordingId` — a bare UUID — so Asterisk writes to its own spool, which is NOT the shared
volume, and the archiver logs that the object was not there. `mediad` writing the object key
directly closes that gap.

**Format: WAV, 8 kHz, mono, PCM16.** Linear rather than the G.711 the leg negotiated, even though
that would be a byte-for-byte copy at half the size, for three reasons in the order they bite: a
`both` recording has to SUM, which only exists in the linear domain; `apps/api` serves every
recording as `audio/wav` and something has to play it, where µ-law-in-WAV is supported unevenly;
and one law is wrong for the other half of a call the day two legs answer differently.

**Finalisation, and why a crash is detectable.** The file is written to `<key>.wav.partial` with a
placeholder header, and on stop the buffer is flushed, both length fields are patched, the bytes are
fsynced, and only then is it **renamed** into the object key. So the final path either does not
exist or is a complete recording — never a plausible-looking WAV the archiver would copy and the
person who needed it would find empty. A crash leaves a `.partial`, which is greppable and is
nothing else. A recording that cannot be finalised removes its partial and reports `reason: error`,
because saying `stopped` would tell the engine a file exists that does not.

**`recording.finished` is the one media event the engine really branches on**, mapping to
`recording-finished` or, on `error`, `recording-failed` — the same split ARI's own
`RecordingFinished`/`RecordingFailed` makes, and the callers depend on it: a failure means there is
no file, so no voicemail message is filed and no recording key lands on the CDR. It is published
only after the rename, because an event published earlier archives a file that is still being
written. It also carries `bytes`, which nothing else on this backbone can supply: the engine's
`channel.record.stopped` has an optional byte count it has never been able to fill, so
`recordings.size_bytes` is zero on every row today.

**Two arguments are refused rather than approximated**, with the same distinction `tone://` draws at
`start-playback` — the operation exists, this plane cannot serve that argument:

- **`beep`** needs a tone generator `mediad` does not have. A voicemail whose beep never sounds is a
  caller talking over the tail of the greeting with the first words of every message clipped.
- **`terminateOn`** needed DTMF DETECTION, which rung 3's receive half now provides — so this is the
  one refusal on the list that is a WIRING gap rather than a missing capability. It is still refused
  until the recorder is taught to stop on a detected digit (§10 question 10), because a recording
  that ignored `#` would run to `maxDurationMs` on every voicemail, and answering `ok` while ignoring
  the argument is the silent failure this design keeps rejecting.

Both are `not_supported` with the capability named, so the engine routes that leg to Asterisk.
**The practical consequence, stated rather than hidden: `plan-walker`'s voicemail node sends both,
so voicemail still runs on Asterisk under this driver**, and `call-control`'s on-demand recording
calls `snoop` before `record`, so it does too. The rung-4 capability is complete and the two callers
have not been pointed at it — that is a change in `apps/engine/src/calls/` and
`apps/engine/src/routing/`, and it is named as follow-up work in §10 rather than pretended away.

### 6.3 The session directory (open question 2, answered)

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

### 9.0 Rung 3's receive half — DTMF detection (this wave)

```
packages/events/
├── src/subjects.ts               dtmf.received in MEDIA_SESSION_EVENTS
├── src/schemas/media-events.ts   mediaDtmfReceivedDataSchema — {digit, durationMs, …identity}
└── scripts/registry.ts           the codegen entry, MediaDtmfReceived

packages/events-go/               regenerated: MediaDtmfReceivedData, EventTypeMediaDtmfReceived,
                                  registry_gen.go, parity.json

apps/mediad/
├── internal/rtp/dtmfdetect.go    NEW. The per-session detector: telephone-event parse, the
│                                 timestamp-keyed digit identity, the surfaced-once gate and its
│                                 four closes, the one-digit reorder memory, the session tap
├── internal/rtp/session.go       the receive tap in handlePacket, the OnDtmf hook, two counters
├── internal/rtp/manager.go       Lifecycle.DtmfReceived, the teardown flush, DtmfMaxDigitDuration
├── internal/events/events.go     Publisher.DtmfReceived + the recorder
└── internal/control/lifecycle.go the dtmf.received announcer

apps/engine/src/media/
└── mediad-event-mapping.ts       dtmf.received -> the EXISTING dtmf-received union member
```

**Configuration added: none.** The max-digit cutoff is a bound rather than a policy — five seconds
is outside every real keypress and inside the duration field's own wrap — so it is a constant with a
`ManagerOptions` override that only the suite uses. An env var would be a knob whose only correct
value is the default.

**Nothing engine-side either, and that is the result rather than a convenience.** `MediaEvent`
already had `dtmf-received` with exactly the three fields this event carries, `toMediaEvent` already
produced it from `ChannelDtmfReceived`, and `channel-orchestrator.service.ts` already dispatched it
into `onDtmf`. The whole engine change is eleven lines in `mediad-event-mapping.ts`;
`src/calls/`, `src/routing/` and `src/nats/` are untouched.

**NATS: no permission change, verified rather than assumed.** `apps/mediad`'s publish grant is
`media.evt.v1.>` — a wildcard chosen precisely because the event token is DOTTED and
`media.evt.v1.*.*.*` would match none of these — so the fifth event needs nothing, exactly as rung
1's third and rung 4's fourth did not. (`config/nats.conf`'s comment still says "four
session-lifecycle events"; the grant is right and the count is one behind.)

**Verified.** `apps/mediad` 321 tests race-clean (up from 307), `go build`/`go vet` clean;
`packages/events` 289 (up from 285); `packages/events-go` parity green with byte-reproducible
codegen (generated twice, byte-identical); `apps/engine` 972 unit specs (up from 968), typecheck and
build clean, and the integration suite 12/12 unchanged on the ARI path. A live round trip against a
real broker running the repo's real `config/nats.conf` — so the permission grant was exercised, not
asserted — drove the whole wire on the `mediad` identity with the engine identity as a raw core
subscriber: two legs allocated over raw NATS with SDP, negotiating telephone-event 96 and 101, then
bridged; one keypress injected at a test socket as RFC 4733 sends it (five update packets, marker on
the first, three END copies) produced **all eight packets relayed to the peer** — renumbered 96 → 101,
timestamps preserved, marker intact, three END copies forwarded — and **exactly one**
`media.evt.v1.<org>.<sessionA>.dtmf.received` carrying `digit: "4"`, `durationMs: 100`, the instance
id and the call id.

### 9.1 Rungs 3 and 4 — DTMF generation and recording (the wave before)

```
packages/events/
├── src/subjects.ts               rpc.media.v1.send-dtmf / start-recording / stop-recording,
│                                 recording.finished in MEDIA_SESSION_EVENTS
├── src/schemas/rpc.ts            the three command contracts + MEDIA_RECORDING_DIRECTIONS
└── src/schemas/media-events.ts   recording.finished + MEDIA_RECORDING_END_REASONS

packages/events-go/               regenerated: MediaSendDtmf/StartRecording/StopRecording structs,
                                  MediaRecordingFinishedData, parity.json

apps/mediad/
├── internal/rtp/dtmf.go          NEW. RFC 4733 encoding, the per-digit timestamp span, the three
│                                 END copies, the outbound-stream lock, the digit-string queue
├── internal/rtp/recording.go     NEW. Tick-driven two-direction sampler, the mix, silence and
│                                 duration limits, finalisation on session end
├── internal/audio/wavwriter.go   NEW. Buffered PCM16 WAV writer, header patching, .partial rename,
│                                 DecodeLinear and the saturating MixInto
├── internal/rtp/manager.go       SendDtmf / StartRecording / StopRecording, the recording index,
│                                 RecordingFinished ordered BEFORE SessionEnded
├── internal/control/handlers.go  send-dtmf / start-recording / stop-recording
├── internal/control/lifecycle.go recording.finished announcer
└── internal/config/              MEDIAD_RECORDINGS_DIR

apps/engine/src/media/
├── mediad-media.port.ts          sendDtmf / record / stopRecording implemented; startRecording
│                                 above the interface for `both`; snoop refused as an Asterisk-ism
└── mediad-event-mapping.ts       recording.finished -> recording-finished | recording-failed

config/nats.conf                  three new rpc subjects on both the engine and mediad identities
```

**Configuration added.** `MEDIAD_RECORDINGS_DIR` (no default — an unconfigured instance refuses
every recording by name). Nothing engine-side: `sendDtmf`, `record` and `stopRecording` were
already on `MediaPort`.

**Verified.** `apps/mediad` 305 tests race-clean (up from 245); `packages/events` 285;
`packages/events-go` parity green with byte-reproducible codegen; `apps/engine` 968 unit specs plus
the integration suite unchanged on the ARI path. A live round trip against a real broker running the
repo's real `config/nats.conf` — so the permission diff was exercised, not asserted — proved both
rungs: `send-dtmf` of `"42"` at 60 ms/40 ms produced 12 telephone-event packets on a test socket
under the negotiated PT 101, marker on the first packet of each digit, one shared timestamp per
digit, a duration field growing 160 → 320 → 480, three END copies, a contiguous sequence space
across the whole string, and the second digit starting exactly one tone plus one gap after the
first; a leg offered without `telephone-event` was refused `not_supported` by name. `start-recording`
with `direction: both` on a bridged pair, fed 25 frames each way, then stopped, produced a 9,964-byte
RIFF/WAVE PCM16 mono 8 kHz file at `<root>/<orgId>/<callId>/<ref>.wav` with both length fields
patched, no `.partial` left behind, samples equal to the exact linear SUM of the two directions, and
a `recording.finished` carrying `reason: stopped`, `durationMs: 620`, `bytes: 9964` and the object
key. Releasing a leg under a live recording produced a complete playable WAV and a
`recording.finished` with `reason: session-ended` ahead of the `session.ended`. `beep` and
`terminateOn: "#"` were both refused `not_supported` with the missing capability named, and a stop
of a finished recording answered `ok: true, stopped: false`.

### 9.2 Rung 1 — playback

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

### 9.3 Rung 2 — bridged calls

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
   `media-sessions`. Full reasoning in §6.3. The reply-subject alternative lost because it puts
   routing state in the engine, where a restart loses it.

3. ~~**Is echo mode worth keeping past rung 1?**~~ **Kept, behind `MEDIAD_ECHO_DIAGNOSTIC`.** It is
   now unreachable from the wire — no field in `allocate-session` selects it — so it can never be
   hit by a production call path, which was the whole concern. It costs one branch in the packet
   path and buys the simplest possible smoke test of a real deployment's ports and NAT with no
   second party. A deployment that leaves the flag on serves NO working calls (every leg hears
   itself), so it is warned about on every boot.

4. ~~**Does recording need the `snoop` primitive?**~~ **No, and `snoop` stays refused permanently
   rather than until a rung.** A snoop channel exists because ARI addresses everything by channel
   id, so a tap must BE a channel; a `mediad` session is already both directions, so the choice is
   an argument on `start-recording`. Reproducing the tap would mean a session with no port
   publishing a `leg-arrived` for a leg that does not exist. Full reasoning in §6.2.

**Still open, and honestly so:**

9. **NEW: rung 4 is complete and neither of its two callers can reach it yet.** The capability is
   built and proved end to end, but `plan-walker`'s voicemail node sends `beep: true` and
   `terminateOn: "#"`, and `call-control`'s on-demand recording calls `snoop` before `record` — so
   both route to Asterisk under this driver. Closing it needs two changes OUTSIDE `mediad`, in
   `apps/engine/src/routing/` and `apps/engine/src/calls/`: teach the on-demand path to ask
   `MediadMediaPort.startRecording({direction: "both"})` when the driver is `mediad` instead of
   creating a tap, and give voicemail a path that does not need a beep or a digit terminator. The
   refusals are the per-capability cutover working exactly as designed; what is missing is the
   caller, not the capability.

10. **DTMF DETECTION is built; `terminateOn` is now a WIRING gap rather than a missing capability.**
    ~~Rung 3's receive half is not built~~ — it is, in §6.1.1: a keypress on any session becomes one
    `dtmf.received`, mapped into the `dtmf-received` union member the orchestrator already consumed,
    so the confirmation IVR and feature codes work on this driver unchanged. What is still open is
    the CALLER: `start-recording` continues to refuse `terminateOn` by name, because refusing an
    argument is honest and accepting one it ignores is a voicemail that runs to `maxDurationMs` on
    every message. Closing it is small and local to `mediad` — the recorder gains a terminator set
    and stops on a matching digit from the detector it now has — and it is deferred because
    voicemail, the only caller that sends it, also sends `beep`, which needs the tone generator in
    question 11. Implementing one without the other moves no call off Asterisk.

11. **There is no tone generator, and two features name it.** `tone://` at
    `start-playback` and `beep` at `start-recording` are the same missing piece. It is small (a sine
    into the leg's companding law, generated once, played through the existing playback path) and it
    is deferred rather than built because neither caller can use `mediad` for other reasons today.
    Detection has now landed, so `terminateOn` is a small local change (question 10) and this is the
    LAST thing standing between voicemail and this driver — which is what makes it the next one.

12. **What does graceful drain mean for a media server?** Unchanged, and now one dependency closer:
    the session directory exists, so an instance can enumerate what it holds and another can find it.
    What is still missing is the MOVE — repointing a far end needs an authenticated re-INVITE from
    the signalling plane, so this cannot be finished inside `mediad` at all. Today a drain closes
    live sessions and says so on the wire (`session.ended` with `reason: drained`), which is the
    honest description of "calls on this instance lose audio". **This must be solved before `mediad`
    carries production traffic, not after.**

13. **Does `sipd`'s proxy wave need to know about `mediad`?** §5 still says no — the engine is the
    courier — and this wave did not test it, because there is no INVITE path yet. It is now the
    BLOCKING question rather than a background one: `MediadMediaPort` refuses `answer`, `ring` and
    `originate` by design, so nothing can drive a whole call through `mediad` until `sipd` terminates
    the dialog and hands the engine an offer. Re-test the post-dial delay of the extra hop when it
    lands; if it is material, the coupling has to be argued for explicitly rather than discovered.

    **DESIGNED, not built: `plans/sipd-invite-design.md`.** §5's answer holds — the engine stays the
    courier and `sipd` gets no `mediad` client — but the design does require **one change inside
    `mediad`**, and it is the one this document deliberately deferred. A B-leg has no offer, so
    `mediaAllocateSessionRequestSchema`'s "v1 ANSWERS offers… generating an offer for a leg the
    engine is originating arrives with the rung that needs it" is now the rung: `rpc.media.v1.create-offer`
    and `rpc.media.v1.accept-answer`, symmetric with `allocate-session`, so that `mediad` writes the
    outbound offer and `sipd` still never picks a codec. That design also supplies what open questions
    12 and 15 have been waiting on — `rpc.sip.v1.reinvite` is the authenticated re-INVITE a graceful
    drain needs to MOVE a session, and its slice 1 is the first time a real phone can hear rung 1's
    prompt. Post-dial delay is question 2 there and is still unmeasured.

14. **RTCP: when?** Still bound and unread. It carries the receiver reports that are the only in-band
    signal of call quality, and §8.4's MOS/jitter gate wants them. It did not block rung 2 — a relay
    forwards RTP whether or not it reads RTCP — so it moves to the rung that first needs a quality
    number it cannot get from anywhere else.

15. **NEW: rung 1's gate is half met, and the missing half is not `mediad`'s to close.** The ladder
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

16. **NEW: what proves the audio is GOOD, not just correct?** §8.4 gates rungs 2 and 6 on MOS and
    jitter against an Asterisk baseline on the same hardware. This wave proved CORRECTNESS — the
    right bytes reach the right socket with the right header — and measured nothing. The relay adds
    no jitter buffer and no transcoding, so the expected delta is a few hundred microseconds of
    forwarding latency, but "expected" is not "measured", and the whole point of the gate is that
    absolute MOS numbers are meaningless while the delta against the thing being replaced is not.
    **Rung 2 is not cut over until this exists.**

17. **NEW: the `MediaPort` conformance suite (§8.1) still does not exist.** There is now a second
    implementation to run it against, which is exactly the condition that made it worth building —
    `describeMediaPortConformance(makePort)` invoked against the fake, against `AriMediaAdapter`, and
    against `MediadMediaPort`. Without it, "the seam holds" is proved by two separate suites that
    could drift, rather than by one suite two implementations must both satisfy.
