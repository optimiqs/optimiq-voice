import { boolean, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";

/**
 * The settings cascade.
 *
 * FusionPBX has three DB levels (default → domain → user). Ours has ONE, because **platform
 * defaults live in code**, not in a table: a default row nobody wrote is indistinguishable from
 * a deliberate override, and a code-owned default is versioned, typed and reviewable. So the
 * resolution order is `code default → org_setting`, and provisioning extends it with
 * `device_profile.settings → device.settings` (columns on those tables, not rows here).
 *
 * ## Why there is no `user_setting`
 *
 * There was one, from the baseline migration until it was dropped: a table with RLS, a unique
 * index and a tenant grant that no line of code in `apps/api`, `apps/web`, `apps/engine` or any
 * package ever read or wrote. It was not a cascade level, it was a promise the API did not keep —
 * `org-settings.service.ts` resolves a category from `code default → org_setting` and stops, and
 * `provisioning/catalog/cascade.ts` states in a comment that a device has no user so the level
 * does not apply to it either.
 *
 * Per-user preferences are a real feature and this table was not most of it. That feature needs a
 * catalogue of user-scoped setting names (there is none — `SETTING_CATALOG` is entirely
 * organization-scoped), a `settings.read.own` / `settings.write.own` permission pair, a resolver
 * that knows which settings a user may override at all, and a surface to set them from. Every one
 * of those decisions constrains the table's shape, so the honest state until they are made is no
 * table rather than an empty one that looks like the work is half done.
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
