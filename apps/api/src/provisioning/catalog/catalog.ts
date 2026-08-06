import { DEVICE_VENDORS } from "@optimiq-voice/pbx-db";
import { FANVIL_TEMPLATE } from "./templates/fanvil";
import { GRANDSTREAM_TEMPLATE } from "./templates/grandstream";
import { POLY_TEMPLATE } from "./templates/poly";
import { SNOM_TEMPLATE } from "./templates/snom";
import { GENERIC_TEMPLATE, SOFTPHONE_TEMPLATE } from "./templates/softphone";
import { YEALINK_TEMPLATE } from "./templates/yealink";
import type { VendorTemplate } from "./template";
import type { DeviceVendor } from "@optimiq-voice/pbx-db";

/**
 * The vendor catalogue: one template per vendor, plus the model families each covers.
 *
 * FusionPBX shipped ~300 model directories across 29 vendors and ~947 provisioning settings. The
 * rebuild's stated scope (`plans/reference/fusionpbx-inventory.md` §2 and §6-T3) is the five
 * vendors that make up roughly 80% of the installed base, plus a softphone pattern — as a
 * **data-driven catalogue** rather than 300 hand-maintained directories.
 *
 * ## Why it lives in `apps/api` and not in a package
 *
 * It has exactly one consumer: the render endpoint two directories away. `apps/web` needs the model
 * LIST and gets it from `GET /api/v1/provisioning/catalog`, which it needs anyway to know which
 * templates the deployment it is talking to actually has. `apps/engine` does not render
 * configurations — provisioning is an HTTP control-plane concern and the engine never sees a phone
 * before it registers.
 *
 * So a workspace package would add a build target, a tsconfig, a lerna entry and a published
 * surface for code with one importer, and would buy nothing but the ability to `bun test` it —
 * which `apps/api`'s mocha suite does regardless. If a second consumer ever appears the extraction
 * is mechanical: the templates are pure functions of `RenderContext` and import nothing from Nest.
 *
 * ## Model matching
 *
 * By upper-cased PREFIX, longest first. Vendors ship a dozen suffixes per family — `T54W`,
 * `T54W-A`, `T54WS` — that share a format exactly, so equality matching would need the catalogue to
 * enumerate SKUs and would go stale the week after it shipped. A model nothing matches still gets
 * its vendor's template, because a phone released last month is still that vendor's phone and a 404
 * would make the product refuse hardware it can very likely provision.
 */

export const VENDOR_TEMPLATES: readonly VendorTemplate[] = [
	YEALINK_TEMPLATE,
	POLY_TEMPLATE,
	GRANDSTREAM_TEMPLATE,
	FANVIL_TEMPLATE,
	SNOM_TEMPLATE,
	SOFTPHONE_TEMPLATE,
	GENERIC_TEMPLATE,
];

const BY_VENDOR = new Map<DeviceVendor, VendorTemplate>(
	VENDOR_TEMPLATES.map((template) => [template.vendor, template]),
);

/**
 * The template for a device.
 *
 * Returns `undefined` only for a vendor the catalogue has no entry for at all, which the type
 * system already makes impossible — `DEVICE_VENDORS` and `VENDOR_TEMPLATES` are pinned against each
 * other by spec. The signature keeps the `undefined` so the render path has a branch to publish
 * `unknown-vendor` from rather than a non-null assertion that would be a 500 the day the two lists
 * disagree.
 */
export function templateFor(vendor: DeviceVendor): VendorTemplate | undefined {
	return BY_VENDOR.get(vendor);
}

/** Whether a template covers a model. Prefix match, case-insensitive. */
export function templateCoversModel(template: VendorTemplate, model: string | undefined): boolean {
	if (model === undefined || model.length === 0) {
		return template.models.length === 0;
	}
	const normalized = model.trim().toUpperCase();
	return template.models.some((prefix) => normalized.startsWith(prefix));
}

/**
 * The model defaults a device inherits — the cascade's first level.
 *
 * Today every model of a vendor shares the vendor template's `defaults`. The per-MODEL layer is
 * where "the T31G has no colour screen, so do not set a wallpaper" would live, and it is
 * deliberately not populated with guesses: a default that is wrong is worse than a default that is
 * absent, because the absent one is visible in the diff and the wrong one is not.
 */
export function modelDefaults(
	vendor: DeviceVendor,
): Readonly<Record<string, string | number | boolean>> {
	return templateFor(vendor)?.defaults ?? {};
}

// ---------------------------------------------------------------------------------------------
// The shape `apps/web` reads
// ---------------------------------------------------------------------------------------------

export interface CatalogVendorEntry {
	readonly vendor: DeviceVendor;
	readonly templateId: string;
	readonly name: string;
	readonly models: readonly string[];
	readonly contentType: string;
	readonly sources: readonly string[];
	readonly caveats: readonly string[];
	/** Whether a device on this vendor produces a configuration a phone can use. */
	readonly provisionable: boolean;
}

/**
 * The catalogue as the admin UI needs it.
 *
 * Served rather than mirrored in `apps/web` for the reason the feature-code parameter fields are:
 * it describes the DEPLOYMENT's capabilities, and a client that hard-coded the list would offer a
 * vendor picker whose entries the server it is talking to might not have. `caveats` travels with it
 * so the form can show, next to the vendor, what has not been validated — which is information an
 * administrator about to buy forty handsets should have.
 */
export function catalogEntries(): readonly CatalogVendorEntry[] {
	return VENDOR_TEMPLATES.map((template) => ({
		vendor: template.vendor,
		templateId: template.id,
		name: template.name,
		models: template.models,
		contentType: template.contentType,
		sources: template.sources,
		caveats: template.caveats ?? [],
		provisionable: template.vendor !== "generic",
	}));
}

/** Every vendor the schema knows. Exported so the spec can assert the catalogue covers all of them. */
export const CATALOG_VENDORS = DEVICE_VENDORS;
