import { describe, expect, it } from "bun:test";
import { RANGE_PRESET_LABELS, RANGE_PRESETS, resolveRange, toLocalInputValue } from "./time-range";

const NOW = new Date("2026-08-05T12:00:00.000Z");

describe("resolveRange", () => {
	it("resolves each preset relative to now", () => {
		expect(resolveRange("24h", { from: "", to: "" }, NOW)).toEqual({
			from: "2026-08-04T12:00:00.000Z",
			to: "2026-08-05T12:00:00.000Z",
		});
		expect(resolveRange("7d", { from: "", to: "" }, NOW).from).toBe("2026-07-29T12:00:00.000Z");
		expect(resolveRange("30d", { from: "", to: "" }, NOW).from).toBe("2026-07-06T12:00:00.000Z");
	});

	it("sends nothing at all for a half-filled custom range", () => {
		// The server defaults an absent range; a half-range would be either a parse failure or a
		// silently-defaulted other end, and neither is what a user mid-keystroke meant.
		expect(resolveRange("custom", { from: "2026-08-01T00:00", to: "" }, NOW)).toEqual({
			from: undefined,
			to: undefined,
		});
		expect(resolveRange("custom", { from: "", to: "" }, NOW).from).toBe(undefined);
	});

	it("sends nothing for a custom range that is not readable as dates", () => {
		expect(resolveRange("custom", { from: "yesterday", to: "today" }, NOW).from).toBe(undefined);
	});

	it("resolves a complete custom range to instants", () => {
		const resolved = resolveRange(
			"custom",
			{ from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" },
			NOW,
		);

		expect(resolved.from).toBe("2026-08-01T00:00:00.000Z");
		expect(resolved.to).toBe("2026-08-02T00:00:00.000Z");
	});

	it("names every preset it offers", () => {
		for (const preset of RANGE_PRESETS) {
			expect(RANGE_PRESET_LABELS[preset].length).toBeGreaterThan(0);
		}
	});
});

describe("toLocalInputValue", () => {
	it("produces the shape a datetime-local input round trips", () => {
		expect(toLocalInputValue(new Date(2026, 7, 5, 9, 4))).toBe("2026-08-05T09:04");
	});
});
