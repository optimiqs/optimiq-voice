import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	utcTimestamp,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { phoneNumber } from "./numbers-schema";

/**
 * Two-way SMS/MMS on business numbers, and the A2P registration that makes it legal to send.
 *
 * # Why messaging is its own six tables and not a column on `phone_number`
 *
 * A DID that carries voice and a DID that carries A2P text are the same E.164 and almost nothing
 * else. Voice needs a route, a trunk and an emergency address; messaging needs a carrier *messaging
 * profile*, a registered brand, an approved campaign the number is assigned to, and a per-recipient
 * consent ledger — and every one of those is a fact about the tenant's relationship with the
 * carriers, not about the number's place in the dial plan. Bolting `sms_enabled` onto
 * `phone_number` and stopping there is exactly how a platform ships a send button that the carriers
 * silently filter: the number is "enabled" and the traffic is unregistered.
 *
 * So `messaging_number` is a JOIN row — the DID plus the messaging facts about it — and the send
 * path reads it, not `phone_number`. A DID with no `messaging_number` row is voice-only, which is
 * the correct default for every number this platform has ever ordered.
 *
 * # Why the registration state is stored and not asked
 *
 * `messaging_brand` and `messaging_campaign` mirror The Campaign Registry's state through Telnyx.
 * They could in principle be read from the carrier on every send. They are not, for two reasons:
 * a send is on a request path and a carrier round trip is not, and — more importantly — the block
 * on an unregistered number has to be answerable when the carrier is unreachable. A projection that
 * a poller refreshes is a fact the send path can read in a millisecond and can defend in an
 * enforcement inquiry; a live lookup is neither.
 *
 * # Why the opt-out ledger is keyed by the PAIR
 *
 * CTIA's opt-out obligation is per *program*, and the smallest honest expression of a program on
 * this platform is the business number the consumer is talking to. A STOP sent to the support line
 * must not silence the appointment reminders from the clinic's other DID, and a STOP sent to one
 * tenant's number must never reach another tenant's — which is why `messaging_opt_out` is keyed
 * `(organization_id, messaging_number_id, remote_e164)` and not by remote number alone.
 */

/** Which way a message travelled. Switched on by the inbox UI and by the compliance handler. */
export const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/**
 * Where a `message` is in its lifecycle.
 *
 * Outbound walks `queued → sending → sent → delivered | failed`; inbound is filed straight as
 * `received`. `sent` and `delivered` are distinct on purpose and the difference is the whole point
 * of the delivery receipt: `sent` means the carrier accepted it, `delivered` means the handset's
 * network acknowledged it, and a program that treats the first as the second cannot tell a working
 * number from a filtered one. `delivered`, `failed` and `received` are terminal.
 */
export const MESSAGE_STATUSES = [
	"queued",
	"sending",
	"sent",
	"delivered",
	"failed",
	"received",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** SMS or MMS. Derived from whether the message carries media, never asked of the caller. */
export const MESSAGE_KINDS = ["SMS", "MMS"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/**
 * A2P registration state for a number, as this platform sees it.
 *
 * `unregistered` is the safe off-state a `messaging_number` is created in. `local` numbers must
 * reach `registered` through a 10DLC campaign assignment; `toll-free` numbers must reach it through
 * a verification submission; `short-code` is modelled so the enum does not have to change when one
 * is added, and is refused by the send path today.
 */
export const MESSAGING_REGISTRATION_STATUSES = [
	"unregistered",
	"pending",
	"registered",
	"rejected",
] as const;
export type MessagingRegistrationStatus = (typeof MESSAGING_REGISTRATION_STATUSES)[number];

/** How the number is classified for A2P purposes. Decides WHICH registration path applies. */
export const MESSAGING_NUMBER_CLASSES = ["local", "toll-free", "short-code"] as const;
export type MessagingNumberClass = (typeof MESSAGING_NUMBER_CLASSES)[number];

/**
 * TCR brand identity status, as Telnyx reports it on `GET /v2/10dlc/brand/{id}`.
 *
 * Kept as free text with a check rather than a Postgres enum for the reason the carrier schemas in
 * `@optimiq-voice/telnyx` are loose: TCR adds members, and a registry that gains a status must not
 * take the projection poller down. The four below are the ones the UI and the send gate branch on.
 */
export const MESSAGING_BRAND_STATUSES = [
	"pending",
	"self-declared",
	"verified",
	"vetted-verified",
	"unverified",
	"failed",
] as const;
export type MessagingBrandStatus = (typeof MESSAGING_BRAND_STATUSES)[number];

/** Campaign state. Only `active` unblocks a send. */
export const MESSAGING_CAMPAIGN_STATUSES = [
	"draft",
	"pending",
	"active",
	"expired",
	"rejected",
	"suspended",
] as const;
export type MessagingCampaignStatus = (typeof MESSAGING_CAMPAIGN_STATUSES)[number];

/** Toll-free verification state, mirroring the carrier's `verificationStatus`. */
export const TOLL_FREE_VERIFICATION_STATUSES = [
	"pending",
	"in-review",
	"verified",
	"rejected",
] as const;
export type TollFreeVerificationStatus = (typeof TOLL_FREE_VERIFICATION_STATUSES)[number];

/**
 * Why a consumer is on the suppression list.
 *
 * `keyword` is a STOP (or a recognised variant) the consumer texted; `manual` is an agent acting on
 * an opt-out that arrived by phone, email or a web form — which the FCC's April-2025 order makes a
 * channel this platform has to be able to record even though it cannot observe it.
 */
export const OPT_OUT_SOURCES = ["keyword", "manual", "carrier"] as const;
export type OptOutSource = (typeof OPT_OUT_SOURCES)[number];

// --------------------------------------------------------------------------------------------
// Registration: brand → campaign → number
// --------------------------------------------------------------------------------------------

/**
 * The tenant's registered business identity at The Campaign Registry, via Telnyx.
 *
 * One per organization in practice, but not constrained to one: a reseller's customer that trades
 * under two legal entities registers two brands, and a unique index on `organization_id` would make
 * that a support ticket. What IS unique is the carrier's brand id, so a redelivered poll or a
 * double-submit files one row.
 *
 * `ein` is a government identifier and is stored because TCR requires it on every submission and a
 * resubmission after a rejection must not make an admin retype it. It is never returned by the API
 * in full — the service masks it — and it is the reason this table's RLS policy matters as much as
 * the message table's.
 */
export const messagingBrand = pgTable.withRLS(
	"messaging_brand",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/** TCR/Telnyx brand id (`brandId`), set once the submission is accepted. Null while drafting. */
		carrierBrandId: text("carrier_brand_id"),
		displayName: text("display_name").notNull(),
		companyName: text("company_name").notNull(),
		/** TCR `entityType`: PRIVATE_PROFIT, PUBLIC_PROFIT, NON_PROFIT, GOVERNMENT, SOLE_PROPRIETOR. */
		entityType: text("entity_type").notNull(),
		/** EIN / business registration number. Masked on read; see the header. */
		ein: text("ein"),
		vertical: text("vertical"),
		email: text("email").notNull(),
		phone: text("phone"),
		website: text("website"),
		street: text("street"),
		city: text("city"),
		state: text("state"),
		postalCode: text("postal_code"),
		country: text("country").notNull().default("US"),
		status: text("status").$type<MessagingBrandStatus>().notNull().default("pending"),
		/**
		 * The registry's own words for a rejection. Carried verbatim because "why was my brand
		 * rejected" is a question only TCR can answer and paraphrasing it loses the answer.
		 */
		statusReason: text("status_reason"),
		/**
		 * Sole-proprietor brands need an SMS OTP round trip before TCR will vet them. This is the
		 * carrier-side reference for the outstanding challenge; null for every other entity type and
		 * once the PIN has been accepted.
		 */
		otpReference: text("otp_reference"),
		/** When the status poller last reconciled this row against the carrier. */
		lastPolledAt: utcTimestamp("last_polled_at"),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("messaging_brand_carrier_brand_id_key")
			.on(table.carrierBrandId)
			.where(sql`carrier_brand_id is not null`),
		index("messaging_brand_organization_status_idx").on(table.organizationId, table.status),
		check(
			"messaging_brand_status_check",
			sql`status in ('pending', 'self-declared', 'verified', 'vetted-verified', 'unverified', 'failed')`,
		),
		tenantIsolationPolicy("messaging_brand"),
	],
);

/**
 * A registered use case. Numbers are assigned to a campaign; only an `active` campaign may send.
 *
 * The opt-in/opt-out/help keyword columns are not decoration and not duplicated from the carrier for
 * display: they are what the platform's OWN compliance handler answers with. A campaign whose
 * `helpMessage` lives only at TCR is a campaign whose HELP reply this platform cannot send, and a
 * HELP that goes unanswered is the single most reliably-detected carrier violation there is.
 */
export const messagingCampaign = pgTable.withRLS(
	"messaging_campaign",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		brandId: uuidEntityId("brand_id")
			.notNull()
			.references(() => messagingBrand.id, { onDelete: "cascade" }),
		/** TCR/Telnyx campaign id, set once the submission is accepted. */
		carrierCampaignId: text("carrier_campaign_id"),
		name: text("name").notNull(),
		/** TCR `usecase`: MIXED, CUSTOMER_CARE, DELIVERY_NOTIFICATION, 2FA, … */
		useCase: text("use_case").notNull(),
		description: text("description").notNull(),
		/** The two-to-five sample messages TCR requires. Stored as an array so a resubmit is an edit. */
		sampleMessages: jsonb("sample_messages")
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** How consumers opt in, in the tenant's own words. Carrier review reads this closely. */
		messageFlow: text("message_flow").notNull(),
		/** The platform's reply to HELP. See the header — this is answered locally, not by TCR. */
		helpMessage: text("help_message").notNull(),
		/** The platform's reply to STOP, sent once and then never again to that pair. */
		optOutMessage: text("opt_out_message")
			.notNull()
			.default(
				"You have been unsubscribed and will receive no further messages. Reply START to resubscribe.",
			),
		optInKeywords: text("opt_in_keywords").notNull().default("START,UNSTOP,YES"),
		optOutKeywords: text("opt_out_keywords")
			.notNull()
			.default("STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT"),
		helpKeywords: text("help_keywords").notNull().default("HELP,INFO"),
		embeddedLink: boolean("embedded_link").notNull().default(false),
		ageGated: boolean("age_gated").notNull().default(false),
		/**
		 * Optional quiet hours, as minutes past local midnight, and the IANA zone they are read in.
		 *
		 * Nullable as a trio: NULL means "this campaign has no quiet hours", which is the right
		 * default for a two-way conversational inbox where a reply at 22:00 is a human answering a
		 * human. A promotional campaign sets 8am–9pm, which is what the TCPA's own restriction and
		 * every carrier's reading of it come to.
		 */
		quietHoursStartMinute: integer("quiet_hours_start_minute"),
		quietHoursEndMinute: integer("quiet_hours_end_minute"),
		quietHoursTimeZone: text("quiet_hours_time_zone"),
		status: text("status").$type<MessagingCampaignStatus>().notNull().default("draft"),
		statusReason: text("status_reason"),
		/**
		 * Messages per second the carriers allow this campaign, derived from the brand's vetting
		 * score. Null until the carrier reports one. The send path uses it as a ceiling, so a
		 * campaign that is throttled upstream is throttled here rather than discovering it as a
		 * wall of 429s.
		 */
		throughputPerSecond: integer("throughput_per_second"),
		lastPolledAt: utcTimestamp("last_polled_at"),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("messaging_campaign_carrier_campaign_id_key")
			.on(table.carrierCampaignId)
			.where(sql`carrier_campaign_id is not null`),
		uniqueIndex("messaging_campaign_organization_name_key").on(table.organizationId, table.name),
		index("messaging_campaign_organization_status_idx").on(table.organizationId, table.status),
		check(
			"messaging_campaign_status_check",
			sql`status in ('draft', 'pending', 'active', 'expired', 'rejected', 'suspended')`,
		),
		// The trio is all-or-nothing: two of three is a quiet-hours window with an undefined edge,
		// and an undefined edge in a send gate is a message sent at 3am.
		check(
			"messaging_campaign_quiet_hours_shape_check",
			sql`(quiet_hours_start_minute is null and quiet_hours_end_minute is null and quiet_hours_time_zone is null)
			    or (quiet_hours_start_minute is not null and quiet_hours_end_minute is not null and quiet_hours_time_zone is not null)`,
		),
		check(
			"messaging_campaign_quiet_hours_range_check",
			sql`(quiet_hours_start_minute is null or (quiet_hours_start_minute between 0 and 1439))
			    and (quiet_hours_end_minute is null or (quiet_hours_end_minute between 0 and 1439))`,
		),
		tenantIsolationPolicy("messaging_campaign"),
	],
);

/**
 * A toll-free verification submission.
 *
 * Separate from `messaging_campaign` because toll-free verification is not a TCR campaign: it is a
 * carrier-managed review with a different payload, a different timeline (one to two weeks against
 * days) and a different failure mode. Sharing a table would mean a column set where half the fields
 * are NULL for half the rows and the send gate has to know which half it is looking at.
 *
 * The three BRN columns are `not null` because they have been mandatory on every new submission
 * since 17 February 2026 — a submission without them is rejected at the carrier, so accepting one
 * here would only move the failure later.
 */
export const messagingTollFreeVerification = pgTable.withRLS(
	"messaging_toll_free_verification",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		messagingNumberId: uuidEntityId("messaging_number_id").notNull(),
		/** The carrier's `verificationRequestId` / record id, once submitted. */
		carrierVerificationId: text("carrier_verification_id"),
		businessName: text("business_name").notNull(),
		corporateWebsite: text("corporate_website").notNull(),
		businessAddr1: text("business_addr1").notNull(),
		businessAddr2: text("business_addr2"),
		businessCity: text("business_city").notNull(),
		businessState: text("business_state").notNull(),
		businessZip: text("business_zip").notNull(),
		businessContactFirstName: text("business_contact_first_name").notNull(),
		businessContactLastName: text("business_contact_last_name").notNull(),
		businessContactEmail: text("business_contact_email").notNull(),
		businessContactPhone: text("business_contact_phone").notNull(),
		/** Mandatory since 17 Feb 2026. See the header. */
		businessRegistrationNumber: text("business_registration_number").notNull(),
		businessRegistrationType: text("business_registration_type").notNull(),
		businessRegistrationCountry: text("business_registration_country").notNull(),
		useCase: text("use_case").notNull(),
		useCaseSummary: text("use_case_summary").notNull(),
		productionMessageContent: text("production_message_content").notNull(),
		optInWorkflow: text("opt_in_workflow").notNull(),
		optInWorkflowImageUrls: jsonb("opt_in_workflow_image_urls")
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		messageVolume: text("message_volume").notNull(),
		/** Required by carrier policy since September 2026; carried as required here for the same reason. */
		privacyPolicyUrl: text("privacy_policy_url").notNull(),
		termsAndConditionsUrl: text("terms_and_conditions_url").notNull(),
		status: text("status").$type<TollFreeVerificationStatus>().notNull().default("pending"),
		statusReason: text("status_reason"),
		lastPolledAt: utcTimestamp("last_polled_at"),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("messaging_toll_free_verification_carrier_id_key")
			.on(table.carrierVerificationId)
			.where(sql`carrier_verification_id is not null`),
		index("messaging_tfv_organization_status_idx").on(table.organizationId, table.status),
		check(
			"messaging_toll_free_verification_status_check",
			sql`status in ('pending', 'in-review', 'verified', 'rejected')`,
		),
		check(
			"messaging_toll_free_verification_country_check",
			sql`business_registration_country ~ '^[A-Z]{2}$'`,
		),
		tenantIsolationPolicy("messaging_toll_free_verification"),
	],
);

/**
 * A DID with messaging switched on: the join between `phone_number` and the A2P world.
 *
 * `phone_number_id` is `not null` and cascades: a messaging number with no DID is not a thing that
 * can send or receive, and releasing the number ends the messaging line with it. The CONVERSATIONS
 * do not cascade from here — see `conversation` — because a tenant that releases a DID must not
 * thereby destroy the transcript of what was said on it.
 */
export const messagingNumber = pgTable.withRLS(
	"messaging_number",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		phoneNumberId: uuidEntityId("phone_number_id")
			.notNull()
			.references(() => phoneNumber.id, { onDelete: "cascade" }),
		/** Denormalised E.164, so an inbound webhook resolves the tenant with one untenanted lookup. */
		e164: text("e164").notNull(),
		numberClass: text("number_class").$type<MessagingNumberClass>().notNull().default("local"),
		/** The Telnyx messaging profile this number sends through. Null until provisioned. */
		carrierMessagingProfileId: text("carrier_messaging_profile_id"),
		/** The campaign the number is assigned to. Null for toll-free and for unregistered locals. */
		campaignId: uuidEntityId("campaign_id").references(() => messagingCampaign.id, {
			onDelete: "set null",
		}),
		registrationStatus: text("registration_status")
			.$type<MessagingRegistrationStatus>()
			.notNull()
			.default("unregistered"),
		/**
		 * The sentence shown to an admin, and returned in the 422 when a send is refused.
		 *
		 * Stored rather than derived so the reason survives the carrier being unreachable and so the
		 * refusal an admin reads in the UI is character-for-character the refusal the API gave the
		 * integration. A named reason is the difference between "messaging is broken" and "assign
		 * this number to your approved campaign".
		 */
		registrationReason: text("registration_reason"),
		/** `false` parks the line without unregistering it — a holiday shutdown, or a spend freeze. */
		enabled: boolean("enabled").notNull().default(true),
		/**
		 * Per-number retention for message bodies and MMS media, in days. NULL inherits the
		 * organization's setting, and the organization's own NULL means "keep". Per NUMBER because a
		 * clinic's appointment line and its billing line are under different obligations.
		 */
		retentionDays: integer("retention_days"),
		...auditTimestampColumns(),
	},
	(table) => [
		/**
		 * One messaging line per DID.
		 *
		 * Scoped to the organization even though `phone_number.id` is already unique platform-wide, so
		 * the index leads with `organization_id` and stays usable under the tenant predicate like every
		 * other index in this schema. The two are equivalent in what they forbid — a DID belongs to
		 * exactly one tenant, so a cross-tenant duplicate cannot arise — and the scoped form is the one
		 * a tenant's own "is messaging on for this number?" read can actually use.
		 */
		uniqueIndex("messaging_number_organization_phone_number_key").on(
			table.organizationId,
			table.phoneNumberId,
		),
		/**
		 * Global, not per-tenant, and for the same reason `phone_number.e164` is: an inbound message
		 * webhook arrives with a `to` and nothing else, and the lookup that decides whose message it
		 * is must have exactly one answer. `phone_number` already enforces one owner per E.164
		 * platform-wide; this index is what makes the messaging lookup inherit that guarantee rather
		 * than re-derive it through a join under no tenant scope.
		 */
		uniqueIndex("messaging_number_e164_global_key").on(table.e164),
		index("messaging_number_organization_enabled_idx").on(table.organizationId, table.enabled),
		index("messaging_number_organization_campaign_idx").on(table.organizationId, table.campaignId),
		check(
			"messaging_number_class_check",
			sql`number_class in ('local', 'toll-free', 'short-code')`,
		),
		check(
			"messaging_number_registration_status_check",
			sql`registration_status in ('unregistered', 'pending', 'registered', 'rejected')`,
		),
		tenantIsolationPolicy("messaging_number"),
	],
);

// --------------------------------------------------------------------------------------------
// Traffic: conversation → message, and the suppression ledger
// --------------------------------------------------------------------------------------------

/**
 * A thread between one of the tenant's messaging numbers and one remote number.
 *
 * The thread is the unit the inbox lists and the unit a human thinks in, so it is a row rather than
 * a `group by` over messages: the list query has to be able to page by last activity and show an
 * unread count without scanning the message table, and both of those are columns here.
 *
 * `on delete restrict` from `messaging_number` — not cascade. Deleting a messaging line must not
 * silently delete the record of what was said on it; the service unbinds the line and leaves the
 * threads, which is also what the retention sweeper expects to find.
 */
export const conversation = pgTable.withRLS(
	"conversation",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		messagingNumberId: uuidEntityId("messaging_number_id")
			.notNull()
			.references(() => messagingNumber.id, { onDelete: "restrict" }),
		/** The consumer's number, E.164. Half of the thread key. */
		remoteE164: text("remote_e164").notNull(),
		/** Optional human label an agent typed, so a thread reads as a person and not a number. */
		displayName: text("display_name"),
		/** Denormalised for the list: the newest message's timestamp and a preview of its text. */
		lastMessageAt: utcTimestamp("last_message_at"),
		lastMessagePreview: text("last_message_preview"),
		lastMessageDirection: text("last_message_direction").$type<MessageDirection>(),
		unreadCount: integer("unread_count").notNull().default(0),
		archived: boolean("archived").notNull().default(false),
		...auditTimestampColumns(),
	},
	(table) => [
		/** One thread per (our number, their number). The insert is an upsert on this key. */
		uniqueIndex("conversation_number_remote_key").on(
			table.organizationId,
			table.messagingNumberId,
			table.remoteE164,
		),
		/** The inbox's own index: newest activity first, within a tenant. */
		index("conversation_organization_last_message_idx").on(
			table.organizationId,
			table.archived,
			table.lastMessageAt,
		),
		tenantIsolationPolicy("conversation"),
	],
);

/**
 * One SMS or MMS, in either direction.
 *
 * MMS media is stored as an array of object-store keys rather than as carrier URLs: a carrier's
 * media URL expires, and an inbox that renders one is an inbox whose two-week-old attachments are
 * broken links. The ingestion path downloads into the existing object store, exactly as inbound fax
 * does, and the row carries the key.
 *
 * `carrier_message_id` is unique per tenant where present — the redelivery guard. Telnyx retries a
 * webhook it did not get a 200 for, and an inbox that files the same inbound message twice is one
 * an agent stops trusting immediately.
 */
export const message = pgTable.withRLS(
	"message",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		conversationId: uuidEntityId("conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		messagingNumberId: uuidEntityId("messaging_number_id")
			.notNull()
			.references(() => messagingNumber.id, { onDelete: "restrict" }),
		direction: text("direction").$type<MessageDirection>().notNull(),
		status: text("status").$type<MessageStatus>().notNull().default("queued"),
		kind: text("kind").$type<MessageKind>().notNull().default("SMS"),
		fromE164: text("from_e164").notNull(),
		toE164: text("to_e164").notNull(),
		/** The text. Nullable for an MMS that is media only. */
		body: text("body"),
		/** Object-store keys for MMS parts. Empty for SMS. See the header for why not carrier URLs. */
		mediaKeys: jsonb("media_keys")
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** The carrier's message id, for delivery-receipt correlation and redelivery dedupe. */
		carrierMessageId: text("carrier_message_id"),
		/** Segments the carrier billed. Null until the carrier says. */
		segments: integer("segments"),
		/** Carrier's own sentence for a `failed`. Never paraphrased — see `messaging_brand`. */
		errorReason: text("error_reason"),
		/** The user who composed an outbound message. Null for inbound and for API-originated sends. */
		sentByUserId: text("sent_by_user_id"),
		/**
		 * Set on an inbound message whose text was a recognised STOP/HELP/START keyword.
		 *
		 * The message is still FILED — a consumer's opt-out is evidence and deleting it would destroy
		 * the record of when they asked — but the flag is what stops the inbox showing "STOP" as a
		 * conversation an agent should reply to, and what a compliance export selects on.
		 */
		complianceKeyword: text("compliance_keyword"),
		/** How many times the send worker has claimed this outbound row. See `fax_message.attempts`. */
		attempts: integer("attempts").notNull().default(0),
		/** The send worker's lease. Released by expiry, never explicitly — a crashed worker frees nothing. */
		claimedAt: utcTimestamp("claimed_at"),
		/** When the message reached a terminal state. */
		completedAt: utcTimestamp("completed_at"),
		/**
		 * When retention may purge this row and its media. NULL means "no policy", which the sweeper
		 * reads as keep — the same convention `call_leg.retention_until` uses.
		 */
		retentionUntil: utcTimestamp("retention_until"),
		...auditTimestampColumns(),
	},
	(table) => [
		/** The thread view: one conversation, oldest to newest. */
		index("message_conversation_created_idx").on(
			table.organizationId,
			table.conversationId,
			table.createdAt,
		),
		index("message_organization_status_idx").on(table.organizationId, table.status),
		/** Redelivery guard: a carrier message id is filed at most once per tenant. */
		uniqueIndex("message_organization_carrier_message_id_key")
			.on(table.organizationId, table.carrierMessageId)
			.where(sql`carrier_message_id is not null`),
		/**
		 * The outbound send queue, global and partial — the same shape and the same argument as
		 * `fax_message_send_queue_idx`: the worker runs untenanted and asks "which message anywhere
		 * still owes a send", so leading with `organization_id` would force a full scan of a table
		 * that is the busiest one in this schema.
		 */
		index("message_send_queue_idx")
			.on(table.status, table.claimedAt)
			.where(sql`direction = 'outbound' and status in ('queued', 'sending')`),
		/** The retention sweeper's index, global for the same reason. */
		index("message_retention_idx")
			.on(table.retentionUntil)
			.where(sql`retention_until is not null`),
		check("message_direction_check", sql`direction in ('inbound', 'outbound')`),
		check(
			"message_status_check",
			sql`status in ('queued', 'sending', 'sent', 'delivered', 'failed', 'received')`,
		),
		check("message_kind_check", sql`kind in ('SMS', 'MMS')`),
		tenantIsolationPolicy("message"),
	],
);

/**
 * The suppression list: a consumer who has said STOP to one of this tenant's numbers.
 *
 * A row here is a hard block on the send path, checked inside the same transaction that inserts the
 * outbound message so a STOP arriving between the check and the insert cannot be raced past.
 *
 * A START re-subscribe DELETES the row rather than flagging it inactive. That is deliberate and it
 * is the one place this schema throws information away on purpose: an "inactive opt-out" is a row
 * that a future query with a forgotten `where active` clause turns back into a block, or worse into
 * a permission to send that nobody granted. The consumer's own messages — the STOP and the START —
 * remain in the `message` table as the evidence of both acts, so the audit trail survives the row.
 */
export const messagingOptOut = pgTable.withRLS(
	"messaging_opt_out",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		messagingNumberId: uuidEntityId("messaging_number_id")
			.notNull()
			.references(() => messagingNumber.id, { onDelete: "cascade" }),
		remoteE164: text("remote_e164").notNull(),
		source: text("source").$type<OptOutSource>().notNull().default("keyword"),
		/** The exact keyword the consumer sent, when there was one. Evidence, not configuration. */
		keyword: text("keyword"),
		/** The user who recorded a `manual` opt-out. Null for `keyword` and `carrier`. */
		recordedByUserId: text("recorded_by_user_id"),
		optedOutAt: utcTimestamp("opted_out_at").notNull().defaultNow(),
		...auditTimestampColumns(),
	},
	(table) => [
		/** One block per pair. The insert is an upsert on this key — a second STOP is not an error. */
		uniqueIndex("messaging_opt_out_number_remote_key").on(
			table.organizationId,
			table.messagingNumberId,
			table.remoteE164,
		),
		check("messaging_opt_out_source_check", sql`source in ('keyword', 'manual', 'carrier')`),
		tenantIsolationPolicy("messaging_opt_out"),
	],
);
