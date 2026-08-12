import { assertAgentTransition, isEligibleForDistribution } from "./agent-state";
import { noAnswerCountOf } from "./agent-state.store";
import { QueueCursors } from "./queue-registry";
import { QueueWaitingStore } from "./queue-waiting.store";
import type {
	AgentStatePort,
	AgentTransitionRequest,
	QueueEventPort,
	QueueMembershipPort,
	QueueServices,
} from "./queue-session";
import type {
	AgentStateEntry,
	AgentStatus,
	QueueMembership,
	QueueMembershipAgent,
} from "@optimiq-voice/events";

/**
 * In-memory {@link QueueServices}, so a queued call runs with no NATS and no Asterisk.
 *
 * Test scaffolding, not product code: excluded from `tsconfig.build.json` by the `*.fake.ts`
 * pattern, exactly as `media-port.fake.ts` is.
 *
 * The agent store is a REAL state machine over a fake bucket, not a recorder that accepts anything.
 * That distinction is the point: a fake that let `logged-out → on-call` through would make the
 * session's specs pass for a transition production refuses, and the first time anyone noticed would
 * be a queue that rang somebody who had gone home.
 *
 * Every write is appended to {@link FakeAgentStateStore.transitions} in order, because the
 * assertion most session specs want is not "was wrap-up written" but "was it written AFTER the
 * answer, and was the loser released without a penalty".
 */

// ---------------------------------------------------------------------------------------------
// Rosters
// ---------------------------------------------------------------------------------------------

export function fakeAgent(
	agentId: string,
	overrides: Partial<QueueMembershipAgent> = {},
): QueueMembershipAgent {
	return {
		agentId,
		name: `agent-${agentId}`,
		contactKind: "extension",
		contact: `PJSIP/${agentId}`,
		level: 1,
		position: 1,
		wrapUpSeconds: 10,
		maxNoAnswer: 3,
		noAnswerDelaySeconds: 30,
		busyDelaySeconds: 60,
		rejectDelaySeconds: 60,
		enabled: true,
		...overrides,
	};
}

export function fakeMembership(
	orgId: string,
	queueId: string,
	agents: readonly QueueMembershipAgent[],
	overrides: Partial<QueueMembership> = {},
): QueueMembership {
	return {
		orgId,
		queueId,
		wrapUpSeconds: 10,
		tierRulesApply: true,
		tierRuleWaitSeconds: 30,
		tierRuleNoAgentNoWait: false,
		agents: [...agents],
		updatedAt: "2026-08-05T12:00:00.000Z",
		...overrides,
	};
}

export function fakeMembershipPort(
	membership: QueueMembership | undefined,
): QueueMembershipPort & { current: QueueMembership | undefined; reads: number } {
	const port = {
		current: membership,
		reads: 0,
		membershipFor: async (): Promise<QueueMembership | undefined> => {
			port.reads += 1;
			return port.current;
		},
	};
	return port;
}

// ---------------------------------------------------------------------------------------------
// Agent state
// ---------------------------------------------------------------------------------------------

export interface RecordedTransition {
	readonly agentId: string;
	readonly from: AgentStatus;
	readonly to: AgentStatus;
	readonly callId: string;
	readonly availableAt?: number;
	readonly noAnswerCount?: number;
	readonly refused?: boolean;
}

export interface FakeAgentStateStore extends AgentStatePort {
	readonly entries: Map<string, AgentStateEntry>;
	readonly transitions: RecordedTransition[];
	/** Seeds an agent, bypassing the machine — this is the API's write, not the engine's. */
	seed(agentId: string, status: AgentStatus, overrides?: Partial<AgentStateEntry>): void;
	statusOf(agentId: string): AgentStatus | undefined;
}

export function makeFakeAgentStateStore(orgId: string, now: () => number): FakeAgentStateStore {
	const entries = new Map<string, AgentStateEntry>();
	const transitions: RecordedTransition[] = [];

	const store: FakeAgentStateStore = {
		entries,
		transitions,
		seed: (agentId, status, overrides = {}) => {
			entries.set(agentId, {
				orgId,
				agentId,
				status,
				since: new Date(now()).toISOString(),
				...overrides,
			});
		},
		statusOf: (agentId) => entries.get(agentId)?.status,

		readStates: async (_orgId: string, agentIds: readonly string[]) => {
			const states = new Map<string, AgentStateEntry>();
			for (const agentId of agentIds) {
				const entry = entries.get(agentId);
				if (entry !== undefined) {
					states.set(agentId, entry);
				}
			}
			return states;
		},
		readState: async (_orgId: string, agentId: string) => {
			const entry = entries.get(agentId);
			return entry === undefined ? { kind: "absent" as const } : { kind: "found" as const, entry };
		},
		reserve: async (request) => {
			const current = entries.get(request.agentId);
			if (!isEligibleForDistribution(current, request.now)) {
				return undefined;
			}
			const next: AgentStateEntry = {
				orgId: request.orgId,
				agentId: request.agentId,
				status: "ringing",
				since: new Date(request.now).toISOString(),
				previousStatus: current.status,
				source: "engine",
				callId: request.callId,
				queueId: request.queueId,
				...noAnswerCountOf(request.noAnswerCount, current.noAnswerCount),
				...(request.legId === undefined ? {} : { legId: request.legId }),
			};
			entries.set(request.agentId, next);
			transitions.push({
				agentId: request.agentId,
				from: current.status,
				to: "ringing",
				callId: request.callId,
			});
			return next;
		},

		transition: async (request: AgentTransitionRequest) => {
			const current = entries.get(request.agentId);
			const from: AgentStatus = current?.status ?? "logged-out";
			if (
				(from === "ringing" || from === "on-call" || from === "wrap-up") &&
				current?.callId !== request.callId
			) {
				transitions.push({
					agentId: request.agentId,
					from,
					to: request.to,
					callId: request.callId,
					refused: true,
				});
				return undefined;
			}
			if (from === request.to) {
				return current;
			}
			try {
				assertAgentTransition(from, request.to);
			} catch {
				transitions.push({
					agentId: request.agentId,
					from,
					to: request.to,
					callId: request.callId,
					refused: true,
				});
				return undefined;
			}
			const next: AgentStateEntry = {
				orgId: request.orgId,
				agentId: request.agentId,
				status: request.to,
				since: new Date(now()).toISOString(),
				previousStatus: from,
				source: "engine",
				...(request.availableAt === undefined
					? {}
					: { availableAt: new Date(request.availableAt).toISOString() }),
				...noAnswerCountOf(request.noAnswerCount, current?.noAnswerCount),
				...(request.queueId === undefined ? {} : { queueId: request.queueId }),
				...(request.to === "ringing" || request.to === "on-call" || request.to === "wrap-up"
					? { callId: request.callId }
					: {}),
				...(request.legId === undefined ? {} : { legId: request.legId }),
				...(request.reason === undefined ? {} : { reason: request.reason }),
			};
			entries.set(request.agentId, next);
			transitions.push({
				agentId: request.agentId,
				from,
				to: request.to,
				callId: request.callId,
				...(request.availableAt === undefined ? {} : { availableAt: request.availableAt }),
				...(request.noAnswerCount === undefined ? {} : { noAnswerCount: request.noAnswerCount }),
			});
			return next;
		},
	};

	return store;
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

export interface RecordedQueueEvent {
	readonly type: "caller.joined" | "caller.answered" | "caller.abandoned";
	readonly data: Record<string, unknown>;
}

export interface FakeQueueEventPort extends QueueEventPort {
	readonly recorded: RecordedQueueEvent[];
	types(): string[];
}

export function makeFakeQueueEventPort(): FakeQueueEventPort {
	const recorded: RecordedQueueEvent[] = [];
	return {
		recorded,
		types: () => recorded.map((event) => event.type),
		callerJoined: async (input) => {
			recorded.push({ type: "caller.joined", data: { ...input } });
		},
		callerAnswered: async (input) => {
			recorded.push({ type: "caller.answered", data: { ...input } });
		},
		callerAbandoned: async (input) => {
			recorded.push({ type: "caller.abandoned", data: { ...input } });
		},
	};
}

// ---------------------------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------------------------

export interface FakeQueueServices extends QueueServices {
	readonly membership: ReturnType<typeof fakeMembershipPort>;
	readonly agents: FakeAgentStateStore;
	readonly events: FakeQueueEventPort;
	readonly waiting: QueueWaitingStore;
	readonly cursor: QueueCursors;
}

/**
 * The five ACD constructor arguments `ChannelOrchestrator` takes, as fakes.
 *
 * A tuple rather than five constants, so a spec that is about DTMF or CDRs spreads one expression
 * and never has to be edited again when the ACD plane grows a sixth collaborator. The membership
 * source returns nothing, which is what a queue-free orchestrator spec wants: any queue node it
 * happened to reach would report an unreadable roster rather than silently distributing.
 */
export function fakeQueueOrchestratorArgs(): readonly [
	unknown,
	unknown,
	unknown,
	unknown,
	unknown,
] {
	const services = makeFakeQueueServices({ orgId: "0195c0f0-1c2f-7000-8000-000000000001" });
	return [services.membership, services.agents, services.events, services.waiting, services.cursor];
}

export function makeFakeQueueServices(input: {
	readonly orgId: string;
	readonly membership?: QueueMembership | undefined;
	readonly now?: () => number;
}): FakeQueueServices {
	const now = input.now ?? Date.now;
	return {
		membership: fakeMembershipPort(input.membership),
		agents: makeFakeAgentStateStore(input.orgId, now),
		events: makeFakeQueueEventPort(),
		// The REAL store, over a JetStream service with no bucket configured, which is exactly the
		// single-instance deployment: the same compare-and-set code path, the same pure ranking and
		// pruning, backed by a map instead of a broker. A hand-written fake here would be a second
		// implementation of the ordering — and the ordering is the thing under test.
		waiting: new QueueWaitingStore({ queueWaiting: undefined } as never),
		cursor: new QueueCursors(),
	};
}
