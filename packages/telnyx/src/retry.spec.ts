import { describe, expect, it } from "bun:test";
import {
	backoffDelayMs,
	DEFAULT_RETRY_POLICY,
	isRetryableStatus,
	parseRateLimitResetMs,
	parseRetryAfterMs,
} from "./retry";

describe("isRetryableStatus", () => {
	it("retries 429 and 5xx", () => {
		expect(isRetryableStatus(429)).toBe(true);
		expect(isRetryableStatus(500)).toBe(true);
		expect(isRetryableStatus(502)).toBe(true);
		expect(isRetryableStatus(503)).toBe(true);
		expect(isRetryableStatus(504)).toBe(true);
	});

	/**
	 * The important half. A 422 from Telnyx is a statement about the request body; sending it again
	 * produces the same 422 and burns budget the ambiguous cases need. A 409 is idempotency-in-flight
	 * and a 404 is a resource that does not exist — neither improves with repetition.
	 */
	it("never retries a client error other than 429", () => {
		for (const status of [400, 401, 403, 404, 409, 422]) {
			expect(isRetryableStatus(status), `status ${status}`).toBe(false);
		}
	});
});

describe("backoffDelayMs", () => {
	it("doubles per attempt before jitter", () => {
		// random() === 1 makes full jitter select the whole exponential window, which is what makes
		// the doubling observable at all.
		const one = () => 1;
		expect(backoffDelayMs(DEFAULT_RETRY_POLICY, 0, undefined, one)).toBe(250);
		expect(backoffDelayMs(DEFAULT_RETRY_POLICY, 1, undefined, one)).toBe(500);
		expect(backoffDelayMs(DEFAULT_RETRY_POLICY, 2, undefined, one)).toBe(1000);
		expect(backoffDelayMs(DEFAULT_RETRY_POLICY, 3, undefined, one)).toBe(2000);
	});

	it("clamps at maxDelayMs however many attempts have passed", () => {
		expect(backoffDelayMs(DEFAULT_RETRY_POLICY, 20, undefined, () => 1)).toBe(
			DEFAULT_RETRY_POLICY.maxDelayMs,
		);
	});

	/**
	 * Full jitter means the delay is uniform over `[0, exponential]`. The property that matters is
	 * that it can be ZERO — a client that always waited at least the base delay would still retry
	 * in lockstep with every other client that got 429'd in the same millisecond.
	 */
	it("can select the whole window or none of it", () => {
		expect(backoffDelayMs(DEFAULT_RETRY_POLICY, 2, undefined, () => 0)).toBe(0);
		expect(backoffDelayMs(DEFAULT_RETRY_POLICY, 2, undefined, () => 1)).toBe(1000);
	});

	it("treats the carrier's hint as a floor, adding jitter on top of it", () => {
		// 2s hint + the whole 250ms first window.
		expect(backoffDelayMs(DEFAULT_RETRY_POLICY, 0, 2000, () => 1)).toBe(2250);
		// Even with zero jitter the floor is honoured.
		expect(backoffDelayMs(DEFAULT_RETRY_POLICY, 0, 2000, () => 0)).toBe(2000);
	});

	it("stays within [floor, floor + window] for any random draw", () => {
		for (let draw = 0; draw <= 10; draw += 1) {
			const delay = backoffDelayMs(DEFAULT_RETRY_POLICY, 1, 100, () => draw / 10);
			expect(delay).toBeGreaterThanOrEqual(100);
			expect(delay).toBeLessThanOrEqual(600);
		}
	});
});

describe("parseRetryAfterMs", () => {
	it("reads delta-seconds", () => {
		expect(parseRetryAfterMs("3")).toBe(3000);
		expect(parseRetryAfterMs(" 0 ")).toBe(0);
	});

	it("reads an HTTP-date relative to now", () => {
		const now = Date.parse("2026-08-06T00:00:00Z");
		expect(parseRetryAfterMs("Thu, 06 Aug 2026 00:00:05 GMT", now)).toBe(5000);
	});

	it("never returns a negative wait for a date already in the past", () => {
		const now = Date.parse("2026-08-06T00:01:00Z");
		expect(parseRetryAfterMs("Thu, 06 Aug 2026 00:00:00 GMT", now)).toBe(0);
	});

	it("returns undefined for an absent or unparseable header", () => {
		expect(parseRetryAfterMs(null)).toBeUndefined();
		expect(parseRetryAfterMs("")).toBeUndefined();
		expect(parseRetryAfterMs("soon")).toBeUndefined();
	});
});

describe("parseRateLimitResetMs", () => {
	/** Telnyx sends seconds-until-reset, and in practice it is a very small integer. */
	it("reads seconds until the window rolls over", () => {
		expect(parseRateLimitResetMs("1")).toBe(1000);
		expect(parseRateLimitResetMs("30")).toBe(30_000);
	});

	/**
	 * One Telnyx doc page prints a Unix epoch in this header's example. Reading that as seconds
	 * would compute a delay of roughly fifty-five years, so implausible values are rejected rather
	 * than used — the request degrades to plain backoff instead of hanging.
	 */
	it("rejects a value large enough to be a Unix epoch", () => {
		expect(parseRateLimitResetMs("1786000000")).toBeUndefined();
	});

	it("returns undefined for an absent or non-numeric header", () => {
		expect(parseRateLimitResetMs(null)).toBeUndefined();
		expect(parseRateLimitResetMs("2000, 2000;w=1")).toBeUndefined();
	});
});
