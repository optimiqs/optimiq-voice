import { describe, expect, it } from "bun:test";
import {
	applyDigitManipulation,
	clearPatternCache,
	compilePattern,
	InvalidPatternError,
	MAX_PATTERN_LENGTH,
	matchPattern,
	patternSpecificity,
	patternsOverlap,
	patternSubsumes,
	validateDigitManipulation,
} from "./patterns";

describe("compilePattern", () => {
	it("compiles an exact pattern", () => {
		expect(compilePattern("exact", "+15551230001").pattern).toEqual({
			kind: "exact",
			value: "+15551230001",
		});
	});

	it("compiles a prefix pattern", () => {
		expect(compilePattern("prefix", "+1555").pattern).toEqual({ kind: "prefix", value: "+1555" });
	});

	it("ignores the stored pattern for match kind 'any'", () => {
		expect(compilePattern("any", "whatever").pattern).toEqual({ kind: "any" });
	});

	it("reports an empty non-any pattern", () => {
		expect(compilePattern("exact", "").issues).toEqual([{ code: "empty-pattern" }]);
	});

	it("reports a null pattern as empty", () => {
		expect(compilePattern("prefix", null).issues).toEqual([{ code: "empty-pattern" }]);
	});

	it("reports an over-long pattern", () => {
		const long = "9".repeat(MAX_PATTERN_LENGTH + 1);
		expect(compilePattern("exact", long).issues).toContainEqual({
			code: "pattern-too-long",
			length: MAX_PATTERN_LENGTH + 1,
		});
	});

	it("reports an uncompilable regex", () => {
		const issues = compilePattern("regex", "^(unclosed");
		expect(issues.issues[0]?.code).toBe("invalid-regex");
	});

	it("warns about an unanchored regex", () => {
		expect(compilePattern("regex", "555").issues).toEqual([{ code: "unanchored-regex" }]);
	});

	it("accepts a start-anchored regex without warning", () => {
		expect(compilePattern("regex", "^\\+1555").issues).toEqual([]);
	});

	it("accepts an end-anchored regex without warning", () => {
		expect(compilePattern("regex", "555$").issues).toEqual([]);
	});
});

describe("matchPattern", () => {
	it("matches an exact pattern only on equality", () => {
		const { pattern } = compilePattern("exact", "1001");
		expect(matchPattern(pattern, "1001")).toEqual({ captures: [] });
		expect(matchPattern(pattern, "10011")).toBeNull();
	});

	it("matches a prefix pattern on any extension of it", () => {
		const { pattern } = compilePattern("prefix", "+1555");
		expect(matchPattern(pattern, "+15551230001")).toEqual({ captures: [] });
		expect(matchPattern(pattern, "+44201")).toBeNull();
	});

	it("matches an empty prefix against everything", () => {
		expect(matchPattern({ kind: "prefix", value: "" }, "anything")).toEqual({ captures: [] });
	});

	it("matches 'any' against everything, including the empty string", () => {
		expect(matchPattern({ kind: "any" }, "")).toEqual({ captures: [] });
	});

	it("returns regex capture groups in order", () => {
		const { pattern } = compilePattern("regex", "^\\+1(\\d{3})(\\d{7})$");
		expect(matchPattern(pattern, "+15551230001")).toEqual({ captures: ["555", "1230001"] });
	});

	it("renders an unmatched optional group as an empty capture", () => {
		const { pattern } = compilePattern("regex", "^(a)?(b)$");
		expect(matchPattern(pattern, "b")).toEqual({ captures: ["", "b"] });
	});

	it("does not anchor a regex on the author's behalf", () => {
		const { pattern } = compilePattern("regex", "555");
		expect(matchPattern(pattern, "+19005551212")).not.toBeNull();
	});

	it("is case sensitive, because no flags are applied", () => {
		const { pattern } = compilePattern("regex", "^abc$");
		expect(matchPattern(pattern, "ABC")).toBeNull();
	});

	it("throws when handed a regex that never compiled", () => {
		clearPatternCache();
		expect(() => matchPattern({ kind: "regex", source: "^(" }, "x")).toThrow(InvalidPatternError);
	});

	it("reuses a compiled regex across calls", () => {
		clearPatternCache();
		const pattern = { kind: "regex", source: "^\\d+$" } as const;
		expect(matchPattern(pattern, "123")).not.toBeNull();
		expect(matchPattern(pattern, "456")).not.toBeNull();
	});
});

describe("patternSpecificity", () => {
	it("ranks exact above every prefix", () => {
		expect(patternSpecificity({ kind: "exact", value: "1" })).toBeGreaterThan(
			patternSpecificity({ kind: "prefix", value: "9".repeat(MAX_PATTERN_LENGTH) }),
		);
	});

	it("ranks a longer prefix above a shorter one", () => {
		expect(patternSpecificity({ kind: "prefix", value: "+1555" })).toBeGreaterThan(
			patternSpecificity({ kind: "prefix", value: "+1" }),
		);
	});

	it("ranks every prefix above a regex", () => {
		expect(patternSpecificity({ kind: "prefix", value: "" })).toBeGreaterThan(
			patternSpecificity({ kind: "regex", source: "^\\+1\\d{10}$" }),
		);
	});

	it("ranks a regex above 'any'", () => {
		expect(patternSpecificity({ kind: "regex", source: "x" })).toBeGreaterThan(
			patternSpecificity({ kind: "any" }),
		);
	});

	it("caps a prefix's contribution at the pattern-length bound", () => {
		const capped = patternSpecificity({
			kind: "prefix",
			value: "9".repeat(MAX_PATTERN_LENGTH + 50),
		});
		expect(capped).toBe(1_000 + MAX_PATTERN_LENGTH);
	});

	it("sorts a mixed table most-specific-first", () => {
		const patterns = [
			{ kind: "any" },
			{ kind: "regex", source: "^x$" },
			{ kind: "prefix", value: "+1" },
			{ kind: "prefix", value: "+1555" },
			{ kind: "exact", value: "+15551230001" },
		] as const;
		const sorted = [...patterns].sort((a, b) => patternSpecificity(b) - patternSpecificity(a));
		expect(sorted.map((entry) => entry.kind)).toEqual([
			"exact",
			"prefix",
			"prefix",
			"regex",
			"any",
		]);
	});
});

describe("patternSubsumes", () => {
	it("says 'any' subsumes everything", () => {
		expect(patternSubsumes({ kind: "any" }, { kind: "exact", value: "1" })).toBe(true);
	});

	it("says nothing but 'any' subsumes 'any'", () => {
		expect(patternSubsumes({ kind: "prefix", value: "" }, { kind: "any" })).toBe(false);
	});

	it("says a shorter prefix subsumes a longer one", () => {
		expect(
			patternSubsumes({ kind: "prefix", value: "+1" }, { kind: "prefix", value: "+1555" }),
		).toBe(true);
	});

	it("says a prefix subsumes an exact value that starts with it", () => {
		expect(
			patternSubsumes({ kind: "prefix", value: "+1555" }, { kind: "exact", value: "+15551230001" }),
		).toBe(true);
	});

	it("says an exact value subsumes only itself", () => {
		expect(patternSubsumes({ kind: "exact", value: "1" }, { kind: "exact", value: "1" })).toBe(
			true,
		);
		expect(patternSubsumes({ kind: "exact", value: "1" }, { kind: "prefix", value: "1" })).toBe(
			false,
		);
	});

	it("is conservative about regexes, claiming only identity", () => {
		expect(
			patternSubsumes({ kind: "regex", source: "^\\d+$" }, { kind: "regex", source: "^\\d+$" }),
		).toBe(true);
		expect(
			patternSubsumes({ kind: "regex", source: "^\\d+$" }, { kind: "regex", source: "^\\d{3}$" }),
		).toBe(false);
	});
});

describe("patternsOverlap", () => {
	it("finds overlap with 'any' on either side", () => {
		expect(patternsOverlap({ kind: "any" }, { kind: "exact", value: "1" })).toBe(true);
		expect(patternsOverlap({ kind: "exact", value: "1" }, { kind: "any" })).toBe(true);
	});

	it("finds overlap between nested prefixes", () => {
		expect(
			patternsOverlap({ kind: "prefix", value: "+1" }, { kind: "prefix", value: "+1555" }),
		).toBe(true);
	});

	it("finds no overlap between disjoint prefixes", () => {
		expect(patternsOverlap({ kind: "prefix", value: "+1" }, { kind: "prefix", value: "+44" })).toBe(
			false,
		);
	});

	it("finds overlap between an exact value and a covering prefix", () => {
		expect(
			patternsOverlap({ kind: "exact", value: "+15551230001" }, { kind: "prefix", value: "+1555" }),
		).toBe(true);
	});

	it("claims only identity for regexes", () => {
		expect(
			patternsOverlap({ kind: "regex", source: "^a$" }, { kind: "regex", source: "^b$" }),
		).toBe(false);
		expect(patternsOverlap({ kind: "regex", source: "^a$" }, { kind: "exact", value: "a" })).toBe(
			false,
		);
	});
});

describe("validateDigitManipulation", () => {
	it("accepts a plain strip-and-prepend", () => {
		expect(validateDigitManipulation({ stripDigits: 1, prependDigits: "+1" })).toEqual([]);
	});

	it("accepts no manipulation at all", () => {
		expect(validateDigitManipulation({ stripDigits: 0, prependDigits: null })).toEqual([]);
	});

	it("rejects a negative strip", () => {
		expect(validateDigitManipulation({ stripDigits: -1, prependDigits: null })).toEqual([
			{ code: "negative-strip" },
		]);
	});

	it("rejects a non-integer strip", () => {
		expect(validateDigitManipulation({ stripDigits: 1.5, prependDigits: null })).toEqual([
			{ code: "negative-strip" },
		]);
	});

	it("rejects an absurd strip", () => {
		expect(validateDigitManipulation({ stripDigits: 999, prependDigits: null })).toEqual([
			{ code: "strip-too-large", strip: 999 },
		]);
	});

	it("rejects a prepend that is not dialable", () => {
		// Letters here would let a route inject SIP URI syntax into a dial string.
		expect(validateDigitManipulation({ stripDigits: 0, prependDigits: "sip:evil@" })).toEqual([
			{ code: "invalid-prepend", value: "sip:evil@" },
		]);
	});

	it("accepts star and hash in a prepend", () => {
		expect(validateDigitManipulation({ stripDigits: 0, prependDigits: "*72#" })).toEqual([]);
	});
});

describe("applyDigitManipulation", () => {
	it("passes a number through untouched when nothing is configured", () => {
		expect(applyDigitManipulation({ stripDigits: 0, prependDigits: null }, "5551212")).toBe(
			"5551212",
		);
	});

	it("strips leading digits", () => {
		expect(applyDigitManipulation({ stripDigits: 1, prependDigits: null }, "95551212")).toBe(
			"5551212",
		);
	});

	it("prepends after stripping", () => {
		expect(applyDigitManipulation({ stripDigits: 1, prependDigits: "+1" }, "95551212")).toBe(
			"+15551212",
		);
	});

	it("returns null when the strip would consume the whole number", () => {
		expect(applyDigitManipulation({ stripDigits: 8, prependDigits: null }, "5551212")).toBeNull();
	});

	it("returns null when strip empties the number and there is nothing to prepend", () => {
		expect(applyDigitManipulation({ stripDigits: 3, prependDigits: null }, "123")).toBeNull();
	});

	it("keeps a prepend-only result when the strip empties the number", () => {
		expect(applyDigitManipulation({ stripDigits: 3, prependDigits: "911" }, "123")).toBe("911");
	});
});
