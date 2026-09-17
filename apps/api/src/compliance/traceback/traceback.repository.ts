import { and, callLegs, desc, eq, gte, lte } from "@optimiq-voice/cdr-db";
import type { ResolvedTimeRange } from "../../cdr/query/cdr.dto";
import type { TracebackQuery } from "./traceback.dto";
import type { CdrDatabase, SQL } from "@optimiq-voice/cdr-db";

/**
 * The traceback query, as Drizzle over the CDR admin handle.
 *
 * ## Why this one repository takes a database rather than a scoped transaction
 *
 * Every function in `cdr/query/cdr.repository.ts` takes a transaction the caller has already scoped,
 * and its header says why: "a repository that took an `organizationId` and put it in a `where`
 * clause would be a repository someone can call without one". This file is the deliberate exception,
 * and it is the exception the rule was written to make visible — a traceback is a question ACROSS
 * tenants, so there is no organization to scope to and the tenant role's policy would answer it with
 * zero rows. It runs on `adminDb`, which `cdr-database.ts` describes as "the schema owner… not
 * subject to the policies", and the accountability that RLS would have provided is replaced by the
 * audit row the service writes for every call.
 *
 * ## The predicates are chosen to land on the tenant-agnostic indexes, and the range is never optional
 *
 * `call_legs_traceback_to_idx` is `(to_number, started_at desc)`, `_from_idx` the same on
 * `from_number`, and `call_legs_trunk_idx` on `(trunk_ref, started_at desc)`. All three lead with the
 * equality column and end in the partition key, so a query of the form "this number, in this window"
 * is one seek per partition the window names. The `started_at` bounds are therefore not a filter,
 * they are what makes the query finite — the same unconditional rule the reporting repository states,
 * with more riding on it because there is no tenant predicate here to help.
 *
 * `calledNumber` and `callingNumber` are ANDed when both are given, not ORed. A traceback naming both
 * ends means "this specific call", and an OR would answer a question nobody asked with a result set
 * two orders of magnitude larger.
 */

/** Exactly the columns a traceback answer contains. `raw` and the media block are not among them. */
const TRACEBACK_COLUMNS = {
	organizationId: callLegs.organizationId,
	callId: callLegs.callId,
	startedAt: callLegs.startedAt,
	direction: callLegs.direction,
	fromNumber: callLegs.fromNumber,
	toNumber: callLegs.toNumber,
	sipCallId: callLegs.sipCallId,
	trunkRef: callLegs.trunkRef,
	signalingAddress: callLegs.signalingAddress,
	sipAttestation: callLegs.sipAttestation,
	sipVerstat: callLegs.sipVerstat,
	sipOrigId: callLegs.sipOrigId,
	expectedAttestation: callLegs.expectedAttestation,
	callerIdRightToUse: callLegs.callerIdRightToUse,
	disposition: callLegs.disposition,
	durationMs: callLegs.durationMs,
} as const;

export type TracebackLegRow = {
	[K in keyof typeof TRACEBACK_COLUMNS]: (typeof TRACEBACK_COLUMNS)[K]["_"]["data"];
};

export async function selectTracebackLegs(
	database: CdrDatabase,
	query: TracebackQuery,
	range: ResolvedTimeRange,
): Promise<readonly TracebackLegRow[]> {
	const filters: SQL[] = [
		gte(callLegs.startedAt, range.from) as SQL,
		lte(callLegs.startedAt, range.to) as SQL,
	];
	if (query.calledNumber !== undefined) {
		filters.push(eq(callLegs.toNumber, query.calledNumber) as SQL);
	}
	if (query.callingNumber !== undefined) {
		filters.push(eq(callLegs.fromNumber, query.callingNumber) as SQL);
	}
	if (query.trunkId !== undefined) {
		filters.push(eq(callLegs.trunkRef, query.trunkId) as SQL);
	}
	return await database
		.select(TRACEBACK_COLUMNS)
		.from(callLegs)
		.where(and(...filters))
		// Newest first: a traceback names an approximate instant, and the call being asked about is
		// almost always the most recent match in a window drawn around it.
		.orderBy(desc(callLegs.startedAt))
		.limit(query.limit);
}
