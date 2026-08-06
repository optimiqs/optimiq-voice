import { createEntityId } from "@optimiq-voice/identifiers";
import { isAnsweredCause } from "@optimiq-voice/telephony";
import { dialStringOr } from "./ari-mapping";
import type { CdrLegWriteData, HangupSide, LegSide } from "@optimiq-voice/events";
import type { ChannelSnapshot, HangupCause } from "@optimiq-voice/telephony";

/**
 * Building the `cdr.leg.write` payload from a finished leg.
 *
 * Pure and total — no clock, no ids invented beyond the record id, no I/O. The CDR is the billing
 * record, and a function that reads a clock cannot be tested for the case that actually matters:
 * a leg that answered at one instant and ended at another.
 *
 * `organizationId` is deliberately absent from the payload. It is the subject token and the
 * envelope's `orgId`; a third copy is a third thing that can disagree (see `cdr-events.ts`).
 */

/** Reporting outcome. Authority: `@optimiq-voice/cdr-db` `CALL_DISPOSITIONS`. */
export const CALL_DISPOSITIONS = ["answered", "no-answer", "busy", "failed", "voicemail"] as const;

export type CallDisposition = (typeof CALL_DISPOSITIONS)[number];

/**
 * What the routing decision resolved to. Authority: `@optimiq-voice/cdr-db`
 * `CALL_DESTINATION_TYPES`.
 *
 * Still the fallback rather than the answer: a leg the plan walker never got to a destination for —
 * a call rejected at the door, a drain straggler, an artifact that could not be read — genuinely
 * has no destination, and an honest `unknown` is a far better record than a guessed `extension`.
 * Every leg the walker DID route carries the walk's own destination instead (see
 * {@link CdrLegInput.destinationType}).
 */
export const DEFAULT_DESTINATION_TYPE = "unknown";

/**
 * The reporting outcome of a leg.
 *
 * `answeredAt` is authoritative: if the leg was answered it is `answered`, whatever the cause says.
 * Only an UNANSWERED leg is classified by its cause, and then only for the three outcomes a report
 * distinguishes — a busy signal, a caller who gave up, and everything else, which is a failure.
 */
export function dispositionFor(input: {
	readonly answeredAt?: number;
	readonly hangupCause?: HangupCause;
}): CallDisposition {
	if (input.answeredAt !== undefined) {
		return "answered";
	}
	const cause = input.hangupCause;
	if (cause === undefined) {
		return "failed";
	}
	if (cause === "USER_BUSY") {
		return "busy";
	}
	if (
		cause === "NO_ANSWER" ||
		cause === "NO_USER_RESPONSE" ||
		cause === "ORIGINATOR_CANCEL" ||
		cause === "LOSE_RACE" ||
		cause === "SUBSCRIBER_ABSENT"
	) {
		return "no-answer";
	}
	// A cause that is only reachable after answer, on a leg with no `answeredAt`, means the answer
	// instant was lost rather than that the call failed (see `ANSWERED_HANGUP_CAUSES`).
	if (isAnsweredCause(cause)) {
		return "answered";
	}
	return "failed";
}

/** Everything the CDR needs that the snapshot does not carry. */
export interface CdrLegInput {
	readonly snapshot: ChannelSnapshot;
	readonly leg: LegSide;
	readonly direction: CdrLegWriteData["direction"];
	readonly hangupCause: HangupCause;
	readonly hangupCauseCode: number;
	readonly hangupSide: HangupSide;
	/** Epoch millis the leg ended. Usually the snapshot's `hangupAt`, but a drain supplies now. */
	readonly endedAt: number;
	/** The leg that originated this one; absent on an A-leg. */
	readonly originatingLegId?: string;
	/** The leg this one was bridged to, when it was. */
	readonly bridgeLegId?: string;
	/**
	 * Where the routing walk left the call, in the compiler's kebab-case vocabulary
	 * (`extension`, `ring-group`, `ivr-menu`, …). Absent means the leg was never routed.
	 */
	readonly destinationType?: string;
	/**
	 * The row the destination names, when it is backed by one.
	 *
	 * Only set alongside `destinationType`, and only for kinds that HAVE a row: the CDR column is a
	 * UUID, and an `external` node's "ref" is an E.164 string that would fail validation.
	 */
	readonly destinationRef?: string;
}

/**
 * Builds one `cdr.leg.write` payload.
 *
 * `durationMs` is create → end (what the call cost the platform); `billsecMs` is answer → end
 * (what the call costs the tenant). Conflating them is the classic CDR bug: an unanswered leg that
 * rang for 30 seconds must bill zero, not thirty.
 */
export function buildCdrLegWrite(input: CdrLegInput): CdrLegWriteData {
	const { snapshot } = input;
	const startedAt = snapshot.createdAt;
	const endedAt = Math.max(input.endedAt, startedAt);
	const answeredAt = snapshot.answeredAt;

	return {
		id: createEntityId(),
		callId: snapshot.callId,
		leg: input.leg,
		originatingLegId: input.originatingLegId ?? null,
		bridgeLegId: input.bridgeLegId ?? null,

		direction: input.direction,
		fromNumber: dialStringOr(snapshot.profile.callerIdNumber),
		fromName: snapshot.profile.callerIdName ?? null,
		toNumber: dialStringOr(snapshot.profile.destinationNumber),
		destinationType: input.destinationType ?? DEFAULT_DESTINATION_TYPE,
		destinationRef: input.destinationRef ?? null,

		startedAt: new Date(startedAt).toISOString(),
		answeredAt: answeredAt === undefined ? null : new Date(answeredAt).toISOString(),
		endedAt: new Date(endedAt).toISOString(),
		durationMs: endedAt - startedAt,
		billsecMs: answeredAt === undefined ? 0 : Math.max(0, endedAt - answeredAt),

		hangupCause: input.hangupCause,
		hangupCauseCode: input.hangupCauseCode,
		hangupSide: input.hangupSide,
		disposition: dispositionFor({ answeredAt, hangupCause: input.hangupCause }),
	};
}
