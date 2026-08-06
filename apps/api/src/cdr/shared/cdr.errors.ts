import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * The CDR area's HTTP failure taxonomy.
 *
 * Same contract as the PBX area's (`pbx.errors.ts`): a machine-readable `code` a client can switch
 * on, plus whatever context makes the failure actionable. The area is read-only, so it is a much
 * smaller taxonomy — there is no write to roll back, no destination to dangle and no delete to
 * refuse.
 *
 * ```jsonc
 * { "statusCode": 400, "code": "CDR_INVALID_QUERY",   "message": "…", "issues": [ … ] }
 * { "statusCode": 400, "code": "CDR_INVALID_CURSOR",  "message": "…" }
 * { "statusCode": 400, "code": "CDR_RANGE_TOO_WIDE",  "message": "…", "maxDays": 92 }
 * { "statusCode": 404, "code": "CDR_NOT_FOUND",       "message": "…", "kind": "call-leg", "id": "…" }
 * { "statusCode": 403, "code": "CDR_LINK_INVALID",    "message": "…" }
 * { "statusCode": 410, "code": "CDR_LINK_EXPIRED",    "message": "…" }
 * { "statusCode": 501, "code": "CDR_SIGNING_UNAVAILABLE", "message": "…" }
 * ```
 */

export class CdrNotFoundException extends HttpException {
	constructor(kind: string, id: string) {
		super(
			{
				statusCode: HttpStatus.NOT_FOUND,
				code: "CDR_NOT_FOUND",
				message: `No ${kind} with id ${id} in this organization and time range.`,
				kind,
				id,
			},
			HttpStatus.NOT_FOUND,
		);
	}
}

/**
 * The requested window is wider than the reporting path will scan.
 *
 * A ledger partitioned by month answers "last 24 hours" by touching one partition and "last three
 * years" by touching thirty-six. The cap is not a policy about how much history a tenant may have —
 * retention decides that — it is a promise that one request cannot turn into a table scan of the
 * whole billing history. Exports that genuinely need years are a different, asynchronous surface.
 */
export class CdrRangeTooWideException extends HttpException {
	constructor(maxDays: number, requestedDays: number) {
		super(
			{
				statusCode: HttpStatus.BAD_REQUEST,
				code: "CDR_RANGE_TOO_WIDE",
				message: `The requested range spans ${requestedDays} days; at most ${maxDays} may be queried at once. Narrow the range or page through it.`,
				maxDays,
				requestedDays,
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

/** A cursor that is not one of ours. Always a 400: a client cannot recover by retrying. */
export class CdrInvalidCursorException extends HttpException {
	constructor(detail: string) {
		super(
			{
				statusCode: HttpStatus.BAD_REQUEST,
				code: "CDR_INVALID_CURSOR",
				message: `The pagination cursor could not be read (${detail}). Start the listing again.`,
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}

/**
 * A download token that does not verify.
 *
 * 403 and NOT 404, deliberately and in both directions: a forged token and a token for a recording
 * that does not exist must be indistinguishable, or the difference between the two responses is an
 * oracle that tells an attacker which recording ids are real.
 */
export class CdrLinkInvalidException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.FORBIDDEN,
				code: "CDR_LINK_INVALID",
				message: "This download link is not valid.",
			},
			HttpStatus.FORBIDDEN,
		);
	}
}

/**
 * A download token that verified but has aged out.
 *
 * Distinguished from `CDR_LINK_INVALID` on purpose, and it costs nothing: the signature was
 * checked BEFORE the expiry, so saying "expired" only ever tells someone who already held a valid
 * token something they could have worked out from the timestamp inside it. The UI needs the
 * difference to offer "get a new link" instead of "this is broken".
 */
export class CdrLinkExpiredException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.GONE,
				code: "CDR_LINK_EXPIRED",
				message: "This download link has expired. Request a new one.",
			},
			HttpStatus.GONE,
		);
	}
}

/** No signing key is configured, so no download URL can be minted. Never a fallback to unsigned. */
export class CdrSigningUnavailableException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.NOT_IMPLEMENTED,
				code: "CDR_SIGNING_UNAVAILABLE",
				message:
					"Recording downloads are not configured on this deployment (CDR_RECORDING_URL_SECRET is not set).",
			},
			HttpStatus.NOT_IMPLEMENTED,
		);
	}
}

/** The metadata row exists but the object behind it does not. A tombstone, or a purged object. */
export class CdrMediaGoneException extends HttpException {
	constructor() {
		super(
			{
				statusCode: HttpStatus.GONE,
				code: "CDR_MEDIA_GONE",
				message: "The recording metadata exists but its media has been deleted.",
			},
			HttpStatus.GONE,
		);
	}
}
