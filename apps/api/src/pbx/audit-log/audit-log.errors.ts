import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * The two ways a ledger READ can fail.
 *
 * Plain `HttpException`s rather than the `Schema.TaggedErrorClass` failures in `pbx.errors.ts`,
 * because this surface does not go through the Effect repository: like the reporting area it is a
 * service over `withTenantScope`, so there is no typed failure channel for `runEffect` to unwrap
 * and a Nest exception is the honest shape. The bodies follow the same contract as every other
 * area — a machine-readable `code` a client switches on, plus whatever makes the failure
 * actionable:
 *
 * ```jsonc
 * { "statusCode": 400, "code": "AUDIT_INVALID_CURSOR", "message": "…" }
 * { "statusCode": 400, "code": "AUDIT_RANGE_TOO_WIDE", "message": "…", "maxDays": 366 }
 * ```
 *
 * There is no `AUDIT_NOT_FOUND` and no 409, because there is nothing here but a listing: the
 * ledger is append-only in the database itself, so this area has no write to roll back, no row to
 * fail to find by id and no conflict to report.
 */

/** A cursor that is not one of ours. Always a 400: a client cannot recover by retrying. */
export class AuditInvalidCursorException extends HttpException {
	constructor(detail: string) {
		super(
			{
				statusCode: HttpStatus.BAD_REQUEST,
				code: "AUDIT_INVALID_CURSOR",
				message: `The pagination cursor could not be read (${detail}). Start the listing again.`,
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

/**
 * The requested window is wider than one request may scan.
 *
 * Not a statement about how much history a tenant may keep — retention decides that — but a
 * promise that a single listing cannot become a scan of the whole ledger. Paging through a year
 * with the cursor stays cheap; asking for it in one predicate does not.
 */
export class AuditRangeTooWideException extends HttpException {
	constructor(maxDays: number, requestedDays: number) {
		super(
			{
				statusCode: HttpStatus.BAD_REQUEST,
				code: "AUDIT_RANGE_TOO_WIDE",
				message: `The requested range spans ${requestedDays} days; at most ${maxDays} may be queried at once. Narrow the range or page through it.`,
				maxDays,
				requestedDays,
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}
