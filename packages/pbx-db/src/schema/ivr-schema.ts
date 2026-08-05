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
import { prompt } from "./media-schema";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * IVR menus. `parentId` gives the nesting FusionPBX models with `parent_uuid`; it is advisory
 * (used by the admin UI to render a tree and to prevent orphan deletion) — the actual call flow
 * is driven by the options' destinations, which may point anywhere, including back up the tree.
 */

export const IVR_OPTION_MATCH_KINDS = ["digit", "regex"] as const;
export type IvrOptionMatchKind = (typeof IVR_OPTION_MATCH_KINDS)[number];

export const ivrMenu = pgTable.withRLS(
	"ivr_menu",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		/** Optional internal number so staff can dial the menu directly. */
		extensionNumber: text("extension_number"),
		parentId: uuidEntityId("parent_id").references((): AnyPgColumn => ivrMenu.id, {
			onDelete: "set null",
		}),
		greetingPromptId: uuidEntityId("greeting_prompt_id").references(() => prompt.id, {
			onDelete: "set null",
		}),
		/** Played on a second and subsequent pass through the menu. */
		shortGreetingPromptId: uuidEntityId("short_greeting_prompt_id").references(() => prompt.id, {
			onDelete: "set null",
		}),
		invalidPromptId: uuidEntityId("invalid_prompt_id").references(() => prompt.id, {
			onDelete: "set null",
		}),
		timeoutPromptId: uuidEntityId("timeout_prompt_id").references(() => prompt.id, {
			onDelete: "set null",
		}),
		digitTimeoutMs: integer("digit_timeout_ms").notNull().default(5000),
		interDigitTimeoutMs: integer("inter_digit_timeout_ms").notNull().default(2000),
		maxDigits: integer("max_digits").notNull().default(1),
		maxFailures: integer("max_failures").notNull().default(3),
		maxTimeouts: integer("max_timeouts").notNull().default(3),
		/** Allow callers to dial an extension number that is not an explicit option. */
		directDialEnabled: boolean("direct_dial_enabled").notNull().default(false),
		/** Taken after `maxTimeouts` silent passes. */
		...namedDestinationColumns("timeout"),
		/** Taken after `maxFailures` invalid entries. */
		...namedDestinationColumns("invalid"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("ivr_menu_organization_name_key").on(table.organizationId, table.name),
		uniqueIndex("ivr_menu_organization_extension_number_key")
			.on(table.organizationId, table.extensionNumber)
			.where(sql`extension_number is not null`),
		index("ivr_menu_organization_parent_idx").on(table.organizationId, table.parentId),
		index("ivr_menu_organization_enabled_idx").on(table.organizationId, table.enabled),
		destinationCheck("ivr_menu", "timeout", true),
		destinationCheck("ivr_menu", "invalid", true),
		tenantIsolationPolicy("ivr_menu"),
	],
);

export const ivrMenuOption = pgTable.withRLS(
	"ivr_menu_option",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		ivrMenuId: uuidEntityId("ivr_menu_id")
			.notNull()
			.references(() => ivrMenu.id, { onDelete: "cascade" }),
		ordinal: integer("ordinal").notNull(),
		matchKind: text("match_kind").$type<IvrOptionMatchKind>().notNull().default("digit"),
		/** A single digit (`1`, `*`, `#`) or a POSIX regex, per `matchKind`. */
		matchValue: text("match_value").notNull(),
		label: text("label"),
		...destinationColumns(),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("ivr_menu_option_menu_match_key").on(
			table.organizationId,
			table.ivrMenuId,
			table.matchValue,
		),
		index("ivr_menu_option_menu_ordinal_idx").on(
			table.organizationId,
			table.ivrMenuId,
			table.ordinal,
		),
		destinationCheck("ivr_menu_option"),
		tenantIsolationPolicy("ivr_menu_option"),
	],
);
