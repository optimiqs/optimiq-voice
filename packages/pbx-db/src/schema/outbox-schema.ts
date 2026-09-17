import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { tenantOrganizationIdColumn, utcTimestamp, uuidV7PrimaryKey } from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";

/**
 * The projection outbox: the durable record that a committed write still owes a KV publish.
 *
 * ## The window it closes
 *
 * Every KV projection in `apps/api` — the `routing-cache` artifact, the `did-index` entries, the
 * `queue-membership` rosters — is published AFTER its write transaction commits, and that ordering
 * is not negotiable: publishing from inside the transaction would put a routing artifact, a DID
 * owner or a queue roster for a state that might roll back in front of live calls. The three
 * publishers each record the cost of that choice in their headers, in the same words: if the
 * process dies between the commit and the publish, the row is in PostgreSQL and the projection is
 * not, and it stays that way until the next write for that organization or a manual run of a
 * `rebuild:*` script. Two of them add that closing it "needs an outbox, not a retry loop", because
 * a retry loop lives in the same process that just died.
 *
 * This table is that outbox. One row is inserted **inside** the mutation's transaction, so it
 * commits or rolls back with the write it describes — there is no ordering in which the data
 * exists and the obligation does not. A sweeper in `apps/api` then picks up whatever the
 * fast-path publish failed to mark.
 *
 * ## Why the payload does not carry the artifact
 *
 * The obvious outbox stores the message to send. This one stores only *which* projection is owed
 * and *for whom*, and the sweeper re-derives the value from the database at publish time. That is
 * deliberate: by the time a sweeper runs, the row that produced the obligation may have been
 * superseded several times over, and replaying a stored artifact would push a state that is
 * provably older than the database back into a bucket the engine resolves live calls against —
 * turning a stale cache into a wrong one. Re-deriving can only ever publish the present.
 *
 * It is also the difference between a row of a few hundred bytes and a row carrying a compiled
 * routing artifact for a tenant with a thousand extensions.
 *
 * `payload` therefore holds diagnostics — the table and operation that created the obligation —
 * so a stuck row can be traced back to the request that made it. Nothing reads it to publish.
 *
 * ## Who reads it
 *
 * The tenant role inserts (and, on the fast path, marks published) under RLS like every other
 * table here. The sweeper reads across ALL organizations and therefore runs on the untenanted
 * handle: it is a platform process with no session organization to scope to, and "find every
 * tenant that is owed a publish" is not a question a tenant-scoped transaction can ask.
 */

/**
 * The KV projections a committed write can owe.
 *
 * Plain `text` in the column below rather than a PostgreSQL enum, which is what makes adding a name
 * here a code change and not a migration — deliberate, because the set grows whenever a new derived
 * read model lands and an `ALTER TYPE` in the middle of a deploy is a worse failure than an unknown
 * string in a diagnostics column.
 *
 * `trunks` and `sip-acl` joined when the SIP edge got its own read models. Both are durable for the
 * same reason the first three are and one that is sharper: their buckets have a zero TTL, so a lost
 * publish never self-corrects — a stale `trunks` entry is an outbound outage for a tenant, and a
 * stale `sip-acl` entry is either a carrier silently blocked or a network still admitted by a rule
 * that was deleted.
 */
export const PROJECTION_NAMES = [
	"routing-cache",
	"did-index",
	"queue-membership",
	"trunks",
	"sip-acl",
] as const;
export type ProjectionName = (typeof PROJECTION_NAMES)[number];

export const projectionOutbox = pgTable.withRLS(
	"pbx_projection_outbox",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/** Which bucket is owed. One row per projection, so a partial failure retries only its half. */
		projection: text("projection").$type<ProjectionName>().notNull(),
		/**
		 * Diagnostics only — `{ tableName, kind, operation }`. Never an input to the publish; see the
		 * header for why the sweeper re-derives instead of replaying.
		 */
		payload: jsonb("payload").$type<ProjectionOutboxPayload>(),
		/**
		 * NULL means still owed. Set by the fast path immediately after its publish succeeds, and by
		 * the sweeper otherwise. This is the only column the fast path writes after the commit, which
		 * is what makes the sweeper's queue exactly "the publishes that did not happen".
		 */
		publishedAt: utcTimestamp("published_at"),
		/** Sweep attempts, for the exponential backoff and for the stuck-row threshold. */
		attempts: integer("attempts").notNull().default(0),
		lastAttemptAt: utcTimestamp("last_attempt_at"),
		/** The last failure's message, so a stuck row explains itself without a log search. */
		lastError: text("last_error"),
		createdAt: utcTimestamp("created_at").notNull().defaultNow(),
	},
	(table) => [
		// The sweeper's only query shape: pending rows, oldest first. A partial index keeps it the
		// size of the backlog rather than the size of the history — on a healthy system the fast path
		// marks every row within milliseconds, so "pending" is almost always empty and this index is
		// almost always a single page.
		index("pbx_projection_outbox_pending_idx")
			.on(table.createdAt)
			.where(sql`${table.publishedAt} is null`),
		// Retention sweeps delete published rows by age.
		index("pbx_projection_outbox_published_idx").on(table.publishedAt),
		tenantIsolationPolicy("pbx_projection_outbox"),
	],
);

/** What `payload` holds. Diagnostics for a stuck row; never read to perform a publish. */
export interface ProjectionOutboxPayload {
	/** Physical table the mutation touched, e.g. `queue_tier`. */
	readonly tableName: string;
	/** Resource kind as the API names it, e.g. `queue-tier`. */
	readonly kind: string;
	readonly operation: "create" | "update" | "remove" | "reorder";
}

export type ProjectionOutboxRow = typeof projectionOutbox.$inferSelect;
