import { type Auth, createAuth } from "@optimiq-voice/auth";
import { createDatabaseClient, type DatabaseClient } from "@optimiq-voice/db";
import { createLoggingEmailDelivery } from "./auth-email.delivery";
import { type AuthSliceConfig, resolveAuthSliceConfig } from "./auth.config";
import { type AuthRepository, createAuthRepository } from "./auth.repository";

/**
 * The composed better-auth runtime: the database client it owns, the instance itself and the
 * repository the rest of the slice reads through.
 *
 * The Drizzle handle comes from `@optimiq-voice/db`'s `createDatabaseClient` (a postgres-js pool
 * against `DATABASE_URL`) rather than a locally constructed one, so the connection budget,
 * statement timeouts and `application_name` match every other process in the platform.
 */
export interface AuthPlatform {
	readonly auth: Auth;
	readonly config: AuthSliceConfig;
	readonly repository: AuthRepository;
	readonly database: DatabaseClient;
	readonly close: () => Promise<void>;
}

export function createAuthPlatform(
	config: AuthSliceConfig = resolveAuthSliceConfig(),
): AuthPlatform {
	const database = createDatabaseClient({
		url: config.databaseUrl,
		applicationName: "optimiq-voice-api",
		maxConnections: config.maxConnections,
	});

	let instance: Auth | undefined;
	const repository = createAuthRepository(() => instance);

	const auth = createAuth({
		database: database.adminDb,
		secret: config.secret,
		baseURL: config.baseURL,
		appURL: config.appURL,
		trustedOrigins: config.trustedOrigins,
		email: createLoggingEmailDelivery(),
		organizationRepository: repository,
		sessionExpiresInSeconds: config.sessionExpiresInSeconds,
		requireEmailVerification: config.requireEmailVerification,
		rateLimitEnabled: config.rateLimitEnabled,
		cookies: {
			...(config.cookieSameSite === undefined ? {} : { sameSite: config.cookieSameSite }),
			...(config.cookieDomain === undefined ? {} : { crossSubDomain: config.cookieDomain }),
		},
	});
	instance = auth;

	return {
		auth,
		config,
		repository,
		database,
		close: async () => {
			await database.close();
		},
	};
}
