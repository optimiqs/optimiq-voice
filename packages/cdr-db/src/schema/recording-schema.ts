import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	index,
	integer,
	jsonb,
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
 * The consent record one recording carries, mirroring `RecordingConsentRecord` in
 * `packages/routing/src/recording-consent.ts`.
 *
 * Mirrored rather than imported because this package cannot depend on routing, and structural
 * rather than nominal on purpose: the column is `jsonb`, so what actually crosses the boundary is a
 * shape, and a shape is what this interface has to describe. The string unions are deliberately
 * WIDE where the payload is — `outcome` and `method` are literal unions because a value outside them
 * is a bug in the writer, whereas `regions` is plain `string[]` because a jurisdiction this platform
 * has not heard of must still land on the row.
 */
export interface RecordingConsentRow {
	readonly outcome: "not-required" | "announced" | "accepted" | "declined";
	readonly method: "none" | "announcement" | "keypress";
	readonly policy: "none" | "announce" | "announce-and-require-keypress";
	/** ISO 8601, stamped when the outcome was decided — not when the row was written. */
	readonly at: string;
	/** Which parties heard the announcement. */
	readonly parties: readonly ("caller" | "callee")[];
	readonly regions?: readonly string[];
	readonly promptId?: string;
}

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

		/**
		 * Every stretch a PCI pause silenced, `[startMs, endMs)` against this object's timeline.
		 *
		 * A pause keeps the recording ONE object with quiet in the middle of it, which is the whole
		 * point — a stop and a restart would split the artifact at exactly the moment a reviewer is
		 * looking at. Nothing in the audio distinguishes a deliberate gap from a caller thinking, so
		 * this column is the only record that says which, and it is what a compliance reviewer reads.
		 *
		 * `jsonb` and not a second table: the intervals are read only with the row that owns them,
		 * there are a handful per recording, and nothing joins or filters on them. Null on every row
		 * written before pausing existed, and on every recording nobody paused — the two mean the
		 * same thing to a reader and neither is worth distinguishing.
		 */
		pauses: jsonb("pauses").$type<{ startMs: number; endMs: number }[]>(),

		/**
		 * What consent this object was made under: the outcome, how it was reached, the policy that
		 * asked for it, when it was decided, which parties heard the announcement, and the
		 * jurisdictions that forced all-party treatment.
		 *
		 * This is the artifact's own defence. A recording is evidence of a conversation, and the
		 * first question anyone asks about evidence obtained by recording is whether it was obtained
		 * lawfully — a question the audio cannot answer and a configuration table cannot either,
		 * because configuration is what the tenant believes TODAY and this row is about a call that
		 * happened months ago under settings since changed. So the answer is stamped onto the row at
		 * the moment the tap opened and is never recomputed.
		 *
		 * `jsonb` and not six columns, for the same reason `pauses` above is one column: it is read
		 * whole with the row that owns it, nothing joins or filters on its parts, and splitting it
		 * would spend six migrations to express one decision. Null on every row written before this
		 * existed, and on every recording no consent was required for — the two mean the same thing
		 * to a reader, which is that nobody was asked and nobody had to be.
		 */
		consent: jsonb("consent").$type<RecordingConsentRow>(),

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
