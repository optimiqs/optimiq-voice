import { z } from "zod";
import { TelnyxError } from "../errors";
import { dataEnvelope, listEnvelope } from "../schemas";
import type { TelnyxTransport } from "../transport";

/**
 * `/v2/messaging_tollfree/verification/requests` — toll-free messaging verification.
 *
 * ## The toll-free half of the same problem 10DLC solves
 *
 * A toll-free number does not register with TCR; it is verified with the toll-free aggregators
 * instead, through this one submission. Unverified toll-free SMS is throttled to a trickle and
 * then blocked, so — exactly as with `ten-dlc.ts` — this is a precondition for a toll-free DID
 * being useful for messaging, not a compliance afterthought.
 *
 * ## camelCase body, same warning as `ten-dlc.ts`
 *
 * The path is snake_case (`messaging_tollfree/verification/requests`) but the **body is
 * camelCase**: `businessName`, `useCaseSummary`, `optInWorkflowImageURLs`, and note the
 * SCREAMING `URL` suffix on `privacyPolicyURL` / `termsAndConditionURL`. That is the contract, not
 * a typo in this file. Do not normalise it.
 *
 * ## The three BRN fields are required, and recently so
 *
 * `businessRegistrationNumber`, `businessRegistrationType` and `businessRegistrationCountry` have
 * been mandatory on every NEW submission since 17 Feb 2026
 * (https://developers.telnyx.com/docs/messaging/toll-free-verification). They are therefore
 * required TypeScript fields rather than optionals: an omitted BRN is a 400 from the aggregator
 * whose message names nothing useful, and the compiler can say so first.
 * {@link assertBusinessRegistrationCountry} takes the same job for the country code's shape.
 */

/**
 * The aggregator's own status vocabulary, in the aggregator's own casing — space-separated Title
 * Case, not the `SCREAMING_SNAKE` of TCR or the `lower_snake` of the rest of Telnyx. Translated by
 * the API layer into whatever it stores; carried through verbatim here.
 *
 * An `as const` array rather than a zod enum, per the `schemas.ts` policy: a status added by the
 * aggregator must not fail a poll.
 */
export const TELNYX_TOLL_FREE_VERIFICATION_STATUSES = [
	"Pending",
	"In Progress",
	"In Review",
	"Verified",
	"Rejected",
	"Waiting For Customer",
	"Waiting For Vendor",
] as const;
export type TelnyxTollFreeVerificationStatus =
	(typeof TELNYX_TOLL_FREE_VERIFICATION_STATUSES)[number];

export const telnyxTollFreeVerificationSchema = z.looseObject({
	id: z.string(),
	verificationRequestId: z.string().optional(),
	verificationStatus: z.string().optional(),
	businessName: z.string().optional(),
	phoneNumbers: z.array(z.looseObject({ phoneNumber: z.string().optional() })).optional(),
	businessRegistrationNumber: z.string().nullish(),
	businessRegistrationType: z.string().nullish(),
	businessRegistrationCountry: z.string().nullish(),
	entityType: z.string().nullish(),
	reason: z.string().nullish(),
	rejectionReason: z.string().nullish(),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
});

export type TelnyxTollFreeVerification = z.infer<typeof telnyxTollFreeVerificationSchema>;

const verificationResponse = dataEnvelope(telnyxTollFreeVerificationSchema);
const verificationListResponse = listEnvelope(telnyxTollFreeVerificationSchema);

/** Raised for a submission whose fields are malformed, before any network call. */
export class TelnyxTollFreeVerificationRequestError extends TelnyxError {
	readonly field: string;
	constructor(field: string, detail: string) {
		super(`Telnyx toll-free verification request invalid (${field}): ${detail}`);
		this.field = field;
	}
}

/**
 * Normalises and validates the BRN country code: exactly two letters, upper-cased.
 *
 * Checked locally because the aggregator answers a bad one with a bare 400 that does not say which
 * of thirty-odd fields it disliked. Failing here names the field, and upper-casing means a caller
 * passing `"us"` gets a submission rather than a rejection.
 */
export function assertBusinessRegistrationCountry(country: string): string {
	if (!/^[A-Za-z]{2}$/u.test(country)) {
		throw new TelnyxTollFreeVerificationRequestError(
			"businessRegistrationCountry",
			"must be a two-letter ISO 3166-1 alpha-2 country code",
		);
	}
	return country.toUpperCase();
}

/** One destination on the submission. Its own object because the wire shape is `{phoneNumber}`. */
export interface TollFreeVerificationPhoneNumber {
	readonly phoneNumber: string;
}

/** One opt-in evidence image. Its own object for the same reason: the wire shape is `{url}`. */
export interface TollFreeVerificationImage {
	readonly url: string;
}

/** `POST /v2/messaging_tollfree/verification/requests` input. camelCase on the wire. */
export interface SubmitTollFreeVerificationInput {
	readonly businessName: string;
	readonly corporateWebsite: string;
	readonly businessAddr1: string;
	readonly businessAddr2?: string;
	readonly businessCity: string;
	readonly businessState: string;
	readonly businessZip: string;
	readonly businessContactFirstName: string;
	readonly businessContactLastName: string;
	readonly businessContactEmail: string;
	readonly businessContactPhone: string;
	/** Mandatory on every new submission since 17 Feb 2026 — see the module header. */
	readonly businessRegistrationNumber: string;
	readonly businessRegistrationType: string;
	readonly businessRegistrationCountry: string;
	readonly messageVolume: string;
	readonly phoneNumbers: readonly TollFreeVerificationPhoneNumber[];
	readonly useCase: string;
	readonly useCaseSummary: string;
	readonly productionMessageContent: string;
	readonly optInWorkflow: string;
	readonly optInWorkflowImageURLs: readonly TollFreeVerificationImage[];
	readonly privacyPolicyURL: string;
	readonly termsAndConditionURL: string;
	readonly isvReseller?: string;
	readonly additionalInformation?: string;
	readonly entityType?: string;
	readonly doingBusinessAs?: string;
	readonly optInConfirmationResponse?: string;
	readonly helpMessageResponse?: string;
	readonly ageGatedContent?: boolean;
	readonly optInKeywords?: string;
	readonly webhookUrl?: string;
}

export type UpdateTollFreeVerificationInput = Partial<SubmitTollFreeVerificationInput>;

function verificationBody(input: UpdateTollFreeVerificationInput): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	const put = (key: string, value: unknown): void => {
		if (value !== undefined) {
			body[key] = value;
		}
	};
	put("businessName", input.businessName);
	put("corporateWebsite", input.corporateWebsite);
	put("businessAddr1", input.businessAddr1);
	put("businessAddr2", input.businessAddr2);
	put("businessCity", input.businessCity);
	put("businessState", input.businessState);
	put("businessZip", input.businessZip);
	put("businessContactFirstName", input.businessContactFirstName);
	put("businessContactLastName", input.businessContactLastName);
	put("businessContactEmail", input.businessContactEmail);
	put("businessContactPhone", input.businessContactPhone);
	put("businessRegistrationNumber", input.businessRegistrationNumber);
	put("businessRegistrationType", input.businessRegistrationType);
	put(
		"businessRegistrationCountry",
		input.businessRegistrationCountry === undefined
			? undefined
			: assertBusinessRegistrationCountry(input.businessRegistrationCountry),
	);
	put("messageVolume", input.messageVolume);
	put(
		"phoneNumbers",
		input.phoneNumbers === undefined
			? undefined
			: input.phoneNumbers.map((entry) => ({ phoneNumber: entry.phoneNumber })),
	);
	put("useCase", input.useCase);
	put("useCaseSummary", input.useCaseSummary);
	put("productionMessageContent", input.productionMessageContent);
	put("optInWorkflow", input.optInWorkflow);
	put(
		"optInWorkflowImageURLs",
		input.optInWorkflowImageURLs === undefined
			? undefined
			: input.optInWorkflowImageURLs.map((entry) => ({ url: entry.url })),
	);
	put("privacyPolicyURL", input.privacyPolicyURL);
	put("termsAndConditionURL", input.termsAndConditionURL);
	put("isvReseller", input.isvReseller);
	put("additionalInformation", input.additionalInformation);
	put("entityType", input.entityType);
	put("doingBusinessAs", input.doingBusinessAs);
	put("optInConfirmationResponse", input.optInConfirmationResponse);
	put("helpMessageResponse", input.helpMessageResponse);
	put("ageGatedContent", input.ageGatedContent);
	put("optInKeywords", input.optInKeywords);
	put("webhookUrl", input.webhookUrl);
	return body;
}

export interface TollFreeVerificationResource {
	readonly submit: (input: SubmitTollFreeVerificationInput) => Promise<TelnyxTollFreeVerification>;
	readonly get: (verificationId: string) => Promise<TelnyxTollFreeVerification>;
	readonly list: (status?: string) => Promise<readonly TelnyxTollFreeVerification[]>;
	readonly update: (
		verificationId: string,
		input: UpdateTollFreeVerificationInput,
	) => Promise<TelnyxTollFreeVerification>;
	readonly remove: (verificationId: string) => Promise<void>;
}

const BASE_PATH = "/messaging_tollfree/verification/requests";

export function makeTollFreeVerification(transport: TelnyxTransport): TollFreeVerificationResource {
	return {
		submit: async (input) => {
			const response = await transport.request({
				method: "POST",
				path: BASE_PATH,
				// Not retried: a duplicate submission for the same numbers is reviewed by a human at
				// the aggregator and slows the real one down, which is the opposite of what a retry
				// is for. `list()` is the reconciliation read.
				retryable: false,
				body: verificationBody(input),
				schema: verificationResponse,
			});
			return response.data;
		},

		get: async (verificationId) => {
			const response = await transport.request({
				method: "GET",
				path: `${BASE_PATH}/${encodeURIComponent(verificationId)}`,
				schema: verificationResponse,
			});
			return response.data;
		},

		list: async (status) => {
			const response = await transport.request({
				method: "GET",
				path: BASE_PATH,
				// camelCase and flat, like `ten-dlc.ts` and unlike the bracketed `filter[…]` keys the
				// rest of the v2 API uses.
				query: { status, page: 1, pageSize: 50 },
				schema: verificationListResponse,
			});
			return response.data;
		},

		update: async (verificationId, input) => {
			const response = await transport.request({
				method: "PATCH",
				path: `${BASE_PATH}/${encodeURIComponent(verificationId)}`,
				body: verificationBody(input),
				schema: verificationResponse,
			});
			return response.data;
		},

		remove: async (verificationId) => {
			await transport.request({
				method: "DELETE",
				path: `${BASE_PATH}/${encodeURIComponent(verificationId)}`,
				allowEmptyBody: true,
				schema: z.unknown(),
			});
		},
	};
}
