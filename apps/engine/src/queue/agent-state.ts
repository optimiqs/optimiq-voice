import {
	AGENT_STATUSES,
	ENGINE_DRIVEN_TRANSITIONS,
	VALID_AGENT_TRANSITIONS,
	type AgentStateEntry,
	type AgentStatus,
} from "@optimiq-voice/events";

export { ENGINE_DRIVEN_TRANSITIONS, VALID_AGENT_TRANSITIONS };

/**
 * The ACD agent state machine — the engine's half of it.
 *
 * ## What the engine owns and what it does not
 *
 * An agent's status has two kinds of cause, and only one of them is visible from a call engine.
 *
 * **Shift transitions** — login, logout, "back in ten minutes" — are made by a human in a UI, land
 * in `apps/api`, and are the API's to write. The engine cannot observe them, cannot infer them, and
 * must never guess at them: an engine that decided an agent was logged out because their phone did
 * not answer would take somebody off the roster for being in a meeting.
 *
 * **Call transitions** — ringing, on-call, wrap-up, and back to available — are made by the switch,
 * are invisible to the API, and are the engine's to write. Nothing else in the system knows that a
 * distribution just selected this agent, and nothing else knows when their call ended.
 *
 * So this machine models BOTH (a reader has to be able to validate any entry it finds) but the
 * engine only ever drives the second set. {@link ENGINE_DRIVEN_TRANSITIONS} names them explicitly,
 * and {@link assertAgentTransition} refuses anything else from this process — the guard exists so
 * that a future refactor cannot quietly give the engine the power to log somebody out.
 *
 * ## Eligibility is not the status
 *
 * {@link isEligibleForDistribution} is the question distribution actually asks, and it is NOT
 * "status === available". An agent can be `available` and ineligible (serving a no-answer penalty),
 * and an agent can be in `wrap-up` and eligible (their deadline passed and nobody has written the
 * transition yet, because the engine that took their call is not necessarily the one distributing
 * the next caller). Reading the status alone rings people who just declined; reading the deadline
 * alone rings people who went home. Both, always.
 *
 * Per the oikos convention this is a `VALID_TRANSITIONS` const with guard-then-execute: the guard
 * runs BEFORE the KV write, never after.
 */

export type { AgentStatus };

/**
 * The adjacency tables live in `@optimiq-voice/events` (`agent-state-machine.ts`) so this process
 * and the api's session endpoints validate against ONE machine — they are re-exported above for
 * existing importers. The invariants (logged-out reachable from everywhere, no self-edges,
 * `ringing` only from `available`, `on-call` only from `ringing`) are pinned by the shared
 * package's spec; `agent-state.spec.ts` here pins the engine-side split below.
 *
 * The transitions THIS process may write.
 *
 * Everything here is a fact the switch observed and nothing else in the system can see:
 *
 * - `available → ringing` — a distribution selected this agent and their leg is being originated.
 * - `ringing → on-call` — they answered and are being bridged to the caller.
 * - `ringing → available` — they did not answer, or lost a ring-all race. Back in the pool, with a
 *   penalty deadline the caller-facing loop sets.
 * - `ringing → unavailable` — their consecutive no-answer count reached the queue's `maxNoAnswer`.
 *   `mod_callcenter` does the same thing, for the same reason: a phone that rings out three times in
 *   a row is unplugged, and continuing to send it callers costs each of them a full ring timeout.
 * - `on-call → wrap-up` and `wrap-up → available` — the two halves of after-call work.
 * - `on-call → available` — the same, for a queue whose `wrapUpSeconds` is zero.
 *
 * `logged-out`, `on-break` and the `unavailable` an agent sets by hand are deliberately absent.
 */

/** Raised when a transition is refused. Carries both ends, so the log says what was attempted. */
export class InvalidAgentTransitionError extends Error {
	readonly name = "InvalidAgentTransitionError";

	constructor(
		readonly from: AgentStatus,
		readonly to: AgentStatus,
		readonly reason: "not-adjacent" | "not-engine-driven",
	) {
		super(
			reason === "not-adjacent"
				? `An agent cannot go from "${from}" to "${to}".`
				: `"${from}" -> "${to}" is not a transition the engine may write; it belongs to the control plane.`,
		);
	}
}

/** Whether the machine has this edge at all, by either writer. */
export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
	return (VALID_AGENT_TRANSITIONS[from] as readonly AgentStatus[]).includes(to);
}

/** Whether THIS process may write it. */
export function isEngineDriven(from: AgentStatus, to: AgentStatus): boolean {
	return ENGINE_DRIVEN_TRANSITIONS.some(([start, end]) => start === from && end === to);
}

/**
 * Guard-then-execute. Throws rather than returning a boolean, because every call site is about to
 * perform a KV write and an ignored `false` is a write that happens anyway.
 */
export function assertAgentTransition(from: AgentStatus, to: AgentStatus): void {
	if (!canTransition(from, to)) {
		throw new InvalidAgentTransitionError(from, to, "not-adjacent");
	}
	if (!isEngineDriven(from, to)) {
		throw new InvalidAgentTransitionError(from, to, "not-engine-driven");
	}
}

/**
 * The state an agent the bucket has never heard of is treated as being in.
 *
 * `logged-out`, and therefore ineligible. The alternative — treating an absent entry as available —
 * would make an empty bucket look like a fully staffed queue and send every caller to a phone that
 * may not exist. A queue that rings nobody because nobody has logged in is correct; a queue that
 * rings everybody because the control plane has not written yet is an outage.
 */
export const ABSENT_AGENT_STATUS = "logged-out" satisfies AgentStatus;

/** How long an agent has been in their current state, in millis. Negative clock skew reads as 0. */
export function idleMsOf(entry: AgentStateEntry, now: number): number {
	const since = Date.parse(entry.since);
	if (Number.isNaN(since)) {
		// An unparseable timestamp must not sort as "idle since the epoch" and win every
		// longest-idle selection. Treated as just-changed, which loses the tie-break instead.
		return 0;
	}
	return Math.max(0, now - since);
}

/** Whether an entry's penalty / wrap-up deadline has passed. Absent deadline means "yes". */
export function isPastDeadline(entry: AgentStateEntry, now: number): boolean {
	if (entry.availableAt === undefined) {
		return true;
	}
	const at = Date.parse(entry.availableAt);
	// An unreadable deadline is treated as passed rather than as forever: the failure mode of
	// ringing somebody a second early is a declined call, and of never ringing them is a lost shift.
	return Number.isNaN(at) || now >= at;
}

/**
 * The one question distribution asks.
 *
 * `available` past its deadline, or `wrap-up` past its deadline — the second case is what makes the
 * runtime correct across instances and restarts, where nobody is left to write the transition.
 * Every other status is a human decision this process must not override.
 */
export function isEligibleForDistribution(
	entry: AgentStateEntry | undefined,
	now: number,
): entry is AgentStateEntry {
	if (entry === undefined) {
		return false;
	}
	if (entry.status !== "available" && entry.status !== "wrap-up") {
		return false;
	}
	return isPastDeadline(entry, now);
}

/**
 * Whether an agent counts as ON the roster for `maxWaitNoAgentSeconds`.
 *
 * Deliberately broader than eligibility: an agent on a call, in wrap-up or on a five-minute break
 * IS staffing the queue, and ejecting a caller because everyone happens to be busy right now is the
 * opposite of what that setting is for. Only `logged-out` — and an agent the bucket has never heard
 * of — means "nobody is working this queue".
 */
export function isStaffing(entry: AgentStateEntry | undefined): boolean {
	return entry !== undefined && entry.status !== "logged-out";
}

/** The entry an unseen agent is treated as having, so callers never branch on `undefined`. */
export function absentAgentState(orgId: string, agentId: string, now: number): AgentStateEntry {
	return {
		orgId,
		agentId,
		status: ABSENT_AGENT_STATUS,
		since: new Date(now).toISOString(),
	};
}

/** Every status, re-exported so a spec can assert the machine covers the vocabulary exactly. */
export const AGENT_STATUS_VALUES: readonly AgentStatus[] = AGENT_STATUSES;
