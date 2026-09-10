import { describe, expect, it } from "bun:test";
import { queueCallbackPort, queueNumbersOf } from "../calls/channel-orchestrator.service";
import { QueueCallbackScheduler } from "./queue-callback.scheduler";
import type { AgentStateStore } from "./agent-state.store";
import type { QueueCallbackDialerService } from "./queue-callback.dialer";
import type { QueueEventPublisher } from "./queue-event-publisher.service";
import type { QueueMembershipSource } from "./queue-membership.source";
import type { QueueWaitingStore } from "./queue-waiting.store";
import type { AgentStateEntry, QueueMembership, QueueResumeTombstone } from "@optimiq-voice/events";
import type { QueueCallbackPlan } from "@optimiq-voice/routing";

/**
 * The clock virtual hold runs on, driven by hand.
 *
 * `sweep()` is public for the reason `QueueCallbackRunner.tick()` is: a spec has to be able to run
 * one pass and look at what it did, and a production timer that refs the process is how an engine
 * stops draining. What is asserted here is the SCHEDULER's own decisions — which queues it holds,
 * when it lets one go, and that shutdown leaves no timer behind — never the dial, which is
 * `queue-callback.spec.ts`'s subject.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const QUEUE = "0195c0f0-1c2f-7000-8000-0000000000e1";

const PLAN: QueueCallbackPlan = {
	offerAfterSeconds: 60,
	maxAttempts: 3,
	retryDelaySeconds: 300,
	expiresAfterSeconds: 3600,
	key: "2",
};

function scheduler(options: { readonly tokens?: readonly QueueResumeTombstone[] } = {}) {
	const dialled: string[] = [];
	const tokens = options.tokens ?? [];

	const membership = {
		membershipFor: async () =>
			({
				orgId: ORG,
				queueId: QUEUE,
				agents: [{ agentId: "agent-a", enabled: true }],
			}) as unknown as QueueMembership,
	} as unknown as QueueMembershipSource;

	const agents = {
		readStates: async () =>
			new Map([
				[
					"agent-a",
					{
						orgId: ORG,
						agentId: "agent-a",
						status: "available",
						since: new Date(0).toISOString(),
						updatedAt: new Date(0).toISOString(),
					} as unknown as AgentStateEntry,
				],
			]),
	} as unknown as AgentStateStore;

	const waiting = {
		dueCallbacks: async () => tokens,
		deferCallback: async () => false,
	} as unknown as QueueWaitingStore;

	const placements: { callerNumber: string; queueNumber?: string }[] = [];
	const dialer = {
		place: async (request: { callerNumber: string; queueNumber?: string }) => {
			dialled.push(request.callerNumber);
			placements.push({ callerNumber: request.callerNumber, queueNumber: request.queueNumber });
			return { kind: "placed" as const, callId: "call-1" };
		},
	} as unknown as QueueCallbackDialerService;

	const events = {
		callbackPlaced: async () => undefined,
		callbackFailed: async () => undefined,
	} as unknown as QueueEventPublisher;

	return {
		dialled,
		placements,
		built: new QueueCallbackScheduler(membership, agents, waiting, dialer, events),
	};
}

function token(): QueueResumeTombstone {
	const now = Date.now();
	return {
		callerNumber: "+15551234567",
		joinedAt: now - 60_000,
		priority: 0,
		abandonedAt: now,
		expiresAt: now + 3_600_000,
		callback: { attempts: 0, maxAttempts: 3, nextAttemptAt: 0 },
	};
}

describe("QueueCallbackScheduler", () => {
	it("sweeps a registered queue and dials what it owes", async () => {
		const s = scheduler({ tokens: [token()] });
		s.built.register(ORG, QUEUE, PLAN, { intervalMs: 3_600_000 });

		expect(s.built.stats.queues).toBe(1);
		await s.built.sweep();

		expect(s.dialled).toEqual(["+15551234567"]);
		s.built.onApplicationShutdown();
	});

	/**
	 * Regression: nothing ever passed `queueNumber`.
	 *
	 * `QueueCallbackSchedulePort.register` is three arguments and the orchestrator's wrapper is what
	 * supplies the fourth from the artifact. Without it `planQueueCallback` resolves the outbound
	 * route with an empty `from`, so a tenant whose rules are gated on the queue's toll class matches
	 * nothing and every promised callback is refused `invalid_target`.
	 */
	it("hands the queue's own number to the dialler when it is registered with one", async () => {
		const s = scheduler({ tokens: [token()] });
		s.built.register(ORG, QUEUE, PLAN, { intervalMs: 3_600_000, queueNumber: "4610" });

		await s.built.sweep();

		expect(s.placements).toEqual([{ callerNumber: "+15551234567", queueNumber: "4610" }]);
		s.built.onApplicationShutdown();
	});

	it("registers a queue once, however many promises it makes", () => {
		const s = scheduler();
		s.built.register(ORG, QUEUE, PLAN, { intervalMs: 3_600_000 });
		s.built.register(ORG, QUEUE, PLAN, { intervalMs: 3_600_000 });

		expect(s.built.stats.queues).toBe(1);
		s.built.onApplicationShutdown();
	});

	/**
	 * The bound is the TOKEN's lifetime, not a count of quiet sweeps. A token deferred after a failed
	 * attempt is not due again for `retryDelaySeconds`, so it reads as a quiet sweep for minutes —
	 * and forgetting the queue on that would turn every `maxAttempts: 3` into one attempt.
	 */
	it("holds a queue whose tokens are merely not due yet", async () => {
		const s = scheduler();
		s.built.register(ORG, QUEUE, PLAN, { intervalMs: 3_600_000 });

		await s.built.sweep();
		await s.built.sweep();
		await s.built.sweep();
		await s.built.sweep();

		expect(s.built.stats.queues).toBe(1);
		s.built.onApplicationShutdown();
	});

	it("forgets a queue once no token registered on it could still be alive", async () => {
		const s = scheduler();
		s.built.register(ORG, QUEUE, { ...PLAN, expiresAfterSeconds: 0 }, { intervalMs: 3_600_000 });

		await s.built.sweep();

		expect(s.built.stats.queues).toBe(0);
	});

	/**
	 * The whole reason the timer is the scheduler's and not each runner's: shutdown has ONE thing to
	 * clear. A leaked interval keeps firing through the drain, and a callback placed onto an instance
	 * that is refusing new work is a customer rung by a process that cannot serve them.
	 */
	it("clears its timer on shutdown, so a draining engine leaks none", async () => {
		const s = scheduler({ tokens: [token()] });
		s.built.register(ORG, QUEUE, PLAN, { intervalMs: 1 });
		s.built.onApplicationShutdown();

		const before = s.built.stats.ticks;
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(s.built.stats.ticks).toBe(before);
		expect(s.built.stats.queues).toBe(0);
	});

	it("does not let one sweep overlap the next", async () => {
		const s = scheduler({ tokens: [token()] });
		s.built.register(ORG, QUEUE, PLAN, { intervalMs: 3_600_000 });

		await Promise.all([s.built.sweep(), s.built.sweep()]);

		// One dial, not two: the second call found the first still running and returned.
		expect(s.dialled).toHaveLength(1);
		s.built.onApplicationShutdown();
	});
});

/**
 * The seam that fills the fourth argument in.
 *
 * A queue session knows the queue it is in and the plan it promised, and nothing about the tenant's
 * number plan; the artifact is in the orchestrator's hand. `queueNumbersOf` is the scan that closes
 * the gap — there is no `queueId -> number` index in the artifact and no number on `QueuePlanNode`,
 * which is why virtual hold went without one.
 */
describe("the queue's own number, from the artifact", () => {
	const artifact = {
		internal: {
			numbers: {
				"1001": { number: "1001", kind: "extension", entityId: "ext-1", nodeId: "n1" },
				"4610": { number: "4610", kind: "queue", entityId: QUEUE, nodeId: "n2" },
				"4611": { number: "4611", kind: "queue", entityId: QUEUE, nodeId: "n2" },
			},
		},
	} as unknown as Parameters<typeof queueNumbersOf>[0];

	it("indexes queues by id and keeps one number per queue", () => {
		expect(queueNumbersOf(artifact)).toEqual({ [QUEUE]: "4610" });
	});

	it("passes the number through to the scheduler when the queue has one", () => {
		const registered: { queueId: string; queueNumber?: string }[] = [];
		const fake = {
			register: (
				_orgId: string,
				queueId: string,
				_plan: QueueCallbackPlan,
				options: { queueNumber?: string } = {},
			) => {
				registered.push({ queueId, queueNumber: options.queueNumber });
			},
		} as unknown as QueueCallbackScheduler;

		queueCallbackPort(fake, queueNumbersOf(artifact)).register(ORG, QUEUE, PLAN);
		queueCallbackPort(fake, queueNumbersOf(artifact)).register(ORG, "unnumbered", PLAN);

		expect(registered).toEqual([
			{ queueId: QUEUE, queueNumber: "4610" },
			{ queueId: "unnumbered", queueNumber: undefined },
		]);
	});
});
