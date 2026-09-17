import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type KV, type NatsConnection } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { queueWaitingRecordSchema } from "@optimiq-voice/events/schemas";
import { kvKeyFor, QUEUE_WAITING_KV } from "@optimiq-voice/events/streams";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_ENV } from "../shared/pbx.tokens";
import type { PbxEnv } from "../shared/pbx-env";

const logger = getLogger("api.queues");

/** One outstanding callback promise, as `GET /queues/:id/callbacks` renders it. */
export interface PendingQueueCallback {
	readonly callerNumber: string;
	readonly joinedAt: number;
	readonly priority: number;
	readonly abandonedAt: number;
	readonly expiresAt: number;
	readonly attempts: number;
	readonly maxAttempts: number;
	readonly nextAttemptAt: number;
	/** The queued call the offer was accepted on, when the token was written by an engine that has it. */
	readonly callId?: string;
}

/**
 * Read-only access to the `queue-waiting` bucket, for the callbacks a queue still owes.
 *
 * A callback token is not a row: it is the `callback` block on a resume tombstone in the queue's
 * waiting record, written and consumed by the engine under compare-and-set. So the control plane
 * cannot answer "who are we still going to ring back?" from the database, and until this existed it
 * answered 404 — a promise made to a caller that nobody could see.
 *
 * One `get` on one key, because the record IS the whole line for one queue. No write grant: the
 * engines own this bucket, and an api that could write it could hand out or revoke a caller's place.
 * `config/nats.conf` already grants this identity `$KV.queue-waiting.>` for the wallboard's live
 * topic, so this surface costs no new grant.
 */
@Injectable()
export class QueueCallbacksClient implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private waiting: KV | undefined;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {}

	get isReady(): boolean {
		return (
			this.connection !== undefined && !this.connection.isClosed() && this.waiting !== undefined
		);
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-queue-callbacks",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			const manager = await this.connection.jetstreamManager();
			// NOT created here. The engines own this bucket and this process may not write it.
			this.waiting = await manager.jetstream().views.kv(QUEUE_WAITING_KV.name);
		} catch (error) {
			// A deployment whose engines have never run has no bucket, which is a real state and must
			// not stop the api booting. The listing is then empty rather than an error.
			logger.warn({ err: error }, "queue callbacks could not bind the queue-waiting bucket");
		}
	}

	async onApplicationShutdown(): Promise<void> {
		if (this.connection !== undefined && !this.connection.isClosed()) {
			await this.connection.drain();
		}
		this.connection = undefined;
		this.waiting = undefined;
	}

	/**
	 * The callbacks this queue still owes, soonest attempt first.
	 *
	 * Empty for a queue with no line, for a bucket that is not bound, and for a record whose
	 * tombstones are all plain resume promises — the three are the same answer to the caller and
	 * none of them is an error.
	 */
	async pendingFor(
		organizationId: string,
		queueId: string,
	): Promise<readonly PendingQueueCallback[]> {
		const bucket = this.waiting;
		if (bucket === undefined) {
			return [];
		}
		try {
			const entry = await bucket.get(kvKeyFor.queueWaiting(organizationId, queueId));
			if (entry === null || entry.value.length === 0) {
				return [];
			}
			const parsed = queueWaitingRecordSchema.safeParse(
				JSON.parse(new TextDecoder().decode(entry.value)) as unknown,
			);
			// The tenancy the key already implies, checked again where a mistake would be visible to a
			// user — the rule every other KV read on this surface follows.
			if (!parsed.success || parsed.data.orgId !== organizationId) {
				return [];
			}
			return parsed.data.tombstones
				.flatMap((tombstone) =>
					tombstone.callback === undefined
						? []
						: [
								{
									callerNumber: tombstone.callerNumber,
									joinedAt: tombstone.joinedAt,
									priority: tombstone.priority,
									abandonedAt: tombstone.abandonedAt,
									expiresAt: tombstone.expiresAt,
									attempts: tombstone.callback.attempts,
									maxAttempts: tombstone.callback.maxAttempts,
									nextAttemptAt: tombstone.callback.nextAttemptAt,
									...(tombstone.callback.callId === undefined
										? {}
										: { callId: tombstone.callback.callId }),
								},
							],
				)
				.sort((left, right) => left.nextAttemptAt - right.nextAttemptAt);
		} catch (error) {
			logger.warn({ organizationId, queueId, err: error }, "could not read a queue's callbacks");
			return [];
		}
	}
}
