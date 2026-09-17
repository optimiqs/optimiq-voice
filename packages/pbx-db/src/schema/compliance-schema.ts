import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	utcTimestamp,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";

/**
 * Know-your-customer, and the caller ids a tenant has a right to present.
 *
 * ## Why a platform that sells software needs a KYC table at all
 *
 * A reseller that serves end users is its own voice service provider (FCC, and the 2026 Robocall
 * Mitigation Database rules make it a certification rather than a posture): it owes its own RMD
 * filing, a documented know-your-customer process, and a traceback answer inside 24 hours. This
 * platform IS that reseller's software, so "we asked the customer who they are, and here is what
 * they answered and who accepted it" has to be a row somewhere. A billing email is not it.
 *
 * ## Why the two tables are one file
 *
 * They are one question asked twice. `organization_kyc` is "do we know who this customer is", and
 * `verified_caller_id` is "do we know they may present this number" — the two facts the April 2026
 * FNPRM turns into an A/B/C attestation decision, which `packages/routing`'s `attestation.ts` then
 * makes. Splitting them would put the two halves of one compile input in two places.
 */

/**
 * How far the onboarding review got.
 *
 * Four values and not a boolean, because the interesting state is the third one: `needs-info` is a
 * reviewer who read the file and wants a document, and collapsing it into `pending` would lose the
 * difference between "nobody has looked" and "we are waiting on the customer". `rejected` is
 * terminal in intent but not in mechanism — a tenant may amend and resubmit, which moves it back to
 * `pending`, and the audit log is where the history of that lives.
 */
export const KYC_DECISIONS = ["pending", "approved", "rejected", "needs-info"] as const;
export type KycDecision = (typeof KYC_DECISIONS)[number];

/** The legal shapes a customer can be. Deliberately coarse — this is a routing input, not a filing. */
export const KYC_ENTITY_TYPES = [
	"sole-proprietor",
	"partnership",
	"private-company",
	"public-company",
	"non-profit",
	"government",
] as const;
export type KycEntityType = (typeof KYC_ENTITY_TYPES)[number];

/**
 * One row per organization: who the customer says they are, and what the platform decided.
 *
 * ## `tax_id` is encrypted and every other column is not
 *
 * The envelope in `packages/db/src/secret-cipher.ts` is expensive to read (an unwrap per row) and
 * is worth spending exactly where a database dump would hand over something a third party can use
 * directly. A legal entity name and a registered address are public record in most jurisdictions;
 * an EIN, a VAT number or a company tax reference is the identifier a fraudster opens an account
 * with. So one column carries a `v1.` envelope and the rest are plain, and the column that is
 * encrypted is the one a reader almost never needs — the review screen shows the last four
 * characters, which is why {@link organizationKyc.taxIdLast4} exists as a separate plain column
 * rather than being derived by decrypting on every list.
 *
 * ## One row, enforced
 *
 * A unique index on `organization_id` alone, not a primary key on it: the row still carries its own
 * uuid so the audit log can name it the way it names every other mutation, and so a future
 * amendment history (a second table keyed on this id) has something to point at.
 */
export const organizationKyc = pgTable.withRLS(
	"organization_kyc",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),

		/** The registered name, exactly as it appears on the incorporation document. */
		legalEntityName: text("legal_entity_name").notNull(),
		entityType: text("entity_type").$type<KycEntityType>().notNull(),
		/**
		 * The tax or company registration identifier, sealed with the platform envelope key.
		 *
		 * Nullable because a sole proprietor in some jurisdictions genuinely has none, and refusing
		 * the whole file over it would push those tenants outside the process rather than into it.
		 */
		taxId: text("tax_id"),
		/** The last four characters of {@link taxId}, in plaintext, for the review screen. */
		taxIdLast4: text("tax_id_last4"),

		addressLine1: text("address_line1").notNull(),
		addressLine2: text("address_line2"),
		addressCity: text("address_city").notNull(),
		addressRegion: text("address_region"),
		addressPostalCode: text("address_postal_code"),
		/** ISO 3166-1 alpha-2. */
		addressCountry: text("address_country").notNull(),

		/** The human who can speak for the customer. A role inbox is not one. */
		contactName: text("contact_name").notNull(),
		contactEmail: text("contact_email").notNull(),
		contactPhone: text("contact_phone"),
		websiteUrl: text("website_url"),

		/**
		 * What the customer says they will send, in their own words, plus a number.
		 *
		 * Both, and not one or the other. The prose is what a reviewer reads ("outbound appointment
		 * reminders for dental practices"); the minutes are what an anomaly alert can later be
		 * compared against, which is the only part of a KYC file that keeps working after the review
		 * is over.
		 */
		expectedTrafficProfile: text("expected_traffic_profile"),
		expectedMonthlyMinutes: integer("expected_monthly_minutes"),

		decision: text("decision").$type<KycDecision>().notNull().default("pending"),
		/**
		 * The reviewing user, and when.
		 *
		 * A `user.id` and deliberately NOT a foreign key: `user` lives in the auth database and this
		 * one holds no cross-database references anywhere. A reviewer who later leaves must not take
		 * the decision record with them, which is the same argument the CDR's denormalised labels
		 * make one database over.
		 */
		reviewedBy: uuidEntityId("reviewed_by"),
		reviewedAt: utcTimestamp("reviewed_at"),
		/** What the reviewer asked for, or why they refused. Shown to the tenant. */
		reviewNotes: text("review_notes"),

		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("organization_kyc_organization_key").on(table.organizationId),
		index("organization_kyc_decision_idx").on(table.decision, table.organizationId),
		check("organization_kyc_decision_check", inList("decision", KYC_DECISIONS)),
		check("organization_kyc_entity_type_check", inList("entity_type", KYC_ENTITY_TYPES)),
		check(
			"organization_kyc_expected_minutes_check",
			sql`expected_monthly_minutes is null or expected_monthly_minutes >= 0`,
		),
		tenantIsolationPolicy("organization_kyc"),
	],
);

/**
 * How the platform satisfied itself that a tenant may present a number it does not own.
 *
 * `document` is somebody uploading a carrier invoice or a letter of authorisation; `call-back` is
 * the classic verify-by-calling-it-and-reading-a-code; `carrier-loa` is a letter of authorisation
 * held by the losing carrier. All three are B-attestation evidence and none of them is A — A is
 * reserved for a number this platform assigned, which needs no row here at all because
 * `phone_number` already IS that record.
 */
export const CALLER_ID_VERIFICATION_METHODS = ["document", "call-back", "carrier-loa"] as const;
export type CallerIdVerificationMethod = (typeof CALLER_ID_VERIFICATION_METHODS)[number];

/**
 * An external number this organization has documented a right to present.
 *
 * ## Why this is not a column on `phone_number`
 *
 * `phone_number` is a DID the platform routes traffic TO, and its `e164` is unique platform-wide
 * because the PSTN has one owner per number. A verified caller id is the opposite fact: a number
 * somebody ELSE owns, which this tenant may present outbound, and which several tenants can
 * legitimately have a claim on at once — a franchise group presenting head office's number is the
 * ordinary case. Putting it in `phone_number` would collide with that unique index and would make
 * an inbound INVITE for the number resolvable to a tenant that does not answer it.
 *
 * ## Expiry is a column, and an expired row is kept
 *
 * A verification is a snapshot of a document, and a letter of authorisation from four years ago is
 * not evidence of anything. `expires_at` is nullable — most methods produce no expiry — and the
 * compiler treats a past one as absent, which downgrades the call to whatever the organization's
 * unverified-caller-id policy says. The row itself stays, because "we used to have evidence and it
 * lapsed" is exactly what an enforcement inquiry asks about.
 */
export const verifiedCallerId = pgTable.withRLS(
	"verified_caller_id",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/** Always stored E.164, `+` included, like every other number column in this database. */
		e164: text("e164").notNull(),
		label: text("label"),
		verificationMethod: text("verification_method").$type<CallerIdVerificationMethod>().notNull(),
		/** The document reference, the LOA id, the call-back transaction — whatever names the proof. */
		verificationReference: text("verification_reference"),
		/** The object key of the uploaded evidence, when there is one. */
		evidenceObjectKey: text("evidence_object_key"),
		/** The `user.id` who accepted it. Not a foreign key, for the reason `reviewed_by` is not. */
		verifiedBy: uuidEntityId("verified_by"),
		verifiedAt: utcTimestamp("verified_at").notNull().defaultNow(),
		expiresAt: utcTimestamp("expires_at"),
		notes: text("notes"),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("verified_caller_id_organization_e164_key").on(table.organizationId, table.e164),
		check(
			"verified_caller_id_method_check",
			inList("verification_method", CALLER_ID_VERIFICATION_METHODS),
		),
		tenantIsolationPolicy("verified_caller_id"),
	],
);

/** `column in ('a', 'b')` for a closed value domain, quoted the way the rest of the schema quotes. */
function inList(column: string, values: readonly string[]) {
	const list = values.map((value) => `'${value}'`).join(", ");
	return sql.raw(`"${column}" in (${list})`);
}

export type OrganizationKycRow = typeof organizationKyc.$inferSelect;
export type NewOrganizationKycRow = typeof organizationKyc.$inferInsert;
export type VerifiedCallerIdRow = typeof verifiedCallerId.$inferSelect;
export type NewVerifiedCallerIdRow = typeof verifiedCallerId.$inferInsert;
