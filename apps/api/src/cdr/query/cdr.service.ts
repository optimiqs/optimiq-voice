import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import {
	CdrInvalidCursorException,
	CdrNotFoundException,
	CdrRangeTooWideException,
} from "../shared/cdr.errors";
import { CDR_DATABASE } from "../shared/cdr.tokens";
import { CdrCursorError, nextCursorFrom } from "./cdr-cursor";
import { MAX_RANGE_DAYS, rangeDays, resolveTimeRange } from "./cdr.dto";
import {
	getCallLeg,
	listCallLegs,
	listCallLegsForCall,
	listRecordingsForLegs,
} from "./cdr.repository";
import type { CdrCallQuery, CdrLegQuery, CdrListQuery, ResolvedTimeRange } from "./cdr.dto";
import type { CallLegDetailRow, CallLegListRow, RecordingListRow } from "./cdr.repository";
import type { AppSession } from "@optimiq-voice/auth";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

/**
 * The shaping layer between the reporting repository and the controllers.
 *
 * Same division as the PBX area's `PbxResourceService`: the organization id is read from the
 * session here — once, in one place — and no controller is allowed to accept one from the client.
 * An `organizationId` in a query string is a cross-tenant read waiting to be found.
 *
 * ## The response envelopes, which are a contract with `apps/web`
 *
 * ```jsonc
 * GET /api/v1/cdr            -> { "data": [ … ], "nextCursor": "…"|null, "limit": 25,
 *                                 "range": { "from": "…", "to": "…" } }
 * GET /api/v1/cdr/:id        -> { "data": { …leg…, "recordings": [ … ] } }
 * GET /api/v1/cdr/calls/:id  -> { "data": { "callId": "…", "legs": [ … ], "recordings": [ … ] } }
 * ```
 *
 * `nextCursor` rather than `page`/`total`/`totalPages`, unlike every PBX list. That is a real
 * divergence and it is deliberate: those three fields require a `count(*)` on each request, which
 * over a partitioned ledger is a scan of every partition in the range. The PBX tables are
 * configuration — hundreds of rows, counted for free — and this one is a billing journal that grows
 * without bound. A shared envelope would have made the wrong query cheap to write.
 */

export interface CdrListEnvelope {
	readonly data: readonly CallLegListRow[];
	readonly nextCursor: string | null;
	readonly limit: number;
	readonly range: { readonly from: string; readonly to: string };
}

export interface CdrLegEnvelope {
	readonly data: CallLegDetailRow & { readonly recordings: readonly RecordingListRow[] };
}

export interface CdrCallEnvelope {
	readonly data: {
		readonly callId: string;
		readonly legs: readonly CallLegListRow[];
		readonly recordings: readonly RecordingListRow[];
	};
}

@Injectable()
export class CdrService {
	constructor(@Inject(CDR_DATABASE) private readonly database: CdrDatabaseClient) {}

	private organizationId(session: AppSession): string {
		return requireActiveOrganizationId(session);
	}

	/**
	 * Resolves the window and refuses one that is too wide.
	 *
	 * The refusal is here rather than in the DTO because it is a policy about cost, not about
	 * shape: the schema's job is "is this a date", and "is this more history than one request may
	 * scan" is the area's. Keeping them apart is what lets an export path reuse the same DTO with a
	 * different ceiling later.
	 */
	private range(query: { readonly from?: string; readonly to?: string }): ResolvedTimeRange {
		const range = resolveTimeRange(query);
		const days = rangeDays(range);
		if (days > MAX_RANGE_DAYS) {
			throw new CdrRangeTooWideException(MAX_RANGE_DAYS, days);
		}
		return range;
	}

	/**
	 * One page of legs.
	 *
	 * `CdrCursorError` is translated here rather than left to a 500: an unreadable cursor is always
	 * a client that mangled a query string, and telling it so is the difference between a form it
	 * can recover from and a page that looks broken.
	 */
	async list(session: AppSession, query: CdrListQuery): Promise<CdrListEnvelope> {
		const organizationId = this.organizationId(session);
		const range = this.range(query);

		const page = await this.database
			.withTenantScope(
				organizationId,
				async (transaction) => await listCallLegs(transaction, query, range),
			)
			.catch(rethrowCursorError);

		return {
			data: page.rows,
			nextCursor: nextCursorFrom(page.rows, query.limit, page.fetched),
			limit: query.limit,
			range: { from: range.from.toISOString(), to: range.to.toISOString() },
		};
	}

	/** One leg, with any media it produced. */
	async get(session: AppSession, id: string, query: CdrLegQuery): Promise<CdrLegEnvelope> {
		const organizationId = this.organizationId(session);
		const range = this.range(query);
		const startedAt = query.startedAt === undefined ? undefined : new Date(query.startedAt);

		const found = await this.database.withTenantScope(organizationId, async (transaction) => {
			const leg = await getCallLeg(transaction, id, {
				...(startedAt === undefined || Number.isNaN(startedAt.getTime()) ? {} : { startedAt }),
				range,
			});
			if (leg === undefined) {
				return undefined;
			}
			const media = await listRecordingsForLegs(transaction, [leg.id]);
			return { ...leg, recordings: media };
		});

		if (found === undefined) {
			throw new CdrNotFoundException("call-leg", id);
		}
		return { data: found };
	}

	/**
	 * Every leg of one call, plus every recording any of them produced.
	 *
	 * This is what makes a call legible rather than a list of unrelated rows: a ring-group call is
	 * one A-leg and four B-legs that share a `call_id`, each B-leg naming the leg that dialled it
	 * through `originating_leg_id` and the answered pair naming each other through `bridge_leg_id`.
	 * The UI draws the tree from those three columns; the API's job is to return the set they are
	 * drawn over, in one round trip, so the tree cannot be assembled from a half-loaded state.
	 */
	async getCall(
		session: AppSession,
		callId: string,
		query: CdrCallQuery,
	): Promise<CdrCallEnvelope> {
		const organizationId = this.organizationId(session);
		const range = this.range(query);

		const found = await this.database.withTenantScope(organizationId, async (transaction) => {
			const legs = await listCallLegsForCall(transaction, callId, range);
			if (legs.length === 0) {
				return undefined;
			}
			const media = await listRecordingsForLegs(
				transaction,
				legs.map((leg) => leg.id),
			);
			return { callId, legs, recordings: media };
		});

		if (found === undefined) {
			throw new CdrNotFoundException("call", callId);
		}
		return { data: found };
	}
}

/** Turns the repository's cursor failure into the area's 400. Everything else propagates. */
function rethrowCursorError(error: unknown): never {
	if (error instanceof CdrCursorError) {
		throw new CdrInvalidCursorException(error.message);
	}
	throw error;
}
