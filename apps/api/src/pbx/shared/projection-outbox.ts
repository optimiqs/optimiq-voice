import { createEntityId } from "@optimiq-voice/identifiers";
import {
	and,
	asc,
	eq,
	inArray,
	isNull,
	lte,
	type PbxDatabase,
	type PbxDatabaseTransaction,
	projectionOutbox,
	type ProjectionName,
	type ProjectionOutboxPayload,
	type ProjectionOutboxRow,
	sql,
} from "@optimiq-voice/pbx-db";
import type { PbxMutationEvent } from "./pbx.repository";

/**
 * The projection outbox, from `apps/api`'s side.
 *
 * `packages/pbx-db`'s `outbox-schema.ts` argues for the table; this file is the two halves that
 * use it, and the ORDERING between them is the whole design:
 *
 * ```
 * begin
 *   … the write, the guards, compile-on-write …
 *   INSERT one pbx_projection_outbox row per projection this write owes      ← enqueue()
 * commit
 * ── after commit, in-process (the FAST PATH) ────────────────────────────────────────
 * cutoff := now()                                     ← captured BEFORE the publish
 * publish to the KV bucket (unchanged from before the outbox existed)
 * on success: UPDATE … SET published_at = now()
 *             WHERE organization_id = $org AND projection = $p
 *               AND published_at IS NULL AND created_at <= $cutoff   ← dischargeProjection()
 * ── later, out of process (the SWEEPER) ─────────────────────────────────────────────
 * read the pending rows, publish, mark exactly those ids               ← dischargeRows()
 * ```
 *
 * ## One obligation is discharged by any later publish of the same projection
 *
 * All five publishes are **whole-organization reconciles**: `RoutingCachePublisher.publish` writes
 * the organization's entire compiled artifact, `DidIndexPublisher.syncOrganization` reconciles
 * every DID it owns, `QueueMembershipPublisher.syncOrganization` re-projects every queue,
 * `TrunkDirectoryPublisher.syncOrganization` re-projects every trunk and
 * `SipAclPublisher.syncOrganization` re-projects every ACL entry. A
 * successful publish therefore discharges not one obligation but every outstanding obligation for
 * that organization and projection, because the state it just pushed is at least as new as all of
 * them. Ten edits in a burst become one publish and ten marks, which is what a bulk import needs.
 *
 * The two callers express that differently, and the difference is load-bearing:
 *
 * **The fast path marks by `created_at <= cutoff`**, where `cutoff` is a `new Date()` taken in this
 * process before the publish starts reading. It never saw the rows — it is a continuation of a
 * request, not a query — so a range is all it has. Taking the cutoff *first* is what makes the
 * error one-directional: a row inserted by a concurrent write DURING the publish is newer than the
 * cutoff and stays pending, so the fast path can under-mark (the sweeper does a redundant publish,
 * which is idempotent) and can never over-mark (an obligation silently dropped, which is the bug
 * the table exists to prevent).
 *
 * **The sweeper marks by row id**, because it read the rows and because a range would be wrong
 * there: PostgreSQL stores `timestamptz` to the microsecond and a JavaScript `Date` holds
 * milliseconds, so a `max(created_at)` round-tripped through JS is rounded DOWN, no longer matches
 * the row it came from, marks nothing, and leaves the sweeper republishing the same rows on every
 * tick forever. See {@link PendingProjection.ids}.
 *
 * ## Why there is no obligation when nothing changed
 *
 * `enqueue` uses the SAME predicate the fast path uses to decide whether to publish at all —
 * `compiled.changed` for the artifact and the DID index, `affectsQueueMembership(tableName)` for
 * the roster. If the two disagreed, the sweeper would spend forever publishing states the fast
 * path had correctly decided were already in the bucket. The predicate lives here, in a file with
 * no NATS import, so the repository can call it and the module can too.
 */

/** The KV projections, re-exported so a caller does not import the schema package for a string. */
export { PROJECTION_NAMES, type ProjectionName } from "@optimiq-voice/pbx-db";

/**
 * The tables whose mutation changes a queue roster.
 *
 * Moved here from `queue-membership.publisher.ts` (which re-exports it, so its callers are
 * unchanged) because the repository has to consult it INSIDE the write transaction to decide what
 * to enqueue, and the publisher imports `nats` — which would drag a broker client into every
 * repository spec.
 *
 * `extension` is the one that is easy to miss: an `extension` agent's dial string is derived from
 * `extension.number`, so renumbering an extension moves every queue that agent serves. Leaving it
 * out would publish rosters that dial the old number until something else happened to touch the
 * queue.
 */
export const QUEUE_MEMBERSHIP_TABLES: readonly string[] = [
	"queue",
	"queue_agent",
	"queue_tier",
	"extension",
];

export function affectsQueueMembership(tableName: string): boolean {
	return QUEUE_MEMBERSHIP_TABLES.includes(tableName);
}

/**
 * The tables whose mutation changes the carrier directory the SIP edge dials.
 *
 * One table, and the list exists anyway rather than an inline string comparison, for two reasons.
 * It keeps the shape identical to the roster's above, so the three predicates in this file read as
 * one mechanism; and `trunk` is the table most likely to grow a child (a per-trunk ACL row is
 * already named as a follow-up in `plans/sipd-invite-design.md` §8.2), at which point the addition
 * is one string here and nothing else.
 *
 * `outbound_route` is deliberately NOT here even though it names trunks: it holds an ordered
 * failover list in `trunk_priority`, which is a ROUTING fact the compiled artifact already carries.
 * Nothing about which trunks a route prefers changes how any of them is dialled.
 */
export const TRUNK_DIRECTORY_TABLES: readonly string[] = ["trunk"];

export function affectsTrunkDirectory(tableName: string): boolean {
	return TRUNK_DIRECTORY_TABLES.includes(tableName);
}

/**
 * The tables whose mutation changes the SIP edge's admission list.
 *
 * `sip_acl_entry` is absent from `packages/routing`'s `ROUTING_TABLE_TO_ENTITY`, so
 * `affectsRouting("sip_acl_entry")` is false and `onArtifactCompiled` never fires for it —
 * `security/sip-acl.resource.ts` states that and its consequence in full. This predicate on the
 * `onMutation` seam is therefore not a shortcut past the artifact; it is the ONLY hook the table has.
 */
export const SIP_ACL_TABLES: readonly string[] = ["sip_acl_entry"];

export function affectsSipAcl(tableName: string): boolean {
	return SIP_ACL_TABLES.includes(tableName);
}

/**
 * Which projections a committed write owes.
 *
 * `artifactChanged` is `CompiledWrite.changed` — false when the recompile produced the same
 * `snapshotHash`, which means the bucket already holds the right value and there is nothing owed.
 * The DID index rides on the same evidence for the reason `pbx.module.ts` records: the set of
 * phone numbers is part of the hashed snapshot, so an unchanged hash means an unchanged index.
 *
 * `trunks` and `sip-acl` ride on the TABLE and not on the artifact, and a write to `trunk` can
 * therefore owe three projections at once. That is not double counting: `affectsRouting("trunk")` is
 * true because an outbound route's failover list names trunks, while the directory carries the
 * carrier's dialable address — two different facts derived from one row, published to two buckets
 * with two different readers. Owing both is what stops a renamed proxy from waiting for a recompile
 * that happened not to change the snapshot hash.
 */
export function projectionsOwedBy(
	tableName: string,
	artifactChanged: boolean,
): readonly ProjectionName[] {
	const owed: ProjectionName[] = [];
	if (artifactChanged) {
		owed.push("routing-cache", "did-index");
	}
	if (affectsQueueMembership(tableName)) {
		owed.push("queue-membership");
	}
	if (affectsTrunkDirectory(tableName)) {
		owed.push("trunks");
	}
	if (affectsSipAcl(tableName)) {
		owed.push("sip-acl");
	}
	return owed;
}

/**
 * Writes the obligations, on the mutation's own transaction.
 *
 * Called from inside the repository's `scoped(...)` body, so it commits or rolls back with the
 * write. A failure here fails the write, which is correct and is the point: a mutation that cannot
 * record what it owes is a mutation whose projection can be lost, and the caller would rather be
 * told to retry than be told it succeeded.
 */
export async function enqueueProjections(
	transaction: PbxDatabaseTransaction,
	organizationId: string,
	projections: readonly ProjectionName[],
	payload: ProjectionOutboxPayload,
	newId: () => string = createEntityId,
): Promise<void> {
	if (projections.length === 0) {
		return;
	}
	await transaction.insert(projectionOutbox).values(
		projections.map((projection) => ({
			id: newId(),
			organizationId,
			projection,
			payload,
		})),
	);
}

/** The payload a mutation event carries into the outbox row. Diagnostics only. */
export function payloadOf(event: PbxMutationEvent): ProjectionOutboxPayload {
	return { tableName: event.tableName, kind: event.kind, operation: event.operation };
}

/**
 * Marks every obligation this organization owed for this projection at or before `cutoff`.
 *
 * Runs on the UNTENANTED handle. That is not a shortcut around RLS — the tenant role holds UPDATE
 * on the table and the policy would permit exactly these rows — it is because the caller is a
 * fire-and-forget continuation of a request whose transaction is already gone, and opening a
 * second tenant transaction to set one timestamp would double the connection cost of every write
 * for no isolation the single statement does not already have.
 *
 * Returns how many rows it discharged, so the fast path can be asserted without reading the table.
 */
export async function dischargeProjection(
	database: PbxDatabase,
	organizationId: string,
	projection: ProjectionName,
	cutoff: Date,
): Promise<number> {
	const marked = await database
		.update(projectionOutbox)
		.set({ publishedAt: new Date() })
		.where(pendingBefore(organizationId, projection, cutoff))
		.returning({ id: projectionOutbox.id });
	return marked.length;
}

/** `published_at is null and organization_id = … and projection = … and created_at <= cutoff`. */
function pendingBefore(organizationId: string, projection: ProjectionName, cutoff: Date) {
	return and(
		eq(projectionOutbox.organizationId, organizationId),
		eq(projectionOutbox.projection, projection),
		isNull(projectionOutbox.publishedAt),
		lte(projectionOutbox.createdAt, cutoff),
	);
}

/** One organization's outstanding obligation for one projection, as the sweeper sees it. */
export interface PendingProjection {
	readonly organizationId: string;
	readonly projection: ProjectionName;
	/**
	 * The exact rows in the group. A burst of edits coalesces into one publish and these ids are
	 * what it discharges.
	 *
	 * Ids rather than the `created_at <= cutoff` predicate the fast path uses, and the difference is
	 * not stylistic. PostgreSQL stores `timestamptz` to the MICROSECOND and a JavaScript `Date` holds
	 * MILLISECONDS, so a `max(created_at)` read into a `Date` is rounded DOWN and no longer matches
	 * the row it came from — the update marks nothing and the sweeper republishes the same rows
	 * forever. The fast path is not exposed to that because its cutoff is a `new Date()` taken in
	 * this process AFTER the commit, so it is later than any row it is meant to cover and truncation
	 * can only make it very slightly later still.
	 *
	 * The sweeper has read these exact rows, so naming them is also simply more honest than a range.
	 */
	readonly ids: readonly string[];
	/** The highest `attempts` in the group, for backoff and for the stuck threshold. */
	readonly attempts: number;
	readonly oldestCreatedAt: Date;
	readonly lastAttemptAt: Date | null;
	readonly lastError: string | null;
}

/**
 * Every pending obligation, grouped by organization and projection, oldest first.
 *
 * Read on the untenanted handle because "which tenants are owed a publish?" is not a question a
 * tenant-scoped transaction can ask — it sets one organization id, which is exactly what this has
 * to see past. `scripts/rebuild-queue-membership.ts` reaches for `adminDb` for the same query and
 * records the same reason.
 *
 * Grouping in SQL rather than in TypeScript so a backlog of ten thousand rows is one row per
 * (tenant, projection) over the wire, not ten thousand.
 */
export async function readPendingProjections(
	database: PbxDatabase,
	limit: number,
): Promise<readonly PendingProjection[]> {
	const result = await database
		.select({
			organizationId: projectionOutbox.organizationId,
			projection: projectionOutbox.projection,
			ids: sql<string[]>`array_agg(${projectionOutbox.id}::text)`,
			oldestCreatedAt: sql<Date>`min(${projectionOutbox.createdAt})`,
			attempts: sql<number>`max(${projectionOutbox.attempts})`.mapWith(Number),
			lastAttemptAt: sql<Date | null>`max(${projectionOutbox.lastAttemptAt})`,
			lastError: sql<string | null>`max(${projectionOutbox.lastError})`,
		})
		.from(projectionOutbox)
		.where(isNull(projectionOutbox.publishedAt))
		.groupBy(projectionOutbox.organizationId, projectionOutbox.projection)
		.orderBy(asc(sql`min(${projectionOutbox.createdAt})`))
		.limit(limit);

	return result.map((row) => ({
		organizationId: row.organizationId,
		projection: row.projection,
		ids: row.ids,
		oldestCreatedAt: asDate(row.oldestCreatedAt),
		attempts: row.attempts,
		lastAttemptAt: row.lastAttemptAt === null ? null : asDate(row.lastAttemptAt),
		lastError: row.lastError,
	}));
}

/** Marks the exact rows a sweep published. See {@link PendingProjection.ids} for why by id. */
export async function dischargeRows(
	database: PbxDatabase,
	ids: readonly string[],
): Promise<number> {
	if (ids.length === 0) {
		return 0;
	}
	const marked = await database
		.update(projectionOutbox)
		.set({ publishedAt: new Date() })
		.where(and(inArray(projectionOutbox.id, [...ids]), isNull(projectionOutbox.publishedAt)))
		.returning({ id: projectionOutbox.id });
	return marked.length;
}

/**
 * Records a failed sweep attempt: `attempts + 1`, the timestamp, the message.
 *
 * Every row in the group is bumped, not just one, because the backoff is a property of the group —
 * the next sweep reads `max(attempts)` and would otherwise retry immediately on the strength of a
 * row that has never been tried.
 */
export async function recordAttempt(
	database: PbxDatabase,
	ids: readonly string[],
	error: string,
): Promise<void> {
	if (ids.length === 0) {
		return;
	}
	await database
		.update(projectionOutbox)
		.set({
			attempts: sql`${projectionOutbox.attempts} + 1`,
			lastAttemptAt: new Date(),
			// Truncated: a stack trace in a column that exists to explain a stuck row is a column that
			// nobody reads and a row that no longer fits on a page.
			lastError: error.slice(0, 500),
		})
		.where(and(inArray(projectionOutbox.id, [...ids]), isNull(projectionOutbox.publishedAt)));
}

/**
 * Deletes published rows older than `olderThan`.
 *
 * Retention rather than "delete on publish", so an operator investigating a lost projection can
 * still see that the obligation existed and when it was discharged. Pending rows are never pruned:
 * an obligation nothing has managed to publish is exactly the row worth keeping.
 */
export async function pruneDischarged(database: PbxDatabase, olderThan: Date): Promise<number> {
	const deleted = await database
		.delete(projectionOutbox)
		.where(
			and(
				sql`${projectionOutbox.publishedAt} is not null`,
				lte(projectionOutbox.publishedAt, olderThan),
			),
		)
		.returning({ id: projectionOutbox.id });
	return deleted.length;
}

/**
 * The delay before a group with `attempts` failures may be tried again.
 *
 * Exponential from the sweep interval, capped, because the two failures this exists for have
 * different shapes: a broker that is restarting is back in seconds, and a broker that is gone is
 * gone for hours. Backing off to the cap means a dead broker costs one connection attempt a minute
 * instead of one every sweep, and a restarting one is still picked up on the next tick.
 */
export function backoffMs(attempts: number, baseMs: number, capMs: number): number {
	if (attempts <= 0) {
		return 0;
	}
	return Math.min(baseMs * 2 ** (attempts - 1), capMs);
}

/** Whether a group is due, given when it was last tried. */
export function isDue(
	group: Pick<PendingProjection, "attempts" | "lastAttemptAt">,
	now: Date,
	baseMs: number,
	capMs: number,
): boolean {
	if (group.lastAttemptAt === null) {
		return true;
	}
	return now.getTime() - group.lastAttemptAt.getTime() >= backoffMs(group.attempts, baseMs, capMs);
}

/** Postgres hands timestamps back as `Date`; a driver that hands back a string is normalised here. */
function asDate(value: Date | string): Date {
	return value instanceof Date ? value : new Date(value);
}

export type { ProjectionOutboxPayload, ProjectionOutboxRow };
