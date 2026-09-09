import { z } from "zod/v4";

/**
 * The white-label branding write body. Every field is nullable-optional: omitting a field leaves
 * it untouched, and sending `null` clears the override so the value falls back to the reseller
 * default and then the code default.
 *
 * `logoObjectKey` is the exception: it accepts `null` and nothing else. The key is server-owned —
 * minted by `BrandingLogoUploadService` from the bytes it just stored, under this tenant's own
 * `branding/` prefix — and accepting a STRING here let a tenant admin point their brand at any key
 * in the shared object store. Clearing the override is still a legitimate write and is the only
 * thing this field can now do; the read-side prefix guard in `branding-logo.controller.ts` is
 * defence-in-depth rather than the only defence.
 */

const hexColor = z
	.string()
	.trim()
	.regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u, "expected a hex colour like #1a2b3c");

const host = z
	.string()
	.trim()
	.toLowerCase()
	.max(253)
	.regex(
		/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u,
		"expected a hostname",
	);

export const updateBrandingDto = z.strictObject({
	productName: z.string().trim().min(1).max(80).nullable().optional(),
	logoObjectKey: z.null().optional(),
	primaryColor: hexColor.nullable().optional(),
	accentColor: hexColor.nullable().optional(),
	supportEmail: z.email().max(254).nullable().optional(),
	customDomain: host.nullable().optional(),
	defaultLanguage: z
		.string()
		.trim()
		.regex(/^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/u, "expected a BCP-47 language tag like en or en-GB")
		.nullable()
		.optional(),
});
export type UpdateBrandingInput = z.output<typeof updateBrandingDto>;
