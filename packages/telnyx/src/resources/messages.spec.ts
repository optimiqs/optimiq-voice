import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createTelnyxClient } from "../client";
import { TelnyxApiError } from "../errors";
import { type FakeTelnyxServer, startFakeTelnyxServer } from "../fake";
import { asMessageWebhook, parseTelnyxWebhookEvent } from "../webhooks/events";
import {
	isTelnyxMessageEvent,
	messageFromE164,
	TELNYX_MESSAGE_EVENTS,
	type TelnyxDeliveryStatus,
	telnyxDeliveryStatus,
	TelnyxMessageRequestError,
} from "./messages";

/**
 * Messaging, end to end against the in-package fake — a real socket rather than a stubbed `fetch`,
 * so the body shape (`media_urls`, `client_state`) is under test rather than assumed.
 */

const server: FakeTelnyxServer = await startFakeTelnyxServer();

afterAll(async () => {
	await server.close();
});

beforeEach(() => {
	server.state.reset();
	// These tests are about sending, not about registration; the 10DLC gate has its own spec.
	server.state.allowUnregisteredSend = true;
});

function makeClient(overrides: Record<string, unknown> = {}) {
	return createTelnyxClient({
		apiKey: "KEY0123456789",
		baseUrl: server.baseUrl,
		sleep: async () => {},
		random: () => 0,
		...overrides,
	});
}

describe("messages.send", () => {
	it("sends an SMS and echoes the client state back", async () => {
		const client = makeClient();
		const message = await client.messages.send({
			from: "+12125551000",
			to: "+14155551000",
			text: "your appointment is confirmed",
			clientState: "sms_row_1",
		});
		expect(message.direction).toBe("outbound");
		expect(message.type).toBe("SMS");
		expect(message.client_state).toBe("sms_row_1");
		// The delivery status is per recipient. There is no top-level `status` to read.
		expect(message.to?.[0]?.status).toBe("queued");
		expect((message as Record<string, unknown>).status).toBeUndefined();
	});

	it("sends an MMS when media urls are present", async () => {
		const client = makeClient();
		const message = await client.messages.send({
			from: "+12125551000",
			to: "+14155551000",
			mediaUrls: ["https://example.test/cat.jpg"],
			clientState: "mms_row_1",
		});
		expect(message.type).toBe("MMS");
		expect(message.media).toHaveLength(1);
	});

	it("rejects a send with neither text nor media before any round trip", async () => {
		const client = makeClient();
		const before = server.state.requests.length;
		await expect(
			client.messages.send({ from: "+12125551000", to: "+14155551000", clientState: "x" }),
		).rejects.toBeInstanceOf(TelnyxMessageRequestError);
		expect(server.state.requests.length).toBe(before);
	});

	/**
	 * The fax precedent, enforced: one attempt and no more. A retried send is a second message on
	 * someone's handset and a second bill.
	 */
	it("never retries a send, even on a 500", async () => {
		const client = makeClient();
		server.state.failNext(500);
		await expect(
			client.messages.send({
				from: "+12125551000",
				to: "+14155551000",
				text: "hi",
				clientState: "no_retry",
			}),
		).rejects.toBeInstanceOf(TelnyxApiError);
		expect(server.state.requests.filter((entry) => entry.path === "/messages")).toHaveLength(1);
		expect(server.state.messages.size).toBe(0);
	});

	it("reads a message back by id", async () => {
		const client = makeClient();
		const sent = await client.messages.send({
			from: "+12125551000",
			to: "+14155551000",
			text: "hi",
			clientState: "read_back",
		});
		expect((await client.messages.get(sent.id)).id).toBe(sent.id);
	});
});

describe("telnyxDeliveryStatus", () => {
	const cases: readonly (readonly [string, TelnyxDeliveryStatus])[] = [
		["queued", "sent"],
		["sending", "sent"],
		["sent", "sent"],
		["delivered", "delivered"],
		["webhook_delivered", "delivered"],
		["sending_failed", "failed"],
		["delivery_failed", "failed"],
		["expired", "failed"],
	];

	for (const [carrier, ours] of cases) {
		it(`maps ${carrier} to ${String(ours)}`, () => {
			expect(telnyxDeliveryStatus({ direction: "outbound", to: [{ status: carrier }] })).toBe(ours);
		});
	}

	it("calls any inbound message received, whatever the recipient status says", () => {
		expect(
			telnyxDeliveryStatus({ direction: "inbound", to: [{ status: "delivery_failed" }] }),
		).toBe("received");
	});

	it("reports a fan-out worst-first", () => {
		expect(
			telnyxDeliveryStatus({
				direction: "outbound",
				to: [{ status: "delivered" }, { status: "delivery_failed" }],
			}),
		).toBe("failed");
		expect(
			telnyxDeliveryStatus({
				direction: "outbound",
				to: [{ status: "delivered" }, { status: "sending" }],
			}),
		).toBe("sent");
	});

	it("is undefined when no recipient carries a status yet", () => {
		expect(telnyxDeliveryStatus({ direction: "outbound", to: [{}] })).toBeUndefined();
	});
});

describe("messageFromE164", () => {
	it("reads both the outbound string and the inbound object", () => {
		expect(messageFromE164("+12125551000")).toBe("+12125551000");
		expect(messageFromE164({ phone_number: "+12125551000", carrier: "X" })).toBe("+12125551000");
		expect(messageFromE164(undefined)).toBeUndefined();
		expect(messageFromE164("")).toBeUndefined();
	});
});

describe("asMessageWebhook", () => {
	function envelope(eventType: string, payload: unknown) {
		return {
			data: {
				record_type: "event",
				event_type: eventType,
				id: "11111111-1111-1111-1111-111111111111",
				occurred_at: "2026-01-01T00:00:00Z",
				payload,
			},
			meta: { attempt: 1, delivered_to: "https://example.test/hook" },
		};
	}

	it("narrows a message.finalized delivery and exposes the per-recipient status", () => {
		const event = parseTelnyxWebhookEvent(
			envelope(TELNYX_MESSAGE_EVENTS.finalized, {
				id: "msg-1",
				direction: "outbound",
				to: [{ phone_number: "+14155551000", status: "delivered" }],
				client_state: "sms_row_1",
			}),
		);
		const webhook = asMessageWebhook(event as never);
		expect(webhook?.message.client_state).toBe("sms_row_1");
		expect(telnyxDeliveryStatus(webhook?.message as never)).toBe("delivered");
	});

	it("returns undefined for a non-message event and for a payload missing direction", () => {
		const other = parseTelnyxWebhookEvent(
			envelope("fax.delivered", { fax_id: "f", direction: "outbound", status: "delivered" }),
		);
		expect(asMessageWebhook(other as never)).toBeUndefined();
		const malformed = parseTelnyxWebhookEvent(
			envelope(TELNYX_MESSAGE_EVENTS.received, { id: "msg-2" }),
		);
		expect(asMessageWebhook(malformed as never)).toBeUndefined();
	});

	it("knows its own event types and nothing else", () => {
		expect(isTelnyxMessageEvent("message.received")).toBe(true);
		expect(isTelnyxMessageEvent("message.exploded")).toBe(false);
	});
});
