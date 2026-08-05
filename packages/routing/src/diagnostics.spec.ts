import { describe, expect, it } from "bun:test";
import {
	DIAGNOSTIC_CODES,
	DIAGNOSTIC_SEVERITIES,
	DiagnosticBag,
	formatDiagnostics,
	isDiagnosticCode,
} from "./diagnostics";

describe("diagnostic vocabulary", () => {
	it("offers exactly three severities", () => {
		expect([...DIAGNOSTIC_SEVERITIES]).toEqual(["error", "warning", "info"]);
	});

	it("has no duplicate codes", () => {
		expect(new Set(DIAGNOSTIC_CODES).size).toBe(DIAGNOSTIC_CODES.length);
	});

	it("recognises its own codes", () => {
		expect(isDiagnosticCode("dangling-destination")).toBe(true);
		expect(isDiagnosticCode("dangling_destination")).toBe(false);
	});

	it("names every code in kebab-case", () => {
		for (const code of DIAGNOSTIC_CODES) {
			expect(code).toMatch(/^[a-z][a-z0-9-]*$/);
		}
	});
});

describe("DiagnosticBag", () => {
	it("starts empty", () => {
		const bag = new DiagnosticBag();
		expect(bag.size).toBe(0);
		expect(bag.hasErrors()).toBe(false);
	});

	it("records severity with the entry", () => {
		const bag = new DiagnosticBag();
		bag.warning("empty-ring-group", "no members");
		expect(bag.all()[0]).toMatchObject({ severity: "warning", code: "empty-ring-group" });
	});

	it("reports errors", () => {
		const bag = new DiagnosticBag();
		bag.error("dangling-destination", "gone");
		expect(bag.hasErrors()).toBe(true);
	});

	it("does not treat warnings or info as errors", () => {
		const bag = new DiagnosticBag();
		bag.warning("ivr-cycle", "loop");
		bag.info("no-match", "nothing");
		expect(bag.hasErrors()).toBe(false);
	});

	it("preserves insertion order, which is compile order", () => {
		const bag = new DiagnosticBag();
		bag.info("no-match", "one");
		bag.error("invalid-regex", "two");
		bag.warning("ivr-cycle", "three");
		expect(bag.all().map((entry) => entry.message)).toEqual(["one", "two", "three"]);
	});

	it("filters by severity", () => {
		const bag = new DiagnosticBag();
		bag.error("invalid-regex", "a");
		bag.warning("ivr-cycle", "b");
		expect(bag.bySeverity("error")).toHaveLength(1);
		expect(bag.bySeverity("warning")).toHaveLength(1);
		expect(bag.bySeverity("info")).toHaveLength(0);
	});

	it("omits absent subject and path rather than storing undefined", () => {
		const bag = new DiagnosticBag();
		bag.error("no-match", "x");
		expect(Object.keys(bag.all()[0] as object).sort()).toEqual(["code", "message", "severity"]);
	});

	it("keeps a subject when given one", () => {
		const bag = new DiagnosticBag();
		bag.error("no-match", "x", { kind: "extension", id: "ext-1" });
		expect(bag.all()[0]?.subject).toEqual({ kind: "extension", id: "ext-1" });
	});

	it("keeps a path when given one without a subject", () => {
		const bag = new DiagnosticBag();
		bag.error("no-match", "x", undefined, "a.b");
		expect(bag.all()[0]).toMatchObject({ path: "a.b" });
		expect(bag.all()[0]?.subject).toBeUndefined();
	});

	it("returns a copy so a caller cannot mutate the bag", () => {
		const bag = new DiagnosticBag();
		bag.error("no-match", "x");
		(bag.all() as unknown[]).push({});
		expect(bag.size).toBe(1);
	});

	it("chains", () => {
		const bag = new DiagnosticBag().error("no-match", "a").warning("ivr-cycle", "b");
		expect(bag.size).toBe(2);
	});
});

describe("formatDiagnostics", () => {
	it("puts errors before warnings before info", () => {
		const lines = formatDiagnostics([
			{ severity: "info", code: "no-match", message: "c" },
			{ severity: "warning", code: "ivr-cycle", message: "b" },
			{ severity: "error", code: "invalid-regex", message: "a" },
		]).split("\n");
		expect(lines.map((line) => line.split(":")[0])).toEqual(["error", "warning", "info"]);
	});

	it("includes the subject and path when present", () => {
		expect(
			formatDiagnostics([
				{
					severity: "error",
					code: "dangling-destination",
					message: "gone",
					subject: { kind: "inbound-route", id: "in-1" },
					path: "destination",
				},
			]),
		).toBe("error: dangling-destination [inbound-route:in-1] (destination) — gone");
	});

	it("renders an empty list as an empty string", () => {
		expect(formatDiagnostics([])).toBe("");
	});
});
