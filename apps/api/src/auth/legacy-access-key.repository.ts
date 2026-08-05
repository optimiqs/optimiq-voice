import type { AuthPlatform } from "./auth.platform";

/**
 * `accessKeyId` ⇄ `organization.id`, the translation layer for the coexistence period
 * (identity-removal Steps 2-5).
 *
 * The HTTP surface already speaks `organization.id`: the session guard reads it from
 * `session.activeOrganizationId` and never sees an access key. The gRPC surface and every
 * telephony row still speak `WO…`. Until Step 5 rewrites those rows to carry a real
 * `organization_id` column, something has to translate between the two, and this is it — reading
 * the `legacy_workspace_organization` ledger that
 * `scripts/migrate-identity-to-organizations.ts` wrote.
 *
 * **This file is temporary by construction.** It is deleted with the mapping tables in Step 9.
 * Nothing new should be written against it; new code takes an `organizationId`.
 *
 * ## Caching
 *
 * The mapping is append-only and tiny (one row per tenant that existed before the cutover), and
 * it is consulted on the inbound-call path where a database round trip per call would be a
 * regression against the identity-era signer. Both directions are therefore memoised, positively
 * and negatively, with the negative entries expiring so a tenant migrated after boot becomes
 * visible without a restart.
 *
 * ## Why raw SQL instead of the Drizzle table object
 *
 * `legacyWorkspaceOrganization` is declared in `@optimiq-voice/db`, and pnpm resolves
 * `drizzle-orm` once per distinct peer set — `apps/api` pulls in `pg` / `@types/pg`,
 * `packages/db` does not, so the two receive separate (structurally identical, nominally
 * incompatible) instances of the same `1.0.0-rc.4` build. Handing a table object built by one to
 * an `eq()` imported from the other is a type error. `postgres` has a single instance, so
 * `platform.database.client` crosses the package boundary cleanly, and a two-column lookup table
 * does not need an ORM.
 */

/** How long a "no such access key" answer is trusted before the database is asked again. */
const NEGATIVE_CACHE_TTL_MS = 30_000;

export interface LegacyAccessKeyRepository {
	/** `organization.id` for a legacy `WO…` workspace key, or `null` when it was never migrated. */
	readonly findOrganizationId: (accessKeyId: string) => Promise<string | null>;
	/** The legacy `WO…` key an organization came from, or `null` if it was created after cutover. */
	readonly findAccessKeyId: (organizationId: string) => Promise<string | null>;
	/** Drops every memoised answer. Call after a migration run inside a long-lived process. */
	readonly invalidate: () => void;
}

/** Raised when the caller needs a tenant and the access key does not resolve to one. */
export class UnmappedAccessKeyError extends Error {
	readonly _tag = "UnmappedAccessKeyError" as const;
	readonly accessKeyId: string;

	constructor(accessKeyId: string) {
		super(
			`Access key ${accessKeyId} does not map to an organization. ` +
				"Run `pnpm --filter @optimiq-voice/api migrate:identity` (identity-removal Step 2) " +
				"before this tenant can be served by the better-auth path.",
		);
		this.name = "UnmappedAccessKeyError";
		this.accessKeyId = accessKeyId;
	}
}

interface CacheEntry {
	readonly value: string | null;
	readonly expiresAt: number;
}

function isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
	return entry !== undefined && entry.expiresAt > Date.now();
}

export function createLegacyAccessKeyRepository(platform: AuthPlatform): LegacyAccessKeyRepository {
	const byAccessKey = new Map<string, CacheEntry>();
	const byOrganization = new Map<string, CacheEntry>();

	const remember = (
		cache: Map<string, CacheEntry>,
		key: string,
		value: string | null,
	): string | null => {
		// A hit is immutable — the ledger never rewrites a row — so it never expires.
		cache.set(key, {
			value,
			expiresAt: value === null ? Date.now() + NEGATIVE_CACHE_TTL_MS : Number.POSITIVE_INFINITY,
		});
		return value;
	};

	const findOrganizationId = async (accessKeyId: string): Promise<string | null> => {
		const key = accessKeyId.trim();
		if (key.length === 0) {
			return null;
		}
		const cached = byAccessKey.get(key);
		if (isFresh(cached)) {
			return cached.value;
		}
		const rows = await platform.database.client<{ organizationId: string }[]>`
			select organization_id as "organizationId"
			from legacy_workspace_organization
			where access_key_id = ${key}
			limit 1
		`;
		const organizationId = rows[0]?.organizationId ?? null;
		if (organizationId) {
			remember(byOrganization, organizationId, key);
		}
		return remember(byAccessKey, key, organizationId);
	};

	const findAccessKeyId = async (organizationId: string): Promise<string | null> => {
		const key = organizationId.trim();
		if (key.length === 0) {
			return null;
		}
		const cached = byOrganization.get(key);
		if (isFresh(cached)) {
			return cached.value;
		}
		const rows = await platform.database.client<{ accessKeyId: string }[]>`
			select access_key_id as "accessKeyId"
			from legacy_workspace_organization
			where organization_id = ${key}::uuid
			limit 1
		`;
		const accessKeyId = rows[0]?.accessKeyId ?? null;
		if (accessKeyId) {
			remember(byAccessKey, accessKeyId, key);
		}
		return remember(byOrganization, key, accessKeyId);
	};

	return {
		findOrganizationId,
		findAccessKeyId,
		invalidate: () => {
			byAccessKey.clear();
			byOrganization.clear();
		},
	};
}
