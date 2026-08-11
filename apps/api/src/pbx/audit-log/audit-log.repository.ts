import { and, auditLog, desc, eq, gte, lte, sql } from "@optimiq-voice/pbx-db";
import { decodeAuditLogCursor } from "./audit-log.cursor";
import type { AuditLogQuery, ResolvedAuditRange } from "./audit-log.dto";
import type { PbxDatabaseTransaction, SQL } from "@optimiq-voice/pbx-db";

/**
 * The ledger's read query, as Drizzle over an already-tenant-scoped transaction.
 *
 * ## The organization is not a parameter of anything in this file
 *
 * That is the point, and it is the same contract `cdr.repository.ts` states: the caller opens
 * `withTenantScope(organizationId, …)`, which drops into `pbx_tenant_tls` and publishes the id
 * the RLS policies read, and everything below runs inside it. `audit_log_tenant_select` is then
 * the filter — in the DATABASE, under a role with no privilege to see past it — rather than a
 * `where` clause somebody could forget to write. A repository that took an `organizationId` and
 * put it in a predicate would be a repository someone can call without one; a repository that can
 * only be handed an already-scoped transaction cannot.
 *
 * So every predicate below is about the QUESTION, never about the tenant, and no value that
 * reaches this file comes from anywhere but the parsed query DTO.
 *
 * ## Every predicate carries the window
 *
 * The `occurred_at` bounds are unconditional, and they lead the index
 * (`audit_log_organization_occurred_idx` is `(organization_id, occurred_at, id)`). They are why
 * there is no "search all history" shape reachable from the HTTP surface at all — see
 * `audit-log.dto.ts` for why the window defaults rather than being demanded.
 */

/**
 * What a ledger row looks like on the wire.
 *
 * Every column, deliberately: `before`/`after` are already the redacted, changed-columns-only diff
 * the writer produced (`shared/audit-log.ts` — a `secretColumns` value never entered the table),
 * and `ip_address` / `user_agent` are the two fields that make an entry evidence rather than
 * trivia. Withholding them from a caller who already holds `audit.read` would be a redaction that
 * protects nothing and breaks the one screen this endpoint exists for.
 *
 * `organizationId` rides along for the same reason every other PBX row carries it: it is the
 * caller's own tenant by construction, and the web contract's row shape expects it.
 */
const AUDIT_LIST_COLUMNS = {
	id: auditLog.id,
	organizationId: auditLog.organizationId,
	actorType: auditLog.actorType,
	actorUserId: auditLog.actorUserId,
	actorRef: auditLog.actorRef,
	action: auditLog.action,
	resourceType: auditLog.resourceType,
	resourceRef: auditLog.resourceRef,
	before: auditLog.before,
	after: auditLog.after,
	ipAddress: auditLog.ipAddress,
	userAgent: auditLog.userAgent,
	requestId: auditLog.requestId,
	occurredAt: auditLog.occurredAt,
	createdAt: auditLog.createdAt,
} as const;

/**
 * A column's TypeScript type, nullability included.
 *
 * `column["_"]["data"]` alone is the type of a value that is PRESENT, so a projection derived from
 * it types `actor_ref` as `string` when the column is nullable and the ledger relies on it being
 * null (a person has no `actor_ref`; an API key has no `actor_user_id`). Reading `notNull` off the
 * same descriptor is what keeps the row type honest, and therefore what keeps the web contract
 * that mirrors it honest.
 */
type ColumnValue<TColumn> = TColumn extends {
	readonly _: { readonly data: infer TData; readonly notNull: infer TNotNull };
}
	? TNotNull extends true
		? TData
		: TData | null
	: never;

export type AuditLogRow = {
	[K in keyof typeof AUDIT_LIST_COLUMNS]: ColumnValue<(typeof AUDIT_LIST_COLUMNS)[K]>;
};

/**
 * The keyset comparison for `(occurred_at, id) DESC`, written as a row comparison.
 *
 * `(a, b) < (x, y)` rather than `a < x or (a = x and b < y)` because the row form is what
 * PostgreSQL turns into a single seek on the three-column btree; the expanded boolean form
 * usually degrades into a filter over the whole window. They mean the same thing and cost very
 * differently.
 */
function keysetBefore(occurredAt: Date, id: string): SQL {
	return sql`(${auditLog.occurredAt}, ${auditLog.id}) < (${occurredAt.toISOString()}::timestamptz, ${id}::uuid)`;
}

/**
 * Every predicate the query carries, window first.
 *
 * Exported so a spec can assert which filters a query combination produces without asserting on
 * Drizzle's internals, and so the list stays readable as it grows.
 */
export function auditLogFilters(query: AuditLogQuery, range: ResolvedAuditRange): SQL[] {
	const filters: SQL[] = [
		gte(auditLog.occurredAt, range.from),
		lte(auditLog.occurredAt, range.to),
	] as SQL[];

	if (query.actorType !== undefined) {
		filters.push(eq(auditLog.actorType, query.actorType) as SQL);
	}
	if (query.actorUserId !== undefined) {
		filters.push(eq(auditLog.actorUserId, query.actorUserId) as SQL);
	}
	if (query.actorRef !== undefined) {
		filters.push(eq(auditLog.actorRef, query.actorRef) as SQL);
	}
	if (query.action !== undefined) {
		filters.push(eq(auditLog.action, query.action) as SQL);
	}
	if (query.resourceType !== undefined) {
		filters.push(eq(auditLog.resourceType, query.resourceType) as SQL);
	}
	if (query.resourceRef !== undefined) {
		filters.push(eq(auditLog.resourceRef, query.resourceRef) as SQL);
	}
	if (query.cursor !== undefined) {
		const cursor = decodeAuditLogCursor(query.cursor);
		filters.push(keysetBefore(cursor.occurredAt, cursor.id));
	}
	return filters;
}

/**
 * The listing as a query builder, unexecuted.
 *
 * Split from {@link listAuditLog} so a spec can render it with `.toSQL()` and prove what the
 * predicates actually are — including that there is no `organization_id` among them.
 */
export function auditLogListQuery(
	transaction: PbxDatabaseTransaction,
	query: AuditLogQuery,
	range: ResolvedAuditRange,
) {
	return transaction
		.select(AUDIT_LIST_COLUMNS)
		.from(auditLog)
		.where(and(...auditLogFilters(query, range)))
		.orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
		.limit(query.limit + 1);
}

export interface AuditLogPage {
	readonly rows: readonly AuditLogRow[];
	/** How many rows came back, INCLUDING the sentinel; the caller uses it to decide "is there more". */
	readonly fetched: number;
}

/**
 * One page of ledger entries, newest first.
 *
 * Fetches `limit + 1` rows and hands both the trimmed page and the raw count back, so "is there a
 * next page" is answered by evidence rather than by `rows.length === limit`, which cannot tell a
 * full last page from a page with more behind it.
 *
 * There is deliberately no `total`. A `count(*)` over the window is the exact cost the cursor
 * exists to avoid, and it would be paid on every page; the UI says "1–25, more" rather than
 * "1–25 of 41,882", which is the honest answer a keyset listing can give.
 */
export async function listAuditLog(
	transaction: PbxDatabaseTransaction,
	query: AuditLogQuery,
	range: ResolvedAuditRange,
): Promise<AuditLogPage> {
	const rows = (await auditLogListQuery(transaction, query, range)) as AuditLogRow[];
	return { rows: rows.slice(0, query.limit), fetched: rows.length };
}
