# `apps/sipd` — the INVITE path

**Status:** **design only. Nothing in this document is built.** `apps/sipd` is a registrar plus
REFER; `apps/sipd/cmd/sipd/main.go:186-190` registers `OnRegister`, `OnOptions` and `OnRefer` and
routes everything else — INVITE included — to `Registrar.HandleUnsupported`, which answers `501`
(`apps/sipd/internal/registrar/registrar.go:271-277`). `apps/mediad` is at rung 4 and
`MediadMediaPort` refuses `answer`, `ring` and `originate` by name
(`apps/engine/src/media/mediad-media.port.ts:512-538`). Those two facts are the same fact: **no
phone can reach `mediad`, because nothing terminates a dialog and hands the engine an offer.**

**This is `plans/mediad-design.md`'s blocking open question, answered as a plan rather than as a
paragraph.** It is item **13** of that document's §10 — "Does `sipd`'s proxy wave need to know about
`mediad`?" — which §9 there also points at as "§10 question 4". Both pointers mean this.

**Plan refs:** master plan §3.1/§3.4 option E (`plans/optimiq-voice-master-plan.md:55`, `:155`), §PG
(`:232`), §D5 — Telnyx as the carrier layer (`:286`), §P6 (`:233`).
**Peer:** `plans/mediad-design.md`. Same track, same idiom, same seam.

This document is the map for the whole INVITE effort: what an engine "channel" becomes once a SIP
dialog is a first-class object owned by another process, the order capabilities are cut over in, the
wire between the three planes, what `sipgo` gives us and what has to be written, and how a call is
proved rather than asserted.

---

## 1. Scope, and the thing that is actually missing

The gap is larger than "sipd cannot answer an INVITE", and it is worth stating plainly before
designing anything, because it changes what the first slice is for.

**There is no working PSTN path in this repository today, on either plane.**

- `apps/asterisk/config/pjsip.conf` is sixteen lines. It defines one TCP transport and an endpoint
  identification order. There is **no `endpoint`, no `identify`, no `acl`, no `registration`** in it,
  and `apps/asterisk/config/acl.conf:1` is the single line `; Placeholder`.
- The only carrier-shaped configuration that is actually loaded is
  `apps/asterisk/config/pjsip_wizard.conf`, read by `res_pjsip_config_wizard.so`
  (`apps/asterisk/config/modules.conf:14`). It registers **outward to the legacy Routr proxy** and
  its `endpoint/context = local-ctx` (`pjsip_wizard.conf:10`), which reaches
  `Stasis(mediacontroller)` (`apps/asterisk/config/extensions.conf:165`) — the deleted product's
  application, **not** `Stasis(${ENV(OPTIMIQ_ARI_APP)})`.
- `apps/asterisk/config/pjsip_telnyx_example.conf` shows what a Telnyx trunk would look like, and
  says at `:6-8` that it "is not `#include`d by `pjsip.conf`, so nothing here takes effect unless
  somebody copies it deliberately".
- Nothing turns a `trunk` row into pjsip configuration. `plan-walker.ts:1500-1502` substitutes
  `ENGINE_TRUNK_DIAL_TEMPLATE` (`apps/engine/src/config/engine-env.ts:181`, default
  `PJSIP/{number}@{trunk}`) with **`trunk.name`** — so an outbound call requires a hand-written
  Asterisk endpoint section whose name happens to equal a database column, and no generator writes
  one.
- `compose.yaml:216-217` gives the asterisk service `expose: [6060]` and publishes no ports at all,
  SIP or RTP. No carrier can reach the shipped deployment.
- `[optimiq-inbound-untrusted]` (`extensions.conf:113-125`) exists and is explicitly labelled the
  carrier target at `:110` — and nothing points at it.

So the INVITE path is **not** a replacement for something that works. It is the first end-to-end
call path this platform will have that the engine actually drives. That is good news for
sequencing — there is no traffic to migrate on the trunk side, so the risk is confined to the
extension side — and it is bad news for anyone who reads "Asterisk is the media plane" as "Asterisk
is carrying calls today". It is carrying calls for registered dev endpoints
(`pjsip_dev_endpoints.conf`, off unless `OPTIMIQ_DEV_ENDPOINTS=true`) and for nothing else.

**Scope of this design:** `sipd` becomes a **back-to-back user agent**. It terminates every SIP
dialog, on both sides, and puts `mediad` in the media path. It is not a proxy and will not become
one; see §9.10.

**Out of scope, named so they are decisions rather than omissions:** SRTP/DTLS (a `mediad`
question — `plans/mediad-design.md` §1 declined `pion/webrtc` deliberately), SIPREC, T.38 (rung 8
over there), and any form of dialog migration between `sipd` instances (§6.4).

---

## 2. The cutover ladder

Per the master plan's sequencing rule (`plans/optimiq-voice-master-plan.md:167`), cutover is **per
capability**, and each slice is independently revertible by configuration. The unit of revert here
is not an environment variable in the engine — it is **where a phone or a carrier is pointed**, which
is §8's whole argument.

| #     | Slice                            | What it adds                                                                                                                                              | Why here                                                                                                             | Gate                                                                                                                              |
| ----- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **0** | **Dialog substrate**             | UAS `INVITE`/`ACK`/`BYE`/`CANCEL`, one goroutine per dialog, the `sip-dialogs` claim, the `sip.evt.v1` publisher, the command surface refusing everything | Everything else consumes it, and the concurrency shape (§4.6) is not retrofittable                                   | Go unit suite race-clean; a SIPp UAC gets `100`/`200`/`ACK`/`BYE` with no media and no engine                                     |
| **1** | **Extension ↔ extension**        | Admission RPC, `answer`/`ring`/`hangup`/`originate`, `mediad` allocate on the A-leg, `create-offer`/`accept-answer` on the B-leg, bridge                  | The smallest thing that is a real call. Two-party audio between registered endpoints is the whole product's floor    | Two real softphones talk both ways; a CDR row with a correct `billsec`; `engine-integration.spec.ts` green with the plane swapped |
| **2** | **Progress and teardown**        | `180`, RFC 3398 status→Q.850 mapping, RFC 3326 `Reason`, CANCEL/`487`, glare/`491`, Timer B, ring timeout                                                 | A call that fails has to fail with the right cause or every CDR disposition is a guess                               | A SIPp matrix — busy, no-answer, cancel, decline, unreachable — each producing the right `disposition`                            |
| **3** | **Trunks inbound**               | Trunk ACL from a watched read model, `did-index` attribution, per-trunk E.164 normalisation, the `routingContext` boundary                                | The first slice where an unauthenticated stranger can send us a packet. Nothing above it is safe until this is right | A real Telnyx call reaches an extension; an INVITE from an unlisted source is refused before it costs a NATS round trip           |
| **4** | **Trunks outbound**              | UAC to a trunk with digest, outbound proxy, caller-ID/ELIN presentation, trunk REGISTER, OPTIONS pinger writing `trunk.status*`                           | Outbound is where toll fraud lives, so it comes after the ACL slice, not before                                      | A real PSTN call out; `call.emergency.dialed` still published before the first attempt                                            |
| **5** | **Mid-call: re-INVITE**          | UAS and UAC re-INVITE, re-answer through `mediad`, `leg-held`/`leg-unheld`, REFER resolving a real dialog                                                 | The second-largest build item (§9.2), and the unblocker for `mediad` rung 5 AND for `mediad`'s drain (§7.5)          | A desk phone's HOLD and TRANSFER keys work end to end                                                                             |
| **6** | **Multi-contact, park, pickup**  | List-valued `registrations`, engine-level forking across contacts, park/pickup within the plane                                                           | Needs slice 5's dialog manipulation and the location-model change the README has been deferring                      | A call rings a desk phone and a softphone; the loser gets `LOSE_RACE`; pickup works                                               |
| **7** | **NAT, session timers, TLS/WSS** | `rport`/`received` on mid-dialog requests, `Record-Route`, RFC 4028, `ListenAndServeTLS`, WSS                                                             | A phone behind NAT is the normal case, and it is the case slices 1–6 can survive without only in a lab               | A phone behind a NAT stays reachable for an hour; a `wss` softphone registers (audio blocked on SRTP — §11.6)                     |
| **8** | **Conferences and queues**       | Nothing new in `sipd`; it is `mediad` rung 6 (N-way mix) arriving                                                                                         | Listed so the ladder terminates honestly: `sipd` is not the blocker here                                             | MOS at 3/5/10 participants, per `plans/mediad-design.md` §8.4                                                                     |

Asterisk is retired (§P6) when both ladders top out — this one at slice 7 and `mediad`'s at rung 8.
`apps/asterisk` and `packages/media-ari` stay until then.

**Effort, honestly.** Slices 0 and 1 together are comparable to `mediad` rungs 0 through 2 combined:
a dialog runtime, a command surface, an event family, two new `mediad` commands, one composite port
in the engine and one mapping file. Slice 5 is the second large one, because §9.2 has to be written
from scratch. Slices 2, 3, 4 and 6 are each materially smaller. Slice 7 is mostly deployment.

---

## 3. Dialog ownership: what the engine's "channel" becomes

### 3.1 The identity decision

Today a leg has exactly one id: the ARI channel id. It is what `ChannelRegistry` indexes
(`apps/engine/src/calls/channel-registry.ts`), what `ParkRegistry.byChannel` is keyed by
(`apps/engine/src/routing/park-registry.ts:152-154`), what `ControlledLeg.mediaChannelId` carries
(`apps/engine/src/calls/call-control.ts:88`), and what `QueueCallPort.bridge(mediaChannelId, …)`
takes (`apps/engine/src/queue/queue-session.ts:111`).

Under a split plane there are three candidate identities for one leg: a SIP dialog in `sipd`, an RTP
session in `mediad`, and a channel in the engine.

**Decision: one string names all three. `sipd` mints it for inbound, the engine mints it for
outbound, and it is simultaneously the leg id, the `mediad` `sessionId` and `sipd`'s dialog handle.**

The repo has already made half of this decision and stated why. `MediadMediaPort`'s class note
(`apps/engine/src/media/mediad-media.port.ts:93-99`) records that the session id **is** the leg id,
"both are assigned by the engine… no mapping table to lose on an engine restart", and
`mediaAllocateSessionRequestSchema`'s note in `packages/events/src/schemas/rpc.ts` gives the same
argument for caller-assignment: "the caller must be able to release a session whose allocate reply
it never received". Extending it to the dialog costs nothing and buys the same property in the
signalling direction: **the engine can hang up a leg whose admission reply it never saw.**

The SIP dialog identifier — `Call-ID`, `From` tag, `To` tag — is **data on the payload, never the
key**. That is already the shape `sipTransferRequestSchema` uses
(`packages/events/src/schemas/rpc.ts:456-478`): `sipCallId` is documented there as "a LOOKUP KEY and
never an authorisation", and the tags ride alongside it as optional fields.

**Rejected: a separate `dialogId` with a mapping table in the engine.** It is the same alternative
`plans/mediad-design.md` §6.3 rejected for instance addressing, and it loses for the same reason: an
engine restart loses the map and every live call becomes uncommandable. It would also make the
`channels` KV bucket — keyed `kvKeyFor.channel(orgId, callId, channelId)` — unable to address a
dialog, which is the lookup §7.3 needs.

**Rejected: `sipd` uses the SIP dialog id (`Call-ID` + tags) as its handle and the engine translates.**
A `Call-ID` is phone-chosen, arbitrary-length and full of characters no NATS subject or KV key token
accepts (`TOKEN_PATTERN` in `packages/events/src/subjects.ts` — `[A-Za-z0-9_-]+`). Every subject would have to carry
a hash of it, exactly as `aorSubjectToken` in the same file hashes an AOR, and a hash is a
handle we invented anyway. Better to invent one that is also the engine's.

### 3.2 The command half: a composite `MediaPort`, not a second interface

`MediaPort` has 24 methods (`apps/engine/src/media/media-port.ts:156-262`). Three of them are pure
signalling — `answer` (`:158`), `ring` (`:161`), `originate` (`:205`) — and `mediad` refuses all
three today with "signalling, which `apps/sipd` owns". One of them, `hangup` (`:170`), is both.

Two shapes were available.

- **Option 1 — a composite implementation.** One new `MediaPort` implementation that fans each
  method out to whichever plane owns it. Nothing above the seam changes.
- **Option 2 — a second port.** A `SignallingPort` next to `MediaPort`, and the orchestrator, the
  verb executor, `CallControl` and the plan walker all learn there are two.

**Decision: option 1.** The whole value of this seam is the sentence in `media-port.ts`'s own doc
comment, quoted in `plans/mediad-design.md` §3.1: "the verb executor above it never learns which".
Splitting the interface would push a three-way distinction (ARI / mediad-only / sipd+mediad) into
five files that currently know about none of them. A composite is one new file whose 24 methods are
each one line of delegation — and it is the **first implementation for which all 24 are servable**.

Concretely, `apps/engine/src/media/split-plane.port.ts`:

| Group                                                                                                                             | Served by               | Notes                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `answer`, `ring`, `originate`                                                                                                     | `sipd` + `mediad`       | Compositions, not delegations. See §4 and §5                                     |
| `hangup`                                                                                                                          | `sipd` **and** `mediad` | BYE the dialog, then `release-session`. Media first would drop audio mid-goodbye |
| `play`, `stopPlayback`, `record`, `stopRecording`, `sendDtmf`, `createBridge`, `addToBridge`, `removeFromBridge`, `destroyBridge` | `mediad`                | Unchanged; already built and proved                                              |
| `getVariable`, `setVariable`, `channelExists`, `watchChannel`                                                                     | **the engine itself**   | See §3.4                                                                         |
| `startMusicOnHold`, `stopMusicOnHold`, `hold`, `unhold`, `mute`, `unmute`                                                         | refused                 | `mediad` rung 5, plus slice 5's re-INVITE. Refused with both named               |
| `snoop`                                                                                                                           | refused, permanently    | `plans/mediad-design.md` §10 question 4                                          |

**17 of 24 at slice 1, up from `mediad`'s 12.** The refusal is the same typed
`MediaOperationNotSupportedError` (`apps/engine/src/media/media-not-supported.error.ts:24-43`) with
`driver` set to the composite's name, and it still never silently no-ops — the argument at
`plans/mediad-design.md` §3.1 for why a quiet `record` is the worst defect a telephony system has
applies unchanged.

### 3.3 The event half: `sip.evt.v1` into the same twelve-member union

`apps/engine/src/media/media-event.ts:198-210` already defines the vocabulary, and it was chosen by
what the orchestrator consumes — the orchestrator's `dispatch` is exhaustive with no `default:`
(`channel-orchestrator.service.ts:289-335`). The mapping layer is the pattern:
`calls/ari-mapping.ts:242` translates ARI, `media/mediad-event-mapping.ts`'s `toMediaEventFromMediad` translates `mediad`.

**Decision: a third mapping file, `apps/engine/src/media/sipd-event-mapping.ts`, and no new union
members.** The union is not extended, because a member nobody branches on is a shape three services
would then have to agree on for no reason.

| `sip.evt.v1` event  | `MediaEvent`                               | Notes                                                                              |
| ------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `dialog.progressed` | `call-state-changed` → `ringing` / `early` | `early` only when the `18x` carried SDP                                            |
| `dialog.answered`   | `call-state-changed` → `active`            | Published on ACK for a UAS leg, on the `2xx` for a UAC leg                         |
| `dialog.held`       | `leg-held`                                 | Re-INVITE moving to `sendonly`/`inactive` (slice 5)                                |
| `dialog.resumed`    | `leg-unheld`                               | Slice 5                                                                            |
| `dialog.terminated` | `leg-ended`                                | Carries a real Q.850 cause. See below                                              |
| `dialog.dtmf`       | `dtmf-received`                            | SIP INFO digits only. RFC 4733 is `mediad`'s and is `mediad` rung 3's receive half |

`leg-arrived` is deliberately **not** on this list: it is produced by the admission RPC's caller-side
in the engine, not by an event, and §4.2 is the argument.

**Three members are never produced, and each absence is a decision:**

1. **`leg-left`.** On ARI it means "the channel left the Stasis application but still exists", which
   is why `watchChannel` had to exist at all (`media-port.ts:194`, and the note at
   `media-event.ts:86-90`). A SIP dialog either exists or it does not; there is no dialplan to leave.
   The orchestrator's `onLegLeft` (`channel-orchestrator.service.ts:1603-1610`) only releases the DTMF
   and mid-call-feature registrations, and `onLegEnded` does both again at `:1657-1658`. So never
   producing it is safe by inspection, and `watchChannel` becomes a no-op satisfied by construction —
   exactly as `MediadMediaPort.watchChannel` already is (`mediad-media.port.ts:505-508`).

2. **`hangup-requested`.** It exists so the engine can fix a specific cause first-wins **before** the
   generic teardown cause arrives (`media-event.ts:118-124`, and `markHangup` at
   `channel-orchestrator.service.ts:1655`). Under `sipd` there is no "afterwards": a BYE **is** the
   termination and `dialog.terminated` carries the only cause there will ever be. Emitting both from
   one wire event would tear the leg down twice — the same argument `plans/mediad-design.md` §3.2
   makes for mapping `session.rtp-timeout` to nothing.

3. **`recording-*`.** `mediad` already produces these and the mapping for them already exists.

**The Q.850 cause is genuinely better here, and that is worth stating.**
`plans/mediad-design.md` §3.2 records that "a media plane has no Q.850 opinion — it never saw a SIP
response", so `mediad-event-mapping.ts` picks the closest cause it can defend from a table of four
reasons. `sipd` **did** see the SIP response. So:

- The status code maps through **RFC 3398** (`486` → `USER_BUSY`/17, `480` → 18, `404` → 1
  `UNALLOCATED_NUMBER`, `487` → 16, `503` → 41, `403` → 21 `CALL_REJECTED`, …).
- When the far end sent an **RFC 3326 `Reason: Q.850;cause=NN`** header, that value wins verbatim.
  It is the far end telling us what its own switch decided, and re-deriving it from the status code
  would be discarding better evidence for worse.
- The mapping is a table in `packages/events-go` territory, not a switch in the engine, so both
  languages read one source. The engine's existing `hangupCauseFromAri`
  (`apps/engine/src/calls/ari-mapping.ts:83`) and its surrogate table (`:100-120`) stay as they are;
  ARI's causes are already Q.850.

### 3.4 Channel variables stop being a wire concept

This is the sharpest consequence of the split, and it is not obvious.

`MediadMediaPort` refuses `getVariable`/`setVariable` because "channel variables are a dialplan
concept" (`mediad-media.port.ts:522-533`). That refusal is fine while `mediad` cannot serve
`originate` anyway. It stops being fine at slice 1, because the engine reads five variables on
**every arrival** — `readEngineVariables` at `channel-orchestrator.service.ts:1900-1929` reads
`OPTIMIQ_ORG_ID`, `OPTIMIQ_CALL_DIRECTION`, `OPTIMIQ_ROUTING_CONTEXT`, `OPTIMIQ_LEG` and
`SIP_CALL_ID_VARIABLE` — and stamps three more onto every originated B-leg
(`plan-walker.ts:3252-3257`). Without them, `OPTIMIQ_LEG === "b"`
(`channel-orchestrator.service.ts:378`) never matches and every answered B-leg is filed as a second
inbound call, which is the exact failure the check exists to prevent.

**Decision: on this plane the composite serves `getVariable`/`setVariable` from the engine's own
per-leg store, with no wire trip at all.**

They were never really media-server state. They are engine state that Asterisk happened to hold.
`ChannelAggregate` already carries `variables` (`channel-orchestrator.service.ts:418`) and already
has `setVariable` (`:1958`); `legHooksFor(…).originated` already stamps the B-leg's three
(`:1133-1142`) at the moment the leg is created — **before** the media server is asked
(`plan-walker.ts:3228-3243`). So `OriginateRequest.variables` is satisfied by writing the aggregate
that is being created anyway, and the arrival read is a map lookup.

Two consequences worth naming:

- **`SIP_CALL_ID_CHANNEL_FUNCTION` disappears on this plane.** `channel-identity.ts:88-93` reads
  `CHANNEL(pjsip,call-id)` over the port because ARI is the only way to learn a `Call-ID`. Under
  `sipd` the `Call-ID` is on the admission reply, so `channelCreatedDataSchema.sipCallId`
  (`packages/events/src/schemas/call-events.ts:44`) is populated natively and `readSipCallId`
  (`channel-orchestrator.service.ts:1964`) becomes an ARI-only path.
- **`MediaChannelSnapshot.variables`** (`media-event.ts:71`) is documented as "an OPTIMISATION, never
  the source of truth". On this plane it is the source of truth, because there is nowhere else to
  read from. That is a strengthening of the contract, not a violation of it — the field's rule is
  "the engine falls back to reading each one over the port", and here the port reads the same map.

### 3.5 The driver switch, and the one illegal combination

`ENGINE_MEDIA_DRIVER: z.enum(["ari","mediad"]).default("ari")`
(`apps/engine/src/config/engine-env.ts:298`) is the precedent, and it is the right shape for one
plane. It is the wrong shape for two, because it cannot express "signalling here, media there".

**Decision: add `ENGINE_SIGNALLING_DRIVER: z.enum(["asterisk","sipd"]).default("asterisk")`, and
refuse the illegal combination at boot.**

|                       | `MEDIA=ari`                        | `MEDIA=mediad`                                                                                |
| --------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `SIGNALLING=asterisk` | today's default; `AriMediaAdapter` | today's opt-in; `MediadMediaPort`, `answer`/`ring`/`originate` refused — no call can complete |
| `SIGNALLING=sipd`     | **refused at boot**                | the composite; this design                                                                    |

`sipd` cannot drive Asterisk's media (it has no ARI credential and no channel to name), so
`SIGNALLING=sipd, MEDIA=ari` is a deployment that starts and then fails every call. It must fail to
start instead. The precedent for booting-to-a-refusal is `MediadService.onModuleInit`
(`apps/engine/src/media/mediad.service.ts:73-96`), which already refuses to start when
`ENGINE_MEDIA_DRIVER=mediad` and no `mediad` answers a probe.

**A prerequisite this design depends on, and which is broken today:** `apps/engine/src/main.ts:52-60`
wires `ari.setEventHandler(…)` and calls `ari.start()`, and **never calls `MediadService.start()`**.
So under `ENGINE_MEDIA_DRIVER=mediad` commands reach `mediad` and its events reach nobody — nothing
tears a leg down on `session.ended`, and no CDR is ever written from this plane. That is a two-line
fix in `main.ts` and it is a hard prerequisite for slice 1, not a nicety. It is named again in §11.

---

## 4. The INVITE flow, end to end

### 4.1 The three planes on one call

```text
   phone / carrier                sipd                 engine                  mediad
        │                          │                     │                       │
        │──INVITE (offer)─────────▶│                     │                       │
        │◀─100 Trying──────────────│                     │                       │
        │                          │  digest / trunk ACL │                       │
        │                          │──rpc.sip.v1.invite─▶│  attribute (did-index)│
        │                          │◀─{accepted, legId}──│                       │
        │                          │                     │  leg-arrived          │
        │                          │                     │  routing walk         │
        │                          │◀─rpc.sip.v1.ring────│                       │
        │◀─180 Ringing─────────────│                     │                       │
        │                          │                     │──allocate-session────▶│
        │                          │                     │◀─{sdpAnswer}──────────│
        │                          │◀─rpc.sip.v1.answer──│                       │
        │◀─200 OK (answer)─────────│                     │                       │
        │──ACK────────────────────▶│                     │                       │
        │                          │──dialog.answered───▶│                       │
        │◀════════════════ RTP ═══════════════════════════════════════════════════│
```

The engine remains the courier for SDP, exactly as `plans/mediad-design.md` §5 requires:
`sipd` hands over the body as opaque bytes and never picks a codec; `mediad` is the only process
that parses it. Nothing here gives `sipd` a `mediad` client, and nothing gives `mediad` a SIP stack.

### 4.2 Admission is a synchronous RPC; everything after it is asynchronous

Two shapes were available for "the engine is consulted".

- **Shape A — one synchronous RPC that returns the call's outcome.** `sipd` asks, blocks, and turns
  the reply into `180`/`200`/`4xx`.
- **Shape B — `sipd` publishes an arrival event and waits for commands.**

**Decision: B, with one synchronous admission gate in front of it.**

Shape A cannot work, and the reason is arithmetic rather than taste. A routing walk is not fast: a
ring group rings for `ENGINE_DEFAULT_RING_TIMEOUT_SECONDS` (default 30,
`apps/engine/src/config/engine-env.ts:184`) and may then fall through to voicemail. A request-reply
with a sixty-second deadline is not a request-reply — it is a subscription wearing one's clothes,
and NATS core has no redelivery to make it safe. Every other RPC on this backbone is bounded well
inside two seconds for exactly this reason (`rpc.ts`'s `defineRpc` note: "These are on the call path
— slow is the same as broken").

But a pure fire-and-forget arrival has no refusal path and no back-pressure. A call that cannot be
attributed to a tenant, a draining engine, or an engine that is simply absent must produce a SIP
status the caller understands, not a dialog that sits silently until the far end's Timer B. So
exactly one step is synchronous, and it decides **admission only** — not the outcome.

The precedent is already in this codebase, one level down. `transfer/handler.go:259-272`:

> The 202 goes out BEFORE the RPC. RFC 3515 §2.4.2: accepting a REFER means "I will try and I will
> tell you", not "I have done it".

An INVITE is the same shape: `100 Trying` is out before the admission request, and the admission
request answers "will you take this call at all", not "did it connect".

**Who resolves the tenant.** Split, and the split is load-bearing:

- `sipd` owns **"is this sender allowed to send me an INVITE"** — digest for a registered endpoint
  (the same `registrar.Authenticator` the REFER handler already reuses,
  `transfer/handler.go:35-38`), or a trunk ACL match for a carrier.
- The engine owns **"whose call is it"** — `attributeCall`
  (`channel-orchestrator.service.ts:499-534`) already does this in three ordered steps, and the
  `did-index` bucket exists precisely because "the reader does not know the tenant"
  (`packages/events/src/streams.ts:541-546`).

So the admission request carries `orgId` **optionally** — present when a digest resolved a
credential, absent for a trunk — and the engine answers with the `orgId` it resolved. That closes the
loop `extensions.conf:32-38` has been describing as a production TODO ("the SIP edge sets
`X-Optimiq-Org-Id`, or the engine looks up the DID index") by doing both halves properly, on a typed
wire instead of a header.

**And it is why the event family starts after admission.** `sip.evt.v1.<orgId>.<legId>.<event>`
needs an `orgId` in the subject, on the pattern of every other family
(`SUBJECT_ROOTS` in `packages/events/src/subjects.ts`). For a trunk INVITE, `sipd` does not have one until the
engine answers. Making arrival an RPC rather than an event means **every `sip.evt.v1` subject has a
real tenant in it** — no `_unknown` token, no re-publish under a different subject once the tenant is
learned.

### 4.3 Ringing, and where the SDP answer is committed

`ring` sends `180 Ringing` **without SDP** at slice 1.

Early media — `183 Session Progress` **with** an answer — is deferred to the slice that has something
to put in it (ringback or a real B-leg's audio, which is `mediad` rung 1 playback pointed at an
unanswered leg). The reason to defer rather than to build: a `183` with an answer commits the
offer/answer exchange before the call is answered, and the subsequent `200 OK` must then repeat
**that same answer** (RFC 3261 §13.2.1). Getting that wrong produces a call that connects and has no
audio — the defect class `plans/mediad-design.md` §3.1 spends a paragraph on.

`mediad`'s allocate is **idempotent on `sessionId`** (`rpc.ts`, `mediaAllocateSessionRequestSchema`
note), so when early media does arrive, re-using the answer costs nothing: the same allocate returns
the same session and the same SDP.

**When is the session allocated?** Lazily — at the first command that needs an answer body. The
contract already assumes this: `MEDIA_ALLOCATE_SESSION_RPC`'s 500 ms deadline is justified in
`rpc.ts` as "it also sits inside the engine's answer of an INVITE, where the caller hears every
millisecond as silence before ringback". Allocating at admission time instead would burn an RTP port
pair for every call that rings out and is never answered, and `mediad`'s idle reaper
(`MEDIAD_SESSION_IDLE_TIMEOUT`, 60 s) would be doing the cleaning.

### 4.4 CANCEL, and the race that matters

`sipgo`'s transaction layer already handles the CANCEL mechanics: it responds `200 OK` to the CANCEL
and then drives the INVITE server transaction's FSM to send `487`
(`sip/transaction_layer.go:154-185`, in `github.com/emiago/sipgo@v1.4.3`). What it does **not** do is
tell the application. `sipd` must observe the server transaction terminating and publish
`dialog.terminated{reason: "cancelled", q850Cause: 16}`.

The race that matters is a CANCEL arriving while an `answer` command is in flight. RFC 3261 is
unambiguous: once a `200` has been sent, CANCEL has no effect and the correct teardown is a BYE.

**Decision: `sipd` serialises per dialog — one goroutine owns a dialog, and CANCEL and `answer` are
two messages on the same channel.** Exactly one wins by construction; the loser is answered by name.
An `answer` that lost to a CANCEL is refused `dialog_gone`, and the engine treats it as it already
treats `channel_gone` in the transfer responder (`sip-transfer.service.ts:242-249`). This is the same
concurrency shape `mediad` chose for the same reason (`plans/mediad-design.md` §6.3: "one goroutine
per session… the kernel does the multiplexing").

### 4.5 Re-INVITE, glare, and session timers

**Re-INVITE is the largest single gap in `sipgo` and it is §9.2.** What arrives with it at slice 5:

- **Hold.** `CallControl.hold` (`apps/engine/src/calls/call-control.ts:539-589`) removes the leg from
  its bridge, calls `media.hold(mediaChannelId)` unless `soft`, then starts MOH. On this plane
  `media.hold` becomes "re-INVITE the far end with `a=sendonly`", and MOH is `mediad` rung 5. Note
  that the `soft: true` variant used by attended transfer (`call-control.ts:1243`) needs **only** MOH
  — so it unblocks one rung earlier than full hold does, which is worth knowing when sequencing.
- **`mediad`'s graceful drain.** `plans/mediad-design.md` §10 question 12 says the missing piece is
  the MOVE, and that "repointing a far end needs an authenticated re-INVITE from the signalling
  plane, so this cannot be finished inside `mediad` at all". `rpc.sip.v1.reinvite` (§10.3) **is** that
  command. This design is a prerequisite for that one.

**Glare** — a re-INVITE colliding with one already outstanding — is RFC 3261 §14.2: the UAS answers
`491 Request Pending`, and the UAC that receives a `491` retries after a random interval, 2.1–4.0 s
if it owns the higher `Call-ID` and 0–2.0 s if the lower. `sipgo` implements none of it. It is small
(a per-dialog "offer outstanding" flag plus a timer) and it is not optional: without it, a hold
issued at the same moment the far end holds produces two dialogs each believing they have an
outstanding offer, and the call's media direction is whichever answer lands last.

**Session timers (RFC 4028)** are absent from `sipgo` entirely — `Session-Expires` appears only in
parser test fixtures. Slice 1 ships without them, deliberately, and leans on two things that already
exist: `mediad`'s `MEDIAD_RTP_TIMEOUT` (30 s) publishes `session.rtp-timeout` and then
`session.ended`, and the engine tears the leg down on `leg-ended`. So the common case — a far end
that vanished without a BYE — is already reaped by the media plane. They become mandatory at slice 4,
because a carrier that offers `Supported: timer` and never sees a refresh will tear the call down
itself, and a one-sided timer is worse than none.

### 4.6 Who retries, who times out

One rule, and it is the rule that keeps three layers from retrying the same thing:

> **Each layer retries exactly what it can make idempotent, and nothing else.**

- **SIP** retransmits requests. `sipgo`'s transaction layer owns T1/T2 and Timers A–K, and its
  2xx-until-ACK loop (`dialog_server.go:322-345`) implements RFC 6026. Idempotent by CSeq.
- **NATS commands** are idempotent on `legId`, the same property `allocate-session` has on
  `sessionId`. A timed-out `answer` may be reissued; the second one is answered `invalid_state`
  rather than answering the call twice.
- **Nothing retries a routing walk.** A walk is a side-effecting traversal that dials real phones.
  The engine's own timeouts (`ENGINE_DEFAULT_RING_TIMEOUT_SECONDS`, `answerTimeoutMs`) bound it, and
  a walk that failed has already hung its call up.

The one place this has teeth: **`answer` must reply when the `200 OK` has been written to the socket,
not when the ACK arrives.** `sipgo`'s `DialogServerSession.WriteResponse` blocks the calling
goroutine until the ACK or 64×T1 ≈ 32 s (`dialog_server.go:314-348`), retransmitting the 2xx. A 2 s
RPC wrapped around a 32 s block times out on every call whose ACK is even slightly late. So the
command handler hands the response to the dialog goroutine and answers immediately, and the ACK is
reported later as `dialog.answered`. This mirrors `rpc.media.v1.send-dtmf`, which "answers when
injection has STARTED" (`plans/mediad-design.md` §4.2), and it is the single most important
consequence of `sipgo`'s shape for this design.

---

## 5. B-legs: `originate` becomes a UAC INVITE

### 5.1 The endpoint string is the one place ARI leaks through `MediaPort`

`OriginateRequest.endpoint` is documented as "Technology + resource in the media server's
vocabulary (`PJSIP/1001`, `Local/1001@ctx`)" (`media-port.ts:56`). It is produced by template
substitution: `ENGINE_EXTENSION_DIAL_TEMPLATE` (default `PJSIP/{number}`) and
`ENGINE_TRUNK_DIAL_TEMPLATE` (default `PJSIP/{number}@{trunk}`),
`apps/engine/src/config/engine-env.ts:178,181`, substituted at `plan-walker.ts:1500-1502`,
`:1294-1296` and `:1608-1610`. `{trunk}` is the trunk's **`name`** column.

Two options for making that dialable by `sipd`.

- **A — new templates.** `sip:{number}@{realm}` and `sip:{number}@{trunk}`. One settings change,
  zero interface change.
- **B — a structured target, added additively to `OriginateRequest`.**

**Decision: B.** `endpoint` stays exactly as it is (the ARI adapter needs it), and a new optional
`target?: DialTarget` is added, populated by the plan walker at the same three sites. The `sipd`
composite reads `target` and refuses `bad_request` when it is absent; `AriMediaAdapter` ignores it.

Option A loses because a template hides everything that makes a trunk dialable. The `trunk` row holds
`sipProxy` ("Where INVITEs go"), `outboundProxy` (for a carrier fronted by an SBC), `authUser`,
`sipSecretRef`, `transport` and `registerExpiresSeconds`
(`packages/pbx-db/src/schema/trunks-schema.ts:37-46`) — none of which is expressible as `{number}` and
`{trunk}` substitution. A template that carried only the trunk's **name** would force `sipd` to
re-resolve the trunk against a database it holds no handle on. The walker already **has** the trunk
row when it builds the attempt (`plan-walker.ts:1285-1296` reads `trunk.name` off it), so passing the
id costs nothing and removes the undocumented coupling between a database column and a hand-written
Asterisk section that §1 flagged.

```ts
type DialTarget =
	| { kind: "aor"; aor: string } // sip:1001@realm — sipd reads `registrations`
	| { kind: "trunk"; trunkId: string; number: string } // sipd reads the trunk directory
	| { kind: "uri"; uri: string }; // a REFER target in another domain
```

**Where the AOR lookup happens is itself a decision.** Today `PJSIP/1001` makes Asterisk consult its
own registrar. Under `sipd` the lookup moves into the process that **owns** the location service and
already writes it (`registrar.go:410` puts the binding; `kv.Store` reads it). That deletes a
duplicate registrar rather than adding a hop.

### 5.2 Codecs: `mediad` writes the offer, and that is the bound

This is the one place the design requires a change **inside `mediad`**, and it must be stated plainly
because `plans/mediad-design.md` closed the door on it deliberately.

`mediaAllocateSessionRequestSchema` **requires** `sdpOffer`, and `rpc.ts` explains why:

> v1 ANSWERS offers. Generating an offer for a leg the engine is originating (where no offer exists
> yet) is a different negotiation and arrives with the rung that needs it.

**This is that rung.** A B-leg has no offer, because we are the one calling.

Three options:

- **A — two new `mediad` commands.** `rpc.media.v1.create-offer` allocates the port pair and emits an
  offer; `rpc.media.v1.accept-answer` feeds the callee's answer back and settles the codec.
- **B — `sipd` synthesises the offer** from a port `mediad` allocated. Rejected outright: it makes
  `sipd` pick codecs, which `plans/mediad-design.md` §5 forbids in one sentence ("it never picks a
  codec"), and it creates a second opinion about `mediad`'s own capabilities held by a process that
  cannot check it.
- **C — late offer.** Send the INVITE with no body and let the callee offer in its `200`, answering in
  the ACK (RFC 3261 §13.2.1 permits it). `mediad` then only ever answers and needs no new command.

**Decision: A.** C is genuinely the smaller change and it is tempting, and it loses on interop: a
body-less INVITE is refused or mishandled by a meaningful share of carriers and handsets, and the
failure mode is "the phone rang and there was no audio" — invisible at the moment it happens, which
is the property `plans/mediad-design.md` §3.1 identifies as the worst defect class in telephony.

And option A **is** the codec bound, cleanly:

- `mediad` offers exactly what `mediad` can serve — PCMU, PCMA and RFC 4733 telephone-event
  (`mediaCodecSchema`, `packages/events/src/schemas/rpc.ts:610`; the passthrough argument at
  `plans/mediad-design.md` §7).
- A callee that answers with G.729 is refused at `accept-answer` with `not_supported`, and the engine
  hangs that B-leg up with a cause the plan walker already handles — `originate` failure becomes
  `USER_NOT_REGISTERED` today (`plan-walker.ts:3260-3268`), and a codec refusal deserves a better one
  (`INCOMPATIBLE_DESTINATION`, Q.850 88).
- **`sipd` holds no codec knowledge in either direction.** Inbound it forwards an offer it does not
  parse; outbound it forwards an offer it did not write. The rule from §5 of the `mediad` design is
  preserved exactly, in the direction that design had not needed yet.
- `trunk.codecPrefs` (`trunks-schema.ts:48`, free-text CSV like `PCMU,PCMA,OPUS`) is therefore
  **advisory until `mediad` rung 7**. A trunk configured for Opus gets a G.711 offer and the row is
  wrong rather than the call. Slice 4 should refuse to provision a trunk whose `codecPrefs` names
  nothing `mediad` can serve, rather than silently narrowing it.

### 5.3 Forking stays in the engine

`registrations` holds **one binding per AOR** (`registrar.go:170-175`), and the README names
multi-contact as "the first thing the proxy wave requires" (`apps/sipd/README.md:75`).

But the engine already forks, and it forks better than a SIP UAC could. `dialSimultaneous`
(`plan-walker.ts:2763-2865`) mints one client-assigned channel id per attempt, installs a watcher on
each **before** any originate is issued, and settles on the first answer; the loser gets
`LOSE_RACE` (Q.850 26, `ari-mapping.ts:100-120`), each attempt gets its own `ChannelAggregate` and
therefore its own CDR row, and the confirmation flow (`confirmRacingLeg`, `plan-walker.ts:2988`)
hangs off the same machinery.

**Decision: `sipd` does not implement SIP forking. It grows multiple contacts per AOR and reports
them; the engine originates one dialog per contact.** A `sipd` that forked would have to reproduce
the race, the per-attempt accounting and the confirmation flow in a process that has no CDR and no
plan. Slice 6 changes the KV value shape and the `originate` reply (a `{kind:"aor"}` target answers
with the set of contacts, or the engine asks for a specific one), and nothing else moves.

---

## 6. State distribution, and what dies with an instance

### 6.1 Dialogs live in memory. There is no other option.

`sipgo` keeps dialogs in a `sync.Map` (`dialog_server.go:438-441`, `dialog_client.go:611-620`), and
that is not a limitation to design around — it is the truth about SIP. A dialog's transaction state,
its retransmission timers and its socket are all local, and its `Contact` header tells the far end
which host to send mid-dialog requests to (RFC 3261 §12.1.1). A second process cannot receive the
BYE and cannot retransmit the 2xx.

So the question is not "where does the dialog live". It is **"what can a second instance truthfully
say about it"**, and the answer is a directory.

### 6.2 `sip-dialogs`: a claim, not a directory

The precedents are all present, and one of them is a placeholder waiting for exactly this.
`SIP_TRANSFER_REFUSAL_REASONS.wrong_instance` (`packages/events/src/schemas/rpc.ts:371-380`) is
**reserved and never raised**, with the note:

> distinguishing that from `unknown_dialog` needs a dialog directory in KV, the same shape as
> `park-claims` and `media-sessions`. Named now so the retry semantics — do not retry here, ask the
> owner — exist in the vocabulary before the directory does.

**Decision: a `sip-dialogs` KV bucket, keyed by `legId` alone, not organization-scoped, written only
by `sipd`, and carrying an `expiresAt` that its owner heartbeats.**

Three properties, each argued:

1. **Not org-scoped.** The third exception after `did-index` and `media-sessions`, and for the
   identical reason `streams.ts:541-546` and `plans/mediad-design.md` §6.3 give: the reader does not
   know the tenant. An engine holding a `legId` from a `leg-ended` it is reconciling, or a second
   `sipd` reaping a dead peer, has no org to prefix with. The org travels in the value.

2. **A CLAIM, not a directory — and this is where it diverges from `media-sessions`.**
   `plans/mediad-design.md` §6.3 argues that the media directory needs no `expiresAt` because
   "nothing races for a media session". Something does race here: **a dead owner's dialogs must be
   reaped by somebody**, or the engine holds channels for calls that ended when a pod was
   rescheduled, and no CDR is ever written for them. So the record carries a lease and a heartbeat,
   exactly as `PARK_CLAIMS_KV` does (`streams.ts:640-647`), and a surviving instance that finds an
   expired claim publishes `dialog.terminated{reason: "instance-lost", q850Cause: 41}` on the owner's
   behalf. The engine writes a CDR from a `leg-ended` it would otherwise never have received.

3. **One writer.** `sipd` writes it; the engine reads it. The temptation is to let the engine write
   its own instance id into the same record so the REFER path can find the owning **engine** — and
   that temptation should be refused, because two writers on one key is a compare-and-set protocol
   nobody needs. §6.3 shows the engine's half comes for free anyway.

Shape, mirroring `mediaSessionDirectoryEntrySchema`
(`packages/events/src/schemas/live-state.ts:231-256`):

```jsonc
{
	"legId": "018f…",
	"instanceId": "sipd-7c9f",
	"orgId": "018f…",
	"callId": "018f…",
	"role": "uas", // uas = we answered; uac = we called
	"sipCallId": "a84b4c76e66710@pc33",
	"localTag": "…",
	"remoteTag": "…",
	"state": "early", // early | confirmed | terminating
	"remoteAddress": "203.0.113.7:5060",
	"transport": "udp",
	"trunkId": "018f…", // absent for a registered endpoint
	"createdAt": 1754899200000,
	"expiresAt": 1754899290000,
}
```

### 6.3 The engine's `wrong_instance` gap closes as a side effect

`rpc.sip.v1.transfer` is served on a **flat** subject with a queue group
(`apps/engine/src/nats/sip-transfer.service.ts:34`, and the argument at `:20-33`): `sipd` has no idea
which engine holds a call, so exactly one engine answers and it may be the wrong one.

Under this design the REFER handler changes one line. Today it sends the phone's `Call-ID` verbatim
(`transfer/handler.go:380-382`). Tomorrow it looks that `Call-ID` up in **its own** `sip-dialogs`
bucket — it owns the dialog, so it has the record — and sends `{orgId, callId, legId}` alongside.

That is enough for the engine to answer `wrong_instance` truthfully for the first time, because
`kvKeyFor.channel(orgId, callId, channelId)` is a **direct KV get** against the `channels` bucket
(`streams.ts:489-498`, and `JetStreamService.readChannel` at
`apps/engine/src/nats/jetstream.service.ts:294`). An instance that finds a live `channels` entry it
does not itself hold knows the difference between "this call ended" and "ask my neighbour" —
which the reason's own note says is the whole point.

It also retires `correlation_unavailable` on this plane. That reason exists because "the ARI driver
does not populate `sipCallId` today" (`rpc.ts:355-360`); the engine has since closed it for ARI via a
channel-variable read (`channel-identity.ts:83-93`), and on the `sipd` plane the `Call-ID` is present
on the admission reply and needs no read at all.

### 6.4 What dies with a `sipd` instance: every dialog on it

Stated plainly, because the alternative is discovering it during an incident:

- **Registrations survive.** They already do — `Registrar.Rehydrate` (`registrar.go:639-657`) adopts
  the bucket's bindings at boot, and the sweeper argument at `:544-562` explains why the instance
  that granted a binding owns its deadline.
- **Dialogs do not.** A crashed `sipd` is N dropped calls. There is no re-INVITE that can be sent
  from a process that does not hold the dialog's CSeq, and the far end's BYE is addressed to a
  `Contact` that is gone.
- **The directory's job is therefore reaping, not failover** (§6.2).

**The deployment constraint this implies must be written down.** N `sipd` instances behind a plain
load balancer are safe for REGISTER and OPTIONS, which are stateless. They are **not** safe once
dialogs exist: a mid-dialog request that lands on the wrong instance is answered
`481 Call/Transaction Does Not Exist` (`sipgo`'s `ErrDialogDoesNotExists`, `dialog.go:14`). So the
front end must be **dialog-affine** — a per-instance advertised address in `Contact` (which is what
`contactURI` in `cmd/sipd/main.go:303-316` already computes, and already documents the wildcard
problem for), plus a balancer that does not move an established flow. That is the same property SIP
outbound (RFC 5626) exists to formalise, and slice 7 is where it becomes real.

---

## 7. Migration and coexistence

### 7.1 The switch is not in the engine

`ENGINE_MEDIA_DRIVER` is a deployment-wide enum, and that granularity is wrong for signalling.
A tenant with two hundred desk phones cannot move all of them in one restart.

But the more important observation is that **the engine does not choose the path at all.** A call
takes the `sipd` path because a phone pointed its REGISTER at `sipd`'s address, or because a carrier
pointed its INVITE there. Those are provisioning facts, not engine configuration:

- **An extension moves** when the config the provisioning renderer hands it names `sipd`'s address.
  That is already per-device (`apps/api/src/provisioning/render/`).
- **A DID moves** when the carrier's inbound routing points at `sipd`. That is per-DID or per-trunk
  at Telnyx, via the credential connection the carrier service already provisions
  (`apps/api/src/pbx/carrier/carrier.service.ts:589-598`).

Above the seam, the engine cannot tell the difference and must not try: `toMediaEvent` and
`toMediaEventFromSipd` produce the same union, so `leg-arrived` from either plane is one code path.

### 7.2 What the engine does have to decide: which plane a B-leg goes out on

When the engine originates for a call that arrived on `sipd`, it must originate through `sipd`. An
ARI channel and a `mediad` session cannot be in one bridge — there is no object either media server
could name.

**Decision: the plane is a property of the A-leg, recorded on the aggregate, and the composite port
is resolved per call rather than per process.**

This produces the hard constraint that bounds the whole migration, and it is better said now than
found later:

> **Every feature that joins two existing calls works only within a plane.** Pickup, attended
> transfer, park retrieval, conference and queue delivery all bridge two legs, and a cross-plane
> bridge is impossible.

An attempted cross-plane join is **refused by name**, not attempted: a new
`MediaOperationNotSupportedError` naming the operation and both planes, so the failure is a logged
refusal rather than a call that connects to silence.

### 7.3 Which makes the real granularity per-tenant

If cross-plane features do not work, a tenant with half its extensions on each plane has a PBX where
transfers randomly fail. So a tenant migrates as a **unit** — all extensions and all DIDs — or it
loses those features for the duration of the migration.

**Decision: the flag is a per-organization setting, not an environment variable.** The precedent is
exact: the realm→organization mapping is already an `org_setting` row with
`category='sip'`, `name='realm'` (`apps/sipd/README.md:216`). Add `category='sip'`,
`name='signalling_plane'`, value `"asterisk"` (default) or `"sipd"`. Two readers:

- **the provisioning renderer**, to decide which address a phone's config names;
- **the engine**, to pick the composite for a call it originates on that tenant's behalf — which is
  belt and braces, since the A-leg's plane already decides it.

`ENGINE_SIGNALLING_DRIVER` (§3.5) remains, as the fleet-wide kill switch: `asterisk` forces every
tenant back regardless of its row, which is what an operator wants at 3 a.m.

### 7.4 The smallest slice that carries a real call

Two registered phones, one tenant, no PSTN, no transfer, no queue, no park:

1. Both phones REGISTER against `sipd`. **Works today** (`registrar.go`).
2. `1001` INVITEs `1002`. `sipd` digest-authenticates with the same `Authenticator` the REFER path
   reuses, mints a `legId`, writes the `sip-dialogs` claim, sends `100 Trying`, and issues
   `rpc.sip.v1.invite`.
3. The engine admits, publishes `channel.created` with a real `sipCallId`, and runs its routing walk.
   `resolveInternal` finds extension `1002`; the plan walker builds one attempt.
4. `rpc.sip.v1.ring` → `180`. `rpc.media.v1.create-offer` for the B-leg →
   `rpc.sip.v1.originate` with `{kind:"aor", aor:"sip:1002@realm"}` → `sipd` reads `registrations`
   and INVITEs the contact.
5. `1002` answers → `dialog.answered` → `rpc.media.v1.accept-answer` settles the B-leg codec →
   `rpc.media.v1.allocate-session` answers the A-leg's original offer → `rpc.sip.v1.answer` → `200 OK`
   → ACK.
6. `rpc.media.v1.bridge-sessions`. Audio, both directions.
7. Either side BYEs → `dialog.terminated` → `leg-ended` → `channel.hangup`, `channel.destroyed`,
   `cdr.leg.write` in that order (`channel-orchestrator.service.ts:1612-1618`).

**Gate:** two real softphones talking; a CDR row whose `billsec` starts at the ACK and not at the
bridge; `apps/engine/test/engine-integration.spec.ts` green with the plane swapped and **no new
assertions** — the property that makes it the parity gate (`plans/mediad-design.md` §8.2).

### 7.5 What this unblocks elsewhere

Worth listing, because three open questions in the peer document are waiting on this one:

- **`plans/mediad-design.md` §10 q12 — graceful drain.** Needs `rpc.sip.v1.reinvite` (slice 5).
- **§10 q15 — rung 1's gate is half met.** "A call answered by mediad hears a prompt" needs a phone;
  slice 1 supplies one.
- **§10 q16 — MOS against an Asterisk baseline.** Needs a real call on both planes on the same
  hardware; slice 1 supplies the `sipd` half and Asterisk's dev endpoints supply the other.
- **`didIndexToken`'s doc comment in `packages/events/src/subjects.ts`** assigns per-trunk E.164 normalisation to "the SIP
  edge", and the SIP edge has had nowhere to put it. Slice 3.

---

## 8. Security, and the boundary that has to hold before slice 3

Slice 3 is the first time an unauthenticated stranger can send this platform a packet that costs it
work. Three things must be true before it ships.

**8.1 The trunk ACL is matched in process, not in KV.** `sip_acl_entry`
(`packages/pbx-db/src/schema/security-schema.ts:32-61`) already has the right shape: a native
PostgreSQL `cidr` network, an `action` (`allow`/`deny`), a `priority`, and — crucially — a `scope`
enum whose values are `registration | trunk | provisioning | api`, described at `:28` as "the
anti-toll-fraud boundary".

It is organization-scoped, and the reader does not know the organization. Same problem as
`did-index`, same answer: **a derived, non-org-scoped read model**, a `sip-acl` KV bucket written by
`apps/api` from the table and rebuildable from it, exactly as `did-index.publisher.ts` writes its
bucket after commit (`apps/api/src/pbx/routing/did-index.publisher.ts:41-59`) with
`scripts/rebuild-did-index.ts` as the repair path.

And `sipd` **watches** it rather than reading it per INVITE, compiling the entries into an in-process
longest-prefix match. A KV get per INVITE is a broker round trip inside a transaction, on the one code
path an attacker controls the rate of.

**8.2 The `trunk` table has nowhere to store the CIDRs.** `trunks-schema.ts` has `kind: "ip-auth"`
(`:23`, described at `:14-16` as "the carrier authenticates our source IP") and **no field for which
source addresses we accept**. `pjsip_telnyx_example.conf:118-125` hard-codes
`match = 192.76.120.0/24` and `match = 64.16.250.0/24` in a file that is never loaded. So slice 3
needs either a `trunk_acl` child table or a `trunkId` column on `sip_acl_entry`; the latter is
smaller and keeps one ACL evaluator.

**8.3 The `routingContext` boundary is the thing all of this protects.**
`routingResolveRequestSchema.routingContext` is documented as "the toll-fraud boundary… unauthenticated
traffic never resolves in a trunk-capable context" (`packages/events/src/schemas/rpc.ts:81-86`), and
Asterisk's dialplan enforces it today by having two contexts —`[optimiq-inbound-untrusted]` for
carriers (`extensions.conf:113-125`) and `[optimiq-internal]` for registered devices
(`pjsip_dev_endpoints.conf:33-36`), with the open-relay warning spelled out at
`pjsip_telnyx_example.conf:61-67`.

On this plane `sipd` sets it: a digest-authenticated INVITE admits with the tenant's internal
context, and a trunk-matched INVITE admits with the untrusted one. **The engine must refuse an
admission request whose `routingContext` is trunk-capable and whose authentication was a trunk
match** — the same check, on the side that can enforce it, exactly as `rpc.sip.v1.transfer` puts the
"is the referrer on this call" check in the engine because the edge cannot answer it
(`transfer/handler.go:86-90`).

---

## 9. What `sipgo` gives you, and what it does not

Version pinned at `github.com/emiago/sipgo v1.4.3` (`apps/sipd/go.mod:6`). Every path below is inside
that module.

### 9.1 What is there, and is genuinely good

- **A full transaction layer.** `sip/transaction_layer.go`, `sip/transaction_client_tx_fsm.go`,
  `sip/transaction_server_tx_fsm.go` — T1/T2, Timers A–K, retransmission.
- **CANCEL handled correctly at the transaction layer.** `200` to the CANCEL first so the UAC stops
  retransmitting, then the INVITE FSM sends `487` (`sip/transaction_layer.go:154-185`, with the RFC
  citation in the comment).
- **A dialog layer, both roles.** `DialogUA.ReadInvite` (`dialog_ua.go:24`), `DialogUA.Invite`
  (`:93`), `DialogServerSession` with `ReadAck`/`ReadBye`/`Respond`/`RespondSDP`/`Bye`
  (`dialog_server.go:27,36,201,214,357`), `DialogClientSession` with
  `Invite`/`WaitAnswer`/`Ack`/`Bye` (`dialog_client.go:183,237,404,439`), and caches keyed by dialog
  id (`dialog_server.go:438`, `dialog_client.go:611`).
- **RFC 6026 2xx retransmission until ACK**, with the correct T1→T2 backoff and the 64×T1 give-up
  (`dialog_server.go:322-348`).
- **UAC digest retry built into `WaitAnswer`**, for both `401` and `407`
  (`dialog_client.go:278-330`). **This is the trunk-authentication path, and we get it for free** —
  slice 4's outbound INVITE to a carrier that challenges is already handled.
- **`Record-Route` copying** on both roles (`dialog_server.go:144-160, 202`).
- **UDP, TCP, TLS, WS and WSS transports** (`sip/transport_*.go`).
- **Method handler registration for everything we need**: `OnInvite`, `OnAck`, `OnCancel`, `OnBye`,
  `OnInfo`, `OnUpdate`, `OnPrack` (`server.go:286-347`).

### 9.2 Re-INVITE — the largest gap, and the one slice 5 is

`DialogServerSession.inviteTx` is the **original** INVITE transaction (`dialog_server.go:16`), and
nothing swaps it. There is no `ReadReInvite`, no offer/answer version tracking, and
`WriteResponse` assumes it is answering the initial INVITE (it computes the dialog id from the
response and compares it to the dialog's own, `:305-311`).

Half the plumbing exists: `DialogServerCache.MatchDialogRequest` (`:453-464`) will find the dialog
for a mid-dialog INVITE. Everything after that — accepting a new offer, answering it, tracking which
side owns the current offer, and re-pointing `mediad` — is ours. **Effort: large.** Hold, codec
change, `mediad`'s drain MOVE, and the attended-transfer completion path all sit behind it.

### 9.3 Early dialogs

`sip.DialogState` has three values: `Established` (a 2xx was seen), `Confirmed` (an ACK was seen),
`Ended` (a BYE was seen) — `sip/dialog.go:5-12`. There is **no Early state**. A UAC that receives an
`18x` with a `To` tag has an early dialog per RFC 3261 §12 that `sipgo` does not model, so PRACK,
early-dialog UPDATE and per-branch response handling have nowhere to live.

We need one more state and, if slice 7 ever wants forking-aware behaviour, a per-remote-tag sub-dialog
map. **Effort: medium.** Slice 2 needs the state; the sub-dialog map can wait.

### 9.4 Glare / `491`

Nothing. **Effort: small** (§4.5). Slice 5.

### 9.5 Session timers (RFC 4028)

Nothing — `Session-Expires` appears only in `sip/parser_stream_test.go` fixtures. **Effort: medium**
(a `Session-Expires`/`Min-SE` negotiation, a refresher role, a re-INVITE or UPDATE on a timer, and a
`422` path). Slice 4.

### 9.6 100rel / PRACK

`Server.OnPrack` is a registration hook (`server.go:341-344`) with no RSeq/RAck state behind it.
**Effort: medium, and deferrable** — few endpoints require `100rel`, and a carrier that does can
usually be configured not to. Not on the ladder; it arrives when a specific carrier forces it.

### 9.7 Forking on the UAC side

`WaitAnswer` breaks on the first 2xx (`dialog_client.go:271-273`) and gives up after ten responses
(`:243-246`). A second 2xx from a **carrier's** forking proxy is not handled, and RFC 3261 requires
ACK-then-BYE on the loser; answering with silence leaks a dialog at the far end and, on some
carriers, bills for it. We do not need to fork (§5.3), but we do need to survive being forked at.
**Effort: small.** Slice 4.

### 9.8 UAS digest for INVITE

`DialogServerSession.authDigest` exists (`dialog_server.go:224`) but writes its own `401` and knows
nothing about our stateless HMAC nonce. We reuse **our** authenticator, exactly as
`internal/transfer` already does — "the SAME authenticator the registrar uses, deliberately: a second
one with its own secret would mint nonces the registrar rejects" (`transfer/handler.go:35-38`).
**Effort: none.** It is a copy of a pattern that already exists twice.

### 9.9 NAT on mid-dialog requests

Responses get `rport`/`received` handling in the transport layer. Mid-dialog **requests** — the BYE we
send to a phone behind NAT — go to the `Contact` the phone put in its INVITE, which is routinely a
private address. The binding already records the observed `SourceAddress` (`registrar.go:395`), and
`transfer/handler.go:547-558` already prefers the observed source as the destination while keeping the
`Contact` as the address. That pattern generalises directly. **Effort: small.** Slice 7.

### 9.10 There is no proxy mode, and we do not want one

`sipgo`'s README shows a stateless proxy example. We are not building it. A proxy cannot put `mediad`
in the media path, cannot hand the engine an offer, and cannot answer with an SDP it did not write.
**`sipd` is a back-to-back user agent: two dialogs per call, always.** That is also what makes §5.2's
codec bound expressible at all.

### 9.11 Cross-check against how REFER characterised `sipgo`

Consistent. The transfer handler's own doc comment (`transfer/handler.go:92-100`) says RFC 3515's
subscription state machine is not implemented, `Refer-Sub` is not negotiated, and notifications are
"fire-and-forget rather than retried past the transaction layer's own timers"; the README repeats it
at `:72`. Nothing in that work claimed `sipgo` supplied application-level SIP semantics, and nothing
above contradicts it: **`sipgo` gives transactions and dialogs, and gives no SIP application
semantics at all.**

---

## 10. The wire protocol

### 10.1 Transport rules, unchanged and now inverted twice

**Commands: NATS core request-reply. Events: JetStream.** "Ask over core, tell over JetStream"
(`plans/mediad-design.md` §4.1).

**Every cross-language `rpc.*` subject is served raw**, never a NestJS `@MessagePattern`. This design
adds subjects in **both** directions and both are already precedented:

- `rpc.sip.v1.invite` — **Go caller, TypeScript responder**. Same as `rpc.sip.v1.transfer`, served raw
  by `apps/engine/src/nats/sip-transfer.service.ts:161`, and requested raw by
  `apps/sipd/internal/transfer/client.go:27-46`.
- `rpc.sip.v1.answer|ring|hangup|originate|reinvite` — **TypeScript caller, Go responder**. Same as
  `rpc.media.v1.*`; the engine must use `NatsConnection.request()` and not `ClientProxy.send()`, and
  the reason is written out at length on `mediaAllocateSessionRequestSchema`. The existing
  `MediadTransport` (`apps/engine/src/media/mediad-transport.ts:34-46`) is the shape to reuse.

### 10.2 Subjects

**Engine → `sipd` commands are addressed at ONE instance**, because a dialog lives on one process
(§6.1). The subject therefore carries the instance token, exactly as `rpc.engine.v1.park-handoff`
does and for the argument written on `RPC_SUBJECTS.engineParkHandoff` in `packages/events/src/subjects.ts`: a queue group
delivers to one member chosen by the server, "and seven times out of eight that member is not the one
holding the call". The token comes from `instanceSubjectToken` (`subjects.ts`), and the
engine reads which one from the `sip-dialogs` record.

| Subject                                  | Direction       | Kind               | Deadline |
| ---------------------------------------- | --------------- | ------------------ | -------- |
| `rpc.sip.v1.invite`                      | sipd → engine   | core, queue group  | 1000 ms  |
| `rpc.sip.v1.ring.<sipdInstanceTok>`      | engine → sipd   | core, per-instance | 500 ms   |
| `rpc.sip.v1.answer.<sipdInstanceTok>`    | engine → sipd   | core, per-instance | 1000 ms  |
| `rpc.sip.v1.hangup.<sipdInstanceTok>`    | engine → sipd   | core, per-instance | 500 ms   |
| `rpc.sip.v1.originate.<sipdInstanceTok>` | engine → sipd   | core, per-instance | 1000 ms  |
| `rpc.sip.v1.reinvite.<sipdInstanceTok>`  | engine → sipd   | core, per-instance | 1000 ms  |
| `rpc.media.v1.create-offer`              | engine → mediad | core, queue group  | 500 ms   |
| `rpc.media.v1.accept-answer`             | engine → mediad | core, queue group  | 500 ms   |

Three notes on the deadlines. `answer` is 1000 ms and **not** the 32 s its SIP transaction can take,
for the reason in §4.6: it replies when the 2xx is on the socket. `originate` is 1000 ms and replies
when the INVITE has been sent, not when it is answered — the answer arrives as `dialog.answered`, the
same split `MediaPort.originate` already has (it returns an `OriginatedChannel`, not an answered
call). `invite` is 1000 ms rather than `credential`'s 500 ms because `100 Trying` is already out and
nothing is retransmitting behind it; it is still bounded, because a person is holding a handset.

`originate` has no instance token: **any** `sipd` may place an outbound call, so it is queue-grouped,
and the reply carries the `instanceId` that took it — which the engine then uses for every subsequent
command on that leg. That is the same pattern `allocate-session` uses
(`mediaAllocateSessionResponseSchema.instanceId`).

**Events:**

| Subject                                        | Kind              | Stream |
| ---------------------------------------------- | ----------------- | ------ |
| `sip.evt.v1.<orgId>.<legId>.dialog.progressed` | JetStream publish | `SIP`  |
| `sip.evt.v1.<orgId>.<legId>.dialog.answered`   | JetStream publish | `SIP`  |
| `sip.evt.v1.<orgId>.<legId>.dialog.held`       | JetStream publish | `SIP`  |
| `sip.evt.v1.<orgId>.<legId>.dialog.resumed`    | JetStream publish | `SIP`  |
| `sip.evt.v1.<orgId>.<legId>.dialog.terminated` | JetStream publish | `SIP`  |
| `sip.evt.v1.<orgId>.<legId>.dialog.dtmf`       | JetStream publish | `SIP`  |

New root `sip.evt` alongside the existing `sip.reg` (`SUBJECT_ROOTS`, `subjects.ts`), a new `SIP_DIALOG_EVENTS`
array alongside `REGISTRATION_EVENTS`, a `subjectFor.sipDialog(orgId, legId, event)` and the matching
filters. Published with the envelope id as `Nats-Msg-Id`, as `apps/sipd/internal/events` already
does, so a retried publish is collapsed by the stream's duplicate window.

A **new `SIP` stream**, not an extension of `REGISTRATIONS`. Registration transitions and dialog
lifecycle have different volumes by two orders of magnitude and different retention needs (a
`dialog.terminated` is CDR evidence; a `registered` is presence), and `streams.ts` already models one
stream per family.

**The engine reads them with a CORE subscription** on `sip.evt.v1.>`, for the identical reason it
reads `media.evt.v1.>` that way (`plans/mediad-design.md` §4.2): it wants a leg torn down **now** and
must not pay for a durable consumer's ack round trip on the call path.

**One taxonomy consequence to record.** `parseSubject` returns an `rpc` result only when exactly one
token follows the version (`parseSubject`'s final branch, `subjects.ts`), so an instance-suffixed RPC subject does not parse.
`rpc.engine.v1.park-handoff.<tok>` already has this property and nothing broke, because nothing on
the call path parses RPC subjects. Stated so the next person does not "fix" it.

### 10.3 Payloads

`rpc.sip.v1.invite` — request / reply:

```jsonc
{ "legId": "018f…", "sipdInstanceId": "sipd-7c9f",
  "orgId": "018f…",                        // present ONLY when digest resolved a credential
  "authentication": "digest",              // digest | trunk-acl
  "from": { "number": "1001", "name": "Ada Lovelace", "aor": "sip:1001@acme.example.com" },
  "to":   { "number": "1002", "uri": "sip:1002@acme.example.com" },
  "sipCallId": "a84b4c76e66710@pc33", "fromTag": "…",
  "trunkId": "018f…",                       // present ONLY when authentication is trunk-acl
  "sourceAddress": "203.0.113.7:5060", "transport": "udp",
  "hasOffer": true }

{ "ok": true, "legId": "018f…", "orgId": "018f…", "callId": "018f…",
  "instanceId": "engine-2",
  "routingContext": "internal",
  "direction": "inbound" }
```

Four things are deliberately **not** on the request:

- **The SDP offer.** It stays in `sipd` until the engine asks for it — which it does by calling
  `rpc.media.v1.allocate-session`… and there is the problem: the engine is the courier
  (`plans/mediad-design.md` §5), so it needs the bytes. **Decision: `sdpOffer` IS on the admission
  request.** The 16 KiB `sdpSchema` bound (`rpc.ts:625`) applies, it costs one copy on a request that
  is happening anyway, and the alternative — a second round trip to fetch it — puts a broker RTT in
  the middle of an INVITE for no gain. Corrected in §11.7 rather than hidden: this is the one field
  whose placement was argued both ways and it should be re-examined once post-dial delay is measured.
- **Anything derived from the message that `sipd` also authenticated.** `from.aor` is rebuilt from the
  **credential**, never copied from the `From` header — the rule `transfer/handler.go:370-374` states
  ("Mixing those two up is how an authorisation check becomes decorative").
- **A tenant guess for a trunk call.** `sipd` does not read `did-index`; the engine does.
- **Codecs.** §5.2.

`rpc.sip.v1.answer`:

```jsonc
{ "legId": "018f…", "sdpAnswer": "v=0\r\n…" }
{ "ok": true, "legId": "018f…", "instanceId": "sipd-7c9f", "sentAt": "2026-…" }
```

`rpc.sip.v1.originate`:

```jsonc
{ "legId": "018f…", "orgId": "018f…", "callId": "018f…",
  "target": { "kind": "trunk", "trunkId": "018f…", "number": "+441632960111" },
  "callerId": { "number": "+441632960100", "name": "Acme Ltd" },
  "sdpOffer": "v=0\r\n…",                  // written by mediad's create-offer
  "ringTimeoutMs": 30000,
  "headers": { "X-Optimiq-Call-Id": "018f…" } }
{ "ok": true, "legId": "018f…", "instanceId": "sipd-7c9f" }
```

`rpc.sip.v1.hangup` takes `{legId, cause}` where `cause` is a Q.850 integer, and **`sipd` chooses the
method** from the dialog state it owns: a BYE if confirmed, a CANCEL if we are a UAC in an early
dialog, a `4xx`/`5xx`/`6xx` final if we are a UAS that has not answered. The engine says "end this leg
with this cause" and nothing more, which is exactly what `MediaPort.hangup(channelId, cause)` already
says.

### 10.4 Refusal vocabularies

Two lists, because they refuse different things, and the second one is unlike anything else on this
backbone.

**`SIP_DIALOG_REFUSAL_REASONS`** — a command against an existing dialog, modelled on
`MEDIA_REFUSAL_REASONS` (`rpc.ts:576-604`):

`bad_request`, `unknown_dialog`, `wrong_instance`, `dialog_gone` (raced with a CANCEL or BYE — §4.4),
`invalid_state` (an `answer` on an already-answered dialog), `unregistered_target` (originate to an
AOR with no live binding), `unknown_trunk`, `no_route` (DNS or transport failure reaching the target),
`capacity` (`trunk.maxChannels`), `shutting_down`, `not_supported`, `internal`.

**`SIP_INVITE_REFUSAL_REASONS`** — the engine refusing admission. **These are different because each
one must become a SIP status a stranger sees**, and choosing that mapping in the engine rather than in
`sipd` would put SIP vocabulary in the engine; choosing it in `sipd` from a free-text string would put
guesswork on the edge. So the list is small, the mapping is a table in `sipd`, and every entry is
justified by what a caller should do next:

| Reason           | SIP                         | Why                                                                                       |
| ---------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| `unattributed`   | `404 Not Found`             | No credential org and no `did-index` entry. Today's `INVALID_PROFILE` hangup, on the wire |
| `unknown_target` | `404 Not Found`             | The dialled number resolves to nothing in this tenant's plan                              |
| `not_permitted`  | `403 Forbidden`             | Authenticated, but not for this context — §8.3                                            |
| `congestion`     | `503 Service Unavailable`   | Tenant or trunk channel cap                                                               |
| `shutting_down`  | `503` + `Retry-After`       | Drain. The `Retry-After` is what makes a carrier fail over instead of retrying here       |
| `bad_request`    | `400 Bad Request`           | Malformed payload                                                                         |
| `internal`       | `500 Server Internal Error` | Anything else                                                                             |

**And a refusal is always a reply, never a silence** — the rule stated on `MEDIA_REFUSAL_REASONS`
(`rpc.ts:570-575`). Here it has teeth beyond good manners: a silent engine leaves `sipd` holding an
INVITE transaction until the caller's Timer B, and the caller hears thirty-two seconds of nothing.
A `sipd` whose admission request times out answers `503` on its own authority and logs the timeout as
distinct from a refusal — the same distinction `transfer/client.go:14-19` already draws.

### 10.5 NATS permissions

`config/nats.conf`'s `sipd` user (`:332-380`) is described today as "a pure producer plus two
requesters: it subscribes to no business subject at all". **That sentence stops being true**, and the
comment must change with the grants.

Add to `publish`:

- `sip.evt.v1.>` — the dialog family. The event token is dotted, so the subject has six tokens and a
  three-star filter would match none of them (the lesson already recorded at `nats.conf:294-296`).
- `rpc.sip.v1.invite` — the admission request.
- `$KV.sip-dialogs.>` and the enumerated `$JS.API.*.KV_sip-dialogs` set — **including both the bare
  `$JS.API.CONSUMER.CREATE.KV_sip-dialogs` and the dotted `…KV_sip-dialogs.>` forms**, because `>`
  matches one-or-more tokens and never zero. That exact omission was a permissions violation on the
  first rehydration and is written up at `nats.conf:358-368`.

Add to `subscribe`, for the first time:

- `rpc.sip.v1.ring.*`, `.answer.*`, `.hangup.*`, `.reinvite.*` — the per-instance command surface.
  One token wide, covering every replica, for the same reason `rpc.engine.v1.park-handoff.*` is
  (`nats.conf:229-236`): an enumeration would need a broker restart every time a pod is rescheduled.
- `rpc.sip.v1.originate` — queue-grouped, flat.
- `$KV.sip-acl.>` — the watched ACL read model (§8.1), plus its consumer-create grants.

Add to `engine`'s `publish`: the five `rpc.sip.v1.*` command subjects, **enumerated** rather than
granted as `rpc.sip.v1.*`, for the reason the file already gives about the media subjects — "this
list is the record of what the engine actually calls, so a subject added to the code without being
added here fails at that service with the subject named instead of quietly succeeding everywhere"
(`nats.conf:222-227`). And `rpc.media.v1.create-offer` / `accept-answer` alongside them.

Add to `engine`'s `subscribe`: `sip.evt.v1.>`.
Add to `mediad`'s `subscribe`: `rpc.media.v1.create-offer`, `rpc.media.v1.accept-answer`.
Add to `api`'s `publish`: `$KV.sip-acl.>` — the control plane owns and writes it, as it owns
`did-index`.

What `sipd` still does **not** get, and must not: any `rpc.media.v1.*` subject, any `calls.evt.v1.*`,
any `cdr.leg.v1.*`. §5 of the peer document holds: `sipd` never talks to `mediad`, and the SIP edge
cannot forge a billing record.

---

## 11. How parity is proven

Four layers. The first two are borrowed intact from `plans/mediad-design.md` §8 and the last two are
new.

**11.1 The `MediaPort` conformance suite (§8.1 over there) still does not exist**, and this design
adds a **third** implementation to run it against. `describeMediaPortConformance(makePort)` invoked
against `makeFakeMediaPort()`, `AriMediaAdapter`, `MediadMediaPort` and now the composite is what
turns "the seam holds" into a test rather than four suites that could drift. It is worth more now
than it was, and it is still the highest-value unbuilt thing.

**11.2 The engine integration suite, plane-swapped.** `apps/engine/test/engine-integration.spec.ts`
asserts only domain-level outcomes — NATS subjects, KV snapshots, CDR rows — which is the property
that makes it reusable. It needs a plane switch and **no new assertions**. That is the slice-1 gate.

**11.3 A SIPp scenario matrix**, which does not exist anywhere in this repository today (there is no
`sipp` directory, no scenario XML, and no rig, despite `apps/sipd/README.md:92` and
`internal/credentials/file.go`'s doc comment both referring to "the SIPp rig"). Slice 2 is where it
has to be built, because slice 2's whole content is failure modes: busy, no-answer, cancel, decline,
unreachable, glare, re-INVITE, each asserted on **both** the SIP wire and the resulting CDR
`disposition` (`dispositionFor`, `apps/engine/src/calls/cdr-leg.ts:42-70`).

**11.4 Go-side tests in `sipd`**, following the existing shape exactly: unit tests with no broker and
no socket, every dependency an interface (`registrar.Options`, `transfer.Options`), and integration
tests gated **twice** — `//go:build integration` plus `RUN_SIPD_INTEGRATION=1` — against a throwaway
Docker NATS container. `.github/workflows/go-data-plane.yaml:50-51` already runs that job.

**11.5 Cross-language contract parity.** The new subjects inherit the repo's idiom: golden vectors
emitted **by** the TypeScript source of truth and asserted **by** Go, as
`packages/events-go/parity_test.go` and `apps/sipd/internal/credentials/derive_test.go` already do,
with the codegen drift gate in `ci.yaml`.

**11.6 Media quality.** Unchanged from `plans/mediad-design.md` §8.4, and now finally executable:
MOS and jitter measured against an Asterisk baseline on the same hardware and the same script. Slice
1 is the first moment both halves of that comparison exist.

---

## 12. Open questions

**Blocking, in the order they block things:**

1. **`MediadService.start()` is never called.** `apps/engine/src/main.ts:52-60` wires and starts only
   the ARI connection, so under `ENGINE_MEDIA_DRIVER=mediad` the engine issues commands and receives
   no events: nothing tears a leg down on `session.ended`, and no CDR is written. Two lines, and it
   blocks slice 1 entirely. It also means every claim about the `mediad` driver's event half is
   currently untested end to end in a running process.

2. **Post-dial delay.** `plans/mediad-design.md` §10 q13 asks for this explicitly: "Re-test the
   post-dial delay of the extra hop when it lands; if it is material, the coupling has to be argued
   for explicitly rather than discovered." This design adds **two** hops to answer (admission, then
   allocate) and one to originate. Budget: `100 Trying` is immediate, so the caller hears nothing
   wrong; but the time from INVITE to `180` now includes a NATS round trip plus a routing walk's
   first step. Measure it at slice 1 and put the number in this document.

3. **Where the SDP offer travels on admission.** §10.3 puts it on the request and says why; the
   alternative (a fetch when the engine needs it) trades a copy for a round trip. Re-open once
   question 2 has a number.

4. **The trunk ACL storage shape.** §8.2 — `sip_acl_entry` has no `trunkId` and `trunk` has no CIDR
   column, so slice 3 needs a schema change and the choice between the two shapes has not been made.

**Honestly open, and not blocking:**

5. **Multi-contact `registrations`.** The KV value becomes list-valued (`apps/sipd/README.md:75`),
   which changes a schema two services read. Slice 6. The open part is whether a contact gets a
   stable id (needed to originate to a _specific_ one) or whether the engine sends the URI back.

6. **WSS and SRTP.** Slice 7 can make a WebRTC softphone **register** over WSS. It cannot make it
   **talk**: `mediad` has no SRTP and `plans/mediad-design.md` §1 declined `pion/webrtc`
   deliberately, leaving "a separate ingress in front of the same session model, argued for on its own
   merits". That argument has not been had, and until it is, slice 7's WSS half delivers signalling
   with no media. Say so on the ladder rather than shipping a half-feature.

7. **Cross-plane refusal surface.** §7.2 says pickup, attended transfer, park retrieval, conference
   and queue delivery refuse across planes. Each of those is a different call site with a different
   caller, and none of them currently has a "which plane is this leg on" question to ask. The
   plumbing is small; the number of sites is not zero.

8. **`trunk.status*` and the OPTIONS pinger.** `trunks-schema.ts:18-20` says the columns are "the
   persisted view of the SIP-edge OPTIONS pinger" and that "live trunk state lives in NATS KV". The
   pinger does not exist and neither does the KV shape. Slice 4 needs both, and whether trunk state
   is a fifth KV bucket or a `sip-dialogs`-adjacent record has not been decided.

9. **E.164 normalisation lives nowhere.** `didIndexToken`'s doc comment in `packages/events/src/subjects.ts` assigns per-trunk
   normalisation to the SIP edge and explains why it cannot be a string function in the contract
   package ("turning a national prefix into a country code needs to know which country the trunk is
   in"). There is no normalizer anywhere in the repo and no `country` column on `trunk`. Slice 3.

10. **What a `sipd` restart costs, and whether that is acceptable.** §6.4 says every dialog dies. For
    a fleet of two that is a deploy window; for a fleet of twenty behind a dialog-affine balancer it
    is 5% of calls per rolling restart. The mitigation — draining by refusing new INVITEs while
    letting existing dialogs finish, which is what `SIPD_SHUTDOWN_TIMEOUT` would have to grow into —
    is straightforward but bounded by the longest call, and nobody has decided what that bound is.

11. **Whether admission belongs on the call path at all.** Every INVITE costs a NATS round trip before
    a `180`. A `sipd` that cached a tenant's admission policy (its DIDs, its extensions, its channel
    cap) could answer locally and consult the engine only on a miss — the shape `did-index` already
    has for the engine. It would also remove question 2's first hop. It is not proposed here because
    caching an authorisation decision at the edge is exactly the mistake §8 exists to avoid, and
    because the cache invalidation question (`apps/sipd/README.md:68` already has an open one for
    credentials) is the same question twice. Named so the trade is on the record.

12. **`play` on an unanswered leg.** Ringback and "the number you dialled is unavailable" are part of
    a bridged call, not a later feature (`plans/mediad-design.md` §3.3 says so explicitly), and both
    require early media — a `183` with an answer, which §4.3 defers. So slice 1 has a real gap:
    a call that fails to connect gets a SIP status code and no announcement. Acceptable at slice 1
    between two extensions; not acceptable at slice 3, where a PSTN caller expects to hear why.
