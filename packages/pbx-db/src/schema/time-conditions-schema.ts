import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
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

/**
 * Whether the clock is being obeyed, and if not, which way it is being overruled.
 *
 * The whole reason the column exists: the office closes early for a funeral, and the rules say it
 * is Tuesday afternoon. Upstream solves this with a feature code that flips the condition's
 * dialplan rows; here it is a stored mode, evaluated ahead of the rules, so the override is one
 * column an administrator can also see and clear from a form.
 *
 * - `auto` — evaluate the rules. The state every condition is in until somebody presses a key.
 * - `forced-match` — take the match branch whatever the clock says ("we are open").
 * - `forced-no-match` — take the no-match branch ("we are closed").
 *
 * The names say what they DO rather than what they mean, because what they mean depends on which
 * way round the tenant wired the condition: plenty of conditions match on "out of hours" and route
 * the match branch to voicemail. `forced-open`/`forced-closed` would be a guess about somebody
 * else's configuration.
 */
export const TIME_CONDITION_OVERRIDES = ["auto", "forced-match", "forced-no-match"] as const;

export type TimeConditionOverride = (typeof TIME_CONDITION_OVERRIDES)[number];

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
		/**
		 * The manual override. See {@link TIME_CONDITION_OVERRIDES}.
		 *
		 * Persisted for the reason `call_flow.mode` is persisted, and the argument is the same one: it
		 * is org state, not instance state. It must survive the fleet restarting, an administrator
		 * must be able to see and clear it from a form, and "what is this tenant's routing right now"
		 * has to be answerable by reading the compiled artifact alone. So it is compiled in and a flip
		 * costs a recompile, exactly like every other configuration write.
		 */
		override: text("override").$type<TimeConditionOverride>().notNull().default("auto"),
		/**
		 * The star code that cycles the override, and the key a BLF lamp watches.
		 *
		 * Nullable and per-condition, exactly like `call_flow.feature_code`, and screened against the
		 * feature-code catalogue by the compiler for the same reason: two things answering the same
		 * digits is a collision with no runtime symptom beyond the wrong one winning.
		 */
		overrideFeatureCode: text("override_feature_code"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("time_condition_organization_name_key").on(table.organizationId, table.name),
		uniqueIndex("time_condition_organization_override_feature_code_key")
			.on(table.organizationId, table.overrideFeatureCode)
			.where(sql`override_feature_code is not null`),
		index("time_condition_organization_enabled_idx").on(table.organizationId, table.enabled),
		check(
			"time_condition_override_check",
			sql`override in ('auto', 'forced-match', 'forced-no-match')`,
		),
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
