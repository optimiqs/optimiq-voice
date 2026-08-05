import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { destinationCheck, destinationColumns, namedDestinationColumns } from "./columns";
import { mohClass, prompt } from "./media-schema";

/**
 * Ring groups. FusionPBX ships four strategies (simultaneous / sequential / enterprise /
 * rollover); the last two are `sequential` with a per-destination delay, which the destination
 * rows already express, so only the two meaningful strategies survive.
 */

export const RING_GROUP_STRATEGIES = ["simultaneous", "sequential"] as const;
export type RingGroupStrategy = (typeof RING_GROUP_STRATEGIES)[number];

export const ringGroup = pgTable.withRLS(
	"ring_group",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		extensionNumber: text("extension_number"),
		strategy: text("strategy").$type<RingGroupStrategy>().notNull().default("simultaneous"),
		ringTimeoutSeconds: integer("ring_timeout_seconds").notNull().default(30),
		callerIdNamePrefix: text("caller_id_name_prefix"),
		/** Skip destinations already on a call instead of offering them the leg. */
		ignoreBusy: boolean("ignore_busy").notNull().default(true),
		/** Require the answering party to press a digit before the leg is bridged. */
		confirmEnabled: boolean("confirm_enabled").notNull().default(false),
		confirmPromptId: uuidEntityId("confirm_prompt_id").references(() => prompt.id, {
			onDelete: "set null",
		}),
		mohClassId: uuidEntityId("moh_class_id").references(() => mohClass.id, {
			onDelete: "set null",
		}),
		/** Played to the caller instead of ringback while the group rings. */
		ringbackPromptId: uuidEntityId("ringback_prompt_id").references(() => prompt.id, {
			onDelete: "set null",
		}),
		...namedDestinationColumns("timeout"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("ring_group_organization_name_key").on(table.organizationId, table.name),
		uniqueIndex("ring_group_organization_extension_number_key")
			.on(table.organizationId, table.extensionNumber)
			.where(sql`extension_number is not null`),
		index("ring_group_organization_enabled_idx").on(table.organizationId, table.enabled),
		destinationCheck("ring_group", "timeout", true),
		tenantIsolationPolicy("ring_group"),
	],
);

export const ringGroupDestination = pgTable.withRLS(
	"ring_group_destination",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		ringGroupId: uuidEntityId("ring_group_id")
			.notNull()
			.references(() => ringGroup.id, { onDelete: "cascade" }),
		ordinal: integer("ordinal").notNull(),
		...destinationColumns(),
		/** Wait before this destination is offered the leg. Always 0 for `simultaneous`. */
		delaySeconds: integer("delay_seconds").notNull().default(0),
		timeoutSeconds: integer("timeout_seconds").notNull().default(30),
		confirmRequired: boolean("confirm_required").notNull().default(false),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("ring_group_destination_group_ordinal_key").on(
			table.organizationId,
			table.ringGroupId,
			table.ordinal,
		),
		index("ring_group_destination_organization_group_idx").on(
			table.organizationId,
			table.ringGroupId,
		),
		destinationCheck("ring_group_destination"),
		tenantIsolationPolicy("ring_group_destination"),
	],
);
