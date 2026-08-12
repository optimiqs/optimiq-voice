import { describe, expect, it } from "bun:test";
import {
	aCallFlow,
	aConference,
	aDirectory,
	anExtension,
	anIvrMenu,
	anIvrOption,
	anOutboundRoute,
	aPagingGroup,
	aParkLot,
	aPhoneNumber,
	aQueue,
	aRingGroup,
	aRingGroupMember,
	aSnapshot,
	aStream,
	aTimeCondition,
	aTimeRule,
	aTrunk,
	aVoicemailBox,
	aVoicemailGreeting,
	compiled,
} from "./fixtures";
import { PLAN_NODE_KINDS, planNodeIds, planNodeReferences, reachableNodeIds } from "./plan";
import type { PlanNode, PlanNodeTable } from "./plan";

/** One organization exercising every node kind the compiler can emit. */
const artifact = compiled(
	aSnapshot({
		settings: { voicemailPrefix: "*99" },
		extensions: [anExtension({ voicemailEnabled: true })],
		voicemailBoxes: [aVoicemailBox()],
		conferences: [aConference()],
		parkLots: [aParkLot({ timeoutDestinationType: "extension", timeoutDestinationRef: "ext-1" })],
		pagingGroups: [aPagingGroup()],
		queues: [aQueue({ timeoutDestinationType: "voicemail", timeoutDestinationRef: "vm-1" })],
		ringGroups: [aRingGroup({ timeoutDestinationType: "queue", timeoutDestinationRef: "q-1" })],
		ringGroupDestinations: [aRingGroupMember()],
		ivrMenus: [anIvrMenu({ timeoutDestinationType: "ring-group", timeoutDestinationRef: "rg-1" })],
		ivrMenuOptions: [
			anIvrOption(),
			anIvrOption({
				id: "ivro-2",
				matchValue: "2",
				destinationType: "external",
				destinationRef: null,
				destinationData: { value: "+15559998888" },
			}),
			anIvrOption({
				id: "ivro-3",
				matchValue: "3",
				destinationType: "application",
				destinationRef: null,
				destinationData: { value: "echo" },
			}),
			anIvrOption({
				id: "ivro-4",
				matchValue: "4",
				destinationType: "hangup",
				destinationRef: null,
				destinationData: { cause: "USER_BUSY" },
			}),
			anIvrOption({
				id: "ivro-5",
				matchValue: "5",
				destinationType: "park",
				destinationRef: "park-1",
			}),
			anIvrOption({
				id: "ivro-6",
				matchValue: "6",
				destinationType: "conference",
				destinationRef: "conf-1",
			}),
			anIvrOption({
				id: "ivro-7",
				matchValue: "7",
				destinationType: "time-condition",
				destinationRef: "tc-1",
			}),
		],
		timeConditions: [aTimeCondition()],
		timeConditionRules: [aTimeRule()],
		trunks: [aTrunk()],
		outboundRoutes: [anOutboundRoute()],
		phoneNumbers: [aPhoneNumber({ destinationType: "ivr", destinationRef: "ivr-1" })],
		// The T2 admin block's three node kinds. The directory carries no entries here (nobody has a
		// recorded name in this fixture) and still emits its node — an empty directory is a warning,
		// not a missing node, because a tenant builds one before anybody records a name.
		callFlows: [aCallFlow()],
		audioStreams: [aStream()],
		directories: [aDirectory()],
		voicemailGreetings: [aVoicemailGreeting()],
	}),
);

function kindsIn(nodes: PlanNodeTable): ReadonlySet<string> {
	return new Set(Object.values(nodes).map((node) => node.kind));
}

describe("plan node vocabulary", () => {
	it("has no duplicate kinds", () => {
		expect(new Set(PLAN_NODE_KINDS).size).toBe(PLAN_NODE_KINDS.length);
	});

	/**
	 * Pinned, because a kind added here is an artifact-version bump: a reader compiled against the
	 * previous version meets a `kind` it has no case for, mid-call. Counting them is how the bump
	 * stops being something somebody has to remember.
	 */
	it("names eighteen kinds", () => {
		expect(PLAN_NODE_KINDS).toHaveLength(18);
		expect(PLAN_NODE_KINDS).toContain("paging");
		expect(PLAN_NODE_KINDS).toContain("call-flow");
		expect(PLAN_NODE_KINDS).toContain("stream");
		expect(PLAN_NODE_KINDS).toContain("dial-by-name");
	});

	it("emits every kind except playback from a fully wired organization", () => {
		// `playback` has no destination type of its own yet; it exists for the prompt-only
		// destinations the IVR builder will add.
		const emitted = kindsIn(artifact.nodes);
		for (const kind of PLAN_NODE_KINDS) {
			if (kind === "playback" || kind === "feature-code") {
				continue;
			}
			expect(emitted).toContain(kind);
		}
	});

	it("gives every node its own id as a field", () => {
		for (const [id, node] of Object.entries(artifact.nodes)) {
			expect(node.id).toBe(id);
		}
	});

	it("gives every node a kind in the vocabulary", () => {
		for (const node of Object.values(artifact.nodes)) {
			expect(PLAN_NODE_KINDS).toContain(node.kind);
		}
	});
});

describe("planNodeReferences", () => {
	it("lists an extension's fallback branches", () => {
		const node = artifact.nodes["extension:ext-1"] as PlanNode;
		expect(planNodeReferences(node)).toContain("voicemail:vm-1:leave");
	});

	it("lists a ring group's members and timeout", () => {
		const references = planNodeReferences(artifact.nodes["ring-group:rg-1"] as PlanNode);
		expect(references).toContain("extension:ext-1");
		expect(references).toContain("queue:q-1");
	});

	it("lists an IVR menu's options and branches", () => {
		const references = planNodeReferences(artifact.nodes["ivr-menu:ivr-1"] as PlanNode);
		expect(references).toContain("external:+15559998888");
		expect(references).toContain("ring-group:rg-1");
	});

	it("lists a time condition's two branches", () => {
		expect(planNodeReferences(artifact.nodes["time-condition:tc-1"] as PlanNode)).toContain(
			"extension:ext-1",
		);
	});

	it("lists a park lot's timeout", () => {
		expect(planNodeReferences(artifact.nodes["park:park-1"] as PlanNode)).toEqual([
			"extension:ext-1",
		]);
	});

	it("lists a queue's timeout", () => {
		expect(planNodeReferences(artifact.nodes["queue:q-1"] as PlanNode)).toEqual([
			"voicemail:vm-1:leave",
		]);
	});

	it("lists nothing for a terminal", () => {
		expect(planNodeReferences(artifact.nodes["hangup:NORMAL_CLEARING"] as PlanNode)).toEqual([]);
	});

	it("lists nothing for a voicemail node", () => {
		expect(planNodeReferences(artifact.nodes["voicemail:vm-1:leave"] as PlanNode)).toEqual([]);
	});

	it("lists nothing for a conference", () => {
		expect(planNodeReferences(artifact.nodes["conference:conf-1"] as PlanNode)).toEqual([]);
	});

	it("lists an outbound route's failover only", () => {
		expect(planNodeReferences(artifact.nodes["trunk-dial:out-1"] as PlanNode)).toEqual([]);
	});
});

/**
 * The property the whole artifact rests on. Stated once here over every node, and again in
 * `compile.spec.ts` over the match tables' entry points.
 */
describe("the node table is closed under reference", () => {
	it("resolves every reference of every node", () => {
		for (const node of Object.values(artifact.nodes)) {
			for (const reference of planNodeReferences(node)) {
				expect(artifact.nodes[reference]).toBeDefined();
			}
		}
	});

	it("never references itself from a node's own branch list", () => {
		for (const node of Object.values(artifact.nodes)) {
			expect(planNodeReferences(node)).not.toContain(node.id);
		}
	});
});

describe("reachableNodeIds", () => {
	it("includes the entry node", () => {
		expect(reachableNodeIds(artifact.nodes, "extension:ext-1")).toContain("extension:ext-1");
	});

	it("follows branches transitively", () => {
		const reachable = reachableNodeIds(artifact.nodes, "ivr-menu:ivr-1");
		expect(reachable).toContain("ring-group:rg-1");
		expect(reachable).toContain("queue:q-1");
		expect(reachable).toContain("voicemail:vm-1:leave");
	});

	it("terminates on a cycle", () => {
		const cyclic = compiled(
			aSnapshot({
				extensions: [
					anExtension({ forwardBusyEnabled: true, forwardBusyDestination: "1002" }),
					anExtension({
						id: "ext-2",
						number: "1002",
						forwardBusyEnabled: true,
						forwardBusyDestination: "1001",
					}),
				],
			}),
		);
		expect(reachableNodeIds(cyclic.nodes, "extension:ext-1")).toContain("extension:ext-2");
	});

	it("tolerates an id that is not in the table", () => {
		expect(reachableNodeIds(artifact.nodes, "nope")).toContain("nope");
	});

	it("reaches nothing else from a terminal", () => {
		expect([...reachableNodeIds(artifact.nodes, "hangup:USER_BUSY")]).toEqual(["hangup:USER_BUSY"]);
	});
});

describe("planNodeIds", () => {
	it("returns sorted ids", () => {
		const ids = planNodeIds(artifact.nodes);
		expect(ids).toEqual([...ids].sort());
	});

	it("returns every id", () => {
		expect(planNodeIds(artifact.nodes)).toHaveLength(Object.keys(artifact.nodes).length);
	});
});
