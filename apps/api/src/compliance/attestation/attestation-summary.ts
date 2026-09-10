import { z } from "zod/v4";
import { MAX_RANGE_DAYS, rangeDays, resolveTimeRange } from "../../cdr/query/cdr.dto";
import { ComplianceRangeTooWideException } from "../compliance.errors";
import type { ResolvedTimeRange } from "../../cdr/query/cdr.dto";

/**
 * `GET /api/v1/compliance/attestation-summary` — what this tenant has been presenting.
 *
 * ## The question this answers, which is not the same as the traceback's
 *
 * A traceback is reactive: somebody else names a call and we look it up. This is the tenant's own
 * pre-emptive view — *for every number we presented last month, how many of those calls could we
 * stand behind?* A page of numbers with an all-`C` row on it is a number the tenant is presenting
 * with no right-to-use record, which is exactly the row that becomes a traceback in three months and
 * exactly the row a `verified_caller_id` filing fixes. Putting the two counts side by side is what
 * makes the report actionable rather than merely descriptive.
 *
 * ## Outbound legs only, and grouped by `from_number`
 *
 * Attestation is a claim the ORIGINATING provider makes about the calling party, so an inbound leg
 * has no expected attestation of ours to report — whatever is in `sip_attestation` there was asserted
 * by somebody else's network. `from_number` on an outbound leg is the number this tenant PRESENTED,
 * which is the thing the right-to-use table is keyed on and therefore the only grouping under which
 * the counts mean anything.
 *
 * ## The window ceiling is the reporting one, not the traceback's
 *
 * This runs on the CDR TENANT handle inside `withTenantScope`, so it is bounded by
 * `organization_id` first and is an ordinary reporting aggregate — `MAX_RANGE_DAYS` (92 days, "roughly
 * one quarter — the widest window a person actually reads a call list over") applies unchanged. The
 * traceback's much tighter month exists because that query has no tenant predicate; this one does.
 */
export const attestationSummaryQuerySchema = z.object({
	from: z.iso.datetime({ offset: true }).or(z.iso.datetime()).optional(),
	to: z.iso.datetime({ offset: true }).or(z.iso.datetime()).optional(),
	/** The most presented numbers to report. A tenant presenting more than this has a different problem. */
	limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type AttestationSummaryQuery = z.infer<typeof attestationSummaryQuerySchema>;

/** Resolves the window and refuses one wider than the reporting ceiling. */
export function resolveSummaryRange(
	query: AttestationSummaryQuery,
	now: Date = new Date(),
): ResolvedTimeRange {
	const range = resolveTimeRange(query, now);
	const days = rangeDays(range);
	if (days > MAX_RANGE_DAYS) {
		throw new ComplianceRangeTooWideException(MAX_RANGE_DAYS, days);
	}
	return range;
}

/** One `(number, attestation, right-to-use)` bucket, as the database groups it. */
export interface AttestationSummaryBucket {
	readonly fromNumber: string;
	readonly expectedAttestation: string | null;
	readonly callerIdRightToUse: string | null;
	readonly calls: number;
}

/** One presented number, with its counts. */
export interface AttestationSummaryRow {
	readonly fromNumber: string;
	readonly calls: number;
	readonly attestation: {
		readonly A: number;
		readonly B: number;
		readonly C: number;
		readonly unknown: number;
	};
	/** Every right-to-use recorded for this number in the window, with its count. */
	readonly rightToUse: Readonly<Record<string, number>>;
}

/**
 * Folds the grouped buckets into one row per presented number.
 *
 * Pure, and separate from the query, so the fold — the part that can be silently wrong — is testable
 * without a database. `unknown` is its own bucket rather than being merged into `C`, and the
 * distinction is the whole reason the column is nullable: `C` means *we decided we could not vouch
 * for this*, and NULL means *this leg predates the stamping, or nothing consulted the policy*. A
 * report that collapsed them would tell a tenant it has a compliance problem where it has a
 * backfill.
 *
 * Rows come back ordered by call count descending, so the number a tenant presents most is the number
 * a reader sees first.
 */
export function summariseAttestation(
	buckets: readonly AttestationSummaryBucket[],
): readonly AttestationSummaryRow[] {
	const byNumber = new Map<
		string,
		{ calls: number; attestation: Record<string, number>; rightToUse: Record<string, number> }
	>();
	for (const bucket of buckets) {
		let row = byNumber.get(bucket.fromNumber);
		if (row === undefined) {
			row = { calls: 0, attestation: { A: 0, B: 0, C: 0, unknown: 0 }, rightToUse: {} };
			byNumber.set(bucket.fromNumber, row);
		}
		row.calls += bucket.calls;
		const level =
			bucket.expectedAttestation !== null && bucket.expectedAttestation in row.attestation
				? bucket.expectedAttestation
				: "unknown";
		row.attestation[level] = (row.attestation[level] ?? 0) + bucket.calls;
		if (bucket.callerIdRightToUse !== null) {
			row.rightToUse[bucket.callerIdRightToUse] =
				(row.rightToUse[bucket.callerIdRightToUse] ?? 0) + bucket.calls;
		}
	}
	return [...byNumber.entries()]
		.map(([fromNumber, row]) => ({
			fromNumber,
			calls: row.calls,
			attestation: {
				A: row.attestation.A ?? 0,
				B: row.attestation.B ?? 0,
				C: row.attestation.C ?? 0,
				unknown: row.attestation.unknown ?? 0,
			},
			rightToUse: row.rightToUse,
		}))
		.sort(
			(left, right) => right.calls - left.calls || left.fromNumber.localeCompare(right.fromNumber),
		);
}
