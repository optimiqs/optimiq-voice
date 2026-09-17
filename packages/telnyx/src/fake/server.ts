import { createServer, type Server } from "node:http";
import {
	type FakeAddress,
	type FakeBrand,
	type FakeCampaign,
	type FakeConnection,
	type FakeFax,
	type FakeMessage,
	type FakeMessagingProfile,
	type FakeNumberInventoryEntry,
	type FakeOrder,
	type FakePhoneNumberCampaign,
	type FakePortingOrder,
	type FakeProfile,
	FakeTelnyxState,
	type FakeTollFreeVerification,
} from "./state";
import type { AddressInfo } from "node:net";

/**
 * A fake Telnyx, over plain `node:http`.
 *
 * ## Why this exists, and why it is shipped rather than kept in a test folder
 *
 * Nobody working on this repository has a Telnyx API key, and the operations that matter — order a
 * number, release a number, create a connection — are irreversible and billable. A test suite that
 * needs a real key is a test suite that does not run, which means the number-ordering path would
 * ship having never been executed end to end.
 *
 * So the fake is a first-class artifact exported at `@optimiq-voice/telnyx/fake`: the client's own
 * unit tests use it, and so does `apps/api`'s `verify:carrier`, which boots the real API against
 * it via `TELNYX_API_BASE`. One implementation, two consumers, and any drift between "what the
 * client expects" and "what the API integration expects" shows up as a failing test in one of
 * them.
 *
 * ## What it is faithful about, and what it is not
 *
 * Faithful: every field name, every enum member, every status code, and the two behavioural rules
 * that carry money — search-before-order (`85000`) and no-double-order (`85001`). Also the shapes
 * that are easy to mis-remember and would otherwise be "tested" against my own mistake:
 * `features` as objects, costs as strings, `POST /number_orders` returning 200 while
 * `POST /credential_connections` returns 201, `DELETE /phone_numbers/{id}` returning a body.
 *
 * Also faithful about the two porting shapes that are easy to assume wrong: `POST /porting_orders`
 * answering with a **list** because Telnyx splits a request across losing carriers, and CNAM's two
 * halves living on two different endpoints — the `caller_id_name_enabled` written on `…/voice` is
 * read back from the parent number and NOT from the voice GET.
 *
 * Not faithful: rate limits (driven by an explicit queue instead), regulatory requirements, the
 * porting DOCUMENT workflow (LOAs, end-user detail, drafts), and the several hundred
 * endpoints this platform does not call.
 *
 * Messaging IS modelled, and for the same "rule that carries money" reason: a US local number may
 * not send until it is on a messaging profile AND assigned to an ACTIVE 10DLC campaign, and a
 * campaign under an unverified brand never reaches ACTIVE. Those three refusals are the whole
 * point of the 10DLC surface, so the fake says no to each of them; `state.allowUnregisteredSend`
 * opts a spec out when it is testing something else. A fake that tried to be complete would be a second
 * implementation to maintain and would still be wrong.
 *
 * It is deliberately NOT authenticated beyond "there must be a bearer token" — asserting the exact
 * key would test that we can pass a string to ourselves.
 */

export interface FakeTelnyxServer {
	/** `http://127.0.0.1:<port>/v2` — hand this to `TELNYX_API_BASE`. */
	readonly baseUrl: string;
	readonly port: number;
	readonly state: FakeTelnyxState;
	readonly close: () => Promise<void>;
}

interface ParsedRequest {
	readonly method: string;
	/** Path below `/v2`, no query. */
	readonly path: string;
	readonly query: URLSearchParams;
	readonly headers: Record<string, string>;
	readonly body: Record<string, unknown>;
}

function errorBody(code: string, title: string, detail?: string) {
	return {
		errors: [
			{
				code,
				title,
				...(detail === undefined ? {} : { detail }),
				meta: { url: `https://developers.telnyx.com/docs/overview/errors/${code}` },
			},
		],
	};
}

function availableNumberBody(entry: FakeNumberInventoryEntry) {
	return {
		record_type: "available_phone_number",
		phone_number: entry.phoneNumber,
		vanity_format: "",
		best_effort: false,
		quickship: false,
		reservable: true,
		region_information: [
			{ region_type: "country_code", region_name: entry.countryCode },
			{ region_type: "rate_center", region_name: "FAKEVILLE" },
		],
		// Strings, not numbers. See reference/telnyx-api.md §Number search.
		cost_information: { upfront_cost: "1.00", monthly_cost: "1.00", currency: "USD" },
		// Objects, not strings.
		features: [{ name: "voice" }, { name: "sms" }, { name: "emergency" }],
	};
}

function orderBody(order: FakeOrder, state: FakeTelnyxState) {
	return {
		id: order.id,
		record_type: "number_order",
		status: order.status,
		phone_numbers_count: order.phoneNumbers.length,
		connection_id: order.connectionId ?? null,
		messaging_profile_id: null,
		billing_group_id: null,
		customer_reference: order.customerReference,
		requirements_met: true,
		sub_number_orders_ids: [],
		created_at: order.createdAt,
		updated_at: order.createdAt,
		phone_numbers: order.phoneNumbers.map((phoneNumber) => {
			const entry = state.find(phoneNumber);
			return {
				id: entry?.ownedId ?? state.newId(),
				record_type: "number_order_phone_number",
				phone_number: phoneNumber,
				status: order.status,
				requirements_met: true,
				requirements_status: "approved",
				country_code: "1",
				country_iso_alpha2: entry?.countryCode ?? "US",
				phone_number_type: entry?.phoneNumberType ?? "local",
				bundle_id: null,
				regulatory_requirements: [],
			};
		}),
	};
}

/** The first required postal field this body is missing, or `undefined` when it is complete. */
function missingAddressField(body: Record<string, unknown>): string | undefined {
	for (const field of [
		"street_address",
		"locality",
		"administrative_area",
		"postal_code",
		"country_code",
	]) {
		const value = body[field];
		if (typeof value !== "string" || value.length === 0) {
			return field;
		}
	}
	return undefined;
}

function addressBody(address: FakeAddress) {
	return {
		id: address.id,
		record_type: "address",
		street_address: address.streetAddress,
		extended_address: address.extendedAddress ?? null,
		locality: address.locality,
		administrative_area: address.administrativeArea,
		postal_code: address.postalCode,
		country_code: address.countryCode,
		customer_reference: address.customerReference ?? null,
		address_book: true,
		created_at: address.createdAt,
		updated_at: address.createdAt,
	};
}

function addressValidationBody(state: FakeTelnyxState) {
	const answer = state.addressValidation;
	return {
		record_type: "address_validation",
		result: answer.result,
		suggested: answer.suggested ?? null,
		errors: answer.errors.map((entry) => ({ code: entry.code, message: entry.message })),
	};
}

function phoneNumberBody(entry: FakeNumberInventoryEntry, status = "active") {
	return {
		id: entry.ownedId,
		record_type: "phone_number",
		phone_number: entry.phoneNumber,
		status,
		connection_id: entry.connectionId ?? null,
		connection_name: entry.connectionId === undefined ? null : "fake-connection",
		customer_reference: null,
		messaging_profile_id: null,
		billing_group_id: null,
		emergency_enabled: false,
		emergency_address_id: null,
		call_forwarding_enabled: false,
		cnam_listing_enabled: entry.cnamListingEnabled ?? false,
		caller_id_name_enabled: entry.callerIdNameEnabled ?? false,
		call_recording_enabled: false,
		t38_fax_gateway_enabled: false,
		phone_number_type: entry.phoneNumberType,
		tags: [],
		external_pin: null,
		purchased_at: new Date().toISOString(),
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
}

function voiceSettingsBody(entry: FakeNumberInventoryEntry) {
	return {
		id: entry.ownedId,
		record_type: "voice_settings",
		phone_number: entry.phoneNumber,
		connection_id: entry.connectionId ?? null,
		customer_reference: null,
		tech_prefix_enabled: false,
		translated_number: "",
		usage_payment_method: "pay-per-minute",
		inbound_call_screening: "disabled",
		call_forwarding: {
			call_forwarding_enabled: false,
			forwards_to: "",
			forwarding_type: "always",
		},
		cnam_listing: {
			cnam_listing_enabled: entry.cnamListingEnabled ?? false,
			cnam_listing_details: entry.cnamListingDetails ?? "",
		},
		emergency: {
			emergency_enabled: false,
			emergency_address_id: "",
			emergency_status: "disabled",
		},
		media_features: {
			rtp_auto_adjust_enabled: true,
			accept_any_rtp_packets_enabled: false,
			t38_fax_gateway_enabled: false,
		},
		call_recording: {
			inbound_call_recording_enabled: false,
			inbound_call_recording_format: "wav",
			inbound_call_recording_channels: "single",
		},
		// caller_id_name_enabled is deliberately absent: the real GET does not return it.
	};
}

function connectionBody(connection: FakeConnection) {
	return {
		id: connection.id,
		record_type: "credential_connection",
		connection_name: connection.connectionName,
		user_name: connection.userName,
		password: connection.password,
		active: connection.active,
		anchorsite_override: connection.anchorsiteOverride,
		dtmf_type: connection.dtmfType,
		encrypted_media: null,
		encode_contact_header_enabled: false,
		default_on_hold_comfort_noise_enabled: true,
		onnet_t38_passthrough_enabled: false,
		sip_uri_calling_preference: "disabled",
		webhook_event_url: connection.webhookEventUrl ?? null,
		webhook_event_failover_url: null,
		webhook_api_version: connection.webhookApiVersion,
		webhook_timeout_secs: null,
		tags: [],
		rtcp_settings: { port: "rtcp-mux", capture_enabled: false, report_frequency_secs: 5 },
		inbound: { ani_number_format: "E.164-national", dnis_number_format: "e164" },
		outbound: {
			outbound_voice_profile_id: connection.outboundVoiceProfileId ?? null,
			channel_limit: connection.outboundChannelLimit ?? null,
			ani_override: null,
			ani_override_type: "always",
			localization: "US",
		},
		created_at: connection.createdAt,
		updated_at: connection.createdAt,
	};
}

function profileBody(profile: FakeProfile) {
	return {
		id: profile.id,
		record_type: "outbound_voice_profile",
		name: profile.name,
		connections_count: profile.connectionsCount,
		traffic_type: "conversational",
		service_plan: "global",
		concurrent_call_limit: profile.concurrentCallLimit ?? null,
		enabled: profile.enabled,
		tags: [],
		usage_payment_method: "rate-deck",
		whitelisted_destinations: profile.whitelistedDestinations,
		max_destination_rate: null,
		daily_spend_limit: profile.dailySpendLimit ?? null,
		daily_spend_limit_enabled: profile.dailySpendLimitEnabled,
		call_recording: {
			call_recording_type: "none",
			call_recording_caller_phone_numbers: [],
			call_recording_channels: "single",
			call_recording_format: "wav",
		},
		billing_group_id: null,
		created_at: profile.createdAt,
		updated_at: profile.createdAt,
	};
}

function faxBody(fax: FakeFax) {
	return {
		id: fax.id,
		record_type: "fax",
		direction: fax.direction,
		status: fax.status,
		connection_id: fax.connectionId,
		from: fax.from,
		to: fax.to,
		from_display_name: null,
		quality: "normal",
		media_url: fax.mediaUrl ?? null,
		media_name: fax.mediaName ?? null,
		// Telnyx echoes the source document back under original_media_url; store_media is off by
		// default, so stored_media_url stays null until a delivered webhook fills it.
		original_media_url: fax.mediaUrl ?? null,
		stored_media_url: null,
		page_count: null,
		store_media: false,
		t38_enabled: true,
		monochrome: false,
		webhook_url: null,
		client_state: fax.clientState ?? null,
		failure_reason: null,
		call_duration_secs: null,
		created_at: fax.createdAt,
		updated_at: fax.createdAt,
	};
}

function portingOrderBody(order: FakePortingOrder) {
	return {
		id: order.id,
		record_type: "porting_order",
		status: order.status,
		customer_reference: order.customerReference,
		support_key: order.supportKey,
		phone_numbers_count: order.phoneNumbers.length,
		activation_settings: {
			foc_datetime_requested: null,
			foc_datetime_actual: null,
			fast_port_eligible: false,
		},
		misc: { type: "full", remaining_numbers_action: "keep" },
		created_at: order.createdAt,
		updated_at: order.createdAt,
		phone_numbers: order.phoneNumbers.map((phoneNumber) => ({
			id: randomIshId(phoneNumber),
			record_type: "porting_phone_number",
			phone_number: phoneNumber,
			porting_order_status: order.status,
			activation_status: "New",
			phone_number_type: "landline",
			portability_status: "confirmed",
		})),
	};
}

/** A stable per-number id, so two reads of one order do not disagree about it. */
function randomIshId(phoneNumber: string): string {
	return `pn-${phoneNumber.replace(/[^0-9]/gu, "")}`;
}

/** The path of the toll-free verification collection — snake_case, unlike its camelCase body. */
const TOLL_FREE_PATH = "/messaging_tollfree/verification/requests";

/** The PIN a triggered brand OTP always "sends". Fixed so a spec can complete the round trip. */
export const FAKE_BRAND_OTP_PIN = "123456";

/** North American toll-free NPAs, which are verified by aggregator rather than registered with TCR. */
const TOLL_FREE_NPAS = new Set(["800", "833", "844", "855", "866", "877", "888"]);

/**
 * Whether a number is a US/Canada **local** (10-digit long code) number — the only kind the 10DLC
 * gate applies to. Toll-free and non-NANP numbers take other compliance paths entirely.
 */
function isUsLocalNumber(phoneNumber: string): boolean {
	if (!/^\+1[0-9]{10}$/u.test(phoneNumber)) {
		return false;
	}
	return !TOLL_FREE_NPAS.has(phoneNumber.slice(2, 5));
}

function messagingProfileBody(profile: FakeMessagingProfile) {
	return {
		id: profile.id,
		record_type: "messaging_profile",
		name: profile.name,
		enabled: profile.enabled,
		webhook_url: profile.webhookUrl ?? null,
		webhook_failover_url: profile.webhookFailoverUrl ?? null,
		webhook_api_version: profile.webhookApiVersion,
		whitelisted_destinations: profile.whitelistedDestinations,
		number_pool_settings: null,
		url_shortener_settings: null,
		alpha_sender: null,
		daily_spend_limit: null,
		daily_spend_limit_enabled: false,
		mms_fall_back_to_sms: false,
		mms_transcoding: false,
		v1_secret: null,
		created_at: profile.createdAt,
		updated_at: profile.createdAt,
	};
}

function numberMessagingBody(entry: FakeNumberInventoryEntry) {
	return {
		id: entry.ownedId,
		record_type: "messaging_settings",
		phone_number: entry.phoneNumber,
		messaging_profile_id: entry.messagingProfileId ?? null,
		messaging_product: entry.messagingProfileId === undefined ? null : "P2P",
		eligible_messaging_products: ["P2P", "A2P"],
		features: { sms: { domestic_two_way: true }, mms: null },
		type: entry.phoneNumberType,
		country_code: entry.countryCode,
		traffic_type: "A2P",
		health: null,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
}

function messageBody(message: FakeMessage) {
	return {
		id: message.id,
		record_type: "message",
		direction: message.direction,
		type: message.type,
		// A string on an outbound message and an OBJECT on an inbound one. The client normalises
		// both with `messageFromE164`; a fake that always sent a string would agree with a client
		// that never handled the object.
		from:
			message.direction === "outbound"
				? message.from
				: { phone_number: message.from, carrier: "FakeCarrier", line_type: "Wireless" },
		// The delivery status is HERE, per recipient, and nowhere else. There is deliberately no
		// top-level `status` key on this body.
		to: [
			{
				phone_number: message.to,
				status: message.toStatus,
				carrier: "FakeCarrier",
				line_type: "Wireless",
			},
		],
		text: message.text ?? null,
		media: message.mediaUrls.map((url) => ({
			url,
			content_type: "image/jpeg",
			sha256: null,
			size: null,
		})),
		parts: 1,
		encoding: "GSM-7",
		cost: null,
		errors: [],
		messaging_profile_id: message.messagingProfileId ?? null,
		organization_id: "fake-org",
		received_at: message.createdAt,
		sent_at: null,
		completed_at: null,
		valid_until: null,
		webhook_url: null,
		client_state: message.clientState ?? null,
		tags: [],
	};
}

function brandBody(brand: FakeBrand) {
	return {
		brandId: brand.brandId,
		entityType: brand.entityType,
		displayName: brand.displayName,
		companyName: brand.displayName,
		identityStatus: brand.identityStatus,
		brandRelationship: "BASIC_ACCOUNT",
		vertical: brand.vertical,
		status: brand.status,
		failureReasons: null,
		cspId: "fake-csp",
		country: brand.country,
		email: brand.email,
		website: null,
		phone: null,
		street: null,
		city: null,
		state: null,
		postalCode: null,
		mock: true,
	};
}

function campaignBody(campaign: FakeCampaign) {
	return {
		campaignId: campaign.campaignId,
		brandId: campaign.brandId,
		status: campaign.status,
		campaignStatus: campaign.status,
		usecase: campaign.usecase,
		description: campaign.description,
		sample1: "Your appointment is confirmed.",
		messageFlow: "Users opt in on the web form.",
		helpMessage: "Reply STOP to unsubscribe.",
		optinKeywords: "START",
		optoutKeywords: "STOP",
		helpKeywords: "HELP",
		mnoMetadata: {},
		tcrCampaignId: `C${campaign.campaignId.slice(0, 6).toUpperCase()}`,
		failureReasons: null,
		createdAt: campaign.createdAt,
	};
}

function phoneNumberCampaignBody(assignment: FakePhoneNumberCampaign) {
	return {
		phoneNumber: assignment.phoneNumber,
		campaignId: assignment.campaignId,
		brandId: assignment.brandId,
		tcrCampaignId: `C${assignment.campaignId.slice(0, 6).toUpperCase()}`,
		assignmentStatus: assignment.assignmentStatus,
	};
}

function tollFreeBody(verification: FakeTollFreeVerification) {
	return {
		id: verification.id,
		verificationRequestId: verification.id,
		verificationStatus: verification.verificationStatus,
		businessName: verification.businessName,
		phoneNumbers: verification.phoneNumbers.map((phoneNumber) => ({ phoneNumber })),
		businessRegistrationNumber: verification.businessRegistrationNumber ?? null,
		businessRegistrationType: verification.businessRegistrationType ?? null,
		businessRegistrationCountry: verification.businessRegistrationCountry ?? null,
		entityType: "PRIVATE_PROFIT",
		reason: null,
		rejectionReason: null,
		createdAt: verification.createdAt,
		updatedAt: verification.createdAt,
	};
}

interface Reply {
	readonly status: number;
	readonly body: unknown;
	readonly headers?: Record<string, string>;
}

function route(request: ParsedRequest, state: FakeTelnyxState): Reply {
	const { method, path, query, body } = request;

	// ---- search ----------------------------------------------------------------------------
	if (method === "GET" && path === "/available_phone_numbers") {
		const country = query.get("filter[country_code]");
		const ndc = query.get("filter[national_destination_code]");
		const contains = query.get("filter[phone_number][contains]");
		const type = query.get("filter[phone_number_type]");
		const limit = Number(query.get("filter[limit]") ?? "10");

		const matches = state.inventory
			.filter((entry) => entry.available)
			.filter((entry) => country === null || entry.countryCode === country)
			.filter((entry) => ndc === null || entry.nationalDestinationCode === ndc)
			.filter((entry) => contains === null || entry.phoneNumber.includes(contains))
			.filter((entry) => type === null || entry.phoneNumberType === type)
			.slice(0, Number.isFinite(limit) && limit > 0 ? limit : 10);

		for (const entry of matches) {
			// This is the `85000` gate: only a number returned by a search may be ordered.
			state.searched.add(entry.phoneNumber);
		}

		return {
			status: 200,
			body: {
				data: matches.map(availableNumberBody),
				meta: { total_results: matches.length, best_effort_results: 0 },
				metadata: { total_results: matches.length, best_effort_results: 0 },
			},
		};
	}

	// ---- number orders ---------------------------------------------------------------------
	if (method === "POST" && path === "/number_orders") {
		const requested = Array.isArray(body.phone_numbers)
			? (body.phone_numbers as { phone_number?: string }[]).map((item) => item.phone_number ?? "")
			: [];
		if (requested.length === 0) {
			return { status: 422, body: errorBody("10027", "Unprocessable Entity", "phone_numbers") };
		}
		for (const phoneNumber of requested) {
			if (!state.searched.has(phoneNumber)) {
				return {
					status: 422,
					body: errorBody(
						"85000",
						"Must search phone number via search API first",
						`${phoneNumber} was never returned by /available_phone_numbers`,
					),
				};
			}
			const entry = state.find(phoneNumber);
			if (entry === undefined || !entry.available) {
				return {
					status: 422,
					body: errorBody("85001", "Phone numbers not available", phoneNumber),
				};
			}
		}
		const connectionId = typeof body.connection_id === "string" ? body.connection_id : undefined;
		if (connectionId !== undefined && !state.connections.has(connectionId)) {
			return { status: 422, body: errorBody("85004", "Invalid connection id provided") };
		}

		const order: FakeOrder = {
			id: state.newId(),
			customerReference: typeof body.customer_reference === "string" ? body.customer_reference : "",
			...(connectionId === undefined ? {} : { connectionId }),
			// `success` immediately: the async path is exercised by the webhook tests, and a fake that
			// left every order pending would make every happy-path test poll.
			status: "success",
			phoneNumbers: requested,
			createdAt: state.now(),
		};
		for (const phoneNumber of requested) {
			const entry = state.find(phoneNumber);
			if (entry !== undefined) {
				entry.available = false;
				entry.ownedId = state.newId();
				if (connectionId !== undefined) {
					entry.connectionId = connectionId;
				}
			}
		}
		state.orders.set(order.id, order);
		// 200, not 201. The real API does this and a client that assumed 201 would still work, but a
		// client that asserted it would not.
		return { status: 200, body: { data: orderBody(order, state) } };
	}

	if (method === "GET" && path === "/number_orders") {
		const reference = query.get("filter[customer_reference]");
		const matches = [...state.orders.values()].filter(
			(order) => reference === null || order.customerReference === reference,
		);
		return {
			status: 200,
			body: {
				data: matches.map((order) => orderBody(order, state)),
				meta: { total_results: matches.length, page_number: 1, page_size: 20, total_pages: 1 },
			},
		};
	}

	const orderMatch = /^\/number_orders\/([^/]+)$/u.exec(path);
	if (method === "GET" && orderMatch) {
		const order = state.orders.get(decodeURIComponent(orderMatch[1] ?? ""));
		if (order === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		return { status: 200, body: { data: orderBody(order, state) } };
	}

	// ---- porting orders --------------------------------------------------------------------
	if (method === "POST" && path === "/porting_orders") {
		const requested = Array.isArray(body.phone_numbers)
			? (body.phone_numbers as unknown[]).filter(
					(value): value is string => typeof value === "string",
				)
			: [];
		if (requested.length === 0) {
			return { status: 422, body: errorBody("10027", "Unprocessable Entity", "phone_numbers") };
		}
		const customerReference =
			typeof body.customer_reference === "string" ? body.customer_reference : "";

		/**
		 * The split. Telnyx files one order per losing carrier, and the fake stands in for that by
		 * splitting on country code — enough to make the list-shaped response REAL rather than a
		 * one-element array a client could get away with mis-modelling as a single object.
		 */
		const groups = new Map<string, string[]>();
		for (const phoneNumber of requested) {
			const key = phoneNumber.slice(0, 2);
			groups.set(key, [...(groups.get(key) ?? []), phoneNumber]);
		}
		const created: FakePortingOrder[] = [];
		for (const numbers of groups.values()) {
			const order: FakePortingOrder = {
				id: state.newId(),
				customerReference,
				supportKey: `sk-${state.newId().slice(0, 8)}`,
				// Telnyx files a port as a draft: it is not with the losing carrier until the documents
				// are in. A fake that answered "in-process" would hide the one state a UI must surface.
				status: "draft",
				phoneNumbers: numbers,
				createdAt: state.now(),
			};
			state.portingOrders.set(order.id, order);
			created.push(order);
		}
		// 200, and a LIST envelope — see resources/porting-orders.ts.
		return {
			status: 200,
			body: {
				data: created.map(portingOrderBody),
				meta: { total_results: created.length, page_number: 1, page_size: 20, total_pages: 1 },
			},
		};
	}

	if (method === "GET" && path === "/porting_orders") {
		const status = query.get("filter[status]");
		const reference = query.get("filter[customer_reference]");
		const matches = [...state.portingOrders.values()].filter(
			(order) =>
				(status === null || order.status === status) &&
				(reference === null || order.customerReference === reference),
		);
		return {
			status: 200,
			body: {
				data: matches.map(portingOrderBody),
				meta: { total_results: matches.length, page_number: 1, page_size: 20, total_pages: 1 },
			},
		};
	}

	const portingMatch = /^\/porting_orders\/([^/]+)$/u.exec(path);
	if (method === "GET" && portingMatch) {
		const order = state.portingOrders.get(decodeURIComponent(portingMatch[1] ?? ""));
		if (order === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		return { status: 200, body: { data: portingOrderBody(order) } };
	}

	// ---- phone numbers ---------------------------------------------------------------------
	if (method === "GET" && path === "/phone_numbers") {
		const filter = query.get("filter[phone_number]");
		const owned = state.inventory.filter(
			(entry) =>
				entry.ownedId !== undefined && (filter === null || entry.phoneNumber.includes(filter)),
		);
		return {
			status: 200,
			body: {
				data: owned.map((entry) => phoneNumberBody(entry)),
				meta: { total_results: owned.length, page_number: 1, page_size: 20, total_pages: 1 },
			},
		};
	}

	const voiceMatch = /^\/phone_numbers\/([^/]+)\/voice$/u.exec(path);
	if (voiceMatch && (method === "GET" || method === "PATCH")) {
		const entry = state.findOwned(decodeURIComponent(voiceMatch[1] ?? ""));
		if (entry === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		if (method === "PATCH") {
			// Write-only here: accepted on the PATCH, stored on the number, and deliberately NOT
			// echoed by voiceSettingsBody. A client that reads it back from this response is reading a
			// field the real API does not send.
			if (typeof body.caller_id_name_enabled === "boolean") {
				entry.callerIdNameEnabled = body.caller_id_name_enabled;
			}
			const cnam = body.cnam_listing;
			if (typeof cnam === "object" && cnam !== null) {
				const group = cnam as Record<string, unknown>;
				if (typeof group.cnam_listing_enabled === "boolean") {
					entry.cnamListingEnabled = group.cnam_listing_enabled;
				}
				if (typeof group.cnam_listing_details === "string") {
					if (group.cnam_listing_details.length > 15) {
						return {
							status: 422,
							body: errorBody("10027", "Unprocessable Entity", "cnam_listing_details"),
						};
					}
					entry.cnamListingDetails = group.cnam_listing_details;
				}
			}
		}
		return { status: 200, body: { data: voiceSettingsBody(entry) } };
	}

	const numberMatch = /^\/phone_numbers\/([^/]+)$/u.exec(path);
	if (numberMatch) {
		const numberId = decodeURIComponent(numberMatch[1] ?? "");
		const entry = state.findOwned(numberId);
		if (entry === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		if (method === "GET") {
			return { status: 200, body: { data: phoneNumberBody(entry) } };
		}
		if (method === "PATCH") {
			if (typeof body.connection_id === "string") {
				if (!state.connections.has(body.connection_id)) {
					return { status: 422, body: errorBody("85004", "Invalid connection id provided") };
				}
				entry.connectionId = body.connection_id;
			}
			return { status: 200, body: { data: phoneNumberBody(entry) } };
		}
		if (method === "DELETE") {
			// The release. 200 with the record — not 204 — and the number returns to the inventory so a
			// verification run can order it again on the next pass.
			const released = phoneNumberBody(entry, "deleted");
			entry.available = true;
			delete entry.ownedId;
			delete entry.connectionId;
			state.searched.delete(entry.phoneNumber);
			return { status: 200, body: { data: released } };
		}
	}

	// ---- credential connections ------------------------------------------------------------
	if (method === "POST" && path === "/credential_connections") {
		const userName = typeof body.user_name === "string" ? body.user_name : "";
		const password = typeof body.password === "string" ? body.password : "";
		if (!/^[A-Za-z0-9]{4,32}$/u.test(userName) || !/[A-Za-z]/u.test(userName.slice(0, 5))) {
			return { status: 422, body: errorBody("10027", "Unprocessable Entity", "user_name") };
		}
		if (password.length < 8 || password.length > 128) {
			return { status: 422, body: errorBody("10027", "Unprocessable Entity", "password") };
		}
		for (const existing of state.connections.values()) {
			if (existing.userName === userName) {
				return {
					status: 422,
					body: errorBody("10027", "Unprocessable Entity", "user_name is already taken"),
				};
			}
		}
		const outbound = (body.outbound ?? {}) as Record<string, unknown>;
		const connection: FakeConnection = {
			id: state.newId(),
			connectionName: typeof body.connection_name === "string" ? body.connection_name : "",
			userName,
			password,
			active: body.active !== false,
			anchorsiteOverride:
				typeof body.anchorsite_override === "string" ? body.anchorsite_override : "Latency",
			dtmfType: typeof body.dtmf_type === "string" ? body.dtmf_type : "RFC 2833",
			webhookApiVersion:
				typeof body.webhook_api_version === "string" ? body.webhook_api_version : "1",
			...(typeof body.webhook_event_url === "string"
				? { webhookEventUrl: body.webhook_event_url }
				: {}),
			...(typeof outbound.outbound_voice_profile_id === "string"
				? { outboundVoiceProfileId: outbound.outbound_voice_profile_id }
				: {}),
			...(typeof outbound.channel_limit === "number"
				? { outboundChannelLimit: outbound.channel_limit }
				: {}),
			createdAt: state.now(),
		};
		state.connections.set(connection.id, connection);
		if (connection.outboundVoiceProfileId !== undefined) {
			const profile = state.profiles.get(connection.outboundVoiceProfileId);
			if (profile !== undefined) {
				profile.connectionsCount += 1;
			}
		}
		// 201 — the only endpoint in this surface that does not answer 200.
		return { status: 201, body: { data: connectionBody(connection) } };
	}

	const connectionRegistration =
		/^\/credential_connections\/([^/]+)\/actions\/check_registration_status$/u.exec(path);
	if (method === "POST" && connectionRegistration) {
		const connection = state.connections.get(decodeURIComponent(connectionRegistration[1] ?? ""));
		if (connection === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		return {
			status: 200,
			body: {
				data: {
					record_type: "connection_registration_status",
					status: "Not Registered",
					sip_username: connection.userName,
					ip_address: null,
					transport: null,
					port: null,
					user_agent: null,
					last_registration: null,
				},
			},
		};
	}

	const connectionMatch = /^\/credential_connections\/([^/]+)$/u.exec(path);
	if (connectionMatch) {
		const connectionId = decodeURIComponent(connectionMatch[1] ?? "");
		const connection = state.connections.get(connectionId);
		if (connection === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		if (method === "GET") {
			return { status: 200, body: { data: connectionBody(connection) } };
		}
		if (method === "PATCH") {
			if (typeof body.connection_name === "string") {
				connection.connectionName = body.connection_name;
			}
			if (typeof body.password === "string") {
				connection.password = body.password;
			}
			if (typeof body.active === "boolean") {
				connection.active = body.active;
			}
			const outbound = (body.outbound ?? {}) as Record<string, unknown>;
			if (typeof outbound.outbound_voice_profile_id === "string") {
				connection.outboundVoiceProfileId = outbound.outbound_voice_profile_id;
			}
			return { status: 200, body: { data: connectionBody(connection) } };
		}
		if (method === "DELETE") {
			state.connections.delete(connectionId);
			return { status: 200, body: { data: connectionBody(connection) } };
		}
	}

	// ---- outbound voice profiles -----------------------------------------------------------
	if (method === "POST" && path === "/outbound_voice_profiles") {
		const name = typeof body.name === "string" ? body.name : "";
		if (name.length < 3) {
			return { status: 422, body: errorBody("10027", "Unprocessable Entity", "name") };
		}
		const profile: FakeProfile = {
			id: state.newId(),
			name,
			enabled: body.enabled !== false,
			...(typeof body.concurrent_call_limit === "number"
				? { concurrentCallLimit: body.concurrent_call_limit }
				: {}),
			whitelistedDestinations: Array.isArray(body.whitelisted_destinations)
				? (body.whitelisted_destinations as string[])
				: ["US", "CA"],
			...(typeof body.daily_spend_limit === "string"
				? { dailySpendLimit: body.daily_spend_limit }
				: {}),
			dailySpendLimitEnabled: body.daily_spend_limit_enabled === true,
			connectionsCount: 0,
			createdAt: state.now(),
		};
		state.profiles.set(profile.id, profile);
		return { status: 200, body: { data: profileBody(profile) } };
	}

	if (method === "GET" && path === "/outbound_voice_profiles") {
		const contains = query.get("filter[name][contains]");
		const matches = [...state.profiles.values()].filter(
			(profile) => contains === null || profile.name.includes(contains),
		);
		return {
			status: 200,
			body: {
				data: matches.map(profileBody),
				meta: { total_results: matches.length, page_number: 1, page_size: 50, total_pages: 1 },
			},
		};
	}

	const profileMatch = /^\/outbound_voice_profiles\/([^/]+)$/u.exec(path);
	if (profileMatch) {
		const profileId = decodeURIComponent(profileMatch[1] ?? "");
		const profile = state.profiles.get(profileId);
		if (profile === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		if (method === "GET") {
			return { status: 200, body: { data: profileBody(profile) } };
		}
		if (method === "PATCH") {
			if (typeof body.name === "string") {
				profile.name = body.name;
			}
			if (typeof body.enabled === "boolean") {
				profile.enabled = body.enabled;
			}
			if (typeof body.daily_spend_limit === "string") {
				profile.dailySpendLimit = body.daily_spend_limit;
			}
			return { status: 200, body: { data: profileBody(profile) } };
		}
		if (method === "DELETE") {
			state.profiles.delete(profileId);
			return { status: 200, body: { data: profileBody(profile) } };
		}
	}

	// ---- addresses / E911 dispatchable locations --------------------------------------------
	if (method === "POST" && path === "/addresses/actions/validate") {
		const missing = missingAddressField(body);
		if (missing !== undefined) {
			return { status: 422, body: errorBody("10027", "Unprocessable Entity", missing) };
		}
		return { status: 200, body: { data: addressValidationBody(state) } };
	}

	if (method === "POST" && path === "/addresses") {
		const missing = missingAddressField(body);
		if (missing !== undefined) {
			return { status: 422, body: errorBody("10027", "Unprocessable Entity", missing) };
		}
		// `validate_address` is the carrier's own "refuse the write unless it validates" flag, and
		// the fake honours it — a create that returned an id for an address the validation endpoint
		// calls unreal would let the API layer store a reference that means nothing.
		if (body.validate_address === true && state.addressValidation.result !== "valid") {
			const [first] = state.addressValidation.errors;
			return {
				status: 422,
				body: errorBody(
					first?.code ?? "10015",
					"Address validation failed",
					first?.message ?? "The address could not be validated.",
				),
			};
		}
		const address: FakeAddress = {
			id: state.newId(),
			streetAddress: String(body.street_address ?? ""),
			...(typeof body.extended_address === "string"
				? { extendedAddress: body.extended_address }
				: {}),
			locality: String(body.locality ?? ""),
			administrativeArea: String(body.administrative_area ?? ""),
			postalCode: String(body.postal_code ?? ""),
			countryCode: String(body.country_code ?? ""),
			...(typeof body.customer_reference === "string"
				? { customerReference: body.customer_reference }
				: {}),
			createdAt: state.now(),
		};
		state.addresses.set(address.id, address);
		return { status: 201, body: { data: addressBody(address) } };
	}

	if (method === "GET" && path === "/addresses") {
		const reference = request.query.get("filter[customer_reference]");
		const rows = [...state.addresses.values()].filter(
			(entry) => reference === null || entry.customerReference === reference,
		);
		return {
			status: 200,
			body: {
				data: rows.map((entry) => addressBody(entry)),
				meta: { total_results: rows.length, page_number: 1, page_size: rows.length },
			},
		};
	}

	const addressMatch = /^\/addresses\/([^/]+)$/u.exec(path);
	if (addressMatch) {
		const addressId = decodeURIComponent(addressMatch[1] ?? "");
		const address = state.addresses.get(addressId);
		if (address === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		if (method === "GET") {
			return { status: 200, body: { data: addressBody(address) } };
		}
		if (method === "DELETE") {
			state.addresses.delete(addressId);
			return { status: 200, body: { data: addressBody(address) } };
		}
	}

	// ---- programmable fax ------------------------------------------------------------------
	if (method === "POST" && path === "/faxes") {
		const connectionId = typeof body.connection_id === "string" ? body.connection_id : "";
		const to = typeof body.to === "string" ? body.to : "";
		const from = typeof body.from === "string" ? body.from : "";
		if (connectionId.length === 0) {
			return { status: 422, body: errorBody("10027", "Unprocessable Entity", "connection_id") };
		}
		if (to.length === 0) {
			return { status: 422, body: errorBody("10027", "Unprocessable Entity", "to") };
		}
		if (from.length === 0) {
			return { status: 422, body: errorBody("10027", "Unprocessable Entity", "from") };
		}
		const mediaUrl = typeof body.media_url === "string" ? body.media_url : undefined;
		const mediaName = typeof body.media_name === "string" ? body.media_name : undefined;
		// Exactly one of the two, same rule the client enforces before the round trip.
		if ((mediaUrl === undefined) === (mediaName === undefined)) {
			return {
				status: 422,
				body: errorBody("10027", "Unprocessable Entity", "exactly one of media_url or media_name"),
			};
		}
		const fax: FakeFax = {
			id: state.newId(),
			direction: "outbound",
			// Queued, not sent — the delivery is asynchronous and reported over webhooks.
			status: "queued",
			connectionId,
			to,
			from,
			...(mediaUrl === undefined ? {} : { mediaUrl }),
			...(mediaName === undefined ? {} : { mediaName }),
			...(typeof body.client_state === "string" ? { clientState: body.client_state } : {}),
			createdAt: state.now(),
		};
		state.faxes.set(fax.id, fax);
		// 202 Accepted — the one endpoint in this surface that answers 202. A client asserting 200
		// would break here, which is the point.
		return { status: 202, body: { data: faxBody(fax) } };
	}

	const faxMatch = /^\/faxes\/([^/]+)$/u.exec(path);
	if (method === "GET" && faxMatch) {
		const fax = state.faxes.get(decodeURIComponent(faxMatch[1] ?? ""));
		if (fax === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		return { status: 200, body: { data: faxBody(fax) } };
	}

	// ---- messaging profiles ----------------------------------------------------------------
	if (method === "POST" && path === "/messaging_profiles") {
		const name = typeof body.name === "string" ? body.name : "";
		if (name.length === 0) {
			return { status: 422, body: errorBody("10027", "Unprocessable Entity", "name") };
		}
		const profile: FakeMessagingProfile = {
			id: state.newId(),
			name,
			enabled: body.enabled !== false,
			...(typeof body.webhook_url === "string" ? { webhookUrl: body.webhook_url } : {}),
			...(typeof body.webhook_failover_url === "string"
				? { webhookFailoverUrl: body.webhook_failover_url }
				: {}),
			// Echoed back exactly as sent, so a spec can prove the client pins "2" — a profile left
			// on the "1" default delivers an envelope `webhooks/events.ts` rejects.
			webhookApiVersion:
				typeof body.webhook_api_version === "string" ? body.webhook_api_version : "1",
			whitelistedDestinations: Array.isArray(body.whitelisted_destinations)
				? (body.whitelisted_destinations as string[])
				: ["US"],
			createdAt: state.now(),
		};
		state.messagingProfiles.set(profile.id, profile);
		return { status: 200, body: { data: messagingProfileBody(profile) } };
	}

	if (method === "GET" && path === "/messaging_profiles") {
		const filter = query.get("filter[name]");
		const matches = [...state.messagingProfiles.values()].filter(
			(profile) => filter === null || profile.name.includes(filter),
		);
		return {
			status: 200,
			body: {
				data: matches.map(messagingProfileBody),
				meta: { total_results: matches.length, page_number: 1, page_size: 50, total_pages: 1 },
			},
		};
	}

	const messagingProfileNumbers = /^\/messaging_profiles\/([^/]+)\/phone_numbers$/u.exec(path);
	if (method === "GET" && messagingProfileNumbers) {
		const profileId = decodeURIComponent(messagingProfileNumbers[1] ?? "");
		if (!state.messagingProfiles.has(profileId)) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		const attached = state.inventory.filter((entry) => entry.messagingProfileId === profileId);
		return {
			status: 200,
			body: {
				data: attached.map(numberMessagingBody),
				meta: { total_results: attached.length, page_number: 1, page_size: 50, total_pages: 1 },
			},
		};
	}

	const messagingProfileMatch = /^\/messaging_profiles\/([^/]+)$/u.exec(path);
	if (messagingProfileMatch) {
		const profileId = decodeURIComponent(messagingProfileMatch[1] ?? "");
		const profile = state.messagingProfiles.get(profileId);
		if (profile === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		if (method === "GET") {
			return { status: 200, body: { data: messagingProfileBody(profile) } };
		}
		if (method === "PATCH") {
			if (typeof body.name === "string") {
				profile.name = body.name;
			}
			if (typeof body.enabled === "boolean") {
				profile.enabled = body.enabled;
			}
			if (typeof body.webhook_url === "string") {
				profile.webhookUrl = body.webhook_url;
			}
			if (Array.isArray(body.whitelisted_destinations)) {
				profile.whitelistedDestinations = body.whitelisted_destinations as string[];
			}
			return { status: 200, body: { data: messagingProfileBody(profile) } };
		}
		if (method === "DELETE") {
			state.messagingProfiles.delete(profileId);
			for (const entry of state.inventory) {
				if (entry.messagingProfileId === profileId) {
					delete entry.messagingProfileId;
				}
			}
			return { status: 200, body: { data: messagingProfileBody(profile) } };
		}
	}

	const numberMessagingMatch = /^\/phone_numbers\/([^/]+)\/messaging$/u.exec(path);
	if (numberMessagingMatch && (method === "GET" || method === "PATCH")) {
		const identifier = decodeURIComponent(numberMessagingMatch[1] ?? "");
		/**
		 * Addressable by the carrier's number id OR by the E.164 itself.
		 *
		 * The id is what a number ordered through this fake carries. The E.164 is what a HOSTED
		 * number has — Telnyx Hosted SMS attaches messaging to a number the customer keeps at another
		 * carrier for voice, and there is no order and therefore no id on this account for it. A fake
		 * that only understood ordered numbers would make that whole class of number untestable, and
		 * it is the class a PBX migrating a customer in actually has.
		 */
		let entry =
			state.findOwned(identifier) ??
			state.inventory.find((candidate) => candidate.phoneNumber === identifier);
		if (entry === undefined && identifier.startsWith("+")) {
			entry = {
				phoneNumber: identifier,
				countryCode: "US",
				nationalDestinationCode: identifier.slice(2, 5),
				phoneNumberType: "local",
				available: false,
				ownedId: state.newId(),
			};
			state.inventory.push(entry);
		}
		if (entry === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		if (method === "PATCH") {
			const profileId = body.messaging_profile_id;
			if (typeof profileId === "string") {
				if (!state.messagingProfiles.has(profileId)) {
					return {
						status: 422,
						body: errorBody("10027", "Unprocessable Entity", "messaging_profile_id"),
					};
				}
				entry.messagingProfileId = profileId;
			} else if (profileId === null) {
				// `null` detaches. Distinguished from an absent key, which changes nothing.
				delete entry.messagingProfileId;
			}
		}
		return { status: 200, body: { data: numberMessagingBody(entry) } };
	}

	// ---- messages --------------------------------------------------------------------------
	if (method === "POST" && path === "/messages") {
		const from = typeof body.from === "string" ? body.from : "";
		const to = typeof body.to === "string" ? body.to : "";
		const text = typeof body.text === "string" ? body.text : undefined;
		const mediaUrls = Array.isArray(body.media_urls)
			? (body.media_urls as unknown[]).filter((v): v is string => typeof v === "string")
			: [];
		if (from.length === 0) {
			return { status: 422, body: errorBody("10027", "Unprocessable Entity", "from") };
		}
		if (to.length === 0) {
			return { status: 422, body: errorBody("10027", "Unprocessable Entity", "to") };
		}
		if ((text === undefined || text.length === 0) && mediaUrls.length === 0) {
			return {
				status: 422,
				body: errorBody("10027", "Unprocessable Entity", "one of text or media_urls"),
			};
		}

		/**
		 * The 10DLC gate, and the reason this fake is worth having.
		 *
		 * US carriers do not error on unregistered A2P traffic from a local number — they filter it,
		 * silently. Telnyx front-runs that with a 400, which is the behaviour our own pre-send block
		 * exists to anticipate. A fake that accepted this send would make that block untestable, so
		 * it refuses; `state.allowUnregisteredSend = true` is the escape hatch for specs about
		 * something else.
		 */
		if (!state.allowUnregisteredSend && isUsLocalNumber(from)) {
			const assignment = state.phoneNumberCampaigns.get(from);
			const campaign =
				assignment === undefined ? undefined : state.campaigns.get(assignment.campaignId);
			if (campaign === undefined || campaign.status !== "ACTIVE") {
				return {
					status: 400,
					body: errorBody(
						"40320",
						"Unregistered 10DLC traffic",
						`${from} is not assigned to an ACTIVE 10DLC campaign`,
					),
				};
			}
		}

		const message: FakeMessage = {
			id: state.newId(),
			direction: "outbound",
			type: mediaUrls.length > 0 ? "MMS" : "SMS",
			from,
			to,
			// `queued`, on the RECIPIENT and not at the top level: there is no top-level status on a
			// Telnyx message, and a client that reads one is reading a field that does not exist.
			toStatus: "queued",
			...(text === undefined ? {} : { text }),
			mediaUrls,
			...(typeof body.messaging_profile_id === "string"
				? { messagingProfileId: body.messaging_profile_id }
				: {}),
			...(typeof body.client_state === "string" ? { clientState: body.client_state } : {}),
			createdAt: state.now(),
		};
		state.messages.set(message.id, message);
		return { status: 200, body: { data: messageBody(message) } };
	}

	const messageMatch = /^\/messages\/([^/]+)$/u.exec(path);
	if (method === "GET" && messageMatch) {
		const message = state.messages.get(decodeURIComponent(messageMatch[1] ?? ""));
		if (message === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		return { status: 200, body: { data: messageBody(message) } };
	}

	// ---- 10DLC (camelCase paths AND bodies — see resources/ten-dlc.ts) ----------------------
	if (method === "POST" && path === "/10dlc/brand") {
		const entityType = typeof body.entityType === "string" ? body.entityType : "";
		const displayName = typeof body.displayName === "string" ? body.displayName : "";
		if (displayName.length === 0) {
			return { status: 400, body: errorBody("10027", "Unprocessable Entity", "displayName") };
		}
		if (entityType !== "SOLE_PROPRIETOR" && typeof body.ein !== "string") {
			// TCR's rule: everyone but a sole proprietor has a tax id to vet against.
			return { status: 400, body: errorBody("10027", "Unprocessable Entity", "ein") };
		}
		const brand: FakeBrand = {
			brandId: state.newId(),
			entityType,
			displayName,
			country: typeof body.country === "string" ? body.country : "US",
			email: typeof body.email === "string" ? body.email : "",
			vertical: typeof body.vertical === "string" ? body.vertical : "TECHNOLOGY",
			// A sole proprietor starts UNVERIFIED and reaches VERIFIED only through the SMS OTP;
			// everyone else is vetted by EIN and lands SELF_DECLARED straight away.
			identityStatus: entityType === "SOLE_PROPRIETOR" ? "UNVERIFIED" : "SELF_DECLARED",
			status: "OK",
			createdAt: state.now(),
		};
		state.brands.set(brand.brandId, brand);
		return { status: 200, body: { data: brandBody(brand) } };
	}

	if (method === "GET" && path === "/10dlc/brand") {
		const brands = [...state.brands.values()];
		return {
			status: 200,
			body: {
				data: brands.map(brandBody),
				meta: { total_results: brands.length, page_number: 1, page_size: 50, total_pages: 1 },
			},
		};
	}

	const brandOtpMatch = /^\/10dlc\/brand\/([^/]+)\/smsOtp$/u.exec(path);
	if (brandOtpMatch && (method === "POST" || method === "PUT")) {
		const brand = state.brands.get(decodeURIComponent(brandOtpMatch[1] ?? ""));
		if (brand === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		if (method === "POST") {
			// A fixed PIN, not a random one: the point of the fake is that a spec can complete the
			// round trip, and a random PIN would only be assertable by reading it back out of state.
			brand.otpPin = FAKE_BRAND_OTP_PIN;
			return { status: 200, body: { data: brandBody(brand) } };
		}
		// The wire field is `otpPin`, not `pin` — see resources/ten-dlc.ts for the doc URL.
		const submitted = typeof body.otpPin === "string" ? body.otpPin : "";
		if (brand.otpPin === undefined) {
			return { status: 400, body: errorBody("10027", "Unprocessable Entity", "no OTP was sent") };
		}
		if (submitted !== brand.otpPin) {
			return { status: 400, body: errorBody("10027", "Unprocessable Entity", "otpPin") };
		}
		brand.identityStatus = "VERIFIED";
		delete brand.otpPin;
		return { status: 200, body: { data: brandBody(brand) } };
	}

	const brandMatch = /^\/10dlc\/brand\/([^/]+)$/u.exec(path);
	if (brandMatch && (method === "GET" || method === "DELETE")) {
		const brandId = decodeURIComponent(brandMatch[1] ?? "");
		const brand = state.brands.get(brandId);
		if (brand === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		if (method === "DELETE") {
			state.brands.delete(brandId);
		}
		return { status: 200, body: { data: brandBody(brand) } };
	}

	if (method === "POST" && path === "/10dlc/campaignBuilder") {
		const brandId = typeof body.brandId === "string" ? body.brandId : "";
		const brand = state.brands.get(brandId);
		if (brand === undefined) {
			return { status: 400, body: errorBody("10027", "Unprocessable Entity", "brandId") };
		}
		const campaign: FakeCampaign = {
			campaignId: state.newId(),
			brandId,
			usecase: typeof body.usecase === "string" ? body.usecase : "",
			description: typeof body.description === "string" ? body.description : "",
			// A campaign under an unverified brand does not reach ACTIVE, which is precisely the
			// state that makes an assignment fail. Verifying the brand first is the whole sequence
			// this fake exists to make testable.
			status:
				brand.identityStatus === "UNVERIFIED" || brand.identityStatus === "PENDING"
					? "TCR_PENDING"
					: "ACTIVE",
			createdAt: state.now(),
		};
		state.campaigns.set(campaign.campaignId, campaign);
		return { status: 200, body: { data: campaignBody(campaign) } };
	}

	if (method === "GET" && path === "/10dlc/campaign") {
		const brandId = query.get("brandId");
		const matches = [...state.campaigns.values()].filter(
			(campaign) => brandId === null || campaign.brandId === brandId,
		);
		return {
			status: 200,
			body: {
				data: matches.map(campaignBody),
				meta: { total_results: matches.length, page_number: 1, page_size: 50, total_pages: 1 },
			},
		};
	}

	const campaignMatch = /^\/10dlc\/campaign\/([^/]+)$/u.exec(path);
	if (method === "GET" && campaignMatch) {
		const campaign = state.campaigns.get(decodeURIComponent(campaignMatch[1] ?? ""));
		if (campaign === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		return { status: 200, body: { data: campaignBody(campaign) } };
	}

	if (method === "POST" && path === "/10dlc/phoneNumberCampaign") {
		const phoneNumber = typeof body.phoneNumber === "string" ? body.phoneNumber : "";
		const campaignId = typeof body.campaignId === "string" ? body.campaignId : "";
		const campaign = state.campaigns.get(campaignId);
		if (campaign === undefined) {
			return { status: 400, body: errorBody("10027", "Unprocessable Entity", "campaignId") };
		}
		// Rule one: only an ACTIVE campaign accepts numbers. Assigning to a pending campaign would
		// look like it worked and then filter every message sent from the number.
		if (campaign.status !== "ACTIVE") {
			return {
				status: 400,
				body: errorBody(
					"10027",
					"Unprocessable Entity",
					`campaign ${campaignId} is ${campaign.status}, not ACTIVE`,
				),
			};
		}
		// Rule two: the number must already be on a messaging profile. Telnyx has nowhere to route
		// the traffic otherwise, and this is the ordering mistake easiest to make.
		const entry = state.inventory.find((candidate) => candidate.phoneNumber === phoneNumber);
		if (entry === undefined || entry.messagingProfileId === undefined) {
			return {
				status: 400,
				body: errorBody(
					"10027",
					"Unprocessable Entity",
					`${phoneNumber} is not assigned to a messaging profile`,
				),
			};
		}
		const assignment: FakePhoneNumberCampaign = {
			phoneNumber,
			campaignId,
			brandId: campaign.brandId,
			assignmentStatus: "SUCCESS",
		};
		state.phoneNumberCampaigns.set(phoneNumber, assignment);
		return { status: 200, body: { data: phoneNumberCampaignBody(assignment) } };
	}

	const phoneNumberCampaignMatch = /^\/10dlc\/phoneNumberCampaign\/([^/]+)$/u.exec(path);
	if (method === "DELETE" && phoneNumberCampaignMatch) {
		const phoneNumber = decodeURIComponent(phoneNumberCampaignMatch[1] ?? "");
		if (!state.phoneNumberCampaigns.has(phoneNumber)) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		state.phoneNumberCampaigns.delete(phoneNumber);
		// 204, empty. The client declares `allowEmptyBody` for exactly this.
		return { status: 204, body: undefined };
	}

	// ---- toll-free verification (camelCase body, snake_case path) --------------------------
	if (method === "POST" && path === TOLL_FREE_PATH) {
		const businessName = typeof body.businessName === "string" ? body.businessName : "";
		if (businessName.length === 0) {
			return { status: 400, body: errorBody("10027", "Unprocessable Entity", "businessName") };
		}
		// The BRN trio, mandatory on every new submission since 17 Feb 2026. The fake enforces it so
		// a client that stops sending it fails here rather than in review, days later.
		for (const field of [
			"businessRegistrationNumber",
			"businessRegistrationType",
			"businessRegistrationCountry",
		]) {
			if (typeof body[field] !== "string" || (body[field] as string).length === 0) {
				return { status: 400, body: errorBody("10027", "Unprocessable Entity", field) };
			}
		}
		if (!/^[A-Z]{2}$/u.test(body.businessRegistrationCountry as string)) {
			return {
				status: 400,
				body: errorBody("10027", "Unprocessable Entity", "businessRegistrationCountry"),
			};
		}
		const verification: FakeTollFreeVerification = {
			id: state.newId(),
			businessName,
			verificationStatus: "In Progress",
			businessRegistrationNumber: body.businessRegistrationNumber as string,
			businessRegistrationType: body.businessRegistrationType as string,
			businessRegistrationCountry: body.businessRegistrationCountry as string,
			phoneNumbers: Array.isArray(body.phoneNumbers)
				? (body.phoneNumbers as { phoneNumber?: string }[]).map((item) => item.phoneNumber ?? "")
				: [],
			createdAt: state.now(),
		};
		state.tollFreeVerifications.set(verification.id, verification);
		return { status: 200, body: { data: tollFreeBody(verification) } };
	}

	if (method === "GET" && path === TOLL_FREE_PATH) {
		const status = query.get("status");
		const matches = [...state.tollFreeVerifications.values()].filter(
			(entry) => status === null || entry.verificationStatus === status,
		);
		return {
			status: 200,
			body: {
				data: matches.map(tollFreeBody),
				meta: { total_results: matches.length, page_number: 1, page_size: 50, total_pages: 1 },
			},
		};
	}

	const tollFreeMatch = new RegExp(`^${TOLL_FREE_PATH}/([^/]+)$`, "u").exec(path);
	if (tollFreeMatch) {
		const verificationId = decodeURIComponent(tollFreeMatch[1] ?? "");
		const verification = state.tollFreeVerifications.get(verificationId);
		if (verification === undefined) {
			return { status: 404, body: errorBody("10005", "Resource not found") };
		}
		if (method === "GET") {
			return { status: 200, body: { data: tollFreeBody(verification) } };
		}
		if (method === "PATCH") {
			if (typeof body.businessName === "string") {
				verification.businessName = body.businessName;
			}
			return { status: 200, body: { data: tollFreeBody(verification) } };
		}
		if (method === "DELETE") {
			state.tollFreeVerifications.delete(verificationId);
			return { status: 204, body: undefined };
		}
	}

	return { status: 404, body: errorBody("10005", "Resource not found", `${method} ${path}`) };
}

export async function startFakeTelnyxServer(
	state: FakeTelnyxState = new FakeTelnyxState(),
): Promise<FakeTelnyxServer> {
	const server: Server = createServer((incoming, outgoing) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const url = new URL(incoming.url ?? "/", "http://fake.telnyx");
			const headers: Record<string, string> = {};
			for (const [key, value] of Object.entries(incoming.headers)) {
				headers[key] = Array.isArray(value) ? value.join(",") : (value ?? "");
			}

			const send = (reply: Reply): void => {
				outgoing.writeHead(reply.status, {
					"content-type": "application/json",
					// Telnyx sends these on every response, which is where the retry path reads its
					// rate-limit floor from.
					"x-ratelimit-limit": "2000, 2000;w=1",
					"x-ratelimit-remaining": "1999",
					"x-ratelimit-reset": "1",
					...reply.headers,
				});
				outgoing.end(JSON.stringify(reply.body));
			};

			// Auth: presence only. Asserting the exact key would test that we can pass a string to
			// ourselves; asserting its absence catches a client that forgot the header entirely.
			const authorization = headers.authorization ?? "";
			if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
				send({
					status: 401,
					body: errorBody(
						"10009",
						"Authentication failed",
						"Could not find any usable credentials in the request.",
					),
				});
				return;
			}

			if (!url.pathname.startsWith("/v2/")) {
				send({ status: 404, body: errorBody("10005", "Resource not found", url.pathname) });
				return;
			}

			let body: Record<string, unknown> = {};
			if (raw.length > 0) {
				try {
					const parsed: unknown = JSON.parse(raw);
					body = typeof parsed === "object" && parsed !== null ? (parsed as never) : {};
				} catch {
					send({ status: 400, body: errorBody("10015", "Bad Request", "malformed JSON") });
					return;
				}
			}

			const path = url.pathname.slice("/v2".length);
			state.requests.push({ method: incoming.method ?? "GET", path, headers, body });

			// Queued synthetic failures come first, so a test can describe "429, 429, then work".
			const injected = state.failureQueue.shift();
			if (injected !== undefined) {
				send({
					status: injected.status,
					body: errorBody(
						injected.code ?? (injected.status === 429 ? "10011" : "10027"),
						injected.status === 429 ? "Too many requests" : "Injected failure",
					),
					...(injected.retryAfterSeconds === undefined
						? {}
						: { headers: { "retry-after": String(injected.retryAfterSeconds) } }),
				});
				return;
			}

			send(
				route(
					{
						method: incoming.method ?? "GET",
						path,
						query: url.searchParams,
						headers,
						body,
					},
					state,
				),
			);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.on("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v2`,
		port: address.port,
		state,
		close: async () => {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}
