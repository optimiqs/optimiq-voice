import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { destinationCheck, destinationColumns, namedDestinationColumns } from "./columns";
import { phoneNumber } from "./numbers-schema";
import { pinSet } from "./pins-schema";
import { timeCondition } from "./time-conditions-schema";
import { translationRuleset } from "./translations-schema";
import type { TollClass } from "./extensions-schema";

/**
 * Inbound and outbound routes are first-class rows, never "dialplan rows". The routing compiler
 * reads them (ordered by `priority`, lowest first) and materializes the runtime artifact; nothing
 * in this table is hand-edited XML.
 */

/** How a route's pattern is matched against the dialed digits. */
export const ROUTE_MATCH_KINDS = ["exact", "prefix", "regex", "any"] as const;
export type RouteMatchKind = (typeof ROUTE_MATCH_KINDS)[number];

/** One trunk in an outbound route's ordered failover list. */
export interface TrunkPriorityEntry {
	readonly trunkId: string;
	readonly order: number;
	/** Relative share when several entries have the same `order` (weighted round-robin). */
	readonly weight?: number;
}

export const inboundRoute = pgTable.withRLS(
	"inbound_route",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		priority: integer("priority").notNull().default(100),
		matchKind: text("match_kind").$type<RouteMatchKind>().notNull().default("exact"),
		/** Dialed-number pattern. Ignored when `matchKind = "any"`. */
		matchPattern: text("match_pattern"),
		/** Optional narrowing to a specific DID rather than a pattern. */
		phoneNumberId: uuidEntityId("phone_number_id").references(() => phoneNumber.id, {
			onDelete: "cascade",
		}),
		/** Optional caller-id screen, same `matchKind` semantics. */
		callerIdPattern: text("caller_id_pattern"),
		...destinationColumns(),
		/** Taken when the primary destination fails or is unreachable. */
		...namedDestinationColumns("failover"),
		timeConditionId: uuidEntityId("time_condition_id").references(() => timeCondition.id, {
			onDelete: "set null",
		}),
		recordEnabled: boolean("record_enabled").notNull().default(false),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("inbound_route_organization_name_key").on(table.organizationId, table.name),
		index("inbound_route_organization_enabled_priority_idx").on(
			table.organizationId,
			table.enabled,
			table.priority,
		),
		index("inbound_route_organization_phone_number_idx").on(
			table.organizationId,
			table.phoneNumberId,
		),
		index("inbound_route_organization_time_condition_idx").on(
			table.organizationId,
			table.timeConditionId,
		),
		destinationCheck("inbound_route"),
		destinationCheck("inbound_route", "failover", true),
		tenantIsolationPolicy("inbound_route"),
	],
);

export const outboundRoute = pgTable.withRLS(
	"outbound_route",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		priority: integer("priority").notNull().default(100),
		matchKind: text("match_kind").$type<RouteMatchKind>().notNull().default("prefix"),
		/** Ordered alternatives; the first that matches wins. */
		dialPatterns: text("dial_patterns").array().notNull(),
		stripDigits: integer("strip_digits").notNull().default(0),
		prependDigits: text("prepend_digits"),
		/**
		 * Required privilege class. An extension may only take this route when its own
		 * `toll_class` covers it — the anti-toll-fraud gate, so this column is NOT NULL by design.
		 */
		tollClass: text("toll_class").$type<TollClass>().notNull(),
		/** Ordered trunk failover list. JSON because it is a small ordered list read whole. */
		trunkPriority: jsonb("trunk_priority").$type<readonly TrunkPriorityEntry[]>().notNull(),
		timeConditionId: uuidEntityId("time_condition_id").references(() => timeCondition.id, {
			onDelete: "set null",
		}),
		/** Taken when every trunk in `trunkPriority` fails. */
		...namedDestinationColumns("failover"),
		/**
		 * The authorisation codes a caller must satisfy before any trunk is dialled.
		 *
		 * NULL is the overwhelmingly common case and means no challenge. `on delete set null` rather
		 * than `restrict`: deleting a PIN set removes the gate, and while that widens access it does
		 * so with a row an administrator explicitly deleted — whereas `restrict` would make deleting a
		 * retired set a puzzle, and `cascade` would delete the ROUTE, which takes the tenant's
		 * international calling down to remove a code list.
		 */
		pinSetId: uuidEntityId("pin_set_id").references(() => pinSet.id, { onDelete: "set null" }),
		/**
		 * The shared rewrite applied to the dialled number, AFTER this route's own strip/prepend.
		 *
		 * The composition order and its argument are in `translations-schema.ts`: the inline pair
		 * turns what somebody's fingers did into the number they meant, and the ruleset normalises
		 * that number for the wire.
		 */
		translationRulesetId: uuidEntityId("translation_ruleset_id").references(
			() => translationRuleset.id,
			{ onDelete: "set null" },
		),
		callerIdNumberOverride: text("caller_id_number_override"),
		recordEnabled: boolean("record_enabled").notNull().default(false),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("outbound_route_organization_name_key").on(table.organizationId, table.name),
		index("outbound_route_organization_enabled_priority_idx").on(
			table.organizationId,
			table.enabled,
			table.priority,
		),
		index("outbound_route_organization_toll_class_idx").on(table.organizationId, table.tollClass),
		index("outbound_route_organization_time_condition_idx").on(
			table.organizationId,
			table.timeConditionId,
		),
		index("outbound_route_organization_pin_set_idx").on(table.organizationId, table.pinSetId),
		index("outbound_route_organization_translation_idx").on(
			table.organizationId,
			table.translationRulesetId,
		),
		destinationCheck("outbound_route", "failover", true),
		tenantIsolationPolicy("outbound_route"),
	],
);
