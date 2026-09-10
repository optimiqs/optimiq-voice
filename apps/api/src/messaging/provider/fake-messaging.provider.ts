import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
	MessagingSendError,
	MessagingWebhookAuthError,
	type MessagingProvider,
	type ProviderInboundMessage,
	type ProviderSendInput,
	type ProviderSendResult,
	type ProviderWebhookEvent,
	type ProviderWebhookRequest,
} from "./messaging-provider.port";

/**
 * An in-process carrier for messaging.
 *
 * # What it is for
 *
 * Two jobs, and they are the reason the port exists at all. In the api tests it is the thing that
 * makes a send assertable without a network. On the local stack it is what makes the whole feature
 * *provable* — an inbound message can be pushed at the running API and read back out of the inbox in
 * a browser, and a send from that browser lands somewhere a human can point at — none of which is
 * possible against the real Telnyx without an account, a registered brand, and a publicly reachable
 * webhook URL.
 *
 * # What it is faithful about, and what it is not
 *
 * Faithful about the four things the platform's correctness depends on:
 *
 * 1. **A send is accepted, not delivered.** `send` returns a carrier id and nothing else; the
 *    outcome arrives later, as a receipt, exactly as it does from a real carrier. Code that treated
 *    the resolved promise as delivery would pass against a fake that lied and fail in production.
 * 2. **Webhooks are signed.** The signature is HMAC-SHA256 over `${timestamp}|${rawBody}` — not
 *    Telnyx's Ed25519, because reproducing that would mean shipping a private key in a test double —
 *    but the SHAPE is identical: raw bytes, a timestamp window, a constant-time compare, and a
 *    refusal that names its reason. A receiver written against this cannot be one that forgot to
 *    verify.
 * 3. **Redelivery happens.** `deliver()` can be called twice with the same carrier id, because
 *    carriers retry anything they did not get a 200 for, and an inbox that files a message twice is
 *    one an agent stops trusting on day one.
 * 4. **Refusals are typed.** `failNext` queues a permanent or transient {@link MessagingSendError},
 *    which is how the send worker's retry-versus-abandon branch is driven without waiting out a
 *    real carrier outage.
 *
 * Not faithful about: throughput, segmentation, encoding, cost, or carrier filtering. Nothing in
 * this platform branches on any of them.
 */

export interface FakeSentMessage {
	readonly carrierMessageId: string;
	readonly from: string;
	readonly to: string;
	readonly text: string | undefined;
	readonly mediaUrls: readonly string[];
	readonly clientState: string;
	readonly sentAt: Date;
}

export interface FakeMessagingOptions {
	/** The shared secret the fake signs its webhooks with. Also what the receiver verifies against. */
	readonly webhookSecret?: string;
	/** Seeded media, keyed by the URL the fake hands out. */
	readonly media?: ReadonlyMap<string, { readonly bytes: Buffer; readonly contentType: string }>;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

export class FakeMessagingProvider implements MessagingProvider {
	readonly name = "fake";

	/** Every send this provider accepted, newest last. The test's and the proof's assertion surface. */
	readonly sent: FakeSentMessage[] = [];
	/** DIDs attached to a carrier messaging profile, so the enable path is observable. */
	readonly profileAttachments = new Map<string, string | null>();

	private readonly secret: string;
	private readonly media: Map<string, { bytes: Buffer; contentType: string }>;
	private readonly failures: MessagingSendError[] = [];

	constructor(options: FakeMessagingOptions = {}) {
		this.secret = options.webhookSecret ?? "fake-messaging-secret";
		this.media = new Map(options.media ?? []);
	}

	// ---- the port ----------------------------------------------------------------------------

	async send(input: ProviderSendInput): Promise<ProviderSendResult> {
		const queued = this.failures.shift();
		if (queued !== undefined) {
			throw queued;
		}
		if ((input.text ?? "").length === 0 && (input.mediaUrls ?? []).length === 0) {
			// The carrier's own refusal, reproduced: a message with neither text nor media is not a
			// message. Permanent, because retrying an empty body produces an empty body.
			throw new MessagingSendError("a message must carry text or media", true);
		}
		const carrierMessageId = `fake-msg-${randomUUID()}`;
		this.sent.push({
			carrierMessageId,
			from: input.from,
			to: input.to,
			text: input.text,
			mediaUrls: [...(input.mediaUrls ?? [])],
			clientState: input.clientState,
			sentAt: new Date(),
		});
		return { carrierMessageId, segments: segmentsFor(input.text) };
	}

	async parseWebhook(request: ProviderWebhookRequest): Promise<ProviderWebhookEvent | undefined> {
		this.verify(request);
		const body = JSON.parse(request.rawBody.toString("utf8")) as Record<string, unknown>;
		const kind = body.kind;
		if (kind === "inbound") {
			return {
				kind: "inbound",
				message: {
					carrierMessageId: String(body.carrierMessageId ?? ""),
					from: String(body.from ?? ""),
					to: String(body.to ?? ""),
					text: typeof body.text === "string" ? body.text : undefined,
					mediaUrls: Array.isArray(body.mediaUrls) ? (body.mediaUrls as string[]) : undefined,
					receivedAt: parseDate(body.receivedAt),
				},
			};
		}
		if (kind === "receipt") {
			const status = body.status;
			if (status !== "sent" && status !== "delivered" && status !== "failed") {
				return undefined;
			}
			return {
				kind: "receipt",
				receipt: {
					carrierMessageId: String(body.carrierMessageId ?? ""),
					clientState: typeof body.clientState === "string" ? body.clientState : undefined,
					status,
					segments: typeof body.segments === "number" ? body.segments : undefined,
					errorReason: typeof body.errorReason === "string" ? body.errorReason : undefined,
					occurredAt: parseDate(body.occurredAt),
				},
			};
		}
		// Signed by the fake, but not a shape this platform models. `undefined`, which the route 200s
		// — the same contract the real adapter has, so the route cannot be written to depend on the
		// fake being stricter than a carrier.
		return undefined;
	}

	async fetchMedia(url: string): Promise<{ bytes: Buffer; contentType: string | undefined }> {
		const found = this.media.get(url);
		if (found === undefined) {
			throw new Error(`fake messaging media not found: ${url}`);
		}
		return { bytes: found.bytes, contentType: found.contentType };
	}

	async setNumberMessagingProfile(
		carrierNumberRef: string,
		messagingProfileId: string | null,
	): Promise<void> {
		this.profileAttachments.set(carrierNumberRef, messagingProfileId);
	}

	// ---- the test/proof surface -------------------------------------------------------------

	/** Queues one synthetic send failure. Returns `this` so a test reads as a sentence. */
	failNext(message: string, permanent = false): this {
		this.failures.push(new MessagingSendError(message, permanent));
		return this;
	}

	/** Seeds a media URL the ingestion path can download. */
	putMedia(url: string, bytes: Buffer, contentType: string): this {
		this.media.set(url, { bytes, contentType });
		return this;
	}

	/**
	 * Builds a signed webhook body plus its headers, ready to POST at the API.
	 *
	 * Exposed rather than delivered, because the fake has no idea where the API is listening and a
	 * test double that tried to make an HTTP call would be a second thing to configure. The caller —
	 * a test, or the proof script — does the POST.
	 */
	signWebhook(
		payload: Record<string, unknown>,
		at: Date = new Date(),
	): {
		readonly body: string;
		readonly headers: Record<string, string>;
	} {
		const body = JSON.stringify(payload);
		const timestamp = String(Math.floor(at.getTime() / 1_000));
		return {
			body,
			headers: {
				"content-type": "application/json",
				"x-fake-messaging-timestamp": timestamp,
				"x-fake-messaging-signature": this.sign(timestamp, body),
			},
		};
	}

	/** The body+headers for an inbound message. */
	inboundWebhook(message: Omit<ProviderInboundMessage, "receivedAt"> & { receivedAt?: Date }) {
		return this.signWebhook({
			kind: "inbound",
			carrierMessageId: message.carrierMessageId,
			from: message.from,
			to: message.to,
			text: message.text,
			mediaUrls: message.mediaUrls,
			receivedAt: (message.receivedAt ?? new Date()).toISOString(),
		});
	}

	/** The body+headers for a delivery receipt. */
	receiptWebhook(receipt: {
		carrierMessageId: string;
		clientState?: string;
		status: "sent" | "delivered" | "failed";
		errorReason?: string;
		segments?: number;
		occurredAt?: Date;
	}) {
		return this.signWebhook({
			kind: "receipt",
			...receipt,
			occurredAt: (receipt.occurredAt ?? new Date()).toISOString(),
		});
	}

	reset(): void {
		this.sent.length = 0;
		this.failures.length = 0;
		this.profileAttachments.clear();
	}

	// ---- signature ---------------------------------------------------------------------------

	private sign(timestamp: string, body: string): string {
		return createHmac("sha256", this.secret).update(`${timestamp}|${body}`).digest("base64");
	}

	/**
	 * The same three refusals the real verifier makes, in the same order, for the same reasons:
	 * a missing header, a timestamp outside an ABSOLUTE window (a delivery far in the future is as
	 * much a red flag as a stale one, and accepting it hands an attacker a token with a lifetime of
	 * their choosing), and a MAC that does not match — compared in constant time.
	 */
	private verify(request: ProviderWebhookRequest): void {
		const signature = request.headers["x-fake-messaging-signature"];
		const timestamp = request.headers["x-fake-messaging-timestamp"];
		if (signature === undefined || signature.length === 0) {
			throw new MessagingWebhookAuthError("missing-signature");
		}
		if (timestamp === undefined || !/^\d{1,15}$/u.test(timestamp)) {
			throw new MessagingWebhookAuthError("missing-timestamp");
		}
		const skew = Math.abs(Math.floor(Date.now() / 1_000) - Number(timestamp));
		if (skew > DEFAULT_TOLERANCE_SECONDS) {
			throw new MessagingWebhookAuthError("stale-timestamp", `${skew}s`);
		}
		const expected = Buffer.from(this.sign(timestamp, request.rawBody.toString("utf8")), "utf8");
		const presented = Buffer.from(signature, "utf8");
		if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
			throw new MessagingWebhookAuthError("mismatch");
		}
	}
}

/**
 * GSM-7 segmentation, approximated.
 *
 * Approximated on purpose and never used for billing: nothing in this platform branches on the
 * segment count, it is shown to a user as "this will send as N parts" and stored as whatever the
 * carrier finally says. A faithful implementation would need the GSM-7 extension table and the UCS-2
 * fallback, which is a lot of code to make a fake agree with a number we overwrite.
 */
function segmentsFor(text: string | undefined): number {
	const length = (text ?? "").length;
	if (length === 0) {
		return 0;
	}
	return length <= 160 ? 1 : Math.ceil(length / 153);
}

function parseDate(value: unknown): Date {
	const parsed = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
	return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}
