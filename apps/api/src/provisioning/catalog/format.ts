import type { ProvisioningSettings } from "@optimiq-voice/pbx-db";

/**
 * The three things every vendor template needs and none of them should re-implement: escaping,
 * deterministic ordering, and appending the resolved settings.
 *
 * ## Escaping is not optional and is not the same everywhere
 *
 * A device label is administrator-supplied text that ends up inside a config a phone parses. In an
 * XML template an unescaped `&` in "Sales & Marketing" produces a document the phone rejects —
 * which manifests as a handset that boots to factory defaults and reports nothing. In a `key =
 * value` `.cfg` a newline in a label ends the line early and turns the rest of the name into an
 * unrecognised directive. Neither is exploitable in an interesting way (the writer is already an
 * authenticated administrator of the tenant whose phone it is) but both are a support ticket, and
 * both are one function call to prevent.
 *
 * ## Why the output is sorted
 *
 * Two renders of an unchanged device must produce byte-identical output. `Object.entries` follows
 * insertion order, which follows JSONB's storage order, which is not stable across an UPDATE — so
 * an unsorted settings block would make a phone see a "changed" configuration on every resync and,
 * for several vendors, reboot itself. Sorting also makes the golden assertions in the verification
 * harness meaningful rather than accidental.
 */

/** Escapes the five characters XML gives meaning to. */
export function xmlEscape(value: string): string {
	return value
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/"/gu, "&quot;")
		.replace(/'/gu, "&apos;");
}

/**
 * Flattens a value onto one line for a `key = value` configuration file.
 *
 * Control characters — anything below 0x20, plus DEL — become a space rather than being dropped:
 * dropping them would silently join two words, and a phone displaying "SalesMarketing" is a bug
 * report while "Sales Marketing" is not.
 */
export function cfgValue(value: string | number | boolean): string {
	if (typeof value === "boolean") {
		// Every vendor in the v1 catalogue spells a boolean as 1/0 in its plain-text format. A literal
		// `true` is silently ignored by Yealink and Fanvil, which is the worst of the three outcomes.
		return value ? "1" : "0";
	}
	if (typeof value === "number") {
		return String(value);
	}
	// `\p{Cc}` rather than an explicit \u0000-\u001f range: the Unicode property expresses the
	// intent ("control characters") and does not trip `no-control-regex`, which cannot tell a
	// deliberate sanitizer from an accidental literal.
	return value.replace(/\p{Cc}/gu, " ").trim();
}

/** The same, for a value that will sit inside an XML attribute or element. */
export function xmlValue(value: string | number | boolean): string {
	return xmlEscape(cfgValue(value));
}

/**
 * The settings block, sorted, with a header so a support engineer reading a phone's config knows
 * which lines came from the cascade and which are the template's own.
 */
export function renderSettingsAsCfg(
	settings: ProvisioningSettings,
	options: { readonly separator?: string; readonly comment?: string } = {},
): string {
	// Spaces are legal — and for Fanvil, mandatory — in a plain-text parameter name.
	const entries = sortedEntries(settings, { allowSpaces: true });
	if (entries.length === 0) {
		return "";
	}
	const separator = options.separator ?? " = ";
	const comment = options.comment ?? "#";
	return [
		"",
		`${comment} --- resolved settings (model < organization < profile < device) ---`,
		...entries.map(([key, value]) => `${key}${separator}${cfgValue(value)}`),
	].join("\n");
}

/** The same block as XML elements, for the vendors whose format is a document. */
export function renderSettingsAsXmlElements(settings: ProvisioningSettings, indent = "\t"): string {
	return sortedEntries(settings)
		.map(([key, value]) => `${indent}<${xmlEscape(key)}>${xmlValue(value)}</${xmlEscape(key)}>`)
		.join("\n");
}

/** The same block as XML attributes, for Polycom's `<ALL …/>` style. */
export function renderSettingsAsXmlAttributes(
	settings: ProvisioningSettings,
	indent = "\t\t",
): string {
	return sortedEntries(settings)
		.map(([key, value]) => `${indent}${xmlEscape(key)}="${xmlValue(value)}"`)
		.join("\n");
}

/**
 * Settings in a stable order, with any key that is not a plausible vendor parameter dropped.
 *
 * ## Why the filter differs between the two families
 *
 * A key ends up inside the syntax it is written into, so what is safe depends on that syntax. In an
 * XML document a key becomes an element or an attribute NAME, and a space there is not escapable —
 * `<SIP1 Register TTL>` is not an element with a space in its name, it is an element `SIP1` with
 * two bogus attributes, and the document either fails to parse or means something else entirely.
 *
 * In a `key = value` text file a space is ordinary, and for one vendor it is mandatory: Fanvil's
 * parameters are literally `SIP1 Register TTL` and `Fkey1 Type`. A single strict filter would make
 * a Fanvil override impossible to express through the settings cascade — which is the escape hatch
 * the cascade exists to provide.
 *
 * So `allowSpaces` is the caller's decision and the two helpers below make it: the text renderers
 * pass `true`, the XML ones do not. Neither ever admits a newline, a `<` or a `"`, because those
 * break out of BOTH.
 */
export function sortedEntries(
	settings: ProvisioningSettings,
	options: { readonly allowSpaces?: boolean } = {},
): readonly (readonly [string, string | number | boolean])[] {
	const pattern = options.allowSpaces === true ? /^[A-Za-z0-9._[\] -]+$/u : /^[A-Za-z0-9._[\]-]+$/u;
	return Object.entries(settings)
		.filter(([key]) => pattern.test(key))
		.sort(([a], [b]) => a.localeCompare(b));
}

/** `1` / `0`, which is how every vendor in this catalogue spells a boolean. */
export function bit(value: boolean): "1" | "0" {
	return value ? "1" : "0";
}
