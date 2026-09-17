import { normalizeE164, resolveE164Country } from "./e164-country";

/**
 * The toll-fraud decision: one pure function, no database, no clock of its own.
 *
 * ## Why it is a function and not a service
 *
 * Two processes have to reach the same verdict from the same facts. `apps/api` evaluates it on the
 * click-to-call path, where it has a session and a database; `apps/engine` will evaluate it at dial
 * time, where it has neither — it holds the compiled artifact and whatever the shared counter told
 * it. A verdict that lived inside a Nest service could only ever be reached by the first of those,
 * and the second would grow a second implementation that drifts.
 *
 * So everything this needs is an ARGUMENT: the policy (from the artifact, or from the row), the
 * counters (from the shared window), the dialled number, the instant, and the countries already
 * seen. Nothing is fetched here, nothing is written, and the result is a verdict rather than an
 * exception — because the two callers do different things with it. The API turns it into a 4xx and
 * a webhook; the engine turns it into a hangup cause.
 *
 * ## The order the rules are evaluated in, and why it is not arbitrary
 *
 * ```text
 * 1. not international            → allow, immediately
 * 2. destination country blocked  → DESTINATION_COUNTRY_BLOCKED
 * 3. off-hours lock               → OFF_HOURS_INTERNATIONAL_LOCK
 * 4. first call to a new country  → NEW_COUNTRY_HOLD
 * 5. concurrency ceiling          → INTERNATIONAL_CONCURRENCY_EXCEEDED
 * 6. minutes ceilings             → INTERNATIONAL_MINUTES_EXCEEDED
 * ```
 *
 * Cheapest and most CERTAIN first. A geo block is a statement about a destination and is true
 * whatever else is going on; a minutes ceiling is a statement about an approximate rolling count and
 * is the one most likely to be argued with. When a call trips two rules the caller is told about the
 * one they can act on — "we do not call Latvia" is an answer, "you have used 61 of your 60 minutes"
 * is a different conversation — and reporting the geo block for a call that also happened to be at
 * 03:00 is the more useful of the two.
 *
 * ## What "international" means here
 *
 * The destination resolves to a country that is not {@link TollFraudInput.homeCountry}, OR it does
 * not resolve at all. The second half is the one worth stating: an unresolvable E.164 prefix is a
 * global network, a satellite range or an audiotext code, which is the exact shape of a
 * revenue-share fraud number. Treating it as domestic would put the single highest-risk category of
 * destination outside every control on this page.
 *
 * A number that is not E.164 at all — an extension, a feature code, a bare national string the dial
 * plan has not canonicalised — is NOT international and is allowed. That is not a hole: those never
 * reach a carrier, and a control that started refusing internal calls because a number lacked a `+`
 * would be switched off within a day.
 */

/** Why a call was refused. Every value is stable and reaches the tenant verbatim. */
export const TOLL_FRAUD_REFUSAL_REASONS = [
	"DESTINATION_COUNTRY_BLOCKED",
	"OFF_HOURS_INTERNATIONAL_LOCK",
	"NEW_COUNTRY_HOLD",
	"INTERNATIONAL_CONCURRENCY_EXCEEDED",
	"INTERNATIONAL_MINUTES_EXCEEDED",
	"EXTENSION_OUTBOUND_SUSPENDED",
] as const;

export type TollFraudRefusalReason = (typeof TOLL_FRAUD_REFUSAL_REASONS)[number];

/**
 * The ceilings and rules, already merged across the organization policy and any per-extension
 * override. Identical in shape to `CompiledTollFraudPolicy` in `@optimiq-voice/routing`, restated
 * here because this file must not depend on the routing package to be usable by both callers.
 */
export interface TollFraudPolicy {
	readonly enabled: boolean;
	readonly maxConcurrentInternationalCalls?: number | undefined;
	readonly maxInternationalMinutesPerHour?: number | undefined;
	readonly maxInternationalMinutesPerDay?: number | undefined;
	/** ISO-3166 alpha-2, upper case. Non-empty means "only these". */
	readonly allowedCountries?: readonly string[] | undefined;
	readonly deniedCountries?: readonly string[] | undefined;
	readonly holdFirstCallToNewCountry?: boolean | undefined;
	readonly offHoursInternationalLock?: boolean | undefined;
	/** Minutes since local midnight. `start > end` wraps midnight, which is the ordinary case. */
	readonly offHoursStartMinute?: number | undefined;
	readonly offHoursEndMinute?: number | undefined;
	/** The zone the two offsets are read in. Falls back to {@link TollFraudInput.timezone}. */
	readonly offHoursTimezone?: string | undefined;
	/** Set by the detector or by an administrator; refuses every outbound call, not only overseas. */
	readonly outboundSuspended?: boolean | undefined;
}

/** What the counters currently say. Every field is the caller's to supply; nothing is fetched. */
export interface TollFraudCounters {
	/** Live international legs this extension (or organization) is holding right now. */
	readonly concurrentInternationalCalls: number;
	/** Approximate international minutes in the last rolling hour, and the last rolling day. */
	readonly internationalMinutesLastHour: number;
	readonly internationalMinutesLastDay: number;
}

export interface TollFraudInput {
	readonly policy: TollFraudPolicy;
	readonly counters: TollFraudCounters;
	/** The destination as the dial plan canonicalised it. Not E.164 means "not international". */
	readonly dialedE164: string;
	readonly nowUtc: Date;
	/** The organization's IANA zone, for the off-hours window when the policy names no zone. */
	readonly timezone: string;
	/**
	 * The organization's own country, ISO-3166 alpha-2. A destination in it is domestic and every
	 * rule here is skipped.
	 *
	 * Absent means the tenant has set no default calling code, in which case NOTHING is domestic and
	 * every E.164 destination is evaluated. That is the fail-closed reading and it is deliberate: the
	 * alternative — assume `US` — would silently exempt American destinations for a tenant whose
	 * configuration says nothing about where they are.
	 */
	readonly homeCountry?: string | undefined;
	/**
	 * Countries this organization has already been observed calling, upper case.
	 *
	 * An EMPTY set means "nothing learned yet" and suppresses {@link
	 * TOLL_FRAUD_REFUSAL_REASONS} `NEW_COUNTRY_HOLD` entirely — see {@link evaluateTollFraud} for
	 * why, which is the one piece of this file that is a judgement rather than a comparison.
	 */
	readonly seenCountries: ReadonlySet<string>;
}

/**
 * Allowed, or refused with a reason and the evidence behind it.
 *
 * A FLAT interface with an optional `reason` rather than the discriminated union this obviously
 * wants to be, and the reason is mechanical rather than a preference: `apps/api`'s tooling tsconfig
 * still relaxes `strictNullChecks` for its legacy files, and without it TypeScript does not narrow a
 * union on a boolean discriminant — so `if (verdict.allowed) return;` compiles and then every field
 * access after it is an error on the un-narrowed union. A union that cannot be narrowed at its own
 * call sites is worse than a flat shape with a documented invariant.
 *
 * The invariant: `reason` is present exactly when `allowed` is false, and `observed`/`threshold`
 * are present only on the two refusals that compare a number against a ceiling.
 */
export interface TollFraudVerdict {
	readonly allowed: boolean;
	/** Present exactly when `allowed` is false. */
	readonly reason?: TollFraudRefusalReason;
	/** Whether the destination was treated as international at all. */
	readonly international: boolean;
	readonly country?: string;
	/** The number that crossed the line, and the line, when the rule has one. */
	readonly observed?: number;
	readonly threshold?: number;
}

/**
 * The verdict. Pure: same inputs, same answer, on every process.
 *
 * ## The empty seen-set, which is the one judgement here
 *
 * `holdFirstCallToNewCountry` compares the destination against the countries this organization has
 * been seen calling. On the day a tenant switches it on, that set is empty — every destination is
 * "new", and a literal reading would hold the tenant's entire overseas dial plan at once. Nobody
 * would leave the control on past that morning.
 *
 * So an EMPTY set means "nothing learned yet" and the hold does not fire; the country is recorded by
 * the caller and the hold begins from the second distinct country onward. That leaves exactly one
 * destination unheld per tenant per activation, which is the price of a control people actually
 * keep switched on. It is stated here rather than in the caller because it is testable here.
 */
export function evaluateTollFraud(input: TollFraudInput): TollFraudVerdict {
	const { policy, counters } = input;

	if (policy.outboundSuspended === true) {
		// Ahead of the enabled check: a suspension is an INCIDENT response, and lifting the master
		// switch during an incident must not un-suspend the handset somebody suspended because of it.
		return {
			allowed: false,
			reason: "EXTENSION_OUTBOUND_SUSPENDED",
			international: true,
			...countryField(input.dialedE164),
		};
	}
	if (!policy.enabled) {
		return { allowed: true, international: false };
	}

	const digits = normalizeE164(input.dialedE164);
	if (digits === undefined) {
		// An extension, a feature code, or a number the dial plan has not canonicalised. None of
		// these reach a carrier. See the header.
		return { allowed: true, international: false };
	}
	const country = resolveE164Country(input.dialedE164);
	if (country !== undefined && country === input.homeCountry) {
		return { allowed: true, international: false, country };
	}

	const refusal = (
		reason: TollFraudRefusalReason,
		evidence?: { readonly observed: number; readonly threshold: number },
	): TollFraudVerdict => ({
		allowed: false,
		reason,
		international: true,
		...(country === undefined ? {} : { country }),
		...evidence,
	});

	// 2. Geo. The allow list wins when both are set: a destination not on an allow list is refused
	//    whatever the deny list says, which is the fail-closed reading of two lists that disagree.
	//    An unresolvable country cannot be on either list and is therefore refused by an allow list
	//    and passed by a deny list — which is right in both directions: an allow list is an
	//    enumeration of what is permitted, and a global-network prefix is not in it.
	const allowed = nonEmpty(policy.allowedCountries);
	if (allowed !== undefined && (country === undefined || !allowed.includes(country))) {
		return refusal("DESTINATION_COUNTRY_BLOCKED");
	}
	const denied = nonEmpty(policy.deniedCountries);
	if (denied !== undefined && country !== undefined && denied.includes(country)) {
		return refusal("DESTINATION_COUNTRY_BLOCKED");
	}

	// 3. Off hours.
	if (
		policy.offHoursInternationalLock === true &&
		isWithinOffHours(
			input.nowUtc,
			policy.offHoursTimezone ?? input.timezone,
			policy.offHoursStartMinute ?? DEFAULT_OFF_HOURS_START,
			policy.offHoursEndMinute ?? DEFAULT_OFF_HOURS_END,
		)
	) {
		return refusal("OFF_HOURS_INTERNATIONAL_LOCK");
	}

	// 4. First call to a country nobody here has called before. See the header for the empty set.
	if (
		policy.holdFirstCallToNewCountry === true &&
		input.seenCountries.size > 0 &&
		(country === undefined || !input.seenCountries.has(country))
	) {
		return refusal("NEW_COUNTRY_HOLD");
	}

	// 5. Concurrency. `>=` because the leg being evaluated is not yet counted: at the ceiling, the
	//    next one is the one that exceeds it.
	const concurrency = policy.maxConcurrentInternationalCalls;
	if (concurrency !== undefined && counters.concurrentInternationalCalls >= concurrency) {
		return refusal("INTERNATIONAL_CONCURRENCY_EXCEEDED", {
			observed: counters.concurrentInternationalCalls,
			threshold: concurrency,
		});
	}

	// 6. Minutes. The HOUR is checked before the DAY: a tenant who has burnt both is told about the
	//    one that clears first, which is the difference between "try again after lunch" and "try
	//    again tomorrow".
	const hourly = policy.maxInternationalMinutesPerHour;
	if (hourly !== undefined && counters.internationalMinutesLastHour >= hourly) {
		return refusal("INTERNATIONAL_MINUTES_EXCEEDED", {
			observed: counters.internationalMinutesLastHour,
			threshold: hourly,
		});
	}
	const daily = policy.maxInternationalMinutesPerDay;
	if (daily !== undefined && counters.internationalMinutesLastDay >= daily) {
		return refusal("INTERNATIONAL_MINUTES_EXCEEDED", {
			observed: counters.internationalMinutesLastDay,
			threshold: daily,
		});
	}

	return { allowed: true, international: true, ...(country === undefined ? {} : { country }) };
}

/** 20:00 and 07:00, the window the schema defaults to. Restated so the pure path needs no row. */
export const DEFAULT_OFF_HOURS_START = 1_200;
export const DEFAULT_OFF_HOURS_END = 420;

/**
 * Whether `nowUtc`, read in `timezone`, falls inside `[start, end)` minutes since local midnight.
 *
 * Handles the WRAPPING case — `start > end`, which is 20:00 → 07:00 and is what every office
 * actually configures — by inverting the comparison rather than by splitting into two ranges. A
 * window where `start === end` is treated as empty rather than as "all day": a tenant who typed the
 * same value twice did not mean to lock international calling permanently, and the reading that
 * assumes they did is the one they discover from a support ticket.
 */
export function isWithinOffHours(
	nowUtc: Date,
	timezone: string,
	startMinute: number,
	endMinute: number,
): boolean {
	if (startMinute === endMinute) {
		return false;
	}
	const local = minuteOfDayIn(nowUtc, timezone);
	if (local === undefined) {
		// An unknown zone must not silently lock or unlock the tenant. Not locking is the direction
		// that leaves them where they were; the compiler already refuses to carry an unknown zone.
		return false;
	}
	return startMinute < endMinute
		? local >= startMinute && local < endMinute
		: local >= startMinute || local < endMinute;
}

/**
 * Minutes since local midnight in `timezone`, or `undefined` if the runtime does not know the zone.
 *
 * `Intl.DateTimeFormat` rather than an offset table, because the window has to survive a DST
 * transition: an office that locks at 20:00 locks at 20:00 in July as well as in January, and an
 * offset computed once would be an hour out for half the year.
 */
function minuteOfDayIn(instant: Date, timezone: string): number | undefined {
	try {
		const parts = new Intl.DateTimeFormat("en-GB", {
			timeZone: timezone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).formatToParts(instant);
		const hour = Number(parts.find((part) => part.type === "hour")?.value);
		const minute = Number(parts.find((part) => part.type === "minute")?.value);
		if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
			return undefined;
		}
		return hour * 60 + minute;
	} catch {
		return undefined;
	}
}

/** The list, upper-cased, or `undefined` when it is absent or empty. See the schema for why. */
function nonEmpty(list: readonly string[] | undefined): readonly string[] | undefined {
	if (list === undefined || list.length === 0) {
		return undefined;
	}
	return list.map((entry) => entry.trim().toUpperCase());
}

function countryField(dialed: string): { readonly country?: string } {
	const country = resolveE164Country(dialed);
	return country === undefined ? {} : { country };
}

/**
 * The organization policy and one extension's override, merged into the single policy the decision
 * function takes.
 *
 * Three-valued throughout: `null`/absent on the override inherits, a number replaces, and `0`
 * replaces with "none at all" — which is how one extension is locked down without editing the
 * policy every other extension depends on. `ceilingOf` therefore does NOT treat zero as unlimited
 * here, unlike the compiler, and the difference is deliberate: on the ORG policy a zero is a typo in
 * a quota field, while on an OVERRIDE it is the only way to say "this specific phone, none".
 *
 * `enabled: false` on the override wins over an enabled organization; `true` on the override cannot
 * re-enable an organization that has switched everything off, because that would make the org's
 * master switch a lie. Same for the two boolean holds: an override may only ever LOOSEN them, which
 * is what an exception is for.
 */
export function mergeTollFraudPolicy(
	organization: TollFraudPolicy | undefined,
	override: TollFraudOverride | undefined,
): TollFraudPolicy {
	const base: TollFraudPolicy = organization ?? { enabled: false };
	if (override === undefined) {
		return base;
	}
	return {
		enabled: base.enabled && override.enabled !== false,
		maxConcurrentInternationalCalls: pick(
			override.maxConcurrentInternationalCalls,
			base.maxConcurrentInternationalCalls,
		),
		maxInternationalMinutesPerHour: pick(
			override.maxInternationalMinutesPerHour,
			base.maxInternationalMinutesPerHour,
		),
		maxInternationalMinutesPerDay: pick(
			override.maxInternationalMinutesPerDay,
			base.maxInternationalMinutesPerDay,
		),
		allowedCountries: pick(override.allowedCountries, base.allowedCountries),
		deniedCountries: pick(override.deniedCountries, base.deniedCountries),
		// A hold the override says nothing about is inherited; `false` lifts it, `true` cannot add it.
		holdFirstCallToNewCountry:
			override.holdFirstCallToNewCountry === false ? false : base.holdFirstCallToNewCountry,
		offHoursInternationalLock:
			override.offHoursInternationalLock === false ? false : base.offHoursInternationalLock,
		offHoursStartMinute: base.offHoursStartMinute,
		offHoursEndMinute: base.offHoursEndMinute,
		offHoursTimezone: base.offHoursTimezone,
		outboundSuspended: override.outboundSuspended === true,
	};
}

/** One extension's departures. Every field `null`/absent inherits; see {@link mergeTollFraudPolicy}. */
export interface TollFraudOverride {
	readonly enabled?: boolean | null;
	readonly maxConcurrentInternationalCalls?: number | null;
	readonly maxInternationalMinutesPerHour?: number | null;
	readonly maxInternationalMinutesPerDay?: number | null;
	readonly allowedCountries?: readonly string[] | null;
	readonly deniedCountries?: readonly string[] | null;
	readonly holdFirstCallToNewCountry?: boolean | null;
	readonly offHoursInternationalLock?: boolean | null;
	readonly outboundSuspended?: boolean | null;
}

function pick<T>(override: T | null | undefined, base: T | undefined): T | undefined {
	return override === null || override === undefined ? base : override;
}
