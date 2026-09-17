import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import { AUTH_REPOSITORY } from "../../auth/auth.tokens";
import { actorFromSession, asUuid, insertAuditLog } from "../../pbx/shared/audit-log";
import { PBX_DATABASE } from "../../pbx/shared/pbx.tokens";
import { ComplianceKycNotFoundException } from "../compliance.errors";
import { listPlatformKyc, writeKycDecision } from "./kyc.repository";
import type { AuthRepository } from "../../auth/auth.repository";
import type { KycDecisionDto, PlatformKycListQuery } from "./kyc.dto";
import type { KycResponseRow } from "./kyc.repository";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.compliance");

/** A queue entry: the file, plus the tenant's name so a reviewer is not reading uuids. */
export interface PlatformKycEntry extends KycResponseRow {
	readonly organizationName: string | null;
}

/**
 * The platform operator's review queue.
 *
 * ## Why this is the untenanted handle, and what that costs
 *
 * `compliance.review` is in `OWNER_ONLY_PERMISSIONS`: it is held by the platform operator and by
 * nobody inside a customer organization. The queue it serves is *every* tenant's file, and the
 * tenant handle cannot express that — `packages/pbx-db`'s client is reachable "only as `adminDb`
 * (untenanted) or inside `withTenantScope`", and the RLS policy on `organization_kyc` answers "your
 * own row" by construction. So this class holds `adminDb` and the scope of every statement is
 * explicit in the statement, which is the contract the client's header states for exactly this case.
 *
 * The cost is that the database is no longer the second line of defence: on the tenant path a bug in
 * a service is still refused by a policy, and here it is not. That is why **every read and every
 * write on this surface writes an audit row** — the ledger is what replaces the policy as the thing
 * that makes cross-tenant access accountable.
 *
 * ## Why the audit row is filed under the OPERATOR's organization
 *
 * `audit_log` is tenant-scoped (`security-schema.ts`, and the RLS policies on it), so every row has
 * to name one organization. A cross-tenant listing has no single tenant to file under — it touched
 * all of them — and filing one row per organization returned would put an entry in a customer's
 * change history for something the customer neither did nor can act on, and would tell that customer
 * that a platform review swept their file. The acting operator's own organization is the honest
 * home: it is where "what did our compliance team look at" is asked, and it is the only tenant that
 * is actually a party to the action. A DECISION is different — it changes one organization's row —
 * and is filed under that organization, where the tenant can see the verdict that was reached about
 * it, with the operator recorded as the actor.
 */
@Injectable()
export class PlatformKycService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(AUTH_REPOSITORY) private readonly auth: AuthRepository,
	) {}

	/**
	 * One page of the queue, oldest-waiting first.
	 *
	 * The organization NAME is resolved per distinct id against the auth database rather than joined,
	 * because it lives in a different bounded context with a different pool — the same reason
	 * `auth.repository.ts` exists at all. Bounded by the page size, so a page of 25 is at most 25
	 * lookups and usually far fewer.
	 */
	async list(
		session: AppSession,
		query: PlatformKycListQuery,
	): Promise<{
		readonly data: readonly PlatformKycEntry[];
		readonly total: number;
		readonly page: number;
		readonly limit: number;
	}> {
		const page = await listPlatformKyc(this.database.adminDb, query);
		const named = await this.withNames(page.rows);
		await this.recordPlatformAccess(session, "compliance-kyc.review-list", {
			decision: query.decision ?? null,
			page: query.page,
			returned: named.length,
		});
		return { data: named, total: page.total, page: query.page, limit: query.limit };
	}

	/**
	 * Records a verdict on one organization's file.
	 *
	 * `reviewedBy` is the acting operator's user id, read from the session here and nowhere else —
	 * the same derivation `PbxResourceService.actor` makes, and for the same reason: a reviewer id
	 * that can be supplied is a reviewer id that can name somebody else.
	 */
	async decide(
		session: AppSession,
		organizationId: string,
		body: KycDecisionDto,
	): Promise<{ readonly data: PlatformKycEntry }> {
		const actor = actorFromSession(session);
		const written = await writeKycDecision(
			this.database.adminDb,
			organizationId,
			body.decision,
			asUuid(actor.userId),
			body.reviewNotes ?? null,
		);
		if (written === undefined) {
			throw new ComplianceKycNotFoundException(organizationId);
		}

		// Filed under the REVIEWED organization: the verdict is a fact about that tenant, and the
		// tenant's own change history is where it belongs. The operator is the actor, not the subject.
		await this.database.withTenantScope(organizationId, async (transaction) => {
			await insertAuditLog(transaction, {
				organizationId,
				actor,
				action: "compliance-kyc.decision",
				resourceType: "organization_kyc",
				resourceRef: written.id,
				before: null,
				after: { decision: written.decision, reviewNotes: written.reviewNotes },
			});
		});
		logger.info(
			{ organizationId, decision: written.decision },
			"a platform reviewer recorded a KYC decision",
		);
		const [entry] = await this.withNames([written]);
		return { data: entry ?? { ...written, organizationName: null } };
	}

	private async withNames(rows: readonly KycResponseRow[]): Promise<readonly PlatformKycEntry[]> {
		const names = new Map<string, string | null>();
		for (const id of new Set(rows.map((row) => row.organizationId))) {
			try {
				names.set(id, (await this.auth.findOrganizationById(id))?.name ?? null);
			} catch (error) {
				// A name is a convenience; a review queue that 500s because the auth database blinked is
				// not. The id is still there and is what every other route keys on.
				logger.warn({ organizationId: id, err: error }, "could not resolve an organization name");
				names.set(id, null);
			}
		}
		return rows.map((row) => ({ ...row, organizationName: names.get(row.organizationId) ?? null }));
	}

	/**
	 * One ledger row per cross-tenant READ, under the operator's own organization.
	 *
	 * Best-effort: an operator whose session has no active organization (which the guard permits for
	 * a platform principal) has nowhere to file, and refusing the read would make the review queue
	 * depend on the operator having picked a tenant first. Logged instead, so the gap is visible.
	 */
	private async recordPlatformAccess(
		session: AppSession,
		action: string,
		detail: Record<string, unknown>,
	): Promise<void> {
		let operatorOrganizationId: string;
		try {
			operatorOrganizationId = requireActiveOrganizationId(session);
		} catch {
			logger.warn(
				{ action },
				"a platform compliance read could not be filed: no active organization",
			);
			return;
		}
		const actor = actorFromSession(session);
		await this.database.withTenantScope(operatorOrganizationId, async (transaction) => {
			await insertAuditLog(transaction, {
				organizationId: operatorOrganizationId,
				actor,
				action,
				resourceType: "organization_kyc",
				resourceRef: null,
				before: null,
				after: detail,
			});
		});
	}
}
