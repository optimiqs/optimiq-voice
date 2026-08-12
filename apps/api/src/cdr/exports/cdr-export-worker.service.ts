import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { nextCursorFrom } from "../query/cdr-cursor";
import { cdrListQuerySchema, MAX_CDR_LIMIT } from "../query/cdr.dto";
import { listCallLegs } from "../query/cdr.repository";
import { CDR_DATABASE, CDR_ENV, CDR_EXPORT_STORE } from "../shared/cdr.tokens";
import { csvHeader, csvRow, CSV_BYTE_ORDER_MARK } from "./cdr-export-csv";
import {
	claimNextExportJob,
	clearExpiredExportObjects,
	completeExportJob,
	failExportJob,
	selectExpiredExports,
} from "./cdr-exports.repository";
import { exportObjectKey } from "./export-token";
import type { ObjectStore } from "../../storage";
import type { CdrEnv } from "../shared/cdr-env";
import type { ClaimableExportJob } from "./cdr-exports.repository";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

const logger = getLogger("api.cdr");

/** How many attempts a job gets before it is failed rather than reclaimed. */
const MAX_ATTEMPTS = 3;

/** Expired export files removed per pass. Bounded so one sweep cannot hold the pool for minutes. */
const EXPIRY_BATCH = 100;

/**
 * Turns queued export jobs into CSV objects.
 *
 * ## Why this is an interval worker and not a JetStream consumer
 *
 * This area already has two durable consumers and it would have been easy to make this a third:
 * publish a `cdr.export.requested` event on the commit, consume it, done. It is not one, and the
 * reason is the same one `voicemail-transcription-backfill.ts` gives for its own claim — **the
 * queue is a column, not a message.** A job's state has to be readable by the API that created it
 * (`GET :id` answers "is it done yet"), which means it is in a row whatever else happens. Adding a
 * message beside the row introduces exactly the bug the status column exists to prevent: a row and
 * a queue entry that disagree, where the row says `queued` for ever because the message was lost,
 * or the message redelivers a job the row says already succeeded.
 *
 * The interval is the poll over the column that is already the truth. `cdr_export_job_pending_idx`
 * is partial (`status in ('queued', 'running')`), so the poll is an index scan the size of the
 * backlog and costs nothing when there is none.
 *
 * ## One at a time, and why
 *
 * Each pass claims ONE job. An export is a full scan of its window and a buffer the size of the
 * result; running four concurrently in one process multiplies both the pool pressure and the peak
 * memory by four, to finish a queue that is almost always length zero or one. When a deployment
 * genuinely needs throughput the answer is more replicas — the claim is a committed
 * compare-and-set with `skip locked`, so N of them share the queue without coordination — rather
 * than more concurrency inside one.
 *
 * ## The lease, and the crash it exists for
 *
 * The claim does not hold a lock across the export; it stamps `claimed_at` and commits. A worker
 * that dies mid-export therefore leaves a row stuck in `running`, and nothing else would ever
 * touch it. `CDR_EXPORT_LEASE_MS` is what unsticks it: a `running` job whose claim is older than
 * the lease is claimable again, `attempts` increments, and after {@link MAX_ATTEMPTS} the job is
 * failed with a sentence rather than retried for ever. A job that reliably kills the process is
 * the case this bounds — without it, one such job stalls every export on the deployment.
 *
 * ## Untenanted claim, tenant-scoped everything else
 *
 * "Which export anywhere is owed work" is not a tenant's question, so the claim runs on `adminDb`.
 * The row it returns carries its `organization_id`, and the ledger read, the object write and the
 * completion all re-enter `withTenantScope` with it — so the rows that reach the CSV are the rows
 * the tenant's own RLS policy would have returned to a request. That is the property that matters:
 * an export is not a privileged read, it is the same read, taken slowly.
 *
 * ## Buffered, not streamed
 *
 * `ObjectStore.put` takes a `Buffer` (`local-object-store.ts` argues a streaming write "would buy
 * nothing but a partially-written object on a mid-write failure"), so the CSV is assembled in
 * memory and stored once. `CDR_EXPORT_MAX_ROWS` is the bound that makes that safe, and a job that
 * reaches it FAILS rather than truncating — a truncated CSV is a plausible-looking file somebody
 * will total a column in. Raising the cap much further means growing an `upload` path on
 * `MirroredObjectStore.put`, which names itself as the method that would.
 */
@Injectable()
export class CdrExportWorker implements OnModuleInit, OnApplicationShutdown {
	private timer: NodeJS.Timeout | undefined;
	private running = false;
	private stopped = false;
	private swept = 0;
	private succeeded = 0;
	private failed = 0;
	private expired = 0;

	constructor(
		@Inject(CDR_ENV) private readonly env: CdrEnv,
		@Inject(CDR_DATABASE) private readonly database: CdrDatabaseClient,
		@Inject(CDR_EXPORT_STORE) private readonly store: ObjectStore,
	) {}

	get stats(): {
		readonly swept: number;
		readonly succeeded: number;
		readonly failed: number;
		readonly expired: number;
	} {
		return {
			swept: this.swept,
			succeeded: this.succeeded,
			failed: this.failed,
			expired: this.expired,
		};
	}

	onModuleInit(): void {
		// Under the writer switch, like the recording sweep and for the same reason: it is a
		// singleton-shaped workload, and every replica polling the same partial index is N-1 wasted
		// scans. Unlike the sweep, N replicas here would still be CORRECT — `skip locked` sees to
		// that — so this is a cost decision rather than a safety one, and an operator who wants
		// export throughput turns the writer on in more than one place deliberately.
		if (!this.env.CDR_WRITER_ENABLED || this.env.CDR_EXPORT_POLL_INTERVAL_MS === 0) {
			return;
		}
		// `unref` so a pending timer cannot hold open a process that is otherwise finished.
		this.timer = setInterval(() => {
			void this.tick();
		}, this.env.CDR_EXPORT_POLL_INTERVAL_MS);
		this.timer.unref?.();
		logger.info(
			{
				intervalMs: this.env.CDR_EXPORT_POLL_INTERVAL_MS,
				maxRows: this.env.CDR_EXPORT_MAX_ROWS,
				ttlHours: this.env.CDR_EXPORT_TTL_HOURS,
			},
			"CDR export worker started",
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
	 * One pass: claim at most one job, then purge whatever expired.
	 *
	 * Public so a harness can drive it deterministically rather than waiting out an interval, which
	 * is the only honest way to test a timer. Re-entrancy is refused rather than queued: a pass
	 * still writing a 20 MB object when the next tick fires is already behind, and a second one
	 * would only compete with it for the pool.
	 */
	async tick(): Promise<{ readonly exported: number; readonly expired: number }> {
		if (this.running || this.stopped) {
			return { exported: 0, expired: 0 };
		}
		this.running = true;
		this.swept += 1;
		try {
			const exported = await this.runOne();
			const expired = await this.purgeExpired();
			return { exported, expired };
		} catch (error) {
			// A pass that throws must not kill the interval. Whatever was not completed is still
			// claimable once its lease runs out.
			logger.error({ err: error }, "the CDR export pass failed");
			return { exported: 0, expired: 0 };
		} finally {
			this.running = false;
		}
	}

	private async runOne(): Promise<number> {
		const leaseCutoff = new Date(Date.now() - this.env.CDR_EXPORT_LEASE_MS);
		const job = await claimNextExportJob(this.database.adminDb, leaseCutoff);
		if (job === undefined) {
			return 0;
		}

		if (job.attempts > MAX_ATTEMPTS) {
			// The lease handed this back more times than a transient failure explains. Failing it is
			// what stops one poisonous job from being the only thing this worker ever does.
			await this.fail(
				job,
				"internal",
				`This export was attempted ${job.attempts} times without completing and has been abandoned. Try a narrower range.`,
			);
			return 0;
		}

		try {
			const written = await this.write(job);
			if (written === undefined) {
				return 0;
			}
			this.succeeded += 1;
			logger.info(
				{ organizationId: job.organizationId, exportId: job.id, rows: written.rowCount },
				"a CDR export completed",
			);
			return 1;
		} catch (error) {
			// Left `running` on purpose rather than failed: this is the first or second attempt at a
			// job whose failure may well be a bucket that was briefly unavailable, and the lease will
			// offer it again. `attempts` is what turns "again" into "eventually, no".
			logger.error(
				{ organizationId: job.organizationId, exportId: job.id, err: error },
				"a CDR export attempt failed; it will be retried when its lease expires",
			);
			this.failed += 1;
			return 0;
		}
	}

	/**
	 * Walks the ledger with the job's own filters and stores the CSV.
	 *
	 * The walk uses `listCallLegs` — the SAME function the list endpoint calls, with the same keyset
	 * cursor. That is deliberate and it is the property that makes an export trustworthy: a file
	 * that disagreed with the screen it was exported from would be worse than no file, and the only
	 * way to guarantee it does not is for both to be the same query.
	 *
	 * The page size is `MAX_CDR_LIMIT` rather than something larger. A bigger page would mean fewer
	 * round trips and a longer-held snapshot; a hundred rows at a time is what the index is shaped
	 * for, and the round trips are on a connection this worker already owns.
	 */
	private async write(job: ClaimableExportJob): Promise<{ readonly rowCount: number } | undefined> {
		// Re-parsed rather than trusted. The row was written by a DTO that has since been able to
		// change, and a filter that is no longer valid must not reach a query builder — it becomes a
		// failed job with a readable reason instead. `catch` rather than `parse` for exactly that.
		const parsed = cdrListQuerySchema.safeParse({
			...job.filters,
			from: job.rangeFrom.toISOString(),
			to: job.rangeTo.toISOString(),
			limit: MAX_CDR_LIMIT,
		});
		if (!parsed.success) {
			await this.fail(
				job,
				"internal",
				"The filters stored with this export are no longer valid; create a new one.",
			);
			return undefined;
		}

		const range = { from: job.rangeFrom, to: job.rangeTo };
		const chunks: string[] = [CSV_BYTE_ORDER_MARK, csvHeader()];
		let rowCount = 0;
		let cursor: string | undefined;

		for (;;) {
			if (this.stopped) {
				// Shutdown mid-export. Nothing has been written to the store and nothing has been
				// marked, so the job is still `running` with an expired-soon lease and the next process
				// to come up takes it from the top. Restarting the walk is cheaper than resuming it.
				return undefined;
			}
			const query = cursor === undefined ? parsed.data : { ...parsed.data, cursor };
			const page = await this.database.withTenantScope(
				job.organizationId,
				async (transaction) => await listCallLegs(transaction, query, range),
			);
			for (const leg of page.rows) {
				chunks.push(csvRow(leg));
			}
			rowCount += page.rows.length;

			if (rowCount > this.env.CDR_EXPORT_MAX_ROWS) {
				await this.fail(
					job,
					"too-many-rows",
					`This export matched more than ${this.env.CDR_EXPORT_MAX_ROWS.toLocaleString("en-US")} calls. Narrow the date range or add a filter, then try again — the file is not produced partially, because a truncated report is worse than none.`,
				);
				return undefined;
			}

			const next = nextCursorFrom(page.rows, query.limit, page.fetched);
			if (next === null) {
				break;
			}
			cursor = next;
		}

		const objectKey = exportObjectKey(job.organizationId, job.id);
		const bytes = Buffer.from(chunks.join(""), "utf8");
		await this.store.put(objectKey, bytes, { contentType: "text/csv; charset=utf-8" });

		await this.database.withTenantScope(
			job.organizationId,
			async (transaction) =>
				await completeExportJob(transaction, job.id, {
					objectKey,
					rowCount,
					sizeBytes: bytes.byteLength,
				}),
		);
		return { rowCount };
	}

	private async fail(
		job: ClaimableExportJob,
		reason: "too-many-rows" | "storage" | "internal",
		detail: string,
	): Promise<void> {
		this.failed += 1;
		await this.database.withTenantScope(
			job.organizationId,
			async (transaction) => await failExportJob(transaction, job.id, reason, detail),
		);
	}

	/**
	 * Removes export files whose download window has closed.
	 *
	 * Objects first, row second — the same ordering the recording sweep argues for, and here it
	 * matters even more: a row cleared before its object leaves a CSV of somebody's call history in
	 * the bucket that nothing points at, which means nothing will ever find it again. A store that
	 * refuses a delete leaves the row pointing at the file, still expired, and picked up next pass.
	 *
	 * The ROW survives. `requested_by`, `filters` and the window stay as the record that this
	 * question was asked on this day; only the artefact expires. That is why this clears
	 * `object_key` rather than deleting the row, and it is the same distinction `recordings` draws
	 * with its `deleted_at` tombstone.
	 */
	private async purgeExpired(): Promise<number> {
		const due = await selectExpiredExports(this.database.adminDb, new Date(), EXPIRY_BATCH);
		if (due.length === 0) {
			return 0;
		}
		const removed: string[] = [];
		for (const row of due) {
			if (this.stopped) {
				break;
			}
			try {
				await this.store.delete(row.objectKey);
				removed.push(row.id);
			} catch (error) {
				logger.warn(
					{ exportId: row.id, err: String(error) },
					"an expired export object could not be removed; the row was left pointing at it",
				);
			}
		}
		const cleared = await clearExpiredExportObjects(this.database.adminDb, removed);
		this.expired += cleared;
		if (cleared > 0) {
			logger.info({ cleared }, "expired CDR export files were purged");
		}
		return cleared;
	}
}
