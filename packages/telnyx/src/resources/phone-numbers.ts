import { z } from "zod";
import { dataEnvelope, listEnvelope, telnyxTimestamp } from "../schemas";
import type { TelnyxTransport } from "../transport";

/**
 * `/v2/phone_numbers` — the numbers we already own: list, read, configure, release.
 *
 * Two shapes that are easy to get wrong and are therefore pinned here rather than assumed:
 *
 * - **`DELETE` returns 200 with the full record**, not 204. The returned `status` is what proves
 *   the release was accepted, so discarding the body would throw away the only evidence.
 * - **The voice sub-resource's GET and PATCH are asymmetric.** `caller_id_name_enabled` can be
 *   written there but not read back, and `connection_id` is the opposite — it is set on the parent
 *   resource. They therefore get two schemas, not one, because a single "voice settings" type
 *   would quietly promise a round trip that does not exist.
 */

/**
 * The 13-value status enum returned for a single number. Not narrowed to a union in the schema —
 * see `schemas.ts` for why unknown members must not break a read — but listed so the API layer can
 * classify without inventing its own list.
 */
export const TELNYX_PHONE_NUMBER_STATUSES = [
	"purchase-pending",
	"purchase-failed",
	"port-pending",
	"port-failed",
	"active",
	"deleted",
	"emergency-only",
	"ported-out",
	"port-out-pending",
	"requirement-info-pending",
	"requirement-info-under-review",
	"requirement-info-exception",
	"provision-pending",
] as const;
export type TelnyxPhoneNumberStatus = (typeof TELNYX_PHONE_NUMBER_STATUSES)[number];

/** Statuses in which a number is carrying traffic (or about to). */
export function isTelnyxNumberLive(status: string): boolean {
	return status === "active" || status === "emergency-only";
}

export const telnyxPhoneNumberSchema = z.looseObject({
	id: z.string(),
	record_type: z.string().optional(),
	phone_number: z.string(),
	status: z.string(),
	connection_id: z.string().nullish(),
	connection_name: z.string().nullish(),
	customer_reference: z.string().nullish(),
	messaging_profile_id: z.string().nullish(),
	billing_group_id: z.string().nullish(),
	emergency_enabled: z.boolean().optional(),
	emergency_address_id: z.string().nullish(),
	call_forwarding_enabled: z.boolean().optional(),
	cnam_listing_enabled: z.boolean().optional(),
	caller_id_name_enabled: z.boolean().optional(),
	call_recording_enabled: z.boolean().optional(),
	t38_fax_gateway_enabled: z.boolean().optional(),
	phone_number_type: z.string().optional(),
	tags: z.array(z.string()).optional(),
	external_pin: z.string().nullish(),
	purchased_at: telnyxTimestamp.nullish(),
	created_at: telnyxTimestamp.optional(),
	updated_at: telnyxTimestamp.optional(),
});

export type TelnyxPhoneNumber = z.infer<typeof telnyxPhoneNumberSchema>;

/** `GET /v2/phone_numbers/{id}/voice` — read shape. `caller_id_name_enabled` is absent by design. */
export const telnyxVoiceSettingsSchema = z.looseObject({
	id: z.string().optional(),
	record_type: z.string().optional(),
	phone_number: z.string().optional(),
	connection_id: z.string().nullish(),
	customer_reference: z.string().nullish(),
	tech_prefix_enabled: z.boolean().optional(),
	translated_number: z.string().nullish(),
	usage_payment_method: z.string().optional(),
	inbound_call_screening: z.string().optional(),
	call_forwarding: z
		.looseObject({
			call_forwarding_enabled: z.boolean().optional(),
			forwards_to: z.string().nullish(),
			forwarding_type: z.string().nullish(),
		})
		.optional(),
	cnam_listing: z
		.looseObject({
			cnam_listing_enabled: z.boolean().optional(),
			cnam_listing_details: z.string().nullish(),
		})
		.optional(),
	emergency: z
		.looseObject({
			emergency_enabled: z.boolean().optional(),
			emergency_address_id: z.string().nullish(),
			emergency_status: z.string().nullish(),
		})
		.optional(),
	media_features: z
		.looseObject({
			rtp_auto_adjust_enabled: z.boolean().optional(),
			accept_any_rtp_packets_enabled: z.boolean().optional(),
			t38_fax_gateway_enabled: z.boolean().optional(),
		})
		.optional(),
	call_recording: z
		.looseObject({
			inbound_call_recording_enabled: z.boolean().optional(),
			inbound_call_recording_format: z.string().nullish(),
			inbound_call_recording_channels: z.string().nullish(),
		})
		.optional(),
});

export type TelnyxVoiceSettings = z.infer<typeof telnyxVoiceSettingsSchema>;

const numberResponse = dataEnvelope(telnyxPhoneNumberSchema);
const numberListResponse = listEnvelope(telnyxPhoneNumberSchema);
const voiceResponse = dataEnvelope(telnyxVoiceSettingsSchema);

export interface ListPhoneNumbersQuery {
	readonly phoneNumber?: string;
	readonly status?: string;
	readonly connectionId?: string;
	readonly customerReference?: string;
	readonly pageSize?: number;
	readonly pageNumber?: number;
}

/** `PATCH /v2/phone_numbers/{id}` — the fields Telnyx accepts on the parent resource. */
export interface UpdatePhoneNumberInput {
	readonly connectionId?: string;
	readonly customerReference?: string;
	readonly billingGroupId?: string;
	readonly externalPin?: string;
	readonly hdVoiceEnabled?: boolean;
	readonly addressId?: string;
	readonly tags?: readonly string[];
}

/**
 * `PATCH /v2/phone_numbers/{id}/voice` — a strictly smaller field set than the parent PATCH, and
 * a different one from the voice GET. See the module header.
 */
export interface UpdateVoiceSettingsInput {
	readonly techPrefixEnabled?: boolean;
	readonly translatedNumber?: string;
	readonly callerIdNameEnabled?: boolean;
	readonly usagePaymentMethod?: "pay-per-minute" | "channel";
	readonly inboundCallScreening?: "disabled" | "reject_calls" | "flag_calls";
	readonly callForwarding?: {
		readonly callForwardingEnabled?: boolean;
		readonly forwardsTo?: string;
		readonly forwardingType?: "always" | "on-failure";
	};
	readonly callRecording?: {
		readonly inboundCallRecordingEnabled?: boolean;
		readonly inboundCallRecordingFormat?: "wav" | "mp3";
		readonly inboundCallRecordingChannels?: "single" | "dual";
	};
	readonly mediaFeatures?: {
		readonly rtpAutoAdjustEnabled?: boolean;
		readonly acceptAnyRtpPacketsEnabled?: boolean;
		readonly t38FaxGatewayEnabled?: boolean;
	};
}

export interface PhoneNumbersResource {
	readonly list: (query?: ListPhoneNumbersQuery) => Promise<readonly TelnyxPhoneNumber[]>;
	readonly get: (numberId: string) => Promise<TelnyxPhoneNumber>;
	readonly update: (numberId: string, input: UpdatePhoneNumberInput) => Promise<TelnyxPhoneNumber>;
	readonly getVoiceSettings: (numberId: string) => Promise<TelnyxVoiceSettings>;
	readonly updateVoiceSettings: (
		numberId: string,
		input: UpdateVoiceSettingsInput,
	) => Promise<TelnyxVoiceSettings>;
	/** `DELETE` — the release. Returns the record so the caller can log the resulting status. */
	readonly release: (numberId: string) => Promise<TelnyxPhoneNumber>;
}

export function makePhoneNumbers(transport: TelnyxTransport): PhoneNumbersResource {
	return {
		list: async (query = {}) => {
			const response = await transport.request({
				method: "GET",
				path: "/phone_numbers",
				query: {
					"filter[phone_number]": query.phoneNumber,
					"filter[status]": query.status,
					"filter[connection_id]": query.connectionId,
					"filter[customer_reference]": query.customerReference,
					"page[size]": query.pageSize,
					"page[number]": query.pageNumber,
				},
				schema: numberListResponse,
			});
			return response.data;
		},

		get: async (numberId) => {
			const response = await transport.request({
				method: "GET",
				path: `/phone_numbers/${encodeURIComponent(numberId)}`,
				schema: numberResponse,
			});
			return response.data;
		},

		update: async (numberId, input) => {
			const response = await transport.request({
				method: "PATCH",
				path: `/phone_numbers/${encodeURIComponent(numberId)}`,
				body: {
					...(input.connectionId === undefined ? {} : { connection_id: input.connectionId }),
					...(input.customerReference === undefined
						? {}
						: { customer_reference: input.customerReference }),
					...(input.billingGroupId === undefined ? {} : { billing_group_id: input.billingGroupId }),
					...(input.externalPin === undefined ? {} : { external_pin: input.externalPin }),
					...(input.hdVoiceEnabled === undefined ? {} : { hd_voice_enabled: input.hdVoiceEnabled }),
					...(input.addressId === undefined ? {} : { address_id: input.addressId }),
					...(input.tags === undefined ? {} : { tags: [...input.tags] }),
				},
				schema: numberResponse,
			});
			return response.data;
		},

		getVoiceSettings: async (numberId) => {
			const response = await transport.request({
				method: "GET",
				path: `/phone_numbers/${encodeURIComponent(numberId)}/voice`,
				schema: voiceResponse,
			});
			return response.data;
		},

		updateVoiceSettings: async (numberId, input) => {
			const response = await transport.request({
				method: "PATCH",
				path: `/phone_numbers/${encodeURIComponent(numberId)}/voice`,
				body: {
					...(input.techPrefixEnabled === undefined
						? {}
						: { tech_prefix_enabled: input.techPrefixEnabled }),
					...(input.translatedNumber === undefined
						? {}
						: { translated_number: input.translatedNumber }),
					...(input.callerIdNameEnabled === undefined
						? {}
						: { caller_id_name_enabled: input.callerIdNameEnabled }),
					...(input.usagePaymentMethod === undefined
						? {}
						: { usage_payment_method: input.usagePaymentMethod }),
					...(input.inboundCallScreening === undefined
						? {}
						: { inbound_call_screening: input.inboundCallScreening }),
					...(input.callForwarding === undefined
						? {}
						: {
								call_forwarding: {
									...(input.callForwarding.callForwardingEnabled === undefined
										? {}
										: { call_forwarding_enabled: input.callForwarding.callForwardingEnabled }),
									...(input.callForwarding.forwardsTo === undefined
										? {}
										: { forwards_to: input.callForwarding.forwardsTo }),
									...(input.callForwarding.forwardingType === undefined
										? {}
										: { forwarding_type: input.callForwarding.forwardingType }),
								},
							}),
					...(input.callRecording === undefined
						? {}
						: {
								call_recording: {
									...(input.callRecording.inboundCallRecordingEnabled === undefined
										? {}
										: {
												inbound_call_recording_enabled:
													input.callRecording.inboundCallRecordingEnabled,
											}),
									...(input.callRecording.inboundCallRecordingFormat === undefined
										? {}
										: {
												inbound_call_recording_format:
													input.callRecording.inboundCallRecordingFormat,
											}),
									...(input.callRecording.inboundCallRecordingChannels === undefined
										? {}
										: {
												inbound_call_recording_channels:
													input.callRecording.inboundCallRecordingChannels,
											}),
								},
							}),
					...(input.mediaFeatures === undefined
						? {}
						: {
								media_features: {
									...(input.mediaFeatures.rtpAutoAdjustEnabled === undefined
										? {}
										: { rtp_auto_adjust_enabled: input.mediaFeatures.rtpAutoAdjustEnabled }),
									...(input.mediaFeatures.acceptAnyRtpPacketsEnabled === undefined
										? {}
										: {
												accept_any_rtp_packets_enabled:
													input.mediaFeatures.acceptAnyRtpPacketsEnabled,
											}),
									...(input.mediaFeatures.t38FaxGatewayEnabled === undefined
										? {}
										: { t38_fax_gateway_enabled: input.mediaFeatures.t38FaxGatewayEnabled }),
								},
							}),
				},
				schema: voiceResponse,
			});
			return response.data;
		},

		release: async (numberId) => {
			const response = await transport.request({
				method: "DELETE",
				path: `/phone_numbers/${encodeURIComponent(numberId)}`,
				schema: numberResponse,
			});
			return response.data;
		},
	};
}
