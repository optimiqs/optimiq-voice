import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * The compliance area's HTTP failure taxonomy.
 *
 * Same contract as `cdr/shared/cdr.errors.ts` and for the same reason it exists as its own file
 * rather than as four more entries in `pbx/shared/pbx.errors.ts`: these are failures of a
 * *regulatory* surface, not of the routing compiler, and the PBX taxonomy is a shared file every
 * other pack is also editing. A plain Nest exception declared here costs one class and couples
 * nothing — which is exactly the trade `cdr.errors.ts` made when the reporting area needed a
 * `RANGE_TOO_WIDE` of its own instead of borrowing one.
 *
 * ```jsonc
 * { "statusCode": 404, "code": "COMPLIANCE_KYC_NOT_FOUND",   "message": "…" }
 * { "statusCode": 400, "code": "COMPLIANCE_RANGE_TOO_WIDE",  "message": "…", "maxDays": 31 }
 * { "statusCode": 400, "code": "COMPLIANCE_TRACEBACK_UNBOUNDED", "message": "…" }
 * { "statusCode": 501, "code": "COMPLIANCE_SECRET_KEY_MISSING", "message": "…" }
 * ```
 */

/** A tenant asked for a KYC file it has never filed. Never a 200 with an empty body: absent is a state. */
export class ComplianceKycNotFoundException extends HttpException {
	constructor(organizationId: string) {
		super(
			{
				statusCode: HttpStatus.NOT_FOUND,
				code: "COMPLIANCE_KYC_NOT_FOUND",
				message: `No know-your-customer file has been filed for organization ${organizationId}.`,
				organizationId,
			},
			HttpStatus.NOT_FOUND,
		);
	}
}

/**
 * The traceback window is wider than one operator query may scan.
 *
 * The same argument `CdrRangeTooWideException` makes, one order of magnitude tighter. A traceback
 * predicate is on `to_number`/`from_number` and NOT on `organization_id`, so it runs across every
 * tenant's partitions at once — the index makes that a seek per partition rather than a scan, but
 * the number of partitions is still whatever the window names. A traceback request is also a
 * *specific* question ("who originated this call on the 14th") rather than a report, so a month is
 * generous rather than restrictive.
 */
export class ComplianceRangeTooWideException extends HttpException {
	constructor(maxDays: number, requestedDays: number) {
		super(
			{
				statusCode: HttpStatus.BAD_REQUEST,
				code: "COMPLIANCE_RANGE_TOO_WIDE",
				message: `The requested range spans ${requestedDays} days; at most ${maxDays} may be traced at once. Narrow the window.`,
				maxDays,
				requestedDays,
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

/**
 * A traceback naming neither a called nor a calling number.
 *
 * Refused rather than answered, because the only query this endpoint can serve efficiently is one
 * that hits `call_legs_traceback_to_idx` or `call_legs_traceback_from_idx`. A window with no number
 * in it is "every call on this platform that day" — which is not a traceback, it is an export of
 * every tenant's ledger to whoever holds one platform permission.
 */
export class ComplianceTracebackUnboundedException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.BAD_REQUEST,
				code: "COMPLIANCE_TRACEBACK_UNBOUNDED",
				message:
					"A traceback must name at least one of calledNumber or callingNumber. A window alone is not a traceback.",
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

/**
 * A tax id was submitted on a deployment with no `PLATFORM_SECRET_ENCRYPTION_KEY`.
 *
 * 501 and never a fallback to plaintext. The column is encrypted at rest precisely because a tax
 * id is the one field in the KYC file that identifies a real legal person to a tax authority, and
 * a deployment that has not configured the envelope key must be told so rather than quietly storing
 * it in the clear — which is the failure nobody discovers until the database is copied somewhere.
 * Mirrors `CdrSigningUnavailableException`: a missing key disables a feature, it never downgrades one.
 */
export class ComplianceSecretKeyMissingException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.NOT_IMPLEMENTED,
				code: "COMPLIANCE_SECRET_KEY_MISSING",
				message:
					"A tax id cannot be stored on this deployment: PLATFORM_SECRET_ENCRYPTION_KEY is not configured. Omit taxId, or configure the key.",
			},
			HttpStatus.NOT_IMPLEMENTED,
		);
	}
}
