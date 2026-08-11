import { mediaEventSchema, parseSubject } from "@optimiq-voice/events";
import type { MediaEvent } from "./media-event";
import type { MediaEventEnvelope } from "@optimiq-voice/events";
import type { HangupCause } from "@optimiq-voice/telephony";

/**
 * `media.evt.v1.*` → the engine's own {@link MediaEvent} union.
 *
 * The `mediad` twin of `calls/ari-mapping.ts`'s `toMediaEvent`, and it exists for the same reason:
 * the orchestrator consumes ONE event vocabulary, and which media plane produced it is a fact that
 * stops at this file. `ari-mapping.ts` translates Asterisk's names; this translates `mediad`'s. The
 * layer above never learns there are two.
 *
 * ## Five events in, four members out
 *
 * `mediad` publishes five things and the orchestrator branches on three of them, so the mapping is
 * not symmetric — and that asymmetry is the interesting part.
 *
 * - `session.ended` becomes `leg-ended`, the member the CDR is written from. It is the only media
 *   event that means "this leg is over".
 * - `session.rtp-timeout` maps to NOTHING, on purpose. It is the DIAGNOSIS that immediately precedes
 *   a `session.ended` whose reason is `rtp-timeout`, and emitting both would tear the leg down
 *   twice: once on the warning and once on the fact. The reason survives on the `leg-ended` it
 *   causes, which is where a consumer asking "why did that call drop" looks.
 * - `playback.finished` maps to NOTHING either, and this one is a deliberate MIRROR of the ARI
 *   path rather than an omission. `MediaPort.play` returns as soon as audio has STARTED — the verb
 *   executor says so in as many words, because barge-in must not hold a fiber for the length of a
 *   prompt — so nothing above this seam waits for a prompt to end. `toMediaEvent` drops Asterisk's
 *   `PlaybackFinished` for exactly that reason, and adding a union member here would mean two media
 *   planes agreeing on a shape no consumer branches on. The event is still PUBLISHED, because
 *   `reason: error` is a caller in silence where a menu should be and nothing else records it; it
 *   is read by whoever is asking that question, not by the orchestrator.
 * - `recording.finished` becomes `recording-finished`, or `recording-failed` when the reason is
 *   `error`. This is the one media event the layer above genuinely waits for: `plan-walker`'s
 *   voicemail node and `call-control`'s on-demand recording both block until a recording has
 *   finished before they publish `channel.record.stopped`, which is what triggers the archive in
 *   `apps/api`. The split into two members mirrors the ARI path exactly — `RecordingFinished` and
 *   `RecordingFailed` are distinct ARI events, and the callers branch on the distinction: a failure
 *   means there is no file, so no voicemail message is filed and no recording key lands on the CDR.
 *   Folding them together would make a caller treat a missing file as a zero-length one.
 * - `dtmf.received` becomes `dtmf-received`, the member `calls/ari-mapping.ts` already produces
 *   from `ChannelDtmfReceived` — the SAME member, with the same three fields, which is the entire
 *   point of this rung. The orchestrator's `onDtmf` feeds the `DtmfInbox` that the confirmation
 *   IVR, the feature-code collector and voicemail's digit terminator all read, and none of them
 *   changes by a character to run on this driver. The only translation is the one every member on
 *   this list makes: `sessionId` is the engine's channel id, because under this driver both are the
 *   same engine-assigned string.
 *
 * Answering `undefined` for an event the engine does not act on is the same contract `toMediaEvent`
 * has, for the same reason: the decision about what to drop belongs to the layer that knows what it
 * dropped, not to a silent `default:` three files up.
 *
 * ## Why a hangup cause is invented here and not by mediad
 *
 * A media plane has no Q.850 opinion — it never saw a SIP response. But `MediaLegEndedEvent` needs
 * one, because the CDR needs one, so the mapping picks the closest code it can DEFEND from the
 * reason `mediad` did report. That is a translation, which is what this layer is for; the
 * alternative would be `mediad` inventing a signalling cause it has no evidence for, and putting
 * that fiction in the shared contract where every service would compile against it.
 */

/**
 * Q.850 causes for the four ways a media session can end.
 *
 * Each one is a claim this file has to be able to justify:
 *
 * - `released` → 16 NORMAL_CLEARING. The engine asked, so the call ended the way calls end.
 * - `rtp-timeout` → 804 MEDIA_TIMEOUT. The network stopped carrying audio; the call was fine and
 *   the transport was not. Not 31 NORMAL_UNSPECIFIED, which would put a media failure in the same
 *   CDR bucket as every unexplained hangup and make it invisible in a report — and not 41
 *   NORMAL_TEMPORARY_FAILURE either, which is where this used to land: the taxonomy has carried a
 *   cause that means exactly "the media stopped" since it was written, and mapping to a general
 *   failure while the Asterisk-side watchdog raises the specific one would make the two drivers
 *   report the same event under two different names in the same CDR table.
 * - `idle-reaped` → 102 RECOVERY_ON_TIMER_EXPIRE, which is literally what happened: a timer the
 *   engine was supposed to beat expired and the resource was reclaimed.
 * - `drained` → 44 REQUESTED_CHAN_UNAVAIL. The channel this call was using went away underneath it.
 * - `error` → 41 NORMAL_TEMPORARY_FAILURE, the honest answer for "the media plane broke".
 */
const CAUSE_BY_REASON: Readonly<Record<string, { cause: HangupCause; code: number }>> = {
	released: { cause: "NORMAL_CLEARING", code: 16 },
	"rtp-timeout": { cause: "MEDIA_TIMEOUT", code: 804 },
	"idle-reaped": { cause: "RECOVERY_ON_TIMER_EXPIRE", code: 102 },
	drained: { cause: "REQUESTED_CHAN_UNAVAIL", code: 44 },
	error: { cause: "NORMAL_TEMPORARY_FAILURE", code: 41 },
};

/** The fallback for a reason a future `mediad` invents. Unnamed, so the code is the evidence. */
const UNKNOWN_REASON = { cause: "NORMAL_UNSPECIFIED" as HangupCause, code: 31 };

/**
 * Translates one validated `media.evt.v1.*` envelope.
 *
 * @returns the domain event, or `undefined` when the engine does not act on this one.
 */
export function toMediaEventFromMediad(envelope: MediaEventEnvelope): MediaEvent | undefined {
	if (envelope.type === "session.ended") {
		const mapped = CAUSE_BY_REASON[envelope.data.reason] ?? UNKNOWN_REASON;
		return {
			type: "leg-ended",
			// The engine's leg id and mediad's session id are the same string under this driver —
			// both are engine-assigned. See `MediadMediaPort`'s class doc.
			channelId: envelope.data.sessionId,
			cause: mapped.cause,
			causeCode: mapped.code,
		};
	}
	if (envelope.type === "dtmf.received") {
		// One event per KEYPRESS. `mediad` has already collapsed RFC 4733's update packets and the
		// three END retransmissions into one digit, exactly as Asterisk collapses them before raising
		// `ChannelDtmfReceived` — so this mapping is a rename and nothing more, and that is the
		// property the rung was built for: the layer above cannot tell which plane pressed the key.
		return {
			type: "dtmf-received",
			channelId: envelope.data.sessionId,
			digit: envelope.data.digit,
			durationMs: envelope.data.durationMs,
		};
	}
	if (envelope.type === "recording.finished") {
		// The recording is addressed by NAME the whole way up, because ARI has no recording id and
		// the seam inherited that: `MediaPort.record(name)` names it, `stopRecording(name)` stops it,
		// and the waiters key on the same string. `recordingRef` is that name.
		if (envelope.data.reason === "error") {
			return {
				type: "recording-failed",
				recordingName: envelope.data.recordingRef,
				// The media plane's own account of what went wrong, or a stable stand-in. A caller
				// logs this and files no message, so an empty string would be a voicemail that
				// vanished with no reason attached.
				reason: envelope.data.detail ?? "the media plane could not write the recording",
			};
		}
		return {
			type: "recording-finished",
			recordingName: envelope.data.recordingRef,
			durationMs: envelope.data.durationMs,
		};
	}
	// `session.rtp-timeout` and `playback.finished` — see the file header. The first is the
	// diagnosis of an `ended` that follows and carries the reason; the second has no consumer above
	// this seam on either driver, because `play` never waited for it.
	return undefined;
}

/**
 * Decodes and validates one delivered message, then translates it.
 *
 * Validation is not optional on this path: the publisher is a Go process, so a payload that has
 * drifted from the schema is a real possibility rather than a theoretical one, and an orchestrator
 * handed a half-parsed event would tear down a leg on the strength of a field that is not there.
 *
 * A message that fails to parse returns `undefined` and is the CALLER's problem to log — poison
 * messages are terminated and logged at the subscription, never allowed to become an unhandled
 * rejection inside a NATS callback.
 */
export function decodeMediadEvent(
	subject: string,
	payload: unknown,
): { readonly envelope: MediaEventEnvelope; readonly event: MediaEvent | undefined } | undefined {
	const parsed = parseSubject(subject);
	if (parsed === undefined || parsed.kind !== "media") {
		return undefined;
	}
	const result = mediaEventSchema.safeParse(payload);
	if (!result.success) {
		return undefined;
	}
	const envelope = result.data;
	// The subject's session token and the payload's session id must agree, for the same reason
	// `validateEvent` cross-checks `orgId`: an event published on the wrong subject would be applied
	// to the wrong leg, and a leg torn down because somebody else's session ended is the worst
	// possible outcome of a mismatch nobody checked.
	if (envelope.data.sessionId !== parsed.sessionId) {
		return undefined;
	}
	return { envelope, event: toMediaEventFromMediad(envelope) };
}
