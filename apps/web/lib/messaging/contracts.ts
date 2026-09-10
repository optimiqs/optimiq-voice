import type { ItemEnvelope, PagedEnvelope } from "../pbx/contracts";

/**
 * The messaging contract, mirrored — never imported.
 *
 * Same rule `lib/pbx/contracts.ts` states and for the same reason: `apps/api` is a Nest
 * application, and importing its DTOs would drag Nest, Drizzle and a Postgres driver into the
 * browser bundle. So the closed sets and the row shapes are restated here.
 *
 * Rows arrive as the Drizzle row, camelCased, with `Date` columns serialized to ISO strings. Every
 * body the API accepts is STRICT — an unknown key is a 400 — so every request builder in
 * `./client.ts` sends named keys and never spreads a form's state.
 */

export type { ItemEnvelope, PagedEnvelope };

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

/**
 * Local (10DLC) or toll-free, which is the fork the whole registration story hangs off.
 *
 * A local number registers through a 10DLC brand and campaign; a toll-free number registers
 * through a toll-free verification and has no campaign at all. Two different regulators, two
 * different forms, one column that decides which one a number is subject to.
 */
export const NUMBER_CLASSES = ["local", "toll-free"] as const;
export type NumberClass = (typeof NUMBER_CLASSES)[number];

/**
 * Where a number is in the carrier's queue.
 *
 * `rejected` is the one that must never be collapsed into `unregistered`: an unregistered number
 * has not been submitted, a rejected one WAS submitted and refused, and the stored
 * `registrationReason` is the only place the refusal is written down.
 */
export const REGISTRATION_STATUSES = ["unregistered", "pending", "registered", "rejected"] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export interface MessagingNumberRow {
	readonly id: string;
	readonly organizationId: string;
	readonly phoneNumberId: string;
	readonly e164: string;
	readonly numberClass: NumberClass;
	readonly enabled: boolean;
	readonly registrationStatus: RegistrationStatus;
	/** The carrier's own words about the status. `null` until the carrier has said something. */
	readonly registrationReason: string | null;
	readonly campaignId: string | null;
	readonly campaignName: string | null;
	readonly retentionDays: number | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Conversations and messages
// ---------------------------------------------------------------------------------------------

export interface ConversationRow {
	readonly id: string;
	readonly organizationId: string;
	readonly messagingNumberId: string;
	/** The other end, always E.164. The local end is the messaging number this thread hangs off. */
	readonly remoteE164: string;
	readonly displayName: string | null;
	readonly lastMessagePreview: string | null;
	readonly lastMessageAt: string | null;
	readonly unreadCount: number;
	readonly archived: boolean;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export const MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/**
 * A message's lifecycle, in the order it moves through.
 *
 * `sent` and `delivered` are deliberately separate: `sent` means the carrier accepted it, and
 * `delivered` means the handset acknowledged it. Collapsing them would erase the window in which
 * a message is somewhere between here and a phone, which is exactly the window somebody asking
 * "did they get it?" is asking about.
 */
export const MESSAGE_STATUSES = ["queued", "sending", "sent", "delivered", "failed"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * One MMS part. `objectKey` is what `POST messages/:id/media-url` mints a signed URL for.
 *
 * No size. The API derives a part's content type from its stored key, which is free, but a size
 * would cost an object-store stat per attachment on every thread read — so the label names the type
 * alone and the browser learns the size when it fetches the bytes.
 */
export interface MessageMediaPart {
	readonly objectKey: string;
	readonly part: number;
	readonly contentType: string;
}

export interface MessageRow {
	readonly id: string;
	readonly organizationId: string;
	readonly conversationId: string;
	readonly messagingNumberId: string;
	readonly direction: MessageDirection;
	readonly status: MessageStatus;
	readonly fromE164: string;
	readonly toE164: string;
	readonly body: string | null;
	readonly media: readonly MessageMediaPart[];
	/**
	 * The carrier's sentence about a failure.
	 *
	 * The single most load-bearing string in this contract. A message filtered by a carrier fails
	 * for a reason nothing else on the row explains — a blocked keyword, an unregistered sender, a
	 * spam classification — and this is where that reason is. It is never swallowed.
	 */
	readonly errorReason: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface MediaUploadResult {
	readonly objectKey: string;
	readonly contentType: string;
	readonly sizeBytes: number;
}

/** A signed, expiring URL for one MMS part. Never cached — see `useMessageMediaUrl`. */
export interface MessageMediaLink {
	readonly url: string;
	readonly expiresAt: string;
}

// ---------------------------------------------------------------------------------------------
// 10DLC brand
// ---------------------------------------------------------------------------------------------

export const BRAND_ENTITY_TYPES = [
	"PRIVATE_PROFIT",
	"PUBLIC_PROFIT",
	"NON_PROFIT",
	"GOVERNMENT",
	"SOLE_PROPRIETOR",
] as const;
export type BrandEntityType = (typeof BRAND_ENTITY_TYPES)[number];

export const BRAND_STATUSES = ["unsubmitted", "pending", "verified", "rejected"] as const;
export type BrandStatus = (typeof BRAND_STATUSES)[number];

export interface BrandRow {
	readonly id: string;
	readonly organizationId: string;
	readonly displayName: string;
	readonly companyName: string;
	readonly entityType: BrandEntityType;
	/** Absent for a sole proprietor, who has no employer identification number to give. */
	readonly ein: string | null;
	readonly vertical: string;
	readonly contactEmail: string;
	readonly contactPhone: string;
	readonly website: string | null;
	readonly street: string;
	readonly city: string;
	readonly state: string;
	readonly postalCode: string;
	readonly country: string;
	readonly status: BrandStatus;
	readonly statusReason: string | null;
	/** When the platform last asked the registry. `null` before the first poll. */
	readonly lastPolledAt: string | null;
	/** True once a PIN has been sent and not yet verified. Sole proprietors only. */
	readonly otpPending: boolean;
	readonly otpVerifiedAt: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------------------------

export const CAMPAIGN_STATUSES = ["draft", "pending", "active", "rejected", "expired"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/**
 * Quiet hours, stored as the carrier stores them: two wall-clock times and the zone they are read
 * in. NOT a UTC window — a campaign that must not text at 9pm local must not text at 9pm local in
 * March and in July, which a fixed offset cannot express.
 */
export interface QuietHours {
	/** `HH:MM`, 24-hour. */
	readonly start: string;
	readonly end: string;
	/** An IANA zone name — `America/New_York`, not `EST`. */
	readonly timeZone: string;
}

export interface CampaignRow {
	readonly id: string;
	readonly organizationId: string;
	readonly brandId: string;
	readonly name: string;
	readonly useCase: string;
	readonly description: string;
	readonly sampleMessages: readonly string[];
	readonly messageFlow: string;
	readonly helpMessage: string;
	readonly optOutMessage: string;
	readonly optInKeywords: readonly string[];
	readonly optOutKeywords: readonly string[];
	readonly helpKeywords: readonly string[];
	readonly embeddedLink: boolean;
	readonly ageGated: boolean;
	readonly quietHours: QuietHours | null;
	readonly status: CampaignStatus;
	readonly statusReason: string | null;
	/** Messages per minute the carrier will accept on this campaign. `null` until assigned. */
	readonly throughputPerMinute: number | null;
	readonly numbers: readonly CampaignNumberSummary[];
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface CampaignNumberSummary {
	readonly messagingNumberId: string;
	readonly e164: string;
	readonly registrationStatus: RegistrationStatus;
}

// ---------------------------------------------------------------------------------------------
// Toll-free verification
// ---------------------------------------------------------------------------------------------

export const TOLL_FREE_STATUSES = [
	"unsubmitted",
	"pending",
	"in-review",
	"verified",
	"rejected",
] as const;
export type TollFreeStatus = (typeof TOLL_FREE_STATUSES)[number];

export interface TollFreeVerificationRow {
	readonly id: string;
	readonly organizationId: string;
	readonly messagingNumberId: string;
	readonly e164: string;
	readonly businessName: string;
	readonly businessWebsite: string;
	readonly businessStreet: string;
	readonly businessCity: string;
	readonly businessState: string;
	readonly businessPostalCode: string;
	readonly businessCountry: string;
	readonly businessContactFirstName: string;
	readonly businessContactLastName: string;
	readonly businessContactEmail: string;
	readonly businessContactPhone: string;
	/**
	 * The three BRN fields the carriers made mandatory for every submission from 17 February 2026.
	 * They are not optional on this form and the form says why, once, where it can be read.
	 */
	readonly businessRegistrationNumber: string;
	readonly businessRegistrationType: string;
	/** ISO 3166-1 alpha-2, upper case. `US`, not `USA` and not `us`. */
	readonly businessRegistrationCountry: string;
	readonly privacyPolicyUrl: string;
	readonly termsAndConditionsUrl: string;
	readonly useCase: string;
	readonly useCaseSummary: string;
	readonly productionMessageContent: string;
	readonly optInWorkflow: string;
	readonly optInWorkflowImageUrls: readonly string[];
	readonly messageVolume: string;
	readonly status: TollFreeStatus;
	readonly statusReason: string | null;
	readonly submittedAt: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

// ---------------------------------------------------------------------------------------------
// Opt-outs
// ---------------------------------------------------------------------------------------------

/**
 * How consent was withdrawn.
 *
 * `keyword` is the recipient texting STOP, `carrier` is the network telling us, and `manual` is
 * somebody in this organization recording it on their behalf. The three are kept apart because
 * only the third is one this platform may reverse on its own say-so.
 */
export const OPT_OUT_SOURCES = ["keyword", "manual", "carrier"] as const;
export type OptOutSource = (typeof OPT_OUT_SOURCES)[number];

export interface OptOutRow {
	readonly id: string;
	readonly organizationId: string;
	readonly messagingNumberId: string;
	readonly remoteE164: string;
	readonly source: OptOutSource;
	/** The word the recipient actually sent. `null` for a manual or carrier entry. */
	readonly keyword: string | null;
	readonly createdAt: string;
}
