import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type NatsConnection } from "nats";
import {
	buildCallLegEnrichmentQuery,
	eq,
	recordings,
	sql,
	withCdrWriterScope,
} from "@optimiq-voice/cdr-db";
import { getLogger } from "@optimiq-voice/logger";
import { CDR_DATABASE, CDR_ENV } from "../shared/cdr.tokens";
import { quarantineMessage } from "./cdr-quarantine";
import {
	describeError,
	ensureDurableConsumer,
	isDeterministicDatabaseRejection,
	redeliveryDelayMs,
	type DurableMessage,
} from "./durable-consumer";
import type { CdrEnv } from "../shared/cdr-env";
import type { CdrDatabaseClient, RecordingKind } from "@optimiq-voice/cdr-db";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

const DURABLE = "cdr-recording-writer";
const MAX_DELIVER = 5;

/**
 * Files recording metadata from the engine's `channel.record.*` events.
 *
 * ## Which source, and why it is NOT `cdr.leg.write`
 *
 * The brief allowed either, so here is what the engine actually publishes, read rather than
 * assumed:
 *
 * - `apps/engine/src/calls/cdr-leg.ts` `buildCdrLegWrite()` returns exactly twenty fields and NONE
 *   of them is about media. There is no `recordingKey`, no `objectKey`, no duration. The payload is
 *   `z.looseObject` so it COULD carry one, and it does not.
 * - `apps/engine/src/routing/plan-walker.ts` publishes `channel.record.started` (legId,
 *   recordingId, objectKey, kind) and `channel.record.stopped` (legId, recordingId, objectKey,
 *   durationMs, reason, bytes) on the `CALLS` stream. That is the whole of it, and the schema's own
 *   comment says `objectKey` "joins to `cdr-db` `recordings.object_key`".
 *
 * So `cdr.leg.write` is not a possible source today; taking it would mean writing a mapper for
 * fields that are never sent. This consumer takes the events that carry the data.
 *
 * ### The consequence, stated plainly
 *
 * `CALLS` is `discard: old` with a 72-hour window, while `CDR` is `discard: new` with thirty days.
 * Recording metadata is therefore materially less durable than the CDR row it hangs off: a writer
 * that is down for four days loses recording rows it can never rebuild, where the same outage
 * loses no legs at all. That is a real gap and it is not this consumer's to close — the fix is
 * either a `recording.*` family on a ledger-shaped stream or the recording block being added to
 * `cdr.leg.write`, both of which are `packages/events` changes with the engine on the other end.
 * Recorded as a follow-up rather than papered over.
 *
 * ## Two events, one row
 *
 * `started` creates the row: it is the only event carrying `kind`, and creating on start means a
 * recording that is interrupted by a crash still has metadata pointing at the bytes that were
 * written. `stopped` finalizes it — duration and size — and is also what sets `call_legs.recording_key`,
 * because until the object is final the CDR must not claim there is a recording to play.
 *
 * Both are idempotent by the same mechanism as the leg writer, one level down: `object_key` carries
 * a UNIQUE index (it is an S3 key, so uniqueness is a property of the bucket), so `started` is an
 * `on conflict do nothing` and `stopped` is an update keyed on it. A redelivery of either is a
 * no-op rather than a second row. Note the difference from `call_legs`: there the engine's id IS the
 * row id; here the engine's `recordingId` is NOT the row id, the object key is the natural key, and
 * that is deliberate — two recordings of one leg (a pause-and-resume) are two objects and must be
 * two rows even though a naive "one recording per leg" model would say otherwise.
 *
 * ## A failed recording is not a recording
 *
 * `stopped` with `reason: "failed"` or a zero duration finalizes the row as a tombstone-in-advance
 * rather than setting `recording_key` on the leg — the same judgement `plan-walker.ts` already
 * makes for voicemail ("a message a user opens to find silence in is worse than no message").
 */
@Injectable()
export class CdrRecordingWriter implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private running = false;
	private stopped = false;
	private started = 0;
	private finalized = 0;
	private duplicates = 0;
	private quarantined = 0;

	constructor(
		@Inject(CDR_ENV) private readonly env: CdrEnv,
		@Inject(CDR_DATABASE) private readonly database: CdrDatabaseClient,
	) {}

	get stats(): {
		readonly running: boolean;
		readonly started: number;
		readonly finalized: number;
		readonly duplicates: number;
		readonly quarantined: number;
	} {
		return {
			running: this.running,
			started: this.started,
			finalized: this.finalized,
			duplicates: this.duplicates,
			quarantined: this.quarantined,
		};
	}

	async onModuleInit(): Promise<void> {
		if (!this.env.CDR_WRITER_ENABLED || this.env.NATS_URL === undefined) {
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				name: "optimiq-api-cdr-recordings",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			void this.run();
		} catch (error) {
			logger.error("could not connect the CDR recording writer", error);
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
		const { ensureStreams, CALLS_STREAM } = await import("@optimiq-voice/events/streams");

		try {
			const manager = await connection.jetstreamManager();
			await ensureStreams(manager, [CALLS_STREAM]);
		} catch (error) {
			logger.error("could not ensure the CALLS stream", error);
		}

		/**
		 * `calls.evt.v1.*.*.channel.record.*` — org and call are wildcards, and the event name has
		 * three tokens of which the last varies.
		 *
		 * Written out rather than taken from `subjectFilterFor`, which has no helper for "one event
		 * FAMILY across every org": `callEvent(event)` takes a complete event name, and passing
		 * `channel.record.*` to it would be a wildcard smuggled through `assertEvent`. Filtering to
		 * the two record events rather than consuming all of `CALLS` matters — `CALLS` is the
		 * highest-volume stream in the system and this consumer wants two events out of thirteen.
		 */
		await ensureDurableConsumer(connection, {
			streamName: CALLS_STREAM.name,
			durable: DURABLE,
			filterSubject: "calls.evt.v1.*.*.channel.record.*",
			maxDeliver: MAX_DELIVER,
		});

		try {
			const consumer = await connection.jetstream().consumers.get(CALLS_STREAM.name, DURABLE);
			const messages = await consumer.consume();
			this.running = true;
			logger.info("CDR recording writer running", { durable: DURABLE, stream: CALLS_STREAM.name });
			for await (const message of messages) {
				if (this.stopped) {
					break;
				}
				await this.handle(message as unknown as DurableMessage);
			}
		} catch (error) {
			if (!this.stopped) {
				logger.error("the CDR recording writer stopped", error);
			}
		}
		this.running = false;
	}

	private async handle(message: DurableMessage): Promise<void> {
		const { callEventSchema } = await import("@optimiq-voice/events/schemas");
		const deliveries = message.info.redeliveryCount;

		let body: unknown;
		let envelope: RecordEnvelope;
		try {
			body = JSON.parse(new TextDecoder().decode(message.data));
			envelope = callEventSchema.parse(body) as unknown as RecordEnvelope;
		} catch (error) {
			await this.quarantine(message, "unreadable", describeError(error), body);
			message.term();
			return;
		}

		if (envelope.type !== "channel.record.started" && envelope.type !== "channel.record.stopped") {
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

		// `calls.evt.v1.<orgId>.<callId>.<event…>` — the call is the address, not the payload.
		const parts = message.subject.split(".");
		const subjectOrg = parts[3];
		const callId = parts[4];
		if (subjectOrg === undefined || subjectOrg !== envelope.orgId || callId === undefined) {
			await this.quarantine(
				message,
				"foreign-subject",
				`subject ${message.subject} does not name the envelope's organization`,
				body,
			);
			message.term();
			return;
		}

		try {
			if (envelope.type === "channel.record.started") {
				await this.recordStarted(envelope.orgId, callId, envelope.data);
			} else {
				await this.recordStopped(envelope.orgId, callId, envelope.data);
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
			logger.error("failed to file recording metadata; it will be redelivered", {
				subject: message.subject,
				delivery: deliveries,
				error,
			});
			message.nak(redeliveryDelayMs(deliveries));
		}
	}

	/** Creates the metadata row. Idempotent on `object_key`, which is unique across the bucket. */
	private async recordStarted(
		organizationId: string,
		callId: string,
		data: RecordEventData,
	): Promise<void> {
		await withCdrWriterScope(this.database.adminDb, organizationId, async (transaction) => {
			const written = await transaction
				.insert(recordings)
				.values({
					organizationId,
					callId,
					legId: data.legId,
					kind: (data.kind ?? "call") as RecordingKind,
					objectKey: data.objectKey,
					durationMs: 0,
					sizeBytes: 0,
				})
				.onConflictDoNothing()
				.returning({ id: recordings.id });
			if (written.length > 0) {
				this.started += 1;
			} else {
				this.duplicates += 1;
			}
		});
	}

	/**
	 * Finalizes the row and, when there is audio, points the leg at it.
	 *
	 * `insert … on conflict do update` rather than a bare update: `stopped` can legitimately arrive
	 * without its `started` — the consumer may have been deployed mid-recording, or `started` may
	 * have aged out of the 72-hour `CALLS` window while this one had not. A recording whose
	 * metadata exists only because it stopped is far better than no row at all, and the only thing
	 * lost is `kind`, which defaults to `call`.
	 */
	private async recordStopped(
		organizationId: string,
		callId: string,
		data: RecordEventData,
	): Promise<void> {
		const durationMs = typeof data.durationMs === "number" ? Math.max(0, data.durationMs) : 0;
		const sizeBytes = typeof data.bytes === "number" ? Math.max(0, data.bytes) : 0;
		const usable = data.reason !== "failed" && durationMs > 0;

		await withCdrWriterScope(this.database.adminDb, organizationId, async (transaction) => {
			await transaction
				.insert(recordings)
				.values({
					organizationId,
					callId,
					legId: data.legId,
					kind: (data.kind ?? "call") as RecordingKind,
					objectKey: data.objectKey,
					durationMs,
					sizeBytes,
				})
				.onConflictDoUpdate({
					target: recordings.objectKey,
					set: { durationMs, sizeBytes, updatedAt: new Date() },
					// The tenant predicate on the conflict path. `object_key` is unique across the
					// BUCKET rather than within a tenant, so without it a producer that guessed another
					// organization's key could rewrite its metadata.
					setWhere: eq(recordings.organizationId, organizationId),
				});
			this.finalized += 1;

			if (!usable) {
				return;
			}
			/**
			 * Setting `call_legs.recording_key` is the one place this consumer touches the ledger, and
			 * it goes through `buildCallLegEnrichmentQuery` rather than a hand-written update — that
			 * function is the ONLY exported way to update a leg and it always emits both the
			 * organization predicate and the partition key, so an enrichment can neither cross a
			 * tenant boundary nor scan every partition.
			 *
			 * The leg's `started_at` is not in this event, so it is read back first, scoped to the
			 * organization. A leg that is not there (the record event outran its own CDR, or the CDR
			 * writer is behind) is simply not enriched: `recordings.leg_id` already joins the two, and
			 * a missing `recording_key` degrades the leg list's "has media" badge rather than losing
			 * the recording.
			 */
			const legs = await transaction.execute(
				sql`select "started_at" from "call_legs"
					where "organization_id" = ${organizationId}::uuid and "id" = ${data.legId}::uuid
					limit 1`,
			);
			const startedAt = firstStartedAt(legs);
			if (startedAt === undefined) {
				return;
			}
			await transaction.execute(
				buildCallLegEnrichmentQuery(
					{ organizationId, callLegId: data.legId, startedAt },
					{ recordingKey: data.objectKey },
				),
			);
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
			stream: "CALLS",
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

/**
 * The `started_at` from a raw `execute`, whatever shape the driver returned it in.
 *
 * `transaction.execute` is untyped by design and postgres.js hands back an array-like of row
 * objects; this narrows it in one place rather than casting at the call site.
 */
function firstStartedAt(result: unknown): Date | undefined {
	const rows = Array.isArray(result)
		? result
		: ((result as { readonly rows?: unknown }).rows as unknown[] | undefined);
	const first = Array.isArray(rows) ? rows[0] : undefined;
	const value = (first as { readonly started_at?: unknown } | undefined)?.started_at;
	if (value instanceof Date) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? undefined : parsed;
	}
	return undefined;
}

interface RecordEventData {
	readonly legId: string;
	readonly recordingId: string;
	readonly objectKey: string;
	readonly kind?: string;
	readonly durationMs?: number;
	readonly bytes?: number;
	readonly reason?: string;
}

interface RecordEnvelope {
	readonly type: string;
	readonly orgId: string;
	readonly subject: string;
	readonly data: RecordEventData;
}
