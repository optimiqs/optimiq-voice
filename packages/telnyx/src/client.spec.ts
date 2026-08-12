import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createTelnyxClient } from "./client";
import { TelnyxApiError, TelnyxResponseShapeError, TelnyxTransportError } from "./errors";
import { type FakeTelnyxServer, startFakeTelnyxServer } from "./fake";
import { availableNumbersQuery } from "./resources/available-numbers";
import { assertTelnyxPassword, assertTelnyxUserName } from "./resources/credential-connections";
import { isTelnyxFaxEvent, TelnyxFaxRequestError } from "./resources/faxes";
import { asFaxWebhook, parseTelnyxWebhookEvent } from "./webhooks/events";

/**
 * The client, exercised end to end against the in-package fake.
 *
 * Every test below drives a real socket rather than a stubbed `fetch`, which is what makes the
 * request-building (bracketed filter keys, bodies, methods) part of what is under test rather than
 * part of the test's assumptions.
 */

const server: FakeTelnyxServer = await startFakeTelnyxServer();

afterAll(async () => {
	await server.close();
});

beforeEach(() => {
	server.state.reset();
});

function makeClient(overrides: Record<string, unknown> = {}) {
	return createTelnyxClient({
		apiKey: "KEY0123456789",
		baseUrl: server.baseUrl,
		// No real waiting: the policy is unit-tested in `retry.spec.ts`; here only the sequencing
		// matters.
		sleep: async () => {},
		random: () => 0,
		...overrides,
	});
}

describe("availableNumbers.search", () => {
	it("filters by country and area code, and returns the documented shape", async () => {
		const client = makeClient();
		const result = await client.availableNumbers.search({
			countryCode: "US",
			nationalDestinationCode: "212",
			limit: 3,
		});
		expect(result.data).toHaveLength(3);
		for (const entry of result.data) {
			expect(entry.phone_number.startsWith("+1212555")).toBe(true);
		}
		expect(result.totalResults).toBe(3);
	});

	/** `features` is an array of objects and costs are strings — the two shapes most easily wrong. */
	it("keeps features as objects and costs as strings", async () => {
		const client = makeClient();
		const [first] = (await client.availableNumbers.search({ countryCode: "US" })).data;
		expect(first?.features?.[0]).toEqual({ name: "voice" });
		expect(typeof first?.cost_information?.monthly_cost).toBe("string");
	});

	it("builds bracketed filter keys rather than a nested object", () => {
		const query = availableNumbersQuery({
			countryCode: "US",
			contains: "555",
			phoneNumberType: "local",
			features: ["voice", "emergency"],
		});
		expect(query["filter[country_code]"]).toBe("US");
		expect(query["filter[phone_number][contains]"]).toBe("555");
		// Not `filter[number_type]` — that key belongs to a different endpoint.
		expect(query["filter[phone_number_type]"]).toBe("local");
		expect(query["filter[features][0]"]).toBe("voice");
		expect(query["filter[features][1]"]).toBe("emergency");
	});

	/**
	 * An unspecified area code must not become the literal string "undefined" in the query — Telnyx
	 * would then filter for numbers containing it and return an empty page that looks like "no
	 * numbers available in your country".
	 */
	it("drops unspecified filters instead of sending them as 'undefined'", async () => {
		let requested = "";
		const client = makeClient({
			fetch: async (url: string, init: RequestInit) => {
				requested = url;
				return await fetch(url, init);
			},
		});
		await client.availableNumbers.search({ countryCode: "US" });
		expect(requested).toContain("filter%5Bcountry_code%5D=US");
		expect(requested).not.toContain("undefined");
		expect(requested).not.toContain("national_destination_code");
	});
});

describe("numberOrders", () => {
	it("refuses an order for a number that was never searched (Telnyx 85000)", async () => {
		const client = makeClient();
		await expect(
			client.numberOrders.create({
				phoneNumbers: ["+12125551000"],
				customerReference: "ref-1",
			}),
		).rejects.toThrow(TelnyxApiError);

		try {
			await client.numberOrders.create({
				phoneNumbers: ["+12125551000"],
				customerReference: "ref-1",
			});
		} catch (error) {
			expect(error).toBeInstanceOf(TelnyxApiError);
			expect((error as TelnyxApiError).hasCode("85000")).toBe(true);
			// The carrier's own code survives the trip — that is the whole point of the error class.
			expect((error as TelnyxApiError).errors[0]?.title).toBe(
				"Must search phone number via search API first",
			);
		}
	});

	it("orders a searched number and reports it as owned", async () => {
		const client = makeClient();
		const search = await client.availableNumbers.search({ countryCode: "US", limit: 1 });
		const target = search.data[0]?.phone_number ?? "";
		const order = await client.numberOrders.create({
			phoneNumbers: [target],
			customerReference: "ref-2",
		});
		expect(order.status).toBe("success");
		expect(order.phone_numbers[0]?.phone_number).toBe(target);
		expect(order.customer_reference).toBe("ref-2");

		const owned = await client.phoneNumbers.list({ phoneNumber: target });
		expect(owned).toHaveLength(1);
		expect(owned[0]?.status).toBe("active");
	});

	it("refuses to order the same number twice (Telnyx 85001)", async () => {
		const client = makeClient();
		const search = await client.availableNumbers.search({ countryCode: "US", limit: 1 });
		const target = search.data[0]?.phone_number ?? "";
		await client.numberOrders.create({ phoneNumbers: [target], customerReference: "a" });
		try {
			await client.numberOrders.create({ phoneNumbers: [target], customerReference: "b" });
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as TelnyxApiError).hasCode("85001")).toBe(true);
		}
	});

	/**
	 * The reconciliation path that stands in for the idempotency Telnyx does not offer. Without it,
	 * the only recovery from an ambiguous timeout is to retry — which is how one order becomes two.
	 */
	it("finds an order by the customer reference we stamped on it", async () => {
		const client = makeClient();
		const search = await client.availableNumbers.search({ countryCode: "US", limit: 1 });
		const created = await client.numberOrders.create({
			phoneNumbers: [search.data[0]?.phone_number ?? ""],
			customerReference: "reconcile-me",
		});
		const found = await client.numberOrders.findByCustomerReference("reconcile-me");
		expect(found).toHaveLength(1);
		expect(found[0]?.id).toBe(created.id);
		expect(await client.numberOrders.findByCustomerReference("nothing")).toHaveLength(0);
	});

	it("reads an order back by id", async () => {
		const client = makeClient();
		const search = await client.availableNumbers.search({ countryCode: "US", limit: 1 });
		const created = await client.numberOrders.create({
			phoneNumbers: [search.data[0]?.phone_number ?? ""],
			customerReference: "ref-3",
		});
		expect((await client.numberOrders.get(created.id)).id).toBe(created.id);
	});

	/**
	 * The most consequential behaviour in the package. Telnyx offers no idempotency on this
	 * endpoint, so a transport-level retry after a 500 could place a second paid order. One attempt
	 * is made, and the failure is surfaced for the caller to reconcile.
	 */
	it("never retries order creation, because a second attempt could order twice", async () => {
		const client = makeClient();
		const search = await client.availableNumbers.search({ countryCode: "US", limit: 1 });
		server.state.requests.length = 0;
		server.state.failNext(500);
		try {
			await client.numberOrders.create({
				phoneNumbers: [search.data[0]?.phone_number ?? ""],
				customerReference: "no-retry",
			});
			throw new Error("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(TelnyxApiError);
		}
		const orderAttempts = server.state.requests.filter(
			(request) => request.method === "POST" && request.path === "/number_orders",
		);
		expect(orderAttempts).toHaveLength(1);
	});
});

describe("phoneNumbers", () => {
	async function orderOne(client: ReturnType<typeof makeClient>) {
		const search = await client.availableNumbers.search({ countryCode: "US", limit: 1 });
		const phoneNumber = search.data[0]?.phone_number ?? "";
		await client.numberOrders.create({ phoneNumbers: [phoneNumber], customerReference: "x" });
		const [owned] = await client.phoneNumbers.list({ phoneNumber });
		return owned;
	}

	it("assigns a connection with PATCH on the parent resource", async () => {
		const client = makeClient();
		const connection = await client.credentialConnections.create({
			connectionName: "trunk-a",
			userName: "org1abcd",
			password: "correct-horse-battery",
		});
		const owned = await orderOne(client);
		const updated = await client.phoneNumbers.update(owned?.id ?? "", {
			connectionId: connection.id,
		});
		expect(updated.connection_id).toBe(connection.id);
	});

	it("rejects an unknown connection id with the carrier's own 85004", async () => {
		const client = makeClient();
		const owned = await orderOne(client);
		try {
			await client.phoneNumbers.update(owned?.id ?? "", { connectionId: "nope" });
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as TelnyxApiError).hasCode("85004")).toBe(true);
		}
	});

	it("reads voice settings, which do not echo caller_id_name_enabled", async () => {
		const client = makeClient();
		const owned = await orderOne(client);
		const voice = await client.phoneNumbers.getVoiceSettings(owned?.id ?? "");
		expect(voice.call_recording?.inbound_call_recording_format).toBe("wav");
		// Asymmetric by design: writable via PATCH, absent from GET. See reference/telnyx-api.md.
		expect((voice as Record<string, unknown>).caller_id_name_enabled).toBeUndefined();
	});

	it("releases a number and returns the record with the resulting status", async () => {
		const client = makeClient();
		const owned = await orderOne(client);
		const released = await client.phoneNumbers.release(owned?.id ?? "");
		expect(released.status).toBe("deleted");
		expect(await client.phoneNumbers.list({})).toHaveLength(0);
	});
});

describe("credentialConnections", () => {
	it("creates a connection and echoes the credential back", async () => {
		const client = makeClient();
		const connection = await client.credentialConnections.create({
			connectionName: "org-a trunk",
			userName: "org1a2b3c",
			password: "a-long-enough-password",
			anchorsiteOverride: "Latency",
			dtmfType: "RFC 2833",
		});
		expect(connection.user_name).toBe("org1a2b3c");
		expect(connection.password).toBe("a-long-enough-password");
		// Version 2 is forced by the client: version 1 delivers an envelope nothing here can parse.
		expect(connection.webhook_api_version).toBe("2");
	});

	it("binds an outbound voice profile through the nested outbound object", async () => {
		const client = makeClient();
		const profile = await client.outboundVoiceProfiles.create({ name: "org-a profile" });
		const connection = await client.credentialConnections.create({
			connectionName: "org-a trunk",
			userName: "org1zzzz",
			password: "a-long-enough-password",
			outboundVoiceProfileId: profile.id,
		});
		expect(connection.outbound?.outbound_voice_profile_id).toBe(profile.id);
		expect((await client.outboundVoiceProfiles.get(profile.id)).connections_count).toBe(1);
	});

	it("reads, updates and deletes", async () => {
		const client = makeClient();
		const created = await client.credentialConnections.create({
			connectionName: "one",
			userName: "org1aaaa",
			password: "a-long-enough-password",
		});
		expect((await client.credentialConnections.get(created.id)).connection_name).toBe("one");
		const updated = await client.credentialConnections.update(created.id, {
			connectionName: "two",
		});
		expect(updated.connection_name).toBe("two");
		await client.credentialConnections.remove(created.id);
		await expect(client.credentialConnections.get(created.id)).rejects.toThrow(TelnyxApiError);
	});

	it("reports registration status without a live registration", async () => {
		const client = makeClient();
		const created = await client.credentialConnections.create({
			connectionName: "one",
			userName: "org1bbbb",
			password: "a-long-enough-password",
		});
		const status = await client.credentialConnections.checkRegistrationStatus(created.id);
		expect(status.status).toBe("Not Registered");
		expect(status.sip_username).toBe("org1bbbb");
	});
});

describe("credential format rules, checked before the round trip", () => {
	it("accepts a username that is 4-32 alphanumerics with a letter in the first five", () => {
		expect(() => assertTelnyxUserName("org1abc")).not.toThrow();
		expect(() => assertTelnyxUserName("a123")).not.toThrow();
	});

	it("rejects a username that is too short, too long or not alphanumeric", () => {
		expect(() => assertTelnyxUserName("abc")).toThrow();
		expect(() => assertTelnyxUserName("a".repeat(33))).toThrow();
		expect(() => assertTelnyxUserName("org-1abc")).toThrow();
		expect(() => assertTelnyxUserName("org 1abc")).toThrow();
	});

	/**
	 * The rule Telnyx documents only on its RESPONSE schema, and enforces anyway. Generated
	 * usernames are the ones most likely to be all digits, so this is the check that stops a
	 * provisioning run failing in front of an admin.
	 */
	it("rejects a username whose first five characters are all digits", () => {
		expect(() => assertTelnyxUserName("12345abc")).toThrow();
		expect(() => assertTelnyxUserName("1234a567")).not.toThrow();
	});

	it("enforces the 8-128 character password range", () => {
		expect(() => assertTelnyxPassword("short")).toThrow();
		expect(() => assertTelnyxPassword("longenough")).not.toThrow();
		expect(() => assertTelnyxPassword("x".repeat(129))).toThrow();
	});
});

describe("outboundVoiceProfiles", () => {
	it("creates with spend controls and reads them back", async () => {
		const client = makeClient();
		const profile = await client.outboundVoiceProfiles.create({
			name: "org-a profile",
			concurrentCallLimit: 10,
			whitelistedDestinations: ["US", "CA", "GB"],
			dailySpendLimit: "50.00",
			dailySpendLimitEnabled: true,
		});
		expect(profile.concurrent_call_limit).toBe(10);
		expect(profile.whitelisted_destinations).toEqual(["US", "CA", "GB"]);
		// A decimal string, never coerced to a float.
		expect(profile.daily_spend_limit).toBe("50.00");
		expect(profile.traffic_type).toBe("conversational");
		expect(profile.service_plan).toBe("global");
		expect(profile.usage_payment_method).toBe("rate-deck");
	});

	it("refuses a name shorter than Telnyx's minimum without a round trip", async () => {
		const client = makeClient();
		server.state.requests.length = 0;
		await expect(client.outboundVoiceProfiles.create({ name: "ab" })).rejects.toThrow();
		expect(server.state.requests).toHaveLength(0);
	});

	it("lists, updates and deletes", async () => {
		const client = makeClient();
		const created = await client.outboundVoiceProfiles.create({ name: "org-a profile" });
		expect(await client.outboundVoiceProfiles.list("org-a")).toHaveLength(1);
		expect(
			(await client.outboundVoiceProfiles.update(created.id, { enabled: false })).enabled,
		).toBe(false);
		await client.outboundVoiceProfiles.remove(created.id);
		expect(await client.outboundVoiceProfiles.list()).toHaveLength(0);
	});
});

describe("faxes", () => {
	it("queues a send and returns the fax with its carrier id, echoing our client_state", async () => {
		const client = makeClient();
		const fax = await client.faxes.send({
			connectionId: "conn-1",
			to: "+13125551111",
			from: "+13125550000",
			mediaUrl: "https://media.example/doc.pdf",
			clientState: "fax-message-row-1",
		});
		expect(fax.direction).toBe("outbound");
		expect(fax.status).toBe("queued");
		expect(fax.client_state).toBe("fax-message-row-1");
		expect(fax.id).toBeString();
	});

	it("answers 202 Accepted on send, not 200", async () => {
		const client = makeClient();
		server.state.requests.length = 0;
		await client.faxes.send({
			connectionId: "conn-1",
			to: "+13125551111",
			from: "+13125550000",
			mediaUrl: "https://media.example/doc.pdf",
			clientState: "row-2",
		});
		// One request only: a queued send must never auto-retry (a second attempt is a second fax).
		expect(server.state.requests).toHaveLength(1);
		expect(server.state.requests[0]?.method).toBe("POST");
		expect(server.state.requests[0]?.path).toBe("/faxes");
	});

	it("reads a fax back by id after sending it", async () => {
		const client = makeClient();
		const sent = await client.faxes.send({
			connectionId: "conn-1",
			to: "+13125551111",
			from: "+13125550000",
			mediaName: "stored-doc",
			clientState: "row-3",
		});
		const read = await client.faxes.get(sent.id);
		expect(read.id).toBe(sent.id);
		expect(read.media_name).toBe("stored-doc");
	});

	it("refuses a send with neither media_url nor media_name before any round trip", async () => {
		const client = makeClient();
		server.state.requests.length = 0;
		await expect(
			client.faxes.send({
				connectionId: "conn-1",
				to: "+13125551111",
				from: "+13125550000",
				clientState: "row-4",
			}),
		).rejects.toThrow(TelnyxFaxRequestError);
		expect(server.state.requests).toHaveLength(0);
	});

	it("refuses a send with both media_url and media_name before any round trip", async () => {
		const client = makeClient();
		server.state.requests.length = 0;
		await expect(
			client.faxes.send({
				connectionId: "conn-1",
				to: "+13125551111",
				from: "+13125550000",
				mediaUrl: "https://media.example/doc.pdf",
				mediaName: "stored-doc",
				clientState: "row-5",
			}),
		).rejects.toThrow(TelnyxFaxRequestError);
		expect(server.state.requests).toHaveLength(0);
	});

	it("does not retry a send that fails, because a repeat could send a second fax", async () => {
		const client = makeClient();
		server.state.failNext(500);
		server.state.requests.length = 0;
		await expect(
			client.faxes.send({
				connectionId: "conn-1",
				to: "+13125551111",
				from: "+13125550000",
				mediaUrl: "https://media.example/doc.pdf",
				clientState: "row-6",
			}),
		).rejects.toThrow(TelnyxApiError);
		expect(server.state.requests).toHaveLength(1);
	});
});

describe("fax webhooks", () => {
	function faxEnvelope(eventType: string, payload: Record<string, unknown>) {
		return {
			data: {
				record_type: "event",
				event_type: eventType,
				id: "evt-1",
				occurred_at: "2026-08-12T00:00:00.000Z",
				payload,
			},
			meta: { attempt: 1, delivered_to: "https://example/webhooks/telnyx" },
		};
	}

	it("recognizes every modelled fax event type and rejects an unmodelled one", () => {
		expect(isTelnyxFaxEvent("fax.delivered")).toBe(true);
		expect(isTelnyxFaxEvent("fax.received")).toBe(true);
		expect(isTelnyxFaxEvent("fax.queued")).toBe(true);
		expect(isTelnyxFaxEvent("fax.bogus")).toBe(false);
		expect(isTelnyxFaxEvent("number_order.complete")).toBe(false);
	});

	it("narrows an outbound fax.delivered to the fax payload", () => {
		const event = parseTelnyxWebhookEvent(
			faxEnvelope("fax.delivered", {
				fax_id: "fax-1",
				direction: "outbound",
				status: "delivered",
				from: "+13125550000",
				to: "+13125551111",
				client_state: "row-7",
				page_count: 2,
			}),
		);
		expect(event).toBeDefined();
		const fax = asFaxWebhook(event as never);
		expect(fax?.eventType).toBe("fax.delivered");
		expect(fax?.fax.fax_id).toBe("fax-1");
		expect(fax?.fax.page_count).toBe(2);
		expect(fax?.fax.client_state).toBe("row-7");
	});

	it("narrows an inbound fax.received carrying the rendered document url", () => {
		const event = parseTelnyxWebhookEvent(
			faxEnvelope("fax.received", {
				fax_id: "fax-2",
				direction: "inbound",
				status: "received",
				from: "+13125559999",
				to: "+13125550000",
				media_url: "https://media.telnyx/received.tiff",
				page_count: 1,
			}),
		);
		const fax = asFaxWebhook(event as never);
		expect(fax?.eventType).toBe("fax.received");
		expect(fax?.fax.direction).toBe("inbound");
		expect(fax?.fax.media_url).toBe("https://media.telnyx/received.tiff");
	});

	it("returns undefined for a non-fax event, leaving it for another narrower", () => {
		const event = parseTelnyxWebhookEvent(
			faxEnvelope("number_order.complete", { id: "order-1", status: "success" }),
		);
		expect(asFaxWebhook(event as never)).toBeUndefined();
	});

	it("returns undefined for a fax event whose payload is missing fax_id", () => {
		const event = parseTelnyxWebhookEvent(
			faxEnvelope("fax.failed", { direction: "outbound", status: "failed" }),
		);
		expect(asFaxWebhook(event as never)).toBeUndefined();
	});
});

describe("transport behaviour", () => {
	it("retries a 429 and succeeds on the next attempt", async () => {
		const client = makeClient();
		server.state.failNext(429).failNext(429);
		server.state.requests.length = 0;
		const result = await client.availableNumbers.search({ countryCode: "US", limit: 1 });
		expect(result.data).toHaveLength(1);
		expect(server.state.requests).toHaveLength(3);
	});

	it("retries a 500 on a read", async () => {
		const client = makeClient();
		server.state.failNext(500);
		server.state.requests.length = 0;
		await client.availableNumbers.search({ countryCode: "US", limit: 1 });
		expect(server.state.requests).toHaveLength(2);
	});

	it("gives up after the budget and surfaces the carrier's status and code", async () => {
		const client = makeClient({ retry: { maxAttempts: 2 } });
		server.state.failNext(429).failNext(429);
		try {
			await client.availableNumbers.search({ countryCode: "US" });
			throw new Error("should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(TelnyxApiError);
			expect((error as TelnyxApiError).status).toBe(429);
			expect((error as TelnyxApiError).isRateLimited).toBe(true);
			expect((error as TelnyxApiError).hasCode("10011")).toBe(true);
		}
	});

	it("does not retry a 422, because repeating it produces the same 422", async () => {
		const client = makeClient();
		server.state.failNext(422, { code: "10027" });
		server.state.requests.length = 0;
		await expect(client.availableNumbers.search({ countryCode: "US" })).rejects.toThrow(
			TelnyxApiError,
		);
		expect(server.state.requests).toHaveLength(1);
	});

	it("classifies an authentication failure distinctly", async () => {
		const client = createTelnyxClient({
			apiKey: "",
			baseUrl: server.baseUrl,
			sleep: async () => {},
			random: () => 0,
		});
		try {
			await client.availableNumbers.search({ countryCode: "US" });
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as TelnyxApiError).isAuthentication).toBe(true);
			expect((error as TelnyxApiError).hasCode("10009")).toBe(true);
		}
	});

	it("reports a transport failure separately from an API failure", async () => {
		const client = createTelnyxClient({
			apiKey: "KEY",
			// A port nothing listens on: connect fails without a response.
			baseUrl: "http://127.0.0.1:1/v2",
			sleep: async () => {},
			random: () => 0,
			retry: { maxAttempts: 2 },
		});
		await expect(client.availableNumbers.search({ countryCode: "US" })).rejects.toThrow(
			TelnyxTransportError,
		);
	});

	/**
	 * A 2xx whose body does not match must be fatal, not "use what we can read": a silently
	 * tolerated shape drift is how a renamed field becomes `undefined` in a database column.
	 */
	it("refuses a 2xx body it does not understand", async () => {
		const client = createTelnyxClient({
			apiKey: "KEY",
			baseUrl: server.baseUrl,
			sleep: async () => {},
			random: () => 0,
			fetch: async () =>
				new Response(JSON.stringify({ data: [{ not_a_phone_number: true }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		});
		await expect(client.availableNumbers.search({ countryCode: "US" })).rejects.toThrow(
			TelnyxResponseShapeError,
		);
	});

	it("sends the bearer token on every request", async () => {
		const client = makeClient();
		server.state.requests.length = 0;
		await client.availableNumbers.search({ countryCode: "US" });
		expect(server.state.requests[0]?.headers.authorization).toBe("Bearer KEY0123456789");
	});

	/**
	 * Telnyx rejects an `Idempotency-Key` on endpoints that do not support it with error `10015`, so
	 * the client must not send one speculatively.
	 */
	it("does not send an Idempotency-Key on endpoints that would reject it", async () => {
		const client = makeClient();
		const search = await client.availableNumbers.search({ countryCode: "US", limit: 1 });
		server.state.requests.length = 0;
		await client.numberOrders.create({
			phoneNumbers: [search.data[0]?.phone_number ?? ""],
			customerReference: "no-key",
		});
		expect(server.state.requests[0]?.headers["idempotency-key"]).toBeUndefined();
	});
});
