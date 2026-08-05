/**
 * Time conditions: business hours, holidays, night mode — evaluated in the tenant's own zone.
 *
 * # The clock is always an argument
 *
 * Nothing in this module reads `Date.now()`. Every entry point takes the instant to evaluate,
 * because "did this call arrive during business hours?" must be answerable identically by the
 * engine at 09:00, by a support engineer replaying it at 17:00, and by a test at any time. A
 * routing decision that cannot be reproduced cannot be explained to a customer.
 *
 * # Zones without a dependency
 *
 * `Intl.DateTimeFormat(zone).formatToParts(instant)` is the platform's IANA database, and it is
 * the only correct way to get a wall clock: it applies whatever offset was in force *at that
 * instant*, including historical rule changes. Adding a date library here would buy nothing except
 * a second, staler copy of the same data.
 *
 * # DST, stated explicitly
 *
 * Wall-clock windows are evaluated against the local wall clock, which is what a human means by
 * "we open at 09:00". The consequences are deliberate and pinned by tests:
 *
 * - **Spring forward** — 02:00–02:59 does not exist on the transition day in `America/New_York`.
 *   A window of 02:00–02:59 simply never matches that day. It is not silently shifted to 03:00,
 *   because a business that opens at 02:00 has bigger problems than routing.
 * - **Fall back** — 01:00–01:59 happens twice. A window covering it matches during both passes.
 *   Two distinct instants, one wall clock, both inside the stated window: matching both is the
 *   only answer consistent with "we are open 01:00–02:00".
 * - An **overnight** window (`from > to`, e.g. 22:00–06:00) is the union of `[from, 24:00)` and
 *   `[00:00, to]`. Both halves are evaluated against the same day's other predicates, so
 *   "Fridays 22:00–06:00" means *Friday* evening plus *Friday* small hours — not Saturday's. That
 *   is the reading FreeSWITCH's `time-of-day` gives, and changing it would move a night-shift
 *   route by a day.
 */

import type { TimeRulePredicateInput } from "./snapshot";

/** A `HH:MM` 24-hour wall clock, inclusive at both ends of a window. */
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A `YYYY-MM-DD` local calendar date. */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The zoned wall clock at one instant. Every field is local to the condition's timezone. */
export interface ZonedInstant {
	readonly year: number;
	/** 1–12. */
	readonly month: number;
	/** 1–31. */
	readonly day: number;
	/** 0–23. */
	readonly hour: number;
	/** 0–59. */
	readonly minute: number;
	/** ISO weekday, 1 = Monday … 7 = Sunday. */
	readonly weekday: number;
	/** 1–5, counting from the first of the month in blocks of seven days. */
	readonly weekOfMonth: number;
	/** Minutes since local midnight; the comparison unit for wall-clock windows. */
	readonly minuteOfDay: number;
	/** `YYYY-MM-DD`, for date-range comparison as a plain string. */
	readonly date: string;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
	Sun: 7,
};

/**
 * Formatters are expensive to construct and immutable once built, so they are memoised per zone.
 * The map is bounded by the number of distinct tenant timezones in a process, which is small and
 * does not grow with call volume.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
	const hit = formatterCache.get(timezone);
	if (hit !== undefined) {
		return hit;
	}
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		// `hourCycle: "h23"` rather than `hour12: false`: the latter renders midnight as `24` on
		// some engines, which would put every midnight call an hour past the end of the day.
		hourCycle: "h23",
		hour: "2-digit",
		minute: "2-digit",
		weekday: "short",
	});
	formatterCache.set(timezone, formatter);
	return formatter;
}

/** Whether this runtime's ICU data knows the zone. Used by the validation pass. */
export function isKnownTimezone(timezone: string): boolean {
	try {
		void new Intl.DateTimeFormat("en-US", { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
}

/** Projects an instant into a tenant's zone. Throws only if the zone is unknown to this runtime. */
export function zonedInstant(instant: Date, timezone: string): ZonedInstant {
	const parts = formatterFor(timezone).formatToParts(instant);
	let year = 0;
	let month = 0;
	let day = 0;
	let hour = 0;
	let minute = 0;
	let weekday = 1;

	for (const part of parts) {
		switch (part.type) {
			case "year": {
				year = Number.parseInt(part.value, 10);
				break;
			}
			case "month": {
				month = Number.parseInt(part.value, 10);
				break;
			}
			case "day": {
				day = Number.parseInt(part.value, 10);
				break;
			}
			case "hour": {
				hour = Number.parseInt(part.value, 10) % 24;
				break;
			}
			case "minute": {
				minute = Number.parseInt(part.value, 10);
				break;
			}
			case "weekday": {
				weekday = WEEKDAY_INDEX[part.value] ?? 1;
				break;
			}
			default: {
				break;
			}
		}
	}

	return {
		year,
		month,
		day,
		hour,
		minute,
		weekday,
		weekOfMonth: Math.floor((day - 1) / 7) + 1,
		minuteOfDay: hour * 60 + minute,
		date: `${pad4(year)}-${pad2(month)}-${pad2(day)}`,
	};
}

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

function pad4(value: number): string {
	return String(value).padStart(4, "0");
}

/** A validated predicate as it lives in the artifact. Same shape as the input, minus the doubt. */
export interface CompiledTimePredicate {
	readonly weekdays?: readonly number[];
	readonly monthDays?: readonly number[];
	readonly months?: readonly number[];
	readonly weeksOfMonth?: readonly number[];
	readonly timeOfDay?: { readonly from: string; readonly to: string };
	readonly dateRange?: { readonly from: string; readonly to: string };
}

export interface CompiledTimeRule {
	readonly id: string;
	readonly ordinal: number;
	readonly label?: string;
	/** Every predicate must match; an empty list matches everything ("always"). */
	readonly predicates: readonly CompiledTimePredicate[];
}

export type TimePredicateIssue =
	| { readonly code: "weekday-out-of-range"; readonly value: number }
	| { readonly code: "month-day-out-of-range"; readonly value: number }
	| { readonly code: "month-out-of-range"; readonly value: number }
	| { readonly code: "week-of-month-out-of-range"; readonly value: number }
	| { readonly code: "malformed-time-of-day"; readonly value: string }
	| { readonly code: "malformed-date"; readonly value: string }
	| { readonly code: "inverted-date-range"; readonly from: string; readonly to: string }
	| { readonly code: "empty-list"; readonly field: string };

/**
 * Validates one predicate. Returns every problem, not the first, so a tenant fixing a holiday rule
 * sees all of it at once.
 *
 * An empty list (`weekdays: []`) is an error rather than "matches nothing": it is always a bug in
 * the form that produced it, and treating it as "never" would turn a UI slip into a silently dead
 * route.
 */
export function validateTimePredicate(
	predicate: TimeRulePredicateInput,
): readonly TimePredicateIssue[] {
	const issues: TimePredicateIssue[] = [];

	checkList(predicate.weekdays, "weekdays", 1, 7, issues, "weekday-out-of-range");
	checkList(predicate.monthDays, "monthDays", 1, 31, issues, "month-day-out-of-range");
	checkList(predicate.months, "months", 1, 12, issues, "month-out-of-range");
	checkList(predicate.weeksOfMonth, "weeksOfMonth", 1, 5, issues, "week-of-month-out-of-range");

	if (predicate.timeOfDay !== undefined) {
		for (const value of [predicate.timeOfDay.from, predicate.timeOfDay.to]) {
			if (!TIME_OF_DAY_PATTERN.test(value)) {
				issues.push({ code: "malformed-time-of-day", value });
			}
		}
	}

	if (predicate.dateRange !== undefined) {
		const { from, to } = predicate.dateRange;
		let wellFormed = true;
		for (const value of [from, to]) {
			if (!isCalendarDate(value)) {
				issues.push({ code: "malformed-date", value });
				wellFormed = false;
			}
		}
		if (wellFormed && from > to) {
			// Dates, unlike wall-clock windows, do not wrap: a holiday that ends before it starts is
			// a typo, and silently swapping the ends would hide it.
			issues.push({ code: "inverted-date-range", from, to });
		}
	}

	return issues;
}

function checkList(
	values: readonly number[] | undefined,
	field: string,
	min: number,
	max: number,
	issues: TimePredicateIssue[],
	code:
		| "weekday-out-of-range"
		| "month-day-out-of-range"
		| "month-out-of-range"
		| "week-of-month-out-of-range",
): void {
	if (values === undefined) {
		return;
	}
	if (values.length === 0) {
		issues.push({ code: "empty-list", field });
		return;
	}
	for (const value of values) {
		if (!Number.isInteger(value) || value < min || value > max) {
			issues.push({ code, value });
		}
	}
}

function isCalendarDate(value: string): boolean {
	const match = DATE_PATTERN.exec(value);
	if (match === null) {
		return false;
	}
	const month = Number.parseInt(match[2] as string, 10);
	const day = Number.parseInt(match[3] as string, 10);
	if (month < 1 || month > 12 || day < 1 || day > 31) {
		return false;
	}
	// Reject 31 April and friends, but stay permissive about 29 February: a leap-day holiday is
	// legitimate and the string comparison used at match time handles it without a calendar.
	const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return day <= (daysInMonth[month - 1] as number);
}

/** Normalises a validated predicate into artifact form: sorted, deduplicated lists. */
export function compileTimePredicate(predicate: TimeRulePredicateInput): CompiledTimePredicate {
	const compiled: {
		weekdays?: readonly number[];
		monthDays?: readonly number[];
		months?: readonly number[];
		weeksOfMonth?: readonly number[];
		timeOfDay?: { from: string; to: string };
		dateRange?: { from: string; to: string };
	} = {};

	if (predicate.weekdays !== undefined) {
		compiled.weekdays = sortedUnique(predicate.weekdays);
	}
	if (predicate.monthDays !== undefined) {
		compiled.monthDays = sortedUnique(predicate.monthDays);
	}
	if (predicate.months !== undefined) {
		compiled.months = sortedUnique(predicate.months);
	}
	if (predicate.weeksOfMonth !== undefined) {
		compiled.weeksOfMonth = sortedUnique(predicate.weeksOfMonth);
	}
	if (predicate.timeOfDay !== undefined) {
		compiled.timeOfDay = { from: predicate.timeOfDay.from, to: predicate.timeOfDay.to };
	}
	if (predicate.dateRange !== undefined) {
		compiled.dateRange = { from: predicate.dateRange.from, to: predicate.dateRange.to };
	}
	return compiled;
}

function sortedUnique(values: readonly number[]): readonly number[] {
	return [...new Set(values)].sort((left, right) => left - right);
}

function minuteOfDayOf(value: string): number {
	const match = TIME_OF_DAY_PATTERN.exec(value);
	if (match === null) {
		return Number.NaN;
	}
	return Number.parseInt(match[1] as string, 10) * 60 + Number.parseInt(match[2] as string, 10);
}

/** Whether a wall-clock window covers `minuteOfDay`. Handles windows that cross midnight. */
export function timeOfDayMatches(
	window: { readonly from: string; readonly to: string },
	minuteOfDay: number,
): boolean {
	const from = minuteOfDayOf(window.from);
	const to = minuteOfDayOf(window.to);
	if (Number.isNaN(from) || Number.isNaN(to)) {
		return false;
	}
	// Both ends inclusive: "09:00 to 17:00" includes a call that arrives at 17:00:30, which is what
	// a receptionist means. Half-open would drop the last minute of every business day.
	return from <= to
		? minuteOfDay >= from && minuteOfDay <= to
		: minuteOfDay >= from || minuteOfDay <= to;
}

/** Whether every field of a predicate matches the zoned instant. */
export function predicateMatches(predicate: CompiledTimePredicate, at: ZonedInstant): boolean {
	if (predicate.weekdays !== undefined && !predicate.weekdays.includes(at.weekday)) {
		return false;
	}
	if (predicate.monthDays !== undefined && !predicate.monthDays.includes(at.day)) {
		return false;
	}
	if (predicate.months !== undefined && !predicate.months.includes(at.month)) {
		return false;
	}
	if (predicate.weeksOfMonth !== undefined && !predicate.weeksOfMonth.includes(at.weekOfMonth)) {
		return false;
	}
	if (predicate.dateRange !== undefined) {
		// Zero-padded ISO dates compare correctly as strings; no calendar arithmetic needed.
		if (at.date < predicate.dateRange.from || at.date > predicate.dateRange.to) {
			return false;
		}
	}
	if (predicate.timeOfDay !== undefined && !timeOfDayMatches(predicate.timeOfDay, at.minuteOfDay)) {
		return false;
	}
	return true;
}

/** Whether every predicate of a rule matches. An empty predicate list means "always". */
export function ruleMatches(rule: CompiledTimeRule, at: ZonedInstant): boolean {
	return rule.predicates.every((predicate) => predicateMatches(predicate, at));
}

/** A time condition as it lives in the artifact. */
export interface CompiledTimeCondition {
	readonly id: string;
	readonly name: string;
	readonly timezone: string;
	/** In `ordinal` order. The first that matches wins. */
	readonly rules: readonly CompiledTimeRule[];
}

export interface TimeConditionEvaluation {
	readonly matched: boolean;
	readonly matchedRuleId?: string;
	/** The zoned wall clock the decision was made against — the "why" for a support ticket. */
	readonly at: ZonedInstant;
}

/** Evaluates a condition at an instant. Pure: the same arguments always give the same answer. */
export function evaluateTimeCondition(
	condition: CompiledTimeCondition,
	instant: Date,
): TimeConditionEvaluation {
	const at = zonedInstant(instant, condition.timezone);
	for (const rule of condition.rules) {
		if (ruleMatches(rule, at)) {
			return { matched: true, matchedRuleId: rule.id, at };
		}
	}
	return { matched: false, at };
}

/** Test seam: drops memoised `Intl` formatters. */
export function clearTimezoneCache(): void {
	formatterCache.clear();
}
