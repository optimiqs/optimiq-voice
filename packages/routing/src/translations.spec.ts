import { describe, expect, it } from "bun:test";
import {
	applyTranslationRuleset,
	clearTranslationCache,
	isSafeReplacement,
	MAX_TRANSLATED_LENGTH,
	validateTranslationRule,
} from "./translations";
import type { CompiledTranslationRuleset } from "./translations";

/**
 * Number-translation rulesets.
 *
 * The two things worth testing here are the two things that are not obvious from the type: that the
 * pipeline composes (every matching rule fires, each seeing the last one's output) and that the
 * replacement allow-list is a SECURITY boundary rather than formatting — a route that could emit an
 * `@` into a request URI is a route that can send a call to somebody else's host.
 */

function ruleset(
	rules: readonly { id: string; source: string; replacement: string }[],
): CompiledTranslationRuleset {
	return {
		id: "tr-1",
		name: "E.164",
		rules: rules.map((rule, index) => ({ ...rule, ordinal: index + 1 })),
	};
}

describe("validateTranslationRule", () => {
	it("accepts a regex with capture groups and a dialable replacement", () => {
		expect(validateTranslationRule({ matchPattern: "^00(\\d+)$", replacement: "+$1" })).toEqual([]);
	});

	it("accepts an empty replacement, because that is how a strip rule is written", () => {
		expect(validateTranslationRule({ matchPattern: "^9", replacement: "" })).toEqual([]);
	});

	it("refuses a regex that does not compile", () => {
		const issues = validateTranslationRule({ matchPattern: "^(unclosed", replacement: "$1" });
		expect(issues.map((issue) => issue.code)).toContain("invalid-regex");
	});

	it("refuses an empty pattern", () => {
		expect(validateTranslationRule({ matchPattern: "", replacement: "1" })[0]?.code).toBe(
			"empty-pattern",
		);
	});

	/**
	 * THE assertion in this file. `$1@evil.example` passes any test that only asks "does it use a
	 * capture group", and it is a request URI pointing at somebody else's host.
	 */
	it("refuses a replacement that could inject SIP syntax", () => {
		for (const replacement of ["$1@evil.example", "1;transport=tcp", "sip:$1", "1 2", "$1\n"]) {
			const issues = validateTranslationRule({ matchPattern: "^(.+)$", replacement });
			expect(
				issues.map((issue) => issue.code),
				replacement,
			).toContain("unsafe-replacement");
		}
	});

	it("allows every character a dial string may actually contain", () => {
		expect(isSafeReplacement("+1$1*#0")).toBe(true);
		expect(isSafeReplacement("$$1")).toBe(true);
	});
});

describe("applyTranslationRuleset", () => {
	it("returns the input untouched when nothing matches", () => {
		const outcome = applyTranslationRuleset(
			ruleset([{ id: "r1", source: "^00", replacement: "+" }]),
			"+15551234567",
		);
		expect(outcome.value).toBe("+15551234567");
		expect(outcome.applied).toEqual([]);
	});

	/**
	 * A pipeline, not a first-match table. "Strip the international prefix" and "add the plus" are
	 * two steps of one normalisation, and a first-match reading would run only the first.
	 */
	it("runs every matching rule in order, each seeing the last one's output", () => {
		const outcome = applyTranslationRuleset(
			ruleset([
				{ id: "strip-9", source: "^9", replacement: "" },
				{ id: "intl", source: "^00(\\d+)$", replacement: "+$1" },
			]),
			"90044201234567",
		);
		expect(outcome.value).toBe("+44201234567");
		expect(outcome.applied).toEqual(["strip-9", "intl"]);
	});

	/**
	 * Only the FIRST occurrence, because a dial string is one number: a rule meant to strip a leading
	 * `00` that also stripped a `00` in the middle of a subscriber number would be invisible in the
	 * ruleset and wrong on the wire.
	 */
	it("replaces the first match only", () => {
		const outcome = applyTranslationRuleset(
			ruleset([{ id: "r1", source: "00", replacement: "" }]),
			"0012003456",
		);
		expect(outcome.value).toBe("12003456");
	});

	it("names only the rules that changed something", () => {
		const outcome = applyTranslationRuleset(
			ruleset([
				{ id: "noop", source: "^777", replacement: "8" },
				{ id: "real", source: "^00", replacement: "+" },
			]),
			"0044123",
		);
		expect(outcome.applied).toEqual(["real"]);
	});

	/** A pipeline of regexes can grow without bound; refusing beats dialing something enormous. */
	it("abandons the pipeline and returns the input when the result over-runs", () => {
		const outcome = applyTranslationRuleset(
			ruleset([{ id: "double", source: "^(.*)$", replacement: "$1$1$1$1$1$1$1$1" }]),
			"1".repeat(MAX_TRANSLATED_LENGTH / 4),
		);
		expect(outcome.overflowed).toBe(true);
		expect(outcome.value).toBe("1".repeat(MAX_TRANSLATED_LENGTH / 4));
		expect(outcome.applied).toEqual([]);
	});

	it("is stable across a cleared regex cache", () => {
		const rules = ruleset([{ id: "r1", source: "^00(\\d+)$", replacement: "+$1" }]);
		const first = applyTranslationRuleset(rules, "0044123").value;
		clearTranslationCache();
		expect(applyTranslationRuleset(rules, "0044123").value).toBe(first);
	});
});
