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
 * FusionPBX has three DB levels (default → domain → user). Ours has TWO, because **platform
 * defaults live in code**, not in a table: a default row nobody wrote is indistinguishable from
 * a deliberate override, and a code-owned default is versioned, typed and reviewable. So the
 * resolution order is `code default → org_setting → user_setting`, and provisioning extends the
 * organization level with `device_profile.settings → device.settings` (columns on those tables,
 * not rows here — a device has no user, so the user level never applies to provisioning).
 *
 * ## Why `user_setting` is back, and what had to exist first
 *
 * The table shipped in the baseline, was dropped by `20260811204713_pbx_drop_user_setting`, and is
 * now back — and the history matters, so it is converted here rather than deleted. The original
 * table had RLS, a unique index and a tenant grant that no line of code in `apps/api`, `apps/web`,
 * `apps/engine` or any package ever read or wrote. It was not a cascade level, it was a promise
 * the API did not keep, and the drop note named four prerequisites for its return — every one of
 * which constrains this table's shape, and every one of which now exists:
 *
 * 1. **A catalogue of user-scoped setting names.** `org-settings.catalog.ts` gives every
 *    `SettingDescriptor` a `scope`, defaulting to `organization`; exactly the settings that are
 *    genuinely one person's presentation preference are marked `user`. This is why `category` and
 *    `name` here are plain text with no check constraint: the catalogue is the closed list, and it
 *    can tighten without a migration because the resolver IGNORES a row for a name the catalogue
 *    no longer marks user-scoped.
 * 2. **A `settings.read.own` / `settings.write.own` permission pair.** Declared and described in
 *    `packages/auth/src/permissions.ts` and granted in `SELF_SERVICE_PERMISSIONS`, with the
 *    argument for why they are NOT a scope-narrowing of `settings.write`: the unscoped grant edits
 *    the organization's answer, this pair edits one person's override of it.
 * 3. **A resolver that knows which settings a user may override.** `resolveForUser` in
 *    `org-settings.catalog.ts` applies `code default → org_setting → user_setting`, treats a
 *    disabled row as absent at both levels, and drops a user row the catalogue does not sanction.
 * 4. **A surface to set them from.** `GET /api/v1/org-settings/me` and
 *    `PATCH /api/v1/org-settings/me/categories/:category`, whose service writes
 *    `userId: session.user.id` unconditionally — the id is not an input, which is the whole
 *    own-ness argument.
 *
 * `userId` is a better-auth `user.id` from ANOTHER database, so there is no foreign key — the same
 * cross-context rule `extension_user.user_id` states. It is `text` rather than `uuid` because this
 * side does not own the identifier's shape: a malformed id here should be an unmatchable row, not
 * a 22P02 that rolls back a preferences save.
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

/**
 * One user's override of one catalogued setting — the third level of the cascade.
 *
 * Deliberately the same row shape as `org_setting` plus the owner: the resolver overlays the two
 * levels by `name`, and a column that existed at one level and not the other would be a value that
 * cannot cascade. The differences are the ones the level itself demands — `userId` (see the header
 * for why it is FK-less text), and no `description` column, because a preference row is written by
 * a form that labels it from the catalogue rather than by an operator annotating a raw row.
 *
 * The unique index is `(organization_id, user_id, category, name)` — one override per person per
 * setting — and the `(organization_id, user_id)` index is the preferences screen's read path:
 * "everything this person has overridden", across categories, in one seek.
 */
export const userSetting = pgTable.withRLS(
	"user_setting",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/** `user.id` in the auth database. No FK, and text on purpose — see the file header. */
		userId: text("user_id").notNull(),
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
