import { z } from "zod";
import { timezoneName } from "../pbx/schemas";
import { isResolvableCountry } from "./countries";
import type { TollFraudPolicy, WriteTollFraudPolicy } from "./client";

/**
 * The organization's toll-fraud policy, in the shape a form can hold.
 *
 * ## Why the conversion is here and not in the panel
 *
 * Three of the ceilings are nullable numbers, two of the fields are country lists, and the
 * off-hours window is two integers a person thinks of as clock times. Every one of those is a
 * projection with a wrong answer available — `""` sent as `0` is a ceiling of zero, which refuses
 * every international call, and an empty ALLOW list sent as `[]` instead of `null` is the same
 * outage by a different route. So it is a pair of pure functions with a spec, exactly as
 * `org-settings/routing-form.ts` is and for the same reason.
 *
 * ## `""` means "no ceiling", and only `null` says so on the wire
 *
 * `PUT /toll-fraud/policy` takes the COMPLETE policy: a `null` ceiling removes it, and there is no
 * encoding of "leave this one alone". An empty box therefore has to become `null` and never `0` —
 * `0` is a real value on this surface and means "no international calls at all", which is what an
 * administrator writes deliberately to stop a tenant, not what somebody means by clearing a field.
 *
 * The same rule, in the other direction, is why an empty country list becomes `null`: the API
 * stores both `[]` and `null` as NULL for exactly this reason, and sending `[]` on an allow list
 * would otherwise read as "allow nothing".
 */

/** The DTO's own ceilings in `toll-fraud.dto.ts`. Not policy — the largest values that are not typos. */
export const MAX_CONCURRENT_CEILING = 100_000;
export const MAX_MINUTES_PER_HOUR_CEILING = 1_000_000;
export const MAX_MINUTES_PER_DAY_CEILING = 10_000_000;

/** The DTO's cap on either country list. There are fewer countries than this. */
export const MAX_COUNTRY_LIST = 250;

/** 1439 is 23:59; there is no 24:00. Mirrors `minuteOfDay`. */
export const MAX_MINUTE_OF_DAY = 1_439;

export interface TollFraudPolicyFormValues {
	enabled: boolean;
	/** Numeric text: `""` is "no ceiling". See the note above on why it is never `0`. */
	maxConcurrentInternationalCalls: string;
	maxInternationalMinutesPerHour: string;
	maxInternationalMinutesPerDay: string;
	allowedCountries: string[];
	deniedCountries: string[];
	holdFirstCallToNewCountry: boolean;
	offHoursInternationalLock: boolean;
	/** `HH:MM`, because minutes-since-midnight is not a thing anybody types. */
	offHoursStart: string;
	offHoursEnd: string;
	/** `""` means "use the organization's routing default zone". */
	offHoursTimezone: string;
	autoSuspendOnSignal: boolean;
}

/**
 * A ceiling box: empty, or a whole number within the DTO's bound.
 *
 * Refusing the empty string would make "remove this ceiling" impossible, which is the operation the
 * API's `null` exists for — the same argument `optionalText` makes on the routing form.
 */
function ceilingText(max: number) {
	return z.string().refine(
		(value) => {
			if (value.trim() === "") {
				return true;
			}
			return /^\d+$/u.test(value.trim()) && Number(value.trim()) <= max;
		},
		{ message: `A whole number up to ${max.toLocaleString("en-US")}, or empty for no limit` },
	);
}

const countryListField = z
	.array(z.string())
	.max(MAX_COUNTRY_LIST, `At most ${MAX_COUNTRY_LIST} countries`)
	.refine((value) => value.every((code) => isResolvableCountry(code)), {
		message: "Every entry must be a country this platform can resolve a number to",
	});

const clockTime = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/u, "A 24-hour clock time, e.g. 20:00");

export const tollFraudPolicyFormSchema = z.object({
	enabled: z.boolean(),
	maxConcurrentInternationalCalls: ceilingText(MAX_CONCURRENT_CEILING),
	maxInternationalMinutesPerHour: ceilingText(MAX_MINUTES_PER_HOUR_CEILING),
	maxInternationalMinutesPerDay: ceilingText(MAX_MINUTES_PER_DAY_CEILING),
	allowedCountries: countryListField,
	deniedCountries: countryListField,
	holdFirstCallToNewCountry: z.boolean(),
	offHoursInternationalLock: z.boolean(),
	offHoursStart: clockTime,
	offHoursEnd: clockTime,
	offHoursTimezone: z
		.string()
		.refine((value) => value === "" || timezoneName.safeParse(value).success, {
			message: "Must be an IANA zone, e.g. Europe/Berlin",
		}),
	autoSuspendOnSignal: z.boolean(),
});

/**
 * What the form holds before the query resolves, and what a tenant with no policy row starts from.
 *
 * These repeat the COLUMN defaults in `packages/pbx-db/src/schema/toll-fraud-schema.ts` — 20:00 to
 * 07:00, everything else off and every ceiling absent — because that is what the API will store the
 * moment this form is first saved. Seeding anything else would make the first save silently write
 * values nobody chose.
 */
export const EMPTY_TOLL_FRAUD_POLICY_FORM: TollFraudPolicyFormValues = {
	enabled: true,
	maxConcurrentInternationalCalls: "",
	maxInternationalMinutesPerHour: "",
	maxInternationalMinutesPerDay: "",
	allowedCountries: [],
	deniedCountries: [],
	holdFirstCallToNewCountry: false,
	offHoursInternationalLock: false,
	offHoursStart: "20:00",
	offHoursEnd: "07:00",
	offHoursTimezone: "",
	autoSuspendOnSignal: false,
};

export function toPolicyFormValues(policy: TollFraudPolicy): TollFraudPolicyFormValues {
	return {
		enabled: policy.enabled,
		maxConcurrentInternationalCalls: ceilingToText(policy.maxConcurrentInternationalCalls),
		maxInternationalMinutesPerHour: ceilingToText(policy.maxInternationalMinutesPerHour),
		maxInternationalMinutesPerDay: ceilingToText(policy.maxInternationalMinutesPerDay),
		allowedCountries: sortedCodes(policy.allowedCountries),
		deniedCountries: sortedCodes(policy.deniedCountries),
		holdFirstCallToNewCountry: policy.holdFirstCallToNewCountry,
		offHoursInternationalLock: policy.offHoursInternationalLock,
		offHoursStart: minutesToClock(policy.offHoursStartMinute),
		offHoursEnd: minutesToClock(policy.offHoursEndMinute),
		offHoursTimezone: policy.offHoursTimezone ?? "",
		autoSuspendOnSignal: policy.autoSuspendOnSignal,
	};
}

/** The form's values as the complete body `PUT /toll-fraud/policy` takes. */
export function fromPolicyFormValues(values: TollFraudPolicyFormValues): WriteTollFraudPolicy {
	return {
		enabled: values.enabled,
		maxConcurrentInternationalCalls: textToCeiling(values.maxConcurrentInternationalCalls),
		maxInternationalMinutesPerHour: textToCeiling(values.maxInternationalMinutesPerHour),
		maxInternationalMinutesPerDay: textToCeiling(values.maxInternationalMinutesPerDay),
		allowedCountries: toCountryList(values.allowedCountries),
		deniedCountries: toCountryList(values.deniedCountries),
		holdFirstCallToNewCountry: values.holdFirstCallToNewCountry,
		offHoursInternationalLock: values.offHoursInternationalLock,
		offHoursStartMinute: clockToMinutes(values.offHoursStart),
		offHoursEndMinute: clockToMinutes(values.offHoursEnd),
		offHoursTimezone: values.offHoursTimezone.trim() === "" ? null : values.offHoursTimezone.trim(),
		autoSuspendOnSignal: values.autoSuspendOnSignal,
	};
}

/** The stored policy as a body, so a form can be diffed against what the API currently holds. */
export function policyToWrite(policy: TollFraudPolicy): WriteTollFraudPolicy {
	return fromPolicyFormValues(toPolicyFormValues(policy));
}

/**
 * Which keys of the policy the pending save would change.
 *
 * NOT used to build the request — `PUT` sends the whole body, and a diff-shaped body would remove
 * every ceiling it omitted. This exists only so the footer can say what is about to change and so
 * Save can go quiet when nothing is, which is the one thing `changedSettings` is also good for on
 * the routing form.
 */
export function changedPolicyKeys(
	loaded: WriteTollFraudPolicy,
	next: WriteTollFraudPolicy,
): readonly string[] {
	const before = loaded as unknown as Readonly<Record<string, unknown>>;
	const changed: string[] = [];
	for (const [name, value] of Object.entries(next)) {
		if (!samePolicyValue(before[name], value)) {
			changed.push(name);
		}
	}
	return changed;
}

function samePolicyValue(before: unknown, after: unknown): boolean {
	if (Array.isArray(before) && Array.isArray(after)) {
		return before.length === after.length && before.every((entry, index) => entry === after[index]);
	}
	return before === after;
}

function ceilingToText(value: number | null): string {
	return value === null ? "" : String(value);
}

/** `""` → `null`, never `0`. See the header: `0` is a real value meaning "none at all". */
function textToCeiling(value: string): number | null {
	const trimmed = value.trim();
	return trimmed === "" ? null : Number(trimmed);
}

/**
 * Sorted, de-duplicated, upper-cased — and `null` when the result is empty.
 *
 * Sorting is what stops {@link changedPolicyKeys} reporting a change nobody made when a chip is
 * removed and re-added; the empty case collapses to `null` because an empty ALLOW list would refuse
 * every international call, and nobody who cleared a field meant that.
 */
export function toCountryList(codes: readonly string[]): readonly string[] | null {
	const normalized = [...new Set(codes.map((code) => code.trim().toUpperCase()))]
		.filter((code) => code.length > 0)
		.sort();
	return normalized.length === 0 ? null : normalized;
}

function sortedCodes(codes: readonly string[] | null): string[] {
	return codes === null ? [] : [...new Set(codes.map((code) => code.toUpperCase()))].sort();
}

/** Minutes since local midnight as `HH:MM`. Out-of-range input is clamped rather than thrown on. */
export function minutesToClock(minutes: number): string {
	const bounded = Math.min(Math.max(Math.trunc(minutes), 0), MAX_MINUTE_OF_DAY);
	const hours = Math.floor(bounded / 60);
	return `${String(hours).padStart(2, "0")}:${String(bounded % 60).padStart(2, "0")}`;
}

/** `HH:MM` as minutes since local midnight. Anything unparseable is midnight — the schema refuses it first. */
export function clockToMinutes(value: string): number {
	const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
	if (match === null) {
		return 0;
	}
	const minutes = Number(match[1]) * 60 + Number(match[2]);
	return Math.min(Math.max(minutes, 0), MAX_MINUTE_OF_DAY);
}
