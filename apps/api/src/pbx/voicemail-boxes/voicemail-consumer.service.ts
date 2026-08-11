import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { AckPolicy, connect, DeliverPolicy, type NatsConnection } from "nats";
import { natsCredentials } from "@optimiq-voice/config/nats-credentials";
import { getLogger } from "@optimiq-voice/logging";
import { eq, voicemailBox, voicemailMessage } from "@optimiq-voice/pbx-db";
import { isArchivingObjectStore } from "../../storage";
import { PBX_DATABASE, PBX_ENV, PBX_VOICEMAIL_STORE } from "../shared/pbx.tokens";
import { VoicemailEmailService } from "./voicemail-email.service";
import { readMailboxCounts, VoicemailMwiPublisher } from "./voicemail-mwi.publisher";
import type { ObjectStore } from "../../storage";
import type { PbxEnv } from "../shared/pbx-env";
import type { MailboxCounts } from "./voicemail-mwi.publisher";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/** The durable this consumer binds to. Named, so a redeploy resumes rather than replays. */
const DURABLE = "pbx-voicemail-writer";

/**
 * Files the messages the engine records.
 *
 * ## Why the control plane and not the engine
 *
 * The engine holds no database handle, on purpose: nothing on the call path may need Postgres to be
 * up. It records the audio, knows which box it belongs to, and publishes `voicemail.message.left`
 * with an ack. This is the other half — the process that already owns `pbx-db`, already knows what a
 * mailbox is, and can answer the question the engine cannot: how many messages are in it now.
 *
 * ## Idempotence is the row id, not a dedupe table
 *
 * The engine mints `messageId` (UUID v7) and it becomes `voicemail_message.id`, so a redelivery —
 * which JetStream guarantees will happen eventually, and which a crash between the insert and the
 * ack guarantees will happen soon — inserts one row rather than two copies of one message. The
 * insert is `on conflict do nothing` and the ack follows it, in that order: acking first would turn
 * a crash into a message nobody ever files.
 *
 * ## A failure is NAKed, not swallowed
 *
 * Unlike the routing-cache publish — where a failure costs a cache entry the system is designed to
 * miss — a message that is not filed is a user's voicemail that is in the object store and in no
 * mailbox. So the delivery is NAKed with a backoff and redelivered. A message whose BOX does not
 * exist is the exception: it is terminated, because redelivering it forever would block the
 * consumer on a mailbox that is never coming back.
 *
 * ## MWI
 *
 * `voicemail.mwi.updated` is published with ABSOLUTE counts read back in the same transaction, never
 * a delta: a lamp driven by deltas is one dropped message away from being wrong until somebody
 * reboots a phone.
 *
 * The publish itself now lives in {@link VoicemailMwiPublisher}, because this is no longer the only
 * thing that moves a mailbox's counts: reading and deleting a message from the web UI move them
 * too, and three copies of "build the envelope, publish it, swallow the failure" is three chances
 * to emit a lamp state in a different shape. The ORDER is unchanged and still matters — ack first,
 * then publish — for the reason `publishMwi` records below.
 *
 * ## Archival: this is where the audio gets a second home
 *
 * `message.left` is published when the recording is COMPLETE — the engine has stopped the capture
 * and knows the duration and the size — which makes it the same moment `channel.record.stopped` is
 * for a call recording, and it is filing time here for the same reason. With `STORAGE_DRIVER=s3`
 * the audio is copied from the shared volume into the bucket; with the default `local` driver
 * {@link VoicemailConsumer.archive} is a no-op.
 *
 * The copy does NOT let the audio leave the volume, and that is the constraint rather than a
 * shortcut: `*97` plays a message by handing Asterisk `object://<objectKey>` (see
 * `voicemail-messages.service.ts` `listForBroker`), and Asterisk opens the file off a mount. What
 * the archive buys is that an API container whose volume was replaced can still SERVE the message
 * over the signed playback route. `src/storage/object-store.ts` has the whole picture and the
 * `apps/mediad` migration note.
 */
@Injectable()
export class VoicemailConsumer implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private running = false;
	private stopped = false;
	private filed = 0;
	private duplicates = 0;
	private failed = 0;
	private archived = 0;

	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(VoicemailMwiPublisher) private readonly mwi: VoicemailMwiPublisher,
		@Inject(VoicemailEmailService) private readonly email: VoicemailEmailService,
		@Inject(PBX_VOICEMAIL_STORE) private readonly store: ObjectStore,
	) {}

	get stats(): {
		readonly running: boolean;
		readonly filed: number;
		readonly duplicates: number;
		readonly failed: number;
		readonly archived: number;
	} {
		return {
			running: this.running,
			filed: this.filed,
			duplicates: this.duplicates,
			failed: this.failed,
			archived: this.archived,
		};
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			logger.warn(
				"NATS_URL is not set — voicemail messages will not be filed. The engine still records " +
					"them and the audio still reaches the object store; the mailbox rows land when a " +
					"broker is configured and the stream is replayed.",
			);
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsCredentials(this.env),
				name: "optimiq-api-voicemail",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
			// Fire-and-forget: the consume loop is long-lived and awaiting it here would never return.
			void this.run();
		} catch (error) {
			this.failed += 1;
			logger.error({ err: error }, "could not connect the voicemail consumer");
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
	 * `DeliverPolicy.All` on a durable that does not exist yet, so a broker that had messages queued
	 * before this service first booted files them rather than skipping to the head. The stream is
	 * `discard: new` and thirty days deep precisely so that is a safe thing to want.
	 */
	private async run(): Promise<void> {
		const connection = this.connection;
		if (connection === undefined) {
			return;
		}
		const { ensureStreams, VOICEMAIL_STREAM } = await import("@optimiq-voice/events/streams");

		try {
			const manager = await connection.jetstreamManager();
			await ensureStreams(manager, [VOICEMAIL_STREAM]);
			await manager.consumers.add(VOICEMAIL_STREAM.name, {
				durable_name: DURABLE,
				ack_policy: AckPolicy.Explicit,
				deliver_policy: DeliverPolicy.All,
				filter_subject: "voicemail.evt.v1.*.*.message.left",
				max_deliver: 10,
			});
		} catch (error) {
			// `consumers.add` on an existing durable with identical config is a no-op; anything else
			// here means the consumer cannot run, and saying so once is better than a silent loop.
			if (!/consumer already exists/iu.test(String(error))) {
				logger.error({ err: error }, "could not create the voicemail durable consumer");
			}
		}

		try {
			const consumer = await connection.jetstream().consumers.get(VOICEMAIL_STREAM.name, DURABLE);
			const messages = await consumer.consume();
			this.running = true;
			logger.info({ durable: DURABLE }, "voicemail consumer running");
			for await (const message of messages) {
				if (this.stopped) {
					break;
				}
				await this.handle(message);
			}
		} catch (error) {
			if (!this.stopped) {
				this.failed += 1;
				logger.error({ err: error }, "the voicemail consumer stopped");
			}
		}
		this.running = false;
	}

	private async handle(message: {
		readonly subject: string;
		readonly data: Uint8Array;
		ack(): void;
		nak(millis?: number): void;
		term(): void;
	}): Promise<void> {
		// The schemas subpath rather than the package root, for the reason
		// `routing-cache.publisher.ts` records: `apps/api`'s tooling tsconfig still relaxes
		// `strictNullChecks` for its legacy files, and `validate.ts` needs it in order to narrow a
		// discriminated union. Recorded as a follow-up: the fix is to bring `apps/api` up to strict.
		const { voicemailEventSchema } = await import("@optimiq-voice/events/schemas");

		let envelope: VoicemailEnvelope;
		try {
			envelope = voicemailEventSchema.parse(
				JSON.parse(new TextDecoder().decode(message.data)),
			) as unknown as VoicemailEnvelope;
		} catch (error) {
			// Bytes that are not this contract will never become this contract. Terminating is the
			// only way not to block every message behind them.
			logger.error(
				{
					subject: message.subject,
					error,
				},
				"terminating a voicemail message that is not readable as one",
			);
			message.term();
			return;
		}

		if (envelope.type !== "message.left") {
			message.ack();
			return;
		}
		if (envelope.subject !== message.subject) {
			// The tenancy cross-check `validateEvent` would have made: an envelope whose own subject
			// disagrees with the one it was delivered on could scope a write to the wrong tenant.
			logger.error(
				{
					subject: message.subject,
					envelopeSubject: envelope.subject,
				},
				"terminating a voicemail message delivered on a foreign subject",
			);
			message.term();
			return;
		}
		const data = envelope.data;
		// `voicemail.evt.v1.<orgId>.<mailboxId>.<event>` — the box is the address, not the payload.
		const mailboxId = message.subject.split(".")[4];
		if (mailboxId === undefined) {
			message.term();
			return;
		}

		try {
			const counts = await this.file(envelope.orgId, mailboxId, data);
			if (counts === undefined) {
				logger.error(
					{
						subject: message.subject,
						mailboxId,
					},
					"terminating a voicemail message for a mailbox that does not exist",
				);
				message.term();
				return;
			}
			message.ack();
			// Everything below the ack is best-effort by design — the row IS filed, and a broker, a
			// relay or a bucket that is briefly unavailable must not cause the message to be written
			// twice. The archive is the same bargain: a copy that did not happen is a durability gap
			// with a log line, whereas a NAK here would re-run an insert whose duplicate-detection is
			// the only thing standing between a user and seeing one voicemail twice.
			await this.archive(data.objectKey);
			await this.publishMwi(envelope.orgId, mailboxId, data.mailboxNumber, counts);
			await this.notifyByEmail(envelope.orgId, mailboxId, data.messageId);
		} catch (error) {
			this.failed += 1;
			logger.error(
				{
					subject: message.subject,
					error,
				},
				"failed to file a voicemail message; it will be redelivered",
			);
			message.nak(5_000);
		}
	}

	/**
	 * Inserts the row and reads the box's counts back, in one transaction.
	 *
	 * One transaction because the counts are what the MWI event will claim: reading them on a second
	 * connection would let a concurrent delivery land in between and publish a lamp state that was
	 * never true.
	 *
	 * `undefined` means the box is not in this organization — a message for a mailbox that was
	 * deleted while the caller was recording into it, or an event for a tenant that no longer exists.
	 */
	private async file(
		organizationId: string,
		mailboxId: string,
		data: {
			messageId: string;
			legId: string;
			objectKey: string;
			durationMs: number;
			sizeBytes?: number;
			callerIdNumber?: string;
			callerIdName?: string;
			receivedAt: string;
		},
	): Promise<MailboxCounts | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const box = await transaction
				.select({ id: voicemailBox.id })
				.from(voicemailBox)
				.where(eq(voicemailBox.id, mailboxId))
				.limit(1);
			if (box.length === 0) {
				return undefined;
			}

			const inserted = await transaction
				.insert(voicemailMessage)
				.values({
					// The engine's id IS the row id, which is what makes a redelivery idempotent.
					id: data.messageId,
					organizationId,
					voicemailBoxId: mailboxId,
					folder: "new",
					callerIdName: data.callerIdName ?? null,
					callerIdNumber: data.callerIdNumber ?? null,
					receivedAt: new Date(data.receivedAt),
					durationMs: data.durationMs,
					objectKey: data.objectKey,
					sizeBytes: data.sizeBytes ?? null,
					callLegRef: data.legId,
				})
				.onConflictDoNothing()
				.returning({ id: voicemailMessage.id });

			if (inserted.length === 0) {
				this.duplicates += 1;
			} else {
				this.filed += 1;
			}

			return await readMailboxCounts(transaction, mailboxId);
		});
	}

	/**
	 * Copies the recorded message from the shared volume into the durable object store.
	 *
	 * A no-op unless `STORAGE_DRIVER=s3`: the capability is asked for with
	 * {@link isArchivingObjectStore} rather than by switching on a driver name, so a store that
	 * cannot archive simply is not one.
	 *
	 * Swallows its own failure, unlike the CDR recording writer's archive, and the difference is the
	 * position relative to the ack. There, the archive runs BEFORE the ack, so a throw NAKs and
	 * JetStream retries a copy that is `exists`-guarded and costs nothing to repeat. Here the row is
	 * already acked — a throw would redeliver the whole message and lean on `on conflict do nothing`
	 * to avoid filing it twice, which is a lot of machinery to exercise for a copy that a back-fill
	 * can make later.
	 */
	private async archive(objectKey: string): Promise<void> {
		if (!isArchivingObjectStore(this.store)) {
			return;
		}
		try {
			if (await this.store.archiveObject(objectKey)) {
				this.archived += 1;
				return;
			}
			logger.warn(
				{ objectKey },
				"an object store is configured but the voicemail audio was not on the shared volume",
			);
		} catch (error) {
			logger.error({ objectKey, err: error }, "could not archive voicemail audio to the store");
		}
	}

	/**
	 * Publishes the box's new counts.
	 *
	 * Best-effort and after the ack: the message IS filed, and a broker that refuses the lamp update
	 * must not cause the row to be written twice. A missed MWI is a stale lamp, which the next
	 * message or a resync corrects; a duplicated row is a message a user sees twice forever.
	 */
	private async publishMwi(
		organizationId: string,
		mailboxId: string,
		mailboxNumber: string,
		counts: MailboxCounts,
	): Promise<void> {
		await this.mwi.publish(organizationId, mailboxId, mailboxNumber, counts, "message-left");
	}

	/**
	 * Voicemail-to-email, on exactly the same terms as the MWI publish.
	 *
	 * After the ack and never in the failure path: the row IS filed, and a relay that is down must
	 * not cause the message to be redelivered and filed again. `VoicemailEmailService.notify` does
	 * not throw — every refusal is a named outcome — so this is a `void` return by construction
	 * rather than by a swallowed `catch`.
	 *
	 * ## What a duplicate delivery does
	 *
	 * JetStream will eventually redeliver, and a crash between the ack and this call means a
	 * message that is filed and never emailed. Both are accepted, in that direction: the insert is
	 * `on conflict do nothing`, so a redelivery re-runs this and sends a SECOND notification for a
	 * message the recipient already has — an annoyance — whereas making the send part of the acked
	 * unit of work would mean a relay outage re-filing rows. A duplicate notification carries the
	 * same `X-Optimiq-Voicemail-Message-Id`, which is what lets a mail store collapse it.
	 */
	private async notifyByEmail(
		organizationId: string,
		mailboxId: string,
		messageId: string,
	): Promise<void> {
		const outcome = await this.email.notify(organizationId, mailboxId, messageId);
		if (outcome.outcome === "failed") {
			// Already logged with the cause by the service; this records the message it belonged to.
			logger.warn(
				{
					organizationId,
					mailboxId,
					messageId,
				},
				"a voicemail was filed but its notification could not be sent",
			);
		}
	}
}

/**
 * The envelope this consumer acts on.
 *
 * Declared structurally rather than imported as `VoicemailEventEnvelope`, for the same
 * `strictNullChecks` reason as the import above: naming the inferred union type here drags the
 * package root's `validate.ts` into this app's compilation.
 */
interface VoicemailEnvelope {
	readonly type: string;
	readonly orgId: string;
	readonly subject: string;
	readonly data: {
		readonly messageId: string;
		readonly mailboxNumber: string;
		readonly legId: string;
		readonly objectKey: string;
		readonly durationMs: number;
		readonly sizeBytes?: number;
		readonly callerIdNumber?: string;
		readonly callerIdName?: string;
		readonly receivedAt: string;
	};
}
