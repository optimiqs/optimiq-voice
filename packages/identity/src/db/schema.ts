import {
	boolean,
	foreignKey,
	index,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

const verificationType = pgEnum("VerificationType", ["EMAIL", "PHONE"]);
const workspaceMemberStatus = pgEnum("workspace_member_status", ["PENDING", "ACTIVE"]);
const role = pgEnum("role", ["USER", "WORKSPACE_ADMIN", "WORKSPACE_OWNER", "WORKSPACE_MEMBER"]);

const users = pgTable(
	"users",
	{
		ref: text("ref").notNull(),
		accessKeyId: varchar("access_key_id", { length: 255 }).notNull(),
		name: varchar("name", { length: 60 }).notNull(),
		email: varchar("email", { length: 255 }).notNull(),
		emailVerified: boolean("email_verified").default(false).notNull(),
		password: text("password_hash").notNull(),
		phoneNumber: varchar("phone_number", { length: 20 }),
		phoneNumberVerified: boolean("phone_number_verified").default(false).notNull(),
		avatar: varchar("avatar", { length: 255 }),
		createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
		extended: jsonb("extended").$type<JsonValue>(),
	},
	(table) => [
		primaryKey({ name: "users_pkey", columns: [table.ref] }),
		uniqueIndex("users_access_key_id_key").on(table.accessKeyId),
		uniqueIndex("users_email_key").on(table.email),
		index("users_email_idx").using("hash", table.email),
		index("users_access_key_id_idx").using("hash", table.accessKeyId),
	],
);

const workspaces = pgTable(
	"workspaces",
	{
		ref: text("ref").notNull(),
		accessKeyId: varchar("access_key_id", { length: 255 }).notNull(),
		name: varchar("name", { length: 60 }).notNull(),
		createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
		ownerRef: text("owner_ref").notNull(),
	},
	(table) => [
		primaryKey({ name: "workspaces_pkey", columns: [table.ref] }),
		uniqueIndex("workspaces_access_key_id_key").on(table.accessKeyId),
		index("workspaces_access_key_id_idx").using("hash", table.accessKeyId),
		index("workspaces_owner_ref_idx").using("hash", table.ownerRef),
		foreignKey({
			name: "workspaces_owner_ref_fkey",
			columns: [table.ownerRef],
			foreignColumns: [users.ref],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

const workspaceMembers = pgTable(
	"workspace_members",
	{
		ref: text("ref").notNull(),
		status: workspaceMemberStatus("status").default("PENDING").notNull(),
		role: role("role").default("WORKSPACE_MEMBER").notNull(),
		createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
		userRef: text("user_ref").notNull(),
		workspaceRef: text("workspace_ref").notNull(),
	},
	(table) => [
		primaryKey({ name: "workspace_members_pkey", columns: [table.ref] }),
		uniqueIndex("workspace_members_user_ref_workspace_ref_key").on(
			table.userRef,
			table.workspaceRef,
		),
		foreignKey({
			name: "workspace_members_user_ref_fkey",
			columns: [table.userRef],
			foreignColumns: [users.ref],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "workspace_members_workspace_ref_fkey",
			columns: [table.workspaceRef],
			foreignColumns: [workspaces.ref],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

const apiKeys = pgTable(
	"api_keys",
	{
		ref: text("ref").notNull(),
		accessKeyId: varchar("access_key_id", { length: 255 }).notNull(),
		accessKeySecret: varchar("access_key_secret", { length: 255 }).notNull(),
		role: role("role").default("WORKSPACE_MEMBER").notNull(),
		createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
		expiresAt: timestamp("expires_at", { precision: 3, withTimezone: true }),
		workspaceRef: text("workspace_ref").notNull(),
	},
	(table) => [
		primaryKey({ name: "api_keys_pkey", columns: [table.ref] }),
		uniqueIndex("api_keys_access_key_id_key").on(table.accessKeyId),
		index("api_keys_access_key_id_idx").using("hash", table.accessKeyId),
		index("api_keys_workspace_ref_idx").using("hash", table.workspaceRef),
		foreignKey({
			name: "api_keys_workspace_ref_fkey",
			columns: [table.workspaceRef],
			foreignColumns: [workspaces.ref],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

const verificationCodes = pgTable(
	"verification_codes",
	{
		ref: text("ref").notNull(),
		type: verificationType("type").notNull(),
		code: varchar("code", { length: 6 }).notNull(),
		value: varchar("value", { length: 255 }).notNull(),
		expiresAt: timestamp("expires_at", {
			precision: 3,
			withTimezone: true,
		}).notNull(),
		createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		primaryKey({ name: "verification_codes_pkey", columns: [table.ref] }),
		index("verification_codes_code_idx").using("hash", table.code),
	],
);

export {
	apiKeys,
	JsonObject,
	JsonValue,
	role,
	users,
	verificationCodes,
	verificationType,
	workspaceMembers,
	workspaceMemberStatus,
	workspaces,
};
