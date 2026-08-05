import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { utcTimestamp, uuidEntityId, uuidV7PrimaryKey } from "../primitives";

/**
 * better-auth core identity tables.
 *
 * The Drizzle property keys are the better-auth field names (camelCase) because the
 * drizzle adapter resolves columns as `schema[model][field]`. The physical SQL column
 * names stay snake_case per repository convention — the adapter never reads them.
 * Identifiers are UUID v7 supplied by `advanced.database.generateId` in @optimiq-voice/auth.
 */
export const user = pgTable(
	"user",
	{
		id: uuidV7PrimaryKey(),
		name: text("name").notNull(),
		email: text("email").notNull(),
		emailVerified: boolean("email_verified").notNull().default(false),
		image: text("image"),
		createdAt: utcTimestamp("created_at").notNull().defaultNow(),
		updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
		/** admin plugin: platform-level role, distinct from organization membership roles. */
		role: text("role"),
		banned: boolean("banned").default(false),
		banReason: text("ban_reason"),
		banExpires: utcTimestamp("ban_expires"),
		/** two-factor plugin: mirrors whether any verified second factor is enrolled. */
		twoFactorEnabled: boolean("two_factor_enabled").default(false),
	},
	(table) => [uniqueIndex("user_email_key").on(table.email), index("user_role_idx").on(table.role)],
);

export const session = pgTable(
	"session",
	{
		id: uuidV7PrimaryKey(),
		expiresAt: utcTimestamp("expires_at").notNull(),
		token: text("token").notNull(),
		createdAt: utcTimestamp("created_at").notNull().defaultNow(),
		updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: uuidEntityId("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		/** organization plugin: the tenant claim that drives row-level security. */
		activeOrganizationId: uuidEntityId("active_organization_id"),
		/** admin plugin: set while an operator impersonates this user. */
		impersonatedBy: uuidEntityId("impersonated_by"),
	},
	(table) => [
		uniqueIndex("session_token_key").on(table.token),
		index("session_user_idx").on(table.userId),
		index("session_expires_idx").on(table.expiresAt),
		index("session_active_organization_idx").on(table.activeOrganizationId),
	],
);

export const account = pgTable(
	"account",
	{
		id: uuidV7PrimaryKey(),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		userId: uuidEntityId("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: utcTimestamp("access_token_expires_at"),
		refreshTokenExpiresAt: utcTimestamp("refresh_token_expires_at"),
		scope: text("scope"),
		password: text("password"),
		createdAt: utcTimestamp("created_at").notNull().defaultNow(),
		updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [
		index("account_user_idx").on(table.userId),
		index("account_provider_idx").on(table.providerId, table.accountId),
	],
);

export const verification = pgTable(
	"verification",
	{
		id: uuidV7PrimaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: utcTimestamp("expires_at").notNull(),
		createdAt: utcTimestamp("created_at").notNull().defaultNow(),
		updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
	},
	(table) => [
		index("verification_identifier_idx").on(table.identifier),
		index("verification_expires_idx").on(table.expiresAt),
	],
);
