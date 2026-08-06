import { z } from "zod";
import { dataEnvelope, telnyxTimestamp } from "../schemas";
import type { TelnyxTransport } from "../transport";

/**
 * `/v2/credential_connections` — the SIP trunk, as Telnyx models it.
 *
 * A credential connection is a username/password pair that authenticates a REGISTER (inbound) and
 * answers a `407` on an INVITE (outbound) at `sip.telnyx.com`. It is the connection type chosen in
 * `reference/telnyx-api.md` §Connection types, and the reason is worth restating here because it
 * is the whole basis of the trunk-provisioning feature: it is the only shape that needs **zero**
 * coordination with the customer's network. No static IP to register, no DNS to publish, no
 * firewall rule to accept unsolicited INVITEs — which is what makes "provision a working trunk in
 * one click" a thing the control plane can actually promise.
 *
 * `POST` returns **201** here (the only endpoint in this package that does not return 200).
 */

/**
 * Anchorsite selection — where Telnyx anchors MEDIA, not signalling.
 *
 * Exactly ten values, capitalized, comma-space formatted. Telnyx's own anchorsite-configuration
 * page lists eleven and shows a lowercase example; those extra values are rejected by the API. The
 * tuple is closed so a typo is a TypeScript error rather than a 422 discovered in production.
 */
export const TELNYX_ANCHORSITES = [
	"Latency",
	"Chicago, IL",
	"Ashburn, VA",
	"San Jose, CA",
	"Sydney, Australia",
	"Amsterdam, Netherlands",
	"London, UK",
	"Toronto, Canada",
	"Vancouver, Canada",
	"Frankfurt, Germany",
] as const;
export type TelnyxAnchorsite = (typeof TELNYX_ANCHORSITES)[number];

/** Note the spaces: `RFC 2833`, not `rfc2833`. */
export const TELNYX_DTMF_TYPES = ["RFC 2833", "Inband", "SIP INFO"] as const;
export type TelnyxDtmfType = (typeof TELNYX_DTMF_TYPES)[number];

export const TELNYX_SIP_URI_CALLING_PREFERENCES = ["disabled", "unrestricted", "internal"] as const;
export type TelnyxSipUriCallingPreference = (typeof TELNYX_SIP_URI_CALLING_PREFERENCES)[number];

/**
 * Registration health, from `actions/check_registration_status`.
 *
 * Values are Title Case with spaces, exactly as returned.
 */
export const TELNYX_REGISTRATION_STATUSES = [
	"Not Applicable",
	"Not Registered",
	"Failed",
	"Expired",
	"Registered",
	"Unregistered",
] as const;
export type TelnyxRegistrationStatus = (typeof TELNYX_REGISTRATION_STATUSES)[number];

// -------------------------------------------------------------------------------------------
// Credential validation, enforced here rather than discovered as a 422
// -------------------------------------------------------------------------------------------

/**
 * `user_name`: 4–32 alphanumeric characters, with at least one LETTER among the first five.
 *
 * The second rule appears only on Telnyx's response schema, not its request schema, but the API
 * enforces it — which is exactly the kind of asymmetry that produces a provisioning failure a
 * human is watching in real time. Checked locally so the failure is a typed error with a message
 * that says what to do, instead of a round trip that comes back saying "invalid".
 */
const USER_NAME_PATTERN = /^[A-Za-z0-9]{4,32}$/u;
const USER_NAME_LETTER_WINDOW = 5;

export class TelnyxCredentialFormatError extends Error {
	readonly field: "user_name" | "password";

	constructor(field: "user_name" | "password", detail: string) {
		super(`Telnyx credential ${field} is invalid: ${detail}`);
		this.name = "TelnyxCredentialFormatError";
		this.field = field;
	}
}

export function assertTelnyxUserName(userName: string): void {
	if (!USER_NAME_PATTERN.test(userName)) {
		throw new TelnyxCredentialFormatError(
			"user_name",
			"must be 4-32 alphanumeric characters with no spaces or symbols",
		);
	}
	if (!/[A-Za-z]/u.test(userName.slice(0, USER_NAME_LETTER_WINDOW))) {
		throw new TelnyxCredentialFormatError(
			"user_name",
			`at least one of the first ${USER_NAME_LETTER_WINDOW} characters must be a letter`,
		);
	}
}

export function assertTelnyxPassword(password: string): void {
	if (password.length < 8 || password.length > 128) {
		throw new TelnyxCredentialFormatError("password", "must be 8 to 128 characters");
	}
}

// -------------------------------------------------------------------------------------------
// Schemas
// -------------------------------------------------------------------------------------------

export const credentialConnectionSchema = z.looseObject({
	id: z.string(),
	record_type: z.string().optional(),
	connection_name: z.string().optional(),
	/**
	 * Required: the whole point of provisioning is to learn the credential, and a connection whose
	 * username we failed to read is one the trunk row cannot be configured from.
	 */
	user_name: z.string(),
	/**
	 * Telnyx echoes the password back. It is required for the same reason as `user_name` — a
	 * provision that cannot report the secret produced a trunk that cannot register.
	 */
	password: z.string(),
	active: z.boolean().optional(),
	anchorsite_override: z.string().optional(),
	dtmf_type: z.string().optional(),
	encrypted_media: z.string().nullish(),
	encode_contact_header_enabled: z.boolean().optional(),
	default_on_hold_comfort_noise_enabled: z.boolean().optional(),
	onnet_t38_passthrough_enabled: z.boolean().optional(),
	sip_uri_calling_preference: z.string().optional(),
	webhook_event_url: z.string().nullish(),
	webhook_event_failover_url: z.string().nullish(),
	webhook_api_version: z.string().optional(),
	webhook_timeout_secs: z.number().nullish(),
	tags: z.array(z.string()).optional(),
	rtcp_settings: z.looseObject({}).optional(),
	inbound: z.looseObject({}).optional(),
	outbound: z
		.looseObject({
			outbound_voice_profile_id: z.string().nullish(),
			channel_limit: z.number().nullish(),
			ani_override: z.string().nullish(),
			ani_override_type: z.string().nullish(),
			localization: z.string().nullish(),
		})
		.optional(),
	created_at: telnyxTimestamp.optional(),
	updated_at: telnyxTimestamp.optional(),
});

export type TelnyxCredentialConnection = z.infer<typeof credentialConnectionSchema>;

export const registrationStatusSchema = z.looseObject({
	record_type: z.string().optional(),
	status: z.string().optional(),
	sip_username: z.string().nullish(),
	ip_address: z.string().nullish(),
	transport: z.string().nullish(),
	port: z.number().nullish(),
	user_agent: z.string().nullish(),
	last_registration: telnyxTimestamp.nullish(),
});

export type TelnyxRegistrationStatusReport = z.infer<typeof registrationStatusSchema>;

const connectionResponse = dataEnvelope(credentialConnectionSchema);
const registrationResponse = dataEnvelope(registrationStatusSchema);

export interface CreateCredentialConnectionInput {
	readonly connectionName: string;
	readonly userName: string;
	readonly password: string;
	readonly outboundVoiceProfileId?: string;
	readonly anchorsiteOverride?: TelnyxAnchorsite;
	readonly dtmfType?: TelnyxDtmfType;
	readonly webhookEventUrl?: string;
	readonly webhookEventFailoverUrl?: string;
	readonly webhookTimeoutSecs?: number;
	readonly sipUriCallingPreference?: TelnyxSipUriCallingPreference;
	readonly encodeContactHeaderEnabled?: boolean;
	readonly onnetT38PassthroughEnabled?: boolean;
	readonly outboundChannelLimit?: number;
	readonly tags?: readonly string[];
	readonly active?: boolean;
}

export type UpdateCredentialConnectionInput = Partial<CreateCredentialConnectionInput>;

/**
 * Builds the wire body.
 *
 * `webhook_api_version: "2"` is set unconditionally and is NOT an option the caller can change.
 * Version `"1"` — the Telnyx default — delivers a different envelope (`metadata` with a nested
 * `metadata.event` rather than `data`/`meta`), and the receiver in `apps/api` parses exactly one
 * of those. Making the version configurable would let a connection be created that silently sends
 * webhooks nothing can read.
 */
function connectionBody(input: UpdateCredentialConnectionInput): Record<string, unknown> {
	const body: Record<string, unknown> = { webhook_api_version: "2" };
	if (input.connectionName !== undefined) {
		body.connection_name = input.connectionName;
	}
	if (input.userName !== undefined) {
		body.user_name = input.userName;
	}
	if (input.password !== undefined) {
		body.password = input.password;
	}
	if (input.anchorsiteOverride !== undefined) {
		body.anchorsite_override = input.anchorsiteOverride;
	}
	if (input.dtmfType !== undefined) {
		body.dtmf_type = input.dtmfType;
	}
	if (input.webhookEventUrl !== undefined) {
		body.webhook_event_url = input.webhookEventUrl;
	}
	if (input.webhookEventFailoverUrl !== undefined) {
		body.webhook_event_failover_url = input.webhookEventFailoverUrl;
	}
	if (input.webhookTimeoutSecs !== undefined) {
		body.webhook_timeout_secs = input.webhookTimeoutSecs;
	}
	if (input.sipUriCallingPreference !== undefined) {
		body.sip_uri_calling_preference = input.sipUriCallingPreference;
	}
	if (input.encodeContactHeaderEnabled !== undefined) {
		body.encode_contact_header_enabled = input.encodeContactHeaderEnabled;
	}
	if (input.onnetT38PassthroughEnabled !== undefined) {
		body.onnet_t38_passthrough_enabled = input.onnetT38PassthroughEnabled;
	}
	if (input.active !== undefined) {
		body.active = input.active;
	}
	if (input.tags !== undefined) {
		body.tags = [...input.tags];
	}
	const outbound: Record<string, unknown> = {};
	if (input.outboundVoiceProfileId !== undefined) {
		outbound.outbound_voice_profile_id = input.outboundVoiceProfileId;
	}
	if (input.outboundChannelLimit !== undefined) {
		outbound.channel_limit = input.outboundChannelLimit;
	}
	if (Object.keys(outbound).length > 0) {
		body.outbound = outbound;
	}
	return body;
}

export interface CredentialConnectionsResource {
	readonly create: (input: CreateCredentialConnectionInput) => Promise<TelnyxCredentialConnection>;
	readonly get: (connectionId: string) => Promise<TelnyxCredentialConnection>;
	readonly update: (
		connectionId: string,
		input: UpdateCredentialConnectionInput,
	) => Promise<TelnyxCredentialConnection>;
	readonly remove: (connectionId: string) => Promise<TelnyxCredentialConnection>;
	readonly checkRegistrationStatus: (
		connectionId: string,
	) => Promise<TelnyxRegistrationStatusReport>;
}

export function makeCredentialConnections(
	transport: TelnyxTransport,
): CredentialConnectionsResource {
	return {
		create: async (input) => {
			assertTelnyxUserName(input.userName);
			assertTelnyxPassword(input.password);
			const response = await transport.request({
				method: "POST",
				path: "/credential_connections",
				// Creating a connection is cheap and non-billable, and a duplicate is detectable and
				// deletable — unlike a duplicate number order. Retrying is therefore the safer default
				// here, which is why this call does NOT opt out.
				body: connectionBody(input),
				schema: connectionResponse,
			});
			return response.data;
		},

		get: async (connectionId) => {
			const response = await transport.request({
				method: "GET",
				path: `/credential_connections/${encodeURIComponent(connectionId)}`,
				schema: connectionResponse,
			});
			return response.data;
		},

		update: async (connectionId, input) => {
			if (input.userName !== undefined) {
				assertTelnyxUserName(input.userName);
			}
			if (input.password !== undefined) {
				assertTelnyxPassword(input.password);
			}
			const response = await transport.request({
				method: "PATCH",
				path: `/credential_connections/${encodeURIComponent(connectionId)}`,
				body: connectionBody(input),
				schema: connectionResponse,
			});
			return response.data;
		},

		remove: async (connectionId) => {
			const response = await transport.request({
				method: "DELETE",
				path: `/credential_connections/${encodeURIComponent(connectionId)}`,
				schema: connectionResponse,
			});
			return response.data;
		},

		checkRegistrationStatus: async (connectionId) => {
			const response = await transport.request({
				method: "POST",
				path: `/credential_connections/${encodeURIComponent(
					connectionId,
				)}/actions/check_registration_status`,
				schema: registrationResponse,
			});
			return response.data;
		},
	};
}
