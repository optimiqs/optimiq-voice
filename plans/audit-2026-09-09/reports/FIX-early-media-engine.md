# FIX — early media, step 3 (engine)

Implements step 3 of `FIX-sip-hardening.md` §4 only. Steps 1 (sipd) and 2 (mediad) are cross-area and
spelled out below.

## Design

The `183` is composed exactly like the `200`: `SplitPlaneMediaPort.earlyMedia(channelId)` allocates a
`mediad` session from the A-leg's stored offer and hands the answer to `rpc.sip.v1.ring` with
`status: 183`. It is a `MediaPort` method rather than an argument on `ring` because the two differ in
what the driver must PRODUCE — a 180 is a status line, a 183 commits an offer/answer exchange — and
`AriMediaAdapter` must be able to refuse one while serving the other.

For the B-leg the settle is `acceptAnswer` (the existing `settleOutboundAnswer`), not a
create-offer/renegotiate: the carrier's 183 answers the offer `mediad` already wrote at originate, so
there is nothing to re-offer. §4 step 2's `direction: "sendonly"` and the one-way relay are mediad's
half, not the engine's.

Finding the A-leg from the B-leg: a walker-dialled B-leg has no registry aggregate, so
`OriginateRequest.originatorChannelId` (already passed by `plan-walker.ts:6524`) is recorded on the
B-leg's `LegRecord` and read back with `originatorOf`. No new map, no new eviction: `forget` already
bounds it.

Idempotency and the RFC 3261 §13.2.1 repeat share one latch: the answer the 183 carried is stored on
the A-leg record, so a chatty carrier's later 18x is a no-op and `answer` sends those same bytes
rather than negotiating a second session.

Billing is untouched: `markAnswered` / `channel.answered` / the duration ceiling stay under
`nextCallState === "active"`; the `early` branch runs before the aggregate is even looked up.

## Per file

- `media/sipd-event-mapping.ts` — `dialog.progressed` carries `sdpAnswer`, but only when
  `hasEarlyMedia` (a body on an uncommitted 180 is not an answer to settle).
- `media/media-event.ts` — `sdpAnswer` doc now covers the `early` moment too.
- `media/media-port.ts` — new `earlyMedia(channelId)` on `MediaPort`.
- `media/split-plane.port.ts` — `LegRecord.originatorChannelId` + `earlyMediaAnswer`; `originatorOf`;
  `earlyMedia` (allocate → 183 + answer, cleanup-on-refusal, latch after the response is on the wire);
  `originate` records the originator; `answer` repeats a latched early answer instead of re-allocating.
- `media/ari-media.adapter.ts` — refuses with `MediaOperationNotSupportedError`, matching
  `verb-executor.ts:646`.
- `media/mediad-media.port.ts` — refuses as signalling, alongside `ring`.
- `media/media-port.fake.ts` — records the call.
- `calls/channel-orchestrator.service.ts` — `onCallStateChanged` settles on `early` (refusal handled
  exactly as `active` does) then `relayEarlyMedia`, which is best-effort: losing the announcement
  should not lose the call.

## Tests

`sipd-event-mapping.spec.ts` (body carried on 183, dropped on 180), `split-plane.port.spec.ts`
(183 carries mediad's answer; idempotent across repeated 18x; the 200 repeats the 183's answer and
allocates once; a refused 183 releases the session and stays unlatched; originator recorded and
evicted), `ari-media.adapter.spec.ts` (refuses rather than ringing or answering instead),
`channel-orchestrator.spec.ts` (settle + 183 relay + repeated 18x does not re-ring + **no
`channel.answered` until `active`**).

## Cross-area needed

1. **sipd** — `apps/sipd/internal/command/handlers.go:84-89`: delete the `HandleRing` refusal that
   returns `not_supported` for any 183 carrying a body; keep the `status < 180 || status > 183` check
   above it. Then update the now-stale doc on `sipRingRequestSchema.sdpAnswer`
   (`packages/events/src/schemas/rpc.ts` ~1365): "Refused `not_supported` until early media ships"
   is no longer true, and the paragraph above it that defers early media to a later slice with it.
2. **mediad** — see below.

## Verification

- `pnpm --filter @optimiq-voice/engine run typecheck` — clean.
- `pnpm --filter @optimiq-voice/engine exec bun test src/media src/calls` — 583 pass, 0 fail.
- `pnpm --filter @optimiq-voice/engine run test` — 1730 pass, 12 skip, 0 fail (78 files).
- `pnpm exec oxlint apps/engine/src/media apps/engine/src/calls` — no diagnostics.
- `pnpm exec oxfmt apps/engine/src/media apps/engine/src/calls` — 50 files, clean.

## mediad (cross-area item 2) — investigated

Read of `apps/mediad`: one-way B→A relay while the A-leg dialog is Early is ALMOST there.
`direction: "sendonly"/"recvonly"` is fully honoured on allocate/create-offer
(`internal/control/handlers.go:64,88-100,254-279,867-878`) — the `not_supported` the schema comment at
`packages/events/src/schemas/rpc.ts:1855-1861` claims does not exist in the Go, and that comment is
stale. The bridge relays on `bridge-sessions` with no answered/active gate
(`internal/rtp/manager.go:499,537` → `internal/rtp/session.go:530`); mediad holds no SIP dialog state
at all; `accept-answer` only re-points codec/SRTP (`manager.go:367`) and leaves the leg live.

Two real gaps remain, and they are mediad's to close:

1. `session.remote` is LEARN-ONLY (symmetric-RTP latching, `session.go:163,713-728`). During early
   media the caller usually sends nothing until the 200, so `forward` returns at `session.go:631-635`
   and the announcement is dropped on the floor. Fix: seed `remote` from the offer's `c=`/`m=` at
   allocate, or add an explicit set-remote.
2. `ApplyDirection` (`manager.go:347-361`) moves the mute flags and never the session mode, so a leg
   allocated `inactive` can never be promoted back to relay. The engine sidesteps this by asking for
   `sendrecv` at the 183 and repeating that answer at the 200, but the promotion is still a latent bug.

**Until (1) lands, early media does NOT work end to end on a live call**, even with the sipd refusal
deleted and this engine change in place: signalling and negotiation would be correct and the caller
would still hear silence.
