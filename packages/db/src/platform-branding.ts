import { eq } from "drizzle-orm";
import { organizationBranding } from "./schema/platform/organization-platform-schema";
import type { AdminDatabase } from "./client";

/**
 * Reads and writes over per-organization white-label branding — the base-database repository the
 * theme cascade resolves through. Lives here for the same Drizzle-version reason as
 * {@link import("./platform-hierarchy")}: the queries are built with this package's Drizzle and
 * `apps/api` calls them with its untenanted `adminDb` handle.
 */

export interface BrandingRow {
	readonly organizationId: string;
	readonly productName: string | null;
	readonly logoObjectKey: string | null;
	readonly primaryColor: string | null;
	readonly accentColor: string | null;
	readonly supportEmail: string | null;
	readonly customDomain: string | null;
	readonly defaultLanguage: string | null;
}

/** The columns a caller may set. Every field is optional; an absent field is left untouched. */
export interface BrandingPatch {
	readonly productName?: string | null;
	readonly logoObjectKey?: string | null;
	readonly primaryColor?: string | null;
	readonly accentColor?: string | null;
	readonly supportEmail?: string | null;
	readonly customDomain?: string | null;
	readonly defaultLanguage?: string | null;
}

const BRANDING_COLUMNS = {
	organizationId: organizationBranding.organizationId,
	productName: organizationBranding.productName,
	logoObjectKey: organizationBranding.logoObjectKey,
	primaryColor: organizationBranding.primaryColor,
	accentColor: organizationBranding.accentColor,
	supportEmail: organizationBranding.supportEmail,
	customDomain: organizationBranding.customDomain,
	defaultLanguage: organizationBranding.defaultLanguage,
} as const;

/** The branding row for one organization, or `null` when it has never set any branding. */
export async function readBranding(
	db: AdminDatabase,
	organizationId: string,
): Promise<BrandingRow | null> {
	const rows = await db
		.select(BRANDING_COLUMNS)
		.from(organizationBranding)
		.where(eq(organizationBranding.organizationId, organizationId))
		.limit(1);
	return rows[0] ?? null;
}

/**
 * The organization that owns a custom host — the one genuinely cross-tenant lookup, answered
 * before authentication so the web shell can theme its login page. Returns only the branding row;
 * no other tenant data is reachable from here.
 */
export async function readBrandingByCustomDomain(
	db: AdminDatabase,
	host: string,
): Promise<BrandingRow | null> {
	const normalized = host.trim().toLowerCase();
	if (normalized.length === 0) {
		return null;
	}
	const rows = await db
		.select(BRANDING_COLUMNS)
		.from(organizationBranding)
		.where(eq(organizationBranding.customDomain, normalized))
		.limit(1);
	return rows[0] ?? null;
}

/** Upsert the branding row, patching only the fields supplied. */
export async function upsertBranding(
	db: AdminDatabase,
	organizationId: string,
	patch: BrandingPatch,
): Promise<BrandingRow> {
	const set: Record<string, unknown> = {};
	for (const key of [
		"productName",
		"logoObjectKey",
		"primaryColor",
		"accentColor",
		"supportEmail",
		"customDomain",
		"defaultLanguage",
	] as const) {
		if (patch[key] !== undefined) {
			set[key] = patch[key] === null ? null : normalizeField(key, patch[key] as string);
		}
	}

	const rows = await db
		.insert(organizationBranding)
		.values({ organizationId, ...set })
		.onConflictDoUpdate({
			target: organizationBranding.organizationId,
			set: Object.keys(set).length > 0 ? set : { organizationId },
		})
		.returning(BRANDING_COLUMNS);
	return rows[0]!;
}

/** A custom domain is compared and stored lowercased; other fields are stored verbatim. */
function normalizeField(key: keyof BrandingPatch, value: string): string {
	return key === "customDomain" ? value.trim().toLowerCase() : value;
}
