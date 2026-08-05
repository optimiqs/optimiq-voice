import { describe, expect, it } from "bun:test";
import {
	DEFAULT_FEATURE_CODES,
	FEATURE_CODE_ARGUMENT_MODE,
	featureCodeIssues,
	isWellFormedFeatureCode,
	matchFeatureCode,
} from "./feature-codes";
import { FEATURE_CODE_ACTIONS } from "./snapshot";
import type { CompiledFeatureCode } from "./feature-codes";

function code(
	value: string,
	action: CompiledFeatureCode["action"],
	overrides: Partial<CompiledFeatureCode> = {},
): CompiledFeatureCode {
	return {
		id: `fc-${value}`,
		code: value,
		action,
		argumentMode: FEATURE_CODE_ARGUMENT_MODE[action],
		nodeId: `feature-code:fc-${value}`,
		...overrides,
	};
}

/** The table is matched longest-code-first; `compile.ts` guarantees the order, so specs must too. */
function table(...codes: readonly CompiledFeatureCode[]): readonly CompiledFeatureCode[] {
	return [...codes].sort(
		(left, right) => right.code.length - left.code.length || left.code.localeCompare(right.code),
	);
}

describe("argument modes", () => {
	it("assigns a mode to every action in the pbx-db catalogue", () => {
		for (const action of FEATURE_CODE_ACTIONS) {
			expect(FEATURE_CODE_ARGUMENT_MODE[action]).toBeDefined();
		}
	});

	it("requires an argument for directed pickup", () => {
		expect(FEATURE_CODE_ARGUMENT_MODE["call-pickup"]).toBe("required");
	});

	it("takes no argument for checking your own mailbox", () => {
		expect(FEATURE_CODE_ARGUMENT_MODE["voicemail-check"]).toBe("none");
	});

	it("makes forwarding optional so the same code both sets and clears it", () => {
		expect(FEATURE_CODE_ARGUMENT_MODE["call-forward-all"]).toBe("optional");
	});
});

describe("default catalogue", () => {
	it("seeds every code in a dialable form", () => {
		for (const entry of DEFAULT_FEATURE_CODES) {
			expect(isWellFormedFeatureCode(entry.code)).toBe(true);
		}
	});

	it("has no duplicate codes", () => {
		const codes = DEFAULT_FEATURE_CODES.map((entry) => entry.code);
		expect(new Set(codes).size).toBe(codes.length);
	});

	it("compiles without conflicts", () => {
		expect(featureCodeIssues(DEFAULT_FEATURE_CODES)).toEqual([]);
	});

	it("keeps the vanilla voicemail code", () => {
		expect(DEFAULT_FEATURE_CODES.find((entry) => entry.action === "voicemail-check")?.code).toBe(
			"*97",
		);
	});

	it("keeps the vanilla group-pickup code", () => {
		expect(DEFAULT_FEATURE_CODES.find((entry) => entry.action === "group-pickup")?.code).toBe("*8");
	});

	it("labels every entry, because the admin UI renders the list", () => {
		for (const entry of DEFAULT_FEATURE_CODES) {
			expect(entry.label.length).toBeGreaterThan(0);
		}
	});
});

describe("isWellFormedFeatureCode", () => {
	it("accepts a star code", () => {
		expect(isWellFormedFeatureCode("*97")).toBe(true);
	});

	it("accepts a hash code", () => {
		expect(isWellFormedFeatureCode("#9")).toBe(true);
	});

	it("accepts a double star", () => {
		expect(isWellFormedFeatureCode("**")).toBe(true);
	});

	it("rejects a bare number, which would collide with an extension range", () => {
		expect(isWellFormedFeatureCode("4000")).toBe(false);
	});

	it("rejects letters", () => {
		expect(isWellFormedFeatureCode("*vm")).toBe(false);
	});

	it("rejects an empty string", () => {
		expect(isWellFormedFeatureCode("")).toBe(false);
	});
});

describe("featureCodeIssues", () => {
	it("passes a clean catalogue", () => {
		expect(
			featureCodeIssues([
				{ code: "*97", action: "voicemail-check" },
				{ code: "*8", action: "group-pickup" },
			]),
		).toEqual([]);
	});

	it("reports a malformed code", () => {
		expect(featureCodeIssues([{ code: "97", action: "voicemail-check" }])).toEqual([
			{ code: "malformed-code", value: "97" },
		]);
	});

	it("reports a duplicate", () => {
		expect(
			featureCodeIssues([
				{ code: "*97", action: "voicemail-check" },
				{ code: "*97", action: "redial" },
			]),
		).toEqual([{ code: "duplicate-code", value: "*97" }]);
	});

	it("reports a prefix collision when the shorter code takes an argument", () => {
		// `**` is directed pickup and eats trailing digits, so `**2` could never be dialed.
		expect(
			featureCodeIssues([
				{ code: "**", action: "call-pickup" },
				{ code: "**2", action: "redial" },
			]),
		).toEqual([{ code: "prefix-collision", value: "**", other: "**2" }]);
	});

	it("allows a prefix relationship when the shorter code takes no argument", () => {
		// `*8` is dialed alone, so `*80` is unambiguous.
		expect(
			featureCodeIssues([
				{ code: "*8", action: "group-pickup" },
				{ code: "*80", action: "intercom" },
			]),
		).toEqual([]);
	});

	it("returns issues in a stable order regardless of input order", () => {
		const left = featureCodeIssues([
			{ code: "97", action: "redial" },
			{ code: "98", action: "redial" },
		]);
		const right = featureCodeIssues([
			{ code: "98", action: "redial" },
			{ code: "97", action: "redial" },
		]);
		expect(left).toEqual(right);
	});
});

describe("matchFeatureCode", () => {
	const codes = table(
		code("*97", "voicemail-check"),
		code("*8", "group-pickup"),
		code("*80", "intercom"),
		code("**", "call-pickup"),
		code("*72", "call-forward-all"),
	);

	it("matches an argument-free code exactly", () => {
		expect(matchFeatureCode(codes, "*97")?.featureCode.code).toBe("*97");
	});

	it("returns an empty argument for an exact match", () => {
		expect(matchFeatureCode(codes, "*97")?.argument).toBe("");
	});

	it("does not match an argument-free code with trailing digits", () => {
		expect(matchFeatureCode(codes, "*971")).toBeNull();
	});

	it("captures the argument of a required-argument code", () => {
		expect(matchFeatureCode(codes, "**1001")).toMatchObject({ argument: "1001" });
	});

	it("refuses a required-argument code dialed alone", () => {
		expect(matchFeatureCode(codes, "**")).toBeNull();
	});

	it("matches an optional-argument code dialed alone", () => {
		expect(matchFeatureCode(codes, "*72")).toMatchObject({ argument: "" });
	});

	it("matches an optional-argument code with a target", () => {
		expect(matchFeatureCode(codes, "*725551212")).toMatchObject({ argument: "5551212" });
	});

	it("prefers the longer code when two could match", () => {
		// `*80` (intercom, takes an argument) must win over `*8` (group pickup, exact only).
		expect(matchFeatureCode(codes, "*801001")?.featureCode.code).toBe("*80");
	});

	it("still matches the shorter exact code", () => {
		expect(matchFeatureCode(codes, "*8")?.featureCode.code).toBe("*8");
	});

	it("returns null for something that is not a feature code", () => {
		expect(matchFeatureCode(codes, "1001")).toBeNull();
	});

	it("returns null against an empty table", () => {
		expect(matchFeatureCode([], "*97")).toBeNull();
	});
});
