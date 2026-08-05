/**
 * Hangup-cause taxonomy — Q.850 named subset plus the FreeSWITCH extensions.
 *
 * Frozen source of truth: `plans/reference/freeswitch-capabilities.md` §6
 * ("Full Q.850 (1–127) plus extensions"). Routing keys off these names — outbound-route
 * failover, `continue_on_fail` cause lists and CDR disposition all read them — so the names
 * and codes are reproduced verbatim and are pinned by `hangup-causes.spec.ts`. Renaming a
 * member is a breaking change for every stored CDR row.
 *
 * Only the Q.850 points a softswitch actually emits are named (45 of the 1–127 range);
 * anything else that arrives from a carrier is stored as its numeric code on
 * `call_legs.hangup_cause_code` with `hangup_cause = "NORMAL_UNSPECIFIED"`.
 */

/** Q.850 causes (plus `NONE`, the "no cause recorded yet" sentinel). */
export const Q850_HANGUP_CAUSES = [
	"NONE",
	"UNALLOCATED_NUMBER",
	"NO_ROUTE_TRANSIT_NET",
	"NO_ROUTE_DESTINATION",
	"CHANNEL_UNACCEPTABLE",
	"CALL_AWARDED_DELIVERED",
	"NORMAL_CLEARING",
	"USER_BUSY",
	"NO_USER_RESPONSE",
	"NO_ANSWER",
	"SUBSCRIBER_ABSENT",
	"CALL_REJECTED",
	"NUMBER_CHANGED",
	"REDIRECTION_TO_NEW_DESTINATION",
	"EXCHANGE_ROUTING_ERROR",
	"DESTINATION_OUT_OF_ORDER",
	"INVALID_NUMBER_FORMAT",
	"FACILITY_REJECTED",
	"RESPONSE_TO_STATUS_ENQUIRY",
	"NORMAL_UNSPECIFIED",
	"NORMAL_CIRCUIT_CONGESTION",
	"NETWORK_OUT_OF_ORDER",
	"NORMAL_TEMPORARY_FAILURE",
	"SWITCH_CONGESTION",
	"ACCESS_INFO_DISCARDED",
	"REQUESTED_CHAN_UNAVAIL",
	"PRE_EMPTED",
	"FACILITY_NOT_SUBSCRIBED",
	"OUTGOING_CALL_BARRED",
	"INCOMING_CALL_BARRED",
	"BEARERCAPABILITY_NOTAUTH",
	"BEARERCAPABILITY_NOTAVAIL",
	"SERVICE_UNAVAILABLE",
	"BEARERCAPABILITY_NOTIMPL",
	"CHAN_NOT_IMPLEMENTED",
	"FACILITY_NOT_IMPLEMENTED",
	"SERVICE_NOT_IMPLEMENTED",
	"INVALID_CALL_REFERENCE",
	"INCOMPATIBLE_DESTINATION",
	"INVALID_MSG_UNSPECIFIED",
	"MANDATORY_IE_MISSING",
	"MESSAGE_TYPE_NONEXIST",
	"WRONG_MESSAGE",
	"IE_NONEXIST",
	"INVALID_IE_CONTENTS",
	"WRONG_CALL_STATE",
	"RECOVERY_ON_TIMER_EXPIRE",
	"MANDATORY_IE_LENGTH_ERROR",
	"PROTOCOL_ERROR",
	"INTERWORKING",
] as const;

/**
 * FreeSWITCH-extended causes, verbatim from the frozen reference §6. These are the ones the
 * PBX itself raises: ring-all cleanup, transfers, timeouts, gateway health and pickup.
 */
export const EXTENDED_HANGUP_CAUSES = [
	"ORIGINATOR_CANCEL",
	"LOSE_RACE",
	"BLIND_TRANSFER",
	"ATTENDED_TRANSFER",
	"ALLOTTED_TIMEOUT",
	"USER_CHALLENGE",
	"MEDIA_TIMEOUT",
	"PICKED_OFF",
	"USER_NOT_REGISTERED",
	"PROGRESS_TIMEOUT",
	"INVALID_GATEWAY",
	"GATEWAY_DOWN",
	"INVALID_URL",
	"INVALID_PROFILE",
	"NO_PICKUP",
	"SRTP_READ_ERROR",
] as const;

/** Every accepted value of `call_legs.hangup_cause`. */
export const HANGUP_CAUSES = [...Q850_HANGUP_CAUSES, ...EXTENDED_HANGUP_CAUSES] as const;

export type Q850HangupCause = (typeof Q850_HANGUP_CAUSES)[number];
export type ExtendedHangupCause = (typeof EXTENDED_HANGUP_CAUSES)[number];
export type HangupCause = (typeof HANGUP_CAUSES)[number];

/** Name → numeric code. Codes 1–127 are Q.850; everything above is a FreeSWITCH extension. */
export const HANGUP_CAUSE_CODES: Readonly<Record<HangupCause, number>> = {
	NONE: 0,
	UNALLOCATED_NUMBER: 1,
	NO_ROUTE_TRANSIT_NET: 2,
	NO_ROUTE_DESTINATION: 3,
	CHANNEL_UNACCEPTABLE: 6,
	CALL_AWARDED_DELIVERED: 7,
	NORMAL_CLEARING: 16,
	USER_BUSY: 17,
	NO_USER_RESPONSE: 18,
	NO_ANSWER: 19,
	SUBSCRIBER_ABSENT: 20,
	CALL_REJECTED: 21,
	NUMBER_CHANGED: 22,
	REDIRECTION_TO_NEW_DESTINATION: 23,
	EXCHANGE_ROUTING_ERROR: 25,
	DESTINATION_OUT_OF_ORDER: 27,
	INVALID_NUMBER_FORMAT: 28,
	FACILITY_REJECTED: 29,
	RESPONSE_TO_STATUS_ENQUIRY: 30,
	NORMAL_UNSPECIFIED: 31,
	NORMAL_CIRCUIT_CONGESTION: 34,
	NETWORK_OUT_OF_ORDER: 38,
	NORMAL_TEMPORARY_FAILURE: 41,
	SWITCH_CONGESTION: 42,
	ACCESS_INFO_DISCARDED: 43,
	REQUESTED_CHAN_UNAVAIL: 44,
	PRE_EMPTED: 45,
	FACILITY_NOT_SUBSCRIBED: 50,
	OUTGOING_CALL_BARRED: 52,
	INCOMING_CALL_BARRED: 54,
	BEARERCAPABILITY_NOTAUTH: 57,
	BEARERCAPABILITY_NOTAVAIL: 58,
	SERVICE_UNAVAILABLE: 63,
	BEARERCAPABILITY_NOTIMPL: 65,
	CHAN_NOT_IMPLEMENTED: 66,
	FACILITY_NOT_IMPLEMENTED: 69,
	SERVICE_NOT_IMPLEMENTED: 79,
	INVALID_CALL_REFERENCE: 81,
	INCOMPATIBLE_DESTINATION: 88,
	INVALID_MSG_UNSPECIFIED: 95,
	MANDATORY_IE_MISSING: 96,
	MESSAGE_TYPE_NONEXIST: 97,
	WRONG_MESSAGE: 98,
	IE_NONEXIST: 99,
	INVALID_IE_CONTENTS: 100,
	WRONG_CALL_STATE: 101,
	RECOVERY_ON_TIMER_EXPIRE: 102,
	MANDATORY_IE_LENGTH_ERROR: 103,
	PROTOCOL_ERROR: 111,
	INTERWORKING: 127,
	ORIGINATOR_CANCEL: 487,
	LOSE_RACE: 702,
	BLIND_TRANSFER: 800,
	ATTENDED_TRANSFER: 801,
	ALLOTTED_TIMEOUT: 802,
	USER_CHALLENGE: 803,
	MEDIA_TIMEOUT: 804,
	PICKED_OFF: 805,
	USER_NOT_REGISTERED: 806,
	PROGRESS_TIMEOUT: 807,
	INVALID_GATEWAY: 808,
	GATEWAY_DOWN: 809,
	INVALID_URL: 810,
	INVALID_PROFILE: 811,
	NO_PICKUP: 812,
	SRTP_READ_ERROR: 813,
} as const;

/** Numeric code → name. Built from {@link HANGUP_CAUSE_CODES} so the two can never diverge. */
export const HANGUP_CAUSE_NAMES: Readonly<Record<number, HangupCause>> = Object.freeze(
	Object.fromEntries(
		Object.entries(HANGUP_CAUSE_CODES).map(([name, code]) => [code, name as HangupCause]),
	) as Record<number, HangupCause>,
);

const HANGUP_CAUSE_SET = new Set<string>(HANGUP_CAUSES);

/** Type guard for values arriving from the wire, a webhook or a legacy CDR row. */
export function isHangupCause(value: string): value is HangupCause {
	return HANGUP_CAUSE_SET.has(value);
}

/** Numeric code for a cause name. Total over {@link HangupCause}, so it never returns undefined. */
export function hangupCauseCode(cause: HangupCause): number {
	return HANGUP_CAUSE_CODES[cause];
}

/**
 * Name for a numeric code, or `undefined` for a Q.850 point we deliberately do not name.
 * Callers store the raw code and fall back to `NORMAL_UNSPECIFIED`.
 */
export function hangupCauseFromCode(code: number): HangupCause | undefined {
	return HANGUP_CAUSE_NAMES[code];
}

/**
 * Causes that justify trying the next target/trunk in an outbound route or ring group.
 *
 * The rule is "the far end never made a decision about this call": transport, congestion,
 * gateway-health and timeout failures. Deliberately excluded are outcomes that ARE a decision
 * (`USER_BUSY`, `NO_ANSWER`, `CALL_REJECTED`, `UNALLOCATED_NUMBER`), locally-initiated
 * teardowns (`ORIGINATOR_CANCEL`, `NORMAL_CLEARING`) and the expected ring-all cleanup
 * (`LOSE_RACE`) — retrying any of those is how toll-fraud loops and duplicate-billing bugs start.
 */
export const RETRYABLE_HANGUP_CAUSES = [
	"NO_ROUTE_TRANSIT_NET",
	"NO_ROUTE_DESTINATION",
	"CHANNEL_UNACCEPTABLE",
	"DESTINATION_OUT_OF_ORDER",
	"NORMAL_CIRCUIT_CONGESTION",
	"NETWORK_OUT_OF_ORDER",
	"NORMAL_TEMPORARY_FAILURE",
	"SWITCH_CONGESTION",
	"REQUESTED_CHAN_UNAVAIL",
	"SERVICE_UNAVAILABLE",
	"RECOVERY_ON_TIMER_EXPIRE",
	"PROTOCOL_ERROR",
	"INTERWORKING",
	"NO_USER_RESPONSE",
	"MEDIA_TIMEOUT",
	"PROGRESS_TIMEOUT",
	"INVALID_GATEWAY",
	"GATEWAY_DOWN",
	"SRTP_READ_ERROR",
] as const satisfies readonly HangupCause[];

const RETRYABLE_SET = new Set<string>(RETRYABLE_HANGUP_CAUSES);

export function isRetryableCause(cause: HangupCause): boolean {
	return RETRYABLE_SET.has(cause);
}

/**
 * Causes that are only reachable once a leg has been answered — the media path existed, so the
 * leg is billable even if `answered_at` was lost.
 *
 * This is a reconciliation heuristic for incomplete records only. `call_legs.disposition` and
 * `answered_at` remain authoritative for billing; the engine sets both.
 */
export const ANSWERED_HANGUP_CAUSES = [
	"NORMAL_CLEARING",
	"BLIND_TRANSFER",
	"ATTENDED_TRANSFER",
	"ALLOTTED_TIMEOUT",
	"MEDIA_TIMEOUT",
	"PICKED_OFF",
] as const satisfies readonly HangupCause[];

const ANSWERED_SET = new Set<string>(ANSWERED_HANGUP_CAUSES);

export function isAnsweredCause(cause: HangupCause): boolean {
	return ANSWERED_SET.has(cause);
}
