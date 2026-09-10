import { z } from "zod";
import { dataEnvelope, listEnvelope, telnyxTimestamp } from "../schemas";
import type { ListMeta } from "../schemas";
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
 *
 * That asymmetry is not an academic note: it makes "show me this number's CNAM listing" a
 * **two-request** operation, which is why {@link PhoneNumbersResource.getCnamListing} exists
 * rather than being left for each caller to rediscover. See its doc comment.
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

/**
 * A number's caller-ID-name (CNAM) listing, assembled from the two places Telnyx keeps it.
 *
 * `enabled` — whether outbound calls from this DID present a name at all — is written on
 * `PATCH …/voice` as `caller_id_name_enabled` and read from `GET /phone_numbers/{id}`. `listing`
 * — the string carriers actually display, and whether the listing itself is switched on — lives in
 * the `cnam_listing` group on `GET …/voice`. Neither endpoint returns both halves, and a caller
 * that read only one of them would render a listing as "off" whenever the *other* half was the one
 * that was off.
 *
 * So this type is the merged view, and the two methods below are the only supported way to get it.
 */
export interface TelnyxCnamListing {
	/** `caller_id_name_enabled` — present a name on outbound calls. Read from the parent resource. */
	readonly enabled: boolean;
	/** `cnam_listing.cnam_listing_enabled` — the listing record itself. Read from `…/voice`. */
	readonly listingEnabled: boolean;
	/** `cnam_listing.cnam_listing_details` — the 15-character name carriers display. */
	readonly listingDetails: string | null;
}

/**
 * The writable half. Every field optional, and an empty input is a legitimate no-op PATCH.
 *
 * `details` is capped at 15 characters by the NANP CNAM database, not by Telnyx — which accepts a
 * longer string and silently truncates it downstream, so the caller would never learn that the
 * name shown to the called party is not the name they typed. {@link assertCnamDetails} refuses it
 * here instead, before the round trip.
 */
export interface UpdateCnamListingInput {
	readonly enabled?: boolean;
	readonly listingEnabled?: boolean;
	readonly details?: string;
}

/** The NANP CNAM field width. Fifteen characters, and the fifteenth is not negotiable. */
export const TELNYX_CNAM_DETAILS_MAX_LENGTH = 15;

/**
 * Refuses a CNAM string the carrier network cannot carry, before a request is built.
 *
 * Client-side because the failure mode is silence: Telnyx accepts an over-long or
 * non-ASCII-printable `cnam_listing_details` and the name simply arrives mangled — or not at all —
 * at the called party, weeks later, reported as "our calls show up wrong". A local throw turns
 * that into an error message next to the field.
 */
export class TelnyxCnamFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TelnyxCnamFormatError";
	}
}

export function assertCnamDetails(details: string): void {
	if (details.length > TELNYX_CNAM_DETAILS_MAX_LENGTH) {
		throw new TelnyxCnamFormatError(
			`A CNAM listing is at most ${TELNYX_CNAM_DETAILS_MAX_LENGTH} characters; "${details}" is ${details.length}.`,
		);
	}
	if (!/^[\x20-\x7E]*$/u.test(details)) {
		throw new TelnyxCnamFormatError(
			"A CNAM listing may only contain printable ASCII; the CNAM database cannot carry anything else.",
		);
	}
}

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
	/**
	 * The `cnam_listing` group. Accepted by `PATCH …/voice` and returned by `GET …/voice`, unlike
	 * `callerIdNameEnabled` above, which is write-only here — the two travel together in one
	 * request and are read back from two different ones.
	 */
	readonly cnamListing?: {
		readonly cnamListingEnabled?: boolean;
		readonly cnamListingDetails?: string;
	};
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
	/**
	 * One page of numbers. Truncation is silent unless the caller looks: without `page[size]` Telnyx
	 * answers with its own default page and nothing in the array says there are more.
	 */
	readonly list: (query?: ListPhoneNumbersQuery) => Promise<readonly TelnyxPhoneNumber[]>;
	/**
	 * The same call, with the page metadata Telnyx sent.
	 *
	 * `list` throws `meta` away, which is right for `resolveCarrierNumberId` (one E.164, one match)
	 * and wrong for anything admin-facing: a "list our DIDs" caller needs `total_pages` to know its
	 * answer is short. Kept beside `list` rather than replacing it so the common single-number
	 * lookup stays a one-liner.
	 */
	readonly listPage: (query?: ListPhoneNumbersQuery) => Promise<{
		readonly data: readonly TelnyxPhoneNumber[];
		readonly meta: ListMeta;
	}>;
	readonly get: (numberId: string) => Promise<TelnyxPhoneNumber>;
	readonly update: (numberId: string, input: UpdatePhoneNumberInput) => Promise<TelnyxPhoneNumber>;
	readonly getVoiceSettings: (numberId: string) => Promise<TelnyxVoiceSettings>;
	readonly updateVoiceSettings: (
		numberId: string,
		input: UpdateVoiceSettingsInput,
	) => Promise<TelnyxVoiceSettings>;
	/**
	 * The merged CNAM view. **Two requests**, because Telnyx splits the answer across two
	 * endpoints — see {@link TelnyxCnamListing}. The cost is paid here, once, rather than by every
	 * caller who would otherwise read one endpoint and believe it.
	 */
	readonly getCnamListing: (numberId: string) => Promise<TelnyxCnamListing>;
	/**
	 * Writes both halves in one `PATCH …/voice`, then re-reads to return the merged view — which
	 * is a second request for the same reason the read is two: the PATCH response carries
	 * `cnam_listing` but not `caller_id_name_enabled`, so echoing it back would report the flag the
	 * caller just set as whatever it happened to be before.
	 */
	readonly updateCnamListing: (
		numberId: string,
		input: UpdateCnamListingInput,
	) => Promise<TelnyxCnamListing>;
	/** `DELETE` — the release. Returns the record so the caller can log the resulting status. */
	readonly release: (numberId: string) => Promise<TelnyxPhoneNumber>;
}

/**
 * Folds the two halves into the merged view.
 *
 * Both flags default to `false` when absent rather than to `undefined`: "Telnyx did not send the
 * field" and "the feature is off" are the same thing to a caller deciding whether to bill for CNAM,
 * and a tri-state here would push that decision onto every one of them.
 */
function mergeCnam(number: TelnyxPhoneNumber, voice: TelnyxVoiceSettings): TelnyxCnamListing {
	return {
		enabled: number.caller_id_name_enabled ?? false,
		listingEnabled:
			voice.cnam_listing?.cnam_listing_enabled ?? number.cnam_listing_enabled ?? false,
		listingDetails: voice.cnam_listing?.cnam_listing_details ?? null,
	};
}

export function makePhoneNumbers(transport: TelnyxTransport): PhoneNumbersResource {
	const listPage = async (query: ListPhoneNumbersQuery = {}) => {
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
		return { data: response.data, meta: response.meta };
	};

	return {
		listPage,

		list: async (query = {}) => (await listPage(query)).data,

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
					...(input.cnamListing === undefined
						? {}
						: {
								cnam_listing: {
									...(input.cnamListing.cnamListingEnabled === undefined
										? {}
										: { cnam_listing_enabled: input.cnamListing.cnamListingEnabled }),
									...(input.cnamListing.cnamListingDetails === undefined
										? {}
										: { cnam_listing_details: input.cnamListing.cnamListingDetails }),
								},
							}),
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

		getCnamListing: async (numberId) => {
			// Two reads, in parallel: they are independent and a CNAM screen should not pay for them
			// serially. See TelnyxCnamListing for why one of them is not enough.
			const [number, voice] = await Promise.all([
				transport.request({
					method: "GET",
					path: `/phone_numbers/${encodeURIComponent(numberId)}`,
					schema: numberResponse,
				}),
				transport.request({
					method: "GET",
					path: `/phone_numbers/${encodeURIComponent(numberId)}/voice`,
					schema: voiceResponse,
				}),
			]);
			return mergeCnam(number.data, voice.data);
		},

		updateCnamListing: async (numberId, input) => {
			if (input.details !== undefined) {
				assertCnamDetails(input.details);
			}
			await transport.request({
				method: "PATCH",
				path: `/phone_numbers/${encodeURIComponent(numberId)}/voice`,
				body: {
					...(input.enabled === undefined ? {} : { caller_id_name_enabled: input.enabled }),
					...(input.listingEnabled === undefined && input.details === undefined
						? {}
						: {
								cnam_listing: {
									...(input.listingEnabled === undefined
										? {}
										: { cnam_listing_enabled: input.listingEnabled }),
									...(input.details === undefined ? {} : { cnam_listing_details: input.details }),
								},
							}),
				},
				schema: voiceResponse,
			});
			// The PATCH response cannot answer "is caller_id_name_enabled on now?" — it is write-only
			// on this endpoint. Re-read rather than report the request back as if it were the state.
			const [number, voice] = await Promise.all([
				transport.request({
					method: "GET",
					path: `/phone_numbers/${encodeURIComponent(numberId)}`,
					schema: numberResponse,
				}),
				transport.request({
					method: "GET",
					path: `/phone_numbers/${encodeURIComponent(numberId)}/voice`,
					schema: voiceResponse,
				}),
			]);
			return mergeCnam(number.data, voice.data);
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
