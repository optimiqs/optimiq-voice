import { CALL_DIRECTIONS } from "@optimiq-voice/events";
import { hangupCauseCode, hangupCauseFromCode } from "@optimiq-voice/telephony";
import type { MediaChannelSnapshot, MediaEvent } from "../media/media-event";
import type { CallDirection, HangupSide, LegSide } from "@optimiq-voice/events";
import type { AriChannel, AriEvent } from "@optimiq-voice/media-ari";
import type { CallState, HangupCause } from "@optimiq-voice/telephony";

/**
 * The ARI → domain translation table.
 *
 * Everything here is pure and total. It is the layer that makes the media server swappable: when
 * `apps/mediad` (plan §3.4 option E) replaces Asterisk, this file is replaced and the state
 * machines, the events and the CDR are untouched. Nothing below this file knows the word "ARI".
 *
 * It translates both directions of the seam. VALUES — Q.850 causes, call directions, channel
 * states — have always been here. The EVENT UNION itself is here too as of {@link toMediaEvent}:
 * this file, and the ARI adapter beneath it, are the only places in the engine that name an ARI
 * event type at all.
 *
 * The value domains are IMPORTED, never redeclared — `CallDirection`, `HangupSide` and `LegSide`
 * belong to `@optimiq-voice/events` (the wire contract) and the state machines and hangup causes
 * belong to `@optimiq-voice/telephony` (the domain). A local copy of any of them would be a second
 * source of truth with no test able to notice the drift.
 */

const CALL_DIRECTION_SET = new Set<string>(CALL_DIRECTIONS);

/**
 * Reads the direction a channel variable declares, defaulting to `inbound`.
 *
 * `inbound` is the safe default because it is the only direction that cannot cost money: an
 * outbound leg mis-labelled inbound shows up wrong in reporting; an inbound leg mis-labelled
 * outbound can be billed to a tenant that never placed a call.
 */
export function callDirectionFrom(value: string | undefined): CallDirection {
	const normalized = value?.trim().toLowerCase();
	if (normalized !== undefined && CALL_DIRECTION_SET.has(normalized)) {
		return normalized as CallDirection;
	}
	return "inbound";
}

/**
 * ARI channel state → the user-visible call state that drives BLF.
 *
 * `undefined` means "this ARI state carries no user-visible information", and the caller must then
 * leave the published state alone rather than inventing a transition. That is why the return type
 * is optional instead of falling back to `down`: publishing `down` for a channel that is merely
 * `OffHook` makes a busy lamp flicker off mid-call.
 *
 * `Ring` and `Ringing` both map to `ringing`. Asterisk distinguishes "we are being rung" from "the
 * far end is ringing"; a BLF watcher does not, and the distinction is already carried by the
 * channel's direction.
 */
export function callStateFromAriChannelState(ariState: string): CallState | undefined {
	switch (ariState) {
		case "Down":
		case "Rsrvd":
		case "Pre-ring":
			return "down";
		case "Dialing":
		case "Dialing Offhook":
			return "dialing";
		case "Ring":
		case "Ringing":
			return "ringing";
		case "Up":
			return "active";
		default:
			// `Busy`, `OffHook`, `Unknown` and anything a future Asterisk invents: no user-visible
			// meaning, so no transition.
			return undefined;
	}
}

/**
 * ARI's numeric hangup cause → the domain taxonomy.
 *
 * An unnamed Q.850 point becomes `NORMAL_UNSPECIFIED` while the raw code is preserved separately,
 * exactly as `packages/telephony` prescribes: carriers invent causes, and losing the number would
 * lose the only evidence of what actually happened.
 */
export function hangupCauseFromAri(ariCause: number): HangupCause {
	return hangupCauseFromCode(ariCause) ?? "NORMAL_UNSPECIFIED";
}

/**
 * Q.850 surrogates for the domain's extended causes, for the ONE direction that needs them:
 * telling Asterisk why to hang a channel up.
 *
 * ARI's `reason_code` is a Q.850 code, so the extended causes (`LOSE_RACE` 702, `BLIND_TRANSFER`
 * 800, …) cannot be sent verbatim — they are outside the range Asterisk accepts. The domain cause
 * is still what gets published on NATS and written to the CDR; this map only decides what the far
 * end sees on the wire.
 *
 * Each choice is the closest Q.850 point with the same MEANING to the far end, never just "16 for
 * everything": a losing ring-all leg that reports `NORMAL_CLEARING` to the carrier is
 * indistinguishable from a caller who hung up, and that difference shows up in billing disputes.
 */
export const ARI_CAUSE_SURROGATES: Readonly<Record<string, number>> = {
	/** SIP 487 Request Terminated — the originator gave up. */
	ORIGINATOR_CANCEL: 16,
	/** Q.850 26 "non-selected user clearing" — precisely a losing leg of a ring-all. */
	LOSE_RACE: 26,
	BLIND_TRANSFER: 16,
	ATTENDED_TRANSFER: 16,
	/** Q.850 102 "recovery on timer expiry" — every timeout in the taxonomy. */
	ALLOTTED_TIMEOUT: 102,
	MEDIA_TIMEOUT: 102,
	PROGRESS_TIMEOUT: 102,
	USER_CHALLENGE: 21,
	PICKED_OFF: 16,
	USER_NOT_REGISTERED: 20,
	INVALID_GATEWAY: 3,
	INVALID_URL: 3,
	INVALID_PROFILE: 3,
	GATEWAY_DOWN: 27,
	NO_PICKUP: 19,
	SRTP_READ_ERROR: 31,
};

/** The largest value Q.850 defines, and therefore the largest ARI will accept. */
const MAX_Q850_CODE = 127;

/**
 * The `reason_code` to send on `DELETE /channels/{id}`.
 *
 * @throws {Error} when an extended cause has no surrogate — a gap the type system cannot see,
 * closed in the table above rather than papered over with a default.
 */
export function ariReasonCodeFor(cause: HangupCause): number {
	const code = hangupCauseCode(cause);
	if (code <= MAX_Q850_CODE) {
		return code;
	}
	const surrogate = ARI_CAUSE_SURROGATES[cause];
	if (surrogate === undefined) {
		throw new Error(
			`Hangup cause ${cause} (${String(code)}) is outside Q.850 and has no ARI surrogate. ` +
				"Add one to ARI_CAUSE_SURROGATES.",
		);
	}
	return surrogate;
}

/**
 * Which side a hangup came from.
 *
 * `system` covers the engine's own decisions (drain, media timeout, a rejected call). Everything
 * else is attributed by the leg's role: the A-leg IS the caller and a B-leg IS the callee, so a
 * hangup arriving on a leg is that party's doing unless the engine caused it.
 */
export function hangupSideFor(input: {
	readonly leg: LegSide;
	readonly initiatedByEngine: boolean;
}): HangupSide {
	if (input.initiatedByEngine) {
		return "system";
	}
	return input.leg === "a" ? "caller" : "callee";
}

/**
 * A dial string that satisfies the wire contract.
 *
 * ARI hands back an empty caller number for an anonymous call and an empty extension for a
 * channel that entered Stasis without a dialplan hop, but `dialStringSchema` requires at least one
 * character. Substituting a marker keeps the event publishable — dropping the event instead would
 * mean an anonymous call produced no CDR at all, which is the worse failure by a wide margin.
 */
export const UNKNOWN_DIAL_STRING = "unknown";

export function dialStringOr(value: string | undefined): string {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === "" ? UNKNOWN_DIAL_STRING : trimmed;
}

/**
 * The channel facts the engine reads, lifted out of ARI's `Channel` resource.
 *
 * Pass-through, not normalisation: whether an empty caller number should become `unknown` or
 * `undefined` depends on which consumer is asking (the wire contract and the CDR want different
 * answers), so that decision stays above this seam. See {@link MediaChannelSnapshot}.
 */
function mediaChannelSnapshot(channel: AriChannel): MediaChannelSnapshot {
	return {
		id: channel.id,
		name: channel.name,
		...(channel.caller === undefined
			? {}
			: { callerName: channel.caller.name, callerNumber: channel.caller.number }),
		...(channel.dialplan === undefined
			? {}
			: { dialedNumber: channel.dialplan.exten, context: channel.dialplan.context }),
		// Only present when the media server is configured to export variables with every event,
		// which is why the engine treats it as a hint and reads over the port when it misses.
		variables: channel.channelvars ?? {},
	};
}

/**
 * The Q.850 cause a bare hangup REQUEST is read as when the far end sent none.
 *
 * 16, "normal clearing": the request arrived, so somebody deliberately ended the call, and the only
 * honest reading of "deliberately, reason unstated" is a normal hangup. Defaulting to `NONE` (0)
 * instead would put a cause on the CDR that means "no cause was ever signalled", which is a
 * different and less true statement about a call that was explicitly hung up.
 */
const DEFAULT_HANGUP_REQUEST_CAUSE = 16;

/**
 * ARI's event union → the engine's own.
 *
 * ## Why this function is the seam
 *
 * It is the ONLY place an ARI event name is spoken above the ARI client. Everything downstream —
 * the orchestrator, and whatever else grows a branch on media events — consumes
 * {@link MediaEvent}, so replacing Asterisk means replacing this file and `ari-media.adapter.ts`
 * and nothing else. Before it existed, the orchestrator branched on `StasisStart` and
 * `ChannelDestroyed` directly and a media-server swap meant rewriting 1,800 lines of state machine
 * on live calls.
 *
 * ## `undefined` is a first-class answer, not a failure
 *
 * It means "this is a real event the engine does not act on". Three kinds land here:
 *
 * 1. **Events with no consumer.** Bridge membership, playback progress, `Dial` status,
 *    `ChannelCreated`, `ChannelDialplan`. The plan walker learns what it needs from the channel
 *    events above and from its own command responses, so these carry no decision. They were
 *    already being dropped — by the orchestrator's `default:` — and the only change is that the
 *    drop now happens at the layer that can name what it dropped.
 * 2. **A channel state with no user-visible meaning.** `Busy`, `OffHook`, `Unknown`, and whatever
 *    a future Asterisk invents. `callStateFromAriChannelState` already answered `undefined` for
 *    these and every consumer of that answer was a no-op; producing an event with no domain state
 *    would only push an ARI-shaped hole through the seam.
 * 3. **A `ChannelVarset` for a GLOBAL variable.** The engine's state is per-leg; a variable set on
 *    no channel has nothing to be applied to.
 *
 * It is deliberately NOT the answer for a malformed event — those throw in `parseAriEvent`, at the
 * socket, with the raw frame still in hand.
 */
export function toMediaEvent(event: AriEvent): MediaEvent | undefined {
	switch (event.type) {
		case "StasisStart":
			return { type: "leg-arrived", channel: mediaChannelSnapshot(event.channel) };
		case "StasisEnd":
			return { type: "leg-left", channelId: event.channel.id };
		case "ChannelStateChange": {
			const callState = callStateFromAriChannelState(event.channel.state);
			return callState === undefined
				? undefined
				: { type: "call-state-changed", channelId: event.channel.id, callState };
		}
		case "ChannelDtmfReceived":
			return {
				type: "dtmf-received",
				channelId: event.channel.id,
				digit: event.digit,
				durationMs: event.durationMs,
			};
		case "ChannelHangupRequest":
			return {
				type: "hangup-requested",
				channelId: event.channel.id,
				cause: hangupCauseFromAri(event.cause ?? DEFAULT_HANGUP_REQUEST_CAUSE),
			};
		case "ChannelDestroyed":
			return {
				type: "leg-ended",
				channelId: event.channel.id,
				cause: hangupCauseFromAri(event.cause),
				// The RAW code travels alongside the named cause on purpose: an unnamed Q.850 point
				// becomes `NORMAL_UNSPECIFIED`, and the integer is then the only evidence left.
				causeCode: event.cause,
			};
		case "ChannelVarset":
			return event.channel === undefined
				? undefined
				: {
						type: "variable-set",
						channelId: event.channel.id,
						variable: event.variable,
						value: event.value,
					};
		case "ChannelHold":
			return {
				type: "leg-held",
				channelId: event.channel.id,
				...(event.musicClass === undefined ? {} : { musicClass: event.musicClass }),
			};
		case "ChannelUnhold":
			return { type: "leg-unheld", channelId: event.channel.id };
		case "RecordingStarted":
			return { type: "recording-started", recordingName: event.recording.name };
		case "RecordingFinished":
			return {
				type: "recording-finished",
				recordingName: event.recording.name,
				// ARI reports seconds; milliseconds are the unit everywhere above this seam.
				durationMs: Math.round((event.recording.duration ?? 0) * 1_000),
			};
		case "RecordingFailed":
			return {
				type: "recording-failed",
				recordingName: event.recording.name,
				reason: event.recording.cause ?? UNKNOWN_RECORDING_FAILURE_REASON,
			};
		default:
			return undefined;
	}
}

/** What a recording failure is reported as when the media server volunteered no reason. */
export const UNKNOWN_RECORDING_FAILURE_REASON = "unknown";
