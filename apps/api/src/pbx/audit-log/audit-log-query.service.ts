import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import { AuditLogCursorError, nextAuditLogCursor } from "./audit-log.cursor";
import { auditRangeDays, MAX_RANGE_DAYS, resolveAuditRange } from "./audit-log.dto";
import { AuditInvalidCursorException, AuditRangeTooWideException } from "./audit-log.errors";
import { listAuditLog } from "./audit-log.repository";
import type { AuditLogQuery, ResolvedAuditRange } from "./audit-log.dto";
import type { AuditLogRow } from "./audit-log.repository";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The shaping layer between the ledger's read query and the controller.
 *
 * Named `AuditLogQueryService` because `shared/audit-log.service.ts` already owns
 * `AuditLogService` — the WRITER, which appends a row inside every mutation's transaction. The
 * two never meet: one is called by the repository with a transaction it did not open, this one
 * opens its own and only ever reads.
 *
 * ## The organization id is read here, once, and never accepted from the client
 *
 * Same division as `PbxResourceService` and `CdrService`. `requireActiveOrganizationId` is the
 * only source of the tenant, `withTenantScope` is the only way to a transaction, and the query
 * DTO has no organization field at all — an `organizationId` in a query string would be a
 * cross-tenant read waiting to be found, and a non-strict Zod object drops it silently rather
 * than letting it reach anything. Below that, `audit_log_tenant_select` is the database's own
 * refusal, so a bug in this file is still not a leak.
 *
 * ## The response envelope
 *
 * ```jsonc
 * GET /api/v1/audit-log -> { "data": [ … ], "nextCursor": "…"|null, "limit": 25,
 *                            "range": { "from": "…", "to": "…" } }
 * ```
 *
 * `nextCursor` rather than `page`/`total`/`totalPages`, unlike every other PBX list. That is a
 * real divergence and it is argued in `audit-log.cursor.ts`: those three fields need a `count(*)`
 * per request over a table that grows with every mutation forever, and `offset` over a ledger
 * being appended to while somebody reads it silently skips rows. `range` is echoed because the
 * window was DEFAULTED — a filter the caller cannot see is what makes "why is my change missing?"
 * unanswerable.
 */
export interface AuditLogListEnvelope {
	readonly data: readonly AuditLogRow[];
	readonly nextCursor: string | null;
	readonly limit: number;
	readonly range: { readonly from: string; readonly to: string };
}

@Injectable()
export class AuditLogQueryService {
	constructor(@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient) {}

	/** The active organization, or a 403 telling the caller to pick one. */
	private organizationId(session: AppSession): string {
		return requireActiveOrganizationId(session);
	}

	/**
	 * Resolves the window and refuses one that is too wide.
	 *
	 * The refusal is here rather than in the DTO because it is a policy about cost, not about
	 * shape: the schema's job is "is this a date", and "is this more history than one request may
	 * scan" is the area's.
	 */
	private range(query: AuditLogQuery): ResolvedAuditRange {
		const range = resolveAuditRange(query);
		const days = auditRangeDays(range);
		if (days > MAX_RANGE_DAYS) {
			throw new AuditRangeTooWideException(MAX_RANGE_DAYS, days);
		}
		return range;
	}

	/**
	 * One page of ledger entries, newest first.
	 *
	 * `AuditLogCursorError` is translated here rather than left to a 500: an unreadable cursor is
	 * always a client that mangled a query string, and telling it so is the difference between a
	 * listing it can restart and a page that looks broken.
	 */
	async list(session: AppSession, query: AuditLogQuery): Promise<AuditLogListEnvelope> {
		const organizationId = this.organizationId(session);
		const range = this.range(query);

		const page = await this.database
			.withTenantScope(
				organizationId,
				async (transaction) => await listAuditLog(transaction, query, range),
			)
			.catch(rethrowCursorError);

		return {
			data: page.rows,
			nextCursor: nextAuditLogCursor(page.rows, query.limit, page.fetched),
			limit: query.limit,
			range: { from: range.from.toISOString(), to: range.to.toISOString() },
		};
	}
}

/** Turns the repository's cursor failure into the area's 400. Everything else propagates. */
function rethrowCursorError(error: unknown): never {
	if (error instanceof AuditLogCursorError) {
		throw new AuditInvalidCursorException(error.message);
	}
	throw error;
}
