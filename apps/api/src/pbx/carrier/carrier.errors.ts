import {
	BadGatewayException,
	ForbiddenException,
	HttpException,
	HttpStatus,
	ServiceUnavailableException,
	UnprocessableEntityException,
} from "@nestjs/common";
import { TelnyxApiError, TelnyxTransportError } from "@optimiq-voice/telnyx";

/**
 * The carrier area's HTTP errors.
 *
 * These are Nest exceptions rather than `Schema.TaggedErrorClass` failures, and the reason is
 * structural: the PBX failures exist to cross the Effect seam, which is where a repository's typed
 * failure becomes a response. The carrier service is not below that seam — its "repository" is an
 * HTTP client that already throws typed errors, and its database work is delegated to the slice
 * services, which run their own `runEffect` and produce their own exceptions. Inventing a second
 * Effect boundary here would add a layer whose only job is to re-wrap an error that is already
 * typed.
 *
 * They keep the PBX body contract exactly — `{ statusCode, code, message, … }` — because
 * `apps/web` switches on `code` and must not care which layer produced the failure.
 *
 * ```jsonc
 * // 503 — no carrier configured on this deployment
 * { "statusCode": 503, "code": "CARRIER_NOT_CONFIGURED", "message": "…" }
 * // 502 — the carrier answered, badly
 * { "statusCode": 502, "code": "CARRIER_REQUEST_FAILED", "message": "…",
 *   "carrierStatus": 422, "carrierErrors": [{ "code": "85001", "title": "…", "detail": "…" }] }
 * // 422 — the carrier refused for a reason the caller can act on
 * { "statusCode": 422, "code": "CARRIER_REJECTED", "message": "…", "carrierErrors": [ … ] }
 * // 403 — a webhook that did not prove it came from the carrier
 * { "statusCode": 403, "code": "CARRIER_SIGNATURE_INVALID", "message": "…" }
 * ```
 */

/**
 * No `TELNYX_API_KEY` on this deployment.
 *
 * 503 rather than 404 or 501 deliberately. 404 would say the feature does not exist, which is
 * wrong and sends an admin looking for a version to upgrade to. 501 would say it is not
 * implemented, which is also wrong. 503 says exactly what is true — the capability exists and is
 * currently unavailable — and the `code` gives the UI something to render as a "connect a carrier"
 * callout rather than as a crash.
 */
export class CarrierNotConfiguredException extends ServiceUnavailableException {
	constructor(capability = "Carrier operations") {
		super({
			statusCode: HttpStatus.SERVICE_UNAVAILABLE,
			code: "CARRIER_NOT_CONFIGURED",
			message: `${capability} are unavailable: this deployment has no carrier configured. Set TELNYX_API_KEY to enable number ordering and trunk provisioning.`,
		});
	}
}

/** No webhook public key, so a delivery cannot be verified — and must therefore not be accepted. */
export class CarrierWebhookNotConfiguredException extends ServiceUnavailableException {
	constructor() {
		super({
			statusCode: HttpStatus.SERVICE_UNAVAILABLE,
			code: "CARRIER_WEBHOOK_NOT_CONFIGURED",
			message:
				"Carrier webhooks are not accepted: this deployment has no TELNYX_PUBLIC_KEY, so a delivery's signature cannot be verified.",
		});
	}
}

export class CarrierSignatureInvalidException extends ForbiddenException {
	constructor(reason: string) {
		super({
			statusCode: HttpStatus.FORBIDDEN,
			code: "CARRIER_SIGNATURE_INVALID",
			message: `The webhook signature could not be verified (${reason}).`,
		});
	}
}

/** Carrier error codes a tenant can do something about, and which are therefore not our fault. */
const ACTIONABLE_CARRIER_CODES = new Set([
	// The number went to someone else between the search and the order.
	"85001",
	// The number was never searched — a client-sequencing error, surfaced so it is fixable.
	"85000",
	// Already reserved.
	"85006",
	"85007",
	"85008",
	// Channel limits.
	"90042",
	"90043",
]);

/**
 * Turns a `TelnyxApiError` into the right HTTP answer.
 *
 * The split matters more than it looks. "The number you picked was just sold to someone else" is a
 * 422 the user fixes by picking another number; "our platform's API key is wrong" is a 502 no
 * tenant can act on and an operator must see. Collapsing both into 500 would train everyone to
 * ignore the alert that matters.
 *
 * Authentication and funding failures never expose their detail to a tenant: `10009` means the
 * platform's credential is broken, and `20100` means the platform's account is out of money.
 * Neither is a tenant's business, and both are logged in full on the way past.
 */
export function toCarrierException(error: unknown, operation: string): HttpException {
	if (error instanceof TelnyxApiError) {
		if (error.isAuthentication || error.hasCode("20012") || error.hasCode("20100")) {
			return new BadGatewayException({
				statusCode: HttpStatus.BAD_GATEWAY,
				code: "CARRIER_REQUEST_FAILED",
				message: `The carrier refused ${operation}. This is a platform configuration or account problem; the operator has been notified.`,
				carrierStatus: error.status,
			});
		}
		const actionable = error.errors.some((entry) => ACTIONABLE_CARRIER_CODES.has(entry.code));
		if (actionable) {
			return new UnprocessableEntityException({
				statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
				code: "CARRIER_REJECTED",
				message: `The carrier refused ${operation}: ${error.errors
					.map((entry) => entry.title)
					.join("; ")}`,
				carrierErrors: error.errors.map((entry) => ({
					code: entry.code,
					title: entry.title,
					...(entry.detail === undefined ? {} : { detail: entry.detail }),
				})),
			});
		}
		return new BadGatewayException({
			statusCode: HttpStatus.BAD_GATEWAY,
			code: "CARRIER_REQUEST_FAILED",
			message: `The carrier refused ${operation} with status ${error.status}.`,
			carrierStatus: error.status,
			carrierErrors: error.errors.map((entry) => ({ code: entry.code, title: entry.title })),
		});
	}

	if (error instanceof TelnyxTransportError) {
		return new BadGatewayException({
			statusCode: HttpStatus.BAD_GATEWAY,
			code: "CARRIER_UNREACHABLE",
			message: `The carrier could not be reached while attempting ${operation}. Nothing was changed here; check the carrier's status before retrying.`,
		});
	}

	if (error instanceof HttpException) {
		return error;
	}

	return new BadGatewayException({
		statusCode: HttpStatus.BAD_GATEWAY,
		code: "CARRIER_REQUEST_FAILED",
		message: `An unexpected error occurred while attempting ${operation}.`,
	});
}
