import { z } from "zod/v4";

/**
 * The white-label branding write body. Every field is nullable-optional: omitting a field leaves
 * it untouched, and sending `null` clears the override so the value falls back to the reseller
 * default and then the code default.
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
	logoObjectKey: z.string().trim().min(1).max(512).nullable().optional(),
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
