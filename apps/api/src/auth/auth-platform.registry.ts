import type { AuthPlatform } from "./auth.platform";

/**
 * A process-global handle on the auth platform, for the parts of `apps/api` that Nest does not
 * construct.
 *
 * It exists for code started outside the Nest container, which cannot inject `AUTH_PLATFORM` and
 * must not construct a second one: a second `AuthPlatform` means a second PostgreSQL pool and a
 * second JWKS cache against the same database. A single, explicitly-named registry that
 * `AuthModule` publishes is the smallest seam that keeps one pool and stays greppable.
 *
 * It fails **closed**: `requireAuthRuntime()` throws when the slice is not mounted, so an
 * environment without `DATABASE_URL` / `AUTH_SECRET` / `AUTH_URL` cannot silently fall back to an
 * unauthenticated call path.
 */

export interface AuthRuntimeHandle {
	readonly platform: AuthPlatform;
}

let current: AuthRuntimeHandle | undefined;

export function publishAuthRuntime(handle: AuthRuntimeHandle): void {
	current = handle;
}

export function clearAuthRuntime(): void {
	current = undefined;
}

/** The handle, or `undefined` when the auth slice is not mounted in this process. */
export function getAuthRuntime(): AuthRuntimeHandle | undefined {
	return current;
}

/** Raised when a code path that requires better-auth runs in a process that did not mount it. */
export class AuthRuntimeUnavailableError extends Error {
	readonly _tag = "AuthRuntimeUnavailableError" as const;

	constructor(consumer: string) {
		super(
			`${consumer} requires the better-auth slice, which is not mounted in this process. ` +
				"Set DATABASE_URL, AUTH_SECRET and AUTH_URL.",
		);
		this.name = "AuthRuntimeUnavailableError";
	}
}

export function requireAuthRuntime(consumer: string): AuthRuntimeHandle {
	if (!current) {
		throw new AuthRuntimeUnavailableError(consumer);
	}
	return current;
}
