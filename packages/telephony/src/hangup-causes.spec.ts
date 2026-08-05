import { describe, expect, it } from "bun:test";
import {
	ANSWERED_HANGUP_CAUSES,
	EXTENDED_HANGUP_CAUSES,
	HANGUP_CAUSE_CODES,
	HANGUP_CAUSE_NAMES,
	HANGUP_CAUSES,
	hangupCauseCode,
	hangupCauseFromCode,
	isAnsweredCause,
	isHangupCause,
	isRetryableCause,
	Q850_HANGUP_CAUSES,
	RETRYABLE_HANGUP_CAUSES,
} from "./hangup-causes";

/**
 * The taxonomy is a stored value domain and a routing key: renaming a member rewrites the meaning
 * of every historical CDR row, and re-coding one silently changes outbound failover. These specs
 * pin `plans/reference/freeswitch-capabilities.md` §6 so that never happens by accident.
 *
 * They live here, next to the canonical definition, and travel with it — `@optimiq-voice/cdr-db`
 * re-exports the module rather than keeping a parallel copy.
 */
describe("hangup-cause taxonomy", () => {
	it("is the Q.850 subset followed by the FreeSWITCH extensions, with no duplicates", () => {
		expect(HANGUP_CAUSES).toHaveLength(Q850_HANGUP_CAUSES.length + EXTENDED_HANGUP_CAUSES.length);
		expect(new Set(HANGUP_CAUSES).size).toBe(HANGUP_CAUSES.length);
		expect(HANGUP_CAUSES.slice(0, Q850_HANGUP_CAUSES.length)).toEqual([...Q850_HANGUP_CAUSES]);
	});

	it("names 50 Q.850 points (NONE plus the 49 a softswitch actually emits)", () => {
		expect(Q850_HANGUP_CAUSES).toHaveLength(50);
		expect(Q850_HANGUP_CAUSES[0]).toBe("NONE");
	});

	it("keeps every Q.850 code inside 0-127", () => {
		for (const cause of Q850_HANGUP_CAUSES) {
			const code = hangupCauseCode(cause);
			expect(code).toBeGreaterThanOrEqual(0);
			expect(code).toBeLessThanOrEqual(127);
		}
	});

	// Verbatim from plans/reference/freeswitch-capabilities.md §6. Do not "fix" these numbers.
	it.each([
		["ORIGINATOR_CANCEL", 487],
		["LOSE_RACE", 702],
		["BLIND_TRANSFER", 800],
		["ATTENDED_TRANSFER", 801],
		["ALLOTTED_TIMEOUT", 802],
		["USER_CHALLENGE", 803],
		["MEDIA_TIMEOUT", 804],
		["PICKED_OFF", 805],
		["USER_NOT_REGISTERED", 806],
		["PROGRESS_TIMEOUT", 807],
		["INVALID_GATEWAY", 808],
		["GATEWAY_DOWN", 809],
		["INVALID_URL", 810],
		["INVALID_PROFILE", 811],
		["NO_PICKUP", 812],
		["SRTP_READ_ERROR", 813],
	] as const)("codes the FreeSWITCH extension %s as %i", (cause, code) => {
		expect(hangupCauseCode(cause)).toBe(code);
		expect(EXTENDED_HANGUP_CAUSES).toContain(cause);
	});

	it.each([
		["NORMAL_CLEARING", 16],
		["USER_BUSY", 17],
		["NO_ANSWER", 19],
		["CALL_REJECTED", 21],
		["NORMAL_UNSPECIFIED", 31],
		["NORMAL_CIRCUIT_CONGESTION", 34],
		["RECOVERY_ON_TIMER_EXPIRE", 102],
		["INTERWORKING", 127],
	] as const)("codes the Q.850 cause %s as %i", (cause, code) => {
		expect(hangupCauseCode(cause)).toBe(code);
	});

	it("gives every cause a code, and every code exactly one cause", () => {
		const codes = HANGUP_CAUSES.map(hangupCauseCode);
		expect(codes).toHaveLength(HANGUP_CAUSES.length);
		expect(new Set(codes).size).toBe(codes.length);
		expect(Object.keys(HANGUP_CAUSE_CODES).sort()).toEqual([...HANGUP_CAUSES].sort());
	});

	it("round-trips name -> code -> name for every cause", () => {
		for (const cause of HANGUP_CAUSES) {
			expect(hangupCauseFromCode(hangupCauseCode(cause))).toBe(cause);
		}
		expect(Object.keys(HANGUP_CAUSE_NAMES)).toHaveLength(HANGUP_CAUSES.length);
	});

	it("returns undefined for an unnamed Q.850 point so callers keep the raw code", () => {
		expect(hangupCauseFromCode(5)).toBeUndefined();
		expect(hangupCauseFromCode(9999)).toBeUndefined();
	});

	it("guards values arriving from the wire", () => {
		expect(isHangupCause("LOSE_RACE")).toBe(true);
		expect(isHangupCause("lose_race")).toBe(false);
		expect(isHangupCause("NOT_A_CAUSE")).toBe(false);
	});
});

describe("hangup-cause helpers", () => {
	it("treats transport, congestion, gateway and timeout failures as retryable", () => {
		for (const cause of RETRYABLE_HANGUP_CAUSES) {
			expect(isRetryableCause(cause)).toBe(true);
		}
	});

	// Retrying any of these is how toll-fraud loops and duplicate billing start.
	it.each([
		"NORMAL_CLEARING",
		"USER_BUSY",
		"NO_ANSWER",
		"CALL_REJECTED",
		"UNALLOCATED_NUMBER",
		"ORIGINATOR_CANCEL",
		"LOSE_RACE",
		"OUTGOING_CALL_BARRED",
	] as const)("never retries %s", (cause) => {
		expect(isRetryableCause(cause)).toBe(false);
	});

	it("only calls a cause answered when it is unreachable before answer", () => {
		for (const cause of ANSWERED_HANGUP_CAUSES) {
			expect(isAnsweredCause(cause)).toBe(true);
		}
		expect(isAnsweredCause("NORMAL_CLEARING")).toBe(true);
		expect(isAnsweredCause("LOSE_RACE")).toBe(false);
		expect(isAnsweredCause("NO_ANSWER")).toBe(false);
		expect(isAnsweredCause("USER_BUSY")).toBe(false);
		expect(isAnsweredCause("PROGRESS_TIMEOUT")).toBe(false);
	});

	it("keeps the retryable and answered sets disjoint apart from MEDIA_TIMEOUT", () => {
		const overlap = RETRYABLE_HANGUP_CAUSES.filter((cause) => isAnsweredCause(cause));
		expect(overlap).toEqual(["MEDIA_TIMEOUT"]);
	});

	it("only lists causes that exist in the taxonomy", () => {
		for (const cause of [...RETRYABLE_HANGUP_CAUSES, ...ANSWERED_HANGUP_CAUSES]) {
			expect(isHangupCause(cause)).toBe(true);
		}
	});
});
