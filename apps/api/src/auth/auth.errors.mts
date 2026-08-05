import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { Permission } from "@optimiq-voice/auth";

/**
 * HTTP-boundary failures for the auth slice.
 *
 * `…Exception` extends `HttpException` and is only ever thrown at or above the controller/guard
 * boundary; `…Failure` (see `auth.config.mts`, `auth.repository.mts`) stays inside the slice.
 */

export class UnauthenticatedRequestException extends UnauthorizedException {
	constructor() {
		super("An authenticated session is required.");
	}
}

export class NoActiveOrganizationException extends ForbiddenException {
	constructor() {
		super("The session has no active organization. Select an organization and retry.");
	}
}

export class MissingPermissionException extends ForbiddenException {
	constructor(missing: readonly Permission[]) {
		super(`Missing required permission(s): ${missing.join(", ")}.`);
	}
}
