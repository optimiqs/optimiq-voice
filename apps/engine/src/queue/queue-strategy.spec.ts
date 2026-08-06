import { describe, expect, it } from "bun:test";
import { isEligibleForDistribution } from "./agent-state";
import { fakeAgent, fakeMembership } from "./queue-services.fake";
import {
	compareByIdle,
	compareByTier,
	eligibleCandidates,
	openLevels,
	rotateAfter,
	selectAgents,
	shuffled,
} from "./queue-strategy";
import type { QueueCandidate } from "./queue-strategy";
import type { AgentStateEntry, QueueMembership, QueueMembershipAgent } from "@optimiq-voice/events";
import type { QueueStrategy } from "@optimiq-voice/routing";

/**
 * Distribution, tested as the pure function it is.
 *
 * Every case here is "given this roster and these live states, who rings" — no channel, no bucket,
 * no clock. The agent ids are single letters because the assertion that matters is the ORDER, and
 * `["a", "b", "c"]` reads as an order in a way that three UUIDs do not.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const QUEUE = "0195c0f0-1c2f-7000-8000-0000000000a1";
const NOW = Date.parse("2026-08-05T12:00:00.000Z");

function state(
	agentId: string,
	overrides: Partial<AgentStateEntry> = {},
): [string, AgentStateEntry] {
	return [
		agentId,
		{
			orgId: ORG,
			agentId,
			status: "available",
			since: new Date(NOW).toISOString(),
			...overrides,
		},
	];
}

/** Everyone available, all idle for the same length of time. */
function allAvailable(agents: readonly QueueMembershipAgent[]): Map<string, AgentStateEntry> {
	return new Map(agents.map((agent) => state(agent.agentId)));
}

function roster(
	agents: readonly QueueMembershipAgent[],
	overrides: Partial<QueueMembership> = {},
): QueueMembership {
	return fakeMembership(ORG, QUEUE, agents, overrides);
}

function ids(selection: { readonly ordered: readonly QueueCandidate[] }): string[] {
	return selection.ordered.map((candidate) => candidate.agent.agentId);
}

/**
 * Who rings first.
 *
 * `selectAgents` returns the whole ORDER, not a truncated list — a one-at-a-time strategy takes the
 * head and a `ring-all` takes all of it, and that decision is the runtime's. So a spec about
 * "who does top-down pick" asks for the head, and a spec about the ordering asks for the list.
 */
function head(selection: { readonly ordered: readonly QueueCandidate[] }): string | undefined {
	return selection.ordered[0]?.agent.agentId;
}

function select(input: {
	readonly strategy: QueueStrategy;
	readonly agents: readonly QueueMembershipAgent[];
	readonly states?: Map<string, AgentStateEntry>;
	readonly membership?: Partial<QueueMembership>;
	readonly waitedMs?: number;
	readonly excludedAgentIds?: ReadonlySet<string>;
	readonly roundRobinAfterAgentId?: string;
	readonly random?: () => number;
}) {
	return selectAgents({
		strategy: input.strategy,
		membership: roster(input.agents, input.membership ?? {}),
		states: input.states ?? allAvailable(input.agents),
		waitedMs: input.waitedMs ?? 0,
		now: NOW,
		...(input.excludedAgentIds === undefined ? {} : { excludedAgentIds: input.excludedAgentIds }),
		...(input.roundRobinAfterAgentId === undefined
			? {}
			: { roundRobinAfterAgentId: input.roundRobinAfterAgentId }),
		...(input.random === undefined ? {} : { random: input.random }),
	});
}

const THREE = [
	fakeAgent("a", { level: 1, position: 1 }),
	fakeAgent("b", { level: 1, position: 2 }),
	fakeAgent("c", { level: 1, position: 3 }),
];

// =================================================================================================
// Ordering
// =================================================================================================

describe("tier ordering", () => {
	it("orders by level, then position", () => {
		const agents = [
			fakeAgent("b", { level: 2, position: 1 }),
			fakeAgent("c", { level: 1, position: 2 }),
			fakeAgent("a", { level: 1, position: 1 }),
		];
		const selection = select({
			strategy: "top-down",
			agents,
			membership: { tierRulesApply: false },
		});
		expect(ids(selection)).toEqual(["a", "c", "b"]);
	});

	it("breaks a level+position tie by agent id, so two engines agree on the order", () => {
		const agents = [
			fakeAgent("zz", { level: 1, position: 1 }),
			fakeAgent("aa", { level: 1, position: 1 }),
		];
		expect(ids(select({ strategy: "ring-all", agents }))).toEqual(["aa", "zz"]);
	});

	it("compareByTier is a total order", () => {
		const left = candidate(fakeAgent("a", { level: 1, position: 1 }), 0);
		const right = candidate(fakeAgent("b", { level: 1, position: 1 }), 0);
		expect(compareByTier(left, right)).toBeLessThan(0);
		expect(compareByTier(right, left)).toBeGreaterThan(0);
	});
});

describe("longest-idle", () => {
	it("picks the agent who has been free longest", () => {
		const states = new Map([
			state("a", { since: new Date(NOW - 10_000).toISOString() }),
			state("b", { since: new Date(NOW - 90_000).toISOString() }),
			state("c", { since: new Date(NOW - 30_000).toISOString() }),
		]);
		expect(ids(select({ strategy: "longest-idle", agents: THREE, states }))).toEqual([
			"b",
			"c",
			"a",
		]);
	});

	it("breaks an idle tie by tier, not by roster order", () => {
		const agents = [
			fakeAgent("c", { level: 1, position: 3 }),
			fakeAgent("a", { level: 1, position: 1 }),
			fakeAgent("b", { level: 1, position: 2 }),
		];
		expect(ids(select({ strategy: "longest-idle", agents }))).toEqual(["a", "b", "c"]);
	});

	it("compareByIdle puts the longer-idle candidate first", () => {
		const fresh = candidate(fakeAgent("a"), 1_000);
		const stale = candidate(fakeAgent("b"), 60_000);
		expect(compareByIdle(stale, fresh)).toBeLessThan(0);
	});
});

describe("ring-all", () => {
	it("returns everybody eligible and asks for a simultaneous fan-out", () => {
		const selection = select({ strategy: "ring-all", agents: THREE });
		expect(ids(selection)).toEqual(["a", "b", "c"]);
		expect(selection.fanOut).toBe("all");
	});

	it("still drops the ineligible: a ring-all is not an excuse to ring a busy phone", () => {
		const states = new Map([
			state("a"),
			state("b", { status: "on-call" }),
			state("c", { status: "logged-out" }),
		]);
		expect(ids(select({ strategy: "ring-all", agents: THREE, states }))).toEqual(["a"]);
	});
});

describe("top-down", () => {
	it("always starts at the top of the list", () => {
		expect(head(select({ strategy: "top-down", agents: THREE }))).toBe("a");
		expect(select({ strategy: "top-down", agents: THREE }).fanOut).toBe("one");
	});

	it("moves down when the top agent has been excluded by a penalty", () => {
		expect(
			head(select({ strategy: "top-down", agents: THREE, excludedAgentIds: new Set(["a"]) })),
		).toBe("b");
	});

	it("returns to the top the moment that agent is eligible again", () => {
		expect(head(select({ strategy: "top-down", agents: THREE }))).toBe("a");
	});
});

describe("round-robin", () => {
	it("starts after the agent this queue selected last", () => {
		expect(
			ids(select({ strategy: "round-robin", agents: THREE, roundRobinAfterAgentId: "a" })),
		).toEqual(["b", "c", "a"]);
	});

	it("wraps at the end of the list", () => {
		expect(
			ids(select({ strategy: "round-robin", agents: THREE, roundRobinAfterAgentId: "c" })),
		).toEqual(["a", "b", "c"]);
	});

	it("falls back to the top when the cursor names somebody who is no longer eligible", () => {
		const states = new Map([state("a"), state("b", { status: "on-call" }), state("c")]);
		expect(
			ids(select({ strategy: "round-robin", agents: THREE, states, roundRobinAfterAgentId: "b" })),
		).toEqual(["a", "c"]);
	});

	it("starts at the top when there is no cursor yet", () => {
		expect(ids(select({ strategy: "round-robin", agents: THREE }))).toEqual(["a", "b", "c"]);
	});

	it("rotateAfter leaves an empty list alone", () => {
		expect(rotateAfter([], "a")).toEqual([]);
	});
});

describe("sequential", () => {
	it("presents the tier order, one at a time", () => {
		const selection = select({ strategy: "sequential", agents: THREE });
		expect(ids(selection)).toEqual(["a", "b", "c"]);
		expect(selection.fanOut).toBe("one");
	});
});

describe("random", () => {
	it("uses the injected RNG, so a spec is deterministic", () => {
		// A generator that always returns 0 makes Fisher-Yates reverse-rotate deterministically.
		const selection = select({ strategy: "random", agents: THREE, random: () => 0 });
		expect(ids(selection).sort()).toEqual(["a", "b", "c"]);
		// A generator pinned to 0 makes Fisher-Yates deterministic: every swap targets index 0.
		expect(ids(selection)).toEqual(
			ids(select({ strategy: "random", agents: THREE, random: () => 0 })),
		);
	});

	it("shuffled is a permutation, never a subset", () => {
		const candidates = THREE.map((agent) => candidate(agent, 0));
		const result = shuffled(candidates, () => 0.5);
		expect(result.map((c) => c.agent.agentId).sort()).toEqual(["a", "b", "c"]);
	});
});

// =================================================================================================
// Eligibility and tier rules
// =================================================================================================

describe("who is eligible at all", () => {
	it("skips a disabled seat", () => {
		const agents = [fakeAgent("a", { enabled: false }), fakeAgent("b", { position: 2 })];
		expect(ids(select({ strategy: "ring-all", agents }))).toEqual(["b"]);
	});

	it("skips an agent with no live state at all", () => {
		const states = new Map([state("b")]);
		expect(ids(select({ strategy: "ring-all", agents: THREE, states }))).toEqual(["b"]);
	});

	it("skips an agent this caller already tried", () => {
		expect(
			ids(select({ strategy: "ring-all", agents: THREE, excludedAgentIds: new Set(["a", "c"]) })),
		).toEqual(["b"]);
	});

	it("returns an empty list rather than a fallback when nobody is reachable", () => {
		const states = new Map([
			state("a", { status: "on-call" }),
			state("b", { status: "on-call" }),
			state("c", { status: "logged-out" }),
		]);
		const selection = select({ strategy: "longest-idle", agents: THREE, states });
		expect(selection.ordered).toEqual([]);
	});

	it("returns an empty list for a queue with no agents at all", () => {
		expect(select({ strategy: "ring-all", agents: [] }).ordered).toEqual([]);
	});

	it("eligibleCandidates honours the predicate it is given", () => {
		const membership = roster(THREE);
		const candidates = eligibleCandidates({
			membership,
			states: allAvailable(THREE),
			openLevels: [1],
			now: NOW,
			isEligible: isEligibleForDistribution,
		});
		expect(candidates).toHaveLength(3);
	});
});

describe("tier rules", () => {
	const TIERED = [
		fakeAgent("a", { level: 1, position: 1 }),
		fakeAgent("b", { level: 2, position: 1 }),
		fakeAgent("c", { level: 3, position: 1 }),
	];

	it("opens every level at once when the rules are off", () => {
		const selection = select({
			strategy: "ring-all",
			agents: TIERED,
			membership: { tierRulesApply: false },
		});
		expect(selection.openLevels).toEqual([1, 2, 3]);
		expect(ids(selection)).toEqual(["a", "b", "c"]);
	});

	it("starts a fresh caller at the lowest level only", () => {
		const selection = select({
			strategy: "ring-all",
			agents: TIERED,
			membership: { tierRuleWaitSeconds: 30 },
			waitedMs: 0,
		});
		expect(selection.openLevels).toEqual([1]);
		expect(ids(selection)).toEqual(["a"]);
	});

	it("opens the next level once the caller has waited the tier rule out", () => {
		const selection = select({
			strategy: "ring-all",
			agents: TIERED,
			membership: { tierRuleWaitSeconds: 30 },
			waitedMs: 30_000,
		});
		expect(selection.openLevels).toEqual([1, 2]);
	});

	it("opens everything eventually and never more than exists", () => {
		const selection = select({
			strategy: "ring-all",
			agents: TIERED,
			membership: { tierRuleWaitSeconds: 30 },
			waitedMs: 600_000,
		});
		expect(selection.openLevels).toEqual([1, 2, 3]);
	});

	it("treats a tier rule wait of 0 as `open everything`, literally", () => {
		const selection = select({
			strategy: "ring-all",
			agents: TIERED,
			membership: { tierRuleWaitSeconds: 0 },
		});
		expect(selection.openLevels).toEqual([1, 2, 3]);
	});

	it("does NOT hold a caller at a level nobody is staffing when no-agent-no-wait is set", () => {
		const states = new Map([state("a", { status: "logged-out" }), state("b"), state("c")]);
		const selection = select({
			strategy: "ring-all",
			agents: TIERED,
			states,
			membership: { tierRuleWaitSeconds: 30, tierRuleNoAgentNoWait: true },
			waitedMs: 0,
		});
		expect(selection.openLevels).toEqual([1, 2]);
		expect(ids(selection)).toEqual(["b"]);
	});

	it("DOES hold them there when somebody is staffing it, even if that person is busy", () => {
		const states = new Map([state("a", { status: "on-call" }), state("b"), state("c")]);
		const selection = select({
			strategy: "ring-all",
			agents: TIERED,
			states,
			membership: { tierRuleWaitSeconds: 30, tierRuleNoAgentNoWait: true },
			waitedMs: 0,
		});
		expect(selection.openLevels).toEqual([1]);
		expect(ids(selection)).toEqual([]);
	});

	it("opens levels one at a time until it finds a staffed one", () => {
		const states = new Map([
			state("a", { status: "logged-out" }),
			state("b", { status: "logged-out" }),
			state("c"),
		]);
		const selection = select({
			strategy: "ring-all",
			agents: TIERED,
			states,
			membership: { tierRuleWaitSeconds: 30, tierRuleNoAgentNoWait: true },
		});
		expect(selection.openLevels).toEqual([1, 2, 3]);
	});

	it("openLevels reports nothing for a roster with nobody in it", () => {
		expect(
			openLevels({ membership: roster([]), waitedMs: 0, staffingAgentIds: new Set() }),
		).toEqual([]);
	});
});

describe("the fan-out", () => {
	it("is `all` only for ring-all", () => {
		for (const strategy of [
			"longest-idle",
			"round-robin",
			"top-down",
			"sequential",
			"random",
		] as const) {
			expect(select({ strategy, agents: THREE }).fanOut).toBe("one");
		}
		expect(select({ strategy: "ring-all", agents: THREE }).fanOut).toBe("all");
	});

	it("reports the strategy it was asked for, so a caller.answered can name it", () => {
		expect(select({ strategy: "round-robin", agents: THREE }).strategy).toBe("round-robin");
	});
});

function candidate(agent: QueueMembershipAgent, idleMs: number): QueueCandidate {
	return {
		agent,
		state: {
			orgId: ORG,
			agentId: agent.agentId,
			status: "available",
			since: new Date(NOW - idleMs).toISOString(),
		},
		idleMs,
	};
}
