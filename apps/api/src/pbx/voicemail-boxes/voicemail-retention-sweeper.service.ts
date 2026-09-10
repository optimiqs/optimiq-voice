import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { eq, extension, lt, sql, voicemailBox, voicemailMessage } from "@optimiq-voice/pbx-db";
import {
	RECORDING_SETTINGS_CATEGORY,
	VOICEMAIL_RETENTION_SETTING,
} from "../org-settings/org-settings.catalog";
import { asUuid, insertAuditLog, serviceActor } from "../shared/audit-log";
import { PBX_DATABASE, PBX_ENV, PBX_VOICEMAIL_STORE } from "../shared/pbx.tokens";
import { readMailboxCounts, VoicemailMwiPublisher } from "./voicemail-mwi.publisher";
import type { ObjectStore } from "../../storage";
import type { PbxEnv } from "../shared/pbx-env";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/** Milliseconds in a day; the retention window is expressed in days of them. */
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Purges voicemail messages whose organization's retention window has run out.
 *
 * ## What was missing
 *
 * `voicemail-messages.service.ts` says it twice, in `remove` and again in `forward`: "Retention
 * owns the object store's lifecycle." Retention did not exist. Every message ever deposited was
 * kept for ever — the audio in the store and the row in `voicemail_message` — including the ones a
 * user had "deleted", which only ever moved a row to the `deleted` folder. A mailbox is the least
 * curated store of personal data this platform holds (anybody may leave anything in one, and
 * nobody reviews it), so an indefinite default there is the least defensible one.
 *
 * ## Modelled on `cdr/recordings/recording-retention-sweeper.service.ts`
 *
 * Same batching shape, same re-entrancy refusal, same "a sweep that throws must not kill the
 * interval", same public {@link sweep} so a harness can drive one pass instead of waiting out a
 * timer. The differences are the two that the data forces:
 *
 * **The window is per-organization and lives in `org_setting`, not on the row.** A recording is
 * stamped with `retention_until` when it is written, because the CDR area has a platform floor to
 * fall back to and because re-stamping a year of audio on a settings change is exactly the mistake
 * a retention policy exists to prevent. Voicemail has no platform floor — a mailbox is a tenant's
 * artefact end to end — so there is nothing to stamp AT and the tenant's current setting is the
 * only policy there is. The consequence is stated rather than hidden: shortening the window purges
 * messages that are already older than the new one, which is what an administrator shortening a
 * retention window means, and lengthening it cannot bring back what a previous window destroyed.
 *
 * **The worklist is built per-organization from the settings table**, because "which mailboxes
 * anywhere are past their window" is not one query when the window is a column in a different
 * table per tenant. An organization with no row, or a row of `0`, is never selected at all — it is
 * not swept and then skipped, it is not in the worklist — so the cost of the default ("keep
 * indefinitely") is one settings scan per pass rather than a scan of every mailbox on the platform.
 *
 * ## Object before row, and the `remove`/`unlink` ordering is copied deliberately
 *
 * `voicemail-messages.service.ts` deletes the OBJECT and then the ROW everywhere it does both, and
 * the recording sweeper argues the general case at length: a row deleted before its object is a
 * message the API says is gone while the audio is still in the store — destroyed for the customer
 * and retained for a subpoena, the worst of both. So the object goes first, and only the ids whose
 * delete actually returned are deleted from the table. A store that refused half the batch leaves
 * those messages readable, still expired, and picked up again next pass. `ObjectStore.delete` is
 * idempotent on all three drivers, so a retry costs nothing.
 *
 * ## The lamp is republished, because a purge changes the counts
 *
 * A mailbox whose `new` messages were purged has a phone with a lit MWI lamp and nothing behind
 * it. The counts are re-read and announced per affected box, best-effort and after the deletes, on
 * exactly the terms every other writer in this area uses: the rows ARE gone, and a broker that
 * refuses the lamp update must not turn a completed purge into a failure.
 */
@Injectable()
export class VoicemailRetentionSweeper implements OnModuleInit, OnApplicationShutdown {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private stopped = false;
	private swept = 0;
	private purged = 0;
	private unpurgeable = 0;
	private failed = 0;

	constructor(
		@Inject(PBX_ENV) private readonly env: PbxEnv,
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(PBX_VOICEMAIL_STORE) private readonly store: ObjectStore,
		@Inject(VoicemailMwiPublisher) private readonly mwi: VoicemailMwiPublisher,
	) {}

	get stats(): {
		readonly swept: number;
		readonly purged: number;
		readonly unpurgeable: number;
		readonly failed: number;
	} {
		return {
			swept: this.swept,
			purged: this.purged,
			unpurgeable: this.unpurgeable,
			failed: this.failed,
		};
	}

	onModuleInit(): void {
		if (this.env.PBX_VOICEMAIL_RETENTION_SWEEP_INTERVAL_MS === 0) {
			return;
		}
		// `unref` so a pending timer cannot hold open a process that is otherwise finished.
		this.timer = setInterval(() => {
			void this.sweep();
		}, this.env.PBX_VOICEMAIL_RETENTION_SWEEP_INTERVAL_MS);
		this.timer.unref?.();
		logger.info(
			{
				intervalMs: this.env.PBX_VOICEMAIL_RETENTION_SWEEP_INTERVAL_MS,
				batch: this.env.PBX_VOICEMAIL_RETENTION_SWEEP_BATCH,
			},
			"voicemail retention sweep started; organizations with no voicemailRetentionDays keep messages indefinitely",
		);
	}

	onApplicationShutdown(): void {
		this.stopped = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * One pass. Public so a harness can drive it deterministically rather than waiting out an
	 * interval, which is the only honest way to test a timer.
	 *
	 * Re-entrancy is refused rather than queued: a pass still deleting objects when the next tick
	 * fires is already behind, and a second one would only race it for the same worklist.
	 */
	async sweep(): Promise<VoicemailRetentionSweepResult> {
		if (this.running || this.stopped) {
			return { purged: 0, organizations: 0 };
		}
		this.running = true;
		try {
			return await this.runOnce();
		} catch (error) {
			this.failed += 1;
			logger.error({ err: error }, "the voicemail retention sweep failed");
			return { purged: 0, organizations: 0 };
		} finally {
			this.running = false;
		}
	}

	private async runOnce(): Promise<VoicemailRetentionSweepResult> {
		const now = new Date();
		this.swept += 1;

		const windows = await this.retentionWindows();
		let purged = 0;
		let organizations = 0;
		for (const window of windows) {
			if (this.stopped) {
				break;
			}
			const count = await this.purgeOrganization(window.organizationId, window.days, now);
			if (count > 0) {
				purged += count;
				organizations += 1;
			}
		}

		this.purged += purged;
		if (purged > 0) {
			logger.info({ purged, organizations }, "voicemail retention sweep");
		}
		return { purged, organizations };
	}

	/**
	 * Every organization that has asked for a finite window, read UNTENANTED.
	 *
	 * "Which tenants have a retention window" is not a tenant's question, so it is asked on
	 * `adminDb` on the same reasoning `voicemail-transcription-backfill.ts` sets out for its claim
	 * and the recording sweeper for its worklist. Everything that follows is tenant-scoped: the
	 * organization id comes back on the row and every delete runs inside `withTenantScope` for it,
	 * so RLS is still the filter on the rows that are actually destroyed.
	 *
	 * The value is read defensively — the column is `jsonb` and a hand-written row could hold
	 * anything — and a value that is not a finite positive integer is skipped rather than coerced.
	 * A sweeper must be sure of the policy before it deletes; "I could not read the window"
	 * resolves to keeping.
	 */
	private async retentionWindows(): Promise<readonly RetentionWindow[]> {
		const rows = await this.database.adminDb.execute(sql`
			select organization_id, value
			from org_setting
			where category = ${RECORDING_SETTINGS_CATEGORY}
				and name = ${VOICEMAIL_RETENTION_SETTING}
				and enabled = true
		`);
		const windows: RetentionWindow[] = [];
		for (const row of rowsOf<{ organization_id: string; value: unknown }>(rows)) {
			const days = Number(row.value);
			if (!Number.isInteger(days) || days <= 0) {
				continue;
			}
			windows.push({ organizationId: row.organization_id, days });
		}
		return windows;
	}

	/** One organization's expired messages: objects first, then rows, then the ledger and the lamp. */
	private async purgeOrganization(
		organizationId: string,
		days: number,
		now: Date,
	): Promise<number> {
		const cutoff = new Date(now.getTime() - days * DAY_MS);
		const due = await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				await transaction
					.select({
						id: voicemailMessage.id,
						voicemailBoxId: voicemailMessage.voicemailBoxId,
						objectKey: voicemailMessage.objectKey,
						receivedAt: voicemailMessage.receivedAt,
					})
					.from(voicemailMessage)
					.where(lt(voicemailMessage.receivedAt, cutoff))
					.orderBy(voicemailMessage.receivedAt)
					.limit(this.env.PBX_VOICEMAIL_RETENTION_SWEEP_BATCH),
		);
		if (due.length === 0) {
			return 0;
		}

		const removed: typeof due = [];
		for (const row of due) {
			if (this.stopped) {
				break;
			}
			try {
				await this.store.delete(row.objectKey);
				removed.push(row);
			} catch (error) {
				// Left due on purpose: the row stays readable and stays selected, and the next pass
				// tries again. Counting it is what makes a store that is permanently refusing visible.
				this.unpurgeable += 1;
				logger.warn(
					{ organizationId, messageId: row.id, err: String(error) },
					"an expired voicemail's object could not be removed; the row was left due",
				);
			}
		}
		if (removed.length === 0) {
			return 0;
		}

		const boxes = new Set(removed.map((row) => row.voicemailBoxId));
		const counts = await this.database.withTenantScope(organizationId, async (transaction) => {
			for (const row of removed) {
				await transaction.delete(voicemailMessage).where(eq(voicemailMessage.id, row.id));
				// The ledger row shares the deleting transaction, exactly as every other PBX write
				// does: a delete that rolls back must leave no record claiming it happened. That is
				// affordable here — unlike the CDR sweep, whose "mutation" is in another database —
				// because the row and the ledger live in the same one.
				await insertAuditLog(transaction, {
					organizationId,
					actor: serviceActor("voicemail-retention-sweeper"),
					action: "voicemail-message.purge",
					resourceType: "voicemail_message",
					resourceRef: asUuid(row.id),
					before: {
						voicemailBoxId: row.voicemailBoxId,
						objectKey: row.objectKey,
						receivedAt: row.receivedAt.toISOString(),
						retentionDays: days,
					},
					after: null,
				});
			}
			const lamps: LampUpdate[] = [];
			for (const boxId of boxes) {
				const found = await transaction
					.select({
						mailboxNumber: voicemailBox.mailboxNumber,
						extensionNumber: extension.number,
						mwiEnabled: voicemailBox.mwiEnabled,
					})
					.from(voicemailBox)
					.leftJoin(extension, eq(voicemailBox.extensionId, extension.id))
					.where(eq(voicemailBox.id, boxId))
					.limit(1);
				const box = found[0];
				// `mwiEnabled = false` means "this mailbox does not drive a lamp", and publishing
				// anyway would make every subscriber re-implement the check — the same rule
				// `voicemail-messages.service.ts`'s `announce` follows.
				if (box === undefined || !box.mwiEnabled) {
					continue;
				}
				lamps.push({
					boxId,
					mailboxNumber: box.mailboxNumber,
					extensionNumber: box.extensionNumber ?? undefined,
					counts: await readMailboxCounts(transaction, boxId),
				});
			}
			return lamps;
		});

		for (const lamp of counts) {
			// Best effort, after the commit, on the terms every writer in this area uses: the rows ARE
			// gone, and a broker that refuses the lamp update must not turn a purge into a failure.
			// A mailbox whose `new` messages were purged otherwise leaves a lit phone with nothing
			// behind it.
			await this.mwi.publish(
				organizationId,
				lamp.boxId,
				lamp.mailboxNumber,
				lamp.extensionNumber,
				lamp.counts,
				"message-deleted",
			);
		}

		logger.info(
			{ organizationId, purged: removed.length, retentionDays: days },
			"purged expired voicemail messages",
		);
		return removed.length;
	}
}

export interface VoicemailRetentionSweepResult {
	readonly purged: number;
	/** How many organizations had anything purged this pass. */
	readonly organizations: number;
}

interface LampUpdate {
	readonly boxId: string;
	readonly mailboxNumber: string;
	readonly extensionNumber: string | undefined;
	readonly counts: Awaited<ReturnType<typeof readMailboxCounts>>;
}

interface RetentionWindow {
	readonly organizationId: string;
	readonly days: number;
}

/**
 * Drizzle's `execute` returns the driver's shape: postgres.js yields an array, `pg` yields
 * `{ rows }`. Normalized here so the sweep works under either adapter, exactly as the CDR
 * recording sweeper does for its own worklist.
 */
function rowsOf<T>(result: unknown): readonly T[] {
	if (Array.isArray(result)) {
		return result as readonly T[];
	}
	if (typeof result === "object" && result !== null && "rows" in result) {
		return ((result as { readonly rows?: readonly T[] }).rows ?? []) as readonly T[];
	}
	return [];
}
