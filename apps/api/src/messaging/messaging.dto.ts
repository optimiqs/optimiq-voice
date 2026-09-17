import { z } from "zod/v4";
import { e164 } from "../pbx/shared/dto";
import { listQuerySchema } from "../pbx/shared/pagination";
import { isValidTimeZone } from "./compliance/quiet-hours";

/**
 * Messaging DTOs. `z.strictObject` everywhere, like the rest of the API — an unknown key is a client
 * that thinks it is setting something, and dropping it silently is how "I set that and it did
 * nothing" bugs are born.
 *
 * Two of the schemas here are stricter than the carrier is, and both are deliberate:
 *
 * - Toll-free verification requires the three BRN fields. They have been mandatory on every new
 *   submission since 17 February 2026, so accepting one without them would only move the rejection
 *   from this form to the carrier, a week later, with no field named.
 * - A campaign's quiet-hours trio is all-or-nothing. Two of three is a window with an undefined
 *   edge, and an undefined edge in a send gate is a message at 3am.
 */

const SMS_BODY_MAX = 1_600;

// --------------------------------------------------------------------------------------------
// Numbers
// --------------------------------------------------------------------------------------------

export const MESSAGING_NUMBER_CLASS_VALUES = ["local", "toll-free", "short-code"] as const;

export const enableMessagingNumberDto = z.strictObject({
	phoneNumberId: z.uuid(),
	/**
	 * Optional, because the class is DERIVED from the E.164 when it is not given — a `+1800/833/844/
	 * 855/866/877/888` number is toll-free and everything else in NANP is local. Overridable because
	 * derivation is a NANP rule and this platform will eventually carry numbers it does not describe.
	 */
	numberClass: z.enum(MESSAGING_NUMBER_CLASS_VALUES).optional(),
	retentionDays: z.coerce.number().int().min(0).max(3_650).nullable().optional(),
});
export type EnableMessagingNumberDto = z.infer<typeof enableMessagingNumberDto>;

export const updateMessagingNumberDto = z.strictObject({
	enabled: z.boolean().optional(),
	/** `null` unassigns the number from its campaign, which also un-registers it for sending. */
	campaignId: z.uuid().nullable().optional(),
	retentionDays: z.coerce.number().int().min(0).max(3_650).nullable().optional(),
});
export type UpdateMessagingNumberDto = z.infer<typeof updateMessagingNumberDto>;

export const messagingNumberListQuerySchema = listQuerySchema;
export type MessagingNumberListQuery = z.infer<typeof messagingNumberListQuerySchema>;

// --------------------------------------------------------------------------------------------
// Conversations and messages
// --------------------------------------------------------------------------------------------

export const conversationListQuerySchema = listQuerySchema.extend({
	numberId: z.uuid().optional(),
	archived: z.stringbool({ truthy: ["true", "1"], falsy: ["false", "0"] }).optional(),
});
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

export const updateConversationDto = z.strictObject({
	displayName: z.string().trim().max(128).nullable().optional(),
	archived: z.boolean().optional(),
});
export type UpdateConversationDto = z.infer<typeof updateConversationDto>;

export const messageListQuerySchema = listQuerySchema;
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;

/**
 * Send one message.
 *
 * `body` and `mediaKeys` are both optional but not both absent — checked by the refinement rather
 * than by the service, so an empty send is a 400 naming the fields instead of a carrier round trip
 * that fails.
 *
 * `mediaKeys` are OBJECT-STORE keys returned by the upload endpoint, never URLs. A DTO that accepted
 * a URL would be a server-side request forgery primitive with a send button on it: the send path
 * hands the carrier whatever it is given, and the carrier fetches it from inside our network's
 * reputation, not the caller's.
 */
export const sendMessageDto = z
	.strictObject({
		messagingNumberId: z.uuid(),
		to: e164,
		body: z.string().max(SMS_BODY_MAX).optional(),
		mediaKeys: z.array(z.string().min(1).max(512)).max(10).optional(),
	})
	.refine((value) => (value.body ?? "").trim().length > 0 || (value.mediaKeys ?? []).length > 0, {
		message: "a message must carry body text or at least one attachment",
		path: ["body"],
	});
export type SendMessageDto = z.infer<typeof sendMessageDto>;

// --------------------------------------------------------------------------------------------
// Opt-outs
// --------------------------------------------------------------------------------------------

export const optOutListQuerySchema = listQuerySchema.extend({
	numberId: z.uuid().optional(),
});
export type OptOutListQuery = z.infer<typeof optOutListQuerySchema>;

export const createOptOutDto = z.strictObject({
	messagingNumberId: z.uuid(),
	remoteE164: e164,
	/**
	 * The tenant's note about where the opt-out came from.
	 *
	 * Free text and not an enum, because the FCC's April-2025 order made "any reasonable method" a
	 * channel — email, a phone call, a web form, somebody at the counter — and an enum would force an
	 * agent to file a real request under the nearest wrong label. The `source` column stays `manual`
	 * for all of them; this is the evidence of which one.
	 */
	note: z.string().trim().max(512).optional(),
});
export type CreateOptOutDto = z.infer<typeof createOptOutDto>;

// --------------------------------------------------------------------------------------------
// 10DLC brand
// --------------------------------------------------------------------------------------------

export const MESSAGING_ENTITY_TYPES = [
	"PRIVATE_PROFIT",
	"PUBLIC_PROFIT",
	"NON_PROFIT",
	"GOVERNMENT",
	"SOLE_PROPRIETOR",
] as const;

export const createBrandDto = z
	.strictObject({
		displayName: z.string().trim().min(1).max(128),
		companyName: z.string().trim().min(1).max(128),
		entityType: z.enum(MESSAGING_ENTITY_TYPES),
		/**
		 * EIN / business registration number.
		 *
		 * Optional in the DTO and required by TCR for every entity type except `SOLE_PROPRIETOR`, which
		 * proves itself by the SMS-OTP round trip instead. Enforcing that split HERE rather than at the
		 * carrier is what turns a week-long rejection into a form error.
		 */
		ein: z.string().trim().max(32).optional(),
		vertical: z.string().trim().max(64).optional(),
		email: z.email().max(320),
		phone: e164.optional(),
		website: z.url().max(512).optional(),
		street: z.string().trim().max(128).optional(),
		city: z.string().trim().max(64).optional(),
		state: z.string().trim().max(64).optional(),
		postalCode: z.string().trim().max(16).optional(),
		country: z.string().trim().length(2).toUpperCase().default("US"),
	})
	.refine((value) => value.entityType === "SOLE_PROPRIETOR" || (value.ein ?? "").length > 0, {
		message: "every entity type except SOLE_PROPRIETOR must supply an EIN",
		path: ["ein"],
	});
export type CreateBrandDto = z.infer<typeof createBrandDto>;

export const verifyBrandOtpDto = z.strictObject({
	/** TCR's SMS PIN. Digits only and short — a typed PIN, not a token. */
	pin: z
		.string()
		.trim()
		.regex(/^\d{4,10}$/u, "the PIN is 4 to 10 digits"),
});
export type VerifyBrandOtpDto = z.infer<typeof verifyBrandOtpDto>;

// --------------------------------------------------------------------------------------------
// 10DLC campaign
// --------------------------------------------------------------------------------------------

/** `HH:MM`, the form's shape, converted to minutes past midnight before it reaches the row. */
const clockTime = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/u, "expected HH:MM")
	.transform((value) => {
		const [hour, minute] = value.split(":");
		return Number(hour) * 60 + Number(minute);
	});

const quietHours = z.strictObject({
	start: clockTime,
	end: clockTime,
	timeZone: z
		.string()
		.min(1)
		.max(64)
		.refine((value) => isValidTimeZone(value), "not an IANA time zone this runtime knows"),
});

export const createCampaignDto = z.strictObject({
	brandId: z.uuid(),
	name: z.string().trim().min(1).max(128),
	useCase: z.string().trim().min(1).max(64),
	description: z.string().trim().min(1).max(4_096),
	/**
	 * TCR requires at least two sample messages and accepts up to five. Enforced here because a
	 * one-sample submission is rejected at the registry days later with no field named.
	 */
	sampleMessages: z.array(z.string().trim().min(1).max(SMS_BODY_MAX)).min(2).max(5),
	messageFlow: z.string().trim().min(1).max(4_096),
	helpMessage: z.string().trim().min(1).max(SMS_BODY_MAX),
	optOutMessage: z.string().trim().min(1).max(SMS_BODY_MAX).optional(),
	optInKeywords: z.string().trim().max(256).optional(),
	optOutKeywords: z.string().trim().max(256).optional(),
	helpKeywords: z.string().trim().max(256).optional(),
	embeddedLink: z.boolean().optional(),
	ageGated: z.boolean().optional(),
	/** `null` clears the window; absent leaves it. See the header for why the trio is atomic. */
	quietHours: quietHours.nullable().optional(),
});
export type CreateCampaignDto = z.infer<typeof createCampaignDto>;

export const updateCampaignDto = z.strictObject({
	name: z.string().trim().min(1).max(128).optional(),
	description: z.string().trim().min(1).max(4_096).optional(),
	sampleMessages: z.array(z.string().trim().min(1).max(SMS_BODY_MAX)).min(2).max(5).optional(),
	messageFlow: z.string().trim().min(1).max(4_096).optional(),
	helpMessage: z.string().trim().min(1).max(SMS_BODY_MAX).optional(),
	optOutMessage: z.string().trim().min(1).max(SMS_BODY_MAX).optional(),
	optInKeywords: z.string().trim().max(256).optional(),
	optOutKeywords: z.string().trim().max(256).optional(),
	helpKeywords: z.string().trim().max(256).optional(),
	embeddedLink: z.boolean().optional(),
	ageGated: z.boolean().optional(),
	quietHours: quietHours.nullable().optional(),
});
export type UpdateCampaignDto = z.infer<typeof updateCampaignDto>;

export const assignCampaignNumberDto = z.strictObject({
	messagingNumberId: z.uuid(),
});
export type AssignCampaignNumberDto = z.infer<typeof assignCampaignNumberDto>;

// --------------------------------------------------------------------------------------------
// Toll-free verification
// --------------------------------------------------------------------------------------------

export const submitTollFreeVerificationDto = z.strictObject({
	messagingNumberId: z.uuid(),
	businessName: z.string().trim().min(1).max(256),
	corporateWebsite: z.url().max(512),
	businessAddr1: z.string().trim().min(1).max(128),
	businessAddr2: z.string().trim().max(128).optional(),
	businessCity: z.string().trim().min(1).max(64),
	businessState: z.string().trim().min(1).max(64),
	businessZip: z.string().trim().min(1).max(16),
	businessContactFirstName: z.string().trim().min(1).max(64),
	businessContactLastName: z.string().trim().min(1).max(64),
	businessContactEmail: z.email().max(320),
	businessContactPhone: e164,
	/**
	 * The BRN trio. Required — mandatory at the carrier for every new submission since
	 * 17 February 2026 (https://developers.telnyx.com/docs/messaging/toll-free-verification).
	 */
	businessRegistrationNumber: z.string().trim().min(1).max(500),
	businessRegistrationType: z.string().trim().min(1).max(500),
	businessRegistrationCountry: z
		.string()
		.trim()
		.length(2)
		.regex(/^[A-Za-z]{2}$/u, "an ISO 3166-1 alpha-2 country code")
		.toUpperCase(),
	useCase: z.string().trim().min(1).max(128),
	useCaseSummary: z.string().trim().min(1).max(4_096),
	productionMessageContent: z.string().trim().min(1).max(SMS_BODY_MAX),
	optInWorkflow: z.string().trim().min(1).max(4_096),
	optInWorkflowImageUrls: z.array(z.url().max(512)).max(10).default([]),
	messageVolume: z.string().trim().min(1).max(32),
	/** Required by carrier policy since September 2026, so required here. */
	privacyPolicyUrl: z.url().max(512),
	termsAndConditionsUrl: z.url().max(512),
});
export type SubmitTollFreeVerificationDto = z.infer<typeof submitTollFreeVerificationDto>;
