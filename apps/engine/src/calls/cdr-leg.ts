import { createEntityId } from "@optimiq-voice/identifiers";
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
 * The ways a leg ends without anybody having answered it.
 *
 * `NORMAL_CLEARING` is in here because of what it means on an UNANSWERED leg, which is not what it
 * means on an answered one: a ring-all loser cancelled by the media server, a caller who gave up
 * while the phone was still ringing, a leg the edge tore down after the race was decided. Every one
 * of those is a call nobody took, and filing them as answered — which is what reading the cause as
 * "the answer instant was lost" did — inflates the answered count and the per-leg billing metrics
 * by one row per fan-out target. See `ANSWERED_HANGUP_CAUSES`, which stays what it is: a
 * reconciliation heuristic for records the ENGINE did not write, and not a source of dispositions.
 */
const UNANSWERED_NO_ANSWER_CAUSES = new Set<HangupCause>([
	"NORMAL_CLEARING",
	"NO_ANSWER",
	"NO_USER_RESPONSE",
	"ORIGINATOR_CANCEL",
	"LOSE_RACE",
	"SUBSCRIBER_ABSENT",
	"ALLOTTED_TIMEOUT",
	"PROGRESS_TIMEOUT",
	"PICKED_OFF",
	"NO_PICKUP",
]);

/**
 * The reporting outcome of a leg.
 *
 * The ANSWER STATE decides it, and it decides it first: a leg with an `answeredAt` is `answered`
 * whatever the cause says, and a leg without one is NEVER `answered`, whatever the cause says. The
 * cause is consulted second and only to tell the three unanswered outcomes a report distinguishes
 * apart — a busy signal, a call nobody took, and a failure.
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
	if (UNANSWERED_NO_ANSWER_CAUSES.has(cause)) {
		return "no-answer";
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
	/**
	 * The authorisation code that opened a gated outbound route. See {@link authorizationOf}.
	 *
	 * The ordinal and the label, never the digits — the digits stop at the walker.
	 */
	readonly authPinOrdinal?: number;
	readonly authPinLabel?: string;
	/**
	 * The carrier's STIR/SHAKEN claim, on an inbound trunk leg that arrived with one.
	 *
	 * Each field independently optional — see {@link attestationOf} for why this is not the
	 * all-or-nothing pair the authorisation code is.
	 */
	readonly sipAttestation?: "A" | "B" | "C";
	readonly sipVerstat?: string;
	readonly sipOrigId?: string;
	/**
	 * The SIP `Call-ID` of the dialog this leg IS, when one is known.
	 *
	 * `call_legs.sip_call_id` exists and was 0-populated across every row on the stack, which makes
	 * the one question a carrier ever asks about a record — "show me the call whose Call-ID was
	 * this" — unanswerable. It is read back off {@link SIP_CALL_ID_VARIABLE}, mirrored like every
	 * other CDR identity here, so a leg adopted after a failover files the same value.
	 *
	 * Absent on a leg with no SIP dialog at all: a Local half, a snoop, a media-only channel.
	 */
	readonly sipCallId?: string;
	/**
	 * The call this leg SETTLES, when it settles one — a queue callback, today the only such leg.
	 *
	 * `originatingLegId` and `bridgeLegId` link legs within one `call_id`; this is the only field
	 * that links two CALLS. A callback is deliberately a new `call_id` rather than a reuse of the
	 * queued one: it happens minutes later with its own answer, its own trunk and its own billing,
	 * and reusing the id would make every duration in the ledger a sum over time the customer was
	 * not on the phone.
	 */
	readonly relatedCallId?: string;
	/**
	 * The consent verdict this leg's recording was made under — or refused under.
	 *
	 * Four loose fields here rather than the whole {@link import("@optimiq-voice/routing")
	 * .RecordingConsentRecord} that rides `channel.record.started`, because the two answer different
	 * questions. The event's record is evidence attached to one audio object and is stored beside
	 * it. These are COLUMNS on the ledger, and the ledger's question is "which of this tenant's calls
	 * were recorded, under what, and where" — asked across millions of rows, filtered and grouped,
	 * by a reviewer who is not going to unpack a jsonb blob to do it.
	 *
	 * All four are absent on the overwhelming majority of legs, which is every leg that was never
	 * recorded and every leg on a tenant with no consent policy.
	 */
	readonly recordingConsent?: NonNullable<CdrLegWriteData["recordingConsent"]>;
	readonly recordingConsentMethod?: NonNullable<CdrLegWriteData["recordingConsentMethod"]>;
	readonly recordingConsentAt?: string;
	readonly recordingConsentRegions?: readonly string[];
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
		...(input.authPinOrdinal === undefined ? {} : { authPinOrdinal: input.authPinOrdinal }),
		...(input.authPinLabel === undefined ? {} : { authPinLabel: input.authPinLabel }),
		...(input.sipAttestation === undefined ? {} : { sipAttestation: input.sipAttestation }),
		...(input.sipVerstat === undefined ? {} : { sipVerstat: input.sipVerstat }),
		...(input.sipOrigId === undefined ? {} : { sipOrigId: input.sipOrigId }),
		// Omitted rather than nulled on a leg that carries no dialog, for the reason the queue fields
		// are: an unmapped null would be a null in `raw` for every such leg in the tenant.
		...(input.sipCallId === undefined ? {} : { sipCallId: input.sipCallId }),
		// The cross-CALL link, omitted on the overwhelming majority of legs that settle nothing. See
		// `CdrLegInput.relatedCallId`.
		...(input.relatedCallId === undefined ? {} : { relatedCallId: input.relatedCallId }),
		// Omitted rather than nulled, on the same rule the queue fields follow: the payload is a
		// `looseObject`, so a null on a leg that was never recorded would be a null in `raw` for every
		// call in the tenant.
		...(input.recordingConsent === undefined ? {} : { recordingConsent: input.recordingConsent }),
		...(input.recordingConsentMethod === undefined
			? {}
			: { recordingConsentMethod: input.recordingConsentMethod }),
		...(input.recordingConsentAt === undefined
			? {}
			: { recordingConsentAt: input.recordingConsentAt }),
		...(input.recordingConsentRegions === undefined
			? {}
			: { recordingConsentRegions: [...input.recordingConsentRegions] }),
	};
}

/**
 * The consent verdict off the leg's channel variables.
 *
 * Symmetric with {@link attestationOf} and mirrored the same way and for the same reason: the CDR
 * is written by whichever of teardown and the walk's return gets there first, only the variables
 * are visible to both, and they travel into the `channels` bucket so a replica adopting the leg
 * after a failover writes the same record.
 *
 * ALL-OR-NOTHING on the outcome, like {@link queueLegOf} and unlike {@link attestationOf}. The
 * outcome is what makes the rest mean anything: a method with no outcome does not say a call was
 * announced, it says a variable was half-written, and "announcement" filed against a call with no
 * verdict is worse than no row at all in the one report these columns exist for. The instant and
 * the regions are then taken on their own, because either can legitimately be missing — an engine
 * that lost its clock write still knows the caller declined, and a call with no jurisdiction match
 * has no regions by construction.
 *
 * The regions parse defensively for the reason the queue wait does: a channel variable is a string
 * a media server echoed, and a JSON blob that came back malformed must put nothing in the column
 * rather than an exception on the teardown path.
 */
export function recordingConsentOf(variables: Readonly<Record<string, string | undefined>>): {
	recordingConsent?: NonNullable<CdrLegWriteData["recordingConsent"]>;
	recordingConsentMethod?: NonNullable<CdrLegWriteData["recordingConsentMethod"]>;
	recordingConsentAt?: string;
	recordingConsentRegions?: readonly string[];
} {
	const outcome = variables.OPTIMIQ_RECORDING_CONSENT;
	if (outcome === undefined || !isConsentOutcome(outcome)) {
		return {};
	}
	const method = variables.OPTIMIQ_RECORDING_CONSENT_METHOD;
	const at = variables.OPTIMIQ_RECORDING_CONSENT_AT;
	const regions = parseConsentRegions(variables.OPTIMIQ_RECORDING_CONSENT_REGIONS);
	return {
		recordingConsent: outcome,
		...(method === undefined || !isConsentMethod(method) ? {} : { recordingConsentMethod: method }),
		...(at === undefined || at === "" ? {} : { recordingConsentAt: at }),
		...(regions === undefined ? {} : { recordingConsentRegions: regions }),
	};
}

const CONSENT_OUTCOMES: readonly string[] = ["not-required", "announced", "accepted", "declined"];
const CONSENT_METHODS: readonly string[] = ["none", "announcement", "keypress"];

function isConsentOutcome(
	value: string,
): value is NonNullable<CdrLegWriteData["recordingConsent"]> {
	return CONSENT_OUTCOMES.includes(value);
}

function isConsentMethod(
	value: string,
): value is NonNullable<CdrLegWriteData["recordingConsentMethod"]> {
	return CONSENT_METHODS.includes(value);
}

function parseConsentRegions(raw: string | undefined): readonly string[] | undefined {
	if (raw === undefined || raw === "") {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) {
		return undefined;
	}
	const regions = parsed.filter(
		(entry): entry is string => typeof entry === "string" && entry.length > 0,
	);
	// The wire caps both the count and each entry's length; a variable that arrived longer is
	// truncated here rather than rejected, because a leg's CDR must not be lost to a malformed
	// sixteenth region.
	return regions.length === 0 ? undefined : regions.slice(0, 16).map((entry) => entry.slice(0, 16));
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

/**
 * The carrier's STIR/SHAKEN claim about the caller, off the leg's variables.
 *
 * Symmetric with {@link authorizationOf} and mirrored the same way and for the same reason: the CDR
 * is written by whichever of teardown and the walk's return gets there first, only the channel
 * variables are visible to both, and they travel into the `channels` bucket so a replica adopting
 * the leg after a failover writes the same record.
 *
 * **Not all-or-nothing, and that is the difference from {@link authorizationOf}.** There the
 * ordinal makes the pair real, because a label with no ordinal is a variable set on a call that was
 * never gated. Here every field is an INDEPENDENT thing a carrier chose to say: `verstat` is stated
 * by carriers that state no `attest` level at all, and a `tn-validation-failed` with no level is the
 * single most useful thing this function can report. So each key is taken on its own, and a level
 * outside the contract's `A`/`B`/`C` vocabulary is dropped rather than passed through — the edge
 * already refuses one, and a second reader that admitted it would make the first decorative.
 */
export function attestationOf(variables: Readonly<Record<string, string | undefined>>): {
	sipAttestation?: "A" | "B" | "C";
	sipVerstat?: string;
	sipOrigId?: string;
} {
	const level = variables.OPTIMIQ_SIP_ATTESTATION;
	const verstat = variables.OPTIMIQ_SIP_VERSTAT;
	const origId = variables.OPTIMIQ_SIP_ORIGID;
	return {
		...(level === "A" || level === "B" || level === "C" ? { sipAttestation: level } : {}),
		...(verstat === undefined || verstat === "" ? {} : { sipVerstat: verstat.slice(0, 64) }),
		...(origId === undefined || origId === "" ? {} : { sipOrigId: origId.slice(0, 128) }),
	};
}

/**
 * The bare number out of a caller identity as the media server was given it.
 *
 * The walker composes what it hands the media server — `"Ada" <+13125557001>` when there is a name,
 * the number alone when there is not — and that composed string is the only place the **effective**
 * caller id exists by the time a leg is created. The leg's own profile is inherited from the A-leg,
 * so a handset dialling out through a trunk that overrides its caller id would file the EXTENSION
 * number (`7001`) in `call_legs.from_number` while the carrier saw `+13125557001`.
 *
 * That is not a cosmetic difference. `AttestationPolicyService`'s backfill stamps
 * `expected_attestation` only when `from_number` is already an E.164, precisely because looking up
 * `7001` in the owned-DID table would miss and record **C** on a call attested **A** — a wrong level
 * in a compliance ledger being worse than an absent one. Filing the number actually presented is
 * what lets that guard fire on a handset-originated call.
 *
 * CLIR does not change the answer: a withheld number is still the identity presented to the carrier
 * (in `P-Asserted-Identity`), and the presentation decision travels as its own field. What comes
 * back here is the number, never the display name, and never the angle brackets.
 *
 * `undefined` for a name-only identity (`"Ada"`), for an empty one, and for an absent one — in every
 * such case the leg keeps whatever its profile already said, which is today's behaviour exactly.
 */
export function presentedCallerIdNumber(callerId: string | undefined): string | undefined {
	if (callerId === undefined) {
		return undefined;
	}
	const angled = /<([^>]*)>\s*$/.exec(callerId);
	const raw = (angled?.[1] ?? callerId).trim();
	// A name-only composition is `"Ada"` — quoted, and no number at all. Returning `Ada` from it
	// would put a display name in an E.164 column.
	if (raw === "" || raw.startsWith('"')) {
		return undefined;
	}
	return raw;
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
