import { z } from "zod";
import { e164, timezoneName } from "../pbx/schemas";
import type { RoutingSettings } from "./client";

/**
 * The `routing` settings category, in the shape a form can hold.
 *
 * ## Why the conversion is here and not in the page
 *
 * Three of the eight settings are not strings and every one of the five that are is nullable, so
 * the screen has a real projection to do in both directions: `null` becomes `""` going in, `""`
 * becomes `null` coming out, and two arrays become editable text and a set of checkboxes. That
 * projection is where the mistakes live — an empty caller-id saved as `""` instead of `null` is a
 * value, and an outbound call presenting an empty display name is what it produces — so it is a
 * pair of pure functions with a spec rather than inline JSX.
 *
 * ## `""` means "unset", and only `null` says so on the wire
 *
 * The cascade stores an absent setting as `null`. An empty string is a VALUE: `voicemailPrefix`
 * of `""` would be a prefix that matches nothing and disables the table, which happens to be the
 * same outcome, but `outboundCallerIdName` of `""` is a name of "" presented on a live call. One
 * rule, applied to all five, is cheaper than five judgement calls.
 */

/** At most 32 entries of at most 16 characters — the catalogue's own bound for both list settings. */
const MAX_LIST_ENTRIES = 32;
const MAX_DIAL_STRING = 16;

export interface RoutingSettingsFormValues {
	defaultTimezone: string;
	voicemailPrefix: string;
	voicemailCheckPrefix: string;
	outboundCallerIdNumber: string;
	outboundCallerIdName: string;
	outboundEnabled: boolean;
	trunkContinueOnCauses: string[];
	/** Free text, one number per line or comma-separated — see {@link parseDialStringList}. */
	emergencyNumbers: string;
}

/**
 * Optional in the form, validated only when non-empty.
 *
 * `.optional()` is the wrong tool: the control always holds a string, so the schema has to accept
 * `""` and defer to the inner rule for everything else. Refusing an empty box would make "clear
 * this setting" impossible, which is the operation the cascade's `null` exists for.
 */
function optionalText(inner: z.ZodType<unknown, string>, message: string) {
	return z.string().refine((value) => value === "" || inner.safeParse(value).success, { message });
}

export const routingSettingsFormSchema = z.object({
	defaultTimezone: timezoneName,
	voicemailPrefix: optionalText(
		z.string().trim().min(1).max(MAX_DIAL_STRING),
		`At most ${MAX_DIAL_STRING} characters`,
	),
	voicemailCheckPrefix: optionalText(
		z.string().trim().min(1).max(MAX_DIAL_STRING),
		`At most ${MAX_DIAL_STRING} characters`,
	),
	outboundCallerIdNumber: optionalText(e164, "Must be E.164, e.g. +12125550100"),
	outboundCallerIdName: optionalText(z.string().trim().min(1).max(64), "At most 64 characters"),
	outboundEnabled: z.boolean(),
	trunkContinueOnCauses: z.array(z.string()).max(MAX_LIST_ENTRIES),
	emergencyNumbers: z
		.string()
		.refine((value) => parseDialStringList(value).length <= MAX_LIST_ENTRIES, {
			message: `At most ${MAX_LIST_ENTRIES} numbers`,
		})
		.refine(
			(value) => parseDialStringList(value).every((entry) => entry.length <= MAX_DIAL_STRING),
			{ message: `Each number is at most ${MAX_DIAL_STRING} characters` },
		),
});

/**
 * Seed values for the first render, before the category query resolves.
 *
 * They repeat the catalogue's defaults, which is what the API would return for a tenant with no
 * rows — binding a switch to `undefined` in the meantime makes it an uncontrolled input that React
 * then complains about the moment the data arrives.
 */
export const EMPTY_ROUTING_FORM: RoutingSettingsFormValues = {
	defaultTimezone: "UTC",
	voicemailPrefix: "",
	voicemailCheckPrefix: "",
	outboundCallerIdNumber: "",
	outboundCallerIdName: "",
	outboundEnabled: true,
	trunkContinueOnCauses: [],
	emergencyNumbers: "",
};

export function toRoutingFormValues(settings: RoutingSettings): RoutingSettingsFormValues {
	return {
		defaultTimezone: settings.defaultTimezone,
		voicemailPrefix: settings.voicemailPrefix ?? "",
		voicemailCheckPrefix: settings.voicemailCheckPrefix ?? "",
		outboundCallerIdNumber: settings.outboundCallerIdNumber ?? "",
		outboundCallerIdName: settings.outboundCallerIdName ?? "",
		outboundEnabled: settings.outboundEnabled,
		trunkContinueOnCauses: [...settings.trunkContinueOnCauses],
		emergencyNumbers: formatDialStringList(settings.emergencyNumbers),
	};
}

/**
 * The form's values as the eight catalogued settings, ready to be diffed against what was loaded.
 *
 * Every key is present — the diff in `changedSettings` is what decides which of them reach the
 * PATCH, and it can only do that if it is handed the whole picture.
 */
export function fromRoutingFormValues(values: RoutingSettingsFormValues): RoutingSettings {
	const text = (value: string): string | null => {
		const trimmed = value.trim();
		return trimmed.length === 0 ? null : trimmed;
	};
	return {
		defaultTimezone: values.defaultTimezone.trim(),
		voicemailPrefix: text(values.voicemailPrefix),
		voicemailCheckPrefix: text(values.voicemailCheckPrefix),
		outboundCallerIdNumber: text(values.outboundCallerIdNumber),
		outboundCallerIdName: text(values.outboundCallerIdName),
		outboundEnabled: values.outboundEnabled,
		// Sorted and de-duplicated for the reason the compiler sorts them: an unordered set whose
		// order moves would make the diff below report a change the user did not make.
		trunkContinueOnCauses: [...new Set(values.trunkContinueOnCauses)].sort(),
		emergencyNumbers: parseDialStringList(values.emergencyNumbers),
	};
}

/**
 * A list of dial strings out of one text box.
 *
 * Commas AND newlines both separate, because both are how a person pastes a list of numbers and
 * choosing one would silently turn `112, 999` into a single 8-character "number". Duplicates are
 * collapsed: the compiler treats the list as a set, so keeping a repeat would only ever show up as
 * a spurious diff.
 */
export function parseDialStringList(value: string): string[] {
	const entries = value
		.split(/[\n,]/u)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return [...new Set(entries)];
}

export function formatDialStringList(entries: readonly string[]): string {
	return entries.join(", ");
}

/**
 * The zones offered for `defaultTimezone`, always including whatever is currently stored.
 *
 * A select is the right control here because an unknown zone does not fail the SAVE — it fails the
 * COMPILE, later, on a route the user was not editing, and the compiler's message names a setting
 * rather than the screen it was typed on. `Intl.supportedValuesOf` is the runtime's own list, so
 * the offered set is exactly the set the compiler's `Intl` will accept.
 *
 * `current` is prepended when the runtime does not know it, because a select whose value is not
 * among its options renders as the FIRST option — so a tenant on a zone this browser's ICU build
 * has dropped would silently be shown, and then saved as, something else entirely.
 */
export function timezoneOptions(current: string): readonly string[] {
	let supported: readonly string[] = [];
	try {
		supported = Intl.supportedValuesOf("timeZone");
	} catch {
		supported = [];
	}
	const zones = new Set<string>(["UTC", ...supported]);
	if (current.length > 0) {
		zones.add(current);
	}
	return [...zones].sort();
}
