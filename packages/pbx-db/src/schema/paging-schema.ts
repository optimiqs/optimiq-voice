import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { extension } from "./extensions-schema";

/**
 * Paging groups — one-way announcements and talkback intercom to a set of handsets.
 *
 * A page is not a call in the sense the rest of this schema means it. Every other entity here ends
 * by handing the call somewhere else (a ring group's timeout goes to voicemail, a queue's goes to a
 * ring group), which is why they all carry a destination trio. A page has nowhere to go: the pager
 * speaks, the members' handsets auto-answer, and when the pager hangs up the whole thing is over.
 * There is no timeout branch to take, because a page does not wait for an answer — it *causes* one.
 * So there is deliberately no `namedDestinationColumns("timeout")` here, and adding one later would
 * be inventing a state ("the page went unanswered") that the feature does not have.
 *
 * # Why membership is a real table with a foreign key
 *
 * `extension.pickup_group` is free text and that is right for a pickup group: a group is a NAME an
 * administrator gives a set of desks, it has no properties, and set membership is the whole of it.
 * A paging group is the opposite on both counts. A page must ring a REAL endpoint — the engine
 * originates a leg per member and auto-answers it — so a member that does not resolve is not a
 * cosmetic error, it is a page that silently reaches fewer people than the operator believes it
 * does. A text list would make that failure invisible until the day of the fire drill, whereas a
 * foreign key with `on delete cascade` means deleting an extension removes it from every group it
 * was in, at the moment of the delete, in the same transaction.
 *
 * `ordinal` exists for the same reason a ring group's does: an announcement to a hundred handsets
 * is fanned out rather than originated in one instant, and the order in which the fan-out proceeds
 * is the operator's decision, not the database's. Without a column for it the order would be
 * whatever the loader's `ORDER BY` happened to be, which is a decision nobody made and nobody can
 * change.
 *
 * Multicast RTP — the other way to page, where the engine sends one stream to a group address and
 * the handsets subscribe — is deliberately not modelled. It needs a network the tenant controls and
 * a per-model handset configuration, and neither is a routing fact. Unicast fan-out is what this
 * describes.
 */

export const pagingGroup = pgTable.withRLS(
	"paging_group",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		/**
		 * Dialable number for the group, when it has one. Nullable because a group reachable only
		 * through the `*81<id>` feature code has none, and a group with no number must not be forced
		 * to invent one that then collides with an extension.
		 */
		extensionNumber: text("extension_number"),
		/** `false` is a one-way announcement; `true` is talkback — members can be heard back. */
		duplex: boolean("duplex").notNull().default(false),
		/** How long a member's auto-answered leg may take to come up before it is given up on. */
		timeoutSeconds: integer("timeout_seconds").notNull().default(30),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("paging_group_organization_name_key").on(table.organizationId, table.name),
		uniqueIndex("paging_group_organization_extension_number_key")
			.on(table.organizationId, table.extensionNumber)
			.where(sql`extension_number is not null`),
		index("paging_group_organization_enabled_idx").on(table.organizationId, table.enabled),
		tenantIsolationPolicy("paging_group"),
	],
);

/**
 * One handset in a paging group.
 *
 * Two unique indexes rather than one: `(group, extension)` stops the same desk being paged twice by
 * one announcement, and `(group, ordinal)` stops two members claiming the same position in the
 * fan-out — which would put the order back in the loader's hands, which is what the column exists
 * to take away.
 */
export const pagingGroupMember = pgTable.withRLS(
	"paging_group_member",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		pagingGroupId: uuidEntityId("paging_group_id")
			.notNull()
			.references(() => pagingGroup.id, { onDelete: "cascade" }),
		extensionId: uuidEntityId("extension_id")
			.notNull()
			.references(() => extension.id, { onDelete: "cascade" }),
		ordinal: integer("ordinal").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("paging_group_member_group_extension_key").on(
			table.organizationId,
			table.pagingGroupId,
			table.extensionId,
		),
		uniqueIndex("paging_group_member_group_ordinal_key").on(
			table.organizationId,
			table.pagingGroupId,
			table.ordinal,
		),
		index("paging_group_member_organization_group_idx").on(
			table.organizationId,
			table.pagingGroupId,
		),
		tenantIsolationPolicy("paging_group_member"),
	],
);
