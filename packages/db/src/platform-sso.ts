import { and, eq } from "drizzle-orm";
import { organizationSsoProvider } from "./schema/platform/organization-platform-schema";
import type { AdminDatabase } from "./client";

/**
 * Reads and writes over per-organization SSO providers — the base-database repository the auth
 * slice configures IdPs through. Built with this package's Drizzle for the version-pin reason the
 * other platform repositories state.
 */

/**
 * A provider as every read surface sees it — WITHOUT `client_secret`.
 *
 * The secret is a credential the platform presents to the IdP; one careless controller returning
 * a row is enough to leak it, so it is not in the shared projection at all. The single reader
 * that needs it is the auth boot, through {@link listEnabledSsoProvidersWithSecrets}.
 */
export interface SsoProviderRow {
	readonly id: string;
	readonly organizationId: string;
	readonly providerId: string;
	readonly protocol: "oidc";
	readonly issuer: string;
	readonly clientId: string;
	readonly discoveryUrl: string | null;
	readonly scopes: string | null;
	readonly emailDomain: string | null;
	readonly enabled: boolean;
}

/** {@link SsoProviderRow} plus the secret. Only the platform bootstrap may hold one. */
export interface SsoProviderSecretRow extends SsoProviderRow {
	readonly clientSecret: string;
}

export interface SsoProviderInput {
	readonly organizationId: string;
	readonly providerId: string;
	readonly issuer: string;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly discoveryUrl?: string | null;
	readonly scopes?: string | null;
	readonly emailDomain?: string | null;
	readonly enabled?: boolean;
}

const COLUMNS = {
	id: organizationSsoProvider.id,
	organizationId: organizationSsoProvider.organizationId,
	providerId: organizationSsoProvider.providerId,
	protocol: organizationSsoProvider.protocol,
	issuer: organizationSsoProvider.issuer,
	clientId: organizationSsoProvider.clientId,
	discoveryUrl: organizationSsoProvider.discoveryUrl,
	scopes: organizationSsoProvider.scopes,
	emailDomain: organizationSsoProvider.emailDomain,
	enabled: organizationSsoProvider.enabled,
} as const;

/** The projection above plus the secret — used by exactly one function, deliberately. */
const SECRET_COLUMNS = {
	...COLUMNS,
	clientSecret: organizationSsoProvider.clientSecret,
} as const;

export async function listSsoProviders(
	db: AdminDatabase,
	organizationId: string,
): Promise<readonly SsoProviderRow[]> {
	return await db
		.select(COLUMNS)
		.from(organizationSsoProvider)
		.where(eq(organizationSsoProvider.organizationId, organizationId));
}

export async function readSsoProvider(
	db: AdminDatabase,
	organizationId: string,
	id: string,
): Promise<SsoProviderRow | null> {
	const rows = await db
		.select(COLUMNS)
		.from(organizationSsoProvider)
		.where(
			and(
				eq(organizationSsoProvider.organizationId, organizationId),
				eq(organizationSsoProvider.id, id),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Every enabled provider across all organizations — what the auth boot feeds to `genericOAuth`.
 *
 * The ONLY accessor that returns `client_secret`, and the only one that should: `genericOAuth`'s
 * config is platform-wide, so the boot needs each row's `organizationId` and `emailDomain` too —
 * they are what ties an identity asserted by one tenant's IdP back to that tenant. Never reachable
 * from a request handler.
 */
export async function listEnabledSsoProvidersWithSecrets(
	db: AdminDatabase,
): Promise<readonly SsoProviderSecretRow[]> {
	return await db
		.select(SECRET_COLUMNS)
		.from(organizationSsoProvider)
		.where(eq(organizationSsoProvider.enabled, true));
}

export async function createSsoProvider(
	db: AdminDatabase,
	input: SsoProviderInput,
): Promise<SsoProviderRow> {
	const rows = await db
		.insert(organizationSsoProvider)
		.values({
			organizationId: input.organizationId,
			providerId: input.providerId,
			issuer: input.issuer,
			clientId: input.clientId,
			clientSecret: input.clientSecret,
			discoveryUrl: input.discoveryUrl ?? null,
			scopes: input.scopes ?? null,
			emailDomain: input.emailDomain ?? null,
			enabled: input.enabled ?? true,
		})
		.returning(COLUMNS);
	return rows[0]!;
}

export async function updateSsoProvider(
	db: AdminDatabase,
	organizationId: string,
	id: string,
	patch: Partial<Omit<SsoProviderInput, "organizationId" | "providerId">>,
): Promise<SsoProviderRow | null> {
	const set: Record<string, unknown> = {};
	for (const key of [
		"issuer",
		"clientId",
		"clientSecret",
		"discoveryUrl",
		"scopes",
		"emailDomain",
		"enabled",
	] as const) {
		if (patch[key] !== undefined) {
			set[key] = patch[key];
		}
	}
	if (Object.keys(set).length === 0) {
		return await readSsoProvider(db, organizationId, id);
	}
	const rows = await db
		.update(organizationSsoProvider)
		.set(set)
		.where(
			and(
				eq(organizationSsoProvider.organizationId, organizationId),
				eq(organizationSsoProvider.id, id),
			),
		)
		.returning(COLUMNS);
	return rows[0] ?? null;
}

export async function deleteSsoProvider(
	db: AdminDatabase,
	organizationId: string,
	id: string,
): Promise<boolean> {
	const rows = await db
		.delete(organizationSsoProvider)
		.where(
			and(
				eq(organizationSsoProvider.organizationId, organizationId),
				eq(organizationSsoProvider.id, id),
			),
		)
		.returning({ id: organizationSsoProvider.id });
	return rows.length > 0;
}
