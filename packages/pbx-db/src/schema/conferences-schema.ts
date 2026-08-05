import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { destinationCheck, namedDestinationColumns } from "./columns";
import { mohClass } from "./media-schema";

/**
 * Conference rooms and call-park lots.
 *
 * FusionPBX ships both "conferences" (static rooms) and "conference centers" (multi-room with
 * PINs and session logs); only one model survives here — a room with an optional participant PIN
 * and an optional moderator PIN. Session and participant history belongs to the CDR context.
 */

export const conference = pgTable.withRLS(
	"conference",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		roomNumber: text("room_number").notNull(),
		pinHash: text("pin_hash"),
		moderatorPinHash: text("moderator_pin_hash"),
		maxMembers: integer("max_members").notNull().default(50),
		recordEnabled: boolean("record_enabled").notNull().default(false),
		mohClassId: uuidEntityId("moh_class_id").references(() => mohClass.id, {
			onDelete: "set null",
		}),
		announceJoinLeave: boolean("announce_join_leave").notNull().default(true),
		/** Hold participants in MOH until a moderator PIN is entered. */
		waitForModerator: boolean("wait_for_moderator").notNull().default(false),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("conference_organization_room_number_key").on(
			table.organizationId,
			table.roomNumber,
		),
		uniqueIndex("conference_organization_name_key").on(table.organizationId, table.name),
		index("conference_organization_enabled_idx").on(table.organizationId, table.enabled),
		tenantIsolationPolicy("conference"),
	],
);

export const parkLot = pgTable.withRLS(
	"park_lot",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		/** Inclusive dialable slot range, e.g. 701–720. */
		slotStart: integer("slot_start").notNull(),
		slotEnd: integer("slot_end").notNull(),
		/** How long a call may sit parked before it is retrieved automatically. */
		timeoutSeconds: integer("timeout_seconds").notNull().default(120),
		...namedDestinationColumns("timeout"),
		mohClassId: uuidEntityId("moh_class_id").references(() => mohClass.id, {
			onDelete: "set null",
		}),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("park_lot_organization_name_key").on(table.organizationId, table.name),
		check("park_lot_slot_range_check", sql`slot_end >= slot_start`),
		destinationCheck("park_lot", "timeout", true),
		tenantIsolationPolicy("park_lot"),
	],
);
