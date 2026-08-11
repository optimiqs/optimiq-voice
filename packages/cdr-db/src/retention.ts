import { sql, type SQL } from "drizzle-orm";
import {
	addMonths,
	assertPartitionedCdrTable,
	dropPartitionsBeforeQuery,
	monthStart,
	PARTITIONED_CDR_TABLES,
	toDateLiteral,
	type PartitionedCdrTable,
	type PartitionExecutor,
} from "./partitions";

/**
 * CDR retention.
 *
 * Deliberately NOT a cron, a job runner or a background timer: this package only knows how to
 * compute the cutoff and issue the statements. Phase 2 wires it to whatever scheduler the
 * platform ends up with (a NATS-scheduled engine task or a Kubernetes CronJob calling
 * `scripts/retention.ts`).
 *
 * Two independent sweeps:
 *
 * 1. **Partition drop.** `DROP TABLE <partition>` reclaims a whole month of legs and events in
 *    milliseconds with no bloat — the reason the table is partitioned at all. Only partitions
 *    whose upper bound is at or below the cutoff are dropped, and the default partition is never
 *    touched (dropping it would start failing out-of-range inserts).
 * 2. **Recording expiry.** Rows past `retention_until` are soft-deleted (`deleted_at`) so the
 *    object purge and the row tombstone stay auditable; a separate hard-delete removes tombstones
 *    long after the object is gone.
 */

/** Default retention: 13 months keeps a full year plus the current partial month. */
export const DEFAULT_CDR_RETENTION_MONTHS = 13;

/** Default tombstone retention after an object has been purged from the store. */
export const DEFAULT_RECORDING_TOMBSTONE_MONTHS = 12;

export class RetentionWindowError extends RangeError {
	readonly _tag = "RetentionWindowError" as const;

	constructor(retentionMonths: number) {
		super(
			`CDR retention window must be a whole number of months of at least 1, received ${String(retentionMonths)}.`,
		);
		this.name = "RetentionWindowError";
	}
}

/**
 * First month that must be KEPT. Every partition entirely below this is droppable.
 * `now` is normalized to its month start, so the current partial month always counts as month 1.
 */
export function retentionCutoff(now: Date, retentionMonths: number): Date {
	if (!Number.isInteger(retentionMonths) || retentionMonths < 1) {
		throw new RetentionWindowError(retentionMonths);
	}
	return addMonths(monthStart(now), -(retentionMonths - 1));
}

/** Drops every fully-expired monthly partition of one table and returns the names dropped. */
export async function dropPartitionsBefore(
	executor: PartitionExecutor,
	table: PartitionedCdrTable,
	cutoff: Date,
): Promise<readonly string[]> {
	assertPartitionedCdrTable(table);
	const result = await executor.execute(dropPartitionsBeforeQuery(table, cutoff));
	return returnedRows<{ readonly dropped_partition: string }>(result).map(
		(row) => row.dropped_partition,
	);
}

/** `update recordings set deleted_at = now() where retention_until <= now() and deleted_at is null`. */
export function expiredRecordingsUpdateQuery(now: Date): SQL {
	return sql`
		update "recordings"
		set "deleted_at" = ${now.toISOString()}::timestamptz, "updated_at" = ${now.toISOString()}::timestamptz
		where "retention_until" is not null
			and "retention_until" <= ${now.toISOString()}::timestamptz
			and "deleted_at" is null
		returning "id", "object_key"
	`;
}

/** Selects the object keys the purge worker must remove from the object store, oldest first. */
export function expiredRecordingsSelectQuery(now: Date, limit = 500): SQL {
	return sql`
		select "id", "organization_id", "object_key"
		from "recordings"
		where "retention_until" is not null
			and "retention_until" <= ${now.toISOString()}::timestamptz
			and "deleted_at" is null
		order by "retention_until" asc
		limit ${limit}
	`;
}

/**
 * Tombstones exactly the rows whose object has just been removed from the store.
 *
 * The difference from {@link expiredRecordingsUpdateQuery} is which fact the `deleted_at` is a
 * record OF. That one marks everything past its window in a single statement, which is right for
 * the CLI sweep where the object purge is somebody else's problem; this one is for a worker that
 * deletes the bytes first and then says so, id by id, so a store that refused half the batch
 * leaves those recordings still playable and still due rather than marked deleted with the audio
 * intact behind them.
 *
 * An empty `ids` is a no-op statement rather than a caller-side branch: a purge worker that found
 * nothing should not have to know that `in ()` is a syntax error.
 */
export function purgedRecordingSoftDeleteQuery(now: Date, ids: readonly string[]): SQL {
	if (ids.length === 0) {
		return sql`select null::uuid as "id" where false`;
	}
	return sql`
		update "recordings"
		set "deleted_at" = ${now.toISOString()}::timestamptz, "updated_at" = ${now.toISOString()}::timestamptz
		where "id" = any(${ids}::uuid[])
			and "deleted_at" is null
		returning "id"
	`;
}

/** Removes tombstones whose object was purged longer ago than the tombstone window. */
export function purgedRecordingTombstoneDeleteQuery(before: Date): SQL {
	return sql`
		delete from "recordings"
		where "deleted_at" is not null and "deleted_at" < ${before.toISOString()}::timestamptz
		returning "id"
	`;
}

/**
 * Drizzle's `execute` returns the driver's shape: postgres.js yields an array, `pg` yields
 * `{ rows }`. Both are normalized here so retention works under either adapter.
 */
function returnedRows<T>(result: unknown): readonly T[] {
	if (Array.isArray(result)) {
		return result as readonly T[];
	}
	if (typeof result === "object" && result !== null && "rows" in result) {
		return ((result as { readonly rows?: readonly T[] }).rows ?? []) as readonly T[];
	}
	return [];
}

export interface CdrRetentionPlan {
	readonly now: Date;
	readonly retentionMonths: number;
	/** First month that is kept. */
	readonly cutoff: Date;
	/** `YYYY-MM-DD` form of {@link cutoff}, as written into the range bounds. */
	readonly cutoffDate: string;
	readonly tables: readonly PartitionedCdrTable[];
	readonly tombstoneCutoff: Date;
}

/** Pure description of what a sweep would do. Log this before executing it. */
export function planCdrRetention(
	options: {
		readonly now?: Date;
		readonly retentionMonths?: number;
		readonly tombstoneMonths?: number;
	} = {},
): CdrRetentionPlan {
	const now = options.now ?? new Date();
	const retentionMonths = options.retentionMonths ?? DEFAULT_CDR_RETENTION_MONTHS;
	const cutoff = retentionCutoff(now, retentionMonths);
	const tombstoneMonths = options.tombstoneMonths ?? DEFAULT_RECORDING_TOMBSTONE_MONTHS;
	return {
		now,
		retentionMonths,
		cutoff,
		cutoffDate: toDateLiteral(cutoff),
		tables: PARTITIONED_CDR_TABLES,
		tombstoneCutoff: addMonths(monthStart(now), -tombstoneMonths),
	};
}

export interface CdrRetentionOutcome {
	readonly plan: CdrRetentionPlan;
	readonly droppedPartitions: readonly string[];
	readonly expiredRecordings: number;
	readonly removedTombstones: number;
}

/**
 * Runs the whole sweep as the schema owner. Not tenant-scoped on purpose: retention is a platform
 * lifecycle operation across every organization, and `DROP TABLE` is not expressible under RLS.
 */
export async function runCdrRetention(
	executor: PartitionExecutor,
	options: {
		readonly now?: Date;
		readonly retentionMonths?: number;
		readonly tombstoneMonths?: number;
	} = {},
): Promise<CdrRetentionOutcome> {
	const plan = planCdrRetention(options);
	const droppedPartitions: string[] = [];
	for (const table of plan.tables) {
		droppedPartitions.push(...(await dropPartitionsBefore(executor, table, plan.cutoff)));
	}
	const expired = await executor.execute(expiredRecordingsUpdateQuery(plan.now));
	const tombstones = await executor.execute(
		purgedRecordingTombstoneDeleteQuery(plan.tombstoneCutoff),
	);
	return {
		plan,
		droppedPartitions,
		expiredRecordings: returnedRows(expired).length,
		removedTombstones: returnedRows(tombstones).length,
	};
}
