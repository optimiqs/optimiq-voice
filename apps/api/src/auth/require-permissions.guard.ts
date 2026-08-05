import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { hasPermission, type Permission } from "@optimiq-voice/auth";
import { getSession, setSessionOnRequest, withResolvedAccess } from "./app-session";
import {
	MissingPermissionException,
	NoActiveOrganizationException,
	UnauthenticatedRequestException,
} from "./auth.errors";
import { AuthService } from "./auth.service";
import { REQUIRE_PERMISSIONS_METADATA } from "./require-permissions.decorator";

/**
 * Opt-in authorization guard for `@RequirePermissions(...)`.
 *
 * It is NOT registered globally: the gRPC surface still authenticates through
 * `createAuthInterceptor`, and the two paths coexist until identity-removal Step 3. Apply it per
 * controller with `@UseGuards(RequirePermissionsGuard)`.
 *
 * Guard-then-execute order: session → active organization → permission. Each failure has its own
 * exception so the client can tell "sign in" from "pick an organization" from "not allowed".
 */
@Injectable()
export class RequirePermissionsGuard implements CanActivate {
	constructor(
		@Inject(Reflector) private readonly reflector: Reflector,
		@Inject(AuthService) private readonly authService: AuthService,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const required = this.reflector.getAllAndOverride<readonly Permission[] | undefined>(
			REQUIRE_PERMISSIONS_METADATA,
			[context.getHandler(), context.getClass()],
		);
		if (required === undefined) {
			return true;
		}

		const request = context.switchToHttp().getRequest<unknown>();
		const session = getSession(request);
		if (!session) {
			throw new UnauthenticatedRequestException();
		}
		if (required.length === 0) {
			return true;
		}

		const access = await this.authService.resolveAccess(session);
		if (!access.organizationId || !access.role) {
			throw new NoActiveOrganizationException();
		}
		setSessionOnRequest(request, withResolvedAccess(session, access.role, access.permissions));

		const missing = required.filter((permission) => !hasPermission(access.permissions, permission));
		if (missing.length > 0) {
			throw new MissingPermissionException(missing);
		}
		return true;
	}
}
