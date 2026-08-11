import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { and, desc, eq, gte, lte, sipAuthEvent, sql } from "@optimiq-voice/pbx-db";
import {
	AuditLogCursorError,
	decodeAuditLogCursor,
	nextAuditLogCursor,
} from "../audit-log/audit-log.cursor";
import { AuditInvalidCursorException } from "../audit-log/audit-log.errors";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import { DEFAULT_EVENT_RANGE_DAYS } from "./sip-auth-event.dto";
import type { SipAuthEventQuery } from "./sip-auth-event.dto";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient, PbxDatabaseTransaction, SQL } from "@optimiq-voice/pbx-db";

/**
 * The attack log's read surface.
 *
 * ## Why this reuses the change ledger's cursor and not a copy of it
 *
 * `audit-log.cursor.ts` states, at length, why it is a COPY of `cdr-cursor.ts` rather than an
 * import: those two live in different bounded contexts over different databases, and
 * `apps/api/src/pbx` depending on `apps/api/src/cdr` would establish exactly the direction the
 * contexts exist to prevent.
 *
 * Neither clause applies within the PBX area. This is the same database, the same table shape
 * (`(occurred_at, id)`, UUID v7, append-only) and the same three-column index; a second encoder
 * would be sixty duplicated lines whose only distinguishing feature would be the bug one of them
 * eventually grows. So the cursor, its error and its `nextCursor` helper are imported, and the
 * naming keeps saying `AuditLog` because renaming them would be a diff across the ledger slice for
 * no behavioural change.
 *
 * ## No `total`, and no `search`
 *
 * For the reasons `audit-log.repository.ts` gives, which apply with more force here: a `count(*)`
 * over a window that is being appended to at attack rate is the most expensive query the table can
 * be asked, and it would be paid on every page.
 */
export interface SipAuthEventListEnvelope {
	readonly data: readonly SipAuthEventRow[];
	readonly nextCursor: string | null;
	readonly limit: number;
	readonly range: { readonly from: string; readonly to: string };
}

const EVENT_LIST_COLUMNS = {
	id: sipAuthEvent.id,
	organizationId: sipAuthEvent.organizationId,
	eventType: sipAuthEvent.eventType,
	scope: sipAuthEvent.scope,
	sourceIp: sipAuthEvent.sourceIp,
	accountRef: sipAuthEvent.accountRef,
	transport: sipAuthEvent.transport,
	userAgent: sipAuthEvent.userAgent,
	detail: sipAuthEvent.detail,
	requestId: sipAuthEvent.requestId,
	occurredAt: sipAuthEvent.occurredAt,
	createdAt: sipAuthEvent.createdAt,
} as const;

export interface SipAuthEventRow {
	readonly id: string;
	readonly organizationId: string;
	readonly eventType: string;
	readonly scope: string;
	readonly sourceIp: string | null;
	readonly accountRef: string | null;
	readonly transport: string | null;
	readonly userAgent: string | null;
	readonly detail: unknown;
	readonly requestId: string | null;
	readonly occurredAt: Date;
	readonly createdAt: Date;
}

export interface ResolvedEventRange {
	readonly from: Date;
	readonly to: Date;
}

/**
 * The optional `from`/`to` pair as a concrete window.
 *
 * Total, and therefore testable without a Nest context — the same division `resolveAuditRange`
 * makes. An inverted range is swapped rather than refused: it is always two date controls wired in
 * the wrong order, and the intent is unambiguous.
 */
export function resolveEventRange(
	query: { readonly from?: string; readonly to?: string },
	now: Date = new Date(),
): ResolvedEventRange {
	const to = query.to === undefined ? now : new Date(query.to);
	const from =
		query.from === undefined
			? new Date(to.getTime() - DEFAULT_EVENT_RANGE_DAYS * 24 * 60 * 60 * 1000)
			: new Date(query.from);
	return from.getTime() <= to.getTime() ? { from, to } : { from: to, to: from };
}

/**
 * Every predicate the query carries, window first — and never the organization.
 *
 * Same contract as `auditLogFilters`: the caller has already opened `withTenantScope`, so
 * `sip_auth_event_tenant_select` is the tenant filter, in the database, under a role with no
 * privilege to see past it. Exported so a spec can assert which filters a combination produces
 * without asserting on Drizzle's internals.
 */
export function sipAuthEventFilters(query: SipAuthEventQuery, range: ResolvedEventRange): SQL[] {
	const filters: SQL[] = [
		gte(sipAuthEvent.occurredAt, range.from),
		lte(sipAuthEvent.occurredAt, range.to),
	] as SQL[];

	if (query.eventType !== undefined) {
		filters.push(eq(sipAuthEvent.eventType, query.eventType) as SQL);
	}
	if (query.scope !== undefined) {
		filters.push(eq(sipAuthEvent.scope, query.scope) as SQL);
	}
	if (query.sourceIp !== undefined) {
		// An explicit `::inet` cast on the parameter: the column is `inet` and the bind would
		// otherwise arrive as text, which Postgres resolves by casting the COLUMN — turning an index
		// seek into a scan that also stops matching `::ffff:` forms.
		filters.push(sql`${sipAuthEvent.sourceIp} = ${query.sourceIp}::inet` as SQL);
	}
	if (query.accountRef !== undefined) {
		filters.push(eq(sipAuthEvent.accountRef, query.accountRef) as SQL);
	}
	if (query.cursor !== undefined) {
		const cursor = decodeAuditLogCursor(query.cursor);
		filters.push(
			sql`(${sipAuthEvent.occurredAt}, ${sipAuthEvent.id}) < (${cursor.occurredAt.toISOString()}::timestamptz, ${cursor.id}::uuid)` as SQL,
		);
	}
	return filters;
}

/** The listing as an unexecuted builder, so a spec can render it with `.toSQL()`. */
export function sipAuthEventListQuery(
	transaction: PbxDatabaseTransaction,
	query: SipAuthEventQuery,
	range: ResolvedEventRange,
) {
	return transaction
		.select(EVENT_LIST_COLUMNS)
		.from(sipAuthEvent)
		.where(and(...sipAuthEventFilters(query, range)))
		.orderBy(desc(sipAuthEvent.occurredAt), desc(sipAuthEvent.id))
		.limit(query.limit + 1);
}

@Injectable()
export class SipAuthEventQueryService {
	constructor(@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient) {}

	async list(session: AppSession, query: SipAuthEventQuery): Promise<SipAuthEventListEnvelope> {
		const organizationId = requireActiveOrganizationId(session);
		const range = resolveEventRange(query);

		const rows = await this.database
			.withTenantScope(
				organizationId,
				async (transaction) =>
					(await sipAuthEventListQuery(transaction, query, range)) as SipAuthEventRow[],
			)
			.catch(rethrowCursorError);

		const page = rows.slice(0, query.limit);
		return {
			data: page,
			nextCursor: nextAuditLogCursor(page, query.limit, rows.length),
			limit: query.limit,
			range: { from: range.from.toISOString(), to: range.to.toISOString() },
		};
	}
}

/**
 * A mangled cursor is a client that lost a query string, not a broken service.
 *
 * Reuses the ledger's exception so both listings answer an unreadable cursor with the same code and
 * a UI has one case to handle.
 */
function rethrowCursorError(cause: unknown): never {
	if (cause instanceof AuditLogCursorError) {
		throw new AuditInvalidCursorException(cause.message);
	}
	throw cause;
}
