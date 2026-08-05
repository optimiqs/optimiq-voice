import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	index,
	integer,
	pgPolicy,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	tenantOrganizationScope,
	utcTimestamp,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { cdrTenantContext } from "../cdr-context";
import { RECORDING_KINDS, type RecordingKind } from "./enums";

const tenantScope = tenantOrganizationScope(cdrTenantContext);

/**
 * `recordings` — metadata for every media object in the S3-compatible store.
 *
 * NOT partitioned and NOT append-only: rows are mutated by the retention lifecycle
 * (`deleted_at` after the object is purged) and by ownership fixes, so the tenant role gets the
 * standard single `FOR ALL` policy. Volume is bounded by recorded calls rather than by all
 * calls, which is one to two orders of magnitude smaller than `call_legs`.
 *
 * `object_key` is globally unique: it is the S3 key, so uniqueness is a property of the bucket,
 * not of the tenant. Signed-URL issuing joins on it and MUST still check `organization_id`.
 */
export const recordings = pgTable.withRLS(
	"recordings",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),

		/** Nullable: voicemail greetings and conference recordings have no single leg. */
		callId: uuidEntityId("call_id"),
		legId: uuidEntityId("leg_id"),

		kind: text("kind").$type<RecordingKind>().notNull(),
		/** S3 object key. Unique across the bucket; never reused after a purge. */
		objectKey: text("object_key").notNull(),

		durationMs: integer("duration_ms").notNull().default(0),
		sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),

		/** When the retention policy allows the object to be purged. Null = keep indefinitely. */
		retentionUntil: utcTimestamp("retention_until"),
		/** Set once the object is gone from the store; the row is kept as an audit tombstone. */
		deletedAt: utcTimestamp("deleted_at"),

		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("recordings_object_key_key").on(table.objectKey),
		index("recordings_organization_created_idx").on(
			table.organizationId,
			table.createdAt.desc().nullsLast(),
		),
		index("recordings_call_idx").on(table.callId),
		index("recordings_leg_idx").on(table.legId),
		// Drives the retention sweep: only rows still holding an object matter.
		index("recordings_retention_idx")
			.on(table.retentionUntil)
			.where(sql`deleted_at is null and retention_until is not null`),

		check(
			"recordings_kind_check",
			sql.raw(`"kind" in (${RECORDING_KINDS.map((value) => `'${value}'`).join(", ")})`),
		),
		check("recordings_size_check", sql`"duration_ms" >= 0 and "size_bytes" >= 0`),

		pgPolicy("recordings_tenant_isolation", {
			for: "all",
			to: cdrTenantContext.role,
			using: tenantScope,
			withCheck: tenantScope,
		}),
	],
);

export type RecordingRow = typeof recordings.$inferSelect;
export type NewRecordingRow = typeof recordings.$inferInsert;
