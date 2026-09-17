import { z } from "zod/v4";
import {
	destinationShape,
	displayName,
	namedDestinationShape,
	patchOf,
	shortCode,
} from "../shared/dto";

/** `HH:MM`, 24-hour. Both ends of a wall-clock window are inclusive. */
const wallClock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, "must be HH:MM, 24-hour");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "must be YYYY-MM-DD");

/**
 * One predicate. Every present field must match (logical AND); an empty predicate matches always,
 * which is a legitimate "this rule is the default branch".
 */
const timeRulePredicate = z.strictObject({
	/** ISO weekdays, 1 = Monday … 7 = Sunday. */
	weekdays: z.array(z.int().min(1).max(7)).max(7).optional(),
	monthDays: z.array(z.int().min(1).max(31)).max(31).optional(),
	months: z.array(z.int().min(1).max(12)).max(12).optional(),
	weeksOfMonth: z.array(z.int().min(1).max(5)).max(5).optional(),
	/** `from > to` crosses midnight: `[from, 24:00) ∪ [00:00, to]` on the same day. */
	timeOfDay: z.strictObject({ from: wallClock, to: wallClock }).optional(),
	/** Holidays live here. */
	dateRange: z.strictObject({ from: isoDate, to: isoDate }).optional(),
});

export const createTimeConditionDto = z.strictObject({
	name: displayName,
	/** IANA zone. Every rule is evaluated in this zone; an unknown one fails the compile. */
	timezone: z.string().min(1).max(64).optional(),
	...destinationShape(true),
	...namedDestinationShape("nomatch"),
	/**
	 * The star code that cycles the override, and the key a BLF lamp watches.
	 *
	 * Shaped exactly like `call_flow.featureCode` and left unconstrained beyond that for the same
	 * reason: the suffix is the tenant's, and the failure this feature can actually have is two
	 * mechanisms answering the same digits — which the compile-time screen against the feature-code
	 * catalogue sees and a regex at the edge cannot. The column's partial unique index makes a second
	 * condition claiming the same code a write-time conflict rather than a silent second claimant.
	 */
	overrideFeatureCode: shortCode.nullish(),
	enabled: z.boolean().optional(),
});

export const updateTimeConditionDto = patchOf(createTimeConditionDto);

export const createTimeConditionRuleDto = z.strictObject({
	ordinal: z.int().min(0).max(1000),
	label: z.string().max(128).nullish(),
	predicates: z.array(timeRulePredicate).min(1).max(20),
	enabled: z.boolean().optional(),
});

export const updateTimeConditionRuleDto = patchOf(createTimeConditionRuleDto);
