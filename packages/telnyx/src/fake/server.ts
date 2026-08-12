import { createServer, type Server } from "node:http";
import {
	type FakeConnection,
	type FakeFax,
	type FakeNumberInventoryEntry,
	type FakeOrder,
	type FakeProfile,
	FakeTelnyxState,
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
 * Not faithful: rate limits (driven by an explicit queue instead), regulatory requirements,
 * porting, messaging, and the several hundred endpoints this platform does not call. A fake that
 * tried to be complete would be a second implementation to maintain and would still be wrong.
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
		cnam_listing_enabled: false,
		caller_id_name_enabled: false,
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
		cnam_listing: { cnam_listing_enabled: false, cnam_listing_details: "" },
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
