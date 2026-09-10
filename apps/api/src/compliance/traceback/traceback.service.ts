import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import { AUTH_REPOSITORY } from "../../auth/auth.tokens";
import { CDR_DATABASE } from "../../cdr/shared/cdr.tokens";
import { actorFromSession, insertAuditLog } from "../../pbx/shared/audit-log";
import { PBX_DATABASE } from "../../pbx/shared/pbx.tokens";
import { selectKyc } from "../kyc/kyc.repository";
import { validateTraceback } from "./traceback.dto";
import { selectTracebackLegs } from "./traceback.repository";
import type { AuthRepository } from "../../auth/auth.repository";
import type { ResolvedTimeRange } from "../../cdr/query/cdr.dto";
import type { TracebackQuery } from "./traceback.dto";
import type { TracebackLegRow } from "./traceback.repository";
import type { AppSession } from "@optimiq-voice/auth";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";
import type { KycDecision, PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.compliance");

/** One matched leg, with the two facts about its tenant that a traceback answer has to carry. */
export interface TracebackEntry extends TracebackLegRow {
	readonly organizationName: string | null;
	readonly kycDecision: KycDecision | null;
}

export interface TracebackResult {
	readonly data: readonly TracebackEntry[];
	readonly range: { readonly from: string; readonly to: string };
	readonly limit: number;
	/** True when the row cap was reached — see `TRACEBACK_MAX_ROWS` for why this is a flag. */
	readonly truncated: boolean;
}

/**
 * `GET /api/v1/platform/traceback` — who originated this call, and who is our customer.
 *
 * ## Three databases, and why the answer is assembled rather than joined
 *
 * The legs are in `cdr-db`, the KYC decision is in `pbx-db`, and the organization's NAME is in the
 * better-auth database behind `packages/db`. Those are three bounded contexts with three connection
 * pools, chosen so that no one of them can be the reason another is down; there is no join to write
 * even if one were wanted. So: one indexed query for the legs, then one lookup per DISTINCT
 * organization the legs named — which is one or two in every real traceback, and is bounded by the
 * row cap in the pathological case.
 *
 * ## Every traceback writes an audit row, and it is filed under the OPERATOR's organization
 *
 * A traceback is an unpoliced cross-tenant read of call history: the tenant handle cannot express it
 * and RLS therefore is not the second line of defence it is everywhere else. The ledger is what
 * replaces it. `audit_log` is tenant-scoped by schema — `security-schema.ts` grants the tenant role
 * `SELECT, INSERT` under policies keyed on `organization_id` — so every row must name exactly one
 * organization, and a query that touched every tenant has none of its own. Filing one row per tenant
 * in the RESULT would be worse than useless: it would put an entry in a customer's change history for
 * an investigation the customer is not a party to and cannot act on, and it would tell that customer
 * their traffic was examined. The acting operator's own organization is where "what did our
 * compliance team look up, and when" is genuinely asked, and it is the only tenant that is a party to
 * the action. The row records the operator, the numbers, the window and the count — never the rows.
 */
@Injectable()
export class TracebackService {
	constructor(
		@Inject(CDR_DATABASE) private readonly cdr: CdrDatabaseClient,
		@Inject(PBX_DATABASE) private readonly pbx: PbxDatabaseClient,
		@Inject(AUTH_REPOSITORY) private readonly auth: AuthRepository,
	) {}

	async trace(session: AppSession, query: TracebackQuery): Promise<TracebackResult> {
		const range = validateTraceback(query);
		const legs = await selectTracebackLegs(this.cdr.adminDb, query, range);
		const data = await this.withTenantFacts(legs);
		await this.record(session, query, range, data.length);
		return {
			data,
			range: { from: range.from.toISOString(), to: range.to.toISOString() },
			limit: query.limit,
			truncated: legs.length >= query.limit,
		};
	}

	/**
	 * The two per-tenant facts, resolved once per distinct organization.
	 *
	 * The KYC read goes through `withTenantScope` for each organization rather than through `adminDb`,
	 * even though this caller could use the admin handle and save a round trip. That is deliberate:
	 * the traceback has ONE untenanted read in it and it is the one that cannot be anything else. A
	 * per-organization lookup can be scoped, so it is — the fewer statements that run outside RLS, the
	 * smaller the surface a future edit can widen by accident.
	 */
	private async withTenantFacts(
		legs: readonly TracebackLegRow[],
	): Promise<readonly TracebackEntry[]> {
		const names = new Map<string, string | null>();
		const decisions = new Map<string, KycDecision | null>();
		for (const organizationId of new Set(legs.map((leg) => leg.organizationId))) {
			names.set(organizationId, await this.organizationName(organizationId));
			decisions.set(organizationId, await this.kycDecision(organizationId));
		}
		return legs.map((leg) => ({
			...leg,
			organizationName: names.get(leg.organizationId) ?? null,
			kycDecision: decisions.get(leg.organizationId) ?? null,
		}));
	}

	private async organizationName(organizationId: string): Promise<string | null> {
		try {
			return (await this.auth.findOrganizationById(organizationId))?.name ?? null;
		} catch (error) {
			// A traceback with the ids and no names is still an answer, and the clock is 24 hours. A
			// 500 because the auth database blinked is not.
			logger.warn(
				{ organizationId, err: error },
				"a traceback could not resolve an organization name",
			);
			return null;
		}
	}

	private async kycDecision(organizationId: string): Promise<KycDecision | null> {
		try {
			const row = await this.pbx.withTenantScope(
				organizationId,
				async (transaction) => await selectKyc(transaction, organizationId),
			);
			return row?.decision ?? null;
		} catch (error) {
			logger.warn({ organizationId, err: error }, "a traceback could not resolve a KYC decision");
			return null;
		}
	}

	/**
	 * The ledger row. Best-effort in the same narrow sense the platform review queue's is.
	 *
	 * An operator whose session has no active organization has nowhere to file — the guard permits a
	 * platform principal without one — and refusing the traceback for that reason would make a
	 * regulatory deadline depend on which tenant the operator last clicked. Logged loudly instead.
	 */
	private async record(
		session: AppSession,
		query: TracebackQuery,
		range: ResolvedTimeRange,
		matched: number,
	): Promise<void> {
		let operatorOrganizationId: string;
		try {
			operatorOrganizationId = requireActiveOrganizationId(session);
		} catch {
			logger.warn(
				{ matched },
				"a traceback ran but could not be filed in the audit ledger: no active organization",
			);
			return;
		}
		const actor = actorFromSession(session);
		await this.pbx.withTenantScope(operatorOrganizationId, async (transaction) => {
			await insertAuditLog(transaction, {
				organizationId: operatorOrganizationId,
				actor,
				action: "compliance.traceback",
				resourceType: "call_legs",
				// One row names one entity, and a traceback names a query. Null rather than an arbitrary
				// leg id, on the same grounds `erasure` files a null ref.
				resourceRef: null,
				before: null,
				after: {
					calledNumber: query.calledNumber ?? null,
					callingNumber: query.callingNumber ?? null,
					trunkId: query.trunkId ?? null,
					from: range.from.toISOString(),
					to: range.to.toISOString(),
					matched,
				},
			});
		});
		logger.info(
			{
				operatorOrganizationId,
				matched,
				from: range.from.toISOString(),
				to: range.to.toISOString(),
			},
			"a platform traceback was answered and recorded",
		);
	}
}
