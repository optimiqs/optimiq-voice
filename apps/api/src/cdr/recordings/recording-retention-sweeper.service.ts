import {
	Inject,
	Injectable,
	Optional,
	type OnApplicationShutdown,
	type OnModuleInit,
} from "@nestjs/common";
import {
	expiredRecordingsSelectQuery,
	purgedRecordingSoftDeleteQuery,
	purgedRecordingTombstoneDeleteQuery,
	DEFAULT_RECORDING_TOMBSTONE_MONTHS,
} from "@optimiq-voice/cdr-db";
import { getLogger } from "@optimiq-voice/logging";
import { CDR_DATABASE, CDR_ENV, CDR_RECORDING_STORE } from "../shared/cdr.tokens";
import { RECORDING_PURGE_AUDIT } from "./purge-audit";
import type { ObjectStore } from "../../storage";
import type { CdrEnv } from "../shared/cdr-env";
import type { RecordingPurgeAudit } from "./purge-audit";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

const logger = getLogger("api.cdr");

/** Milliseconds in a day; the tombstone window is expressed in months of thirty of them. */
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Purges recordings whose retention window has run out.
 *
 * ## What was missing, and what this closes
 *
 * `packages/cdr-db/src/retention.ts` has had the whole vocabulary since it was written — the
 * worklist query, the soft delete, the tombstone purge — and `recordings.retention_until` has had
 * a column and a partial index built for exactly this scan. Nothing called any of it: no scheduler
 * ran the sweep, and nothing had ever written the column, so every recording was "keep for ever"
 * and the retention policy in the product was a date in a table nobody read.
 *
 * ## Objects first, row second, ledger third
 *
 * The order is the whole design. A row tombstoned before its object is gone is a recording the API
 * refuses to play (`recordings.service.ts` returns 410 on `deleted_at`) while the audio is still
 * sitting in the bucket — deleted for the customer and retained for a subpoena, which is the worst
 * of both. So the object is removed first, and only the ids whose delete actually returned are
 * marked. A store that refused half the batch leaves those recordings playable, still expired, and
 * picked up again on the next pass.
 *
 * `ObjectStore.delete` is idempotent on all three drivers — an object that is already gone is the
 * state we wanted — so a retry costs nothing.
 *
 * ## Untenanted read, tenant-scoped delete
 *
 * "Which recordings anywhere are past their window" is not a tenant's question, so the worklist is
 * read on `adminDb`, on the same reasoning `voicemail-transcription-backfill.ts` sets out for its
 * claim. Every row that comes back carries its `organization_id`, and the object key it names is
 * already tenant-prefixed (`<orgId>/<callId>/<recordingId>.<format>`), so the delete that follows
 * cannot reach outside the tenant that owns the row.
 *
 * ## What this deliberately does NOT do
 *
 * It does not drop CDR partitions. That half of `runCdrRetention` is a `DROP TABLE` against the
 * billing ledger, it is not reversible, and it belongs to an operator running
 * `packages/cdr-db/scripts/retention.ts` deliberately — not to a timer inside an API replica.
 */
@Injectable()
export class CdrRecordingRetentionSweeper implements OnModuleInit, OnApplicationShutdown {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private stopped = false;
	private swept = 0;
	private purged = 0;
	private tombstoned = 0;
	private unpurgeable = 0;
	private failed = 0;

	constructor(
		@Inject(CDR_ENV) private readonly env: CdrEnv,
		@Inject(CDR_DATABASE) private readonly database: CdrDatabaseClient,
		@Inject(CDR_RECORDING_STORE) private readonly store: ObjectStore,
		/**
		 * The purge ledger, implemented on the PBX side of the port and therefore OPTIONAL: a
		 * deployment without the PBX area has no `audit_log` to write, and the sweep must keep
		 * purging on schedule regardless — see `purge-audit.ts`.
		 */
		@Optional()
		@Inject(RECORDING_PURGE_AUDIT)
		private readonly purgeAudit?: RecordingPurgeAudit,
	) {}

	get stats(): {
		readonly swept: number;
		readonly purged: number;
		readonly tombstoned: number;
		readonly unpurgeable: number;
		readonly failed: number;
	} {
		return {
			swept: this.swept,
			purged: this.purged,
			tombstoned: this.tombstoned,
			unpurgeable: this.unpurgeable,
			failed: this.failed,
		};
	}

	onModuleInit(): void {
		// Under the writer switch, because it is the same kind of workload: one deployment should
		// own it, and N replicas sweeping the same batch would be N-1 wasted passes over a bucket.
		if (!this.env.CDR_WRITER_ENABLED || this.env.CDR_RECORDING_SWEEP_INTERVAL_MS === 0) {
			return;
		}
		// `unref` so a pending timer cannot hold open a process that is otherwise finished.
		this.timer = setInterval(() => {
			void this.sweep();
		}, this.env.CDR_RECORDING_SWEEP_INTERVAL_MS);
		this.timer.unref?.();
		logger.info(
			{
				intervalMs: this.env.CDR_RECORDING_SWEEP_INTERVAL_MS,
				batch: this.env.CDR_RECORDING_SWEEP_BATCH,
				retentionDays: this.env.CDR_RECORDING_RETENTION_DAYS,
			},
			this.env.CDR_RECORDING_RETENTION_DAYS === 0
				? "recording retention sweep started; new recordings are kept indefinitely (CDR_RECORDING_RETENTION_DAYS=0)"
				: "recording retention sweep started",
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
	async sweep(): Promise<RecordingSweepResult> {
		if (this.running || this.stopped) {
			return { purged: 0, tombstoned: 0 };
		}
		this.running = true;
		try {
			return await this.runOnce();
		} catch (error) {
			// A sweep that throws must not kill the interval. Nothing was tombstoned that was not
			// purged, so the next tick picks the same rows up.
			this.failed += 1;
			logger.error({ err: error }, "the recording retention sweep failed");
			return { purged: 0, tombstoned: 0 };
		} finally {
			this.running = false;
		}
	}

	private async runOnce(): Promise<RecordingSweepResult> {
		const now = new Date();
		this.swept += 1;

		const due = rowsOf<ExpiredRecordingRow>(
			await this.database.adminDb.execute(
				expiredRecordingsSelectQuery(now, this.env.CDR_RECORDING_SWEEP_BATCH),
			),
		);

		const removed: string[] = [];
		for (const row of due) {
			if (this.stopped) {
				break;
			}
			try {
				await this.store.delete(row.object_key);
				removed.push(row.id);
			} catch (error) {
				// Left due on purpose: the row stays playable and stays selected, and the next pass
				// tries again. Counting it is what makes a bucket that is permanently refusing visible.
				this.unpurgeable += 1;
				logger.warn(
					{ recordingId: row.id, organizationId: row.organization_id, err: String(error) },
					"a expired recording's object could not be removed; the row was left due",
				);
			}
		}

		const tombstoned = rowsOf(
			await this.database.adminDb.execute(purgedRecordingSoftDeleteQuery(now, removed)),
		).length;

		await this.auditPurged(due, removed);

		// The second half: rows whose object went long enough ago that the tombstone itself has
		// served its purpose. Independent of the batch above, and cheap when there is nothing to do.
		const purgedTombstones = rowsOf(
			await this.database.adminDb.execute(
				purgedRecordingTombstoneDeleteQuery(
					new Date(now.getTime() - DEFAULT_RECORDING_TOMBSTONE_MONTHS * 30 * DAY_MS),
				),
			),
		).length;

		this.purged += removed.length;
		this.tombstoned += tombstoned;

		if (removed.length > 0 || purgedTombstones > 0) {
			logger.info(
				{
					due: due.length,
					purged: removed.length,
					tombstoned,
					removedTombstones: purgedTombstones,
				},
				"recording retention sweep",
			);
		}
		return { purged: removed.length, tombstoned };
	}

	/**
	 * The audit row on delete — one ledger entry per recording whose OBJECT actually went, written
	 * through the optional port after the tombstone so the ledger never claims a purge the next
	 * pass will retry. AFTER the tombstone rather than inside anything: the purge is already
	 * irreversible by then (the bytes are gone), so the honest failure mode of a ledger outage is
	 * a purge that happened and was not recorded — logged loudly here — never a record of a purge
	 * that did not happen. The failure is swallowed for the same reason the port is optional: the
	 * sweep enforcing the retention window must not be hostage to the OTHER database's uptime.
	 */
	private async auditPurged(
		due: readonly ExpiredRecordingRow[],
		removed: readonly string[],
	): Promise<void> {
		if (this.purgeAudit === undefined || removed.length === 0) {
			return;
		}
		const removedSet = new Set(removed);
		const byOrganization = new Map<string, { recordingId: string; objectKey: string }[]>();
		for (const row of due) {
			if (!removedSet.has(row.id)) {
				continue;
			}
			const entries = byOrganization.get(row.organization_id) ?? [];
			entries.push({ recordingId: row.id, objectKey: row.object_key });
			byOrganization.set(row.organization_id, entries);
		}
		for (const [organizationId, entries] of byOrganization) {
			try {
				await this.purgeAudit.recordAudit(organizationId, entries);
			} catch (error) {
				logger.error(
					{ organizationId, purged: entries.length, err: String(error) },
					"purged recordings could not be recorded in the audit ledger",
				);
			}
		}
	}
}

export interface RecordingSweepResult {
	readonly purged: number;
	readonly tombstoned: number;
}

/** The worklist row shape, snake-cased because it comes back from raw SQL. */
interface ExpiredRecordingRow {
	readonly id: string;
	readonly organization_id: string;
	readonly object_key: string;
}

/**
 * Drizzle's `execute` returns the driver's shape: postgres.js yields an array, `pg` yields
 * `{ rows }`. Normalized here so the sweep works under either adapter, exactly as `retention.ts`
 * does for its own callers.
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
