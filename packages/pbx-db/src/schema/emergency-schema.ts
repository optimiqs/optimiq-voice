import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	utcTimestamp,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";

/**
 * Dispatchable locations for E911 (Kari's Law / RAY BAUM'S Act). A number may only be used for
 * emergency origination once its address has been validated by the upstream provider, so
 * `validated` is a hard gate the CRUD layer must check before allowing an emergency caller id.
 */

export const emergencyAddress = pgTable.withRLS(
	"emergency_address",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		label: text("label").notNull(),
		streetLine1: text("street_line1").notNull(),
		streetLine2: text("street_line2"),
		/** Room / floor / suite — the "dispatchable location" detail RAY BAUM'S requires. */
		locationDetail: text("location_detail"),
		locality: text("locality").notNull(),
		administrativeArea: text("administrative_area").notNull(),
		postalCode: text("postal_code").notNull(),
		/** ISO 3166-1 alpha-2. */
		country: text("country").notNull().default("US"),
		validated: boolean("validated").notNull().default(false),
		validatedAt: utcTimestamp("validated_at"),
		validationProvider: text("validation_provider"),
		validationReference: text("validation_reference"),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("emergency_address_organization_label_key").on(table.organizationId, table.label),
		index("emergency_address_organization_validated_idx").on(table.organizationId, table.validated),
		tenantIsolationPolicy("emergency_address"),
	],
);
