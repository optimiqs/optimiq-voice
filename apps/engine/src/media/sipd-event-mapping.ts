import { parseSubject, sipDialogEventSchema } from "@optimiq-voice/events";
import { hangupCauseFromCode } from "@optimiq-voice/telephony";
import type { MediaEvent } from "./media-event";
import type { SipDialogEventEnvelope, SipTerminationReason } from "@optimiq-voice/events";
import type { HangupCause } from "@optimiq-voice/telephony";

/**
 * `sip.evt.v1.*` → the engine's own {@link MediaEvent} union.
 *
 * The THIRD translation into one vocabulary, after `calls/ari-mapping.ts`'s `toMediaEvent` and
 * `media/mediad-event-mapping.ts`'s `toMediaEventFromMediad`, and it exists for exactly the reason
 * those two do: the orchestrator's `dispatch` is exhaustive with no `default:`, and which plane
 * produced an event is a fact that stops at this file. `plans/sipd-invite-design.md` §7.1 states the
 * consequence as a requirement — "`toMediaEvent` and `toMediaEventFromSipd` produce the same union,
 * so `leg-arrived` from either plane is one code path" — and this file is where that is true or not.
 *
 * ## Six events in, five members out, and the union is NOT extended
 *
 * | `sip.evt.v1` event  | {@link MediaEvent}                              |
 * | ------------------- | ----------------------------------------------- |
 * | `dialog.progressed` | `call-state-changed` → `ringing`, or → `early`  |
 * | `dialog.answered`   | `call-state-changed` → `active`                 |
 * | `dialog.held`       | `leg-held`                                      |
 * | `dialog.resumed`    | `leg-unheld`                                    |
 * | `dialog.terminated` | `leg-ended`                                     |
 * | `dialog.dtmf`       | `dtmf-received`                                 |
 *
 * Adding a member for this plane was available and was refused, on the rule `media-event.ts` states:
 * a union member nobody branches on is a shape three services would then have to agree on for no
 * reason. Every one of the six above lands on a member the orchestrator already handles, and the
 * layer above cannot tell which plane pressed the key or hung the phone up.
 *
 * ## Three members are deliberately NEVER produced, and each absence is an argument
 *
 * **1. `leg-arrived`.** It is produced by the ADMISSION RPC's caller-side in the engine — see
 * `ChannelOrchestrator.placeInvitedCall` — and not by any event on this family. The reason is
 * `plans/sipd-invite-design.md` §4.2: admission is the one synchronous step, and it answers "will you
 * take this call at all" with the tenant, the call id and the instance that took it. An arrival that
 * also came back as an event would file the leg twice — once from the reply the edge is holding open
 * and once from the JetStream publish — and the second filing would race the routing walk started by
 * the first. It would also be impossible to publish honestly: `sip.evt.v1.<orgId>.<legId>.<event>`
 * needs a real tenant in its subject and, for a trunk INVITE, the edge does not have one until the
 * admission reply. So the arrival is a reply, and this family starts after it.
 *
 * **2. `leg-left`.** On ARI it means "the channel left the Stasis application but still exists",
 * which is the whole reason `MediaPort.watchChannel` had to exist (`media-port.ts`, and the note at
 * `media-event.ts`). A SIP dialog has no such state: it either exists or it does not, and there is no
 * dialplan for it to leave. Producing a synthetic one before every `leg-ended` would be inventing a
 * transition this plane never observes, and the orchestrator's `onLegLeft` only releases the DTMF and
 * mid-call-feature registrations that `onLegEnded` releases again anyway — so never producing it is
 * safe by inspection rather than by hope, and `watchChannel` is satisfied by construction exactly as
 * it already is under `MediadMediaPort`.
 *
 * **3. `hangup-requested`.** It exists so the engine can fix a SPECIFIC cause first-wins BEFORE the
 * generic teardown cause arrives (`media-event.ts`, and `markHangup` in the orchestrator). Under this
 * plane there is no "afterwards": a BYE **is** the termination, and `dialog.terminated` carries the
 * only cause there will ever be. Emitting both from one wire event would run the teardown twice — the
 * same defect `mediad-event-mapping.ts` avoids by mapping `session.rtp-timeout` to nothing, and for
 * the same reason: one wire fact must not become two engine facts.
 *
 * ## The Q.850 cause is NOT re-derived here, and that is the interesting part
 *
 * `mediad-event-mapping.ts` picks a cause from a table of four reasons because "a media plane has no
 * Q.850 opinion — it never saw a SIP response". `apps/sipd` **did** see it. The status maps through
 * RFC 3398 at the edge, and when the far end sent an RFC 3326 `Reason: Q.850;cause=NN` header that
 * value wins verbatim — it is the far end's own switch telling us what it decided, and re-deriving it
 * from the status code in this file would be discarding better evidence for worse. So
 * {@link toMediaEventFromSipd} carries `data.cause` through UNCHANGED as `causeCode`, and the table
 * below never overrides it.
 *
 * What the table is for is narrower and is stated where it is defined: naming a code the domain
 * taxonomy has no name for.
 */

/**
 * The domain NAME to use when the payload's Q.850 code is one `packages/telephony` does not name.
 *
 * This table never decides the cause CODE — the edge saw the SIP response and the code is evidence,
 * so it is carried through byte for byte. It decides only the human-readable name that goes on the
 * CDR beside it, and only when {@link hangupCauseFromCode} answers `undefined`, which happens exactly
 * when a carrier used a Q.850 point outside the taxonomy. Falling flat to `NORMAL_UNSPECIFIED` there
 * would put "a carrier declined with a private cause" in the same CDR bucket as every unexplained
 * hangup, and the termination reason the edge reported is strictly better information than nothing.
 *
 * Each entry is a claim this file has to be able to defend:
 *
 * - `bye` → `NORMAL_CLEARING`. Somebody sent a BYE: the call ended the way calls end.
 * - `cancelled` → `ORIGINATOR_CANCEL`. Exactly what a CANCEL is — the originator gave up before the
 *   `200 OK`. Not `NORMAL_CLEARING`, which would make an abandoned call indistinguishable from a
 *   completed one in a report about abandonment.
 * - `rejected` → `CALL_REJECTED`. A final failure response, ours or theirs. The specific code
 *   normally survives (486 → 17, 404 → 1), so this is only reached for a status RFC 3398 maps to a
 *   point the taxonomy skips.
 * - `timeout` → `ALLOTTED_TIMEOUT`. Timer B, an unACKed 2xx, an RFC 4028 expiry: a deadline this
 *   platform set expired. It is the cause the plan walker already uses for its own ring timeouts, so
 *   one report reads the same for both.
 * - `replaced` → `ATTENDED_TRANSFER`. An RFC 3891 `Replaces` completed and this dialog was the one
 *   taken out of the call, which is the definition of the attended-transfer cause the taxonomy
 *   already carries. Filing it as a plain clearing would lose the transfer from the CDR entirely.
 * - `instance-lost` → `NORMAL_TEMPORARY_FAILURE`. The reaping path (§6.2): a surviving edge found an
 *   expired `sip-dialogs` claim and published the termination its owner never got to. A temporary
 *   failure is the honest name — nobody watched the call end — and it is deliberately NOT
 *   `RECOVERY_ON_TIMER_EXPIRE`, which would suggest a timer this call was supposed to beat.
 * - `shutting-down` → `REQUESTED_CHAN_UNAVAIL`. A drain that ran out of patience: the channel this
 *   call was using went away underneath it, which is the same claim `mediad-event-mapping.ts` makes
 *   for its own `drained` reason and is deliberately the same name, so a drain reads identically
 *   whichever plane was drained.
 */
const CAUSE_NAME_BY_TERMINATION_REASON: Readonly<Record<SipTerminationReason, HangupCause>> = {
	bye: "NORMAL_CLEARING",
	cancelled: "ORIGINATOR_CANCEL",
	rejected: "CALL_REJECTED",
	timeout: "ALLOTTED_TIMEOUT",
	replaced: "ATTENDED_TRANSFER",
	"instance-lost": "NORMAL_TEMPORARY_FAILURE",
	"shutting-down": "REQUESTED_CHAN_UNAVAIL",
};

/**
 * Translates one validated `sip.evt.v1.*` envelope.
 *
 * An `if`-chain rather than a `switch`, matching `toMediaEventFromMediad` exactly: the chain ends in
 * a `return undefined` that can be COMMENTED, and the comment is the record of what was dropped and
 * why. A `switch` with a `default:` is the shape `media-event.ts` was written to abolish.
 *
 * @returns the domain event, or `undefined` when the engine does not act on this one.
 */
export function toMediaEventFromSipd(envelope: SipDialogEventEnvelope): MediaEvent | undefined {
	if (envelope.type === "dialog.progressed") {
		// `early` and `ringing` are two different facts about billing, not two words for one. A `183`
		// carrying an answer COMMITS the offer/answer exchange, so the caller may already be hearing
		// audio the tenant is not being charged for; a plain `180` is ringback and nothing more. The
		// engine's `CallState` already draws that line, so the only translation is the flag.
		return {
			type: "call-state-changed",
			channelId: envelope.data.legId,
			callState: envelope.data.hasEarlyMedia ? "early" : "ringing",
		};
	}
	if (envelope.type === "dialog.answered") {
		// Published on the ACK for a UAS leg and on the `2xx` for a UAC leg — the two moments the call
		// is genuinely established in each direction. It is emphatically NOT the moment the `answer`
		// command replied, which only means the 2xx reached the socket, and `billsec` counts from here.
		return { type: "call-state-changed", channelId: envelope.data.legId, callState: "active" };
	}
	if (envelope.type === "dialog.held") {
		// The direction the far end asserted (`sendonly` vs `inactive`) is carried on the payload and
		// is deliberately dropped here: `MediaLegHeldEvent` has one optional field and it is
		// `musicClass`, which SIP has no way to express — a phone that holds tells us it has stopped
		// sending, never which music it would like. Passing `sendonly` in as a music class would put a
		// direction attribute where a sound file belongs.
		return { type: "leg-held", channelId: envelope.data.legId };
	}
	if (envelope.type === "dialog.resumed") {
		return { type: "leg-unheld", channelId: envelope.data.legId };
	}
	if (envelope.type === "dialog.terminated") {
		return {
			type: "leg-ended",
			channelId: envelope.data.legId,
			// The NAME may fall back; the CODE never does. See the table's own note: the edge saw the
			// SIP response and, when the far end sent an RFC 3326 `Reason` header, the far end's own
			// switch decided this number. Re-deriving it here would be inventing a worse answer than
			// the one we were given.
			cause:
				hangupCauseFromCode(envelope.data.cause) ??
				CAUSE_NAME_BY_TERMINATION_REASON[envelope.data.reason],
			causeCode: envelope.data.cause,
		};
	}
	if (envelope.type === "dialog.dtmf") {
		// SIP INFO digits only — RFC 4733 in-band digits are `mediad`'s and arrive as
		// `media.evt.v1.…dtmf.received`. Both land on the SAME member, which is the point: the
		// confirmation IVR, the feature-code collector and voicemail's digit terminator all read one
		// `DtmfInbox` and none of them can tell how a keypress travelled.
		//
		// `durationMs` defaults to zero rather than being omitted, because `MediaDtmfReceivedEvent`
		// requires it and INFO bodies routinely carry no duration at all. Zero is the honest reading of
		// "the far end did not say", and no consumer branches on it — `onDtmf` passes it to the inbox
		// for the record.
		return {
			type: "dtmf-received",
			channelId: envelope.data.legId,
			digit: envelope.data.digit,
			durationMs: envelope.data.durationMs ?? 0,
		};
	}
	// Nothing else is on this family today. The `return` is here rather than an exhaustiveness assert
	// because a v1.n edge may publish a dialog event a v1.0 engine has never heard of, and dropping it
	// is the additive-evolution rule this backbone runs on — the same contract `toMediaEventFromMediad`
	// holds for `session.rtp-timeout` and `playback.finished`.
	return undefined;
}

/**
 * Decodes and validates one delivered message, then translates it.
 *
 * Validation is not ceremony on this path: the publisher is a Go process compiled from the same Zod
 * source, so a payload that has drifted from the schema is a real possibility rather than a
 * theoretical one, and an orchestrator handed a half-parsed event would tear a leg down on the
 * strength of a field that is not there.
 *
 * A message that fails any check returns `undefined` and is the CALLER's problem to log — poison
 * messages are terminated and logged at the subscription, never allowed to become an unhandled
 * rejection inside a NATS callback.
 */
export function decodeSipdEvent(
	subject: string,
	payload: unknown,
):
	| { readonly envelope: SipDialogEventEnvelope; readonly event: MediaEvent | undefined }
	| undefined {
	const parsed = parseSubject(subject);
	if (parsed === undefined || parsed.kind !== "sip-dialog") {
		return undefined;
	}
	const result = sipDialogEventSchema.safeParse(payload);
	if (!result.success) {
		return undefined;
	}
	const envelope = result.data;
	// The subject's leg token and the payload's leg id must agree, for the same reason
	// `decodeMediadEvent` cross-checks its session token and `validateEvent` cross-checks `orgId`: an
	// event published on the wrong subject would be applied to the wrong leg, and a call torn down
	// because somebody else's dialog ended is the worst possible outcome of a mismatch nobody checked.
	// `makeSipDialogEvent` derives the subject FROM the payload, so a disagreement can only mean a
	// hand-rolled publish or a corrupted one, and neither deserves to reach the orchestrator.
	if (envelope.data.legId !== parsed.legId) {
		return undefined;
	}
	return { envelope, event: toMediaEventFromSipd(envelope) };
}
