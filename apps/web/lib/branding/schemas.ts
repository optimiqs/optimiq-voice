/**
 * The branding form schema, matched to `apps/api`'s `updateBrandingDto`.
 *
 * The form works in strings — an empty input is the user's way of saying "unset", which the wire
 * carries as `null` (clearing the override so the value falls back to the reseller default, then the
 * code default). Colours accept `#rgb` or `#rrggbb`; email, hostname and BCP-47 language are
 * validated only when non-empty, so clearing a field is always allowed.
 *
 * `customDomain` is the one field handled specially in {@link formToBrandingPatch}: the resolved
 * read never returns it, so it always seeds empty, and blanking it must NOT be read as "clear the
 * domain". It is therefore OMITTED from the patch when empty rather than sent as `null`.
 */

import { z } from "zod";
import { isHexColor } from "./theme";
import type { Branding } from "./contracts";

const optionalHex = z
	.string()
	.trim()
	.refine((value) => value === "" || isHexColor(value), {
		message: "Enter a hex colour like #2f6fed, or leave it empty to use the default",
	});

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const BCP47 = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/u;

export const brandingFormSchema = z.object({
	productName: z.string().trim().min(1, "Required").max(80, "At most 80 characters"),
	logoObjectKey: z.string().trim().max(512, "At most 512 characters"),
	primaryColor: optionalHex,
	accentColor: optionalHex,
	supportEmail: z
		.string()
		.trim()
		.refine((value) => value === "" || z.email().max(254).safeParse(value).success, {
			message: "Enter an email address, or leave it empty",
		}),
	customDomain: z
		.string()
		.trim()
		.refine((value) => value === "" || HOSTNAME.test(value.toLowerCase()), {
			message: "Enter a hostname like voice.acme.com, or leave it empty",
		}),
	defaultLanguage: z
		.string()
		.trim()
		.refine((value) => value === "" || BCP47.test(value), {
			message: "Enter a language tag like en or en-GB, or leave it empty",
		}),
});

export type BrandingForm = z.infer<typeof brandingFormSchema>;

/** The form's empty state — every field a string, ready to seed from a resolved brand. */
export const EMPTY_BRANDING_FORM: BrandingForm = {
	productName: "",
	logoObjectKey: "",
	primaryColor: "",
	accentColor: "",
	supportEmail: "",
	customDomain: "",
	defaultLanguage: "",
};

/** A resolved {@link Branding} → the string form the inputs bind to (`null` → `""`). */
export function brandingToForm(brand: Branding): BrandingForm {
	return {
		productName: brand.productName,
		logoObjectKey: brand.logoObjectKey ?? "",
		primaryColor: brand.primaryColor ?? "",
		accentColor: brand.accentColor ?? "",
		supportEmail: brand.supportEmail ?? "",
		customDomain: brand.customDomain ?? "",
		defaultLanguage: brand.defaultLanguage,
	};
}

/**
 * The form → the partial write body.
 *
 * Empty strings become `null` (the "unset" the cascade stores) for every field EXCEPT
 * `customDomain`, which is omitted entirely when empty so a form that never showed the current
 * domain cannot clear it by being saved.
 */
export function formToBrandingPatch(form: BrandingForm): Partial<Branding> {
	const orNull = (value: string): string | null => {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	};

	const base: Partial<Branding> = {
		productName: form.productName.trim(),
		logoObjectKey: orNull(form.logoObjectKey),
		primaryColor: orNull(form.primaryColor),
		accentColor: orNull(form.accentColor),
		supportEmail: orNull(form.supportEmail),
		defaultLanguage: form.defaultLanguage.trim().length > 0 ? form.defaultLanguage.trim() : "en",
	};

	// A new object rather than a mutation — `Branding`'s fields are readonly. Omit `customDomain`
	// entirely when blank so a save cannot clear a domain the resolved read never showed.
	const domain = form.customDomain.trim();
	return domain.length > 0 ? { ...base, customDomain: domain } : base;
}
