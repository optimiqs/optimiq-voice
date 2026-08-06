import { describe, expect, it } from "bun:test";
import {
	aCallBlockRule,
	anExtension,
	anOutboundRoute,
	aSnapshot,
	aTrunk,
	codesOf,
	compileAttempt,
	compiled,
} from "./fixtures";
import { planNodeReferences, reachableNodeIds } from "./plan";
import type { ExtensionPlanNode, FollowMePlan, TrunkDialPlanNode } from "./plan";
import type {
	ExtensionInput,
	FollowMeInput,
	FollowMeTargetInput,
	OrgRoutingSnapshot,
} from "./snapshot";

const OFF_NET = "+15559998888";
const OTHER_OFF_NET = "+15557776666";

function hop(overrides: Partial<FollowMeTargetInput> = {}): FollowMeTargetInput {
	return { destination: OFF_NET, delaySeconds: 0, timeoutSeconds: 20, ...overrides };
}

function ladder(overrides: Partial<FollowMeInput> = {}): FollowMeInput {
	return { enabled: true, targets: [hop()], ...overrides };
}

/**
 * `ext-1` (1001) carries the ladder; `ext-2` (1002) is there to be an internal hop; one national
 * outbound route over one trunk carries the off-net ones.
 */
function withLadder(
	followMe: FollowMeInput,
	extension: Partial<ExtensionInput> = {},
	snapshot: Partial<OrgRoutingSnapshot> = {},
): OrgRoutingSnapshot {
	return aSnapshot({
		extensions: [
			anExtension({ followMe, ...extension }),
			anExtension({ id: "ext-2", number: "1002", label: "Desk" }),
		],
		trunks: [aTrunk()],
		outboundRoutes: [anOutboundRoute()],
		...snapshot,
	});
}

function followMeOf(snapshot: OrgRoutingSnapshot): FollowMePlan | undefined {
	return (compiled(snapshot).nodes["extension:ext-1"] as ExtensionPlanNode).followMe;
}

describe("compile — follow-me: when it is attached at all", () => {
	it("leaves an extension with no ladder alone", () => {
		expect(followMeOf(withLadder({ enabled: false, targets: [] }))).toBeUndefined();
	});

	it("leaves an extension whose ladder is switched off alone", () => {
		expect(followMeOf(withLadder(ladder({ enabled: false })))).toBeUndefined();
	});

	it("leaves an extension alone when the loader never supplied the column", () => {
		const node = compiled(aSnapshot({ extensions: [anExtension()] })).nodes[
			"extension:ext-1"
		] as ExtensionPlanNode;
		expect(node.followMe).toBeUndefined();
	});

	it("does not attach a ladder whose every hop is unresolvable, and says why", () => {
		// No trunks and no outbound routes: the off-net hop has nothing to take.
		const snapshot = aSnapshot({ extensions: [anExtension({ followMe: ladder() })] });
		const result = compileAttempt(snapshot);
		expect(result.ok).toBe(true);
		expect(codesOf(result)).toContain("unresolvable-follow-me");
		expect(codesOf(result)).toContain("empty-follow-me");
		// The extension still rings its own endpoint, which is what it did before follow-me existed.
		expect(followMeOf(snapshot)).toBeUndefined();
	});

	it("drops a hop with a blank destination and renumbers nothing", () => {
		const snapshot = withLadder(
			ladder({ targets: [hop({ destination: "   " }), hop({ destination: OFF_NET })] }),
		);
		expect(codesOf(compileAttempt(snapshot))).toContain("unresolvable-follow-me");
		const plan = followMeOf(snapshot);
		expect(plan?.destinations).toHaveLength(1);
		// The surviving hop keeps its stored position, so the ladder still reads as authored.
		expect(plan?.destinations[0]?.ordinal).toBe(1);
	});
});

describe("compile — follow-me: the strategy is derived from the delays", () => {
	it("is simultaneous when every hop rings immediately", () => {
		const plan = followMeOf(
			withLadder(ladder({ targets: [hop(), hop({ destination: OTHER_OFF_NET })] })),
		);
		expect(plan?.strategy).toBe("simultaneous");
	});

	it("is sequential as soon as one hop is delayed", () => {
		const plan = followMeOf(
			withLadder(
				ladder({ targets: [hop(), hop({ destination: OTHER_OFF_NET, delaySeconds: 15 })] }),
			),
		);
		expect(plan?.strategy).toBe("sequential");
	});

	it("clamps a negative or fractional stored second count", () => {
		const plan = followMeOf(
			withLadder(ladder({ targets: [hop({ delaySeconds: -4, timeoutSeconds: 20.7 })] })),
		);
		expect(plan?.destinations[0]).toMatchObject({ delaySeconds: 0, timeoutSeconds: 20 });
	});

	it("carries ignoreBusy through, defaulting to false", () => {
		expect(followMeOf(withLadder(ladder()))?.ignoreBusy).toBe(false);
		expect(followMeOf(withLadder(ladder({ ignoreBusy: true })))?.ignoreBusy).toBe(true);
	});

	it("carries the per-hop confirm flag through as confirmRequired", () => {
		const plan = followMeOf(withLadder(ladder({ targets: [hop({ confirm: true })] })));
		expect(plan?.destinations[0]?.confirmRequired).toBe(true);
		expect(followMeOf(withLadder(ladder()))?.destinations[0]?.confirmRequired).toBe(false);
	});
});

describe("compile — follow-me: internal hops", () => {
	it("points an internal number at that extension's own node", () => {
		const plan = followMeOf(withLadder(ladder({ targets: [hop({ destination: "1002" })] })));
		expect(plan?.destinations[0]).toMatchObject({
			destination: "1002",
			targetNodeId: "extension:ext-2",
		});
		// Internal hops dial the extension node's own number; there is nothing to manipulate.
		expect(plan?.destinations[0]?.dialedNumber).toBeUndefined();
	});

	it("prefers an internal number over an outbound route that would also match it", () => {
		const plan = followMeOf(
			withLadder(
				ladder({ targets: [hop({ destination: "1002" })] }),
				{},
				{
					extensions: [
						anExtension({ followMe: ladder({ targets: [hop({ destination: "1002" })] }) }),
						anExtension({ id: "ext-2", number: "1002", label: "Desk" }),
					],
					trunks: [aTrunk()],
					outboundRoutes: [anOutboundRoute({ matchKind: "any", dialPatterns: [] })],
				},
			),
		);
		expect(plan?.destinations[0]?.targetNodeId).toBe("extension:ext-2");
	});

	it("lets an extension put itself at the top of its own ladder", () => {
		const plan = followMeOf(withLadder(ladder({ targets: [hop({ destination: "1001" }), hop()] })));
		expect(plan?.destinations[0]?.targetNodeId).toBe("extension:ext-1");
	});
});

describe("compile — follow-me: external hops go through the outbound match table", () => {
	it("points an external number at the matched route's trunk-dial node", () => {
		expect(followMeOf(withLadder(ladder()))?.destinations[0]).toMatchObject({
			destination: OFF_NET,
			targetNodeId: "trunk-dial:out-1",
			dialedNumber: OFF_NET,
		});
	});

	it("applies the matched route's digit manipulation to the number that goes on the wire", () => {
		const plan = followMeOf(
			withLadder(
				ladder(),
				{},
				{
					extensions: [anExtension({ followMe: ladder() })],
					trunks: [aTrunk()],
					outboundRoutes: [anOutboundRoute({ stripDigits: 1, prependDigits: "011" })],
				},
			),
		);
		expect(plan?.destinations[0]?.dialedNumber).toBe("01115559998888");
	});

	it("refuses a hop whose only route needs a toll class the extension does not hold", () => {
		const snapshot = withLadder(
			ladder(),
			{ tollClass: "local" },
			{
				extensions: [anExtension({ followMe: ladder(), tollClass: "local" })],
				trunks: [aTrunk()],
				outboundRoutes: [anOutboundRoute({ tollClass: "international" })],
			},
		);
		expect(codesOf(compileAttempt(snapshot))).toContain("unresolvable-follow-me");
		expect(followMeOf(snapshot)).toBeUndefined();
	});

	it("takes a lower-class route the extension does hold over one it does not", () => {
		const plan = followMeOf(
			withLadder(
				ladder(),
				{},
				{
					extensions: [anExtension({ followMe: ladder(), tollClass: "national" })],
					trunks: [aTrunk()],
					outboundRoutes: [
						anOutboundRoute({ id: "out-premium", priority: 10, tollClass: "premium" }),
						anOutboundRoute({ id: "out-national", priority: 20, tollClass: "national" }),
					],
				},
			),
		);
		expect(plan?.destinations[0]?.targetNodeId).toBe("trunk-dial:out-national");
	});

	it("refuses every external hop when outbound calling is switched off", () => {
		const snapshot = withLadder(
			ladder(),
			{},
			{
				extensions: [anExtension({ followMe: ladder() })],
				trunks: [aTrunk()],
				outboundRoutes: [anOutboundRoute()],
				settings: { outboundEnabled: false },
			},
		);
		expect(codesOf(compileAttempt(snapshot))).toContain("unresolvable-follow-me");
		expect(followMeOf(snapshot)).toBeUndefined();
	});

	it("refuses a hop a call-block rule names", () => {
		const snapshot = withLadder(
			ladder(),
			{},
			{
				extensions: [anExtension({ followMe: ladder() })],
				trunks: [aTrunk()],
				outboundRoutes: [anOutboundRoute()],
				callBlockRules: [
					aCallBlockRule({
						direction: "outbound",
						action: "block",
						matchKind: "exact",
						pattern: OFF_NET,
					}),
				],
			},
		);
		expect(codesOf(compileAttempt(snapshot))).toContain("unresolvable-follow-me");
		expect(followMeOf(snapshot)).toBeUndefined();
	});

	it("keeps a refused hop in the ladder, without a target, when another hop still works", () => {
		const plan = followMeOf(withLadder(ladder({ targets: [hop(), hop({ destination: "555" })] })));
		expect(plan?.destinations).toHaveLength(2);
		expect(plan?.destinations[1]).toMatchObject({ destination: "555" });
		expect(plan?.destinations[1]?.targetNodeId).toBeUndefined();
	});
});

describe("compile — follow-me: the artifact stays sound", () => {
	it("reports every hop as a node reference, so closure covers them", () => {
		const artifact = compiled(withLadder(ladder()));
		const node = artifact.nodes["extension:ext-1"] as ExtensionPlanNode;
		expect(planNodeReferences(node)).toContain("trunk-dial:out-1");
		for (const reference of planNodeReferences(node)) {
			expect(artifact.nodes[reference]).toBeDefined();
		}
	});

	it("makes the trunk-dial node a follow-me hop needs reachable from the extension", () => {
		const artifact = compiled(withLadder(ladder()));
		expect([...reachableNodeIds(artifact.nodes, "extension:ext-1")]).toContain("trunk-dial:out-1");
		expect((artifact.nodes["trunk-dial:out-1"] as TrunkDialPlanNode).attempts).toHaveLength(1);
	});

	it("is deterministic: the same snapshot compiles byte for byte", () => {
		const build = (): OrgRoutingSnapshot =>
			withLadder(
				ladder({
					targets: [
						hop({ destination: "1002", delaySeconds: 5 }),
						hop({ delaySeconds: 10, timeoutSeconds: 25 }),
					],
				}),
			);
		expect(compiled(build()).snapshotHash).toBe(compiled(build()).snapshotHash);
		expect(JSON.stringify(compiled(build()).nodes)).toBe(JSON.stringify(compiled(build()).nodes));
	});

	it("keeps the extension's own failure branches untouched", () => {
		const node = compiled(withLadder(ladder())).nodes["extension:ext-1"] as ExtensionPlanNode;
		expect(node.noAnswerNodeId).toBe("hangup:NO_ANSWER");
		expect(node.busyNodeId).toBe("hangup:USER_BUSY");
		expect(node.number).toBe("1001");
	});
});
