import { z } from "zod/v4";
import { knownCountries } from "./e164-country";

/**
 * Bodies for `/api/v1/toll-fraud`.
 *
 * The organization policy is a SINGLETON reached without an id, exactly like `/api/v1/org-limits`
 * and for the same reason: there is one row per organization, and an id would be a detail of this
 * table every caller would have to fetch before it could write. `PUT` rather than `PATCH`, because
 * the body is the complete set of controls and a partial one would make "remove this ceiling" and
 * "leave this ceiling alone" the same request.
 *
 * The per-extension override is a collection keyed on the extension, and it is a `PUT` on that key
 * for the same reason — an override is a small, complete statement of one phone's departures, and
 * merging one field at a time into it is how somebody ends up with a ceiling they did not set.
 */

const COUNTRIES: ReadonlySet<string> = new Set(knownCountries());

/**
 * One ISO-3166 alpha-2 code this platform can actually resolve a number to.
 *
 * Checked against `e164-country.ts`'s own table rather than against the ISO list, and that is the
 * point: a country the resolver cannot produce is a country no call will ever match, so an allow
 * list containing it is a rule that silently does nothing. Refusing it at write time turns a
 * support ticket ("we allowed Kosovo and it still blocks") into a 400 naming the code.
 */
const countryCode = z
	.string()
	.trim()
	.toUpperCase()
	.refine((value) => COUNTRIES.has(value), {
		message: "must be an ISO-3166 alpha-2 country this platform can resolve a number to",
	});

/**
 * A country list.
 *
 * Capped at 250 — there are fewer countries than that — so an attacker-chosen array cannot become a
 * jsonb column the compiler then sorts on every artifact build. `null` clears the list, and the
 * distinction from an empty array is deliberate: both mean "no list", and both are stored as NULL,
 * because an empty ALLOW list would refuse every international call and nobody who cleared a field
 * meant that. The schema column records the same reasoning.
 */
const countryList = z.array(countryCode).max(250).nullish();

/**
 * A ceiling. `null` removes it; there is no default to reset to, because unlimited IS the default.
 *
 * The upper bounds are not policy — they are the largest values that are not obviously a typo. A
 * hundred thousand simultaneous international calls is larger than any tenant this platform will
 * hold, and half a million minutes a day is more minutes than a day contains at any headcount.
 */
const ceiling = (max: number) => z.int().min(0).max(max).nullish();

/** Minutes since local midnight. 1439 is 23:59; there is no 24:00. */
const minuteOfDay = z.int().min(0).max(1_439);

/**
 * An IANA zone name, shape-checked only.
 *
 * Deliberately not validated against `Intl`: the runtime's zone database is a property of the image,
 * a zone this process does not know may be perfectly real on the next release, and refusing it here
 * would make a tenant's configuration depend on when they saved it. The decision function already
 * degrades an unknown zone to "do not lock", which is the direction that leaves the tenant where
 * they were.
 */
const timezone = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/u, "must be an IANA time zone name");

export const writeTollFraudPolicyDto = z.strictObject({
	enabled: z.boolean().optional(),
	maxConcurrentInternationalCalls: ceiling(100_000),
	maxInternationalMinutesPerHour: ceiling(1_000_000),
	maxInternationalMinutesPerDay: ceiling(10_000_000),
	allowedCountries: countryList,
	deniedCountries: countryList,
	holdFirstCallToNewCountry: z.boolean().optional(),
	offHoursInternationalLock: z.boolean().optional(),
	offHoursStartMinute: minuteOfDay.optional(),
	offHoursEndMinute: minuteOfDay.optional(),
	offHoursTimezone: timezone.nullish(),
	autoSuspendOnSignal: z.boolean().optional(),
});

export type WriteTollFraudPolicy = z.output<typeof writeTollFraudPolicyDto>;

/**
 * One extension's override.
 *
 * Every field nullish and `null` means INHERIT, which is the opposite of what `null` means on the
 * organization body one block up. That asymmetry is real rather than an oversight: on the org policy
 * there is nothing above to inherit from, so `null` can only mean "no ceiling"; on an override the
 * whole point of the row is that most of it defers. `0` is the value that means "none at all" here,
 * and it is what an administrator writes to stop one compromised phone without touching anybody
 * else's ceilings.
 */
export const writeExtensionTollFraudOverrideDto = z.strictObject({
	enabled: z.boolean().nullish(),
	maxConcurrentInternationalCalls: ceiling(100_000),
	maxInternationalMinutesPerHour: ceiling(1_000_000),
	maxInternationalMinutesPerDay: ceiling(10_000_000),
	allowedCountries: countryList,
	deniedCountries: countryList,
	holdFirstCallToNewCountry: z.boolean().nullish(),
	offHoursInternationalLock: z.boolean().nullish(),
});

export type WriteExtensionTollFraudOverride = z.output<typeof writeExtensionTollFraudOverrideDto>;

/**
 * Suspending or restoring one extension's outbound calling.
 *
 * Its own endpoint rather than a field on the override body, because it is a different ACT with a
 * different lifecycle: an override is configuration somebody tunes, and a suspension is an incident
 * response somebody takes at speed and reverses when the investigation closes. Folding it in would
 * mean that restoring a phone requires resending every ceiling that phone happens to have.
 */
export const suspendExtensionOutboundDto = z.strictObject({
	suspended: z.boolean(),
	/** Shown to whoever finds the phone dead. Required on a suspend, ignored on a restore. */
	reason: z.string().trim().min(1).max(256).optional(),
});

export type SuspendExtensionOutbound = z.output<typeof suspendExtensionOutboundDto>;
