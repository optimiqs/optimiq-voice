import {
	type Auth,
	type AuthEmailDelivery,
	createAuth,
	type SsoProviderConfig,
} from "@optimiq-voice/auth";
import {
	createDatabaseClient,
	type DatabaseClient,
	listEnabledSsoProviders,
	type SsoProviderRow,
} from "@optimiq-voice/db";
import { getLogger } from "@optimiq-voice/logging";
import { type AuthSliceConfig, resolveAuthSliceConfig } from "./auth.config";
import { type AuthRepository, createAuthRepository } from "./auth.repository";

const logger = getLogger("api.auth");

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

/**
 * Composes the runtime.
 *
 * `email` is a REQUIRED parameter rather than something this function builds, and that is the
 * point of the change that introduced it: delivery used to be a log-only stub constructed here,
 * which meant nothing outside this file could see whether messages were being sent. It is now the
 * `Mailer` that `MailModule` owns, injected by `auth.module.ts`, so the transport has one owner
 * with one lifecycle and this function has no opinion about SMTP at all.
 */
export async function createAuthPlatform(
	email: AuthEmailDelivery,
	config: AuthSliceConfig = resolveAuthSliceConfig(),
): Promise<AuthPlatform> {
	const database = createDatabaseClient({
		url: config.databaseUrl,
		applicationName: "optimiq-voice-api",
		maxConnections: config.maxConnections,
	});

	let instance: Auth | undefined;
	const repository = createAuthRepository(() => instance);

	// The enabled SSO providers, read once at boot: `genericOAuth`'s config is fixed at construction,
	// so this snapshot is what makes the callback and initiate routes live. Best-effort — a database
	// that is unreachable here is already fatal for the rest of the slice, but a query that fails for
	// a narrower reason must not stop the whole auth surface from booting over the one optional
	// feature, so it degrades to "no SSO" and says so.
	const ssoProviders = await loadSsoProviders(database);

	const auth = createAuth({
		database: database.adminDb,
		secret: config.secret,
		baseURL: config.baseURL,
		appURL: config.appURL,
		trustedOrigins: config.trustedOrigins,
		email,
		organizationRepository: repository,
		sessionExpiresInSeconds: config.sessionExpiresInSeconds,
		requireEmailVerification: config.requireEmailVerification,
		rateLimitEnabled: config.rateLimitEnabled,
		ssoProviders,
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

/**
 * Read the enabled SSO providers and shape them for `genericOAuth`.
 *
 * `scopes` is stored as a free-text list on the row (comma/space separated); it is split here so the
 * plugin receives the array it wants and an empty column falls back to the OIDC defaults in
 * `packages/auth`. A read failure is logged and treated as "no providers" rather than propagated:
 * the SSO feed is one optional feature and must not be the thing that stops the auth slice booting.
 */
async function loadSsoProviders(database: DatabaseClient): Promise<readonly SsoProviderConfig[]> {
	let rows: readonly SsoProviderRow[];
	try {
		rows = await listEnabledSsoProviders(database.adminDb);
	} catch (error) {
		logger.error(
			{ err: error },
			"could not read SSO providers at boot; sign-in via SSO is disabled",
		);
		return [];
	}
	return rows.map((row) => ({
		providerId: row.providerId,
		clientId: row.clientId,
		clientSecret: row.clientSecret,
		issuer: row.issuer,
		...(row.discoveryUrl === null ? {} : { discoveryUrl: row.discoveryUrl }),
		...(row.scopes === null || row.scopes.trim().length === 0
			? {}
			: { scopes: row.scopes.split(/[,\s]+/u).filter((scope) => scope.length > 0) }),
	}));
}
