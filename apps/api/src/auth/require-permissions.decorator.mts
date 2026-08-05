import { SetMetadata } from "@nestjs/common";
import type { Permission } from "@optimiq-voice/auth";

export const REQUIRE_PERMISSIONS_METADATA = "optimiq-voice:require-permissions";

/**
 * Declares the permissions a handler requires.
 *
 * - absent          — the guard lets the request through (routes are not implicitly protected)
 * - `()`            — an authenticated session is required, no permission check
 * - `(…permissions)` — an authenticated session with an active organization that grants all of them
 *
 * Permissions come from `PERMISSIONS` in `@optimiq-voice/auth`, so a typo is a compile error.
 */
export const RequirePermissions = (...permissions: readonly Permission[]) =>
	SetMetadata<string, readonly Permission[]>(REQUIRE_PERMISSIONS_METADATA, permissions);
