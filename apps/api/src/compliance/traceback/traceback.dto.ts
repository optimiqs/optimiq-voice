import { z } from "zod/v4";
import { rangeDays, resolveTimeRange } from "../../cdr/query/cdr.dto";
import {
	ComplianceRangeTooWideException,
	ComplianceTracebackUnboundedException,
} from "../compliance.errors";
import type { ResolvedTimeRange } from "../../cdr/query/cdr.dto";

/**
 * The traceback query contract.
 *
 * ## What a traceback is, so the shape below reads as a consequence rather than as a preference
 *
 * An industry traceback (the ITG's, or a state attorney general's) arrives as: *this number called
 * this number at roughly this time — who originated it, and who is your customer?* The answer has to
 * come back inside 24 hours, which is what makes this a synchronous endpoint rather than a job. So
 * the query is a NUMBER plus a WINDOW, and everything else about the shape follows from the fact
 * that it runs across every tenant's partitions on the admin handle.
 *
 * ## The window is mandatory here, where every other range in this codebase defaults
 *
 * `cdr.dto.ts` defaults its range to the last 24 hours precisely so that no client can forget one.
 * That is right for a reporting screen and wrong here: a traceback names an instant somebody else
 * gave us, and a defaulted window would silently answer a different question from the one asked —
 * "no calls found" for a call that happened last Tuesday. `resolveTimeRange` is still reused for the
 * parsing and the inverted-range swap, but both bounds are required by the schema above it.
 *
 * ## At least one number, enforced outside the schema
 *
 * Expressed in {@link validateTraceback} rather than as a Zod refinement, so the refusal is the
 * area's own 400 with a `code` a client can switch on, and so it is a pure function a spec can drive
 * without building a Zod error. The same division `cdr.service.ts` uses for its range ceiling: the
 * schema's job is "is this a date", and "is this a question we can answer" is the area's.
 */

/**
 * The widest window one traceback may scan, in days.
 *
 * A month. Deliberately far tighter than the reporting list's 92 and the export's 366, because those
 * are bounded by `organization_id` first and this one is not: the predicate here is on `to_number`
 * or `from_number` alone, so it visits every tenant's rows in every partition the window names. The
 * index makes each partition a seek rather than a scan, but the partition count is whatever the
 * window says — and a traceback that genuinely needs a year is a subpoena, not an API call.
 */
export const TRACEBACK_MAX_RANGE_DAYS = 31;

/**
 * The most legs one traceback may return.
 *
 * A traceback is a question about a handful of calls. Five hundred rows is already far more than any
 * real request produces, and the cap is here for the query that is not a traceback at all — a
 * three-digit "number" that matches a million legs. Reached silently rather than as a failure,
 * because unlike a CSV export (`CDR_EXPORT_MAX_ROWS`, which FAILS rather than truncating so nobody
 * totals a column in a short file) a traceback answer is read row by row and a `truncated` flag on
 * the envelope is the honest, useful signal.
 */
export const TRACEBACK_MAX_ROWS = 500;

const isoDateTime = z.iso.datetime({ offset: true }).or(z.iso.datetime());

/** Exact, never partial: a traceback for +12125550100 must not also return +12125550100x. */
const numberFilter = z
	.string()
	.trim()
	.min(2)
	.max(32)
	.regex(/^[+0-9A-Za-z*#._-]+$/u, "must be a dialable string")
	.optional();

export const tracebackQuerySchema = z.object({
	from: isoDateTime,
	to: isoDateTime,
	/** The number that was CALLED — matches `to_number`, hitting `call_legs_traceback_to_idx`. */
	calledNumber: numberFilter,
	/** The number that was PRESENTED — matches `from_number`, hitting `call_legs_traceback_from_idx`. */
	callingNumber: numberFilter,
	/** Narrows to one trunk. Matches `trunk_ref`, hitting `call_legs_trunk_idx`. */
	trunkId: z.uuid().optional(),
	limit: z.coerce.number().int().min(1).max(TRACEBACK_MAX_ROWS).default(TRACEBACK_MAX_ROWS),
});

export type TracebackQuery = z.infer<typeof tracebackQuerySchema>;

/**
 * Resolves the window and refuses the two queries this endpoint must not run.
 *
 * Pure and total apart from the two throws, so both refusals are directly testable — which matters
 * more here than for most validators, because the thing being prevented is an unbounded cross-tenant
 * read of every customer's call history.
 */
export function validateTraceback(
	query: TracebackQuery,
	now: Date = new Date(),
): ResolvedTimeRange {
	if (query.calledNumber === undefined && query.callingNumber === undefined) {
		throw new ComplianceTracebackUnboundedException();
	}
	const range = resolveTimeRange(query, now);
	const days = rangeDays(range);
	if (days > TRACEBACK_MAX_RANGE_DAYS) {
		throw new ComplianceRangeTooWideException(TRACEBACK_MAX_RANGE_DAYS, days);
	}
	return range;
}
