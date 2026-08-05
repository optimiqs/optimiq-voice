import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { utcTimestamp, uuidEntityId, uuidV7PrimaryKey } from "../primitives";
import { user } from "./identity-schema";

/**
 * better-auth organization plugin tables. An organization IS the Optimiq Voice tenant:
 * `organization.id` is the value every org-scoped table stores in `organization_id` and
 * every row-level-security policy compares against.
 */
export const organization = pgTable(
	"organization",
	{
		id: uuidV7PrimaryKey(),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		logo: text("logo"),
		createdAt: utcTimestamp("created_at").notNull().defaultNow(),
		metadata: text("metadata"),
	},
	(table) => [uniqueIndex("organization_slug_key").on(table.slug)],
);

export const member = pgTable(
	"member",
	{
		id: uuidV7PrimaryKey(),
		organizationId: uuidEntityId("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: uuidEntityId("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		role: text("role").notNull().default("member"),
		createdAt: utcTimestamp("created_at").notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("member_organization_user_key").on(table.organizationId, table.userId),
		index("member_user_idx").on(table.userId),
		index("member_organization_role_idx").on(table.organizationId, table.role),
	],
);

export const invitation = pgTable(
	"invitation",
	{
		id: uuidV7PrimaryKey(),
		organizationId: uuidEntityId("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		role: text("role"),
		status: text("status").notNull().default("pending"),
		expiresAt: utcTimestamp("expires_at").notNull(),
		createdAt: utcTimestamp("created_at").notNull().defaultNow(),
		inviterId: uuidEntityId("inviter_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("invitation_organization_status_idx").on(table.organizationId, table.status),
		index("invitation_email_idx").on(table.email),
		index("invitation_expires_idx").on(table.expiresAt),
	],
);
