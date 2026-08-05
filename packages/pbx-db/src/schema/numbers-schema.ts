import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { destinationCheck, destinationColumns } from "./columns";
import { emergencyAddress } from "./emergency-schema";

/**
 * DIDs. The physical table is `phone_number` rather than `number` because `number` reads as a
 * column everywhere else in the schema (`extension.number`, `conference.room_number`).
 *
 * The destination trio is the DID's default route. An inbound route may still override it — the
 * routing compiler resolves route matches first and falls back to the number's own destination.
 */

export const phoneNumber = pgTable.withRLS(
	"phone_number",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/** Always stored E.164, `+` included. */
		e164: text("e164").notNull(),
		label: text("label"),
		...destinationColumns(),
		/** Prefixed onto the inbound caller-id name, e.g. `[Support] `. */
		callerIdNamePrefix: text("caller_id_name_prefix"),
		recordEnabled: boolean("record_enabled").notNull().default(false),
		emergencyAddressId: uuidEntityId("emergency_address_id").references(() => emergencyAddress.id, {
			onDelete: "set null",
		}),
		voiceEnabled: boolean("voice_enabled").notNull().default(true),
		faxEnabled: boolean("fax_enabled").notNull().default(false),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("phone_number_organization_e164_key").on(table.organizationId, table.e164),
		index("phone_number_organization_enabled_idx").on(table.organizationId, table.enabled),
		index("phone_number_organization_destination_idx").on(
			table.organizationId,
			table.destinationType,
			table.destinationRef,
		),
		index("phone_number_organization_emergency_address_idx").on(
			table.organizationId,
			table.emergencyAddressId,
		),
		destinationCheck("phone_number"),
		tenantIsolationPolicy("phone_number"),
	],
);
