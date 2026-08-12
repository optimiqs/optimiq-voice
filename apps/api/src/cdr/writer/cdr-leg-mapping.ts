import {
	CALL_DESTINATION_TYPES,
	CALL_DIRECTIONS,
	CALL_DISPOSITIONS,
	CALL_LEG_SIDES,
	HANGUP_CAUSES,
	HANGUP_SIDES,
	QUEUE_OUTCOMES,
} from "@optimiq-voice/cdr-db";
import type {
	CallDestinationType,
	CallDirection,
	CallDisposition,
	CallLegSide,
	HangupCause,
	HangupSide,
	QueueOutcome,
} from "@optimiq-voice/cdr-db";

/**
 * `cdr.leg.write` → a `call_legs` row.
 *
 * ## Why this file exists at all
 *
 * The event contract is deliberately LOOSE about three fields, and says so: `destinationType`,
 * `hangupCause` and `disposition` are constrained STRINGS in `@optimiq-voice/events`, not enums,
 * "so new destination types arrive with new PBX features and must not require an `events`
 * release". `cdr-db` is the authority on the value domains, and it enforces them with `check`
 * constraints. Something has to sit between "any lower-kebab string" and "one of thirteen
 * snake_case values", and if that something is not a named, tested function then it is an
 * unhandled `23514` in the consume loop at three in the morning.
 *
 * ## The vocabularies genuinely differ, and neither is wrong
 *
 * The engine writes `OPTIMIQ_DESTINATION_TYPE` from the routing plan's node kind, which is
 * `PLAN_NODE_KINDS` in `@optimiq-voice/routing` — kebab-case, and shaped around what the WALKER
 * does (`ivr-menu`, `trunk-dial`, `playback`, `feature-code`). `call_legs.destination_type` is
 * snake_case and shaped around what a REPORT asks (`ivr`, `trunk`, and no row at all for the
 * things that are steps rather than destinations). Translating in the writer keeps both honest:
 * the engine does not learn the reporting vocabulary, and the reporting column does not gain
 * values nobody reports on.
 *
 * Three plan kinds map to `unknown` on purpose rather than getting a column value:
 * `playback` (an announcement is something a call did, not somewhere it ended up), `feature-code`
 * (that is HOW the call was dialled, and the walk continues past it) and `hangup` (a call refused
 * at the door reached no destination — an honest `unknown` beats a guessed `extension`, which is
 * the reasoning `apps/engine/src/calls/cdr-leg.ts` already records for the absent case).
 *
 * ## Nothing is ever dropped
 *
 * Every key the payload carried that does not become a column lands in `raw`, and every value this
 * function had to rewrite is recorded under `raw._writer` alongside what it was. So a report can be
 * wrong about a leg and still be diagnosable: the original string is one `->>` away, and "which
 * legs did the writer have to coerce?" is a query rather than a log search.
 */

/** Columns this mapper produces. Everything else on the payload becomes `raw`. */
const MAPPED_KEYS = new Set([
	"id",
	"callId",
	"leg",
	"originatingLegId",
	"bridgeLegId",
	"direction",
	"fromNumber",
	"fromName",
	"toNumber",
	"destinationType",
	"destinationRef",
	"startedAt",
	"answeredAt",
	"endedAt",
	"durationMs",
	"billsecMs",
	"hangupCause",
	"hangupCauseCode",
	"hangupSide",
	"disposition",
	"queueRef",
	"queueWaitMs",
	"queueOutcome",
	"queueAgentRef",
]);

/**
 * Plan-node kind (and pbx-db destination type) → CDR destination type.
 *
 * The snake_case forms map to themselves so a producer already speaking the reporting vocabulary
 * round-trips untouched, which is what makes the verification script's synthetic payloads and the
 * engine's real ones exercise the same path.
 */
const DESTINATION_TYPE_ALIASES: Readonly<Record<string, CallDestinationType>> = {
	extension: "extension",
	queue: "queue",
	voicemail: "voicemail",
	conference: "conference",
	park: "park",
	external: "external",
	application: "application",
	unknown: "unknown",

	// Kebab plan kinds that name the same thing under a different word.
	"ring-group": "ring_group",
	ring_group: "ring_group",
	"ivr-menu": "ivr",
	ivr: "ivr",
	"time-condition": "time_condition",
	time_condition: "time_condition",
	"trunk-dial": "trunk",
	trunk: "trunk",
	/**
	 * Both spellings of a page, because the two vocabularies name it differently at each end and the
	 * writer sees both: `paging` is the plan-node kind the engine copies out of the walk, and
	 * `paging-group` is the `pbx-db` destination type a row carries when something ROUTED into an
	 * announcement. `cdr-db` spells the reporting value `paging` — the group is named by
	 * `destination_ref`, so repeating "group" in the type would be the column saying it twice.
	 *
	 * This pair used to be absent, and the fallback below turned every paged leg into `unknown`.
	 * That was the wrong kind of inaccuracy to leave: a page originates one auto-answered leg per
	 * member, so an announcement to fifty desks is fifty unattributable rows, and `unknown` stops
	 * meaning "rare residue" the first time somebody uses the overhead pager. The fix needed the
	 * value in `CALL_DESTINATION_TYPES` and a migration widening `call_legs_destination_type_check`;
	 * both landed with this entry, because an alias pointing at a value the check constraint refuses
	 * is not a fix, it is a `23514` moved from the report to the consume loop.
	 */
	paging: "paging",
	"paging-group": "paging",

	// Steps, not destinations. See the file header.
	playback: "unknown",
	"feature-code": "unknown",
	hangup: "unknown",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** What the mapper had to change, so the coercion is visible in the row rather than only in a log. */
export interface CdrLegCoercion {
	readonly field: string;
	readonly received: unknown;
	readonly stored: string;
}

export interface CallLegInsertValues {
	readonly id: string;
	readonly organizationId: string;
	readonly callId: string;
	readonly leg: CallLegSide;
	readonly originatingLegId: string | null;
	readonly bridgeLegId: string | null;
	readonly direction: CallDirection;
	readonly fromNumber: string;
	readonly fromName: string | null;
	readonly toNumber: string;
	readonly destinationType: CallDestinationType;
	readonly destinationRef: string | null;
	readonly startedAt: Date;
	readonly answeredAt: Date | null;
	readonly endedAt: Date | null;
	readonly durationMs: number;
	readonly billsecMs: number;
	readonly hangupCause: HangupCause;
	readonly hangupCauseCode: number;
	readonly hangupSide: HangupSide | null;
	readonly disposition: CallDisposition;
	/**
	 * The queue's verdict on the caller's stay. All four or none — see the mapping.
	 *
	 * Explicitly `null` rather than optional, unlike the payload they come from: these are INSERT
	 * values, and an omitted key and a null column are the same row while an omitted key and an
	 * absent field are not the same object. Spelling the absence keeps "this leg never touched a
	 * queue" a thing the type can be asked about.
	 */
	readonly queueRef: string | null;
	readonly queueWaitMs: number | null;
	readonly queueOutcome: QueueOutcome | null;
	readonly queueAgentRef: string | null;
	readonly raw: Record<string, unknown>;
}

export interface CdrLegMappingResult {
	readonly values: CallLegInsertValues;
	readonly coercions: readonly CdrLegCoercion[];
}

/** Raised when the payload cannot become a row at all. The caller quarantines rather than retries. */
export class CdrLegMappingError extends Error {
	readonly _tag = "CdrLegMappingError" as const;

	constructor(message: string) {
		super(message);
		this.name = "CdrLegMappingError";
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asUuid(value: unknown): string | null {
	const text = asString(value);
	return text !== undefined && UUID_PATTERN.test(text) ? text : null;
}

function asDate(value: unknown): Date | null {
	const text = asString(value);
	if (text === undefined) {
		return null;
	}
	const parsed = new Date(text);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The two duration columns are `notNull default 0` with a `>= 0` check; anything else is zero. */
function asNonNegativeInt(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * Maps one validated `cdr.leg.write` payload onto a row.
 *
 * `organizationId` comes from the SUBJECT, never from the payload — `cdr-events.ts` states the
 * rule ("a third copy is a third thing that can disagree") and this is the consumer half of it.
 *
 * Throws only for the two fields a row cannot be invented for: the id and the partition key. Every
 * other divergence is coerced to a legal value and recorded.
 */
export function mapCdrLegWrite(
	organizationId: string,
	payload: Readonly<Record<string, unknown>>,
): CdrLegMappingResult {
	const coercions: CdrLegCoercion[] = [];
	const record = (field: string, received: unknown, stored: string): void => {
		coercions.push({ field, received, stored });
	};

	const id = asUuid(payload.id);
	if (id === null) {
		throw new CdrLegMappingError(
			`cdr.leg.write carries no usable id (received ${String(payload.id)}).`,
		);
	}
	const startedAt = asDate(payload.startedAt);
	if (startedAt === null) {
		throw new CdrLegMappingError(
			`cdr.leg.write ${id} carries no usable startedAt (received ${String(payload.startedAt)}); ` +
				"it is the partition key and cannot be defaulted.",
		);
	}
	const callId = asUuid(payload.callId);
	if (callId === null) {
		throw new CdrLegMappingError(`cdr.leg.write ${id} carries no usable callId.`);
	}

	const legValue = asString(payload.leg);
	const leg = (CALL_LEG_SIDES as readonly string[]).includes(legValue ?? "")
		? (legValue as CallLegSide)
		: ((): CallLegSide => {
				record("leg", payload.leg, "a");
				return "a";
			})();

	const directionValue = asString(payload.direction);
	const direction = (CALL_DIRECTIONS as readonly string[]).includes(directionValue ?? "")
		? (directionValue as CallDirection)
		: ((): CallDirection => {
				record("direction", payload.direction, "inbound");
				return "inbound";
			})();

	const destinationRaw = asString(payload.destinationType);
	const destinationMapped =
		destinationRaw === undefined ? undefined : DESTINATION_TYPE_ALIASES[destinationRaw];
	const destinationType: CallDestinationType =
		destinationMapped !== undefined &&
		(CALL_DESTINATION_TYPES as readonly string[]).includes(destinationMapped)
			? destinationMapped
			: "unknown";
	// Recorded whenever what is STORED differs from what arrived — which covers a rename
	// (`ivr-menu` → `ivr`), a step that has no destination (`playback` → `unknown`) and a value
	// nobody has taught the writer yet. A snake_case value that maps to itself records nothing.
	if (destinationRaw !== destinationType) {
		record("destinationType", payload.destinationType, destinationType);
	}

	/**
	 * A cause we do not name is stored as `NORMAL_UNSPECIFIED` with its NUMERIC code intact — the
	 * exact fallback `packages/events` promises callers, and the reason `hangup_cause_code` is a
	 * column of its own: a carrier cause the taxonomy has never seen still survives the round trip
	 * as a number even though its name did not.
	 */
	const causeValue = asString(payload.hangupCause);
	let hangupCause: HangupCause = "NONE";
	if (causeValue !== undefined) {
		if ((HANGUP_CAUSES as readonly string[]).includes(causeValue)) {
			hangupCause = causeValue as HangupCause;
		} else {
			hangupCause = "NORMAL_UNSPECIFIED";
			record("hangupCause", payload.hangupCause, hangupCause);
		}
	}

	const sideValue = asString(payload.hangupSide);
	let hangupSide: HangupSide | null = null;
	if (sideValue !== undefined) {
		if ((HANGUP_SIDES as readonly string[]).includes(sideValue)) {
			hangupSide = sideValue as HangupSide;
		} else {
			record("hangupSide", payload.hangupSide, "system");
			hangupSide = "system";
		}
	}

	const dispositionValue = asString(payload.disposition);
	let disposition: CallDisposition;
	if (
		dispositionValue !== undefined &&
		(CALL_DISPOSITIONS as readonly string[]).includes(dispositionValue)
	) {
		disposition = dispositionValue as CallDisposition;
	} else {
		// `failed` rather than `answered`: a disposition we could not read must never be the one
		// that bills. Under-reporting revenue is a support ticket; over-reporting it is fraud.
		disposition = "failed";
		record("disposition", payload.disposition, disposition);
	}

	const causeCodeValue = payload.hangupCauseCode;
	const hangupCauseCode =
		typeof causeCodeValue === "number" && Number.isFinite(causeCodeValue)
			? Math.max(0, Math.min(32_767, Math.trunc(causeCodeValue)))
			: 0;

	const fromNumber = asString(payload.fromNumber) ?? "unknown";
	const toNumber = asString(payload.toNumber) ?? "unknown";
	if (asString(payload.fromNumber) === undefined) {
		record("fromNumber", payload.fromNumber, fromNumber);
	}
	if (asString(payload.toNumber) === undefined) {
		record("toNumber", payload.toNumber, toNumber);
	}

	const raw: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (!MAPPED_KEYS.has(key)) {
			raw[key] = value;
		}
	}
	// A destinationRef the engine sent that is not a UUID (an `external` node's E.164 "ref", say)
	// would fail the column's type rather than its check constraint, so it is kept in `raw` where
	// it is still answerable instead of being silently discarded.
	const destinationRef = asUuid(payload.destinationRef);
	if (destinationRef === null && payload.destinationRef != null) {
		raw.destinationRefRaw = payload.destinationRef;
		record("destinationRef", payload.destinationRef, "null");
	}
	if (coercions.length > 0) {
		raw._writer = { coercions };
	}

	// The queue verdict, all four or none. A leg carrying a wait with no outcome is a leg whose
	// producer died mid-walk, and half a verdict in a service level is worse than none — a wait with
	// no outcome would be counted by an average and by nothing else, which is the shape of a number
	// that is quietly wrong. An unrecognised outcome is a coercion rather than a rejection, for the
	// same reason `destinationType` is: the row is worth keeping without it.
	const queueRef = asUuid(payload.queueRef);
	const outcomeRaw = asString(payload.queueOutcome);
	const queueOutcome =
		outcomeRaw !== undefined && (QUEUE_OUTCOMES as readonly string[]).includes(outcomeRaw)
			? (outcomeRaw as QueueOutcome)
			: undefined;
	if (outcomeRaw !== undefined && queueOutcome === undefined) {
		record("queueOutcome", payload.queueOutcome, "null");
	}
	const queueLeg =
		queueRef === null || queueOutcome === undefined
			? { queueRef: null, queueWaitMs: null, queueOutcome: null, queueAgentRef: null }
			: {
					queueRef,
					queueOutcome,
					queueWaitMs: asNonNegativeInt(payload.queueWaitMs),
					// Only on an answer. An agent id beside an abandonment would make "who took this
					// call" answerable for a call nobody took.
					queueAgentRef: queueOutcome === "answered" ? asUuid(payload.queueAgentRef) : null,
				};

	return {
		values: {
			id,
			organizationId,
			callId,
			leg,
			originatingLegId: asUuid(payload.originatingLegId),
			bridgeLegId: asUuid(payload.bridgeLegId),
			direction,
			fromNumber: fromNumber.slice(0, 128),
			fromName: asString(payload.fromName)?.slice(0, 128) ?? null,
			toNumber: toNumber.slice(0, 128),
			destinationType,
			destinationRef,
			startedAt,
			answeredAt: asDate(payload.answeredAt),
			endedAt: asDate(payload.endedAt),
			durationMs: asNonNegativeInt(payload.durationMs),
			billsecMs: asNonNegativeInt(payload.billsecMs),
			hangupCause,
			hangupCauseCode,
			hangupSide,
			disposition,
			...queueLeg,
			raw,
		},
		coercions,
	};
}
