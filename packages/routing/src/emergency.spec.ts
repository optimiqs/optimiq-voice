import { describe, expect, it } from "bun:test";
import {
	DEFAULT_EMERGENCY_NUMBERS,
	EMERGENCY_CONTINUE_ON_CAUSES,
	EMERGENCY_NODE_ID,
	emergencyNumbers,
	invalidEmergencyNumbers,
	isEmergencyDialString,
} from "./emergency";
import {
	aCallBlockRule,
	anEmergencyAddress,
	anExtension,
	anOutboundRoute,
	aPhoneNumber,
	aSnapshot,
	aTrunk,
	codesOf,
	compileAttempt,
	compiled,
	at,
} from "./fixtures";
import { resolveInternal, resolveOutbound } from "./resolve";
import type { TrunkDialPlanNode } from "./plan";

/**
 * Emergency dialing.
 *
 * Two halves, and the second is the one that matters. The first proves the table compiles: the
 * numbers are there, the node is there, the trunks are in a documented order. The second proves
 * the BYPASS — that each gate which can refuse an ordinary call, refuses an ordinary call, and
 * does not refuse this one. A test that only asserted "911 resolves" would pass on an
 * implementation that had quietly become an ordinary outbound route.
 */

const NOW = at("2026-08-05T12:00:00.000Z");

/** A tenant that can dial out: one extension, one trunk, one route, one DID with an address. */
function anOrganization(overrides: Parameters<typeof aSnapshot>[0] = {}) {
	return aSnapshot({
		extensions: [anExtension()],
		trunks: [aTrunk()],
		outboundRoutes: [anOutboundRoute()],
		phoneNumbers: [aPhoneNumber({ emergencyAddressId: "addr-1" })],
		emergencyAddresses: [anEmergencyAddress()],
		...overrides,
	});
}

describe("the emergency number table", () => {
	it("seeds 911, its test number and the outside-line habit", () => {
		const dialed = DEFAULT_EMERGENCY_NUMBERS.map((seed) => seed.dialed);
		expect(dialed).toContain("911");
		expect(dialed).toContain("933");
		expect(dialed).toContain("9911");
	});

	it("maps a 9-prefixed form to the number that goes on the wire", () => {
		const table = emergencyNumbers();
		expect(table.find((seed) => seed.dialed === "9911")?.number).toBe("911");
		expect(table.find((seed) => seed.dialed === "911")?.number).toBe("911");
	});

	it("does not seed numbers a three-digit dial plan would collide with", () => {
		const dialed = emergencyNumbers().map((seed) => seed.dialed);
		expect(dialed).not.toContain("112");
		expect(dialed).not.toContain("999");
	});

	it("adds an organization's own numbers without removing a seeded one", () => {
		const dialed = emergencyNumbers(["112"]).map((seed) => seed.dialed);
		expect(dialed).toContain("112");
		expect(dialed).toContain("911");
	});

	it("cannot be used to remove 911", () => {
		expect(emergencyNumbers([]).map((seed) => seed.dialed)).toContain("911");
		expect(emergencyNumbers(["112", "999"]).map((seed) => seed.dialed)).toContain("911");
	});

	it("is byte-stable regardless of the order the organization listed its numbers in", () => {
		expect(emergencyNumbers(["112", "999"])).toEqual(emergencyNumbers(["999", "112"]));
	});

	it("refuses a dial string that is not one", () => {
		expect(isEmergencyDialString("911")).toBe(true);
		expect(isEmergencyDialString("+1911")).toBe(true);
		expect(isEmergencyDialString("nine-one-one")).toBe(false);
		expect(invalidEmergencyNumbers(["911", "oops"])).toEqual(["oops"]);
	});

	it("retries far wider than an ordinary trunk chain does", () => {
		// The fraud argument that keeps `CALL_REJECTED` out of `RETRYABLE_HANGUP_CAUSES` does not
		// apply when the destination is a dispatcher: one rejection is a reason to try the next
		// carrier, not evidence of a compromised extension.
		expect(EMERGENCY_CONTINUE_ON_CAUSES).toContain("CALL_REJECTED");
		expect(EMERGENCY_CONTINUE_ON_CAUSES).toContain("USER_BUSY");
		expect(EMERGENCY_CONTINUE_ON_CAUSES).not.toContain("NORMAL_CLEARING");
		expect(EMERGENCY_CONTINUE_ON_CAUSES).not.toContain("ORIGINATOR_CANCEL");
	});
});

describe("compiling the emergency table", () => {
	it("puts the same table on both the internal and the outbound side", () => {
		const artifact = compiled(anOrganization());
		expect(artifact.internal.emergency?.["911"]?.destinationNodeId).toBe(EMERGENCY_NODE_ID);
		expect(artifact.outbound.emergency?.["911"]?.destinationNodeId).toBe(EMERGENCY_NODE_ID);
	});

	it("compiles one node for every dial string, so the artifact does not grow with the table", () => {
		const artifact = compiled(anOrganization());
		const ids = new Set(
			Object.values(artifact.outbound.emergency ?? {}).map((rule) => rule.destinationNodeId),
		);
		expect([...ids]).toEqual([EMERGENCY_NODE_ID]);
	});

	it("marks the node emergency and gives it no failover and no gate", () => {
		const node = compiled(anOrganization()).nodes[EMERGENCY_NODE_ID] as TrunkDialPlanNode;
		expect(node.kind).toBe("trunk-dial");
		expect(node.emergency).toBe(true);
		// Nowhere better for the call to go, and a gate is a thing that can close.
		expect(node.failoverNodeId).toBeUndefined();
		expect(node.recordEnabled).toBe(false);
	});

	it("carries the ELIN and the address it is registered against", () => {
		const node = compiled(anOrganization()).nodes[EMERGENCY_NODE_ID] as TrunkDialPlanNode;
		expect(node.elin).toBe("+15551230001");
		expect(node.emergencyAddressId).toBe("addr-1");
	});

	it("refuses an unvalidated address as an ELIN and says so", () => {
		const result = compileAttempt(
			anOrganization({ emergencyAddresses: [anEmergencyAddress({ validated: false })] }),
		);
		expect(codesOf(result)).toContain("dangling-emergency-address");
		const node = (result.ok ? result.artifact.nodes[EMERGENCY_NODE_ID] : undefined) as
			| TrunkDialPlanNode
			| undefined;
		expect(node?.elin).toBeUndefined();
	});

	it("warns per number when a DID carries no emergency address, naming it", () => {
		const result = compileAttempt(
			anOrganization({
				phoneNumbers: [aPhoneNumber(), aPhoneNumber({ id: "did-2", e164: "+15551230002" })],
				emergencyAddresses: [],
			}),
		);
		const warnings = result.diagnostics.filter(
			(entry) => entry.code === "missing-emergency-address",
		);
		expect(warnings).toHaveLength(2);
		expect(warnings.map((entry) => entry.subject?.name).sort()).toEqual([
			"+15551230001",
			"+15551230002",
		]);
	});

	it("warns when an organization has stations but no trunk to reach a dispatcher over", () => {
		const result = compileAttempt(aSnapshot({ extensions: [anExtension()] }));
		expect(codesOf(result)).toContain("no-emergency-route");
	});

	it("does not warn about reachability for a tenant with no stations at all", () => {
		expect(codesOf(compileAttempt(aSnapshot({})))).not.toContain("no-emergency-route");
	});

	it("warns that an extension numbered 911 is no longer reachable by dialing it", () => {
		const result = compileAttempt(anOrganization({ extensions: [anExtension({ number: "911" })] }));
		expect(codesOf(result)).toContain("emergency-number-shadowed");
		// And the compile still succeeds: this is a tenant's mistake, not an unsound artifact.
		expect(result.ok).toBe(true);
	});

	it("drops a configured number that is not a dial string, keeping the seeds", () => {
		const result = compileAttempt(
			anOrganization({ settings: { emergencyNumbers: ["112", "not a number"] } }),
		);
		expect(codesOf(result)).toContain("invalid-emergency-number");
		expect(result.ok ? result.artifact.outbound.emergency?.["112"] : undefined).toBeDefined();
		expect(result.ok ? result.artifact.outbound.emergency?.["911"] : undefined).toBeDefined();
	});
});

describe("the emergency trunk chain", () => {
	it("follows the tenant's own carrier preference first", () => {
		const artifact = compiled(
			anOrganization({
				trunks: [
					aTrunk({ id: "t-a", name: "Alpha" }),
					aTrunk({ id: "t-b", name: "Bravo" }),
					aTrunk({ id: "t-c", name: "Charlie" }),
				],
				outboundRoutes: [
					anOutboundRoute({
						trunkPriority: [
							{ trunkId: "t-c", order: 1 },
							{ trunkId: "t-a", order: 2 },
						],
					}),
				],
			}),
		);
		const node = artifact.nodes[EMERGENCY_NODE_ID] as TrunkDialPlanNode;
		// Route order first (Charlie, Alpha), then whatever is left, by name (Bravo).
		expect(node.attempts.map((attempt) => attempt.name)).toEqual(["Charlie", "Alpha", "Bravo"]);
	});

	it("includes a DISABLED trunk — one INVITE is cheaper than not trying", () => {
		const artifact = compiled(
			anOrganization({
				trunks: [aTrunk({ id: "t-a", name: "Alpha", enabled: false })],
				outboundRoutes: [],
			}),
		);
		const node = artifact.nodes[EMERGENCY_NODE_ID] as TrunkDialPlanNode;
		expect(node.attempts.map((attempt) => attempt.name)).toEqual(["Alpha"]);
	});

	it("never carries a trunk's ordinary caller-id override, which would replace the ELIN", () => {
		const artifact = compiled(
			anOrganization({
				trunks: [aTrunk({ callerIdNumberOverride: "+15559999999" })],
			}),
		);
		const node = artifact.nodes[EMERGENCY_NODE_ID] as TrunkDialPlanNode;
		expect(node.attempts[0]?.callerIdNumberOverride).toBeUndefined();
	});
});

describe("resolving an emergency call — the bypass proofs", () => {
	it("dials 911 when outbound calling is switched off for the organization", () => {
		const artifact = compiled(anOrganization({ settings: { outboundEnabled: false } }));
		// The control: an ordinary number is refused.
		expect(
			resolveOutbound(artifact, { from: "1001", dialed: "+15551239999", now: NOW }).matched,
		).toBe(false);
		const route = resolveOutbound(artifact, { from: "1001", dialed: "911", now: NOW });
		expect(route.matched).toBe(true);
		expect(route.plan?.entryNodeId).toBe(EMERGENCY_NODE_ID);
	});

	it("dials 911 for a caller whose toll class covers nothing", () => {
		const artifact = compiled(
			anOrganization({
				extensions: [anExtension({ tollClass: "internal" })],
				outboundRoutes: [anOutboundRoute({ tollClass: "international" })],
			}),
		);
		expect(
			resolveOutbound(artifact, { from: "1001", dialed: "+15551239999", now: NOW }).matched,
		).toBe(false);
		expect(resolveOutbound(artifact, { from: "1001", dialed: "911", now: NOW }).matched).toBe(true);
	});

	it("dials 911 for a caller who is not an extension of this organization at all", () => {
		const artifact = compiled(anOrganization());
		expect(resolveOutbound(artifact, { from: "nobody", dialed: "+1555", now: NOW }).matched).toBe(
			false,
		);
		expect(resolveOutbound(artifact, { from: "nobody", dialed: "911", now: NOW }).matched).toBe(
			true,
		);
	});

	it("dials 911 through a call-block rule that blocks everything", () => {
		const artifact = compiled(
			anOrganization({
				callBlockRules: [
					aCallBlockRule({ pattern: "9", matchKind: "prefix", direction: "both", action: "block" }),
				],
			}),
		);
		expect(
			resolveOutbound(artifact, { from: "1001", dialed: "95551230001", now: NOW }).blocked,
		).toBeDefined();
		const route = resolveOutbound(artifact, { from: "1001", dialed: "911", now: NOW });
		expect(route.blocked).toBeUndefined();
		expect(route.plan?.entryNodeId).toBe(EMERGENCY_NODE_ID);
	});

	it("dials 911 from the internal context too, ahead of the number map", () => {
		const artifact = compiled(anOrganization({ extensions: [anExtension({ number: "911" })] }));
		const route = resolveInternal(artifact, { from: "1001", dialed: "911", now: NOW });
		expect(route.plan?.entryNodeId).toBe(EMERGENCY_NODE_ID);
		expect(route.matchedRuleId).toBe("emergency");
	});

	it("strips the outside-line 9 before it reaches the trunk", () => {
		const artifact = compiled(anOrganization());
		expect(resolveOutbound(artifact, { from: "1001", dialed: "9911", now: NOW }).dialedNumber).toBe(
			"911",
		);
	});

	it("records that every gate was bypassed, for the ticket", () => {
		const artifact = compiled(anOrganization());
		const route = resolveOutbound(artifact, { from: "1001", dialed: "911", now: NOW });
		expect(route.diagnostics.map((entry) => entry.code)).toContain("emergency-call");
		expect(route.reason).toBe("emergency call to 911");
	});
});

describe("the caller id an emergency call presents", () => {
	it("prefers the calling extension's own registered callback number", () => {
		const artifact = compiled(
			anOrganization({
				extensions: [anExtension({ emergencyCallerIdNumber: "+15550001111" })],
			}),
		);
		expect(
			resolveOutbound(artifact, { from: "1001", dialed: "911", now: NOW }).callerIdNumber,
		).toBe("+15550001111");
	});

	it("falls back to the organization ELIN", () => {
		expect(
			resolveOutbound(compiled(anOrganization()), { from: "1001", dialed: "911", now: NOW })
				.callerIdNumber,
		).toBe("+15551230001");
	});

	it("falls back to the ordinary outbound caller id when there is no ELIN", () => {
		const artifact = compiled(
			anOrganization({
				phoneNumbers: [],
				emergencyAddresses: [],
				settings: { outboundCallerIdNumber: "+15557654321" },
			}),
		);
		expect(
			resolveOutbound(artifact, { from: "1001", dialed: "911", now: NOW }).callerIdNumber,
		).toBe("+15557654321");
	});

	it("presents nothing rather than guessing, when the organization has nothing to present", () => {
		const artifact = compiled(anOrganization({ phoneNumbers: [], emergencyAddresses: [] }));
		expect(
			resolveOutbound(artifact, { from: "1001", dialed: "911", now: NOW }).callerIdNumber,
		).toBeUndefined();
	});
});
