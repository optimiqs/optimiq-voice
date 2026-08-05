import { describe, expect, it } from "bun:test";
import {
	DEFAULT_DTMF_DURATION_MS,
	DTMF_COLLECTION_END_REASONS,
	DTMF_DIGITS,
	DTMF_SOURCES,
	formatDtmfDigits,
	isDtmfDigit,
	parseDtmfDigits,
} from "./dtmf";

/** Pinned against `plans/reference/freeswitch-capabilities.md` §4. */
describe("DTMF vocabulary", () => {
	it("accepts all sixteen symbols, including the A-D tones PRI gateways send", () => {
		expect(DTMF_DIGITS).toHaveLength(16);
		expect(new Set(DTMF_DIGITS).size).toBe(DTMF_DIGITS.length);
		for (const digit of ["*", "#", "A", "D", "0", "9"] as const) {
			expect(DTMF_DIGITS).toContain(digit);
		}
	});

	it("covers the four documented sources", () => {
		expect([...DTMF_SOURCES].sort()).toEqual(["application", "inband", "info", "rfc2833"]);
	});

	it("distinguishes every way a collection can end", () => {
		expect(new Set(DTMF_COLLECTION_END_REASONS).size).toBe(DTMF_COLLECTION_END_REASONS.length);
		for (const reason of ["max-digits", "terminator", "timeout", "inter-digit-timeout"] as const) {
			expect(DTMF_COLLECTION_END_REASONS).toContain(reason);
		}
	});

	it("uses a sane default tone duration", () => {
		expect(DEFAULT_DTMF_DURATION_MS).toBeGreaterThan(0);
	});

	it("guards single characters arriving from a media adapter", () => {
		expect(isDtmfDigit("5")).toBe(true);
		expect(isDtmfDigit("#")).toBe(true);
		expect(isDtmfDigit("a")).toBe(false);
		expect(isDtmfDigit("12")).toBe(false);
		expect(isDtmfDigit("")).toBe(false);
	});
});

describe("parseDtmfDigits", () => {
	it("splits a feature code into typed digits", () => {
		expect(parseDtmfDigits("*98#")).toEqual(["*", "9", "8", "#"]);
	});

	it("normalises the lower-case A-D some gateways send", () => {
		expect(parseDtmfDigits("a1d")).toEqual(["A", "1", "D"]);
	});

	it("returns an empty sequence for empty input", () => {
		expect(parseDtmfDigits("")).toEqual([]);
	});

	// A partial parse would silently collect the wrong extension, so the whole string is rejected.
	it("rejects the whole string when any character is not a DTMF symbol", () => {
		expect(parseDtmfDigits("12x4")).toBeUndefined();
		expect(parseDtmfDigits("1 2")).toBeUndefined();
		expect(parseDtmfDigits("+15551234567")).toBeUndefined();
	});

	it("round-trips through formatDtmfDigits", () => {
		const digits = parseDtmfDigits("*8");
		expect(digits).toBeDefined();
		expect(formatDtmfDigits(digits ?? [])).toBe("*8");
	});
});
