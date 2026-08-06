import { AGENT_STATUSES, type AgentStatus } from "./telephony";

/**
 * The ACD agent state machine — the WHOLE of it, for both writers.
 *
 * ## Why the machine is here and not in either application
 *
 * An agent's status has two kinds of cause, and each is visible to exactly one process.
 *
 * **Shift transitions** — login, logout, "back in ten minutes" — are made by a human in a UI, land
 * in `apps/api`, and are the control plane's to write. A call engine cannot observe them, cannot
 * infer them, and must never guess at them: an engine that decided an agent was logged out because
 * their phone did not answer would take somebody off the roster for being in a meeting.
 *
 * **Call transitions** — ringing, on-call, wrap-up, and back to available — are made by the switch,
 * are invisible to the API, and are the engine's to write. Nothing else in the system knows that a
 * distribution just selected this agent, and nothing else knows when their call ended.
 *
 * Both writers put their result in ONE bucket ({@link import("./queue-state").agentStateEntrySchema}),
 * and both readers — distribution and the wallboard — have to be able to validate any entry they
 * find, whoever wrote it. A machine that lived in one application would therefore be either
 * duplicated or half-known, and the failure mode of a half-known machine is silent: the process
 * that does not know an edge exists treats a legitimate entry as corrupt and falls back to
 * `logged-out`, which reads as "nobody is working this queue".
 *
 * `packages/events` already owns the bucket definition, the key builder and the value schema. The
 * rules that say which values may follow which belong with them, for the same reason the payloads
 * belong with the subjects: the contract is the whole thing, and splitting it is how the halves end
 * up disagreeing.
 *
 * ## Not in the Go codegen registry
 *
 * Same argument as `queue-state.ts`: `apps/sipd` is a location service and has no reason to know
 * what wrap-up is. `scripts/registry.ts` names what crosses the language border, and this does not.
 *
 * ## Provenance
 *
 * {@link VALID_AGENT_TRANSITIONS} and {@link ENGINE_DRIVEN_TRANSITIONS} were lifted verbatim from
 * `apps/engine/src/queue/agent-state.ts`, which is where they were first written and which still
 * carries its own copy. That file should import from here instead — it is a two-line change and a
 * deleted const block — and it is recorded as a follow-up rather than done in this wave because the
 * engine was owned by another change at the time.
 */

export type { AgentStatus };

/**
 * Adjacency of the machine, across both writers.
 *
 * Invariants pinned by the spec:
 * 1. `logged-out` is reachable from every state — an agent can always go home, including mid-call
 *    (their leg is torn down by the call, not by this machine).
 * 2. No state lists itself. A re-entry is not a transition and must not produce an `agent.state`
 *    event, because a wallboard reading the stream as a transition log would show a flapping agent.
 * 3. `ringing` is reachable ONLY from `available`. Distribution selects an available agent; there is
 *    no path that starts a ring at somebody on a break, and a machine that allowed one would let a
 *    dropped state update turn into a call at a phone nobody is sitting at.
 * 4. `on-call` is reachable only from `ringing` — a call the engine did not ring for is not a queue
 *    call, and filing it as one would corrupt the agent's handled-call count.
 */
export const VALID_AGENT_TRANSITIONS = {
	"logged-out": ["available", "on-break", "unavailable"],
	available: ["ringing", "wrap-up", "on-break", "unavailable", "logged-out"],
	ringing: ["on-call", "available", "unavailable", "on-break", "logged-out"],
	"on-call": ["wrap-up", "available", "unavailable", "logged-out"],
	"wrap-up": ["available", "on-break", "unavailable", "logged-out"],
	"on-break": ["available", "unavailable", "logged-out"],
	unavailable: ["available", "on-break", "logged-out"],
} as const satisfies Record<AgentStatus, readonly AgentStatus[]>;

/** One edge of the machine. */
export type AgentTransition = readonly [AgentStatus, AgentStatus];

/**
 * The transitions the ENGINE may write.
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
export const ENGINE_DRIVEN_TRANSITIONS: readonly AgentTransition[] = [
	["available", "ringing"],
	["ringing", "on-call"],
	["ringing", "available"],
	["ringing", "unavailable"],
	["on-call", "wrap-up"],
	["on-call", "available"],
	["wrap-up", "available"],
];

/**
 * The transitions the CONTROL PLANE may write — the shift half of the machine.
 *
 * Derived from the four actions the agent-session surface exposes rather than listed freehand, so
 * "which edges may the API write?" and "which buttons does the console have?" cannot drift apart:
 *
 * - **login** — anything not already working, to `available`.
 * - **logout** — anything at all, to `logged-out`. An agent can always go home.
 * - **pause** — anything the machine lets reach `on-break`.
 * - **resume** — a paused or unavailable agent, back to `available`.
 *
 * Two of these overlap with the engine's list, and that is correct rather than a conflict:
 * `ringing → unavailable` is written by the engine when a phone rings out three times and by the
 * API when a supervisor takes somebody off the floor while their phone happens to be ringing. The
 * bucket holds one value; the `source` field on the entry records which process last wrote it.
 *
 * `wrap-up → available` is deliberately NOT here even though the machine has it: ending after-call
 * work is the engine's observation of a deadline, and an API that could write it would hand an
 * agent a button that skips the wrap-up their supervisor configured.
 */
export const AGENT_SESSION_ACTIONS = ["login", "logout", "pause", "resume"] as const;
export type AgentSessionAction = (typeof AGENT_SESSION_ACTIONS)[number];

/** The status each action moves an agent TO. The action never names a status; this does. */
export const AGENT_SESSION_ACTION_TARGET = {
	login: "available",
	logout: "logged-out",
	pause: "on-break",
	resume: "available",
} as const satisfies Record<AgentSessionAction, AgentStatus>;

/**
 * The statuses each action may be applied FROM.
 *
 * Stated rather than derived from {@link VALID_AGENT_TRANSITIONS} because "the machine has this
 * edge" and "this button may produce it" are different questions. `wrap-up → available` is an edge
 * the machine has and `resume` must not produce; `available → wrap-up` is an edge the machine has
 * and no action produces at all.
 */
export const AGENT_SESSION_ACTION_SOURCES = {
	login: ["logged-out", "on-break", "unavailable"],
	logout: ["logged-out", "available", "ringing", "on-call", "wrap-up", "on-break", "unavailable"],
	pause: ["logged-out", "available", "ringing", "wrap-up", "unavailable"],
	resume: ["on-break", "unavailable"],
} as const satisfies Record<AgentSessionAction, readonly AgentStatus[]>;

export const API_DRIVEN_TRANSITIONS: readonly AgentTransition[] = AGENT_SESSION_ACTIONS.flatMap(
	(action) =>
		AGENT_SESSION_ACTION_SOURCES[action]
			.filter((from) => from !== AGENT_SESSION_ACTION_TARGET[action])
			.map((from): AgentTransition => [from, AGENT_SESSION_ACTION_TARGET[action]]),
);

/**
 * Why a transition was refused.
 *
 * `not-this-action` is separate from `not-api-driven` on purpose: "resume an agent who is logged
 * out" names an edge the control plane owns (`logged-out → available`) but the wrong button for it,
 * and telling the operator "that transition belongs to the engine" would send them looking for a
 * bug in the switch instead of pressing Log in.
 */
export const AGENT_TRANSITION_REFUSALS = [
	"not-adjacent",
	"not-engine-driven",
	"not-api-driven",
	"not-this-action",
] as const;
export type AgentTransitionRefusal = (typeof AGENT_TRANSITION_REFUSALS)[number];

/** Raised when a transition is refused. Carries both ends, so the log says what was attempted. */
export class InvalidAgentTransitionError extends Error {
	readonly _tag = "InvalidAgentTransitionError" as const;
	readonly from: AgentStatus;
	readonly to: AgentStatus;
	readonly reason: AgentTransitionRefusal;

	constructor(from: AgentStatus, to: AgentStatus, reason: AgentTransitionRefusal) {
		super(messageFor(from, to, reason));
		this.name = "InvalidAgentTransitionError";
		this.from = from;
		this.to = to;
		this.reason = reason;
	}
}

function messageFor(from: AgentStatus, to: AgentStatus, reason: AgentTransitionRefusal): string {
	switch (reason) {
		case "not-adjacent":
			return `An agent cannot go from "${from}" to "${to}".`;
		case "not-engine-driven":
			return `"${from}" -> "${to}" is not a transition the engine may write; it belongs to the control plane.`;
		case "not-api-driven":
			return `"${from}" -> "${to}" is not a transition the control plane may write; it belongs to the engine.`;
		case "not-this-action":
			return `An agent who is "${from}" cannot be moved to "${to}" by this action.`;
	}
}

/** Whether the machine has this edge at all, by either writer. */
export function canAgentTransition(from: AgentStatus, to: AgentStatus): boolean {
	return (VALID_AGENT_TRANSITIONS[from] as readonly AgentStatus[]).includes(to);
}

/** Whether the ENGINE may write it. */
export function isEngineDrivenTransition(from: AgentStatus, to: AgentStatus): boolean {
	return ENGINE_DRIVEN_TRANSITIONS.some(([start, end]) => start === from && end === to);
}

/** Whether the CONTROL PLANE may write it. */
export function isApiDrivenTransition(from: AgentStatus, to: AgentStatus): boolean {
	return API_DRIVEN_TRANSITIONS.some(([start, end]) => start === from && end === to);
}

/**
 * Guard-then-execute for the engine. Throws rather than returning a boolean, because every call
 * site is about to perform a KV write and an ignored `false` is a write that happens anyway.
 */
export function assertEngineAgentTransition(from: AgentStatus, to: AgentStatus): void {
	if (!canAgentTransition(from, to)) {
		throw new InvalidAgentTransitionError(from, to, "not-adjacent");
	}
	if (!isEngineDrivenTransition(from, to)) {
		throw new InvalidAgentTransitionError(from, to, "not-engine-driven");
	}
}

/** The same, for the control plane. */
export function assertApiAgentTransition(from: AgentStatus, to: AgentStatus): void {
	if (!canAgentTransition(from, to)) {
		throw new InvalidAgentTransitionError(from, to, "not-adjacent");
	}
	if (!isApiDrivenTransition(from, to)) {
		throw new InvalidAgentTransitionError(from, to, "not-api-driven");
	}
}

/**
 * What an action would do to an agent currently in `from`.
 *
 * `"no-op"` is the third outcome and the reason this returns a verdict rather than throwing:
 * logging in an agent who is already available, or logging out one who is already logged out, is a
 * button pressed twice — a double-tap, a retried request, two tabs open — and answering it with an
 * error would make the console's own idempotence the user's problem. It is distinguished from
 * `"apply"` so the caller can skip the write and the `agent.state` event, which keeps the
 * transition log free of edges that did not happen.
 */
export type AgentSessionPlan =
	| { readonly outcome: "no-op"; readonly to: AgentStatus }
	| { readonly outcome: "apply"; readonly to: AgentStatus }
	| {
			readonly outcome: "refused";
			readonly to: AgentStatus;
			readonly error: InvalidAgentTransitionError;
	  };

export function planAgentSessionAction(
	action: AgentSessionAction,
	from: AgentStatus,
): AgentSessionPlan {
	const to = AGENT_SESSION_ACTION_TARGET[action];
	if (from === to) {
		return { outcome: "no-op", to };
	}
	if (!(AGENT_SESSION_ACTION_SOURCES[action] as readonly AgentStatus[]).includes(from)) {
		return {
			outcome: "refused",
			to,
			error: new InvalidAgentTransitionError(
				from,
				to,
				!canAgentTransition(from, to)
					? "not-adjacent"
					: isApiDrivenTransition(from, to)
						? "not-this-action"
						: "not-api-driven",
			),
		};
	}
	return { outcome: "apply", to };
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

/** Every status, re-exported so a spec can assert the machine covers the vocabulary exactly. */
export const AGENT_STATUS_VALUES: readonly AgentStatus[] = AGENT_STATUSES;
