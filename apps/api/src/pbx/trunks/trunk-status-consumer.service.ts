import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { AckPolicy, connect, DeliverPolicy, type NatsConnection } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { getLogger } from "@optimiq-voice/logging";
import { eq, trunk } from "@optimiq-voice/pbx-db";
import { PBX_DATABASE, PBX_ENV } from "../shared/pbx.tokens";
import type { PbxEnv } from "../shared/pbx-env";
import type { PbxDatabaseClient, TrunkStatus } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/** The durable this consumer binds to. Named, so a redeploy resumes rather than replays. */
const DURABLE = "pbx-trunk-status-writer";

/**
 * The one filter this consumer wants: `status.changed`, every trunk, every org.
 *
 * Hand-counted rather than built, on the `voicemail.evt.v1.*.*.message.left` precedent one file
 * over: the event name is DOTTED, so the concrete subject is SEVEN tokens
 * (`trunk.evt.v1.<org>.<trunk>.status.changed`) and the two `*`s here cover exactly the org and
 * trunk tokens. A `>` would also deliver whatever event joins the family next, which this writer
 * has no columns for.
 */
const FILTER_SUBJECT = "trunk.evt.v1.*.*.status.changed";

/** What one delivery did, for the spec's benefit and the counters'. */
export type TrunkStatusOutcome =
	| "written"
	| "superseded"
	| "unknown-trunk"
	| "terminated"
	| "skipped"
	| "failed";

/** The broker message shape this consumer acts on — a seam the spec can hand a fake through. */
export interface TrunkStatusMessage {
	readonly subject: string;
	readonly data: Uint8Array;
	ack(): void;
	nak(millis?: number): void;
	term(): void;
}

/**
 * Writes the engine's `trunk.status.changed` events into the `trunk.status*` columns.
 *
 * ## The other half of the qualify loop
 *
 * `trunks-schema.ts` has said since the columns landed that they "are written by the engine, are
 * eventually consistent by design, and are NOT the live truth" — and until this consumer, nothing
 * wrote them and every trunk read "unknown" forever. The engine now publishes transitions (see
 * `apps/engine`'s `TrunkStatusPublisher`); this is the durable writer on the same skeleton as
 * `VoicemailConsumer`: term() what can never be filed, nak() what can be retried, ack() the rest.
 *
 * ## Why the write goes straight through `withTenantScope` and NOT `TrunksService.update`
 *
 * Two reasons, both load-bearing:
 *
 * 1. `updateTrunkDto` deliberately excludes the `status*` columns — they are machine-written
 *    state, not tenant configuration, and a DTO that accepted them would let a PATCH forge a
 *    carrier outage. The service's update path is shaped for the DTO, so it cannot carry them.
 * 2. `affectsRouting("trunk")` is TRUE, so every write through the resource service recompiles
 *    the tenant's routing artifact and republishes the cache. Correct for a config change;
 *    absurd for a status tick — reachability is not a routing input (the failover chain already
 *    handles an unreachable trunk per call), and routing a recompile through every carrier flap
 *    would turn a wobbly peer into compile load. The raw scoped UPDATE writes four columns and
 *    triggers nothing.
 *
 * RLS still holds: `withTenantScope` runs the statement under the organization the SUBJECT names
 * (cross-checked against the envelope), so a forged id in the payload cannot reach another
 * tenant's row.
 *
 * ## Ordering across redeliveries
 *
 * JetStream orders a subject's messages, but a NAKed delivery is re-offered AFTER newer messages
 * have been consumed. The write therefore refuses to move `status_changed_at` backwards: a
 * delivery older than what the row already records is acked as superseded, not applied. That is
 * what makes "at-least-once + redelivery" safe for a column whose whole job is to be the latest
 * truth.
 */
@Injectable()
export class TrunkStatusConsumer implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private running = false;
	private stopped = false;
	private written = 0;
	private superseded = 0;
	private terminated = 0;
	private failed = 0;

	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
	) {}

	get stats(): {
		readonly running: boolean;
		readonly written: number;
		readonly superseded: number;
		readonly terminated: number;
		readonly failed: number;
	} {
		return {
			running: this.running,
			written: this.written,
			superseded: this.superseded,
			terminated: this.terminated,
			failed: this.failed,
		};
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — trunk status transitions will not be written back. The trunk " +
					"list keeps rendering whatever the columns last said (typically 'unknown'); the " +
					"rows catch up when a broker is configured and the stream is replayed.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-trunk-status",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			// Fire-and-forget: the consume loop is long-lived and awaiting it here would never return.
			void this.run();
		} catch (error) {
			this.failed += 1;
			logger.error({ err: error }, "could not connect the trunk status consumer");
		}
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		this.running = false;
		const connection = this.connection;
		this.connection = undefined;
		if (connection && !connection.isClosed()) {
			await connection.drain();
		}
	}

	/**
	 * The consume loop.
	 *
	 * `DeliverPolicy.All` on a durable that does not exist yet, so transitions that happened
	 * before this service first booted are applied rather than skipped — the stream is a week
	 * deep and nearly empty, and the superseded guard makes replaying old transitions harmless.
	 */
	private async run(): Promise<void> {
		const connection = this.connection;
		if (connection === undefined) {
			return;
		}
		const { ensureStreams, TRUNKS_STREAM } = await import("@optimiq-voice/events/streams");

		try {
			const manager = await connection.jetstreamManager();
			await ensureStreams(manager, [TRUNKS_STREAM]);
			await manager.consumers.add(TRUNKS_STREAM.name, {
				durable_name: DURABLE,
				ack_policy: AckPolicy.Explicit,
				deliver_policy: DeliverPolicy.All,
				filter_subject: FILTER_SUBJECT,
				max_deliver: 10,
			});
		} catch (error) {
			// `consumers.add` on an existing durable with identical config is a no-op; anything else
			// here means the consumer cannot run, and saying so once is better than a silent loop.
			if (!/consumer already exists/iu.test(String(error))) {
				logger.error({ err: error }, "could not create the trunk status durable consumer");
			}
		}

		try {
			const consumer = await connection.jetstream().consumers.get(TRUNKS_STREAM.name, DURABLE);
			const messages = await consumer.consume();
			this.running = true;
			logger.info({ durable: DURABLE }, "trunk status consumer running");
			for await (const message of messages) {
				if (this.stopped) {
					break;
				}
				await this.dispatch(message);
			}
		} catch (error) {
			if (!this.stopped) {
				this.failed += 1;
				logger.error({ err: error }, "the trunk status consumer stopped");
			}
		}
		this.running = false;
	}

	/**
	 * Handles one delivery. Public so the spec can drive it with a fake message — the run loop is
	 * the only other caller.
	 */
	async dispatch(message: TrunkStatusMessage): Promise<TrunkStatusOutcome> {
		// The schemas subpath rather than the package root, for the reason `voicemail-consumer`
		// records: `apps/api`'s tooling tsconfig still relaxes `strictNullChecks` for its legacy
		// files, and the package root drags `validate.ts` into this app's compilation.
		const { trunkEventSchema } = await import("@optimiq-voice/events/schemas");

		let envelope: TrunkEnvelope;
		try {
			envelope = trunkEventSchema.parse(
				JSON.parse(new TextDecoder().decode(message.data)),
			) as unknown as TrunkEnvelope;
		} catch (error) {
			// Bytes that are not this contract will never become this contract. Terminating is the
			// only way not to block every transition behind them.
			logger.error(
				{ subject: message.subject, error },
				"terminating a trunk status event that is not readable as one",
			);
			message.term();
			this.terminated += 1;
			return "terminated";
		}

		if (envelope.type !== "status.changed") {
			message.ack();
			return "skipped";
		}
		if (envelope.subject !== message.subject) {
			// The tenancy cross-check: an envelope whose own subject disagrees with the one it was
			// delivered on could scope a write to the wrong tenant's trunk.
			logger.error(
				{ subject: message.subject, envelopeSubject: envelope.subject },
				"terminating a trunk status event delivered on a foreign subject",
			);
			message.term();
			this.terminated += 1;
			return "terminated";
		}
		// `trunk.evt.v1.<orgId>.<trunkId>.<event>` — the trunk is the address, not the payload.
		const trunkId = message.subject.split(".")[4];
		if (trunkId === undefined) {
			message.term();
			this.terminated += 1;
			return "terminated";
		}

		try {
			const outcome = await this.write(envelope.orgId, trunkId, envelope);
			if (outcome === "unknown-trunk") {
				// A transition for a trunk that was deleted mid-outage, or never existed here.
				// Redelivering it forever would block the consumer on a row that is never coming
				// back — the same judgement the voicemail consumer makes about a missing mailbox.
				logger.warn(
					{ subject: message.subject, trunkId },
					"terminating a trunk status event for a trunk that does not exist",
				);
				message.term();
				this.terminated += 1;
				return outcome;
			}
			if (outcome === "written") {
				this.written += 1;
			} else {
				this.superseded += 1;
			}
			message.ack();
			return outcome;
		} catch (error) {
			// A transient database failure: the row exists (or its absence could not be proven),
			// so the delivery is NAKed and retried rather than dropped.
			this.failed += 1;
			logger.error(
				{ subject: message.subject, error },
				"failed to write a trunk status transition; it will be redelivered",
			);
			message.nak(5_000);
			return "failed";
		}
	}

	/**
	 * Applies one transition, refusing to move the row backwards in time.
	 *
	 * A select-then-update in one scoped transaction rather than a conditional UPDATE, so the two
	 * "zero rows" cases stay distinguishable: a missing row is a term(), a newer row is an ack(),
	 * and conflating them would either drop real transitions or retry deleted trunks forever.
	 */
	private async write(
		organizationId: string,
		trunkId: string,
		envelope: TrunkEnvelope,
	): Promise<"written" | "superseded" | "unknown-trunk"> {
		const at = new Date(envelope.at);
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({ id: trunk.id, statusChangedAt: trunk.statusChangedAt })
				.from(trunk)
				.where(eq(trunk.id, trunkId))
				.limit(1);
			const found = rows[0];
			if (found === undefined) {
				return "unknown-trunk";
			}
			if (found.statusChangedAt !== null && found.statusChangedAt.getTime() > at.getTime()) {
				// A redelivery arriving after a newer transition already landed. The row is the
				// latest truth; applying this would un-know it.
				return "superseded";
			}
			await transaction
				.update(trunk)
				.set({
					status: envelope.data.status as TrunkStatus,
					statusChangedAt: at,
					statusReason: envelope.data.reason ?? null,
					statusLatencyMs: envelope.data.latencyMs ?? null,
				})
				.where(eq(trunk.id, trunkId));
			return "written";
		});
	}
}

/**
 * The envelope this consumer acts on.
 *
 * Declared structurally rather than imported as `TrunkEventEnvelope`, for the same
 * `strictNullChecks` reason as the dynamic import above: naming the inferred union type here
 * drags the package root's `validate.ts` into this app's compilation.
 */
interface TrunkEnvelope {
	readonly type: string;
	readonly orgId: string;
	readonly subject: string;
	readonly at: string;
	readonly data: {
		readonly status: string;
		readonly reason?: string;
		readonly latencyMs?: number;
		readonly endpoint?: string;
	};
}
