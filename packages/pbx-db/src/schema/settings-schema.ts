import { boolean, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";

/**
 * The settings cascade.
 *
 * FusionPBX has three DB levels (default → domain → user). Ours has two, because **platform
 * defaults live in code**, not in a table: a default row nobody wrote is indistinguishable from
 * a deliberate override, and a code-owned default is versioned, typed and reviewable. So the
 * resolution order is `code default → org_setting → user_setting`, and provisioning extends it
 * with `device_profile.settings → device.settings` (columns on those tables, not rows here).
 *
 * `value` is JSONB and `valueType` records the intent so a `"true"` string and a `true` boolean
 * are never confused when the value round-trips through a form.
 */

export const SETTING_VALUE_TYPES = ["string", "number", "boolean", "json", "array"] as const;
export type SettingValueType = (typeof SETTING_VALUE_TYPES)[number];

export const orgSetting = pgTable.withRLS(
	"org_setting",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		category: text("category").notNull(),
		name: text("name").notNull(),
		value: jsonb("value"),
		valueType: text("value_type").$type<SettingValueType>().notNull().default("string"),
		description: text("description"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("org_setting_organization_category_name_key").on(
			table.organizationId,
			table.category,
			table.name,
		),
		index("org_setting_organization_category_idx").on(table.organizationId, table.category),
		tenantIsolationPolicy("org_setting"),
	],
);

export const userSetting = pgTable.withRLS(
	"user_setting",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/** `user.id` in the auth database. Plain UUID: no cross-database foreign keys. */
		userId: uuidEntityId("user_id").notNull(),
		category: text("category").notNull(),
		name: text("name").notNull(),
		value: jsonb("value"),
		valueType: text("value_type").$type<SettingValueType>().notNull().default("string"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("user_setting_organization_user_category_name_key").on(
			table.organizationId,
			table.userId,
			table.category,
			table.name,
		),
		index("user_setting_organization_user_idx").on(table.organizationId, table.userId),
		tenantIsolationPolicy("user_setting"),
	],
);
