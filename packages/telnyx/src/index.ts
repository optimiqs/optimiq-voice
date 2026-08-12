/**
 * `@optimiq-voice/telnyx` — a typed client for the Telnyx API v2 surface Optimiq Voice depends on,
 * plus the Ed25519 webhook verifier.
 *
 * The API surface this is pinned to, with the doc URL each field was read from, is
 * `reference/telnyx-api.md`. When a response stops parsing, that file is the first thing to read
 * and the second thing to update.
 *
 * The in-package fake server lives behind the `@optimiq-voice/telnyx/fake` subpath so a production
 * bundle cannot pull it in by importing the root.
 *
 * Implements owner decision D5 (`plans/optimiq-voice-master-plan.md` §9).
 */

export { createTelnyxClient, type TelnyxClient } from "./client";
export {
	TelnyxApiError,
	type TelnyxApiErrorDetail,
	TelnyxError,
	TelnyxResponseShapeError,
	TelnyxSignatureError,
	TelnyxTransportError,
} from "./errors";
export {
	type AvailableNumberSearch,
	availableNumbersQuery,
	availablePhoneNumberSchema,
	TELNYX_NUMBER_FEATURES,
	TELNYX_PHONE_NUMBER_TYPES,
	type TelnyxAvailablePhoneNumber,
	type TelnyxNumberFeature,
	type TelnyxPhoneNumberType,
} from "./resources/available-numbers";
export {
	assertTelnyxPassword,
	assertTelnyxUserName,
	type CreateCredentialConnectionInput,
	credentialConnectionSchema,
	TELNYX_ANCHORSITES,
	TELNYX_DTMF_TYPES,
	TELNYX_REGISTRATION_STATUSES,
	TELNYX_SIP_URI_CALLING_PREFERENCES,
	type TelnyxAnchorsite,
	TelnyxCredentialFormatError,
	type TelnyxCredentialConnection,
	type TelnyxDtmfType,
	type TelnyxRegistrationStatus,
	type TelnyxRegistrationStatusReport,
	type TelnyxSipUriCallingPreference,
	type UpdateCredentialConnectionInput,
} from "./resources/credential-connections";
export {
	assertFaxMedia,
	type FaxesResource,
	isTelnyxFaxEvent,
	type SendFaxInput,
	TELNYX_FAX_DIRECTIONS,
	TELNYX_FAX_EVENT_TYPES,
	TELNYX_FAX_EVENTS,
	TELNYX_FAX_QUALITIES,
	TELNYX_FAX_STATUSES,
	type TelnyxFax,
	type TelnyxFaxDirection,
	type TelnyxFaxEventType,
	TelnyxFaxRequestError,
	type TelnyxFaxQuality,
	type TelnyxFaxStatus,
	type TelnyxFaxWebhookPayload,
	telnyxFaxSchema,
	telnyxFaxWebhookPayloadSchema,
} from "./resources/faxes";
export {
	type CreateNumberOrderInput,
	numberOrderSchema,
	TELNYX_ORDER_STATUSES,
	TELNYX_REQUIREMENTS_STATUSES,
	type TelnyxNumberOrder,
	type TelnyxOrderStatus,
	type TelnyxRequirementsStatus,
} from "./resources/number-orders";
export {
	type CreateOutboundVoiceProfileInput,
	outboundVoiceProfileSchema,
	TELNYX_OVP_PAYMENT_METHODS,
	TELNYX_SERVICE_PLANS,
	TELNYX_TRAFFIC_TYPES,
	type TelnyxOutboundVoiceProfile,
	type TelnyxOvpPaymentMethod,
	TelnyxProfileNameError,
	type TelnyxServicePlan,
	type TelnyxTrafficType,
	type UpdateOutboundVoiceProfileInput,
} from "./resources/outbound-voice-profiles";
export {
	isTelnyxNumberLive,
	type ListPhoneNumbersQuery,
	TELNYX_PHONE_NUMBER_STATUSES,
	type TelnyxPhoneNumber,
	type TelnyxPhoneNumberStatus,
	type TelnyxVoiceSettings,
	telnyxPhoneNumberSchema,
	telnyxVoiceSettingsSchema,
	type UpdatePhoneNumberInput,
	type UpdateVoiceSettingsInput,
} from "./resources/phone-numbers";
export {
	backoffDelayMs,
	DEFAULT_RETRY_POLICY,
	isRetryableStatus,
	parseRateLimitResetMs,
	parseRetryAfterMs,
	type RetryPolicy,
} from "./retry";
export {
	DEFAULT_TELNYX_SIP_DOMAIN,
	DEFAULT_TELNYX_SIP_REGION,
	TELNYX_REGISTER_EXPIRES_SECONDS,
	TELNYX_RTP_PORT_RANGE,
	TELNYX_SIP_DOMAINS,
	TELNYX_SIP_PORT,
	TELNYX_SIP_REGIONS,
	TELNYX_SIP_TLS_PORT,
	TELNYX_WEBHOOK_SOURCE_CIDR,
	type TelnyxSipRegion,
	telnyxSipDomain,
	telnyxSipProxy,
	telnyxSipUri,
} from "./sip";
export {
	TELNYX_API_BASE,
	type TelnyxAttemptEvent,
	type TelnyxClientOptions,
	type TelnyxFetch,
	type TelnyxTransport,
} from "./transport";
export {
	DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
	parseTelnyxPublicKey,
	TELNYX_SIGNATURE_HEADER,
	TELNYX_TIMESTAMP_HEADER,
	telnyxSignedPayload,
	type VerifyWebhookInput,
	verifyTelnyxWebhook,
} from "./webhooks/signature";
export {
	asFaxWebhook,
	asNumberOrderWebhook,
	parseTelnyxWebhookEvent,
	TELNYX_NUMBER_ORDER_EVENT,
	type TelnyxFaxWebhook,
	type TelnyxNumberOrderWebhook,
	type TelnyxWebhookEvent,
} from "./webhooks/events";
