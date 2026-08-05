export {
	APP_SESSION_REQUEST_KEY,
	getSession,
	type RawAuthSession,
	setSessionOnRequest,
	toAppSession,
	withResolvedAccess,
} from "./app-session";
export {
	API_KEY_HEADER,
	API_KEY_MEMBERSHIP_ROLE,
	API_KEY_PRINCIPAL_ROLE,
	AUTH_ROUTE_PREFIX,
	type AuthHttpServer,
	createApiKeySessionResolver,
	registerAuthHttp,
	registerAuthRoutes,
	registerSessionHook,
} from "./auth-http.plugin";
export {
	AuthRuntimeUnavailableError,
	type AuthRuntimeHandle,
	clearAuthRuntime,
	getAuthRuntime,
	publishAuthRuntime,
	requireAuthRuntime,
} from "./auth-platform.registry";
export {
	AuthConfigurationFailure,
	type AuthSliceConfig,
	isAuthSliceConfigured,
	resolveAuthSliceConfig,
} from "./auth.config";
export {
	MissingPermissionException,
	NoActiveOrganizationException,
	UnauthenticatedRequestException,
} from "./auth.errors";
export { AuthModule } from "./auth.module";
export { type AuthPlatform, createAuthPlatform } from "./auth.platform";
export {
	type AuthRepository,
	AuthRepositoryNotReadyFailure,
	createAuthRepository,
	type OrganizationMemberSummary,
	type OrganizationRecord,
} from "./auth.repository";
export {
	AuthService,
	type OrganizationView,
	type ResolvedAccess,
	type SessionOverview,
} from "./auth.service";
export { AUTH_LEGACY_ACCESS_KEYS, AUTH_PLATFORM, AUTH_REPOSITORY } from "./auth.tokens";
export {
	createLegacyAccessKeyRepository,
	type LegacyAccessKeyRepository,
	UnmappedAccessKeyError,
} from "./legacy-access-key.repository";
export {
	buildCallAccessTokenClaims,
	CALL_TOKEN_AUDIENCE,
	CALL_TOKEN_EXPIRES_IN,
	CALL_TOKEN_ROLE,
	type CallAccessTokenClaims,
	type CallAccessTokenRequest,
	CallAccessTokenScopeError,
} from "./call-token.claims";
export { CallTokenService, createCallAccessTokenMinter } from "./call-token.service";
export { MeController } from "./me.controller";
export { OrganizationsController } from "./organizations.controller";
export { PUBLIC_ROUTE_METADATA, PublicRoute } from "./public-route.decorator";
export { REQUIRE_PERMISSIONS_METADATA, RequirePermissions } from "./require-permissions.decorator";
export { RequirePermissionsGuard } from "./require-permissions.guard";
export { resolveRolePermissions, resolveRoleTemplate } from "./role-permissions";
export { OptionalSession, Session } from "./session.decorator";
