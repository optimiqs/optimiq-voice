import { describe, expect, it } from "bun:test";
import { computeBackoffDelayMs, DEFAULT_BACKOFF } from "./backoff";

const NO_JITTER = () => 0;
const FULL_JITTER = () => 0.999_999;

describe("computeBackoffDelayMs", () => {
	it("grows exponentially from the base", () => {
		expect(computeBackoffDelayMs(1, DEFAULT_BACKOFF, NO_JITTER)).toBe(250);
		expect(computeBackoffDelayMs(2, DEFAULT_BACKOFF, NO_JITTER)).toBe(500);
		expect(computeBackoffDelayMs(3, DEFAULT_BACKOFF, NO_JITTER)).toBe(1_000);
		expect(computeBackoffDelayMs(4, DEFAULT_BACKOFF, NO_JITTER)).toBe(2_000);
	});

	it("never exceeds maxMs, no matter how many attempts accumulate", () => {
		for (const attempt of [10, 20, 50, 100]) {
			expect(computeBackoffDelayMs(attempt, DEFAULT_BACKOFF, NO_JITTER)).toBeLessThanOrEqual(
				DEFAULT_BACKOFF.maxMs,
			);
		}
	});

	it("subtracts jitter so the delay is always within the cap", () => {
		const delay = computeBackoffDelayMs(20, DEFAULT_BACKOFF, FULL_JITTER);
		expect(delay).toBeLessThan(DEFAULT_BACKOFF.maxMs);
		expect(delay).toBeGreaterThanOrEqual(DEFAULT_BACKOFF.maxMs * (1 - DEFAULT_BACKOFF.jitter) - 1);
	});

	it("spreads a thundering herd across half the window by default", () => {
		const low = computeBackoffDelayMs(10, DEFAULT_BACKOFF, FULL_JITTER);
		const high = computeBackoffDelayMs(10, DEFAULT_BACKOFF, NO_JITTER);
		expect(high - low).toBeGreaterThan(DEFAULT_BACKOFF.maxMs * 0.49);
	});

	it("is deterministic with a fixed random source", () => {
		const fixed = () => 0.25;
		expect(computeBackoffDelayMs(3, DEFAULT_BACKOFF, fixed)).toBe(
			computeBackoffDelayMs(3, DEFAULT_BACKOFF, fixed),
		);
	});

	it("rejects a non-positive attempt", () => {
		expect(() => computeBackoffDelayMs(0)).toThrow(RangeError);
		expect(() => computeBackoffDelayMs(1.5)).toThrow(RangeError);
	});
});
