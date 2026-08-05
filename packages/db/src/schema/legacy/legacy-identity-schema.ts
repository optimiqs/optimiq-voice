import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "../auth/identity-schema";
import { organization } from "../auth/organization-schema";
import { utcTimestamp, uuidEntityId } from "../primitives";

/**
 * The `accessKeyId → organization.id` mapping produced by identity-removal **Step 2**.
 *
 * These two tables are the durable output of the one-shot `fnidentity` → base-database
 * migration (`apps/api/scripts/migrate-identity-to-organizations.ts`). They are NOT better-auth
 * tables and nothing in `packages/auth` reads them; they exist because:
 *
 * 1. **Step 5 needs a join key.** Every telephony row still stores an owning `accessKeyId`
 *    (a `WO…` workspace key) — in `applications.access_key_id` / `secrets.access_key_id` for
 *    `apps/api`, and in the `extended` JSONB column for the sipnet/Routr resources. Backfilling
 *    `organization_id uuid not null` requires a lookup table that survives the migration run.
 * 2. **The cutover is a coexistence period, not an instant.** While the gRPC surface still speaks
 *    `accessKeyId` and the HTTP surface already speaks `organization.id`, something has to
 *    translate. `apps/api/src/auth/legacy-access-key.repository.ts` reads exactly these rows.
 * 3. **Reruns must be safe.** The migration is idempotent because these tables are its ledger:
 *    a legacy ref that is already mapped is skipped rather than duplicated.
 *
 * They are dropped in identity-removal Step 9, together with `fnidentity` itself — by which
 * point every telephony table carries a real `organization_id` and nothing looks up an
 * `accessKeyId` any more.
 */

/**
 * One row per legacy `workspaces` row. `access_key_id` is the `WO…` key the telephony tables
 * store; `organization_id` is the better-auth organization it became.
 */
export const legacyWorkspaceOrganization = pgTable(
	"legacy_workspace_organization",
	{
		/** The legacy workspace access key (`WO…`). The value telephony rows carry today. */
		accessKeyId: text("access_key_id").primaryKey(),
		/** `workspaces.ref` in `fnidentity` — the source row this mapping was derived from. */
		workspaceRef: text("workspace_ref").notNull(),
		organizationId: uuidEntityId("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		migratedAt: utcTimestamp("migrated_at").notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("legacy_workspace_organization_workspace_ref_key").on(table.workspaceRef),
		uniqueIndex("legacy_workspace_organization_organization_key").on(table.organizationId),
		index("legacy_workspace_organization_migrated_idx").on(table.migratedAt),
	],
);

/**
 * One row per legacy `users` row. The `US…` access key never scoped a telephony resource — it
 * identified a person — so it maps to `user.id`, not to an organization.
 */
export const legacyUserAccount = pgTable(
	"legacy_user_account",
	{
		/** The legacy user access key (`US…`). */
		accessKeyId: text("access_key_id").primaryKey(),
		/** `users.ref` in `fnidentity`. */
		userRef: text("user_ref").notNull(),
		userId: uuidEntityId("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/**
		 * Whether the legacy credential survived the move. `false` means the cloaked password
		 * could not be decrypted with the configured key, so no `account` row was written and the
		 * user must reset their password. The migration reports the count; this column is the
		 * per-user record of it.
		 */
		passwordMigrated: boolean("password_migrated").notNull().default(true),
		migratedAt: utcTimestamp("migrated_at").notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("legacy_user_account_user_ref_key").on(table.userRef),
		uniqueIndex("legacy_user_account_user_key").on(table.userId),
	],
);
