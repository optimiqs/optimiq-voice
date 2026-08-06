import { createMonthlyPartition, monthlyPartitionName, monthStart } from "@optimiq-voice/cdr-db";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

/**
 * "Does the partition for this leg's month exist?", answered once per month rather than per leg.
 *
 * ## Why the writer ensures at all
 *
 * `call_legs` has a DEFAULT partition, so an insert whose `started_at` falls outside the ensured
 * horizon does not fail — it lands in `call_legs_default`. That is the right behaviour (a CDR must
 * never be refused because a cron did not run) and it is also a trap: rows in the default partition
 * are invisible to the retention sweep, which skips it deliberately, so they accumulate forever and
 * a month that ended up there can never be dropped as a unit. Ensuring on the write path is what
 * keeps the default partition an alarm rather than a destination.
 *
 * ## Why a cache
 *
 * `cdr_ensure_monthly_partition` is idempotent and cheap, but it is still a round trip and a
 * `security definer` call, and the writer makes one insert per finished leg. At any realistic call
 * volume the answer is the same for every leg in a month, so it is asked once and remembered.
 *
 * The cache holds partition NAMES, not booleans, and only for months that were successfully
 * ensured — a failure is not cached, so the next leg retries rather than inheriting a "no" that
 * was true for one second in the past. It is bounded by construction: one entry per calendar
 * month the process has seen, which is a handful over the life of a deployment.
 *
 * ## Why it is not a boot-time job
 *
 * There is one, and it is `scripts/ensure-partitions.ts` — a rolling horizon run by cron. This is
 * the safety net under it, not a replacement: the cron guarantees the horizon exists ahead of
 * time, and this guarantees that a leg whose month somehow was not ensured (a late replay of a
 * three-month-old backlog, a cron that was down over a month boundary) still lands in a real
 * partition.
 */
export class CdrPartitionCache {
	private readonly ensured = new Set<string>();

	constructor(private readonly database: CdrDatabaseClient) {}

	/** How many distinct months this process has ensured. Surfaced in the writer's stats. */
	get size(): number {
		return this.ensured.size;
	}

	/**
	 * Ensures `call_legs` has a partition for the month containing `at`.
	 *
	 * Runs as the schema owner (`adminDb`), which is the only principal the `security definer`
	 * function admits, and OUTSIDE the insert's transaction: `CREATE TABLE ... PARTITION OF` takes
	 * an ACCESS EXCLUSIVE lock on the parent, and holding that inside the same transaction as the
	 * insert would serialise every concurrent writer behind it for the duration.
	 */
	async ensureFor(at: Date): Promise<void> {
		const key = monthlyPartitionName("call_legs", at);
		if (this.ensured.has(key)) {
			return;
		}
		await createMonthlyPartition(this.database.adminDb, "call_legs", monthStart(at));
		this.ensured.add(key);
	}

	/** Forgets everything, so a reconnect re-proves the horizon rather than trusting a stale set. */
	reset(): void {
		this.ensured.clear();
	}
}
