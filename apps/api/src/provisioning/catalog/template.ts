import type { RenderContext, RenderedConfig } from "./render-context";
import type { DeviceVendor, ProvisioningSettings } from "@optimiq-voice/pbx-db";

/**
 * A vendor template, as data.
 *
 * FusionPBX shipped ~300 model folders and 29 vendor shim applications, each a directory of
 * `{$var}` files interpolated by a PHP renderer. The rebuild's decision (`plans/reference` §6, T3)
 * is a **data-driven catalogue**: five vendors, one function each, and a model table that says which
 * models a template covers and what defaults they carry.
 *
 * ## Why a function and not a string template
 *
 * The five formats are not variations on one shape — two are XML with different roots and different
 * attribute-versus-element conventions, one is `key = value`, one is a sectioned text format with a
 * mandatory version banner, and the key-type vocabularies are five disjoint sets of magic numbers.
 * A single interpolation engine over five string templates would need conditionals inside the
 * strings, at which point the strings are a programming language with no type checker. A TypeScript
 * function per vendor is the same amount of code with the compiler switched on.
 *
 * ## `id` is a UUID, and it is stable
 *
 * `packages/events`' `deviceRenderedDataSchema` requires `templateId` to be a UUID, and its comment
 * explains why: "the pair (template, profile) reproduces the exact output". These are therefore
 * fixed constants written into the source, not generated — a template id that changed between
 * deployments would make an event stream unjoinable to the thing that produced it. Changing a
 * template's OUTPUT in a way that is not backwards compatible means minting a new id, which is what
 * makes "which template rendered this?" answerable a year later.
 */
export interface VendorTemplate {
	/** Stable UUID. Appears in `device.rendered`. Never regenerate one; mint a new template. */
	readonly id: string;
	readonly vendor: DeviceVendor;
	/** Human name, e.g. "Yealink T4x/T5x (V84+)". Shown in the UI's model picker heading. */
	readonly name: string;
	/**
	 * Model prefixes this template covers, upper-cased.
	 *
	 * Matched by prefix rather than by equality because vendors ship a dozen suffixes per family
	 * (`T54W`, `T54W-A`, `T54WS`) that share a configuration format exactly. A model the catalogue
	 * has never heard of falls back to the vendor's family template rather than failing, because a
	 * phone released last month is still a phone and a 404 helps nobody.
	 */
	readonly models: readonly string[];
	/** Defaults the cascade's first level contributes for this template's models. */
	readonly defaults: ProvisioningSettings;
	readonly contentType: string;
	/** The filename the vendor's firmware would have requested. */
	readonly filename: (macAddress: string, model: string | undefined) => string;
	readonly render: (context: RenderContext) => string;
	/**
	 * Where the parameter names came from.
	 *
	 * Pinned per template rather than in one bibliography so a reviewer can check a specific
	 * template against a specific document. The long form, with what each source covered and what it
	 * did not, is `plans/reference/device-provisioning-formats.md`.
	 */
	readonly sources: readonly string[];
	/**
	 * What this template has NOT been validated against real hardware for.
	 *
	 * Written down rather than assumed correct: none of these five have been rendered into a
	 * physical phone in this repository, and a template that is wrong in a way only hardware reveals
	 * should say so where the next person will read it.
	 */
	readonly caveats?: readonly string[];
}

/** Produces the `RenderedConfig` for a template and a context. */
export function renderWith(template: VendorTemplate, context: RenderContext): RenderedConfig {
	return {
		body: template.render(context),
		contentType: template.contentType,
		filename: template.filename(context.macAddress, context.model),
	};
}
