export {
	APP_SESSION_REQUEST_KEY,
	getSession,
	type RawAuthSession,
	setSessionOnRequest,
	toAppSession,
	withResolvedAccess,
} from "./app-session.mjs";
export {
	AUTH_ROUTE_PREFIX,
	type AuthHttpServer,
	registerAuthHttp,
	registerAuthRoutes,
	registerSessionHook,
} from "./auth-http.plugin.mjs";
export {
	AuthConfigurationFailure,
	type AuthSliceConfig,
	isAuthSliceConfigured,
	resolveAuthSliceConfig,
} from "./auth.config.mjs";
export {
	MissingPermissionException,
	NoActiveOrganizationException,
	UnauthenticatedRequestException,
} from "./auth.errors.mjs";
export { AuthModule } from "./auth.module.mjs";
export { type AuthPlatform, createAuthPlatform } from "./auth.platform.mjs";
export {
	type AuthRepository,
	AuthRepositoryNotReadyFailure,
	createAuthRepository,
	type OrganizationMemberSummary,
	type OrganizationRecord,
} from "./auth.repository.mjs";
export {
	AuthService,
	type OrganizationView,
	type ResolvedAccess,
	type SessionOverview,
} from "./auth.service.mjs";
export { AUTH_PLATFORM, AUTH_REPOSITORY } from "./auth.tokens.mjs";
export { MeController } from "./me.controller.mjs";
export { OrganizationsController } from "./organizations.controller.mjs";
export {
	REQUIRE_PERMISSIONS_METADATA,
	RequirePermissions,
} from "./require-permissions.decorator.mjs";
export { RequirePermissionsGuard } from "./require-permissions.guard.mjs";
export { resolveRolePermissions, resolveRoleTemplate } from "./role-permissions.mjs";
export { OptionalSession, Session } from "./session.decorator.mjs";
