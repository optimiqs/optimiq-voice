import { CALL_DIRECTIONS } from "@optimiq-voice/events";
import { hangupCauseCode, hangupCauseFromCode } from "@optimiq-voice/telephony";
import type { CallDirection, HangupSide, LegSide } from "@optimiq-voice/events";
import type { CallState, HangupCause } from "@optimiq-voice/telephony";

/**
 * The ARI → domain translation table.
 *
 * Everything here is pure and total. It is the layer that makes the media server swappable: when
 * `apps/mediad` (plan §3.4 option E) replaces Asterisk, this file is replaced and the state
 * machines, the events and the CDR are untouched. Nothing below this file knows the word "ARI".
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
