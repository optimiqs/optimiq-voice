import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type JetStreamManager, type KV, type NatsConnection } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { agentStateEntrySchema, makeQueueEvent } from "@optimiq-voice/events/schemas";
import {
	AGENT_STATE_KV,
	ensureKvBuckets,
	ensureStreams,
	kvKeyFor,
	QUEUES_STREAM,
} from "@optimiq-voice/events/streams";
import { QUEUE_SCOPE_ALL } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_ENV } from "../shared/pbx.tokens";
import type { PbxEnv } from "../shared/pbx-env";
import type { AgentStateEntry, AgentStatus } from "@optimiq-voice/events/schemas";

const logger = getLogger("api.pbx");

/**
 * The control plane's half of the `agent-state` bucket: the shift transitions the engine refuses.
 *
 * ## Why this process and not the engine
 *
 * `packages/events`' agent state machine splits the writers explicitly, and the engine's own
 * `assertEngineAgentTransition` refuses `logged-out`, `on-break` and a hand-set `unavailable` on
 * purpose — a call engine that decided somebody had gone home because their phone did not answer
 * would take them off the roster for being in a meeting. Those transitions have a human behind them
 * and a human's request arrives here. This is the other end of that split.
 *
 * ## Two writes and one event, and why the KV comes first
 *
 * A login moves three things: the `agent-state` KV entry the engine reads before every
 * distribution, the `queue_agent.status` column a wallboard renders from a cold start, and the
 * `queue.evt.v1` stream a live consumer follows. The KV entry is written FIRST and is the only one
 * whose failure is reported to the caller, because it is the only one that changes what happens to
 * the next caller in the queue: an agent whose row says `available` but whose KV entry says
 * `logged-out` gets no calls, and telling them the login succeeded would leave them staring at a
 * silent phone. The column and the event are best-effort catch-up.
 *
 * ## The read-modify-write is not atomic, and that is bounded on purpose
 *
 * `put` is unconditional rather than a compare-and-swap on the entry's revision. Two writers can
 * race: the engine moving an agent to `ringing` while a supervisor logs them out. The loser's value
 * survives for as long as it takes the other process to notice, which for the engine is its next
 * distribution pass — a second — and the resolution is the same either way, because a logged-out
 * agent whose leg is already ringing has their leg torn down by the call rather than by this
 * machine. A CAS loop here would turn that one-second window into a retry storm during exactly the
 * moments (a shift change) when both writers are busiest, and it would still not make the pair of
 * writes atomic across two processes.
 */
@Injectable()
export class AgentStatePublisher implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private bucket: KV | undefined;
	private written = 0;
	private published = 0;
	private failed = 0;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {}

	/** Whether a write now would actually reach the broker. */
	get isReady(): boolean {
		return this.bucket !== undefined && this.connection?.isClosed() === false;
	}

	get stats(): {
		readonly written: number;
		readonly published: number;
		readonly failed: number;
	} {
		return { written: this.written, published: this.published, failed: this.failed };
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — agent login/logout will be recorded in the database but not in " +
					"the agent-state KV bucket, so the engine will treat every agent as logged out and " +
					"queues will distribute to nobody.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-agent-state",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			const manager: JetStreamManager = await this.connection.jetstreamManager();
			if (this.env.PBX_ENSURE_KV_BUCKETS) {
				await ensureKvBuckets(manager, [AGENT_STATE_KV]);
				// The QUEUES stream carries the `agent.state` transitions published below. Ensured on
				// the same flag as the buckets: a publish to a subject no stream captures is accepted
				// by the server and silently dropped, which is the one failure mode a wallboard cannot
				// distinguish from "nobody changed status".
				await ensureStreams(manager, [QUEUES_STREAM]);
			}
			this.bucket = await manager.jetstream().views.kv(AGENT_STATE_KV.name);
			logger.info({ bucket: AGENT_STATE_KV.name }, "agent-state KV bucket ready");
		} catch (error) {
			this.failed += 1;
			logger.error({ err: error }, "could not open the agent-state KV bucket");
		}
	}

	async onApplicationShutdown(): Promise<void> {
		this.bucket = undefined;
		const connection = this.connection;
		this.connection = undefined;
		if (connection && !connection.isClosed()) {
			await connection.drain();
		}
	}

	/** One agent's live state, or `undefined` when the bucket has never heard of them. */
	async read(organizationId: string, agentId: string): Promise<AgentStateEntry | undefined> {
		const bucket = this.bucket;
		if (bucket === undefined) {
			return undefined;
		}
		try {
			const value = await bucket.get(kvKeyFor.agentState(organizationId, agentId));
			if (value === null || value.value.length === 0) {
				return undefined;
			}
			const entry = agentStateEntrySchema.parse(JSON.parse(new TextDecoder().decode(value.value)));
			if (entry.orgId !== organizationId || entry.agentId !== agentId) {
				// The same tenancy check `QueueMembershipSource` draws for rosters: a value naming one
				// organization under another's key is a bug, and acting on it would show one tenant's
				// agent as another's.
				logger.error(
					{
						organizationId,
						agentId,
						entryOrgId: entry.orgId,
						entryAgentId: entry.agentId,
					},
					"discarding an agent-state entry filed under another agent's key",
				);
				return undefined;
			}
			return entry;
		} catch (error) {
			logger.warn({ organizationId, agentId, error }, "could not read an agent-state entry");
			return undefined;
		}
	}

	/**
	 * Writes one transition and publishes the `agent.state` event for it.
	 *
	 * The guard belongs to the caller: `queue-agent-session.service.ts` runs
	 * `planAgentSessionAction` before this is reached, because guard-then-execute means the guard
	 * runs BEFORE the write and a publisher that re-derived it would be the second implementation of
	 * a rule that only works if there is one.
	 *
	 * Returns the entry it wrote, so the caller answers the request with what is actually in the
	 * bucket rather than with what it intended to put there.
	 */
	async write(input: AgentStateWrite): Promise<AgentStateEntry> {
		const entry = agentStateEntrySchema.parse({
			orgId: input.organizationId,
			agentId: input.agentId,
			status: input.status,
			since: input.at.toISOString(),
			...(input.previousStatus === undefined ? {} : { previousStatus: input.previousStatus }),
			...(input.reason === undefined || input.reason.length === 0 ? {} : { reason: input.reason }),
			// Deliberately dropped rather than carried forward: `callId`, `legId`, `queueId`,
			// `availableAt` and `noAnswerCount` describe a CALL, and a shift transition ends whatever
			// call context the entry held. Carrying a stale `availableAt` through a login would hold a
			// freshly-arrived agent out of distribution for a penalty they served before they left.
			source: "api",
		} satisfies AgentStateEntry);

		const bucket = this.bucket;
		if (bucket === undefined) {
			throw new AgentStateUnavailableError();
		}

		await bucket.put(
			kvKeyFor.agentState(input.organizationId, input.agentId),
			new TextEncoder().encode(JSON.stringify(entry)),
		);
		this.written += 1;

		// Fire-and-forget, and it observes its own failure: the KV entry is what distribution reads,
		// so a stream that is briefly unreachable must not fail a login the engine will honour. A
		// bare `void` would turn NATS's CONNECTION_DRAINING at shutdown into an unhandled rejection.
		this.publishTransition(entry, input.queueIds).catch((cause) => {
			this.failed += 1;
			logger.error(
				{
					organizationId: input.organizationId,
					agentId: input.agentId,
					cause,
				},
				"agent.state publish failed",
			);
		});

		return entry;
	}

	/**
	 * Publishes the transition on the org-wide queue scope.
	 *
	 * `QUEUE_SCOPE_ALL` rather than one subject per queue the agent serves: an agent has ONE status
	 * across every tier they sit in, and publishing it N times would make a wallboard subscribed to
	 * `queue.evt.v1.<org>.>` render one break as three. `queueIds` rides in the payload for a
	 * consumer that only cares about one queue.
	 */
	private async publishTransition(
		entry: AgentStateEntry,
		queueIds: readonly string[] | undefined,
	): Promise<void> {
		const connection = this.connection;
		if (connection === undefined || connection.isClosed()) {
			return;
		}
		const event = makeQueueEvent("agent.state", {
			orgId: entry.orgId,
			queueId: QUEUE_SCOPE_ALL,
			source: "api",
			at: entry.since,
			data: {
				agentId: entry.agentId,
				status: entry.status,
				...(entry.previousStatus === undefined ? {} : { previousStatus: entry.previousStatus }),
				...(queueIds === undefined || queueIds.length === 0 ? {} : { queueIds: [...queueIds] }),
				...(entry.reason === undefined ? {} : { reason: entry.reason }),
			},
		});
		await connection
			.jetstream()
			.publish(event.subject, new TextEncoder().encode(JSON.stringify(event)), {
				// The envelope id is the idempotency key consumers dedupe on, and JetStream's own
				// duplicate window uses it — so a retried publish files one transition, not two.
				msgID: event.id,
			});
		this.published += 1;
	}
}

export interface AgentStateWrite {
	readonly organizationId: string;
	readonly agentId: string;
	readonly status: AgentStatus;
	readonly previousStatus?: AgentStatus | undefined;
	readonly reason?: string | undefined;
	/** The queues this agent serves, for consumers that filter by one. */
	readonly queueIds?: readonly string[] | undefined;
	readonly at: Date;
}

/**
 * Raised when there is no broker to write to.
 *
 * A distinct error rather than a silent no-op, because this is the one publish in the PBX area
 * whose failure the CALLER has to hear about: a login that appeared to work and did not reach the
 * bucket leaves an agent sitting by a phone that will never ring, and the only person who can
 * notice is the one who pressed the button.
 */
export class AgentStateUnavailableError extends Error {
	readonly _tag = "AgentStateUnavailableError" as const;

	/**
	 * Recognised by its tag rather than by `instanceof`.
	 *
	 * `instanceof` compares constructor identity, and a module graph can hold two copies of one file
	 * — a `tsx` loader resolving the same source through two specifiers is enough. A failure to
	 * recognise this error would turn a 503 into an opaque 500, which is the difference between "the
	 * broker is down, your login was not recorded" and "something broke, we do not know what".
	 */
	static is(error: unknown): error is AgentStateUnavailableError {
		return (
			typeof error === "object" &&
			error !== null &&
			(error as { _tag?: unknown })._tag === "AgentStateUnavailableError"
		);
	}

	constructor() {
		super(
			"The agent-state store is not reachable, so this change would not affect how calls are " +
				"distributed. Nothing was recorded.",
		);
		this.name = "AgentStateUnavailableError";
	}
}
