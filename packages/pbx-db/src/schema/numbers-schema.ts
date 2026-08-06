import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { carrierCheck, carrierColumns } from "./carrier-schema";
import { destinationCheck, destinationColumns } from "./columns";
import { emergencyAddress } from "./emergency-schema";

/**
 * DIDs. The physical table is `phone_number` rather than `number` because `number` reads as a
 * column everywhere else in the schema (`extension.number`, `conference.room_number`).
 *
 * The destination trio is the DID's default route. An inbound route may still override it — the
 * routing compiler resolves route matches first and falls back to the number's own destination.
 *
 * ## Why `e164` is unique GLOBALLY and not just per tenant
 *
 * A DID is a number on the PSTN, and the PSTN has exactly one owner for it. Two organizations on
 * one platform claiming `+441632960111` is not a configuration choice, it is a claim that cannot
 * both be true — and the moment an inbound INVITE for that number arrives, the platform has to
 * decide which tenant it belongs to with no information that can decide it. "Last write wins" picks
 * a tenant at random and files another tenant's calls, recordings and CDRs under it: a billing error
 * and an isolation breach in one.
 *
 * So the constraint lives in the database, where it is the only mechanism that is atomic with the
 * write. RLS does not weaken it: a unique index is enforced against every row in the table,
 * including rows the inserting role cannot see, so the second tenant gets a `23505` rather than a
 * duplicate. That is also its one cost — the 409 tells the second tenant the number is taken
 * somewhere on the platform. `pbx.errors.ts` phrases that message so it says exactly that and
 * nothing more: never which organization, never any of its detail.
 *
 * The `did-index` KV bucket in `@optimiq-voice/events` is the DERIVED read model of this column;
 * this index is what makes that bucket's single-writer-per-key assumption true.
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
		/**
		 * Set when the platform ordered this DID through a managed carrier; NULL for a number an
		 * admin typed in. It is what makes "release it upstream on delete" a decision the row can
		 * answer rather than a carrier lookup keyed on an E.164 that any platform could claim.
		 * See `carrier-schema.ts`.
		 */
		...carrierColumns(),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("phone_number_organization_e164_key").on(table.organizationId, table.e164),
		// One DID, one owner, platform-wide. See the header for the full argument.
		uniqueIndex("phone_number_e164_global_key").on(table.e164),
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
		index("phone_number_organization_carrier_idx").on(
			table.organizationId,
			table.carrierProvider,
			table.carrierRef,
		),
		destinationCheck("phone_number"),
		carrierCheck("phone_number"),
		tenantIsolationPolicy("phone_number"),
	],
);
