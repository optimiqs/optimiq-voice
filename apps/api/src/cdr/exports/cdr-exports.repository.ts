import { and, cdrExportJob, desc, eq, or, sql } from "@optimiq-voice/cdr-db";
import { decodeCdrCursor } from "../query/cdr-cursor";
import type { CdrExportListQuery } from "./cdr-exports.dto";
import type { CdrDatabaseTransaction, CdrExportFailure, SQL } from "@optimiq-voice/cdr-db";

/**
 * Data access for the export lifecycle.
 *
 * Free functions taking a transaction, exactly like `cdr.repository.ts`: the tenant is established
 * by `withTenantScope` before any of these run and none of them accepts an organization id, so
 * there is no place for a query here to be wrong about a tenant. The one exception is
 * {@link claimNextExportJob}, which runs on the admin connection and says so in its own comment.
 */

/** Columns a client sees. `filters` comes back so a UI can say what an old job actually asked for. */
const EXPORT_COLUMNS = {
	id: cdrExportJob.id,
	status: cdrExportJob.status,
	requestedBy: cdrExportJob.requestedBy,
	filters: cdrExportJob.filters,
	rangeFrom: cdrExportJob.rangeFrom,
	rangeTo: cdrExportJob.rangeTo,
	attempts: cdrExportJob.attempts,
	objectKey: cdrExportJob.objectKey,
	rowCount: cdrExportJob.rowCount,
	sizeBytes: cdrExportJob.sizeBytes,
	failureReason: cdrExportJob.failureReason,
	failureDetail: cdrExportJob.failureDetail,
	completedAt: cdrExportJob.completedAt,
	expiresAt: cdrExportJob.expiresAt,
	createdAt: cdrExportJob.createdAt,
} as const;

/**
 * The row shape, with nullability taken from the column rather than assumed away.
 *
 * `cdr.repository.ts` derives its row types as `Column["_"]["data"]`, which is the base type and
 * silently drops the `| null` a nullable column carries — a `CallLegListRow.answeredAt` is typed
 * `Date` when an unanswered leg's really is `null`. That is a latent looseness rather than a bug
 * there, because nothing in the reporting path branches on it.
 *
 * Here it would be a bug. Half the interesting columns are nullable and every one of them is
 * BRANCHED on: `objectKey === null` is how the download endpoint knows there is no file,
 * `failureReason` is how a client renders why. So the `notNull` flag is consulted, and a column
 * that may be null is typed that way. The extra conditional is the price of not writing
 * `row.objectKey!` four times.
 */
export type CdrExportListRow = {
	[K in keyof typeof EXPORT_COLUMNS]: (typeof EXPORT_COLUMNS)[K]["_"]["notNull"] extends true
		? (typeof EXPORT_COLUMNS)[K]["_"]["data"]
		: (typeof EXPORT_COLUMNS)[K]["_"]["data"] | null;
};

export interface CdrExportPage {
	readonly rows: readonly CdrExportListRow[];
	/** One more than the page holds was asked for; this is how many came back. */
	readonly fetched: number;
}

/**
 * The keyset comparison for `(created_at, id) DESC`, as a row comparison.
 *
 * Same form and same reason as `cdr.repository.ts`'s `keysetBefore`: PostgreSQL turns the row
 * comparison into one index seek and usually turns the expanded boolean form into a filter.
 *
 * The cursor TYPE is reused (`CdrCursor.startedAt` carries a `created_at` here), which
 * `listRecordings` already does for the same reason: the wire format is `<iso>|<uuid>` and a
 * second identical encoder differing only in a field name would be two things to keep in step for
 * no gain. Naming it `startedAt` in a place that means `createdAt` is the cost, and it is paid in
 * this comment rather than in a duplicate module.
 */
function keysetBefore(createdAt: Date, id: string): SQL {
	return sql`(${cdrExportJob.createdAt}, ${cdrExportJob.id}) < (${createdAt.toISOString()}::timestamptz, ${id}::uuid)`;
}

export async function listExportJobs(
	transaction: CdrDatabaseTransaction,
	query: CdrExportListQuery,
): Promise<CdrExportPage> {
	const filters: SQL[] = [];
	if (query.status !== undefined) {
		filters.push(eq(cdrExportJob.status, query.status) as SQL);
	}
	if (query.cursor !== undefined) {
		const cursor = decodeCdrCursor(query.cursor);
		filters.push(keysetBefore(cursor.startedAt, cursor.id));
	}

	const rows = await transaction
		.select(EXPORT_COLUMNS)
		.from(cdrExportJob)
		.where(filters.length === 0 ? undefined : and(...filters))
		.orderBy(desc(cdrExportJob.createdAt), desc(cdrExportJob.id))
		// One more than asked for, so "is there a next page" is answered by evidence rather than by
		// the ambiguous `rows.length === limit`. See `nextCursorFrom`.
		.limit(query.limit + 1);

	return { rows: rows.slice(0, query.limit), fetched: rows.length };
}

export async function getExportJob(
	transaction: CdrDatabaseTransaction,
	id: string,
): Promise<CdrExportListRow | undefined> {
	const rows = await transaction
		.select(EXPORT_COLUMNS)
		.from(cdrExportJob)
		.where(eq(cdrExportJob.id, id))
		.limit(1);
	return rows[0];
}

/** How many of a tenant's exports are still owed work. Bounds one client's share of the worker. */
export async function countPendingExportJobs(transaction: CdrDatabaseTransaction): Promise<number> {
	const rows = await transaction
		.select({ id: cdrExportJob.id })
		.from(cdrExportJob)
		.where(or(eq(cdrExportJob.status, "queued"), eq(cdrExportJob.status, "running")))
		.limit(64);
	return rows.length;
}

export interface NewExportJob {
	readonly organizationId: string;
	readonly requestedBy: string | null;
	readonly filters: Readonly<Record<string, unknown>>;
	readonly rangeFrom: Date;
	readonly rangeTo: Date;
	readonly expiresAt: Date;
}

export async function insertExportJob(
	transaction: CdrDatabaseTransaction,
	values: NewExportJob,
): Promise<CdrExportListRow> {
	const rows = await transaction
		.insert(cdrExportJob)
		.values({
			organizationId: values.organizationId,
			requestedBy: values.requestedBy,
			filters: values.filters,
			rangeFrom: values.rangeFrom,
			rangeTo: values.rangeTo,
			expiresAt: values.expiresAt,
		})
		.returning(EXPORT_COLUMNS);
	const row = rows[0];
	if (row === undefined) {
		throw new Error("the export job insert returned no row");
	}
	return row;
}

/** Removes a job and reports whether there was one. The object is the caller's to delete first. */
export async function deleteExportJob(
	transaction: CdrDatabaseTransaction,
	id: string,
): Promise<boolean> {
	const rows = await transaction
		.delete(cdrExportJob)
		.where(eq(cdrExportJob.id, id))
		.returning({ id: cdrExportJob.id });
	return rows.length > 0;
}

// ---------------------------------------------------------------------------------------------
// The worker's half
// ---------------------------------------------------------------------------------------------

export interface ClaimableExportJob {
	readonly id: string;
	readonly organizationId: string;
	readonly filters: Readonly<Record<string, unknown>>;
	readonly rangeFrom: Date;
	readonly rangeTo: Date;
	readonly attempts: number;
}

/**
 * Takes the oldest claimable job, anywhere, and marks it running — in one committed statement.
 *
 * ## Why this runs untenanted
 *
 * "Which export anywhere is owed work" is not a tenant's question, so the claim reads on the admin
 * connection. That is the same argument `voicemail-transcription-backfill.ts` sets out for its own
 * claim, and the same safety property holds: the row that comes back carries its
 * `organization_id`, and everything the worker does afterwards — the ledger read, the object write,
 * the completion — re-enters `withTenantScope` with it. The untenanted reach is exactly one
 * statement wide.
 *
 * ## Why it is a compare-and-set and not a lock
 *
 * `for update skip locked` inside the sub-select is what stops two replicas taking the same row;
 * the predicate is then RESTATED in the outer `where` so the update is still correct if the
 * sub-select's snapshot is stale. The lock is released by the commit of this statement rather than
 * held across the export — an export takes seconds to minutes, and a transaction held open for
 * that long is a connection this pool cannot spare and a vacuum this database cannot run.
 *
 * What replaces the held lock is the LEASE: `claimed_at` plus `leaseCutoff`. A worker that dies
 * mid-export leaves a `running` row whose claim is older than the lease, and the next pass takes
 * it again — which is why `attempts` increments here and why the caller gives up after a few.
 * Without the lease, one crash would strand a job in `running` for ever.
 */
export async function claimNextExportJob(
	executor: {
		execute(query: SQL): Promise<unknown>;
	},
	leaseCutoff: Date,
): Promise<ClaimableExportJob | undefined> {
	const claim = sql`
		update ${cdrExportJob}
		set status = 'running',
		    claimed_at = now(),
		    attempts = ${cdrExportJob.attempts} + 1,
		    updated_at = now()
		where ${cdrExportJob.id} = (
			select ${cdrExportJob.id}
			from ${cdrExportJob}
			where status = 'queued'
			   or (status = 'running' and claimed_at is not null and claimed_at <= ${leaseCutoff.toISOString()}::timestamptz)
			order by ${cdrExportJob.createdAt} asc
			limit 1
			for update skip locked
		)
		  and (
			status = 'queued'
			or (status = 'running' and claimed_at is not null and claimed_at <= ${leaseCutoff.toISOString()}::timestamptz)
		  )
		returning ${cdrExportJob.id} as id,
		          ${cdrExportJob.organizationId} as organization_id,
		          ${cdrExportJob.filters} as filters,
		          ${cdrExportJob.rangeFrom} as range_from,
		          ${cdrExportJob.rangeTo} as range_to,
		          ${cdrExportJob.attempts} as attempts
	`;
	const claimed = rowsOf<ClaimedRow>(await executor.execute(claim))[0];
	if (claimed === undefined) {
		return undefined;
	}
	return {
		id: claimed.id,
		organizationId: claimed.organization_id,
		filters: (claimed.filters ?? {}) as Readonly<Record<string, unknown>>,
		rangeFrom: new Date(claimed.range_from),
		rangeTo: new Date(claimed.range_to),
		attempts: claimed.attempts,
	};
}

interface ClaimedRow {
	readonly id: string;
	readonly organization_id: string;
	readonly filters: unknown;
	readonly range_from: string;
	readonly range_to: string;
	readonly attempts: number;
}

/** Marks a job done. Runs tenant-scoped: the worker knows the organization by then. */
export async function completeExportJob(
	transaction: CdrDatabaseTransaction,
	id: string,
	values: {
		readonly objectKey: string;
		readonly rowCount: number;
		readonly sizeBytes: number;
	},
): Promise<void> {
	await transaction
		.update(cdrExportJob)
		.set({
			status: "succeeded",
			objectKey: values.objectKey,
			rowCount: values.rowCount,
			sizeBytes: values.sizeBytes,
			// Cleared so the lease reclaim cannot pick a finished job up: the predicate is
			// `status = 'running'`, and this is belt and braces on the same fact.
			claimedAt: null,
			completedAt: new Date(),
			failureReason: null,
			failureDetail: null,
			updatedAt: new Date(),
		})
		.where(eq(cdrExportJob.id, id));
}

/**
 * Marks a job failed, with a reason a client can switch on and a sentence a person can read.
 *
 * `failureDetail` is truncated here rather than at the call site so no caller can be the one that
 * forgets — the column is unbounded text and an unbounded error string is how a stack trace ends
 * up in an API response.
 */
export async function failExportJob(
	transaction: CdrDatabaseTransaction,
	id: string,
	reason: CdrExportFailure,
	detail: string,
): Promise<void> {
	await transaction
		.update(cdrExportJob)
		.set({
			status: "failed",
			claimedAt: null,
			completedAt: new Date(),
			failureReason: reason,
			failureDetail: detail.slice(0, 500),
			updatedAt: new Date(),
		})
		.where(eq(cdrExportJob.id, id));
}

/** Finished exports whose download window has closed, oldest first. Untenanted, like the claim. */
export async function selectExpiredExports(
	executor: { execute(query: SQL): Promise<unknown> },
	now: Date,
	limit: number,
): Promise<readonly { readonly id: string; readonly objectKey: string }[]> {
	const query = sql`
		select ${cdrExportJob.id} as id, ${cdrExportJob.objectKey} as object_key
		from ${cdrExportJob}
		where ${cdrExportJob.objectKey} is not null
		  and ${cdrExportJob.expiresAt} is not null
		  and ${cdrExportJob.expiresAt} <= ${now.toISOString()}::timestamptz
		order by ${cdrExportJob.expiresAt} asc
		limit ${limit}
	`;
	return rowsOf<{ readonly id: string; readonly object_key: string }>(
		await executor.execute(query),
	).map((row) => ({ id: row.id, objectKey: row.object_key }));
}

/**
 * Forgets the file, keeps the row.
 *
 * The row survives as the record that somebody exported this window on this day — which is the
 * whole reason `requested_by` is on the table. Only the artefact expires.
 */
export async function clearExpiredExportObjects(
	executor: { execute(query: SQL): Promise<unknown> },
	ids: readonly string[],
): Promise<number> {
	if (ids.length === 0) {
		return 0;
	}
	const list = sql.join(
		ids.map((id) => sql`${id}::uuid`),
		sql`, `,
	);
	const query = sql`
		update ${cdrExportJob}
		set object_key = null, size_bytes = 0, updated_at = now()
		where ${cdrExportJob.id} in (${list})
		returning ${cdrExportJob.id} as id
	`;
	return rowsOf(await executor.execute(query)).length;
}

/**
 * Drizzle's `execute` returns the driver's shape: postgres.js yields an array, `pg` yields
 * `{ rows }`. Normalized here so these statements work under either adapter, exactly as
 * `retention.ts` and the recording sweeper already do.
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
