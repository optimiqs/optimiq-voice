import { SetMetadata } from "@nestjs/common";

export const PUBLIC_ROUTE_METADATA = "optimiq-voice:public-route";

/**
 * Opts a route out of the global session guard.
 *
 * `RequirePermissionsGuard` is registered as an `APP_GUARD` (identity-removal Step 3), so every
 * HTTP route in `apps/api` requires an authenticated session unless it carries this decorator.
 * Marking a route public is a security decision: state WHY in a comment at the call site.
 *
 * The three routes better-auth itself serves under `/api/auth/*` are not affected — they are raw
 * Fastify routes registered outside Nest's router and never reach a guard.
 */
export const PublicRoute = () => SetMetadata<string, true>(PUBLIC_ROUTE_METADATA, true);
