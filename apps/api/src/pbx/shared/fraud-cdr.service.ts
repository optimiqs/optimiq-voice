import { and, callLegs, eq, gte, lt, sql } from "@optimiq-voice/cdr-db";
import { SHORT_CALL_SECONDS } from "../toll-fraud/fraud-cdr.port";
import type { FraudCdrSource, InternationalLegGroup } from "../toll-fraud/fraud-cdr.port";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

/**
 * `FraudCdrSource`, implemented against the call-detail database.
 *
 * Lives beside the other PBX↔CDR adapters in `src/pbx/shared` and is wired by
 * `pbx-cdr-ports.module.ts`, which is the one place allowed to hold both database handles at once —
 * see that file's header for why the two areas must not import each other directly. The direction is
 * the mirror of everything else in that module: the ports there hand PBX-owned facts to the CDR
 * area, and this hands a CDR-owned fact to the PBX area.
 *
 * ## The query is untenanted, and that is the whole reason it is one query
 *
 * The detector's pass is over the PLATFORM: an hourly sweep that has to find the tenant whose
 * traffic spiked, which means it cannot start from a list of tenants it already suspects. So this
 * runs on the admin handle, groups BY the tenant column, and returns the tenant id with every row —
 * the alternative is a scoped query per organization per hour, which is a round trip per tenant on a
 * platform whose tenant count is the thing that grows.
 *
 * What makes that acceptable is what it selects: an aggregate over `(organization, from, to)` and
 * three counts. No leg ids, no call ids, no names, no recording keys. A bug here can misattribute a
 * COUNT; it cannot disclose a conversation. Every read that touches a leg row still goes through the
 * CDR area's own tenant-scoped queries.
 *
 * ## What the SQL filters and what it deliberately does not
 *
 * Filtered here, because it is cheap in an index and enormous in transfer: the window, outbound
 * legs, answered legs, and destinations that look like E.164. NOT filtered here: which destinations
 * are international, and which prefixes are high-risk. Both are PBX policy — the first depends on
 * each tenant's own home country, which is a `pbx-db` setting this database has never heard of — and
 * putting either in this query would put fraud judgement where nothing that owns it can test it.
 */
export class FraudCdrService implements FraudCdrSource {
	constructor(private readonly database: CdrDatabaseClient) {}

	async internationalCandidates(
		since: Date,
		until: Date,
		limit: number,
	): Promise<readonly InternationalLegGroup[]> {
		const rows = await this.database.adminDb
			.select({
				organizationId: callLegs.organizationId,
				fromNumber: callLegs.fromNumber,
				toNumber: callLegs.toNumber,
				legs: sql<number>`count(*)`,
				// Rounded UP per leg before summing, because that is how a carrier bills and therefore
				// the number a spend cap should compare against: a hundred nine-second calls are a
				// hundred minutes on the invoice and would be one and a half if the total were rounded
				// instead. `greatest(…, 1)` so an answered leg never contributes zero.
				minutes: sql<number>`sum(greatest(ceil(${callLegs.billsecMs}::numeric / 60000), 1))`,
				shortLegs: sql<number>`count(*) filter (where ${callLegs.billsecMs} < ${SHORT_CALL_SECONDS * 1000})`,
			})
			.from(callLegs)
			.where(
				and(
					gte(callLegs.startedAt, since),
					lt(callLegs.startedAt, until),
					eq(callLegs.direction, "outbound"),
					eq(callLegs.disposition, "answered"),
					// A destination the dial plan canonicalised. Anything else is an extension, a
					// feature code or a number that never reached a carrier, and none of those can be
					// international by any reading.
					sql`${callLegs.toNumber} like '+%'`,
				),
			)
			.groupBy(callLegs.organizationId, callLegs.fromNumber, callLegs.toNumber)
			.limit(limit);
		return rows.map((row) => ({
			organizationId: row.organizationId,
			fromNumber: row.fromNumber,
			toNumber: row.toNumber,
			legs: Number(row.legs),
			minutes: Number(row.minutes),
			shortLegs: Number(row.shortLegs),
		}));
	}
}
