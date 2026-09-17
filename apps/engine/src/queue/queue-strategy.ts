import { idleMsOf, isEligibleForDistribution, isStaffing } from "./agent-state";
import type {
	AgentStateEntry,
	QueueMembership,
	QueueMembershipAgent,
	QueueSkillRequirement,
} from "@optimiq-voice/events";
import type { QueueSkillRequirementPlan, QueueStrategy } from "@optimiq-voice/routing";

/**
 * Queue distribution: which agent (or agents) a waiting caller reaches next.
 *
 * ## Pure, on purpose
 *
 * Nothing in this file talks to KV, to the media server, or to a clock. It takes a roster, a
 * snapshot of every agent's live state, how long the caller has waited, and returns an ORDER. The
 * runtime in `queue-session.ts` is what rings the result. That split is what makes "does
 * `longest-idle` break its tie by tier position?" a three-line test instead of a call.
 *
 * ## Every strategy is an ordering, plus a fan-out
 *
 * The six strategies differ in exactly two ways: how they sort the eligible agents, and whether
 * they ring one of them or all of them. Modelling it that way rather than as six loops means the
 * ring/timeout/penalty machinery exists once, and a new strategy is a comparator.
 *
 * - **`ring-all`** — every eligible agent in the open tiers rings at once. First answer wins; the
 *   rest get `LOSE_RACE`. Order is still (level, position) so the log reads sensibly.
 * - **`top-down`** — one at a time, always from the top of a freshly computed list. An agent who
 *   became available while the caller waited is inserted at their tier position and may be reached
 *   before somebody lower who was already free. "Always favour the top of the list."
 * - **`sequential`** — one at a time, in the order computed when this caller ARRIVED, walked once.
 *   Agents who become available mid-wait are not spliced in. That frozen order is the whole
 *   difference from `top-down`, and it is the observable one: `sequential` guarantees a caller works
 *   down the roster without re-ringing somebody who already declined them, at the cost of not
 *   reaching a newly free agent until the pass ends.
 * - **`round-robin`** — one at a time, starting at the agent AFTER the last one this queue selected.
 *   The cursor is per queue and shared across callers, which is what spreads load; without it, two
 *   callers arriving together would both start at the same agent.
 * - **`longest-idle`** — one at a time, most-idle first, where "idle" is `now - since` on an
 *   `available` entry. The fairness strategy, and the default in `pbx-db`.
 * - **`random`** — one at a time, shuffled. Useful when every agent is equivalent and the operator
 *   wants no systematic bias; the RNG is injected so a spec can pin it.
 *
 * ## Tier rules are eligibility, not ordering
 *
 * `tierRulesApply` / `tierRuleWaitSeconds` / `tierRuleNoAgentNoWait` decide which LEVELS are open to
 * a caller who has waited a given time — see {@link openLevels}. They run before the comparator, so
 * every strategy honours them identically and none of them has to know they exist.
 *
 * ## Skills are a filter, for exactly the same reason
 *
 * A queue that asks for `spanish: 3` has not asked for a seventh strategy — it has said that some
 * seats cannot take this caller. So the requirement is applied where the tier rules are, BEFORE the
 * comparator, and `longest-idle` over a skilled pool is still `longest-idle`. See
 * {@link effectiveSkillBars} for how a bar drops as the caller waits, and
 * {@link mergeSkillRequirements} for what happens when the queue and the entrance both ask.
 */

/** One agent, joined with the live state the selection needs. */
export interface QueueCandidate {
	readonly agent: QueueMembershipAgent;
	readonly state: AgentStateEntry;
	/** `now - since`, precomputed so the comparator is a pure function of the candidate. */
	readonly idleMs: number;
}

/** What a selection returns: an ordered list, and whether to ring all of it or the head of it. */
export interface QueueSelection {
	readonly strategy: QueueStrategy;
	readonly ordered: readonly QueueCandidate[];
	/** `all` for ring-all; `one` for every other strategy. */
	readonly fanOut: "one" | "all";
	/** Levels that were open to this caller at selection time. For the log and the specs. */
	readonly openLevels: readonly number[];
	/** The skill bars applied at selection time, after relaxation. For the log and the specs. */
	readonly skillBars: readonly QueueSkillBar[];
	/**
	 * How many otherwise-reachable agents the skill bars alone removed, on a pass that ended with
	 * nobody.
	 *
	 * Always 0 when somebody was selected, because the question it answers only has consequences
	 * when the answer is nobody: "nobody qualified" and "nobody is logged in" are the same silence
	 * to a caller and completely different problems to the supervisor fixing it. Computing it costs
	 * a second pass over the roster and is therefore only done when the first one came back empty.
	 */
	readonly skilledOut: number;
}

export interface SelectionInput {
	readonly strategy: QueueStrategy;
	readonly membership: QueueMembership;
	/** Live state per agent id. A missing entry means the agent is not eligible. */
	readonly states: ReadonlyMap<string, AgentStateEntry>;
	/** How long the caller has been in the queue. Drives the tier rules. */
	readonly waitedMs: number;
	readonly now: number;
	/**
	 * Agents this caller has already tried and whose penalty has not lapsed, so a retry pass does
	 * not immediately re-ring the phone that just rang out.
	 */
	readonly excludedAgentIds?: ReadonlySet<string>;
	/**
	 * What this caller needs from an agent — the queue's own requirements already merged with the
	 * entrance's. See {@link mergeSkillRequirements}; absent or empty means anybody may take them.
	 */
	readonly skillRequirements?: readonly QueueSkillRequirement[];
	/** Where `round-robin` resumes: the agent id it selected last for this queue. */
	readonly roundRobinAfterAgentId?: string;
	/** Injected for `random`, so a spec is deterministic. */
	readonly random?: () => number;
}

const MILLIS_PER_SECOND = 1_000;

/**
 * Which tier levels a caller who has waited `waitedMs` may reach.
 *
 * With tier rules OFF, every level is open from the first second: the tiers become a pure ordering
 * hint and the queue behaves like one flat pool. That is what `tier_rules_apply = false` means and
 * it is a common configuration for small teams.
 *
 * With them ON, the caller starts at the LOWEST level that has anybody on the roster and gains one
 * more level per `tierRuleWaitSeconds` elapsed. A `tierRuleWaitSeconds` of 0 opens everything at
 * once — the same as turning the rules off, expressed the other way, and honoured literally rather
 * than treated as "unset".
 *
 * `tierRuleNoAgentNoWait` short-circuits the wait when the open levels contain nobody who is
 * STAFFING the queue (see `isStaffing`): a level whose agents are all logged out should not hold a
 * caller for thirty seconds on the theory that somebody might arrive. It opens levels downward until
 * one has a staffing agent, or until they are all open.
 */
export function openLevels(input: {
	readonly membership: QueueMembership;
	readonly waitedMs: number;
	/** Agent ids that count as staffing. Only consulted for `tierRuleNoAgentNoWait`. */
	readonly staffingAgentIds: ReadonlySet<string>;
}): readonly number[] {
	const levels = [...new Set(input.membership.agents.map((agent) => agent.level))].sort(
		(a, b) => a - b,
	);
	if (levels.length === 0) {
		return [];
	}
	if (!input.membership.tierRulesApply || input.membership.tierRuleWaitSeconds === 0) {
		return levels;
	}

	const step = input.membership.tierRuleWaitSeconds * MILLIS_PER_SECOND;
	let opened = Math.min(levels.length, 1 + Math.floor(input.waitedMs / step));

	if (input.membership.tierRuleNoAgentNoWait) {
		while (opened < levels.length) {
			const open = new Set(levels.slice(0, opened));
			const staffed = input.membership.agents.some(
				(agent) => open.has(agent.level) && input.staffingAgentIds.has(agent.agentId),
			);
			if (staffed) {
				break;
			}
			opened += 1;
		}
	}

	return levels.slice(0, opened);
}

/** (level, position, agentId) — the stable total order every other comparator falls back to. */
export function compareByTier(left: QueueCandidate, right: QueueCandidate): number {
	if (left.agent.level !== right.agent.level) {
		return left.agent.level - right.agent.level;
	}
	if (left.agent.position !== right.agent.position) {
		return left.agent.position - right.agent.position;
	}
	// Ids, not names: two agents can share a name, and a comparator that returned 0 for them would
	// make the whole order depend on the roster's array order, which the control plane does not pin.
	return left.agent.agentId < right.agent.agentId ? -1 : 1;
}

/**
 * Most-idle first, tie-broken by tier.
 *
 * The tie-break is not decoration: two agents who came free in the same millisecond is the normal
 * case at the start of a shift, and without it the winner would be whichever order the roster
 * happened to arrive in — so the "top" agent would change between two engine instances reading the
 * same bucket.
 */
export function compareByIdle(left: QueueCandidate, right: QueueCandidate): number {
	if (left.idleMs !== right.idleMs) {
		return right.idleMs - left.idleMs;
	}
	return compareByTier(left, right);
}

/** One skill and the level an agent must have reached to take this caller, right now. */
export interface QueueSkillBar {
	readonly skill: string;
	/** After relaxation. `0` is a bar nobody can fail and is therefore never applied. */
	readonly minLevel: number;
}

/**
 * The queue's requirements and the entrance's, as one set.
 *
 * Where both name the same skill the HIGHER `minLevel` wins, and the reasoning is written down on
 * `QueuePlanNode.requiredSkills`: a queue insisting on level 3 and a door insisting on level 4 have
 * each been told something the other has not, and taking the lower would let an IVR option quietly
 * weaken the queue's own bar. The winner brings its own `relaxAfterSeconds` with it — the pair is
 * one statement ("level 4, and I will come down from it this fast"), and splitting it would produce
 * a bar neither side asked for.
 */
export function mergeSkillRequirements(
	queue: readonly QueueSkillRequirement[] | undefined,
	entrance: readonly QueueSkillRequirementPlan[] | undefined,
): readonly QueueSkillRequirement[] {
	const merged = new Map<string, QueueSkillRequirement>();
	for (const requirement of [...(queue ?? []), ...(entrance ?? [])]) {
		const existing = merged.get(requirement.skill);
		if (existing === undefined || requirement.minLevel > existing.minLevel) {
			merged.set(requirement.skill, requirement);
		}
	}
	return [...merged.values()];
}

const SKILL_LEVEL_ABSENT = 0;

/**
 * What each requirement actually demands of an agent after `waitedMs` of waiting.
 *
 * `relaxAfterSeconds` of 0 never relaxes — the bar stays at `minLevel` for as long as the caller is
 * prepared to hold, which is the correct and only safe reading for a regulated skill. Otherwise the
 * bar drops one level per whole `relaxAfterSeconds` elapsed and floors at 0, which excludes nobody:
 * a queue that has waited long enough has said it would rather be answered than be answered well.
 */
export function effectiveSkillBars(
	requirements: readonly QueueSkillRequirement[] | undefined,
	waitedMs: number,
): readonly QueueSkillBar[] {
	if (requirements === undefined || requirements.length === 0) {
		return [];
	}
	return requirements.map((requirement) => {
		if (requirement.relaxAfterSeconds === 0) {
			return { skill: requirement.skill, minLevel: requirement.minLevel };
		}
		const steps = Math.floor(waitedMs / (requirement.relaxAfterSeconds * MILLIS_PER_SECOND));
		return {
			skill: requirement.skill,
			minLevel: Math.max(0, requirement.minLevel - steps),
		};
	});
}

/**
 * Whether one agent clears every bar.
 *
 * A skill the agent has no row for is level 0, which is not the same as being unskilled at it — see
 * `queueMembershipAgentSchema.skills`. It only costs them a queue whose bar has not yet relaxed
 * to 0.
 */
export function clearsSkillBars(
	agent: QueueMembershipAgent,
	bars: readonly QueueSkillBar[],
): boolean {
	for (const bar of bars) {
		if (bar.minLevel <= 0) {
			continue;
		}
		const level =
			agent.skills?.find((skill) => skill.skill === bar.skill)?.level ?? SKILL_LEVEL_ABSENT;
		if (level < bar.minLevel) {
			return false;
		}
	}
	return true;
}

/**
 * Joins the roster with live state and drops everyone who cannot be rung.
 *
 * Five filters, in the order a human would apply them: the seat is enabled, the level is open, the
 * agent has not already been tried by this caller, their live state says eligible, and they clear
 * the caller's skill bars. The last one is here rather than in a comparator for the reason the
 * levels are — see this file's header.
 */
export function eligibleCandidates(input: {
	readonly membership: QueueMembership;
	readonly states: ReadonlyMap<string, AgentStateEntry>;
	readonly openLevels: readonly number[];
	readonly excludedAgentIds?: ReadonlySet<string>;
	/** Already relaxed for this caller's wait. Empty means the queue asks for nothing. */
	readonly skillBars?: readonly QueueSkillBar[];
	readonly now: number;
	readonly isEligible: (state: AgentStateEntry | undefined, now: number) => boolean;
}): readonly QueueCandidate[] {
	const open = new Set(input.openLevels);
	const bars = input.skillBars ?? [];
	const candidates: QueueCandidate[] = [];

	for (const agent of input.membership.agents) {
		if (!agent.enabled || !open.has(agent.level)) {
			continue;
		}
		if (input.excludedAgentIds?.has(agent.agentId) === true) {
			continue;
		}
		const state = input.states.get(agent.agentId);
		if (!input.isEligible(state, input.now) || state === undefined) {
			continue;
		}
		if (!clearsSkillBars(agent, bars)) {
			continue;
		}
		candidates.push({ agent, state, idleMs: idleMsOf(state, input.now) });
	}

	return candidates;
}

/**
 * Rotates a tier-ordered list so it starts after `afterAgentId`.
 *
 * When that agent is no longer in the list — they logged out, or went on a call — the rotation
 * falls back to the top rather than to a guess. `round-robin` is a fairness heuristic, not a
 * ledger: losing the cursor costs one caller their turn order and nothing else, whereas trying to
 * reconstruct "who would have been next" from a roster that has changed underneath it is how a
 * cursor ends up permanently stuck on one agent.
 */
export function rotateAfter(
	ordered: readonly QueueCandidate[],
	afterAgentId: string | undefined,
): readonly QueueCandidate[] {
	if (afterAgentId === undefined || ordered.length === 0) {
		return ordered;
	}
	const index = ordered.findIndex((candidate) => candidate.agent.agentId === afterAgentId);
	if (index < 0) {
		return ordered;
	}
	const start = (index + 1) % ordered.length;
	return [...ordered.slice(start), ...ordered.slice(0, start)];
}

/**
 * A Fisher-Yates shuffle over an injected RNG.
 *
 * Written out rather than `sort(() => Math.random() - 0.5)`, which is not a shuffle: it produces a
 * measurably biased order and, with some engines' unstable sorts, is not even a permutation.
 */
export function shuffled(
	ordered: readonly QueueCandidate[],
	random: () => number,
): readonly QueueCandidate[] {
	const result = [...ordered];
	for (let index = result.length - 1; index > 0; index -= 1) {
		const swap = Math.floor(random() * (index + 1));
		const left = result[index] as QueueCandidate;
		result[index] = result[swap] as QueueCandidate;
		result[swap] = left;
	}
	return result;
}

/**
 * The whole selection, for one attempt.
 *
 * Returns an EMPTY `ordered` when nobody is reachable, which is a real answer and not a failure: the
 * caller keeps waiting and the runtime tries again on its next pass. Distinguishing "nobody is
 * eligible right now" from "this queue has nobody at all" is `maxWaitNoAgentSeconds`' job, and it
 * asks a different question (staffing, not eligibility).
 */
export function selectAgents(input: SelectionInput): QueueSelection {
	const staffing = new Set(
		[...input.states.entries()]
			.filter(([, state]) => isStaffing(state))
			.map(([agentId]) => agentId),
	);

	const levels = openLevels({
		membership: input.membership,
		waitedMs: input.waitedMs,
		staffingAgentIds: staffing,
	});

	const bars = effectiveSkillBars(input.skillRequirements, input.waitedMs);

	const common = {
		membership: input.membership,
		states: input.states,
		openLevels: levels,
		...(input.excludedAgentIds === undefined ? {} : { excludedAgentIds: input.excludedAgentIds }),
		now: input.now,
		isEligible: isEligibleForDistribution,
	};

	const candidates = eligibleCandidates({ ...common, skillBars: bars });
	const skilledOut =
		candidates.length === 0 && bars.length > 0 ? eligibleCandidates(common).length : 0;

	const ordered = orderFor(input, candidates);

	return {
		strategy: input.strategy,
		ordered,
		fanOut: input.strategy === "ring-all" ? "all" : "one",
		openLevels: levels,
		skillBars: bars,
		skilledOut,
	};
}

function orderFor(
	input: SelectionInput,
	candidates: readonly QueueCandidate[],
): readonly QueueCandidate[] {
	switch (input.strategy) {
		case "longest-idle": {
			return [...candidates].sort(compareByIdle);
		}
		case "round-robin": {
			return rotateAfter([...candidates].sort(compareByTier), input.roundRobinAfterAgentId);
		}
		case "random": {
			// No sort first: a Fisher-Yates over an already-ordered array has exactly the distribution
			// of one over the unordered array, so `random` deliberately discards the tier order. Tiers
			// are still honoured where they decide anything — eligibility is applied before this.
			return shuffled(candidates, input.random ?? Math.random);
		}
		default: {
			// `ring-all`, `top-down` and `sequential` all present the tier order. The difference
			// between the last two is WHEN the order is computed, which is the runtime's decision (it
			// freezes the list for `sequential`), not the comparator's.
			return [...candidates].sort(compareByTier);
		}
	}
}
