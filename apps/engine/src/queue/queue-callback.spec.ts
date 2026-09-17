import { describe, expect, it } from "bun:test";
import { QueueCallbackRunner } from "./queue-callback";
import type {
	QueueCallbackPlacement,
	QueueCallbackPort,
	QueueCallbackRequest,
	QueueCallbackServices,
} from "./queue-callback";
import type { AgentStatePort, QueueMembershipPort } from "./queue-session";
import type { AgentStateEntry, QueueMembership, QueueResumeTombstone } from "@optimiq-voice/events";
import type { QueueCallbackPlan } from "@optimiq-voice/routing";

/**
 * The platform's half of virtual hold: an agent frees, and the queue calls back the people whose
 * places it is holding.
 *
 * Every collaborator is a port, so a sweep runs in process with no broker and no media server. What
 * is asserted is the RUNNER's decisions — whether to dial at all, how many, and what a failed
 * attempt costs the promise — never how a seizure or a KV write behaves, which are their own files'
 * subjects.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const QUEUE = "0195c0f0-1c2f-7000-8000-0000000000e1";
const ORIGINAL = "0195c0f0-1c2f-7000-8000-0000000000d1";
const NOW = Date.parse("2026-08-05T12:00:00.000Z");

const PLAN: QueueCallbackPlan = {
	offerAfterSeconds: 60,
	maxAttempts: 3,
	retryDelaySeconds: 300,
	expiresAfterSeconds: 3600,
	key: "2",
};

function token(overrides: Partial<QueueResumeTombstone> = {}): QueueResumeTombstone {
	return {
		callerNumber: "+15551234567",
		joinedAt: NOW - 60_000,
		priority: 0,
		abandonedAt: NOW,
		expiresAt: NOW + 3_600_000,
		callback: { attempts: 0, maxAttempts: 3, nextAttemptAt: 0 },
		...overrides,
	};
}

function agent(agentId: string, status: AgentStateEntry["status"] = "available"): AgentStateEntry {
	// `since` and `updatedAt` are ISO instants on the wire; only `status` and the deadline fields
	// decide eligibility, which is all these specs are about.
	return {
		orgId: ORG,
		agentId,
		status,
		since: new Date(NOW - 600_000).toISOString(),
		updatedAt: new Date(NOW - 600_000).toISOString(),
	} as unknown as AgentStateEntry;
}

interface HarnessOptions {
	readonly tokens?: readonly QueueResumeTombstone[];
	/** Absent means the roster could not be read at all — an unavailability, not an empty team. */
	readonly membership?: QueueMembership | null;
	readonly states?: ReadonlyMap<string, AgentStateEntry>;
	readonly placement?: QueueCallbackPlacement;
	readonly plan?: Partial<QueueCallbackPlan>;
	readonly queueNumber?: string;
	/** Makes the event port fail, to prove a sweep survives a broker that is refusing publishes. */
	readonly eventsThrow?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const placed: QueueCallbackRequest[] = [];
	const published: { type: "placed" | "failed"; data: Record<string, unknown> }[] = [];
	const deferred: { callerNumber: string; retryDelayMs: number }[] = [];
	let tokens = [...(options.tokens ?? [token()])];

	const callbacks: QueueCallbackPort = {
		dueCallbacks: async () => tokens,
		deferCallback: async (_orgId, _queueId, callerNumber, _now, retryDelayMs) => {
			deferred.push({ callerNumber, retryDelayMs });
			const spent =
				(tokens.find((entry) => entry.callerNumber === callerNumber)?.callback?.attempts ?? 0) + 1;
			const dropped = spent >= PLAN.maxAttempts;
			tokens = tokens.filter((entry) => entry.callerNumber !== callerNumber);
			return dropped;
		},
	};

	const membership: QueueMembershipPort = {
		membershipFor: async () =>
			options.membership === null
				? undefined
				: (options.membership ??
					({
						orgId: ORG,
						queueId: QUEUE,
						agents: [{ agentId: "agent-a", enabled: true }],
					} as unknown as QueueMembership)),
	};

	const agents: AgentStatePort = {
		readStates: async () => options.states ?? new Map([["agent-a", agent("agent-a")]]),
		readState: async () => agent("agent-a"),
		reserve: async () => undefined,
		transition: async () => undefined,
	} as unknown as AgentStatePort;

	const events = {
		callbackPlaced: async (input: Record<string, unknown>) => {
			if (options.eventsThrow === true) {
				throw new Error("the broker is refusing publishes");
			}
			published.push({ type: "placed", data: input });
		},
		callbackFailed: async (input: Record<string, unknown>) => {
			if (options.eventsThrow === true) {
				throw new Error("the broker is refusing publishes");
			}
			published.push({ type: "failed", data: input });
		},
	} as unknown as NonNullable<QueueCallbackServices["events"]>;

	const services: QueueCallbackServices = {
		membership,
		agents,
		events,
		callbacks,
		dialer: {
			place: async (request) => {
				placed.push(request);
				return options.placement ?? { kind: "placed", callId: "call-1" };
			},
		},
	};

	const runner = new QueueCallbackRunner(
		ORG,
		QUEUE,
		{ ...PLAN, ...options.plan },
		services,
		{ now: () => NOW, instanceId: "engine-a" },
		options.queueNumber,
	);
	return { runner, placed, deferred, published };
}

describe("QueueCallbackRunner", () => {
	it("calls back the caller whose place it is holding, once an agent is free", async () => {
		const h = harness();
		const tick = await h.runner.tick();

		expect(tick).toEqual({ considered: 1, placed: 1, deferred: 0, dropped: 0 });
		expect(h.placed).toEqual([
			{
				orgId: ORG,
				queueId: QUEUE,
				callerNumber: "+15551234567",
				ringTimeoutSeconds: 30,
				attempts: 0,
				heldMs: 60_000,
			},
		]);
	});

	it("does nothing at all when nothing is owed", async () => {
		const h = harness({ tokens: [] });
		expect(await h.runner.tick()).toMatchObject({ skipped: "no-tokens", placed: 0 });
		expect(h.placed).toEqual([]);
	});

	/**
	 * The promise was "we will call you when somebody is free". Calling before that is worse than not
	 * calling: the caller answers and is put straight back on hold.
	 */
	it("waits for a free agent rather than putting the caller back on hold", async () => {
		const h = harness({ states: new Map([["agent-a", agent("agent-a", "on-call")]]) });
		expect(await h.runner.tick()).toMatchObject({ skipped: "no-agent", placed: 0 });
		expect(h.placed).toEqual([]);
	});

	it("spends no attempt when the roster cannot be read at all", async () => {
		const h = harness({ membership: null });
		expect(await h.runner.tick()).toMatchObject({ skipped: "no-roster", placed: 0 });
		expect(h.deferred).toEqual([]);
	});

	/**
	 * Dialling five people back into a queue with one free agent recreates the queue on the
	 * customers' phones, which is the situation virtual hold exists to end.
	 */
	it("places at most one callback per free agent", async () => {
		const h = harness({
			tokens: [
				token(),
				token({ callerNumber: "+15550000002" }),
				token({ callerNumber: "+15550000003" }),
			],
			membership: {
				orgId: ORG,
				queueId: QUEUE,
				agents: [
					{ agentId: "agent-a", enabled: true },
					{ agentId: "agent-b", enabled: true },
				],
			} as unknown as QueueMembership,
			states: new Map([
				["agent-a", agent("agent-a")],
				["agent-b", agent("agent-b")],
			]),
		});
		const tick = await h.runner.tick();

		expect(tick.placed).toBe(2);
		expect(h.placed.map((request) => request.callerNumber)).toEqual([
			"+15551234567",
			"+15550000002",
		]);
	});

	it("records a failed attempt and pushes the next one out by the queue's delay", async () => {
		const h = harness({ placement: { kind: "refused", reason: "no answer" } });
		const tick = await h.runner.tick();

		expect(tick).toMatchObject({ placed: 0, deferred: 1, dropped: 0 });
		expect(h.deferred).toEqual([{ callerNumber: "+15551234567", retryDelayMs: 300_000 }]);
	});

	/** The honest end of the promise: called back as many times as the tenant configured. */
	it("counts the token as dropped once its last attempt fails", async () => {
		const h = harness({
			placement: { kind: "refused", reason: "no answer" },
			tokens: [token({ callback: { attempts: 2, maxAttempts: 3, nextAttemptAt: 0 } })],
		});
		expect(await h.runner.tick()).toMatchObject({ placed: 0, deferred: 0, dropped: 1 });
	});

	it("skips an agent whose state the roster does not carry", async () => {
		const h = harness({ states: new Map() });
		expect(await h.runner.tick()).toMatchObject({ skipped: "no-agent" });
	});

	/**
	 * The cross-call link. `call_legs` relates legs INSIDE one `call_id` and a callback is a new
	 * call, so the queued call the token remembers is the only thing that says which wait this
	 * settled — on the dial request, and on the event a report reads.
	 */
	it("carries the queued call onto the dial and onto the event", async () => {
		const h = harness({
			tokens: [
				token({ callback: { attempts: 0, maxAttempts: 3, nextAttemptAt: 0, callId: ORIGINAL } }),
			],
			queueNumber: "4010",
		});
		await h.runner.tick();

		expect(h.placed[0]?.relatedCallId).toBe(ORIGINAL);
		expect(h.placed[0]?.queueNumber).toBe("4010");
		expect(h.published).toEqual([
			{
				type: "placed",
				data: {
					orgId: ORG,
					queueId: QUEUE,
					callId: "call-1",
					originalCallId: ORIGINAL,
					callerNumber: "+15551234567",
					attempts: 0,
					heldMs: 60_000,
				},
			},
		]);
	});

	it("publishes the failure with the attempt it just spent, and whether the promise survived", async () => {
		const h = harness({
			placement: { kind: "refused", reason: "extension_offline" },
			tokens: [token({ callback: { attempts: 1, maxAttempts: 3, nextAttemptAt: 0 } })],
		});
		await h.runner.tick();

		expect(h.published).toEqual([
			{
				type: "failed",
				data: {
					orgId: ORG,
					queueId: QUEUE,
					callerNumber: "+15551234567",
					attempts: 2,
					dropped: false,
					reason: "extension_offline",
				},
			},
		]);
	});

	/**
	 * Reporting must never stop a callback. The token has already been dialled or already been
	 * deferred by the time the event is published, so a throw there would abandon the rest of the
	 * pass over a report nobody is reading yet.
	 */
	it("finishes the sweep when the event plane is refusing publishes", async () => {
		const h = harness({
			eventsThrow: true,
			tokens: [token(), token({ callerNumber: "+15550000002" })],
			membership: {
				orgId: ORG,
				queueId: QUEUE,
				agents: [
					{ agentId: "agent-a", enabled: true },
					{ agentId: "agent-b", enabled: true },
				],
			} as unknown as QueueMembership,
			states: new Map([
				["agent-a", agent("agent-a")],
				["agent-b", agent("agent-b")],
			]),
		});
		expect(await h.runner.tick()).toMatchObject({ placed: 2 });
	});
});
