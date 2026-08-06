import { z } from "zod";
import { dataEnvelope, listEnvelope, telnyxTimestamp } from "../schemas";
import type { TelnyxTransport } from "../transport";

/**
 * `/v2/outbound_voice_profiles` — the object that decides what a connection is allowed to dial and
 * how much it may spend doing it.
 *
 * A credential connection with no outbound voice profile cannot place a call at all, so this is
 * not an optional extra in the provisioning flow: it is the second half of "provision a working
 * trunk". It is a separate resource with its own lifecycle because several connections can share
 * one profile — which is also why tearing a connection down must not assume it may delete the
 * profile, and why the trunk row stores the two references in separate columns.
 *
 * The spend controls (`daily_spend_limit`, `whitelisted_destinations`, `concurrent_call_limit`)
 * are the platform's blast radius against a compromised tenant credential. They are set at
 * creation rather than left at Telnyx's defaults precisely because the default is "no daily
 * limit".
 */

/**
 * Three enums, each single-valued in the current spec.
 *
 * Modelled as literal tuples rather than free strings so that if Telnyx ever adds a member, the
 * failure is a loud shape error in one place with this file's name on it — rather than a value
 * silently flowing into a profile that then bills differently.
 */
export const TELNYX_TRAFFIC_TYPES = ["conversational"] as const;
export type TelnyxTrafficType = (typeof TELNYX_TRAFFIC_TYPES)[number];

export const TELNYX_SERVICE_PLANS = ["global"] as const;
export type TelnyxServicePlan = (typeof TELNYX_SERVICE_PLANS)[number];

export const TELNYX_OVP_PAYMENT_METHODS = ["rate-deck"] as const;
export type TelnyxOvpPaymentMethod = (typeof TELNYX_OVP_PAYMENT_METHODS)[number];

export const outboundVoiceProfileSchema = z.looseObject({
	id: z.string(),
	record_type: z.string().optional(),
	name: z.string(),
	connections_count: z.number().optional(),
	traffic_type: z.string().optional(),
	service_plan: z.string().optional(),
	concurrent_call_limit: z.number().nullish(),
	enabled: z.boolean().optional(),
	tags: z.array(z.string()).optional(),
	usage_payment_method: z.string().optional(),
	whitelisted_destinations: z.array(z.string()).optional(),
	max_destination_rate: z.number().nullish(),
	/** A decimal STRING. Never coerced — money is not a float. */
	daily_spend_limit: z.string().nullish(),
	daily_spend_limit_enabled: z.boolean().optional(),
	call_recording: z.looseObject({}).optional(),
	billing_group_id: z.string().nullish(),
	created_at: telnyxTimestamp.optional(),
	updated_at: telnyxTimestamp.optional(),
});

export type TelnyxOutboundVoiceProfile = z.infer<typeof outboundVoiceProfileSchema>;

const profileResponse = dataEnvelope(outboundVoiceProfileSchema);
const profileListResponse = listEnvelope(outboundVoiceProfileSchema);

/** Telnyx enforces `minLength: 3` on the name; checked here so it fails before the round trip. */
const MIN_PROFILE_NAME_LENGTH = 3;

export class TelnyxProfileNameError extends Error {
	constructor(name: string) {
		super(
			`Telnyx outbound voice profile name "${name}" is too short: at least ${MIN_PROFILE_NAME_LENGTH} characters are required.`,
		);
		this.name = "TelnyxProfileNameError";
	}
}

export interface CreateOutboundVoiceProfileInput {
	readonly name: string;
	readonly concurrentCallLimit?: number;
	readonly enabled?: boolean;
	/** ISO alpha-2 codes. Telnyx defaults to `["US","CA"]` when omitted. */
	readonly whitelistedDestinations?: readonly string[];
	readonly dailySpendLimit?: string;
	readonly dailySpendLimitEnabled?: boolean;
	readonly maxDestinationRate?: number;
	readonly tags?: readonly string[];
	readonly billingGroupId?: string;
}

export type UpdateOutboundVoiceProfileInput = Partial<CreateOutboundVoiceProfileInput>;

function profileBody(input: UpdateOutboundVoiceProfileInput): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	if (input.name !== undefined) {
		body.name = input.name;
	}
	if (input.concurrentCallLimit !== undefined) {
		body.concurrent_call_limit = input.concurrentCallLimit;
	}
	if (input.enabled !== undefined) {
		body.enabled = input.enabled;
	}
	if (input.whitelistedDestinations !== undefined) {
		body.whitelisted_destinations = [...input.whitelistedDestinations];
	}
	if (input.dailySpendLimit !== undefined) {
		body.daily_spend_limit = input.dailySpendLimit;
	}
	if (input.dailySpendLimitEnabled !== undefined) {
		body.daily_spend_limit_enabled = input.dailySpendLimitEnabled;
	}
	if (input.maxDestinationRate !== undefined) {
		body.max_destination_rate = input.maxDestinationRate;
	}
	if (input.tags !== undefined) {
		body.tags = [...input.tags];
	}
	if (input.billingGroupId !== undefined) {
		body.billing_group_id = input.billingGroupId;
	}
	return body;
}

export interface OutboundVoiceProfilesResource {
	readonly create: (input: CreateOutboundVoiceProfileInput) => Promise<TelnyxOutboundVoiceProfile>;
	readonly get: (profileId: string) => Promise<TelnyxOutboundVoiceProfile>;
	readonly update: (
		profileId: string,
		input: UpdateOutboundVoiceProfileInput,
	) => Promise<TelnyxOutboundVoiceProfile>;
	readonly remove: (profileId: string) => Promise<TelnyxOutboundVoiceProfile>;
	readonly list: (nameContains?: string) => Promise<readonly TelnyxOutboundVoiceProfile[]>;
}

export function makeOutboundVoiceProfiles(
	transport: TelnyxTransport,
): OutboundVoiceProfilesResource {
	return {
		create: async (input) => {
			if (input.name.length < MIN_PROFILE_NAME_LENGTH) {
				throw new TelnyxProfileNameError(input.name);
			}
			const response = await transport.request({
				method: "POST",
				path: "/outbound_voice_profiles",
				body: profileBody(input),
				schema: profileResponse,
			});
			return response.data;
		},

		get: async (profileId) => {
			const response = await transport.request({
				method: "GET",
				path: `/outbound_voice_profiles/${encodeURIComponent(profileId)}`,
				schema: profileResponse,
			});
			return response.data;
		},

		update: async (profileId, input) => {
			if (input.name !== undefined && input.name.length < MIN_PROFILE_NAME_LENGTH) {
				throw new TelnyxProfileNameError(input.name);
			}
			const response = await transport.request({
				method: "PATCH",
				path: `/outbound_voice_profiles/${encodeURIComponent(profileId)}`,
				body: profileBody(input),
				schema: profileResponse,
			});
			return response.data;
		},

		remove: async (profileId) => {
			const response = await transport.request({
				method: "DELETE",
				path: `/outbound_voice_profiles/${encodeURIComponent(profileId)}`,
				schema: profileResponse,
			});
			return response.data;
		},

		list: async (nameContains) => {
			const response = await transport.request({
				method: "GET",
				path: "/outbound_voice_profiles",
				query: {
					"filter[name][contains]": nameContains,
					"page[size]": 50,
				},
				schema: profileListResponse,
			});
			return response.data;
		},
	};
}
