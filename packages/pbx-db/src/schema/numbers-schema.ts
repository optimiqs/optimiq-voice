import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
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
import { prompt } from "./media-schema";

/**
 * What a tenant asks of a call it records, before the recorder is allowed to exist.
 *
 * Mirrored here rather than imported: `packages/routing` owns the canonical vocabulary
 * (`recording-consent.ts`) and this package cannot depend on it — the same arrangement
 * `RECORD_POLICIES` lives under in `extensions-schema.ts`. The values are identical by contract and
 * the spec pins the spelling, so the two copies cannot drift silently.
 *
 * `announce` plays a disclosure and records regardless; `announce-and-require-keypress` refuses to
 * start the tap at all unless the party accepts. That difference is the whole reason this is an
 * enum and not a boolean: consent that is asked for and consent that is merely announced are
 * different legal postures, and a tenant in an all-party jurisdiction needs to be able to say which
 * one they are taking.
 */
export const RECORDING_CONSENT_POLICIES = [
	"none",
	"announce",
	"announce-and-require-keypress",
] as const;
export type RecordingConsentPolicy = (typeof RECORDING_CONSENT_POLICIES)[number];

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
		/**
		 * This DID's consent posture, overriding the organization's. NULL — the default and the
		 * value on every row written before this column existed — means "inherit the org", which is
		 * why it is nullable rather than `not null default 'none'`: a default would make every
		 * existing DID assert a policy nobody chose for it, and the compiler could no longer tell an
		 * explicit `none` from silence when the org later says `announce`.
		 *
		 * Per-DID because jurisdiction follows the NUMBER. A tenant with a California DID and a Texas
		 * DID has two different obligations on one account, and an org-wide setting can only satisfy
		 * both by applying the stricter one to calls that never needed it.
		 */
		recordingConsentPolicy: text("recording_consent_policy").$type<RecordingConsentPolicy>(),
		/**
		 * The disclosure this DID plays. NULL falls back to the org's prompt and then to the seeded
		 * system stem, so a tenant who never uploads anything still announces.
		 *
		 * `on delete set null` for the reason every other prompt reference uses it: deleting a media
		 * file must not delete the DID that referenced it, and `restrict` would make retiring an old
		 * greeting a puzzle. The cost is a fallback to the system stem, which still discloses — the
		 * announcement degrades, it never disappears.
		 */
		recordingConsentPromptId: uuidEntityId("recording_consent_prompt_id").references(
			() => prompt.id,
			{ onDelete: "set null" },
		),
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
		// NULL passes: it is "inherit the org", not an unspecified policy. Anything else must be one
		// of the three the compiler and the engine both understand — a typo here is a call that
		// silently records without disclosing.
		check(
			"phone_number_recording_consent_policy_check",
			sql`recording_consent_policy is null or recording_consent_policy in ('none', 'announce', 'announce-and-require-keypress')`,
		),
		destinationCheck("phone_number"),
		carrierCheck("phone_number"),
		tenantIsolationPolicy("phone_number"),
	],
);
