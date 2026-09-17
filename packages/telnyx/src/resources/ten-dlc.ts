import { z } from "zod";
import { dataEnvelope, listEnvelope } from "../schemas";
import type { TelnyxTransport } from "../transport";

/**
 * `/v2/10dlc` — brand and campaign registration with The Campaign Registry (TCR).
 *
 * ## Why any of this exists
 *
 * Since 2021 US carriers reject application-to-person SMS from a local (10-digit long code) number
 * that is not attached to a registered *campaign*, which in turn belongs to a registered *brand*.
 * Unregistered traffic is not rate-limited, it is filtered — silently, per carrier, with no error
 * back to the sender. So this is not an optional compliance nicety bolted on later: a US local DID
 * cannot usefully send SMS until a brand exists, a campaign under it reaches `ACTIVE`, and the
 * number is assigned to that campaign. The fake server enforces exactly that ordering
 * (`fake/server.ts`), which is what makes our own refusal-to-send testable.
 *
 * ## THESE ENDPOINTS ARE camelCase — IN THE PATH AND IN THE BODY
 *
 * Every other Telnyx v2 endpoint this package speaks to is snake_case: `/credential_connections`,
 * `messaging_profile_id`, `webhook_api_version`. The 10DLC surface is not. It is
 * `/10dlc/campaignBuilder`, `/10dlc/phoneNumberCampaign`, and bodies of `entityType`,
 * `displayName`, `messageFlow`, `optinKeywords`. This is a real and surprising property of the API
 * — the surface is a thin proxy in front of TCR, whose own contract is camelCase — and it is NOT a
 * mistake in this file. Do not "normalise" it: a snake_case body here is rejected, and a
 * snake_case path 404s.
 *
 * ## Sole-proprietor brands verify by SMS OTP
 *
 * A `SOLE_PROPRIETOR` brand has no EIN to vet against, so TCR verifies the human instead: trigger
 * a 6-digit PIN to the brand's mobile number, then submit it back. That is
 * `POST /v2/10dlc/brand/{brandId}/smsOtp` to trigger and `PUT` on the same path to verify. The
 * verify body field is **`otpPin`**, not `pin` — read from
 * https://developers.telnyx.com/docs/messaging/10dlc/sole-proprietor (see also the release note at
 * https://telnyx.com/release-notes/10dlc-api-authentication-update-for-brand-verification). The
 * older `POST /2faEmail` route is a different, email-based flow and is not what a sole proprietor
 * uses.
 */

/**
 * TCR's identity-vetting outcomes for a brand.
 *
 * Exported as an `as const` array for the API layer to map from, and deliberately NOT used as a
 * zod enum on the read: a registry vocabulary grows on the registry's schedule, and per the
 * `schemas.ts` policy an unknown member must not turn a status poll into an outage.
 */
export const TELNYX_BRAND_IDENTITY_STATUSES = [
	"PENDING",
	"SELF_DECLARED",
	"UNVERIFIED",
	"VERIFIED",
	"VETTED_VERIFIED",
] as const;
export type TelnyxBrandIdentityStatus = (typeof TELNYX_BRAND_IDENTITY_STATUSES)[number];

/** Campaign lifecycle, `TCR_*` members being the registry's own view and the rest Telnyx's. */
export const TELNYX_CAMPAIGN_STATUSES = [
	"TCR_PENDING",
	"TCR_SUSPENDED",
	"TCR_EXPIRED",
	"TCR_FAILED",
	"ACTIVE",
	"EXPIRED",
	"PENDING",
	"FAILED",
] as const;
export type TelnyxCampaignStatus = (typeof TELNYX_CAMPAIGN_STATUSES)[number];

/** What kind of legal entity the brand is. `SOLE_PROPRIETOR` is the one that verifies by SMS OTP. */
export const TELNYX_ENTITY_TYPES = [
	"PRIVATE_PROFIT",
	"PUBLIC_PROFIT",
	"NON_PROFIT",
	"GOVERNMENT",
	"SOLE_PROPRIETOR",
] as const;
export type TelnyxEntityType = (typeof TELNYX_ENTITY_TYPES)[number];

/** A registered brand. `brandId` is the only required field — it is what everything else keys on. */
export const telnyxBrandSchema = z.looseObject({
	brandId: z.string(),
	entityType: z.string().optional(),
	displayName: z.string().optional(),
	companyName: z.string().nullish(),
	ein: z.string().nullish(),
	identityStatus: z.string().optional(),
	brandRelationship: z.string().optional(),
	vertical: z.string().optional(),
	status: z.string().optional(),
	failureReasons: z.string().nullish(),
	cspId: z.string().optional(),
	country: z.string().optional(),
	website: z.string().nullish(),
	email: z.string().nullish(),
	phone: z.string().nullish(),
	street: z.string().nullish(),
	city: z.string().nullish(),
	state: z.string().nullish(),
	postalCode: z.string().nullish(),
	mock: z.boolean().optional(),
});

export type TelnyxBrand = z.infer<typeof telnyxBrandSchema>;

/** A registered campaign under a brand. */
export const telnyxCampaignSchema = z.looseObject({
	campaignId: z.string(),
	brandId: z.string().optional(),
	status: z.string().optional(),
	campaignStatus: z.string().optional(),
	usecase: z.string().optional(),
	description: z.string().optional(),
	sample1: z.string().nullish(),
	sample2: z.string().nullish(),
	sample3: z.string().nullish(),
	sample4: z.string().nullish(),
	sample5: z.string().nullish(),
	messageFlow: z.string().nullish(),
	helpMessage: z.string().nullish(),
	optinKeywords: z.string().nullish(),
	optoutKeywords: z.string().nullish(),
	helpKeywords: z.string().nullish(),
	mnoMetadata: z.looseObject({}).nullish(),
	tcrCampaignId: z.string().nullish(),
	failureReasons: z.string().nullish(),
	createdAt: z.string().optional(),
});

export type TelnyxCampaign = z.infer<typeof telnyxCampaignSchema>;

/** The assignment of one DID to one campaign. Keyed by the number, not by an id. */
export const telnyxPhoneNumberCampaignSchema = z.looseObject({
	phoneNumber: z.string(),
	campaignId: z.string().optional(),
	brandId: z.string().optional(),
	tcrCampaignId: z.string().nullish(),
	assignmentStatus: z.string().optional(),
});

export type TelnyxPhoneNumberCampaign = z.infer<typeof telnyxPhoneNumberCampaignSchema>;

const brandResponse = dataEnvelope(telnyxBrandSchema);
const brandListResponse = listEnvelope(telnyxBrandSchema);
const campaignResponse = dataEnvelope(telnyxCampaignSchema);
const campaignListResponse = listEnvelope(telnyxCampaignSchema);
const phoneNumberCampaignResponse = dataEnvelope(telnyxPhoneNumberCampaignSchema);

/**
 * `POST /v2/10dlc/brand` input. camelCase on the wire — see the module header.
 *
 * `ein` is required for every entity type except `SOLE_PROPRIETOR`, which has none; that is TCR's
 * rule and is left to the carrier to enforce so the message names the field the registry rejected.
 */
export interface CreateBrandInput {
	readonly entityType: TelnyxEntityType;
	readonly displayName: string;
	readonly country: string;
	readonly email: string;
	readonly vertical: string;
	readonly companyName?: string;
	readonly ein?: string;
	readonly phone?: string;
	readonly street?: string;
	readonly city?: string;
	readonly state?: string;
	readonly postalCode?: string;
	readonly website?: string;
	readonly brandRelationship?: string;
	/** TCR's sandbox flag. `true` never reaches a real carrier and never bills. */
	readonly mock?: boolean;
}

/** `POST /v2/10dlc/campaignBuilder` input. Note the endpoint's name is not `campaign`. */
export interface CreateCampaignInput {
	readonly brandId: string;
	readonly usecase: string;
	readonly description: string;
	readonly sample1: string;
	readonly sample2?: string;
	readonly sample3?: string;
	readonly sample4?: string;
	readonly sample5?: string;
	readonly messageFlow?: string;
	readonly helpMessage?: string;
	readonly optinKeywords?: string;
	readonly optoutKeywords?: string;
	readonly helpKeywords?: string;
	readonly optinMessage?: string;
	readonly optoutMessage?: string;
	readonly subscriberOptin?: boolean;
	readonly subscriberOptout?: boolean;
	readonly subscriberHelp?: boolean;
	readonly embeddedLink?: boolean;
	readonly embeddedPhone?: boolean;
	readonly ageGated?: boolean;
	readonly directLending?: boolean;
	readonly affiliateMarketing?: boolean;
	readonly numberPool?: boolean;
	readonly termsAndConditions?: boolean;
	readonly mock?: boolean;
}

/** The message pair a triggered OTP sends. `@OTP_PIN@` is substituted by TCR with the real PIN. */
export interface TriggerBrandOtpInput {
	readonly pinSms?: string;
	readonly successSms?: string;
}

export interface TenDlcResource {
	readonly createBrand: (input: CreateBrandInput) => Promise<TelnyxBrand>;
	readonly getBrand: (brandId: string) => Promise<TelnyxBrand>;
	readonly listBrands: () => Promise<readonly TelnyxBrand[]>;
	readonly deleteBrand: (brandId: string) => Promise<TelnyxBrand>;
	/** Sends a 6-digit PIN to a sole-proprietor brand's mobile number. */
	readonly triggerBrandOtp: (brandId: string, input?: TriggerBrandOtpInput) => Promise<TelnyxBrand>;
	/** Submits the PIN back. The wire field is `otpPin` — see the module header. */
	readonly verifyBrandOtp: (brandId: string, pin: string) => Promise<TelnyxBrand>;
	readonly createCampaign: (input: CreateCampaignInput) => Promise<TelnyxCampaign>;
	readonly getCampaign: (campaignId: string) => Promise<TelnyxCampaign>;
	readonly listCampaigns: (brandId?: string) => Promise<readonly TelnyxCampaign[]>;
	/**
	 * Attach a DID to a campaign. Refused by the carrier unless the campaign is `ACTIVE` and the
	 * number is already on a messaging profile — the fake enforces both.
	 */
	readonly assignPhoneNumber: (
		phoneNumber: string,
		campaignId: string,
	) => Promise<TelnyxPhoneNumberCampaign>;
	readonly unassignPhoneNumber: (phoneNumber: string) => Promise<void>;
}

export function makeTenDlc(transport: TelnyxTransport): TenDlcResource {
	return {
		createBrand: async (input) => {
			const response = await transport.request({
				method: "POST",
				path: "/10dlc/brand",
				// A brand is a billable registration with TCR and has no idempotency key, so a repeat
				// is a second brand under the same name — the same reasoning as an outbound voice
				// profile, with a registry fee attached. `listBrands()` is the reconciliation read.
				retryable: false,
				body: {
					entityType: input.entityType,
					displayName: input.displayName,
					country: input.country,
					email: input.email,
					vertical: input.vertical,
					...(input.companyName === undefined ? {} : { companyName: input.companyName }),
					...(input.ein === undefined ? {} : { ein: input.ein }),
					...(input.phone === undefined ? {} : { phone: input.phone }),
					...(input.street === undefined ? {} : { street: input.street }),
					...(input.city === undefined ? {} : { city: input.city }),
					...(input.state === undefined ? {} : { state: input.state }),
					...(input.postalCode === undefined ? {} : { postalCode: input.postalCode }),
					...(input.website === undefined ? {} : { website: input.website }),
					...(input.brandRelationship === undefined
						? {}
						: { brandRelationship: input.brandRelationship }),
					...(input.mock === undefined ? {} : { mock: input.mock }),
				},
				schema: brandResponse,
			});
			return response.data;
		},

		getBrand: async (brandId) => {
			const response = await transport.request({
				method: "GET",
				path: `/10dlc/brand/${encodeURIComponent(brandId)}`,
				schema: brandResponse,
			});
			return response.data;
		},

		listBrands: async () => {
			const response = await transport.request({
				method: "GET",
				path: "/10dlc/brand",
				schema: brandListResponse,
			});
			return response.data;
		},

		deleteBrand: async (brandId) => {
			const response = await transport.request({
				method: "DELETE",
				path: `/10dlc/brand/${encodeURIComponent(brandId)}`,
				schema: brandResponse,
			});
			return response.data;
		},

		triggerBrandOtp: async (brandId, input = {}) => {
			const response = await transport.request({
				method: "POST",
				path: `/10dlc/brand/${encodeURIComponent(brandId)}/smsOtp`,
				// Not retried: each trigger sends a real SMS to a real person and invalidates the PIN
				// they may already be typing.
				retryable: false,
				body: {
					...(input.pinSms === undefined ? {} : { pinSms: input.pinSms }),
					...(input.successSms === undefined ? {} : { successSms: input.successSms }),
				},
				schema: brandResponse,
			});
			return response.data;
		},

		verifyBrandOtp: async (brandId, pin) => {
			const response = await transport.request({
				method: "PUT",
				path: `/10dlc/brand/${encodeURIComponent(brandId)}/smsOtp`,
				body: { otpPin: pin },
				schema: brandResponse,
			});
			return response.data;
		},

		createCampaign: async (input) => {
			const response = await transport.request({
				method: "POST",
				path: "/10dlc/campaignBuilder",
				// Same reasoning as the brand: a campaign carries a monthly TCR fee and there is no
				// idempotency key, so a retried create is a second billed campaign.
				retryable: false,
				body: {
					brandId: input.brandId,
					usecase: input.usecase,
					description: input.description,
					sample1: input.sample1,
					...(input.sample2 === undefined ? {} : { sample2: input.sample2 }),
					...(input.sample3 === undefined ? {} : { sample3: input.sample3 }),
					...(input.sample4 === undefined ? {} : { sample4: input.sample4 }),
					...(input.sample5 === undefined ? {} : { sample5: input.sample5 }),
					...(input.messageFlow === undefined ? {} : { messageFlow: input.messageFlow }),
					...(input.helpMessage === undefined ? {} : { helpMessage: input.helpMessage }),
					...(input.optinKeywords === undefined ? {} : { optinKeywords: input.optinKeywords }),
					...(input.optoutKeywords === undefined ? {} : { optoutKeywords: input.optoutKeywords }),
					...(input.helpKeywords === undefined ? {} : { helpKeywords: input.helpKeywords }),
					...(input.optinMessage === undefined ? {} : { optinMessage: input.optinMessage }),
					...(input.optoutMessage === undefined ? {} : { optoutMessage: input.optoutMessage }),
					...(input.subscriberOptin === undefined
						? {}
						: { subscriberOptin: input.subscriberOptin }),
					...(input.subscriberOptout === undefined
						? {}
						: { subscriberOptout: input.subscriberOptout }),
					...(input.subscriberHelp === undefined ? {} : { subscriberHelp: input.subscriberHelp }),
					...(input.embeddedLink === undefined ? {} : { embeddedLink: input.embeddedLink }),
					...(input.embeddedPhone === undefined ? {} : { embeddedPhone: input.embeddedPhone }),
					...(input.ageGated === undefined ? {} : { ageGated: input.ageGated }),
					...(input.directLending === undefined ? {} : { directLending: input.directLending }),
					...(input.affiliateMarketing === undefined
						? {}
						: { affiliateMarketing: input.affiliateMarketing }),
					...(input.numberPool === undefined ? {} : { numberPool: input.numberPool }),
					...(input.termsAndConditions === undefined
						? {}
						: { termsAndConditions: input.termsAndConditions }),
					...(input.mock === undefined ? {} : { mock: input.mock }),
				},
				schema: campaignResponse,
			});
			return response.data;
		},

		getCampaign: async (campaignId) => {
			const response = await transport.request({
				method: "GET",
				path: `/10dlc/campaign/${encodeURIComponent(campaignId)}`,
				schema: campaignResponse,
			});
			return response.data;
		},

		listCampaigns: async (brandId) => {
			const response = await transport.request({
				method: "GET",
				path: "/10dlc/campaign",
				// camelCase in the query too, and flat rather than the bracketed `filter[…]` the rest
				// of the v2 API uses.
				query: { brandId },
				schema: campaignListResponse,
			});
			return response.data;
		},

		assignPhoneNumber: async (phoneNumber, campaignId) => {
			const response = await transport.request({
				method: "POST",
				path: "/10dlc/phoneNumberCampaign",
				body: { phoneNumber, campaignId },
				schema: phoneNumberCampaignResponse,
			});
			return response.data;
		},

		unassignPhoneNumber: async (phoneNumber) => {
			await transport.request({
				method: "DELETE",
				path: `/10dlc/phoneNumberCampaign/${encodeURIComponent(phoneNumber)}`,
				// The documented success is an empty body; the schema says so rather than the call
				// site guessing.
				allowEmptyBody: true,
				schema: z.unknown(),
			});
		},
	};
}
