import type { AuthPlatform } from "./auth.platform";
import type { LegacyAccessKeyRepository } from "./legacy-access-key.repository";

/**
 * A process-global handle on the auth platform, for the parts of `apps/api` that Nest does not
 * construct.
 *
 * `RuntimeHostService` starts the legacy runtime (`src/runtime/app-runtime.ts`) from
 * `onApplicationBootstrap`: the gRPC servers, the ARI dispatcher and the NATS subscription. None
 * of them are Nest providers, so none of them can inject `AUTH_PLATFORM` — yet the ARI dispatcher
 * is exactly where identity-removal Step 4 item 4 has to mint a per-call token.
 *
 * The alternatives were worse. Constructing a second `AuthPlatform` inside the runtime would open
 * a second PostgreSQL pool and a second JWKS cache against the same database; rewriting the ARI
 * path into Nest providers is the P1 slice rewrite, not a step of this cutover. A single,
 * explicitly-named registry that `AuthModule` publishes and the runtime reads is the smallest
 * seam that keeps one pool and stays greppable — and it disappears when the voice path becomes a
 * feature slice.
 *
 * It fails **closed**: `requireAuthRuntime()` throws when the slice is not mounted, so an
 * environment without `DATABASE_URL` / `AUTH_SECRET` / `AUTH_URL` cannot silently fall back to an
 * unauthenticated call path. (It also cannot fall back to the identity signer — that path is
 * deleted.)
 */

export interface AuthRuntimeHandle {
	readonly platform: AuthPlatform;
	readonly legacyAccessKeys: LegacyAccessKeyRepository;
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
