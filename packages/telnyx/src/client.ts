import { type AvailableNumbersResource, makeAvailableNumbers } from "./resources/available-numbers";
import {
	type CredentialConnectionsResource,
	makeCredentialConnections,
} from "./resources/credential-connections";
import { type E911AddressesResource, makeE911Addresses } from "./resources/e911-addresses";
import { type FaxesResource, makeFaxes } from "./resources/faxes";
import { makeMessages, type MessagesResource } from "./resources/messages";
import {
	makeMessagingProfiles,
	type MessagingProfilesResource,
} from "./resources/messaging-profiles";
import { makeNumberOrders, type NumberOrdersResource } from "./resources/number-orders";
import {
	makeOutboundVoiceProfiles,
	type OutboundVoiceProfilesResource,
} from "./resources/outbound-voice-profiles";
import { makePhoneNumbers, type PhoneNumbersResource } from "./resources/phone-numbers";
import { makePortingOrders, type PortingOrdersResource } from "./resources/porting-orders";
import { makeTenDlc, type TenDlcResource } from "./resources/ten-dlc";
import {
	makeTollFreeVerification,
	type TollFreeVerificationResource,
} from "./resources/toll-free-verification";
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
	/**
	 * Porting a number in from another carrier (LNP). Deliberately a sibling of `numberOrders`
	 * rather than a mode of it: buying an unowned number and taking over one a customer already
	 * pays someone else for share a word ("get me this DID") and nothing else — different
	 * endpoint, different lifecycle, different failure modes, and weeks rather than seconds.
	 */
	readonly portingOrders: PortingOrdersResource;
	readonly credentialConnections: CredentialConnectionsResource;
	readonly outboundVoiceProfiles: OutboundVoiceProfilesResource;
	/**
	 * The carrier's address book, and the E911 dispatchable-location validation that runs against
	 * it. A sibling of `phoneNumbers` rather than part of it because an address outlives the DID
	 * that cites it and is validated once, not per number.
	 */
	readonly e911Addresses: E911AddressesResource;
	/** Programmable Fax: send a fax, read one back. Inbound arrives over the `fax.*` webhooks. */
	readonly faxes: FaxesResource;
	/** Programmable Messaging: send an SMS/MMS, read one back. Inbound arrives over `message.*`. */
	readonly messages: MessagesResource;
	/** Where a number's messaging webhooks go, and which DIDs are attached to that profile. */
	readonly messagingProfiles: MessagingProfilesResource;
	/**
	 * Brand and campaign registration with The Campaign Registry. A sibling of `messagingProfiles`
	 * rather than part of it: a profile is Telnyx configuration that takes effect immediately, while
	 * a 10DLC registration is a third-party review that takes days and can be rejected.
	 */
	readonly tenDlc: TenDlcResource;
	/** The toll-free equivalent of `tenDlc` — a different registry, a different contract. */
	readonly tollFreeVerification: TollFreeVerificationResource;
	/** Exposed for logging and for the verification script's "which server am I talking to". */
	readonly baseUrl: string;
}

export function createTelnyxClient(options: TelnyxClientOptions): TelnyxClient {
	const transport = createTelnyxTransport(options);
	return {
		availableNumbers: makeAvailableNumbers(transport),
		numberOrders: makeNumberOrders(transport),
		phoneNumbers: makePhoneNumbers(transport),
		portingOrders: makePortingOrders(transport),
		credentialConnections: makeCredentialConnections(transport),
		outboundVoiceProfiles: makeOutboundVoiceProfiles(transport),
		e911Addresses: makeE911Addresses(transport),
		faxes: makeFaxes(transport),
		messages: makeMessages(transport),
		messagingProfiles: makeMessagingProfiles(transport),
		tenDlc: makeTenDlc(transport),
		tollFreeVerification: makeTollFreeVerification(transport),
		baseUrl: transport.baseUrl,
	};
}
