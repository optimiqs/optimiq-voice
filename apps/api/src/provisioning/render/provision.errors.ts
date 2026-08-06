import {
	HttpException,
	HttpStatus,
	NotFoundException,
	ServiceUnavailableException,
} from "@nestjs/common";
import { missingRenderConfiguration } from "../provisioning-env";
import type { ProvisioningEnv } from "../provisioning-env";

/**
 * The provisioning area's failure taxonomy — and specifically, the one it deliberately does NOT
 * have.
 *
 * ## Every rejection at the render endpoint is the same 404
 *
 * A phone that presents an unknown token, a revoked token, a token for a disabled device, a token
 * for a device whose organization was suspended, or a token from an address the organization's ACL
 * refuses gets **the same body with the same status**. That is not laziness; it is the whole point.
 *
 * Distinguishing them would turn the endpoint into an oracle. "Unknown token" versus "this token is
 * real but the device is disabled" tells an attacker which of their guesses hit a live row, which
 * is exactly the signal that makes a token space worth walking. Worse, "disabled" would confirm
 * that a specific MAC address is enrolled at a specific deployment — a fact useful to somebody
 * standing in a lobby with a laptop.
 *
 * So the endpoint has one refusal and it says nothing. The *reason* is recorded in two places
 * neither the phone nor an attacker can read: the log line, and the `device.rejected` event on
 * `provision.evt.v1.<orgId>` — which is where anti-fraud counts them and where an administrator's
 * "why is this phone not provisioning?" is actually answered.
 *
 * The rate-limit refusal is the single exception, and it is a 429 rather than a 404 because it has
 * to be: a phone in a boot loop has to be told to back off, and `Retry-After` is the only way HTTP
 * says that. It leaks that the token was resolvable, which is why the limiter is only consulted
 * AFTER the token has already been verified — an attacker who can trip it is an attacker who
 * already holds a valid token, and their problem is not information disclosure.
 */

/** Why a request was refused, for the event and the log. NEVER for the response body. */
export const PROVISION_REJECT_REASONS = [
	"unknown-mac",
	"invalid-token",
	"missing-token",
	"unknown-vendor",
	"template-missing",
	"rate-limited",
	"disabled",
	"ip-not-allowed",
	"not-configured",
] as const;

export type ProvisionRejectReason = (typeof PROVISION_REJECT_REASONS)[number];

/**
 * The one refusal.
 *
 * Carries the reason as a non-enumerable property so the controller can publish it and the log can
 * record it, while `JSON.stringify` of the HTTP body cannot reach it.
 */
export class ProvisionRefusedException extends NotFoundException {
	readonly reason: ProvisionRejectReason;
	readonly detail: string | undefined;
	/** Known when the token resolved far enough to name a tenant; absent otherwise. */
	readonly organizationId: string | undefined;
	readonly deviceId: string | undefined;
	readonly macAddress: string | undefined;

	constructor(input: {
		readonly reason: ProvisionRejectReason;
		readonly detail?: string;
		readonly organizationId?: string;
		readonly deviceId?: string;
		readonly macAddress?: string;
	}) {
		super({
			statusCode: HttpStatus.NOT_FOUND,
			code: "PROVISION_NOT_FOUND",
			// One sentence, identical for every reason. It is addressed to the human reading a phone's
			// web console, not to the phone, which discards it.
			message: "No configuration is available for this URL.",
		});
		this.reason = input.reason;
		this.detail = input.detail;
		this.organizationId = input.organizationId;
		this.deviceId = input.deviceId;
		this.macAddress = input.macAddress;
	}
}

/** The one exception to the one refusal. */
export class ProvisionRateLimitedException extends HttpException {
	readonly reason: ProvisionRejectReason = "rate-limited";

	constructor(
		readonly retryAfterSeconds: number,
		readonly organizationId: string,
		readonly deviceId: string,
	) {
		super(
			{
				statusCode: HttpStatus.TOO_MANY_REQUESTS,
				code: "PROVISION_RATE_LIMITED",
				message: "Too many configuration requests for this device. Try again shortly.",
			},
			HttpStatus.TOO_MANY_REQUESTS,
		);
	}
}

/**
 * The deployment has not been told where phones register or what to derive their passwords from.
 *
 * A 503 rather than a 404, and the one place the provisioning surface is deliberately talkative:
 * this is not a phone's request failing, it is an operator's configuration missing, and the body
 * names the variables so the person who can fix it can. It is reachable only by an authenticated
 * administrator (the mint endpoint) or by a phone whose token already verified — never by an
 * anonymous probe, because the checks run in that order.
 */
export class ProvisioningNotConfiguredException extends ServiceUnavailableException {
	constructor(missing: readonly string[]) {
		super({
			statusCode: HttpStatus.SERVICE_UNAVAILABLE,
			code: "PROVISION_NOT_CONFIGURED",
			message:
				"This deployment cannot render device configurations yet: " +
				`${missing.join(" and ")} must be set on the API.`,
			missing,
		});
	}

	static assert(env: ProvisioningEnv): void {
		const missing = missingRenderConfiguration(env);
		if (missing.length > 0) {
			throw new ProvisioningNotConfiguredException(missing);
		}
	}
}
