import type {
	ConferencePlanNode,
	ExecutionPlan,
	ExtensionPlanNode,
	HangupPlanNode,
	IvrMenuPlanNode,
	PlanNode,
	PlanNodeTable,
	PlaybackPlanNode,
	QueuePlanNode,
	RingGroupPlanNode,
	TimeConditionPlanNode,
	TrunkDialPlanNode,
	VoicemailPlanNode,
} from "@optimiq-voice/routing";

/**
 * Plan-node builders for the walker specs.
 *
 * Deliberately NOT `packages/routing`'s `fixtures.ts`: that file builds SNAPSHOTS for the compiler,
 * and the walker's unit is the compiled node table. Going through the compiler to get a node would
 * make every walker spec depend on the compiler being correct, which is a different package's
 * specs' job — and would make "what happens when a ring group member points at a voicemail box?"
 * a question you answer by constructing a whole tenant.
 *
 * Every builder produces a node with sane, boring defaults and takes an override object, so a spec
 * names only the field it is about.
 */

export function extensionNode(
	id: string,
	overrides: Partial<ExtensionPlanNode> = {},
): ExtensionPlanNode {
	return {
		id,
		kind: "extension",
		extensionId: `ext-${id}`,
		number: "1001",
		tollClass: "internal",
		recordPolicy: "none",
		timeoutSeconds: 20,
		doNotDisturb: false,
		...overrides,
	};
}

export function ringGroupNode(
	id: string,
	overrides: Partial<RingGroupPlanNode> = {},
): RingGroupPlanNode {
	return {
		id,
		kind: "ring-group",
		ringGroupId: `rg-${id}`,
		strategy: "simultaneous",
		ringTimeoutSeconds: 20,
		ignoreBusy: true,
		confirmEnabled: false,
		members: [],
		...overrides,
	};
}

export function ivrMenuNode(id: string, overrides: Partial<IvrMenuPlanNode> = {}): IvrMenuPlanNode {
	return {
		id,
		kind: "ivr-menu",
		ivrMenuId: `ivr-${id}`,
		greetingPromptId: "greeting",
		digitTimeoutMs: 5_000,
		interDigitTimeoutMs: 2_000,
		maxDigits: 1,
		maxFailures: 2,
		maxTimeouts: 2,
		directDialEnabled: false,
		options: [],
		...overrides,
	};
}

export function voicemailNode(
	id: string,
	overrides: Partial<VoicemailPlanNode> = {},
): VoicemailPlanNode {
	return {
		id,
		kind: "voicemail",
		voicemailBoxId: `vm-${id}`,
		mailboxNumber: "8000",
		mode: "leave",
		maxMessageSeconds: 60,
		mwiEnabled: true,
		...overrides,
	};
}

export function trunkDialNode(
	id: string,
	overrides: Partial<TrunkDialPlanNode> = {},
): TrunkDialPlanNode {
	return {
		id,
		kind: "trunk-dial",
		outboundRouteId: `route-${id}`,
		tollClass: "national",
		attempts: [trunkAttempt("carrier-a", 0)],
		continueOnCauses: ["NORMAL_TEMPORARY_FAILURE", "NETWORK_OUT_OF_ORDER"],
		recordEnabled: false,
		...overrides,
	};
}

export function trunkAttempt(name: string, order: number): TrunkDialPlanNode["attempts"][number] {
	return {
		trunkId: `trunk-${name}`,
		name,
		kind: "register",
		sipDomain: "carrier.example",
		sipProxy: "sip.carrier.example",
		transport: "udp",
		order,
	};
}

export function queueNode(id: string, overrides: Partial<QueuePlanNode> = {}): QueuePlanNode {
	return {
		id,
		kind: "queue",
		queueId: `queue-${id}`,
		strategy: "longest-idle",
		// Both deadlines off by default: a spec about distribution should not have to remember to
		// disable a timeout it never mentioned, and `pbx-db`'s own default for both is 0.
		maxWaitSeconds: 0,
		maxWaitNoAgentSeconds: 0,
		announcePositionEnabled: false,
		announceFrequencySeconds: 60,
		recordEnabled: false,
		...overrides,
	};
}

export function conferenceNode(
	id: string,
	overrides: Partial<ConferencePlanNode> = {},
): ConferencePlanNode {
	return {
		id,
		kind: "conference",
		conferenceId: `conf-${id}`,
		roomNumber: "3001",
		requiresPin: false,
		// 0 is `pbx-db`'s own default and means "no limit" everywhere in this schema, so a spec
		// about the PIN gate does not have to remember to raise a cap it never mentioned.
		maxMembers: 0,
		waitForModerator: false,
		recordEnabled: false,
		...overrides,
	};
}

export function playbackNode(
	id: string,
	overrides: Partial<PlaybackPlanNode> = {},
): PlaybackPlanNode {
	return { id, kind: "playback", promptId: "welcome", ...overrides };
}

export function hangupNode(id: string, cause: HangupPlanNode["cause"]): HangupPlanNode {
	return { id, kind: "hangup", cause };
}

export function timeConditionNode(
	id: string,
	overrides: Partial<TimeConditionPlanNode> & Pick<TimeConditionPlanNode, "matchNodeId">,
): TimeConditionPlanNode {
	return {
		id,
		kind: "time-condition",
		timeConditionId: `tc-${id}`,
		...overrides,
	};
}

/** Builds a node table from a list, keyed by each node's own id. */
export function nodeTable(nodes: readonly PlanNode[]): PlanNodeTable {
	return Object.fromEntries(nodes.map((node) => [node.id, node]));
}

/** A plan over a node list, entered at the first node unless told otherwise. */
export function planOf(nodes: readonly PlanNode[], entryNodeId?: string): ExecutionPlan {
	return {
		entryNodeId: entryNodeId ?? (nodes[0]?.id as string),
		nodes: nodeTable(nodes),
	};
}
