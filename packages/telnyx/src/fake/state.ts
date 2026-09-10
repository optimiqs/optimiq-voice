import { randomUUID } from "node:crypto";

/**
 * The fake carrier's world model.
 *
 * ## Why a stateful fake and not recorded fixtures
 *
 * A pure fixture server answers every request the same way, which cannot express the two
 * properties this integration actually depends on:
 *
 * 1. **You must search before you order** (Telnyx error `85000`). A fixture server would happily
 *    accept an order for a number never searched, so the one carrier rule our API layer must
 *    respect would be untested — and would first be discovered in production, on a paid call.
 * 2. **A number ordered once cannot be ordered again** (`85001`). Ordering is the operation whose
 *    double-execution costs money, so the fake has to be able to *say no the second time*.
 *
 * So the fake keeps state: an inventory of numbers with an availability flag, a set of numbers
 * this session has searched, and the orders/connections/profiles created. The response BODIES are
 * still fixture-shaped — every field name and enum member comes from `reference/telnyx-api.md` —
 * but the behaviour is a small state machine, which is what makes `verify:carrier` a test of our
 * sequencing rather than of our JSON parsing.
 */

export interface FakeNumberInventoryEntry {
	readonly phoneNumber: string;
	readonly countryCode: string;
	readonly nationalDestinationCode: string;
	readonly phoneNumberType: string;
	available: boolean;
	/** Set once ordered, so the release path has something to look up. */
	ownedId?: string;
	connectionId?: string;
	/** Set by `PATCH …/messaging`. A number without one cannot be put on a 10DLC campaign. */
	messagingProfileId?: string;
	/**
	 * CNAM, kept on the entry rather than regenerated per response.
	 *
	 * The fake persists it because the property under test is precisely that the two halves round
	 * trip through the two DIFFERENT endpoints Telnyx splits them across — `caller_id_name_enabled`
	 * written on `…/voice` and read from the parent, `cnam_listing` written and read on `…/voice`.
	 * A fake that echoed the request would agree with a client that read the wrong endpoint.
	 */
	callerIdNameEnabled?: boolean;
	cnamListingEnabled?: boolean;
	cnamListingDetails?: string;
}

/**
 * A port-in.
 *
 * Separate from {@link FakeOrder} for the reason the resources are separate: a port is not a
 * purchase that completes in a second, it is a weeks-long workflow whose interesting states
 * (`draft`, `exception`) have no analogue in a number order.
 */
export interface FakePortingOrder {
	readonly id: string;
	readonly customerReference: string;
	readonly supportKey: string;
	status:
		| "draft"
		| "in-process"
		| "submitted"
		| "exception"
		| "foc-date-confirmed"
		| "cancel-pending"
		| "ported"
		| "cancelled";
	readonly phoneNumbers: readonly string[];
	readonly createdAt: string;
}

export interface FakeOrder {
	readonly id: string;
	readonly customerReference: string;
	readonly connectionId?: string;
	status: "pending" | "success" | "failure";
	readonly phoneNumbers: readonly string[];
	readonly createdAt: string;
}

export interface FakeConnection {
	readonly id: string;
	connectionName: string;
	userName: string;
	password: string;
	active: boolean;
	anchorsiteOverride: string;
	dtmfType: string;
	webhookApiVersion: string;
	webhookEventUrl?: string;
	outboundVoiceProfileId?: string;
	outboundChannelLimit?: number;
	readonly createdAt: string;
}

export interface FakeFax {
	readonly id: string;
	readonly direction: "inbound" | "outbound";
	status: string;
	readonly connectionId: string;
	readonly to: string;
	readonly from: string;
	readonly mediaUrl?: string;
	readonly mediaName?: string;
	readonly clientState?: string;
	readonly createdAt: string;
}

/**
 * A messaging profile. Kept separately from {@link FakeProfile} (which is the *voice* profile)
 * because they share a word and nothing else — different endpoint, different fields, and a number
 * can be on one without the other.
 */
export interface FakeMessagingProfile {
	readonly id: string;
	name: string;
	enabled: boolean;
	webhookUrl?: string;
	webhookFailoverUrl?: string;
	webhookApiVersion: string;
	whitelistedDestinations: string[];
	readonly createdAt: string;
}

/** A TCR brand. camelCase throughout, like the endpoint it serves — see `resources/ten-dlc.ts`. */
export interface FakeBrand {
	readonly brandId: string;
	entityType: string;
	displayName: string;
	country: string;
	email: string;
	vertical: string;
	identityStatus: string;
	status: string;
	/** The PIN a triggered `smsOtp` "sent". Fixed rather than random so a spec can assert on it. */
	otpPin?: string;
	readonly createdAt: string;
}

export interface FakeCampaign {
	readonly campaignId: string;
	readonly brandId: string;
	usecase: string;
	description: string;
	/** `ACTIVE` is the only value that lets a number be assigned. See `assignPhoneNumber`. */
	status: string;
	readonly createdAt: string;
}

export interface FakePhoneNumberCampaign {
	readonly phoneNumber: string;
	readonly campaignId: string;
	readonly brandId: string;
	assignmentStatus: string;
}

export interface FakeTollFreeVerification {
	readonly id: string;
	businessName: string;
	verificationStatus: string;
	businessRegistrationNumber?: string;
	businessRegistrationType?: string;
	businessRegistrationCountry?: string;
	readonly phoneNumbers: readonly string[];
	readonly createdAt: string;
}

export interface FakeMessage {
	readonly id: string;
	readonly direction: "inbound" | "outbound";
	readonly type: "SMS" | "MMS";
	readonly from: string;
	readonly to: string;
	/** Where the delivery status lives — per recipient, never at the top level. */
	toStatus: string;
	readonly text?: string;
	readonly mediaUrls: readonly string[];
	readonly messagingProfileId?: string;
	readonly clientState?: string;
	readonly createdAt: string;
}

/**
 * An address in the fake carrier's book.
 *
 * Kept because the E911 flow's whole point is that the id survives: the API layer writes it into
 * `emergency_address.validation_reference`, and a fake that minted a fresh id per response would
 * agree with a client that never stored one.
 */
export interface FakeAddress {
	readonly id: string;
	readonly streetAddress: string;
	readonly extendedAddress?: string;
	readonly locality: string;
	readonly administrativeArea: string;
	readonly postalCode: string;
	readonly countryCode: string;
	readonly customerReference?: string;
	readonly createdAt: string;
}

/**
 * What the fake's address validation answers, and with what.
 *
 * Controllable from `state` rather than derived from the address itself, because the property under
 * test is what the API layer DOES with each of the three answers — sets the flag, reports the
 * carrier's reason, offers the correction — and deriving it would make every test that wants an
 * invalid answer first have to know an address the fake considers unreal.
 */
export interface FakeAddressValidation {
	result: "valid" | "invalid" | "suggested";
	/** The carrier's own reason strings, surfaced verbatim when `result` is `invalid`. */
	errors: { code: string; message: string }[];
	/** The canonical form offered when `result` is `suggested`. */
	suggested?: {
		street_address?: string;
		extended_address?: string;
		locality?: string;
		administrative_area?: string;
		postal_code?: string;
		country_code?: string;
	};
}

export interface FakeProfile {
	readonly id: string;
	name: string;
	enabled: boolean;
	concurrentCallLimit?: number;
	whitelistedDestinations: string[];
	dailySpendLimit?: string;
	dailySpendLimitEnabled: boolean;
	connectionsCount: number;
	readonly createdAt: string;
}

/**
 * A canned inventory, generated rather than hand-listed so a test can ask for a hundred numbers in
 * one area code without a hundred lines of fixture.
 *
 * The numbers are all in the +1-555 range, which is reserved for fiction in the NANP — a fixture
 * that used a real, orderable number would be a copy-paste away from someone pointing this client
 * at the live API and buying it.
 */
export function defaultInventory(): FakeNumberInventoryEntry[] {
	const entries: FakeNumberInventoryEntry[] = [];
	for (const [ndc, country] of [
		["212", "US"],
		["415", "US"],
		["416", "CA"],
	] as const) {
		for (let index = 0; index < 12; index += 1) {
			entries.push({
				phoneNumber: `+1${ndc}555${String(1000 + index).padStart(4, "0")}`,
				countryCode: country,
				nationalDestinationCode: ndc,
				phoneNumberType: "local",
				available: true,
			});
		}
	}
	return entries;
}

export class FakeTelnyxState {
	readonly inventory: FakeNumberInventoryEntry[];
	/** Numbers returned by a search on this instance. The `85000` gate reads this. */
	readonly searched = new Set<string>();
	readonly orders = new Map<string, FakeOrder>();
	readonly portingOrders = new Map<string, FakePortingOrder>();
	readonly connections = new Map<string, FakeConnection>();
	readonly profiles = new Map<string, FakeProfile>();
	readonly faxes = new Map<string, FakeFax>();
	readonly messagingProfiles = new Map<string, FakeMessagingProfile>();
	readonly brands = new Map<string, FakeBrand>();
	readonly campaigns = new Map<string, FakeCampaign>();
	/** Keyed by E.164, because that is the key the carrier's own endpoint uses. */
	readonly phoneNumberCampaigns = new Map<string, FakePhoneNumberCampaign>();
	readonly tollFreeVerifications = new Map<string, FakeTollFreeVerification>();
	readonly messages = new Map<string, FakeMessage>();
	readonly addresses = new Map<string, FakeAddress>();
	/**
	 * The answer `POST /addresses/actions/validate` gives, and the gate `POST /addresses` applies
	 * when the request carries `validate_address: true`.
	 *
	 * Defaults to `valid`, so a test that is about something else does not have to say so; a test
	 * about refusal sets `result` and the reason it wants read back.
	 */
	addressValidation: FakeAddressValidation = { result: "valid", errors: [] };
	/**
	 * Turns off the "a US local number must be on an ACTIVE campaign to send" gate.
	 *
	 * The gate is the whole reason the 10DLC surface exists, so it is on by default and a spec that
	 * is about something else (retry behaviour, request shape) opts out here rather than by
	 * registering a brand it does not care about.
	 */
	allowUnregisteredSend = false;
	/** Every request the fake saw, so a spec can assert headers and bodies after the fact. */
	readonly requests: {
		method: string;
		path: string;
		headers: Record<string, string>;
		body: unknown;
	}[] = [];

	/**
	 * Statuses to return before behaving normally, consumed one per request.
	 *
	 * This is how the retry spec drives "429, 429, then 200" without a real rate limiter, and it is
	 * a queue rather than a flag so a test can describe an exact failure sequence.
	 */
	readonly failureQueue: { status: number; code?: string; retryAfterSeconds?: number }[] = [];

	constructor(inventory: FakeNumberInventoryEntry[] = defaultInventory()) {
		this.inventory = inventory;
	}

	newId(): string {
		return randomUUID();
	}

	now(): string {
		return new Date().toISOString();
	}

	find(phoneNumber: string): FakeNumberInventoryEntry | undefined {
		return this.inventory.find((entry) => entry.phoneNumber === phoneNumber);
	}

	findOwned(numberId: string): FakeNumberInventoryEntry | undefined {
		return this.inventory.find((entry) => entry.ownedId === numberId);
	}

	/** Queues one synthetic failure. Returns `this` so a test reads as a sentence. */
	failNext(status: number, options: { code?: string; retryAfterSeconds?: number } = {}): this {
		this.failureQueue.push({
			status,
			...(options.code === undefined ? {} : { code: options.code }),
			...(options.retryAfterSeconds === undefined
				? {}
				: { retryAfterSeconds: options.retryAfterSeconds }),
		});
		return this;
	}

	reset(): void {
		this.searched.clear();
		this.orders.clear();
		this.portingOrders.clear();
		this.connections.clear();
		this.profiles.clear();
		this.faxes.clear();
		this.messagingProfiles.clear();
		this.brands.clear();
		this.campaigns.clear();
		this.phoneNumberCampaigns.clear();
		this.tollFreeVerifications.clear();
		this.messages.clear();
		this.addresses.clear();
		this.addressValidation = { result: "valid", errors: [] };
		this.allowUnregisteredSend = false;
		this.requests.length = 0;
		this.failureQueue.length = 0;
		for (const entry of this.inventory) {
			entry.available = true;
			delete entry.ownedId;
			delete entry.connectionId;
			delete entry.messagingProfileId;
			delete entry.callerIdNameEnabled;
			delete entry.cnamListingEnabled;
			delete entry.cnamListingDetails;
		}
	}
}
