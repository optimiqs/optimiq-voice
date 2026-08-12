import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgPolicy, pgTable, text } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	tenantOrganizationScope,
	utcTimestamp,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { cdrTenantContext } from "../cdr-context";

const tenantScope = tenantOrganizationScope(cdrTenantContext);

/**
 * The lifecycle of one export.
 *
 * Four states and no more. `queued` is what a request creates; `running` is a worker's claim;
 * `succeeded` and `failed` are terminal. There is no `cancelled`, because nothing can cancel one
 * yet, and a state a client can read but never reach is a promise the API cannot keep.
 *
 * `running` is a CLAIM rather than a phase: it carries `claimed_at`, and a worker that dies
 * mid-write leaves a row that is stuck in it. That is deliberate and it is why `claimed_at` exists
 * — the reclaim predicate is "queued, or running since before the lease expired", which is the
 * same committed compare-and-set the voicemail transcription back-fill uses and for the same
 * reason: a row whose status and whose queue entry can disagree is the bug a separate queue table
 * would introduce.
 */
export const CDR_EXPORT_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type CdrExportStatus = (typeof CDR_EXPORT_STATUSES)[number];

/** Why an export produced no file. A closed set so a client can switch on it and say something useful. */
export const CDR_EXPORT_FAILURES = ["too-many-rows", "storage", "internal"] as const;
export type CdrExportFailure = (typeof CDR_EXPORT_FAILURES)[number];

/**
 * `cdr_export_job` — one asynchronous CSV extraction of the call ledger.
 *
 * ## Why a table and not the outbox
 *
 * `pbx_projection_outbox` is the closest existing shape and it is deliberately NOT reused, because
 * the two differ on the one property that decides everything else. The outbox is stateless about
 * its payload — "re-derive, never replay" — and it can be, because every projection it drives is a
 * whole-organization reconcile whose right answer is always "the current state". An export is the
 * opposite: it is a snapshot of a question asked at a moment. Re-deriving "the last 92 days" a day
 * later produces a different file from the one the user asked for, and a user who downloads a
 * report has every right to expect the bytes to match the filters they submitted.
 *
 * So `filters` is a real payload rather than a diagnostic one, and `range_from`/`range_to` are
 * resolved columns rather than being left inside it: the window is what an operator answering
 * "which export is eating the pool?" needs to see without parsing JSON, and it is what the
 * worklist would be indexed on if this ever grows one.
 *
 * ## Why it is not append-only
 *
 * It is the second read-write table in this database, for the same reason `recordings` is the
 * first: the row is a lifecycle, not a record of something that happened. `call_legs` and
 * `call_events` are LEDGERS and the tenant role holds no UPDATE on them by privilege; a job row is
 * claimed, advanced and completed, and the RLS preflight plan says so.
 *
 * ## What the tenant may write, and what only the worker writes
 *
 * Everything after `filters` is written by the worker under the tenant's own scope: the worker
 * re-enters `withTenantScope` with the row's `organization_id` before it touches anything, so the
 * privilege it uses is the tenant's and the RLS policy is the same one a request would meet. The
 * API refuses those columns in its DTO, which is where "a client cannot claim its own export
 * succeeded" is enforced — not here. A check constraint that tried to express it would have to
 * know which principal was writing, which SQL cannot see.
 *
 * `object_key` is nullable until there is a file, and stays null forever on a failure. It is not
 * unique: an export is written once and never rewritten, so the natural key is the row id and the
 * object key is derived from it (`exports/<org>/<jobId>.csv`). That is the opposite of
 * `recordings.object_key`, where the key arrives from outside and is the only stable identity the
 * writer has.
 */
export const cdrExportJob = pgTable.withRLS(
	"cdr_export_job",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),

		/**
		 * Who asked. A better-auth user id from a different database, so it is a bare uuid with no
		 * foreign key — the same cross-context rule every other id in this journal follows.
		 *
		 * Kept because an export is the one read in this area that produces a durable artefact
		 * somebody can carry out of the building, and "who extracted the call history" is the first
		 * question asked about it afterwards.
		 */
		requestedBy: text("requested_by"),

		status: text("status").$type<CdrExportStatus>().notNull().default("queued"),

		/**
		 * The pinned query, exactly as the DTO parsed it.
		 *
		 * `jsonb` and not a column per filter, and that is a genuine trade. Columns would let an
		 * operator query "who exported everything for +1212555?" directly; a blob makes the job row
		 * unable to drift out of step with `cdrListQuerySchema`, which gains a filter roughly every
		 * time the reporting screen does. The blob wins because the DTO is the contract and a
		 * half-migrated set of filter columns silently changes what a re-run would produce.
		 */
		filters: jsonb("filters").$type<Readonly<Record<string, unknown>>>().notNull().default({}),

		/** The resolved window, lifted out of `filters` so it is queryable and human-readable. */
		rangeFrom: utcTimestamp("range_from").notNull(),
		rangeTo: utcTimestamp("range_to").notNull(),

		/** Set when a worker takes the row. Null once the job is terminal; the lease reclaims on it. */
		claimedAt: utcTimestamp("claimed_at"),
		attempts: integer("attempts").notNull().default(0),

		/** `exports/<organizationId>/<id>.csv` once the bytes are in the store. */
		objectKey: text("object_key"),
		rowCount: integer("row_count").notNull().default(0),
		sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),

		failureReason: text("failure_reason").$type<CdrExportFailure>(),
		/** A sentence for a human, truncated by the worker. Never a stack. */
		failureDetail: text("failure_detail"),

		completedAt: utcTimestamp("completed_at"),
		/**
		 * When the file stops being downloadable and becomes eligible for purging.
		 *
		 * An export is a copy of the ledger sitting outside the ledger's own access controls, so it
		 * expires by default rather than on request — the opposite of `recordings.retention_until`,
		 * which is null (keep for ever) until a policy says otherwise. A report nobody fetched in a
		 * fortnight is a liability, not an asset.
		 */
		expiresAt: utcTimestamp("expires_at"),

		...auditTimestampColumns(),
	},
	(table) => [
		// The worker's only query shape: the oldest claimable job, anywhere. Partial so the index
		// stays the size of the backlog rather than of the history.
		index("cdr_export_job_pending_idx")
			.on(table.createdAt)
			.where(sql`status in ('queued', 'running')`),
		// The list endpoint: one tenant's exports, newest first.
		index("cdr_export_job_organization_created_idx").on(
			table.organizationId,
			table.createdAt.desc().nullsLast(),
		),
		// The purge: files whose window has run out. Partial for the same reason as the worklist.
		index("cdr_export_job_expiry_idx")
			.on(table.expiresAt)
			.where(sql`object_key is not null and expires_at is not null`),

		check(
			"cdr_export_job_status_check",
			sql.raw(`"status" in (${CDR_EXPORT_STATUSES.map((value) => `'${value}'`).join(", ")})`),
		),
		check(
			"cdr_export_job_failure_check",
			sql.raw(
				`"failure_reason" is null or "failure_reason" in (${CDR_EXPORT_FAILURES.map((value) => `'${value}'`).join(", ")})`,
			),
		),
		check("cdr_export_job_range_check", sql`"range_to" > "range_from"`),
		check("cdr_export_job_size_check", sql`"row_count" >= 0 and "size_bytes" >= 0`),

		pgPolicy("cdr_export_job_tenant_isolation", {
			for: "all",
			to: cdrTenantContext.role,
			using: tenantScope,
			withCheck: tenantScope,
		}),
	],
);

export type CdrExportJobRow = typeof cdrExportJob.$inferSelect;
export type NewCdrExportJobRow = typeof cdrExportJob.$inferInsert;
