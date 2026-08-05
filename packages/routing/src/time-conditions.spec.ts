import { describe, expect, it } from "bun:test";
import {
	compileTimePredicate,
	evaluateTimeCondition,
	isKnownTimezone,
	predicateMatches,
	ruleMatches,
	timeOfDayMatches,
	validateTimePredicate,
	zonedInstant,
} from "./time-conditions";
import type { CompiledTimeCondition, CompiledTimeRule } from "./time-conditions";

const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";
const KATHMANDU = "Asia/Kathmandu";

function ruleOf(predicates: CompiledTimeRule["predicates"], id = "r1"): CompiledTimeRule {
	return { id, ordinal: 1, predicates };
}

function conditionOf(rules: readonly CompiledTimeRule[], timezone = "UTC"): CompiledTimeCondition {
	return { id: "tc", name: "Test", timezone, rules };
}

describe("isKnownTimezone", () => {
	it("accepts a real IANA zone", () => {
		expect(isKnownTimezone(NY)).toBe(true);
	});

	it("accepts UTC", () => {
		expect(isKnownTimezone("UTC")).toBe(true);
	});

	it("rejects a made-up zone", () => {
		expect(isKnownTimezone("Mars/Olympus_Mons")).toBe(false);
	});

	it("rejects an empty string", () => {
		expect(isKnownTimezone("")).toBe(false);
	});
});

describe("zonedInstant", () => {
	it("projects an instant into UTC", () => {
		const at = zonedInstant(new Date("2026-08-05T12:34:00Z"), "UTC");
		expect(at).toMatchObject({ year: 2026, month: 8, day: 5, hour: 12, minute: 34 });
	});

	it("applies a negative offset", () => {
		// 12:00Z is 08:00 in New York during daylight time.
		const at = zonedInstant(new Date("2026-08-05T12:00:00Z"), NY);
		expect(at.hour).toBe(8);
		expect(at.date).toBe("2026-08-05");
	});

	it("applies a positive offset that rolls the date forward", () => {
		const at = zonedInstant(new Date("2026-08-05T20:00:00Z"), TOKYO);
		expect(at.date).toBe("2026-08-06");
		expect(at.hour).toBe(5);
	});

	it("handles a zone with a 45-minute offset", () => {
		const at = zonedInstant(new Date("2026-08-05T00:00:00Z"), KATHMANDU);
		expect(at.hour).toBe(5);
		expect(at.minute).toBe(45);
		expect(at.minuteOfDay).toBe(5 * 60 + 45);
	});

	it("renders midnight as hour 0, never 24", () => {
		const at = zonedInstant(new Date("2026-08-05T00:00:00Z"), "UTC");
		expect(at.hour).toBe(0);
		expect(at.minuteOfDay).toBe(0);
	});

	it("reports ISO weekdays with Monday as 1", () => {
		// 2026-08-03 is a Monday.
		expect(zonedInstant(new Date("2026-08-03T12:00:00Z"), "UTC").weekday).toBe(1);
	});

	it("reports Sunday as 7", () => {
		expect(zonedInstant(new Date("2026-08-09T12:00:00Z"), "UTC").weekday).toBe(7);
	});

	it("computes the week of the month in seven-day blocks", () => {
		expect(zonedInstant(new Date("2026-08-01T12:00:00Z"), "UTC").weekOfMonth).toBe(1);
		expect(zonedInstant(new Date("2026-08-07T12:00:00Z"), "UTC").weekOfMonth).toBe(1);
		expect(zonedInstant(new Date("2026-08-08T12:00:00Z"), "UTC").weekOfMonth).toBe(2);
		expect(zonedInstant(new Date("2026-08-29T12:00:00Z"), "UTC").weekOfMonth).toBe(5);
	});

	it("zero-pads the date so string comparison works", () => {
		expect(zonedInstant(new Date("2026-01-02T12:00:00Z"), "UTC").date).toBe("2026-01-02");
	});
});

describe("timeOfDayMatches", () => {
	const nineToFive = { from: "09:00", to: "17:00" };

	it("matches inside the window", () => {
		expect(timeOfDayMatches(nineToFive, 12 * 60)).toBe(true);
	});

	it("includes the opening minute", () => {
		expect(timeOfDayMatches(nineToFive, 9 * 60)).toBe(true);
	});

	it("includes the closing minute", () => {
		// Both ends inclusive: half-open would drop the last minute of every business day.
		expect(timeOfDayMatches(nineToFive, 17 * 60)).toBe(true);
	});

	it("excludes the minute before opening", () => {
		expect(timeOfDayMatches(nineToFive, 9 * 60 - 1)).toBe(false);
	});

	it("excludes the minute after closing", () => {
		expect(timeOfDayMatches(nineToFive, 17 * 60 + 1)).toBe(false);
	});

	it("matches a single-minute window", () => {
		expect(timeOfDayMatches({ from: "12:00", to: "12:00" }, 12 * 60)).toBe(true);
		expect(timeOfDayMatches({ from: "12:00", to: "12:00" }, 12 * 60 + 1)).toBe(false);
	});

	it("matches the evening half of an overnight window", () => {
		expect(timeOfDayMatches({ from: "22:00", to: "06:00" }, 23 * 60)).toBe(true);
	});

	it("matches the small-hours half of an overnight window", () => {
		expect(timeOfDayMatches({ from: "22:00", to: "06:00" }, 2 * 60)).toBe(true);
	});

	it("excludes the middle of the day from an overnight window", () => {
		expect(timeOfDayMatches({ from: "22:00", to: "06:00" }, 12 * 60)).toBe(false);
	});

	it("matches midnight inside an overnight window", () => {
		expect(timeOfDayMatches({ from: "22:00", to: "06:00" }, 0)).toBe(true);
	});

	it("matches the whole day for 00:00-23:59", () => {
		for (const minute of [0, 1, 720, 1438, 1439]) {
			expect(timeOfDayMatches({ from: "00:00", to: "23:59" }, minute)).toBe(true);
		}
	});

	it("refuses a malformed window rather than guessing", () => {
		expect(timeOfDayMatches({ from: "9:00", to: "17:00" }, 600)).toBe(false);
	});
});

describe("validateTimePredicate", () => {
	it("accepts an empty predicate, which means 'always'", () => {
		expect(validateTimePredicate({})).toEqual([]);
	});

	it("accepts a full weekday list", () => {
		expect(validateTimePredicate({ weekdays: [1, 2, 3, 4, 5, 6, 7] })).toEqual([]);
	});

	it("rejects weekday 0", () => {
		expect(validateTimePredicate({ weekdays: [0] })).toEqual([
			{ code: "weekday-out-of-range", value: 0 },
		]);
	});

	it("rejects weekday 8", () => {
		expect(validateTimePredicate({ weekdays: [8] })).toEqual([
			{ code: "weekday-out-of-range", value: 8 },
		]);
	});

	it("rejects month 13", () => {
		expect(validateTimePredicate({ months: [13] })).toEqual([
			{ code: "month-out-of-range", value: 13 },
		]);
	});

	it("rejects month day 32", () => {
		expect(validateTimePredicate({ monthDays: [32] })).toEqual([
			{ code: "month-day-out-of-range", value: 32 },
		]);
	});

	it("rejects week of month 6", () => {
		expect(validateTimePredicate({ weeksOfMonth: [6] })).toEqual([
			{ code: "week-of-month-out-of-range", value: 6 },
		]);
	});

	it("rejects an empty list, which is always a form bug", () => {
		expect(validateTimePredicate({ weekdays: [] })).toEqual([
			{ code: "empty-list", field: "weekdays" },
		]);
	});

	it("rejects a malformed time of day", () => {
		expect(validateTimePredicate({ timeOfDay: { from: "9am", to: "17:00" } })).toEqual([
			{ code: "malformed-time-of-day", value: "9am" },
		]);
	});

	it("rejects hour 24", () => {
		expect(validateTimePredicate({ timeOfDay: { from: "24:00", to: "24:30" } })).toHaveLength(2);
	});

	it("accepts a valid date range", () => {
		expect(validateTimePredicate({ dateRange: { from: "2026-12-24", to: "2026-12-26" } })).toEqual(
			[],
		);
	});

	it("rejects a date range that ends before it starts", () => {
		expect(validateTimePredicate({ dateRange: { from: "2026-12-26", to: "2026-12-24" } })).toEqual([
			{ code: "inverted-date-range", from: "2026-12-26", to: "2026-12-24" },
		]);
	});

	it("rejects 31 April", () => {
		expect(
			validateTimePredicate({ dateRange: { from: "2026-04-31", to: "2026-04-31" } }),
		).toContainEqual({ code: "malformed-date", value: "2026-04-31" });
	});

	it("accepts 29 February, because a leap-day holiday is legitimate", () => {
		expect(validateTimePredicate({ dateRange: { from: "2028-02-29", to: "2028-02-29" } })).toEqual(
			[],
		);
	});

	it("reports every problem, not the first", () => {
		expect(validateTimePredicate({ weekdays: [0], months: [13] })).toHaveLength(2);
	});
});

describe("compileTimePredicate", () => {
	it("sorts and deduplicates lists so a reordered form does not move the hash", () => {
		expect(compileTimePredicate({ weekdays: [5, 1, 1, 3] })).toEqual({ weekdays: [1, 3, 5] });
	});

	it("omits absent fields entirely", () => {
		expect(Object.keys(compileTimePredicate({ months: [1] }))).toEqual(["months"]);
	});

	it("keeps windows verbatim", () => {
		expect(compileTimePredicate({ timeOfDay: { from: "22:00", to: "06:00" } })).toEqual({
			timeOfDay: { from: "22:00", to: "06:00" },
		});
	});
});

describe("predicateMatches", () => {
	const wednesdayNoonUtc = zonedInstant(new Date("2026-08-05T12:00:00Z"), "UTC");

	it("matches an empty predicate", () => {
		expect(predicateMatches({}, wednesdayNoonUtc)).toBe(true);
	});

	it("matches a weekday list containing the day", () => {
		expect(predicateMatches({ weekdays: [3] }, wednesdayNoonUtc)).toBe(true);
	});

	it("rejects a weekday list without the day", () => {
		expect(predicateMatches({ weekdays: [1, 2] }, wednesdayNoonUtc)).toBe(false);
	});

	it("ANDs every present field", () => {
		expect(
			predicateMatches(
				{ weekdays: [3], timeOfDay: { from: "13:00", to: "14:00" } },
				wednesdayNoonUtc,
			),
		).toBe(false);
	});

	it("matches a month day", () => {
		expect(predicateMatches({ monthDays: [5] }, wednesdayNoonUtc)).toBe(true);
	});

	it("matches a month", () => {
		expect(predicateMatches({ months: [8] }, wednesdayNoonUtc)).toBe(true);
	});

	it("matches a week of month", () => {
		expect(predicateMatches({ weeksOfMonth: [1] }, wednesdayNoonUtc)).toBe(true);
	});

	it("matches a date range that contains the day", () => {
		expect(
			predicateMatches({ dateRange: { from: "2026-08-01", to: "2026-08-31" } }, wednesdayNoonUtc),
		).toBe(true);
	});

	it("matches a single-day date range", () => {
		expect(
			predicateMatches({ dateRange: { from: "2026-08-05", to: "2026-08-05" } }, wednesdayNoonUtc),
		).toBe(true);
	});

	it("rejects a date range that ends the day before", () => {
		expect(
			predicateMatches({ dateRange: { from: "2026-07-01", to: "2026-08-04" } }, wednesdayNoonUtc),
		).toBe(false);
	});

	it("compares dates across a year boundary correctly", () => {
		const newYearsEve = zonedInstant(new Date("2026-12-31T12:00:00Z"), "UTC");
		expect(
			predicateMatches({ dateRange: { from: "2026-12-24", to: "2027-01-02" } }, newYearsEve),
		).toBe(true);
	});
});

describe("ruleMatches", () => {
	const at = zonedInstant(new Date("2026-08-05T12:00:00Z"), "UTC");

	it("matches a rule with no predicates, which means 'always'", () => {
		expect(ruleMatches(ruleOf([]), at)).toBe(true);
	});

	it("requires every predicate to match", () => {
		expect(ruleMatches(ruleOf([{ weekdays: [3] }, { months: [8] }]), at)).toBe(true);
		expect(ruleMatches(ruleOf([{ weekdays: [3] }, { months: [7] }]), at)).toBe(false);
	});
});

describe("evaluateTimeCondition — ordering", () => {
	it("returns the first matching rule", () => {
		const condition = conditionOf([
			{ id: "holiday", ordinal: 1, predicates: [{ months: [7] }] },
			{ id: "weekday", ordinal: 2, predicates: [{ weekdays: [3] }] },
		]);
		const evaluation = evaluateTimeCondition(condition, new Date("2026-08-05T12:00:00Z"));
		expect(evaluation).toMatchObject({ matched: true, matchedRuleId: "weekday" });
	});

	it("reports no match when nothing applies", () => {
		const condition = conditionOf([{ id: "r", ordinal: 1, predicates: [{ weekdays: [6, 7] }] }]);
		expect(evaluateTimeCondition(condition, new Date("2026-08-05T12:00:00Z")).matched).toBe(false);
	});

	it("reports no match for a condition with no rules", () => {
		expect(evaluateTimeCondition(conditionOf([]), new Date()).matched).toBe(false);
	});

	it("carries the zoned wall clock it decided against", () => {
		const evaluation = evaluateTimeCondition(conditionOf([], NY), new Date("2026-08-05T12:00:00Z"));
		expect(evaluation.at).toMatchObject({ hour: 8, date: "2026-08-05" });
	});

	it("is pure: the same arguments give the same answer", () => {
		const condition = conditionOf([ruleOf([{ weekdays: [3] }])]);
		const instant = new Date("2026-08-05T12:00:00Z");
		expect(evaluateTimeCondition(condition, instant)).toEqual(
			evaluateTimeCondition(condition, instant),
		);
	});
});

describe("evaluateTimeCondition — zones", () => {
	const businessHours = conditionOf(
		[ruleOf([{ weekdays: [1, 2, 3, 4, 5], timeOfDay: { from: "09:00", to: "17:00" } }])],
		NY,
	);

	it("is closed at 08:00 New York even though it is 12:00 UTC", () => {
		expect(evaluateTimeCondition(businessHours, new Date("2026-08-05T12:00:00Z")).matched).toBe(
			false,
		);
	});

	it("is open at 09:00 New York", () => {
		expect(evaluateTimeCondition(businessHours, new Date("2026-08-05T13:00:00Z")).matched).toBe(
			true,
		);
	});

	it("is closed on Saturday in the tenant's zone", () => {
		expect(evaluateTimeCondition(businessHours, new Date("2026-08-08T15:00:00Z")).matched).toBe(
			false,
		);
	});

	it("uses the tenant's calendar day, not UTC's", () => {
		// 2026-08-10T02:00Z is Sunday 22:00 in New York — still the weekend there.
		expect(evaluateTimeCondition(businessHours, new Date("2026-08-10T02:00:00Z")).matched).toBe(
			false,
		);
	});
});

/**
 * The transitions themselves. 2026: US daylight time starts 08 March (02:00 -> 03:00 local) and
 * ends 01 November (02:00 -> 01:00 local).
 */
describe("evaluateTimeCondition — daylight saving", () => {
	const springForwardGap = conditionOf(
		[ruleOf([{ monthDays: [8], months: [3], timeOfDay: { from: "02:00", to: "02:59" } }])],
		NY,
	);

	it("never matches a window inside the hour that does not exist", () => {
		// Every instant on 2026-03-08, sampled every ten minutes across the transition.
		for (let offset = 0; offset < 6 * 60; offset += 10) {
			const instant = new Date(Date.UTC(2026, 2, 8, 4, offset));
			expect(evaluateTimeCondition(springForwardGap, instant).matched).toBe(false);
		}
	});

	it("still applies offsets correctly the minute before the jump", () => {
		// 06:59Z on the transition day is 01:59 EST.
		expect(zonedInstant(new Date("2026-03-08T06:59:00Z"), NY)).toMatchObject({
			hour: 1,
			minute: 59,
		});
	});

	it("jumps the wall clock from 01:59 to 03:00", () => {
		expect(zonedInstant(new Date("2026-03-08T07:00:00Z"), NY)).toMatchObject({
			hour: 3,
			minute: 0,
		});
	});

	const fallBackRepeat = conditionOf(
		[ruleOf([{ monthDays: [1], months: [11], timeOfDay: { from: "01:00", to: "01:59" } }])],
		NY,
	);

	it("matches both passes through a repeated wall-clock hour", () => {
		// 05:30Z is 01:30 EDT (first pass); 06:30Z is 01:30 EST (second pass).
		expect(evaluateTimeCondition(fallBackRepeat, new Date("2026-11-01T05:30:00Z")).matched).toBe(
			true,
		);
		expect(evaluateTimeCondition(fallBackRepeat, new Date("2026-11-01T06:30:00Z")).matched).toBe(
			true,
		);
	});

	it("distinguishes the two passes by their offset, not by the wall clock", () => {
		expect(zonedInstant(new Date("2026-11-01T05:30:00Z"), NY).hour).toBe(1);
		expect(zonedInstant(new Date("2026-11-01T06:30:00Z"), NY).hour).toBe(1);
		expect(zonedInstant(new Date("2026-11-01T07:30:00Z"), NY).hour).toBe(2);
	});

	it("keeps a 09:00-17:00 window at 09:00 local on both sides of a transition", () => {
		const nineToFive = conditionOf([ruleOf([{ timeOfDay: { from: "09:00", to: "17:00" } }])], NY);
		// 14:00Z is 09:00 EDT in summer; 14:00Z is 09:00 EST in winter only at 13:00Z, so the
		// business day tracks the wall clock rather than a fixed offset.
		expect(evaluateTimeCondition(nineToFive, new Date("2026-07-01T13:00:00Z")).matched).toBe(true);
		expect(evaluateTimeCondition(nineToFive, new Date("2026-01-01T13:00:00Z")).matched).toBe(false);
		expect(evaluateTimeCondition(nineToFive, new Date("2026-01-01T14:00:00Z")).matched).toBe(true);
	});

	it("handles a southern-hemisphere zone whose transitions run the other way", () => {
		const sydney = conditionOf(
			[ruleOf([{ timeOfDay: { from: "09:00", to: "17:00" } }])],
			"Australia/Sydney",
		);
		// 2026-01-01 is daylight time in Sydney (UTC+11): 23:00Z on 31 Dec is 10:00 local.
		expect(evaluateTimeCondition(sydney, new Date("2025-12-31T23:00:00Z")).matched).toBe(true);
		// 2026-07-01 is standard time (UTC+10): 23:00Z on 30 Jun is 09:00 local.
		expect(evaluateTimeCondition(sydney, new Date("2026-06-30T23:00:00Z")).matched).toBe(true);
	});

	it("handles a zone without daylight saving at all", () => {
		const phoenix = conditionOf(
			[ruleOf([{ timeOfDay: { from: "09:00", to: "17:00" } }])],
			"America/Phoenix",
		);
		expect(evaluateTimeCondition(phoenix, new Date("2026-01-01T17:00:00Z")).matched).toBe(true);
		expect(evaluateTimeCondition(phoenix, new Date("2026-07-01T17:00:00Z")).matched).toBe(true);
	});
});

describe("evaluateTimeCondition — overnight windows", () => {
	const nightShift = conditionOf(
		[ruleOf([{ weekdays: [5], timeOfDay: { from: "22:00", to: "06:00" } }])],
		"UTC",
	);

	it("matches Friday evening", () => {
		// 2026-08-07 is a Friday.
		expect(evaluateTimeCondition(nightShift, new Date("2026-08-07T23:00:00Z")).matched).toBe(true);
	});

	it("matches Friday's small hours, not Saturday's", () => {
		// The weekday predicate applies to the same calendar day as the wall clock, so a Friday-only
		// overnight window covers Friday 00:00-06:00 and Friday 22:00-24:00.
		expect(evaluateTimeCondition(nightShift, new Date("2026-08-07T02:00:00Z")).matched).toBe(true);
		expect(evaluateTimeCondition(nightShift, new Date("2026-08-08T02:00:00Z")).matched).toBe(false);
	});

	it("does not match Friday afternoon", () => {
		expect(evaluateTimeCondition(nightShift, new Date("2026-08-07T15:00:00Z")).matched).toBe(false);
	});
});

describe("evaluateTimeCondition — holidays", () => {
	it("matches a holiday date range regardless of weekday", () => {
		const holiday = conditionOf([
			ruleOf([{ dateRange: { from: "2026-12-24", to: "2026-12-26" } }]),
		]);
		expect(evaluateTimeCondition(holiday, new Date("2026-12-25T09:00:00Z")).matched).toBe(true);
		expect(evaluateTimeCondition(holiday, new Date("2026-12-27T09:00:00Z")).matched).toBe(false);
	});

	it("combines a holiday range with a wall-clock window", () => {
		const halfDay = conditionOf([
			ruleOf([
				{
					dateRange: { from: "2026-12-24", to: "2026-12-24" },
					timeOfDay: { from: "09:00", to: "12:00" },
				},
			]),
		]);
		expect(evaluateTimeCondition(halfDay, new Date("2026-12-24T11:00:00Z")).matched).toBe(true);
		expect(evaluateTimeCondition(halfDay, new Date("2026-12-24T13:00:00Z")).matched).toBe(false);
	});

	it("lets an earlier holiday rule pre-empt a later business-hours rule", () => {
		const condition = conditionOf([
			{ id: "closed-for-xmas", ordinal: 1, predicates: [{ months: [12], monthDays: [25] }] },
			{ id: "open", ordinal: 2, predicates: [{ timeOfDay: { from: "09:00", to: "17:00" } }] },
		]);
		expect(evaluateTimeCondition(condition, new Date("2026-12-25T10:00:00Z")).matchedRuleId).toBe(
			"closed-for-xmas",
		);
	});
});
