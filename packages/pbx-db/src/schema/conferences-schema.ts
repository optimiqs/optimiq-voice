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
import type { RecordPolicy } from "./extensions-schema";

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
		/**
		 * How much of this room's audio is captured.
		 *
		 * The same vocabulary `extension`, `trunk` and `queue` carry, and it replaced a boolean here
		 * for the reason it replaced one on `queue`: "record this" and "record nothing" are two
		 * points on a scale the rest of the schema already has five of, and a tenant who can say
		 * `on-demand` for an extension and only `yes`/`no` for a room is looking at an inconsistency
		 * rather than a decision.
		 *
		 * `inbound` and `outbound` are accepted and mean the same thing here as `all`: every leg in a
		 * conference is inbound TO the room, so there is no outbound half to leave out. They are not
		 * refused because the vocabulary is shared — a check constraint that allowed three of five
		 * values on one table would be a second, narrower vocabulary wearing the same name.
		 */
		recordPolicy: text("record_policy").$type<RecordPolicy>().notNull().default("none"),
		mohClassId: uuidEntityId("moh_class_id").references(() => mohClass.id, {
			onDelete: "set null",
		}),
		/**
		 * Play each arrival's and departure's recorded NAME to the room.
		 *
		 * Distinct from {@link entryToneEnabled} below, which is the beep. A name announcement needs a
		 * recording of the participant saying who they are and costs everybody in the meeting three
		 * seconds of somebody's voice; a tone costs a quarter of a second and needs nothing recorded.
		 * A large room usually wants the second and not the first, which is not a preference either
		 * flag could express on its own.
		 */
		announceJoinLeave: boolean("announce_join_leave").notNull().default(true),
		/**
		 * Beep the room when somebody joins. Default ON, and the default is a privacy position rather
		 * than a taste: a participant who cannot tell that a third party has arrived is a participant
		 * who does not know the conversation stopped being private.
		 */
		entryToneEnabled: boolean("entry_tone_enabled").notNull().default(true),
		/** Beep the room when somebody leaves. Pairs with {@link entryToneEnabled}. */
		exitToneEnabled: boolean("exit_tone_enabled").notNull().default(true),
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
