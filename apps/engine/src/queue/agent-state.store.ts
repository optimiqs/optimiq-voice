import { Injectable } from "@nestjs/common";
import { agentStateEntrySchema, kvKeyFor } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { JetStreamService } from "../nats/jetstream.service";
import {
	absentAgentState,
	assertAgentTransition,
	InvalidAgentTransitionError,
} from "./agent-state";
import { QueueEventPublisher } from "./queue-event-publisher.service";
import type { AgentStatePort, AgentTransitionRequest } from "./queue-session";
import type { AgentStateEntry } from "@optimiq-voice/events";

/** The `noAnswerCount` a write should carry: the requested one, else the existing one, else none. */
export function noAnswerCountOf(
	requested: number | undefined,
	current: number | undefined,
): { noAnswerCount?: number } {
	if (requested !== undefined) {
		return { noAnswerCount: requested };
	}
	return current === undefined ? {} : { noAnswerCount: current };
}

/**
 * The engine's writer for the `agent-state` bucket.
 *
 * ## Read-guard-write, in that order, always
 *
 * Every transition reads the current entry, runs {@link assertAgentTransition} against it, and only
 * then writes. The read is not an optimisation — it is what the guard needs, and it is what makes a
 * refused transition possible at all. A blind `put` would let this process mark an agent `on-call`
 * who logged out thirty seconds ago, and the next thing that happened would be a caller waiting for
 * a phone that is switched off.
 *
 * A refusal is `undefined`, not an exception, because every caller is a queued call: the session
 * reads `undefined` as "this agent is not mine to ring" and moves to the next candidate, which is
 * both correct and non-fatal. The refusal IS logged at warn, because a persistent one means this
 * engine and the control plane disagree about somebody's shift.
 *
 * ## The event follows the write, never precedes it
 *
 * `queue.evt.v1.<org>._all.agent.state` goes out only after the bucket write succeeded. A wallboard
 * that showed a transition the bucket does not hold would be reporting a state no distribution will
 * ever act on, and the operator watching it would be the last to know.
 *
 * ## What this does NOT write
 *
 * Login, logout and manual pause. See `agent-state.ts`: those are the control plane's, the guard
 * refuses them from here, and the refusal is deliberate rather than an omission.
 */
@Injectable()
export class AgentStateStore implements AgentStatePort {
	private readonly logger = getLogger("engine.agent-state");
	private writes = 0;
	private refusals = 0;
	private failures = 0;

	constructor(
		private readonly jetstream: JetStreamService,
		private readonly events: QueueEventPublisher,
	) {}

	get stats(): {
		readonly writes: number;
		readonly refusals: number;
		readonly failures: number;
	} {
		return { writes: this.writes, refusals: this.refusals, failures: this.failures };
	}

	/**
	 * Live state for a whole roster.
	 *
	 * One `get` per agent rather than a range read: the bucket is keyed `<orgId>.<agentId>` and a
	 * range over `<orgId>.*` would return every agent in the tenant, most of whom are not in this
	 * queue. A roster is tens of entries, the reads are parallel, and the bucket is memory-speed for
	 * anything already in the server's cache.
	 *
	 * Agents whose entry cannot be read are simply ABSENT from the returned map, which the selection
	 * treats as ineligible. That is the safe direction: a broker hiccup makes a queue quieter, not
	 * one that rings phones on the strength of a guess.
	 */
	async readStates(
		orgId: string,
		agentIds: readonly string[],
	): Promise<Map<string, AgentStateEntry>> {
		const states = new Map<string, AgentStateEntry>();
		const bucket = this.jetstream.agentState;
		if (bucket === undefined || agentIds.length === 0) {
			return states;
		}

		await Promise.all(
			agentIds.map(async (agentId) => {
				const entry = await this.read(orgId, agentId);
				if (entry !== undefined) {
					states.set(agentId, entry);
				}
			}),
		);
		return states;
	}

	/** One agent's entry, or `undefined` when it is absent or unreadable. */
	async read(orgId: string, agentId: string): Promise<AgentStateEntry | undefined> {
		const bucket = this.jetstream.agentState;
		if (bucket === undefined) {
			return undefined;
		}
		let key: string;
		try {
			key = kvKeyFor.agentState(orgId, agentId);
		} catch {
			return undefined;
		}
		try {
			const entry = await bucket.get(key);
			if (entry === null || entry.value.length === 0) {
				return undefined;
			}
			return agentStateEntrySchema.parse(JSON.parse(new TextDecoder().decode(entry.value)));
		} catch (error) {
			this.logger.warn(
				{ orgId, agentId, err: String(error) },
				"discarding an unreadable agent-state entry",
			);
			return undefined;
		}
	}

	/**
	 * Applies one transition.
	 *
	 * The `from` is whatever the bucket currently holds, and an agent with no entry is treated as
	 * `logged-out` — see `ABSENT_AGENT_STATUS` for why that direction and not the other. So the very
	 * first transition the engine attempts for an agent nobody has logged in is refused, which is
	 * correct: distribution should never have selected them, and if it did, something upstream is
	 * reading eligibility wrong.
	 */
	async transition(request: AgentTransitionRequest): Promise<AgentStateEntry | undefined> {
		const bucket = this.jetstream.agentState;
		if (bucket === undefined) {
			return undefined;
		}

		let key: string;
		try {
			key = kvKeyFor.agentState(request.orgId, request.agentId);
		} catch (error) {
			this.logger.warn(
				{ orgId: request.orgId, agentId: request.agentId, err: String(error) },
				"not a valid agent-state key",
			);
			return undefined;
		}

		const now = Date.now();
		const current =
			(await this.read(request.orgId, request.agentId)) ??
			absentAgentState(request.orgId, request.agentId, now);

		if (current.status === request.to) {
			// A no-op re-entry is not a transition. Returning the existing entry rather than writing
			// keeps the `agent.state` stream a transition LOG: a wallboard rendering it as one would
			// otherwise show an agent flapping between a state and itself.
			return current;
		}

		try {
			assertAgentTransition(current.status, request.to);
		} catch (error) {
			this.refusals += 1;
			this.logger.warn(
				{
					orgId: request.orgId,
					agentId: request.agentId,
					from: current.status,
					to: request.to,
					reason: error instanceof InvalidAgentTransitionError ? error.reason : "unknown",
				},
				"refusing an agent state transition",
			);
			return undefined;
		}

		const next: AgentStateEntry = {
			orgId: request.orgId,
			agentId: request.agentId,
			status: request.to,
			since: new Date(now).toISOString(),
			previousStatus: current.status,
			source: "engine",
			...(request.availableAt === undefined
				? {}
				: { availableAt: new Date(request.availableAt).toISOString() }),
			// The count CARRIES unless the caller replaces it: an agent who rang out twice and is now
			// being released for a third time must not have their history reset by a write that was
			// not about the count.
			...noAnswerCountOf(request.noAnswerCount, current.noAnswerCount),
			...(request.callId === undefined ? {} : { callId: request.callId }),
			...(request.legId === undefined ? {} : { legId: request.legId }),
			...(request.queueId === undefined ? {} : { queueId: request.queueId }),
			...(request.reason === undefined ? {} : { reason: request.reason }),
		};

		try {
			await bucket.put(key, new TextEncoder().encode(JSON.stringify(next)));
			this.writes += 1;
		} catch (error) {
			this.failures += 1;
			this.logger.warn(
				{ orgId: request.orgId, agentId: request.agentId, err: String(error) },
				"failed to write agent state to KV; the transition was not applied",
			);
			return undefined;
		}

		await this.events.agentState({
			orgId: request.orgId,
			queueId: request.queueId,
			agentId: request.agentId,
			status: next.status,
			previousStatus: current.status,
			...(request.reason === undefined ? {} : { reason: request.reason }),
		});

		return next;
	}
}
