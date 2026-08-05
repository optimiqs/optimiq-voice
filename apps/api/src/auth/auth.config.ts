import { env } from "@optimiq-voice/config";

/**
 * Boot configuration for the better-auth slice.
 *
 * Every value comes from `@optimiq-voice/config`; this file adds no environment parsing of its
 * own and never reads `process.env`. The canonical names are `DATABASE_URL`, `AUTH_SECRET` and
 * `AUTH_URL` (the config package's name for what the cutover plan calls `AUTH_BASE_URL`).
 */

/** Raised at boot when the auth slice is enabled without the environment it requires. */
export class AuthConfigurationFailure extends Error {
	readonly _tag = "AuthConfigurationFailure" as const;
	readonly missing: readonly string[];

	constructor(missing: readonly string[]) {
		super(
			`The better-auth slice cannot start: ${missing.join(", ")} must be set. ` +
				"Set them in the root .env or disable the slice.",
		);
		this.name = "AuthConfigurationFailure";
		this.missing = missing;
	}
}

export interface AuthSliceConfig {
	readonly databaseUrl: string;
	readonly secret: string;
	/** Public origin better-auth signs cookies and builds callback URLs against. */
	readonly baseURL: string;
	/** Where invitation and password-reset links point (the web app, not the API). */
	readonly appURL: string;
	readonly trustedOrigins: readonly string[];
	readonly cookieDomain: string | undefined;
	readonly cookieSameSite: "strict" | "lax" | "none" | undefined;
	readonly sessionExpiresInSeconds: number;
	/**
	 * Email delivery is a console stub until the SMTP helpers are ported, so requiring
	 * verification outside production would lock every developer out of their own sign-up.
	 */
	readonly requireEmailVerification: boolean;
	readonly rateLimitEnabled: boolean;
	readonly maxConnections: number;
}

/** True when the environment carries enough configuration to mount better-auth. */
export function isAuthSliceConfigured(): boolean {
	return Boolean(env.DATABASE_URL && env.AUTH_SECRET && env.AUTH_URL);
}

export function resolveAuthSliceConfig(): AuthSliceConfig {
	const missing: string[] = [];
	if (!env.DATABASE_URL) missing.push("DATABASE_URL");
	if (!env.AUTH_SECRET) missing.push("AUTH_SECRET");
	if (!env.AUTH_URL) missing.push("AUTH_URL");
	if (missing.length > 0) {
		throw new AuthConfigurationFailure(missing);
	}

	const baseURL = env.AUTH_URL as string;
	const appURL = env.API_APP_URL ?? baseURL;
	const isProduction = env.NODE_ENV === "production";

	return {
		databaseUrl: env.DATABASE_URL as string,
		secret: env.AUTH_SECRET as string,
		baseURL,
		appURL,
		trustedOrigins: [...new Set([baseURL, appURL])],
		cookieDomain: env.AUTH_COOKIE_DOMAIN,
		cookieSameSite: env.AUTH_COOKIE_SAMESITE,
		sessionExpiresInSeconds: env.AUTH_SESSION_TTL_SECONDS,
		requireEmailVerification: isProduction,
		rateLimitEnabled: isProduction,
		maxConnections: 10,
	};
}
