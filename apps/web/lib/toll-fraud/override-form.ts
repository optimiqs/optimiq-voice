import type { ExtensionTollFraudOverride, WriteExtensionTollFraudOverride } from "./client";

/**
 * One extension's toll-fraud override, in the shape a form can hold.
 *
 * ## Three states, not two, and the third is the default
 *
 * `null` on an override row means INHERIT — the opposite of what `null` means on the organization
 * policy, where there is nothing above to inherit from. That asymmetry is the API's and it is the
 * one this projection exists to preserve: a boolean form value can only encode two of the three
 * states, so the booleans are `"inherit" | "on" | "off"` and the ceilings are numeric text where
 * `""` is inherit and `"0"` is a ceiling of none.
 *
 * ## An untouched extension writes nothing
 *
 * {@link sameOverride} is what the extension dialog asks before it sends anything at all, on the
 * same terms as `sameFollowMe` for the follow-me ladder: a `PUT` on this collection creates the row
 * if it is missing, so an unconditional write would give every extension somebody opened the dialog
 * on an override row full of inherits — rows that mean nothing, that the fraud panel then lists as
 * departures from the policy, and that make "which phones are exceptions?" unanswerable.
 */

export type TriState = "inherit" | "on" | "off";

export interface TollFraudOverrideFormValues {
	enabled: TriState;
	/** `""` inherits; `"0"` is a ceiling of none. See the header. */
	maxConcurrentInternationalCalls: string;
	maxInternationalMinutesPerHour: string;
	maxInternationalMinutesPerDay: string;
	holdFirstCallToNewCountry: TriState;
	offHoursInternationalLock: TriState;
}

/** Everything inherited — what an extension with no override row starts from. */
export const EMPTY_OVERRIDE_FORM: TollFraudOverrideFormValues = {
	enabled: "inherit",
	maxConcurrentInternationalCalls: "",
	maxInternationalMinutesPerHour: "",
	maxInternationalMinutesPerDay: "",
	holdFirstCallToNewCountry: "inherit",
	offHoursInternationalLock: "inherit",
};

export function toOverrideFormValues(
	override: ExtensionTollFraudOverride | undefined,
): TollFraudOverrideFormValues {
	if (override === undefined) {
		return EMPTY_OVERRIDE_FORM;
	}
	return {
		enabled: toTriState(override.enabled),
		maxConcurrentInternationalCalls: toCeilingText(override.maxConcurrentInternationalCalls),
		maxInternationalMinutesPerHour: toCeilingText(override.maxInternationalMinutesPerHour),
		maxInternationalMinutesPerDay: toCeilingText(override.maxInternationalMinutesPerDay),
		holdFirstCallToNewCountry: toTriState(override.holdFirstCallToNewCountry),
		offHoursInternationalLock: toTriState(override.offHoursInternationalLock),
	};
}

/**
 * The form's values as the body `PUT /toll-fraud/overrides/:extensionId` takes.
 *
 * The two country lists are always `null` — inherited. This form does not offer them, and sending
 * anything else would clear a list an operator had set through the API, because the body is
 * complete rather than a patch.
 */
export function fromOverrideFormValues(
	values: TollFraudOverrideFormValues,
): WriteExtensionTollFraudOverride {
	return {
		enabled: fromTriState(values.enabled),
		maxConcurrentInternationalCalls: fromCeilingText(values.maxConcurrentInternationalCalls),
		maxInternationalMinutesPerHour: fromCeilingText(values.maxInternationalMinutesPerHour),
		maxInternationalMinutesPerDay: fromCeilingText(values.maxInternationalMinutesPerDay),
		allowedCountries: null,
		deniedCountries: null,
		holdFirstCallToNewCountry: fromTriState(values.holdFirstCallToNewCountry),
		offHoursInternationalLock: fromTriState(values.offHoursInternationalLock),
	};
}

/** Whether the form still says what the stored row says — the dialog's "send nothing" test. */
export function sameOverride(
	before: TollFraudOverrideFormValues,
	after: TollFraudOverrideFormValues,
): boolean {
	return (
		before.enabled === after.enabled &&
		before.maxConcurrentInternationalCalls.trim() ===
			after.maxConcurrentInternationalCalls.trim() &&
		before.maxInternationalMinutesPerHour.trim() === after.maxInternationalMinutesPerHour.trim() &&
		before.maxInternationalMinutesPerDay.trim() === after.maxInternationalMinutesPerDay.trim() &&
		before.holdFirstCallToNewCountry === after.holdFirstCallToNewCountry &&
		before.offHoursInternationalLock === after.offHoursInternationalLock
	);
}

/**
 * A ceiling box the API will accept, or the reason it will not.
 *
 * Checked here rather than left to the 400, because the dialog this sits in has five other sections
 * and a rejection naming `maxInternationalMinutesPerHour` does not point at any of them.
 */
export function overrideFieldErrors(
	values: TollFraudOverrideFormValues,
): Readonly<Record<string, string>> {
	const problems: Record<string, string> = {};
	const check = (key: keyof TollFraudOverrideFormValues, max: number) => {
		const raw = String(values[key]).trim();
		if (raw === "") {
			return;
		}
		if (!/^\d+$/u.test(raw) || Number(raw) > max) {
			problems[key] = `A whole number up to ${max.toLocaleString("en-US")}, or empty to inherit`;
		}
	};
	check("maxConcurrentInternationalCalls", 100_000);
	check("maxInternationalMinutesPerHour", 1_000_000);
	check("maxInternationalMinutesPerDay", 10_000_000);
	return problems;
}

function toTriState(value: boolean | null): TriState {
	if (value === null) {
		return "inherit";
	}
	return value ? "on" : "off";
}

function fromTriState(value: TriState): boolean | null {
	if (value === "inherit") {
		return null;
	}
	return value === "on";
}

function toCeilingText(value: number | null): string {
	return value === null ? "" : String(value);
}

/** `""` → `null` (inherit), never `0`. `"0"` → `0`, which is a ceiling of none. */
function fromCeilingText(value: string): number | null {
	const trimmed = value.trim();
	return trimmed === "" ? null : Number(trimmed);
}
