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
import { PUBLIC_ROUTE_METADATA } from "./public-route.decorator";
import { REQUIRE_PERMISSIONS_METADATA } from "./require-permissions.decorator";

/**
 * The global session and authorization guard (identity-removal Step 3).
 *
 * Registered once as an `APP_GUARD` by `AuthModule`, so it covers every Nest HTTP route in
 * `apps/api` — including routes added later, which is the whole point. It is now the ONLY
 * authorization path in this process: the gRPC interceptor it replaced, the `accessKeyId →
 * organization.id` ledger that translated for it, and the legacy access-key repository that read
 * that ledger are all deleted.
 *
 * Organizations are resolved purely from the live better-auth tables. `AuthService.resolveAccess`
 * reads `session.activeOrganizationId` and the caller's `member` row, and derives permissions from
 * the role recorded there — there is no fallback lookup, no pre-migration `WO…` key path, and
 * nothing to consult when a session has no active organization except to refuse with
 * `NoActiveOrganizationException`.
 *
 * **Deny by default.** A route with no metadata at all requires an authenticated session. Opting
 * out is explicit and auditable via `@PublicRoute()`.
 *
 * Guard-then-execute order: public → session → active organization → permission. Each failure has
 * its own exception so a client can tell "sign in" from "pick an organization" from "not allowed".
 *
 * The caller was resolved once per request by the Fastify `preHandler` hook in
 * `auth-http.plugin.ts` (`auth.api.getSession`, which accepts the session cookie, the bearer
 * plugin's `Authorization: Bearer <token>` and the API-key header). This guard never touches a
 * header itself.
 */
@Injectable()
export class RequirePermissionsGuard implements CanActivate {
	constructor(
		@Inject(Reflector) private readonly reflector: Reflector,
		@Inject(AuthService) private readonly authService: AuthService,
	) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		if (
			this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE_METADATA, [
				context.getHandler(),
				context.getClass(),
			]) === true
		) {
			return true;
		}

		// Absent metadata means "authenticated, no permission required" — the deny-by-default half
		// of the contract. `@RequirePermissions()` with no arguments says the same thing explicitly.
		const required =
			this.reflector.getAllAndOverride<readonly Permission[] | undefined>(
				REQUIRE_PERMISSIONS_METADATA,
				[context.getHandler(), context.getClass()],
			) ?? [];

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
