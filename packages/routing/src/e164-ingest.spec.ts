import { describe, expect, it } from "bun:test";
import {
	declaresInternational,
	ingestDialTarget,
	ingestE164,
	readCallingCode,
} from "./e164-ingest";
import { compiled, compileAttempt, aPhoneNumber, aSnapshot, anExtension, aTrunk } from "./fixtures";
import type { ExtensionPlanNode, TrunkDialPlanNode } from "./plan";

describe("ingestE164", () => {
	it("keeps a number that is already canonical", () => {
		expect(ingestE164("+15551230001")).toEqual({
			value: "+15551230001",
			rejection: null,
			rewritten: false,
		});
	});

	it("canonicalises the three international prefixes to one spelling", () => {
		for (const written of ["+441632960111", "00441632960111", "011441632960111"]) {
			expect(ingestE164(written).value).toBe("+441632960111");
		}
	});

	it("strips the punctuation a person types", () => {
		expect(ingestE164("+1 (555) 123-0001").value).toBe("+15551230001");
	});

	it("prepends the organization's calling code to a national number", () => {
		expect(ingestE164("2125550100", "1").value).toBe("+12125550100");
	});

	it("refuses a national number when no calling code is configured, and keeps it verbatim", () => {
		expect(ingestE164("2125550100")).toEqual({
			value: "2125550100",
			rejection: "no-country-code",
			rewritten: false,
		});
	});

	it("keeps an unreadable value rather than dropping it", () => {
		const outcome = ingestE164("+9999999999999999");
		expect(outcome.rejection).toBe("too-long");
		expect(outcome.value).toBe("+9999999999999999");
	});
});

describe("ingestDialTarget", () => {
	it("leaves a dial string that is not international exactly as written", () => {
		for (const target of ["1001", "92125550100", "*97", "NXXNXXXXXX"]) {
			expect(ingestDialTarget(target, "1")).toEqual({
				value: target,
				rejection: null,
				rewritten: false,
			});
		}
	});

	it("canonicalises a target that declares itself international", () => {
		expect(ingestDialTarget("00441632960111").value).toBe("+441632960111");
	});

	it("reports an international target it cannot read", () => {
		expect(ingestDialTarget("+0044").rejection).toBe("not-a-number");
	});

	it("recognises exactly the three international prefixes", () => {
		expect(declaresInternational("+1")).toBe(true);
		expect(declaresInternational("0044")).toBe(true);
		expect(declaresInternational("0111")).toBe(true);
		expect(declaresInternational("1001")).toBe(false);
	});
});

describe("readCallingCode", () => {
	it("accepts a code with or without the plus a person types", () => {
		expect(readCallingCode("1")).toBe("1");
		expect(readCallingCode("+44")).toBe("44");
		expect(readCallingCode(" 353 ")).toBe("353");
	});

	it("refuses anything that is not a calling code", () => {
		for (const value of [null, undefined, "", "0", "12345", "+", "GB"]) {
			expect(readCallingCode(value)).toBeUndefined();
		}
	});
});

describe("compile — E.164 at ingestion", () => {
	it("canonicalises a DID everywhere it is keyed, from one rewrite", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				phoneNumbers: [aPhoneNumber({ e164: "00441632960111" })],
			}),
		);
		expect(Object.keys(artifact.inbound.didDefaults)).toEqual(["+441632960111"]);
		expect(artifact.inbound.didDefaults["+441632960111"]?.e164).toBe("+441632960111");
	});

	it("canonicalises an extension caller id", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension({ callerIdNumber: "+1 (555) 123-0001" })],
			}),
		);
		const node = artifact.nodes["extension:ext-1"] as ExtensionPlanNode;
		expect(node.callerIdNumber).toBe("+15551230001");
	});

	it("canonicalises a trunk caller id override once, not once per route naming the trunk", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				trunks: [aTrunk({ callerIdNumberOverride: "2125550100" })],
				outboundRoutes: [
					{
						id: "out-1",
						enabled: true,
						name: "A",
						priority: 100,
						matchKind: "prefix",
						dialPatterns: ["+1"],
						stripDigits: 0,
						tollClass: "national",
						trunkPriority: [{ trunkId: "trunk-1", order: 1 }],
						recordEnabled: false,
					},
					{
						id: "out-2",
						enabled: true,
						name: "B",
						priority: 200,
						matchKind: "prefix",
						dialPatterns: ["+4"],
						stripDigits: 0,
						tollClass: "international",
						trunkPriority: [{ trunkId: "trunk-1", order: 1 }],
						recordEnabled: false,
					},
				],
			}),
		);
		expect(result.diagnostics.filter((entry) => entry.code === "non-e164-number")).toHaveLength(1);
	});

	it("uses the organization's calling code when one is configured", () => {
		const artifact = compiled(
			aSnapshot({
				settings: { defaultCallingCode: "44" },
				extensions: [anExtension()],
				trunks: [aTrunk({ callerIdNumberOverride: "01632960111" })],
				outboundRoutes: [
					{
						id: "out-1",
						enabled: true,
						name: "A",
						priority: 100,
						matchKind: "prefix",
						dialPatterns: ["+4"],
						stripDigits: 0,
						tollClass: "international",
						trunkPriority: [{ trunkId: "trunk-1", order: 1 }],
						recordEnabled: false,
					},
				],
			}),
		);
		const node = artifact.nodes["trunk-dial:out-1"] as TrunkDialPlanNode;
		expect(node.attempts[0]?.callerIdNumberOverride).toBe("+441632960111");
	});

	it("warns and compiles verbatim rather than failing the tenant's whole dial plan", () => {
		const result = compileAttempt(
			aSnapshot({
				extensions: [anExtension()],
				phoneNumbers: [aPhoneNumber({ e164: "not-a-did" })],
			}),
		);
		expect(result.ok).toBe(true);
		const warning = result.diagnostics.find((entry) => entry.code === "non-e164-number");
		expect(warning?.severity).toBe("warning");
		expect(warning?.subject?.id).toBe("did-1");
	});

	it("leaves an external destination that is not international alone", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				phoneNumbers: [
					aPhoneNumber({
						destinationType: "external",
						destinationRef: undefined,
						destinationData: { value: "92125550100" },
					}),
				],
			}),
		);
		expect(artifact.nodes["external:92125550100"]).toBeDefined();
	});

	it("canonicalises an external destination that is international", () => {
		const artifact = compiled(
			aSnapshot({
				extensions: [anExtension()],
				phoneNumbers: [
					aPhoneNumber({
						destinationType: "external",
						destinationRef: undefined,
						destinationData: { value: "00441632960111" },
					}),
				],
			}),
		);
		expect(artifact.nodes["external:+441632960111"]).toBeDefined();
	});
});
