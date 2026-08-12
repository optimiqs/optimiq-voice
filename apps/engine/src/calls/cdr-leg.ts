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
	/** Stable UUID v7 persisted with the terminal snapshot, when this is a retryable write. */
	readonly id?: string;
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
	/**
	 * The queue's verdict on this caller's stay, when the walk put them in one.
	 *
	 * Separate from `destinationType` / `destinationRef` even though both name the same queue,
	 * because they answer different questions and only one of them survives the walk continuing: a
	 * caller whose queue timed out into a voicemail box has `destinationType: "voicemail"` by the end
	 * (the walk moved on) and a queue outcome of `timeout`. Losing the second is how a queue that
	 * serves nobody reports a perfect service level.
	 */
	readonly queueRef?: string;
	readonly queueWaitMs?: number;
	readonly queueOutcome?: NonNullable<CdrLegWriteData["queueOutcome"]>;
	readonly queueAgentRef?: string;
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
		id: input.id ?? createEntityId(),
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

		// Omitted entirely rather than sent as null on a leg that never touched a queue. The payload
		// is a `looseObject` whose unmapped keys land in `call_legs.raw`, so a null here would be a
		// null in the ledger's JSON for every direct call in the tenant.
		...(input.queueRef === undefined ? {} : { queueRef: input.queueRef }),
		...(input.queueWaitMs === undefined ? {} : { queueWaitMs: input.queueWaitMs }),
		...(input.queueOutcome === undefined ? {} : { queueOutcome: input.queueOutcome }),
		...(input.queueAgentRef === undefined ? {} : { queueAgentRef: input.queueAgentRef }),
	};
}

/**
 * Reads the queue verdict back off a leg's channel variables.
 *
 * All four or none: a leg carrying a wait with no outcome, or an outcome with no queue, is a leg
 * whose variables were half-written by a process that died mid-walk, and half a verdict in a service
 * level is worse than none. The wait parses defensively for the same reason it is stored as a
 * string — channel variables have no types, and a media server that echoed something unexpected must
 * not put `NaN` into an integer column.
 */
export function queueLegOf(variables: Readonly<Record<string, string | undefined>>): {
	queueRef?: string;
	queueWaitMs?: number;
	queueOutcome?: NonNullable<CdrLegWriteData["queueOutcome"]>;
	queueAgentRef?: string;
} {
	const queueRef = variables.OPTIMIQ_QUEUE_REF;
	const outcome = variables.OPTIMIQ_QUEUE_OUTCOME;
	if (queueRef === undefined || outcome === undefined || !isQueueOutcome(outcome)) {
		return {};
	}
	const waitMs = Number(variables.OPTIMIQ_QUEUE_WAIT_MS);
	const agentRef = variables.OPTIMIQ_QUEUE_AGENT_REF;
	return {
		queueRef,
		queueOutcome: outcome,
		...(Number.isFinite(waitMs) && waitMs >= 0 ? { queueWaitMs: Math.round(waitMs) } : {}),
		// Only ever meaningful on an answer, and refused otherwise: an agent id beside an abandonment
		// would make "who took this call" answerable for a call nobody took.
		...(agentRef === undefined || outcome !== "answered" ? {} : { queueAgentRef: agentRef }),
	};
}

/**
 * The authorisation code that opened a gated outbound route, off the leg's variables.
 *
 * Symmetric with {@link queueLegOf} and mirrored the same way and for the same reason: the CDR is
 * written by whichever of teardown and the walk's return gets there first, and only the channel
 * variables are visible to both. They also travel into the `channels` bucket, so an instance that
 * picks the leg up after a failover writes the same record this one would have.
 *
 * The ORDINAL is what makes the pair real. A label with no ordinal is not a partial authorisation,
 * it is a variable somebody set on a call that was never gated, and it is dropped rather than
 * reported. The digits are nowhere in this function because they are nowhere past the walker — see
 * `PlanWalkerDependencies.onPinAuthorization`.
 */
export function authorizationOf(variables: Readonly<Record<string, string | undefined>>): {
	authPinOrdinal?: number;
	authPinLabel?: string;
} {
	const ordinal = Number(variables.OPTIMIQ_AUTH_PIN_ORDINAL);
	if (
		variables.OPTIMIQ_AUTH_PIN_ORDINAL === undefined ||
		!Number.isInteger(ordinal) ||
		ordinal < 0
	) {
		return {};
	}
	const label = variables.OPTIMIQ_AUTH_PIN_LABEL;
	return {
		authPinOrdinal: ordinal,
		...(label === undefined || label === "" ? {} : { authPinLabel: label }),
	};
}

const QUEUE_OUTCOMES: readonly string[] = [
	"answered",
	"caller-hangup",
	"timeout",
	"overflow",
	"no-agents",
	"exit-key",
];

function isQueueOutcome(value: string): value is NonNullable<CdrLegWriteData["queueOutcome"]> {
	return QUEUE_OUTCOMES.includes(value);
}
