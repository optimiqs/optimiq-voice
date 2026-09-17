import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_DATABASE } from "../pbx/shared/pbx.tokens";
import { claimExpiredMessagesAdmin, deleteMessage } from "./messaging.repository";
import { MESSAGING_ENV, MESSAGING_STORE } from "./messaging.tokens";
import type { ObjectStore } from "../storage";
import type { MessagingEnv } from "./messaging-env";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.messaging");

/** How many rows one pass removes. Small, so the sweep never holds a long transaction. */
const BATCH = 200;

/**
 * Time-scoped deletion of message bodies and their MMS media.
 *
 * # Why messaging needs its own sweeper rather than a `messaging.delete` grant
 *
 * A conversation is the tenant's own evidence in a TCPA or a consent dispute, so it must not be
 * removable by somebody who did not like how an exchange went — which is why the permission registry
 * deliberately has no `messaging.delete`. But GDPR Art. 5(1)(e) storage limitation is a per-class
 * obligation, and a message body is personal data of an identified person. The reconciliation of
 * those two is exactly this: removal on a CLOCK an administrator sets in advance, applied uniformly,
 * with no per-row human decision anywhere in it.
 *
 * # Media before row, and why that order
 *
 * The object is deleted first and the row second. The reverse would produce an orphaned object with
 * nothing left pointing at it — undiscoverable, and therefore permanent, which is the one outcome a
 * retention policy exists to prevent. This way a crash between the two leaves a row whose media is
 * gone, which the next pass simply re-claims and finishes.
 *
 * # What this does NOT delete
 *
 * `messaging_opt_out`. A consumer's "stop texting me" has no expiry, and sweeping it on the same
 * clock as the conversation would silently re-open a suppressed recipient. The opt-out ledger is the
 * one thing in this area that is kept indefinitely, and it holds nothing but a number, a keyword and
 * a date.
 */
@Injectable()
export class MessagingRetentionSweeper implements OnModuleInit, OnApplicationShutdown {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private stopped = false;
	private purged = 0;

	constructor(
		@Inject(MESSAGING_ENV) private readonly env: MessagingEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(MESSAGING_STORE) private readonly store: ObjectStore,
	) {}

	get stats(): { readonly purged: number } {
		return { purged: this.purged };
	}

	onModuleInit(): void {
		if (this.env.MESSAGING_RETENTION_SWEEP_INTERVAL_MS === 0) {
			return;
		}
		this.timer = setInterval(() => {
			void this.tick();
		}, this.env.MESSAGING_RETENTION_SWEEP_INTERVAL_MS);
		this.timer.unref?.();
		logger.info(
			{ intervalMs: this.env.MESSAGING_RETENTION_SWEEP_INTERVAL_MS },
			"messaging retention sweeper started",
		);
	}

	onApplicationShutdown(): void {
		this.stopped = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** One pass. Public so a harness can drive it rather than waiting out an hour. */
	async tick(): Promise<{ readonly purged: number }> {
		if (this.running || this.stopped) {
			return { purged: 0 };
		}
		this.running = true;
		try {
			// Untenanted: "which message anywhere is past its retention date" is the platform's
			// question, and an organization-first scan would read every tenant's live rows to find the
			// few that are not.
			const expired = await claimExpiredMessagesAdmin(this.database.adminDb, BATCH);
			let purged = 0;
			for (const row of expired) {
				for (const key of row.mediaKeys) {
					// Best-effort, and first — see the header. A store that refuses the delete leaves the
					// row for the next pass rather than orphaning the object.
					await this.store.delete(key).catch((error: unknown) => {
						logger.warn(
							{ organizationId: row.organizationId, objectKey: key, err: String(error) },
							"a retained message's attachment could not be removed",
						);
					});
				}
				await this.database.withTenantScope(
					row.organizationId,
					async (transaction) => await deleteMessage(transaction, row.id),
				);
				purged += 1;
			}
			this.purged += purged;
			if (purged > 0) {
				logger.info({ purged }, "messaging retention sweep removed expired messages");
			}
			return { purged };
		} catch (error) {
			logger.error({ err: error }, "the messaging retention sweep failed");
			return { purged: 0 };
		} finally {
			this.running = false;
		}
	}
}
