import {
	type Auth,
	type AuthEmailDelivery,
	createAuth,
	type OrganizationCreatedEvent,
	type SsoProviderConfig,
} from "@optimiq-voice/auth";
import {
	createDatabaseClient,
	type DatabaseClient,
	listEnabledSsoProvidersWithSecrets,
	type SsoProviderSecretRow,
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
	/**
	 * The boot snapshot handed to `genericOAuth`, kept so the callback route can assert the tenant
	 * the session landed in is the one that owns the provider. Same array, not a re-read: an
	 * assertion made against a different set than the plugin was built from would be a check that
	 * disagrees with the thing it is checking.
	 */
	readonly ssoProviders: readonly SsoProviderConfig[];
	readonly close: () => Promise<void>;
}

type OrganizationCreatedHandler = (event: OrganizationCreatedEvent) => Promise<void>;

let organizationCreatedHandler: OrganizationCreatedHandler | undefined;

/**
 * Register what happens to a brand-new tenant, late.
 *
 * `AUTH_PLATFORM` is constructed by `AuthModule`, and everything that provisions a tenant lives in
 * `PbxModule`, which IMPORTS `AuthModule` — so the factory cannot inject the provisioner without
 * making the two modules circular. The handler is therefore set by the provisioner when Nest
 * initialises it (`PbxModule` is instantiated after its imports, so the platform already exists),
 * and `createAuth` is handed a closure that reads this slot at call time rather than a function
 * that has to exist at boot.
 *
 * Unset is a valid state and means "seed nothing": a process that mounts the auth slice without
 * the PBX slice still creates organizations, they simply arrive empty.
 */
export function setOrganizationCreatedHandler(handler: OrganizationCreatedHandler): void {
	organizationCreatedHandler = handler;
}

/** Test seam and shutdown hygiene — the slot is process-global, like the auth runtime registry. */
export function clearOrganizationCreatedHandler(): void {
	organizationCreatedHandler = undefined;
}

/**
 * Whatever is registered, or `undefined`.
 *
 * The closure handed to `createAuth` reads the slot through this, and so does a spec that wants to
 * invoke what a provider registered without standing up better-auth to deliver the call.
 */
export function getOrganizationCreatedHandler(): OrganizationCreatedHandler | undefined {
	return organizationCreatedHandler;
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
		onOrganizationCreated: async (event) => {
			await getOrganizationCreatedHandler()?.(event);
		},
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
		ssoProviders,
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
	let rows: readonly SsoProviderSecretRow[];
	try {
		rows = await listEnabledSsoProvidersWithSecrets(database.adminDb);
	} catch (error) {
		logger.error(
			{ err: error },
			"could not read SSO providers at boot; sign-in via SSO is disabled",
		);
		return [];
	}
	// A row with no email domain is DROPPED rather than registered. `createAuth` refuses one outright
	// — a provider that may assert any address is a cross-tenant takeover — and letting that throw
	// here would make one legacy row, written before the column was required, stop the auth slice
	// from booting at all.
	const usable = rows.filter((row) => {
		if (row.emailDomain === null || row.emailDomain.trim().length === 0) {
			logger.warn(
				{ providerId: row.providerId, organizationId: row.organizationId },
				"an SSO provider has no email domain and was not registered; set one to re-enable it",
			);
			return false;
		}
		return true;
	});
	return usable.map((row) => ({
		providerId: row.providerId,
		organizationId: row.organizationId,
		clientId: row.clientId,
		clientSecret: row.clientSecret,
		issuer: row.issuer,
		...(row.discoveryUrl === null ? {} : { discoveryUrl: row.discoveryUrl }),
		...(row.scopes === null || row.scopes.trim().length === 0
			? {}
			: { scopes: row.scopes.split(/[,\s]+/u).filter((scope) => scope.length > 0) }),
		emailDomain: row.emailDomain ?? "",
	}));
}
