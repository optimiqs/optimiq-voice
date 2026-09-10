import {
	asMessageWebhook,
	messageFromE164,
	parseTelnyxWebhookEvent,
	TELNYX_SIGNATURE_HEADER,
	TELNYX_TIMESTAMP_HEADER,
	telnyxDeliveryStatus,
	TelnyxApiError,
	TelnyxMessageRequestError,
	TelnyxSignatureError,
	verifyTelnyxWebhook,
} from "@optimiq-voice/telnyx";
import {
	MessagingSendError,
	MessagingWebhookAuthError,
	type MessagingProvider,
	type ProviderSendInput,
	type ProviderSendResult,
	type ProviderWebhookEvent,
	type ProviderWebhookRequest,
} from "./messaging-provider.port";
import type { TelnyxClient, TelnyxMessage } from "@optimiq-voice/telnyx";

/**
 * Telnyx behind the messaging port.
 *
 * A thin adapter, and thin is the point: the carrier package already owns the HTTP, the schemas, the
 * retry policy and the Ed25519 verifier. What is left here is exactly the translation the domain
 * must never do for itself —
 *
 * - Telnyx's per-recipient status vocabulary (`queued`, `sending`, `sent`, `delivered`,
 *   `sending_failed`, `delivery_failed`, `expired`, `webhook_delivered`) into this platform's four.
 *   The mapping lives in `telnyxDeliveryStatus` in the carrier package, next to the field names it
 *   reads; this file only calls it.
 * - Telnyx's errors into a `permanent` flag the send worker can branch on.
 * - The v2 webhook envelope into the port's two shapes.
 *
 * # Why the media limit is not enforced here
 *
 * `fetchMedia` returns whatever the carrier served, and the CALLER applies the cap and the
 * allow-list. That looks like the wrong place until you notice the alternative: a limit inside the
 * adapter is a limit the fake provider does not have, so a test would pass against a double that was
 * more permissive than production. One cap, in `messaging-inbound.service.ts`, applied to bytes from
 * any provider.
 */
export class TelnyxMessagingProvider implements MessagingProvider {
	readonly name = "telnyx";

	constructor(
		private readonly client: TelnyxClient,
		/** The account's base64 Ed25519 webhook public key, from the portal. */
		private readonly publicKey: string,
		/** Where Telnyx should send this message's receipts. Absent uses the profile's own URL. */
		private readonly webhookUrl: string | undefined,
	) {}

	async send(input: ProviderSendInput): Promise<ProviderSendResult> {
		try {
			const sent = await this.client.messages.send({
				from: input.from,
				to: input.to,
				...(input.text === undefined ? {} : { text: input.text }),
				...(input.mediaUrls === undefined || input.mediaUrls.length === 0
					? {}
					: { mediaUrls: input.mediaUrls }),
				...(input.messagingProfileId === undefined
					? {}
					: { messagingProfileId: input.messagingProfileId }),
				...(this.webhookUrl === undefined ? {} : { webhookUrl: this.webhookUrl }),
				clientState: input.clientState,
			});
			return {
				carrierMessageId: sent.id,
				...(typeof sent.parts === "number" ? { segments: sent.parts } : {}),
			};
		} catch (error) {
			throw asSendError(error);
		}
	}

	async parseWebhook(request: ProviderWebhookRequest): Promise<ProviderWebhookEvent | undefined> {
		try {
			verifyTelnyxWebhook({
				// The EXACT bytes. `main.ts` sets `rawBody: true` for this reason; a re-serialised body
				// is not the signed body, and the verifier refuses to accept one.
				rawBody: request.rawBody,
				signature: request.headers[TELNYX_SIGNATURE_HEADER],
				timestamp: request.headers[TELNYX_TIMESTAMP_HEADER],
				publicKey: this.publicKey,
			});
		} catch (error) {
			if (error instanceof TelnyxSignatureError) {
				throw new MessagingWebhookAuthError(error.reason, error.message);
			}
			throw error;
		}

		const event = parseTelnyxWebhookEvent(JSON.parse(request.rawBody.toString("utf8")) as unknown);
		if (event === undefined) {
			return undefined;
		}
		const narrowed = asMessageWebhook(event);
		if (narrowed === undefined) {
			// Signed by Telnyx and not a `message.*` event — a fax or a number order arriving on this
			// route. `undefined`, which the route 200s.
			return undefined;
		}

		const payload = narrowed.message;
		const occurredAt = parseDate(event.occurredAt);
		if (payload.direction === "inbound") {
			const from = messageFromE164(payload.from);
			const to = firstRecipient(payload.to);
			if (from === undefined || to === undefined) {
				// A message with no identifiable pair is one this platform cannot file. Logged and 200'd
				// by the route rather than failed, because a retry produces the same body.
				return undefined;
			}
			return {
				kind: "inbound",
				message: {
					carrierMessageId: payload.id,
					from,
					to,
					...(typeof payload.text === "string" && payload.text.length > 0
						? { text: payload.text }
						: {}),
					...(mediaUrlsOf(payload).length === 0 ? {} : { mediaUrls: mediaUrlsOf(payload) }),
					receivedAt: parseDate(payload.received_at) ?? occurredAt ?? new Date(),
				},
			};
		}

		const status = telnyxDeliveryStatus(payload as Pick<TelnyxMessage, "direction" | "to">);
		if (status === undefined || status === "received") {
			// `message.sent` for a message whose recipients report nothing actionable yet. Not an
			// error, just not a transition.
			return undefined;
		}
		return {
			kind: "receipt",
			receipt: {
				carrierMessageId: payload.id,
				...(typeof payload.client_state === "string"
					? { clientState: decodeClientState(payload.client_state) }
					: {}),
				status,
				...(typeof payload.parts === "number" ? { segments: payload.parts } : {}),
				...(errorReasonOf(payload) === undefined ? {} : { errorReason: errorReasonOf(payload) }),
				occurredAt: occurredAt ?? new Date(),
			},
		};
	}

	async fetchMedia(url: string): Promise<{ bytes: Buffer; contentType: string | undefined }> {
		// A plain fetch: Telnyx serves MMS media from a signed, time-limited URL that carries its own
		// authorization, so the API key must NOT be attached — sending it to a host named in a webhook
		// body would be handing a credential to whatever that body pointed at.
		const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) {
			throw new Error(`messaging media download failed: ${String(response.status)}`);
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		return { bytes, contentType: response.headers.get("content-type") ?? undefined };
	}

	async setNumberMessagingProfile(
		carrierNumberRef: string,
		messagingProfileId: string | null,
	): Promise<void> {
		await this.client.messagingProfiles.assignPhoneNumber(carrierNumberRef, messagingProfileId);
	}
}

/**
 * Turns a carrier failure into one the send worker can branch on.
 *
 * The rule: a 4xx that is not a rate limit is PERMANENT — the request is wrong and repeating it
 * produces the same refusal. Everything else (5xx, 429, a socket error, a timeout) is transient.
 * `TelnyxMessageRequestError` is raised before any network call and is permanent by construction.
 */
function asSendError(error: unknown): MessagingSendError {
	if (error instanceof TelnyxMessageRequestError) {
		return new MessagingSendError(error.message, true);
	}
	if (error instanceof TelnyxApiError) {
		const status = (error as { readonly status?: unknown }).status;
		const permanent = typeof status === "number" && status >= 400 && status < 500 && status !== 429;
		return new MessagingSendError(error.message, permanent);
	}
	return new MessagingSendError(error instanceof Error ? error.message : String(error), false);
}

function firstRecipient(to: unknown): string | undefined {
	if (!Array.isArray(to)) {
		return undefined;
	}
	for (const entry of to) {
		const candidate = (entry as { phone_number?: unknown } | null)?.phone_number;
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}
	return undefined;
}

function mediaUrlsOf(payload: { readonly media?: unknown }): readonly string[] {
	if (!Array.isArray(payload.media)) {
		return [];
	}
	const urls: string[] = [];
	for (const entry of payload.media) {
		const candidate = (entry as { url?: unknown } | null)?.url;
		if (typeof candidate === "string" && candidate.length > 0) {
			urls.push(candidate);
		}
	}
	return urls;
}

/** The carrier's own sentence for a failure, joined when it sent several. Never paraphrased. */
function errorReasonOf(payload: { readonly errors?: unknown }): string | undefined {
	if (!Array.isArray(payload.errors) || payload.errors.length === 0) {
		return undefined;
	}
	const parts = payload.errors
		.map((entry) => {
			const detail = (entry as { detail?: unknown; title?: unknown } | null) ?? {};
			const text = typeof detail.detail === "string" ? detail.detail : detail.title;
			return typeof text === "string" ? text : undefined;
		})
		.filter((entry): entry is string => entry !== undefined);
	return parts.length === 0 ? undefined : parts.join("; ");
}

/**
 * The message id inside a `client_state`.
 *
 * We SET the row id, but what comes back is whatever the carrier echoes, and Telnyx documents
 * `client_state` as base64 — so the raw value is tried first and a decode second. The caller
 * validates the result is a UUID before it reaches a `uuid` column.
 */
function decodeClientState(value: string): string {
	const decoded = Buffer.from(value, "base64").toString("utf8").trim();
	return /^[0-9a-f-]{36}$/iu.test(decoded) ? decoded : value;
}

function parseDate(value: unknown): Date | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
