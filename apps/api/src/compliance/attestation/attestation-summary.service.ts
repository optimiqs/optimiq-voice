import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { and, callLegs, eq, gte, lte, sql } from "@optimiq-voice/cdr-db";
import { CDR_DATABASE } from "../../cdr/shared/cdr.tokens";
import { resolveSummaryRange, summariseAttestation } from "./attestation-summary";
import type { AttestationSummaryQuery, AttestationSummaryRow } from "./attestation-summary";
import type { AppSession } from "@optimiq-voice/auth";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

/**
 * The tenant's own attestation picture, aggregated over its outbound legs.
 *
 * ## On the tenant handle, inside `withTenantScope`, and that is the whole security story
 *
 * Unlike the traceback beside it, this endpoint answers a question about ONE organization, so it
 * takes the ordinary path: `withTenantScope` drops into `cdr_tenant_tls` and publishes the id the RLS
 * policies read, and the `organization_id` in the predicate below is the explicit half of the same
 * fact. Two lines of defence, exactly as every reporting query in `cdr/query` has.
 *
 * ## Grouped in the database, folded in this process
 *
 * The `group by` collapses what is potentially millions of legs to at most a few hundred buckets
 * before anything crosses the wire; the fold from buckets to one row per number is
 * {@link summariseAttestation}, a pure function, because it is the part with a decision in it (what
 * `unknown` means) and it should be provable without a pool.
 *
 * The `limit` applies to the BUCKETS rather than to the numbers, which is a deliberate imprecision:
 * one number produces at most a handful of buckets, so a bucket cap of 100 is a number cap of roughly
 * 25 and never fewer than 12. Capping numbers exactly would need a windowed sub-select for a report
 * whose whole point is the top of the list.
 */
@Injectable()
export class AttestationSummaryService {
	constructor(@Inject(CDR_DATABASE) private readonly cdr: CdrDatabaseClient) {}

	async summary(
		session: AppSession,
		query: AttestationSummaryQuery,
	): Promise<{
		readonly data: readonly AttestationSummaryRow[];
		readonly range: { readonly from: string; readonly to: string };
	}> {
		const organizationId = requireActiveOrganizationId(session);
		const range = resolveSummaryRange(query);

		const buckets = await this.cdr.withTenantScope(organizationId, async (transaction) =>
			transaction
				.select({
					fromNumber: callLegs.fromNumber,
					expectedAttestation: callLegs.expectedAttestation,
					callerIdRightToUse: callLegs.callerIdRightToUse,
					calls: sql<number>`count(*)::int`,
				})
				.from(callLegs)
				.where(
					and(
						eq(callLegs.organizationId, organizationId),
						eq(callLegs.direction, "outbound"),
						// The partition key, unconditionally. Same rule as every other query on this table.
						gte(callLegs.startedAt, range.from),
						lte(callLegs.startedAt, range.to),
					),
				)
				.groupBy(callLegs.fromNumber, callLegs.expectedAttestation, callLegs.callerIdRightToUse)
				.orderBy(sql`count(*) desc`)
				.limit(query.limit),
		);

		return {
			data: summariseAttestation(buckets),
			range: { from: range.from.toISOString(), to: range.to.toISOString() },
		};
	}
}
