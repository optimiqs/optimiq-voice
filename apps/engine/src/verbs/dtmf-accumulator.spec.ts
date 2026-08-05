import { describe, expect, it } from "bun:test";
import { DtmfAccumulator } from "./dtmf-accumulator";

const FOUR_DIGITS = { maxDigits: 4, terminators: ["#"] as const, regex: undefined };

describe("DtmfAccumulator", () => {
	it("collects up to maxDigits", () => {
		const accumulator = new DtmfAccumulator(FOUR_DIGITS);
		expect(accumulator.push("1").done).toBe(false);
		expect(accumulator.push("2").done).toBe(false);
		expect(accumulator.push("3").done).toBe(false);
		const last = accumulator.push("4");
		expect(last.done).toBe(true);
		expect(last.done && last.collection).toEqual({
			digits: ["1", "2", "3", "4"],
			endReason: "max-digits",
		});
	});

	it("ends on a terminator and excludes it from the digits", () => {
		const accumulator = new DtmfAccumulator(FOUR_DIGITS);
		accumulator.push("1");
		accumulator.push("2");
		const step = accumulator.push("#");
		expect(step.done && step.collection).toEqual({
			digits: ["1", "2"],
			endReason: "terminator",
			terminator: "#",
		});
	});

	it("distinguishes 'pressed nothing' from 'pressed # immediately'", () => {
		const silent = new DtmfAccumulator(FOUR_DIGITS);
		expect(silent.timeout()).toEqual({ digits: [], endReason: "timeout" });

		const immediate = new DtmfAccumulator(FOUR_DIGITS);
		const step = immediate.push("#");
		expect(step.done && step.collection.endReason).toBe("terminator");
		expect(step.done && step.collection.digits).toEqual([]);
	});

	it("reports a gap after the first digit as an inter-digit timeout, not an overall one", () => {
		const accumulator = new DtmfAccumulator(FOUR_DIGITS);
		accumulator.push("1");
		expect(accumulator.timeout()).toEqual({ digits: ["1"], endReason: "inter-digit-timeout" });
	});

	it("ends early on a pattern match, which is how variable-length input works", () => {
		const accumulator = new DtmfAccumulator({
			maxDigits: 4,
			terminators: [],
			regex: "\\d{3}",
		});
		accumulator.push("1");
		accumulator.push("0");
		const step = accumulator.push("1");
		expect(step.done && step.collection).toEqual({ digits: ["1", "0", "1"], endReason: "pattern" });
	});

	it("anchors the pattern so a partial match cannot end collection early", () => {
		const accumulator = new DtmfAccumulator({
			maxDigits: 6,
			terminators: [],
			regex: "\\d{4}",
		});
		accumulator.push("1");
		accumulator.push("2");
		accumulator.push("3");
		// Unanchored, `\d{4}` would already be searching; anchored, three digits cannot match four.
		expect(accumulator.isDone).toBe(false);
		expect(accumulator.push("4").done).toBe(true);
	});

	it("ignores an invalid pattern rather than failing every call to the IVR", () => {
		const accumulator = new DtmfAccumulator({
			maxDigits: 2,
			terminators: [],
			regex: "([unclosed",
		});
		accumulator.push("1");
		expect(accumulator.push("2").done).toBe(true);
	});

	it("normalises lower-case A-D, which several gateways send", () => {
		const accumulator = new DtmfAccumulator({ maxDigits: 1, terminators: [], regex: undefined });
		const step = accumulator.push("a");
		expect(step.done && step.collection.digits).toEqual(["A"]);
	});

	it("ignores a character that is not a DTMF symbol", () => {
		const accumulator = new DtmfAccumulator(FOUR_DIGITS);
		expect(accumulator.push("X").done).toBe(false);
		expect(accumulator.collected).toEqual([]);
	});

	it("is idempotent once finished", () => {
		const accumulator = new DtmfAccumulator({ maxDigits: 1, terminators: [], regex: undefined });
		const first = accumulator.push("5");
		const second = accumulator.push("6");
		expect(first.done).toBe(true);
		expect(second.done).toBe(true);
		expect(second.done ? second.collection : undefined).toEqual(
			first.done ? first.collection : { digits: [], endReason: "cancelled" },
		);
		expect(accumulator.collected).toEqual(["5"]);
		// A cancel after the fact cannot rewrite the reason the collection actually ended.
		expect(accumulator.cancel().endReason).toBe("max-digits");
	});

	it("carries the reason a collection was abandoned", () => {
		expect(new DtmfAccumulator(FOUR_DIGITS).cancel().endReason).toBe("cancelled");
		expect(new DtmfAccumulator(FOUR_DIGITS).hangup().endReason).toBe("hangup");
		expect(new DtmfAccumulator(FOUR_DIGITS).interDigitTimeout().endReason).toBe(
			"inter-digit-timeout",
		);
	});
});
