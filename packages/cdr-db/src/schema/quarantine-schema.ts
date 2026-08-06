import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { utcTimestamp, uuidEntityId, uuidV7PrimaryKey } from "@optimiq-voice/db";

/**
 * `cdr_write_quarantine` — the CDR writer's dead-letter record.
 *
 * ## Why a table and not "log it loudly"
 *
 * The CDR is the billing record. A message the writer cannot turn into a row is revenue that did
 * not get invoiced, and the only two honest things to do with it are (a) stop the consumer, which
 * blocks every subsequent leg behind one bad one, or (b) set it aside somewhere an operator can
 * find it and replay it. A log line is neither: it is not queryable, it is not countable, and by
 * the time anyone reads it the JetStream message may have aged out of its 30-day window.
 *
 * A row here is a claim ticket. `stream` + `stream_sequence` is enough to fetch the ORIGINAL bytes
 * back out of JetStream (the `CDR` stream is `retention: limits`, so acking does not delete the
 * message — it is still there for 30 days), and `payload` keeps a copy so the reason is diagnosable
 * after the window closes.
 *
 * ## Why it is NOT tenant-scoped
 *
 * This is an operator surface, not a reporting surface. Half of what lands here has no resolvable
 * organization at all — that is frequently the very reason it landed here — so an
 * `organization_id NOT NULL` column with an RLS policy over it could not hold the rows it exists
 * for. The column is nullable and carries the org when the envelope had a credible one, purely so
 * an operator can group a spike by tenant.
 *
 * It is therefore deliberately absent from `cdrTenantRlsPreflightPlan`: the tenant role has no
 * grants on it, no policies apply, and only the schema owner (which is who the writer runs as)
 * can read or write it. The preflight introspects the plan's tables by name, so an unlisted table
 * is not a preflight failure — see `packages/db/src/rls-preflight.ts`.
 */

/**
 * Why a message was set aside. These are not severities; they are different operator actions.
 *
 * - `unreadable`  — the bytes are not a `cdr.leg.write` envelope. Never becoming one, so it was
 *   terminated on first delivery. Fix the producer, then replay from the sequence.
 * - `foreign-subject` — the envelope's own `subject` disagreed with the one it was delivered on,
 *   which is the only signal that could have scoped a write to the wrong tenant. Terminated
 *   immediately and never inserted; this row is a security event, not a data-loss event.
 * - `rejected` — PostgreSQL refused the row (a check constraint, a value outside a domain). Valid
 *   contract, invalid content: replaying it unchanged will fail again, so it is terminated.
 * - `exhausted` — the write kept failing transiently until the consumer's `max_deliver` ran out.
 *   This is the one that usually means the DATABASE was the problem, and the one worth replaying
 *   unchanged once it is healthy.
 */
export const CDR_QUARANTINE_REASONS = [
	"unreadable",
	"foreign-subject",
	"rejected",
	"exhausted",
] as const;
export type CdrQuarantineReason = (typeof CDR_QUARANTINE_REASONS)[number];

export const cdrWriteQuarantine = pgTable(
	"cdr_write_quarantine",
	{
		id: uuidV7PrimaryKey(),
		/** Null when the message carried no organization we would trust. Never a tenant boundary. */
		organizationId: uuidEntityId("organization_id"),
		/** JetStream stream name, e.g. `CDR` or `CALLS`. */
		stream: text("stream").notNull(),
		subject: text("subject").notNull(),
		/** The message's stream sequence — the address a replay reads from. Null if unknown. */
		streamSequence: bigint("stream_sequence", { mode: "number" }),
		/** How many deliveries it had taken when it was set aside. 1 for an immediate terminate. */
		deliveryCount: integer("delivery_count").notNull().default(1),
		reason: text("reason").$type<CdrQuarantineReason>().notNull(),
		/** The failure, in one line. Whatever an operator needs to decide what to do. */
		detail: text("detail").notNull(),
		/** The message body as delivered, so the diagnosis survives the stream's retention window. */
		payload: jsonb("payload")
			.notNull()
			.default(sql`'{}'::jsonb`),
		quarantinedAt: utcTimestamp("quarantined_at").notNull().defaultNow(),
	},
	(table) => [
		index("cdr_write_quarantine_at_idx").on(table.quarantinedAt.desc().nullsLast()),
		index("cdr_write_quarantine_organization_idx").on(table.organizationId),
		check(
			"cdr_write_quarantine_reason_check",
			sql.raw(`"reason" in (${CDR_QUARANTINE_REASONS.map((value) => `'${value}'`).join(", ")})`),
		),
		check("cdr_write_quarantine_delivery_check", sql`"delivery_count" >= 1`),
	],
);

export type CdrWriteQuarantineRow = typeof cdrWriteQuarantine.$inferSelect;
export type NewCdrWriteQuarantineRow = typeof cdrWriteQuarantine.$inferInsert;
