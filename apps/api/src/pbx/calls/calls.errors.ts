import {
	BadRequestException,
	ConflictException,
	HttpException,
	HttpStatus,
	InternalServerErrorException,
	NotFoundException,
	NotImplementedException,
	ServiceUnavailableException,
	UnprocessableEntityException,
} from "@nestjs/common";
import type { OriginateRefusalReason } from "@optimiq-voice/events/schemas";

/**
 * How the engine's refusal vocabulary becomes an HTTP answer.
 *
 * The mapping is the whole reason the contract has a closed set of reasons rather than a free-text
 * error: a caller branches on a status and a `code`, and a dial button needs to tell "that extension
 * does not exist" (fix your configuration) apart from "that phone is not registered" (try again in a
 * minute) apart from "the platform is busy" (not your fault).
 *
 * The bodies follow this area's shape — `statusCode`, `code`, `message`, plus whatever names the
 * failure — so a client switches on the string and never on the status alone. See the header of
 * `shared/pbx.errors.ts`.
 */

/** Why each reason lands where it does. Kept beside the map so the argument travels with it. */
const STATUS_BY_REASON: Readonly<Record<OriginateRefusalReason, HttpStatus>> = {
	/** The engine could not parse what this API sent. That is our bug, not the caller's. */
	bad_request: HttpStatus.INTERNAL_SERVER_ERROR,
	/** No such extension in this tenant. The one refusal that is a 404 about a named thing. */
	unknown_extension: HttpStatus.NOT_FOUND,
	/**
	 * The extension exists and has no phone to ring. A 409 rather than a 404 or a 503: the request is
	 * well-formed and the platform is healthy — the CONFLICT is with the current state of the world,
	 * and it is the one refusal that is worth retrying without changing anything.
	 */
	extension_offline: HttpStatus.CONFLICT,
	/**
	 * The destination matches nothing this tenant may dial. A 422, alongside
	 * `PBX_INVALID_DESTINATION`: the body was syntactically fine and semantically unusable.
	 */
	invalid_target: HttpStatus.UNPROCESSABLE_ENTITY,
	capacity: HttpStatus.SERVICE_UNAVAILABLE,
	/** The engine's media driver cannot originate. A configuration fact, and a 501 says so. */
	not_supported: HttpStatus.NOT_IMPLEMENTED,
	shutting_down: HttpStatus.SERVICE_UNAVAILABLE,
	internal: HttpStatus.INTERNAL_SERVER_ERROR,
};

const MESSAGE_BY_REASON: Readonly<Record<OriginateRefusalReason, string>> = {
	bad_request: "The call engine refused the request.",
	unknown_extension: "No such extension in this organization.",
	extension_offline: "That extension has no registered device to ring.",
	invalid_target: "That destination is not reachable from this extension's dial plan.",
	capacity: "The platform has no capacity for another call right now.",
	not_supported: "This deployment's media driver cannot place calls.",
	shutting_down: "The call engine is restarting. Try again.",
	internal: "The call could not be placed.",
};

/** Builds the HTTP exception for one refusal. */
export function originateRefusalException(
	reason: OriginateRefusalReason,
	detail: string | undefined,
	context: { readonly from: string; readonly to: string; readonly instanceId?: string },
): HttpException {
	const status = STATUS_BY_REASON[reason];
	const body = {
		statusCode: status,
		code: "CALL_ORIGINATE_REFUSED",
		message: MESSAGE_BY_REASON[reason],
		reason,
		from: context.from,
		to: context.to,
		...(context.instanceId === undefined ? {} : { instanceId: context.instanceId }),
		/**
		 * The engine's own words, and they are SAFE to return: every producer of this string is one of
		 * our own processes describing its own refusal — an endpoint name, a plan miss, a driver name.
		 * It never carries another tenant's data, because the engine resolved everything against the
		 * organization this session already proved it belongs to.
		 */
		...(detail === undefined ? {} : { detail: detail.slice(0, 512) }),
	};

	switch (status) {
		case HttpStatus.NOT_FOUND:
			return new NotFoundException(body);
		case HttpStatus.CONFLICT:
			return new ConflictException(body);
		case HttpStatus.UNPROCESSABLE_ENTITY:
			return new UnprocessableEntityException(body);
		case HttpStatus.SERVICE_UNAVAILABLE:
			return new ServiceUnavailableException(body);
		case HttpStatus.NOT_IMPLEMENTED:
			return new NotImplementedException(body);
		case HttpStatus.BAD_REQUEST:
			return new BadRequestException(body);
		default:
			return new InternalServerErrorException(body);
	}
}

/**
 * Nobody answered `rpc.engine.v1.originate` at all.
 *
 * A 503 and NOT a 500, deliberately: a timeout or a "no responders" is a statement about the
 * deployment — no engine is running, or every engine is too busy to answer inside the contract's
 * five seconds — and both are conditions that resolve on their own. A 500 would tell an integrator
 * to open a ticket about a request that will succeed on its next attempt.
 */
export function originateUnavailableException(detail: string): HttpException {
	return new ServiceUnavailableException({
		statusCode: HttpStatus.SERVICE_UNAVAILABLE,
		code: "CALL_ENGINE_UNAVAILABLE",
		message: "No call engine answered. The call was not placed.",
		detail: detail.slice(0, 256),
	});
}

/** The per-organization rate limit on origination. */
export function originateRateLimitedException(retryAfterSeconds: number): HttpException {
	return new HttpException(
		{
			statusCode: HttpStatus.TOO_MANY_REQUESTS,
			code: "CALL_ORIGINATE_RATE_LIMITED",
			message: "Too many calls placed in the last minute.",
			retryAfterSeconds,
		},
		HttpStatus.TOO_MANY_REQUESTS,
	);
}
