import { type AvailableNumbersResource, makeAvailableNumbers } from "./resources/available-numbers";
import {
	type CredentialConnectionsResource,
	makeCredentialConnections,
} from "./resources/credential-connections";
import { makeNumberOrders, type NumberOrdersResource } from "./resources/number-orders";
import {
	makeOutboundVoiceProfiles,
	type OutboundVoiceProfilesResource,
} from "./resources/outbound-voice-profiles";
import { makePhoneNumbers, type PhoneNumbersResource } from "./resources/phone-numbers";
import { createTelnyxTransport, type TelnyxClientOptions } from "./transport";

/**
 * `@optimiq-voice/telnyx` — the carrier API, typed, and nothing else.
 *
 * ## What is deliberately absent
 *
 * There is **no domain logic here**. No organization, no trunk, no `phone_number` row, no decision
 * about when a number should be released or what a provisioned trunk should be named. Those are
 * `apps/api`'s, and keeping them out is what makes this package testable against a fake server
 * with no database, and what makes "swap the carrier" a matter of writing a sibling package rather
 * than unpicking business rules from HTTP.
 *
 * The dividing line, concretely: this package knows that ordering a number requires a prior
 * search; it does not know that our platform orders one number at a time, or that the resulting
 * DID belongs to the organization whose session made the request.
 */
export interface TelnyxClient {
	readonly availableNumbers: AvailableNumbersResource;
	readonly numberOrders: NumberOrdersResource;
	readonly phoneNumbers: PhoneNumbersResource;
	readonly credentialConnections: CredentialConnectionsResource;
	readonly outboundVoiceProfiles: OutboundVoiceProfilesResource;
	/** Exposed for logging and for the verification script's "which server am I talking to". */
	readonly baseUrl: string;
}

export function createTelnyxClient(options: TelnyxClientOptions): TelnyxClient {
	const transport = createTelnyxTransport(options);
	return {
		availableNumbers: makeAvailableNumbers(transport),
		numberOrders: makeNumberOrders(transport),
		phoneNumbers: makePhoneNumbers(transport),
		credentialConnections: makeCredentialConnections(transport),
		outboundVoiceProfiles: makeOutboundVoiceProfiles(transport),
		baseUrl: transport.baseUrl,
	};
}
