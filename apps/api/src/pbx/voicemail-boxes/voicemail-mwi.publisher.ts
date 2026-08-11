import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type NatsConnection } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { getLogger } from "@optimiq-voice/logging";
import { eq, sql, voicemailMessage } from "@optimiq-voice/pbx-db";
import { PBX_ENV } from "../shared/pbx.tokens";
import type { PbxEnv } from "../shared/pbx-env";
import type { PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/** What the lamp is driven by. Absolute, never a delta. */
export interface MailboxCounts {
	readonly newCount: number;
	readonly savedCount: number;
}

/** Why the counts changed. Rides in the event so a subscriber can log a cause, not just a number. */
export type MwiReason = "message-left" | "message-read" | "message-deleted" | "resync";

/**
 * Message-waiting indication, in one place.
 *
 * ## Absolute counts, never deltas
 *
 * A lamp driven by deltas is one dropped message away from being wrong until somebody reboots a
 * phone. So every `voicemail.mwi.updated` carries the mailbox's counts as they are, read back in
 * the SAME transaction as the change that caused them — reading them on a second connection would
 * let a concurrent write land in between and publish a state that was never true.
 *
 * ## Why the API publishes it and not the engine
 *
 * The counts are a property of `voicemail_message`, which is the control plane's table: the engine
 * records the audio and publishes `message.left`, and everything after that — filing the row,
 * moving it between folders, deleting it — happens here. Three of the four reasons a lamp changes
 * are therefore API-side, and the fourth (`message-left`) is the one that becomes a row here too.
 *
 * ## Best-effort, always
 *
 * Every publish is after its transaction has committed and every failure is logged and swallowed.
 * A missed MWI is a stale lamp, which the next message or a resync corrects. A write refused
 * because a broker was down is a user's action lost for a reason that has nothing to do with their
 * mailbox.
 */
@Injectable()
export class VoicemailMwiPublisher implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private published = 0;
	private failed = 0;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {}

	get stats(): { readonly published: number; readonly failed: number; readonly ready: boolean } {
		return { published: this.published, failed: this.failed, ready: this.isReady };
	}

	get isReady(): boolean {
		return this.connection !== undefined && this.connection.isClosed() === false;
	}

	async onModuleInit(): Promise<void> {
		if (this.env.NATS_URL === undefined) {
			// Not a warning: `routing-cache.publisher.ts` already says the broker is absent, once, at
			// boot. A second line per publisher turns one fact into a wall.
			return;
		}
		try {
			this.connection = await connect({
				servers: this.env.NATS_URL,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-voicemail-mwi",
				maxReconnectAttempts: -1,
				reconnectTimeWait: 1_000,
			});
		} catch (error) {
			this.failed += 1;
			logger.error({ err: error }, "could not connect the MWI publisher");
		}
	}

	async onApplicationShutdown(): Promise<void> {
		const connection = this.connection;
		this.connection = undefined;
		if (connection && !connection.isClosed()) {
			await connection.drain();
		}
	}

	/**
	 * Publishes the mailbox's counts. Returns whether they reached the broker.
	 *
	 * `extensionNumber` is the extension whose lamp this lights, when the box is bound to one.
	 * sipd matches a `message-summary` subscription on it; without it, sipd falls back to
	 * assuming the mailbox number IS the extension number, which is only usually true.
	 */
	async publish(
		organizationId: string,
		mailboxId: string,
		mailboxNumber: string,
		extensionNumber: string | undefined,
		counts: MailboxCounts,
		reason: MwiReason,
	): Promise<boolean> {
		const connection = this.connection;
		if (connection === undefined || connection.isClosed()) {
			return false;
		}
		try {
			// The schemas subpath rather than the package root, for the reason
			// `routing-cache.publisher.ts` records: `apps/api`'s tooling tsconfig still relaxes
			// `strictNullChecks` for its legacy files, and `validate.ts` needs it to narrow a union.
			const { makeVoicemailEvent } = await import("@optimiq-voice/events/schemas");
			const envelope = makeVoicemailEvent("mwi.updated", {
				orgId: organizationId,
				mailboxId,
				source: "api",
				data: {
					mailboxNumber,
					extensionNumber,
					newCount: counts.newCount,
					savedCount: counts.savedCount,
					reason,
				},
			});
			await connection
				.jetstream()
				.publish(envelope.subject, new TextEncoder().encode(JSON.stringify(envelope)), {
					msgID: envelope.id,
				});
			this.published += 1;
			return true;
		} catch (error) {
			this.failed += 1;
			logger.error({ mailboxId, reason, error }, "failed to publish an MWI update");
			return false;
		}
	}
}

/**
 * The mailbox's counts, read inside an open tenant transaction.
 *
 * One `group by` rather than two `count(*)` predicates, so the two numbers are taken from the same
 * scan and cannot disagree. Exported because every caller that changes a message has to publish
 * counts, and a second hand-rolled count is a second chance to forget the `deleted` folder exists.
 */
export async function readMailboxCounts(
	transaction: PbxDatabaseTransaction,
	mailboxId: string,
): Promise<MailboxCounts> {
	const counted = await transaction
		.select({ folder: voicemailMessage.folder, total: sql<number>`count(*)`.mapWith(Number) })
		.from(voicemailMessage)
		.where(eq(voicemailMessage.voicemailBoxId, mailboxId))
		.groupBy(voicemailMessage.folder);

	return {
		newCount: counted.find((row) => row.folder === "new")?.total ?? 0,
		savedCount: counted.find((row) => row.folder === "saved")?.total ?? 0,
	};
}
