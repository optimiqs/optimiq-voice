import { z } from "zod";
import { dataEnvelope, listEnvelope, telnyxTimestamp } from "../schemas";
import type { TelnyxTransport } from "../transport";

/**
 * `/v2/messaging_profiles` — the object that decides where a message's webhooks go and which
 * destinations a number may text.
 *
 * A DID with no messaging profile cannot send or receive SMS at all, so this is the messaging
 * counterpart of `outbound-voice-profiles.ts`: the second half of "provision a working number".
 * Several numbers share one profile, which is why {@link MessagingProfilesResource.assignPhoneNumber}
 * is an operation on the *number* rather than a membership list on the profile, and why tearing a
 * number down must never assume it may delete the profile.
 *
 * ## The DID attachment lives on a different resource
 *
 * Telnyx attaches a number to a messaging profile with `PATCH /v2/phone_numbers/{id}/messaging`,
 * not with anything under `/messaging_profiles`. It is exposed here rather than in
 * `phone-numbers.ts` because it is meaningless outside this resource's lifecycle — the id it takes
 * is a messaging profile id, and the only reason to call it is to put a number on (or take it off)
 * one. `phone-numbers.ts` owns the *voice* half of a DID's settings; this owns the messaging half.
 */

export const messagingProfileSchema = z.looseObject({
	id: z.string(),
	record_type: z.string().optional(),
	name: z.string().optional(),
	enabled: z.boolean().optional(),
	webhook_url: z.string().nullish(),
	webhook_failover_url: z.string().nullish(),
	webhook_api_version: z.string().optional(),
	whitelisted_destinations: z.array(z.string()).optional(),
	number_pool_settings: z.looseObject({}).nullish(),
	url_shortener_settings: z.looseObject({}).nullish(),
	alpha_sender: z.string().nullish(),
	daily_spend_limit: z.string().nullish(),
	daily_spend_limit_enabled: z.boolean().optional(),
	mms_fall_back_to_sms: z.boolean().optional(),
	mms_transcoding: z.boolean().optional(),
	v1_secret: z.string().nullish(),
	created_at: telnyxTimestamp.optional(),
	updated_at: telnyxTimestamp.optional(),
});

export type TelnyxMessagingProfile = z.infer<typeof messagingProfileSchema>;

/**
 * The messaging half of a DID's settings, returned by `…/phone_numbers/{id}/messaging`.
 *
 * Only `id` is required: it is the number id we already hold, and everything else here is read for
 * display or capability checks rather than persisted as a source of truth.
 */
export const telnyxPhoneNumberMessagingSchema = z.looseObject({
	id: z.string(),
	record_type: z.string().optional(),
	phone_number: z.string().optional(),
	messaging_profile_id: z.string().nullish(),
	messaging_product: z.string().nullish(),
	eligible_messaging_products: z.array(z.string()).optional(),
	features: z.looseObject({}).nullish(),
	type: z.string().optional(),
	country_code: z.string().nullish(),
	traffic_type: z.string().nullish(),
	health: z.looseObject({}).nullish(),
	created_at: telnyxTimestamp.optional(),
	updated_at: telnyxTimestamp.optional(),
});

export type TelnyxPhoneNumberMessaging = z.infer<typeof telnyxPhoneNumberMessagingSchema>;

const profileResponse = dataEnvelope(messagingProfileSchema);
const profileListResponse = listEnvelope(messagingProfileSchema);
const numberMessagingResponse = dataEnvelope(telnyxPhoneNumberMessagingSchema);
const numberMessagingListResponse = listEnvelope(telnyxPhoneNumberMessagingSchema);

/**
 * `POST /v2/messaging_profiles` input.
 *
 * `whitelistedDestinations` defaults to `["US"]` rather than to Telnyx's own default: an
 * unrestricted profile is a compromised tenant credential's blast radius, exactly as with the
 * voice profile's `daily_spend_limit`.
 */
export interface CreateMessagingProfileInput {
	readonly name: string;
	readonly webhookUrl?: string;
	readonly webhookFailoverUrl?: string;
	readonly enabled?: boolean;
	readonly whitelistedDestinations?: readonly string[];
	/**
	 * Accepted so the shape is complete, and deliberately ignored — see {@link profileBody}. Kept
	 * rather than removed so a caller that passes it gets a type error's worth of documentation
	 * instead of an option that silently does nothing.
	 */
	readonly webhookApiVersion?: never;
}

export type UpdateMessagingProfileInput = Partial<Omit<CreateMessagingProfileInput, "name">> & {
	readonly name?: string;
};

/**
 * Builds the wire body.
 *
 * `webhook_api_version: "2"` is set unconditionally and is NOT an option the caller can change,
 * for the same reason `credential-connections.ts` does it: version `"1"` — the Telnyx default —
 * delivers a different envelope (`metadata` with a nested `metadata.event` rather than
 * `data`/`meta`), and `webhooks/events.ts` parses exactly one of those. A profile created any
 * other way would deliver `message.*` webhooks this package rejects.
 */
function profileBody(input: UpdateMessagingProfileInput): Record<string, unknown> {
	const body: Record<string, unknown> = { webhook_api_version: "2" };
	if (input.name !== undefined) {
		body.name = input.name;
	}
	if (input.webhookUrl !== undefined) {
		body.webhook_url = input.webhookUrl;
	}
	if (input.webhookFailoverUrl !== undefined) {
		body.webhook_failover_url = input.webhookFailoverUrl;
	}
	if (input.enabled !== undefined) {
		body.enabled = input.enabled;
	}
	body.whitelisted_destinations = [...(input.whitelistedDestinations ?? ["US"])];
	return body;
}

export interface MessagingProfilesResource {
	readonly create: (input: CreateMessagingProfileInput) => Promise<TelnyxMessagingProfile>;
	readonly get: (profileId: string) => Promise<TelnyxMessagingProfile>;
	readonly list: (nameContains?: string) => Promise<readonly TelnyxMessagingProfile[]>;
	readonly update: (
		profileId: string,
		input: UpdateMessagingProfileInput,
	) => Promise<TelnyxMessagingProfile>;
	readonly remove: (profileId: string) => Promise<TelnyxMessagingProfile>;
	/** Every DID currently attached to this profile — the membership read the profile itself lacks. */
	readonly listPhoneNumbers: (profileId: string) => Promise<readonly TelnyxPhoneNumberMessaging[]>;
	/**
	 * Put a DID on a messaging profile, or take it off with `null`.
	 *
	 * `PATCH /v2/phone_numbers/{id}/messaging` — an endpoint on the number, not on the profile. See
	 * the module header for why it lives here anyway.
	 */
	readonly assignPhoneNumber: (
		phoneNumberId: string,
		messagingProfileId: string | null,
	) => Promise<TelnyxPhoneNumberMessaging>;
}

export function makeMessagingProfiles(transport: TelnyxTransport): MessagingProfilesResource {
	return {
		create: async (input) => {
			const response = await transport.request({
				method: "POST",
				path: "/messaging_profiles",
				// Never retried, for the reason the voice profile gives: no uniqueness constraint and
				// no `Idempotency-Key`, so a 5xx after creation leaves a second profile with nothing
				// to tell the two apart. `list(name)` is the reconciliation read.
				retryable: false,
				body: profileBody(input),
				schema: profileResponse,
			});
			return response.data;
		},

		get: async (profileId) => {
			const response = await transport.request({
				method: "GET",
				path: `/messaging_profiles/${encodeURIComponent(profileId)}`,
				schema: profileResponse,
			});
			return response.data;
		},

		list: async (nameContains) => {
			const response = await transport.request({
				method: "GET",
				path: "/messaging_profiles",
				query: { "filter[name]": nameContains, "page[size]": 50 },
				schema: profileListResponse,
			});
			return response.data;
		},

		update: async (profileId, input) => {
			const response = await transport.request({
				method: "PATCH",
				path: `/messaging_profiles/${encodeURIComponent(profileId)}`,
				body: profileBody(input),
				schema: profileResponse,
			});
			return response.data;
		},

		remove: async (profileId) => {
			const response = await transport.request({
				method: "DELETE",
				path: `/messaging_profiles/${encodeURIComponent(profileId)}`,
				schema: profileResponse,
			});
			return response.data;
		},

		listPhoneNumbers: async (profileId) => {
			const response = await transport.request({
				method: "GET",
				path: `/messaging_profiles/${encodeURIComponent(profileId)}/phone_numbers`,
				query: { "page[size]": 50 },
				schema: numberMessagingListResponse,
			});
			return response.data;
		},

		assignPhoneNumber: async (phoneNumberId, messagingProfileId) => {
			const response = await transport.request({
				method: "PATCH",
				path: `/phone_numbers/${encodeURIComponent(phoneNumberId)}/messaging`,
				// `null` is the documented detach value and must survive as JSON null rather than
				// being dropped the way an omitted optional would be.
				body: { messaging_profile_id: messagingProfileId },
				schema: numberMessagingResponse,
			});
			return response.data;
		},
	};
}
