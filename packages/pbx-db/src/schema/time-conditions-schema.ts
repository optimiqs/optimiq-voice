import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { destinationCheck, destinationColumns, namedDestinationColumns } from "./columns";

/**
 * Time conditions. FusionPBX stores these as raw dialplan rows; here they are a real table with
 * an ordered list of predicate rows, evaluated in `ordinal` order against the condition's own
 * timezone. The first rule whose predicates ALL match wins and the call takes the condition's
 * `destination_*`; if no rule matches it takes `nomatch_destination_*`.
 */

/** A single FreeSWITCH-style time predicate. Every present field must match (logical AND). */
export interface TimeRulePredicate {
	/** ISO weekdays, 1 = Monday … 7 = Sunday. */
	readonly weekdays?: readonly number[];
	/** Days of the month, 1–31. */
	readonly monthDays?: readonly number[];
	/** Months, 1–12. */
	readonly months?: readonly number[];
	/** Week of the month, 1–5. */
	readonly weeksOfMonth?: readonly number[];
	/** Inclusive local wall-clock window, `HH:MM` 24h. */
	readonly timeOfDay?: { readonly from: string; readonly to: string };
	/** Inclusive local date window, `YYYY-MM-DD`. Use for holidays. */
	readonly dateRange?: { readonly from: string; readonly to: string };
}

export const timeCondition = pgTable.withRLS(
	"time_condition",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		/** IANA zone, e.g. `America/New_York`. Every rule is evaluated in this zone. */
		timezone: text("timezone").notNull().default("UTC"),
		/** Taken when any rule matches. */
		...destinationColumns(),
		/** Taken when no rule matches. NULL means "fall through to the caller's own fallback". */
		...namedDestinationColumns("nomatch"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("time_condition_organization_name_key").on(table.organizationId, table.name),
		index("time_condition_organization_enabled_idx").on(table.organizationId, table.enabled),
		destinationCheck("time_condition"),
		destinationCheck("time_condition", "nomatch", true),
		tenantIsolationPolicy("time_condition"),
	],
);

export const timeConditionRule = pgTable.withRLS(
	"time_condition_rule",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		timeConditionId: uuidEntityId("time_condition_id")
			.notNull()
			.references(() => timeCondition.id, { onDelete: "cascade" }),
		ordinal: integer("ordinal").notNull(),
		label: text("label"),
		/** Ordered predicate array; all entries are ANDed. */
		predicates: jsonb("predicates").$type<readonly TimeRulePredicate[]>().notNull(),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("time_condition_rule_condition_ordinal_key").on(
			table.organizationId,
			table.timeConditionId,
			table.ordinal,
		),
		index("time_condition_rule_organization_condition_idx").on(
			table.organizationId,
			table.timeConditionId,
		),
		tenantIsolationPolicy("time_condition_rule"),
	],
);
