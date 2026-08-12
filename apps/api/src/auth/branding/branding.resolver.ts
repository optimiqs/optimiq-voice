import type { BrandingRow } from "@optimiq-voice/db";

/**
 * The resolved white-label branding a client renders. Every field is present — a resolved value is
 * the org override, then the reseller default, then the code default, so there is never a hole.
 */
export interface EffectiveBranding {
	readonly productName: string;
	readonly logoObjectKey: string | null;
	readonly primaryColor: string;
	readonly accentColor: string;
	readonly supportEmail: string | null;
	readonly defaultLanguage: string;
}

/**
 * The code default — the first level of the cascade, versioned and reviewed rather than a row
 * nobody wrote, exactly as the settings cascade argues in `settings-schema.ts`.
 */
export const DEFAULT_BRANDING: EffectiveBranding = {
	productName: "Optimiq Voice",
	logoObjectKey: null,
	primaryColor: "#111111",
	accentColor: "#2563eb",
	supportEmail: null,
	defaultLanguage: "en",
};

function pick<T>(...candidates: readonly (T | null | undefined)[]): T | null {
	for (const candidate of candidates) {
		if (candidate !== null && candidate !== undefined) {
			return candidate;
		}
	}
	return null;
}

/**
 * Resolve effective branding through `code default → reseller default → org override`.
 *
 * Pure and exported so the cascade is unit-tested without a database. `customDomain` is
 * deliberately NOT part of the resolved shape and NOT inherited: a host belongs to exactly one org,
 * so a child never inherits its reseller's domain. Every other field cascades: a child that sets no
 * logo shows its reseller's, and one that sets no colour shows the reseller's colour, then the code
 * default.
 */
export function resolveEffectiveBranding(
	org: BrandingRow | null,
	resellerDefault: BrandingRow | null,
): EffectiveBranding {
	return {
		productName:
			pick(org?.productName, resellerDefault?.productName) ?? DEFAULT_BRANDING.productName,
		logoObjectKey: pick(org?.logoObjectKey, resellerDefault?.logoObjectKey),
		primaryColor:
			pick(org?.primaryColor, resellerDefault?.primaryColor) ?? DEFAULT_BRANDING.primaryColor,
		accentColor:
			pick(org?.accentColor, resellerDefault?.accentColor) ?? DEFAULT_BRANDING.accentColor,
		supportEmail: pick(org?.supportEmail, resellerDefault?.supportEmail),
		defaultLanguage:
			pick(org?.defaultLanguage, resellerDefault?.defaultLanguage) ??
			DEFAULT_BRANDING.defaultLanguage,
	};
}
