import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type NatsConnection } from "nats";
import { callLegs, withCdrWriterScope } from "@optimiq-voice/cdr-db";
import { natsCredentials } from "@optimiq-voice/config/nats-credentials";
import { getLogger } from "@optimiq-voice/logging";
import { CDR_DATABASE, CDR_ENV } from "../shared/cdr.tokens";
import { mapCdrLegWrite } from "./cdr-leg-mapping";
import { CdrPartitionCache } from "./cdr-partition-cache";
import { quarantineMessage } from "./cdr-quarantine";
import {
	describeError,
	ensureDurableConsumer,
	isDeterministicDatabaseRejection,
	redeliveryDelayMs,
	type DurableMessage,
} from "./durable-consumer";
import type { CdrEnv } from "../shared/cdr-env";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

const logger = getLogger("api.cdr");

/** The durable this consumer binds to. Named, so a redeploy resumes rather than replays. */
const DURABLE = "cdr-leg-writer";
const MAX_DELIVER = 5;

/**
 * Files the per-leg call detail records the engine publishes.
 *
 * ## Why the control plane and not the engine
 *
 * The same reason the voicemail consumer lives here: the engine holds no database handle on
 * purpose, because nothing on the call path may need Postgres to be up. It knows exactly what
 * happened on a leg and publishes `cdr.leg.write` with an ack; this is the half that owns
 * `cdr-db`, knows what a partition is, and can afford to block on a write.
 *
 * ## Idempotency, and WHICH layer does what
 *
 * There are three, and they defend against different things. Conflating them is how a system ends
 * up with two of them and a gap:
 *
 * 1. **`Nats-Msg-Id` at the broker.** The engine publishes with `msgID: envelope.id`
 *    (`jetstream.service.ts`), and the `CDR` stream's `duplicate_window` is 10 minutes — wider
 *    than every other stream, precisely because "a crash-looping writer may retry the same leg
 *    minutes later". This defends against DOUBLE PUBLISHES: the engine retrying a publish it did
 *    not see acked. It does nothing about redeliveries, and it expires.
 *
 * 2. **The composite primary key, `(id, started_at)`.** The engine mints the leg's `id` as UUID v7
 *    and it BECOMES the row id, so the insert is `on conflict do nothing` and a redelivery — which
 *    JetStream guarantees eventually, and which a crash between the insert and the ack guarantees
 *    soon — writes one row rather than two copies of one leg. This is the durable layer: it has no
 *    window and it survives a broker rebuild.
 *
 *    Worth being precise about, because the key is composite: it suppresses a duplicate only when
 *    BOTH columns match. Two messages carrying the same `id` and DIFFERENT `startedAt` would land
 *    as two rows in two partitions. That cannot happen for a well-behaved producer — `startedAt`
 *    is the channel's creation instant and is never recomputed — but "the id is unique" is not what
 *    the database enforces, and a future producer that re-derives the timestamp would find that out
 *    the expensive way.
 *
 * 3. **Ack ordering.** The ack follows the insert, never precedes it. Acking first would turn a
 *    crash in between into a leg nobody ever filed, which for a billing ledger is the one failure
 *    mode with no recovery short of replaying the stream by hand.
 *
 * ## Failure handling, and where a message goes when it cannot be filed
 *
 * - Bytes that are not a `cdr.leg.write` → quarantined `unreadable`, TERMINATED on the first
 *   delivery. They will never become this contract, and redelivering them blocks every leg behind.
 * - An envelope whose own `subject` disagrees with the one it was delivered on → quarantined
 *   `foreign-subject`, terminated. This is the tenancy cross-check `validateEvent` would have made,
 *   and it is the only failure here that could have scoped a write to the wrong organization.
 * - A payload that cannot become a row (no id, no partition key) or that PostgreSQL refuses with a
 *   class 22/23 error → quarantined `rejected`, terminated. Deterministic: attempt eleven fails
 *   exactly like attempt one.
 * - Anything else (database unreachable, failover, lock timeout) → NAKed with a linear backoff and
 *   redelivered, up to `max_deliver`. The last attempt quarantines `exhausted` before terminating,
 *   so a database outage long enough to burn the deliveries leaves a replayable record instead of
 *   a silent gap.
 *
 * Nothing is ever acked-and-dropped. Every message either becomes a row or becomes a quarantine
 * row naming the stream sequence it can be replayed from.
 */
@Injectable()
export class CdrLegWriter implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private partitions: CdrPartitionCache;
	private running = false;
	private stopped = false;
	private written = 0;
	private duplicates = 0;
	private coerced = 0;
	private quarantined = 0;
	private retried = 0;

	constructor(
		@Inject(CDR_ENV) private readonly env: CdrEnv,
		@Inject(CDR_DATABASE) private readonly database: CdrDatabaseClient,
	) {
		this.partitions = new CdrPartitionCache(database);
	}

	get stats(): {
		readonly running: boolean;
		readonly written: number;
		readonly duplicates: number;
		readonly coerced: number;
		readonly quarantined: number;
		readonly retried: number;
		readonly partitionsEnsured: number;
	} {
		return {
			running: this.running,
			written: this.written,
			duplicates: this.duplicates,
			coerced: this.coerced,
			quarantined: this.quarantined,
			retried: this.retried,
			partitionsEnsured: this.partitions.size,
		};
	}

	async onModuleInit(): Promise<void> {
		if (!this.env.CDR_WRITER_ENABLED) {
			logger.info("the CDR leg writer is disabled by CDR_WRITER_ENABLED");
			return;
		}
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — call detail records will not be filed. The engine still " +
					"publishes them and the CDR stream still holds them for 30 days; the rows land when " +
					"a broker is configured and the durable catches up.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsCredentials(this.env),
				name: "optimiq-api-cdr-writer",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			// Fire-and-forget: the consume loop is long-lived and awaiting it here would never return.
			void this.run();
		} catch (error) {
			logger.error({ err: error }, "could not connect the CDR leg writer");
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

	private async run(): Promise<void> {
		const connection = this.connection;
		if (connection === undefined) {
			return;
		}
		const { ensureStreams, CDR_STREAM } = await import("@optimiq-voice/events/streams");
		const { subjectFilterFor } = await import("@optimiq-voice/events/subjects");

		try {
			const manager = await connection.jetstreamManager();
			await ensureStreams(manager, [CDR_STREAM]);
		} catch (error) {
			logger.error({ err: error }, "could not ensure the CDR stream");
		}
		await ensureDurableConsumer(connection, {
			streamName: CDR_STREAM.name,
			durable: DURABLE,
			filterSubject: subjectFilterFor.allCdrLegs(),
			maxDeliver: MAX_DELIVER,
		});

		try {
			// The horizon the cron normally maintains, warmed once at start so the first leg of the
			// day does not pay for a `CREATE TABLE`.
			await this.warmPartitions();
		} catch (error) {
			logger.error(
				{ err: error },
				"could not warm the CDR partition horizon; it will be ensured per leg",
			);
		}

		try {
			const consumer = await connection.jetstream().consumers.get(CDR_STREAM.name, DURABLE);
			const messages = await consumer.consume();
			this.running = true;
			logger.info({ durable: DURABLE, stream: CDR_STREAM.name }, "CDR leg writer running");
			for await (const message of messages) {
				if (this.stopped) {
					break;
				}
				await this.handle(message as unknown as DurableMessage);
			}
		} catch (error) {
			if (!this.stopped) {
				logger.error({ err: error }, "the CDR leg writer stopped");
			}
		}
		this.running = false;
	}

	private async warmPartitions(): Promise<void> {
		const { ensureMonthlyPartitions } = await import("@optimiq-voice/cdr-db");
		await ensureMonthlyPartitions(this.database.adminDb, {
			monthCount: this.env.CDR_PARTITION_HORIZON_MONTHS,
		});
	}

	private async handle(message: DurableMessage): Promise<void> {
		// The schemas subpath rather than the package root, for the reason the voicemail consumer
		// records: `apps/api`'s tooling tsconfig relaxes `strictNullChecks` for its legacy files and
		// the root's `validate.ts` needs it in order to narrow a discriminated union.
		const { cdrEventSchema } = await import("@optimiq-voice/events/schemas");
		const deliveries = message.info.redeliveryCount;

		let body: unknown;
		let envelope: CdrLegEnvelope;
		try {
			body = JSON.parse(new TextDecoder().decode(message.data));
			envelope = cdrEventSchema.parse(body) as unknown as CdrLegEnvelope;
		} catch (error) {
			await this.quarantine(message, "unreadable", describeError(error), body);
			message.term();
			return;
		}

		if (envelope.type !== "cdr.leg.write") {
			// A future CDR event this writer does not file. Acked rather than quarantined: it is a
			// valid message that is simply not ours, and the union exists so adding one is additive.
			message.ack();
			return;
		}

		if (envelope.subject !== message.subject) {
			await this.quarantine(
				message,
				"foreign-subject",
				`envelope subject ${envelope.subject} was delivered on ${message.subject}`,
				body,
				envelope.orgId,
			);
			message.term();
			return;
		}

		/**
		 * The organization comes from the SUBJECT, and the envelope's copy has to agree.
		 *
		 * `cdr-events.ts` keeps `organizationId` out of the payload precisely so there are two
		 * copies rather than three; this is the check that makes having two worth something. A
		 * disagreement here is the shape a cross-tenant write would take.
		 */
		const subjectOrg = message.subject.split(".")[3];
		if (subjectOrg === undefined || subjectOrg !== envelope.orgId) {
			await this.quarantine(
				message,
				"foreign-subject",
				`subject organization ${String(subjectOrg)} disagrees with envelope orgId ${envelope.orgId}`,
				body,
			);
			message.term();
			return;
		}

		let mapped: ReturnType<typeof mapCdrLegWrite>;
		try {
			mapped = mapCdrLegWrite(envelope.orgId, envelope.data);
		} catch (error) {
			// `CdrLegMappingError` for a payload with no id or no partition key, and anything else
			// for a mapper bug. Both are quarantined as `rejected` and terminated, on purpose: a
			// mapper that throws on these bytes will throw on them again on every redelivery, so
			// distinguishing the two here would only choose between two identical outcomes. The
			// distinction that matters is in `detail`, which carries the full cause chain.
			await this.quarantine(message, "rejected", describeError(error), body, envelope.orgId);
			message.term();
			return;
		}
		if (mapped.coercions.length > 0) {
			this.coerced += 1;
			logger.warn(
				{
					legId: mapped.values.id,
					orgId: envelope.orgId,
					coercions: mapped.coercions,
				},
				"a CDR leg needed coercion to fit the reporting schema",
			);
		}

		try {
			await this.partitions.ensureFor(mapped.values.startedAt);
			const inserted = await this.insert(envelope.orgId, mapped.values);
			if (inserted) {
				this.written += 1;
			} else {
				this.duplicates += 1;
			}
			message.ack();
		} catch (error) {
			if (isDeterministicDatabaseRejection(error)) {
				await this.quarantine(message, "rejected", describeError(error), body, envelope.orgId);
				message.term();
				return;
			}
			if (deliveries >= MAX_DELIVER) {
				await this.quarantine(message, "exhausted", describeError(error), body, envelope.orgId);
				message.term();
				return;
			}
			this.retried += 1;
			logger.error(
				{
					legId: mapped.values.id,
					subject: message.subject,
					delivery: deliveries,
					error,
				},
				"failed to file a CDR leg; it will be redelivered",
			);
			message.nak(redeliveryDelayMs(deliveries));
		}
	}

	/**
	 * The insert, as the schema OWNER inside `withCdrWriterScope`.
	 *
	 * Not the tenant role, even though the tenant role holds INSERT on `call_legs` and could do it.
	 * Two reasons, and the second is the one that matters: the writer is not acting on behalf of a
	 * request, so there is no session to take an organization from — and `withCdrWriterScope`
	 * publishes the organization as a transaction-local setting so an owner-principal write is still
	 * ATTRIBUTABLE in `pg_stat_activity` and to any audit trigger. The organization in the VALUES is
	 * what makes it correct; the setting is what makes it explicable.
	 *
	 * Returns whether a row was actually written, so a redelivery is counted as a duplicate rather
	 * than as a write.
	 */
	private async insert(organizationId: string, values: CallLegValues): Promise<boolean> {
		return await withCdrWriterScope(this.database.adminDb, organizationId, async (transaction) => {
			const written = await transaction
				.insert(callLegs)
				.values(values)
				.onConflictDoNothing()
				.returning({ id: callLegs.id });
			return written.length > 0;
		});
	}

	private async quarantine(
		message: DurableMessage,
		reason: "unreadable" | "foreign-subject" | "rejected" | "exhausted",
		detail: string,
		payload: unknown,
		organizationId?: string,
	): Promise<void> {
		this.quarantined += 1;
		await quarantineMessage(this.database, {
			stream: "CDR",
			subject: message.subject,
			streamSequence: message.seq,
			deliveryCount: message.info.redeliveryCount,
			reason,
			detail,
			organizationId,
			payload,
		});
	}
}

/** The row shape `mapCdrLegWrite` produces, named so the insert can be declared. */
type CallLegValues = ReturnType<typeof mapCdrLegWrite>["values"];

/**
 * The envelope this writer acts on.
 *
 * Declared structurally rather than imported as `CdrEventEnvelope`, for the same
 * `strictNullChecks` reason as the dynamic import above: naming the inferred union type here drags
 * the package root's `validate.ts` into this app's compilation.
 */
interface CdrLegEnvelope {
	readonly type: string;
	readonly orgId: string;
	readonly subject: string;
	readonly data: Readonly<Record<string, unknown>>;
}
