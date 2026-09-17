import { z } from "zod";
import { TelnyxError } from "../errors";
import { dataEnvelope, telnyxTimestamp } from "../schemas";
import type { TelnyxTransport } from "../transport";

/**
 * `POST /v2/messages` and its read — Telnyx Programmable Messaging (SMS/MMS).
 *
 * ## Sending a message spends money and is not idempotent — the fax precedent
 *
 * `resources/faxes.ts` states the rule and this module inherits it verbatim: there is no
 * `Idempotency-Key` on `POST /v2/messages` (Telnyx honours that header on seven email/storage
 * endpoints only, see `resources/number-orders.ts`), so a retried send is a **second message** —
 * a second bill and a duplicate delivered to a consumer's handset, which is the one carrier-side
 * side effect a user notices and complains about. The request therefore goes out with
 * `retryable: false`, and every send carries a caller-supplied `clientState` that Telnyx echoes on
 * every `message.*` webhook, so an ambiguous send is reconciled by webhook or by `get(messageId)`
 * rather than by sending again.
 *
 * ## Delivery status does not live where you would look for it
 *
 * There is no top-level `status` on a message. Telnyx fans a message out per recipient, so the
 * delivery state is `to[].status`, one entry per destination. {@link telnyxDeliveryStatus} is the
 * single place that vocabulary is translated into ours; see its own comment for the table.
 *
 * ## `from` is polymorphic
 *
 * On an outbound message `from` is a string; on an inbound one (and on the `message.received`
 * webhook) it is an object carrying `phone_number` plus carrier metadata. The schema models it as
 * `z.unknown()` rather than a union, and {@link messageFromE164} normalises it — a union here
 * would make an unmodelled third shape a hard parse failure on the receive path, which the
 * `schemas.ts` policy exists to prevent.
 */

/** The two directions a message record can have; required, because inbound and outbound are filed
 * into different mailboxes and guessing wrong misattributes a conversation. */
export const TELNYX_MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;
export type TelnyxMessageDirection = (typeof TELNYX_MESSAGE_DIRECTIONS)[number];

/** What Telnyx will accept as a message `type`. Omitted on send, Telnyx infers it from `media_urls`. */
export const TELNYX_MESSAGE_TYPES = ["SMS", "MMS"] as const;
export type TelnyxMessageType = (typeof TELNYX_MESSAGE_TYPES)[number];

/**
 * Telnyx's per-recipient delivery vocabulary, as it appears in `to[].status`.
 *
 * Listed rather than enforced, per the `schemas.ts` policy — a member Telnyx adds must not break a
 * read. {@link telnyxDeliveryStatus} maps these onto our four.
 */
export const TELNYX_MESSAGE_TO_STATUSES = [
	"queued",
	"sending",
	"sent",
	"delivered",
	"sending_failed",
	"delivery_failed",
	"expired",
	"webhook_delivered",
] as const;
export type TelnyxMessageToStatus = (typeof TELNYX_MESSAGE_TO_STATUSES)[number];

/**
 * The webhook `event_type` strings Telnyx sends for messaging, mapped by the moment they mark.
 *
 * `message.received` is the only inbound one. `message.sent` marks hand-off to the carrier and
 * `message.finalized` marks the terminal per-recipient outcome — which is why neither event type
 * tells you whether delivery succeeded: that is in `to[].status`, read by
 * {@link telnyxDeliveryStatus}.
 */
export const TELNYX_MESSAGE_EVENTS = {
	received: "message.received",
	sent: "message.sent",
	finalized: "message.finalized",
} as const;
export type TelnyxMessageEventType =
	(typeof TELNYX_MESSAGE_EVENTS)[keyof typeof TELNYX_MESSAGE_EVENTS];

/** Every message `event_type` this integration understands, for the consumer's membership check. */
export const TELNYX_MESSAGE_EVENT_TYPES = Object.values(
	TELNYX_MESSAGE_EVENTS,
) as readonly TelnyxMessageEventType[];

/** `true` for a message event type this client models. */
export function isTelnyxMessageEvent(eventType: string): eventType is TelnyxMessageEventType {
	return (TELNYX_MESSAGE_EVENT_TYPES as readonly string[]).includes(eventType);
}

/** One `to[]` entry: the destination and, crucially, its own delivery status. */
export const telnyxMessageRecipientSchema = z.looseObject({
	phone_number: z.string().optional(),
	status: z.string().optional(),
	carrier: z.string().nullish(),
	line_type: z.string().nullish(),
});

export type TelnyxMessageRecipient = z.infer<typeof telnyxMessageRecipientSchema>;

/**
 * The message object, returned by send and by read.
 *
 * Required iff we persist it or branch on it: `id` correlates the row and `direction` files it.
 * There is deliberately no required `status` — the field does not exist at the top level.
 */
export const telnyxMessageSchema = z.looseObject({
	id: z.string(),
	direction: z.string(),
	record_type: z.string().optional(),
	type: z.string().optional(),
	/**
	 * String outbound, object inbound. Normalise with {@link messageFromE164}.
	 *
	 * `.optional()` is load-bearing: in zod 4 a bare `z.unknown()` key is REQUIRED, so without it a
	 * payload that happens to omit `from` — which the `message.finalized` webhook does — fails the
	 * parse and the whole event is dropped as unmodelled.
	 */
	from: z.unknown().optional(),
	to: z.array(telnyxMessageRecipientSchema).optional(),
	text: z.string().nullish(),
	media: z.array(z.looseObject({})).optional(),
	parts: z.number().nullish(),
	encoding: z.string().nullish(),
	cost: z.looseObject({}).nullish(),
	errors: z.array(z.looseObject({})).optional(),
	messaging_profile_id: z.string().nullish(),
	received_at: telnyxTimestamp.nullish(),
	sent_at: telnyxTimestamp.nullish(),
	completed_at: telnyxTimestamp.nullish(),
	webhook_url: z.string().nullish(),
	client_state: z.string().nullish(),
	organization_id: z.string().nullish(),
	valid_until: telnyxTimestamp.nullish(),
	tags: z.array(z.string()).optional(),
});

export type TelnyxMessage = z.infer<typeof telnyxMessageSchema>;

/**
 * The `payload` inside a `message.*` webhook envelope.
 *
 * Same shape as the object above, which is unlike fax (whose payload renames `id` to `fax_id`).
 * `id` and `direction` are required for the same reason: they correlate the row and branch the
 * handler, and a payload missing either is one this integration does not model, so
 * `asMessageWebhook` returns `undefined` and the consumer 200s it.
 *
 * Note again: the DELIVERY status is `to[].status`, per recipient. There is no top-level `status`
 * to read, and a handler that invents one will report every message as unknown.
 */
export const telnyxMessageWebhookPayloadSchema = telnyxMessageSchema;

export type TelnyxMessageWebhookPayload = z.infer<typeof telnyxMessageWebhookPayloadSchema>;

const messageResponse = dataEnvelope(telnyxMessageSchema);

/**
 * The E.164 number a message came from, whichever of the two shapes Telnyx used.
 *
 * `undefined` when neither shape is present, rather than an empty string — "we do not know the
 * sender" and "the sender is blank" are different things to store.
 */
export function messageFromE164(from: unknown): string | undefined {
	if (typeof from === "string") {
		return from.length === 0 ? undefined : from;
	}
	if (typeof from === "object" && from !== null) {
		const candidate = (from as { phone_number?: unknown }).phone_number;
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}
	return undefined;
}

/** Our four-state delivery vocabulary. The API layer stores this, never Telnyx's eight. */
export type TelnyxDeliveryStatus = "sent" | "delivered" | "failed" | "received";

/**
 * Collapses `direction` plus the per-recipient `to[].status` list onto our four states.
 *
 * This is the ONE place the two vocabularies are translated; everything above it stores the result.
 * The mapping:
 *
 * | Telnyx `to[].status`                       | ours        | why                                        |
 * | ------------------------------------------ | ----------- | ------------------------------------------ |
 * | `delivered`, `webhook_delivered`           | `delivered` | the handset (or the receiving webhook) has it |
 * | `sent`                                     | `sent`      | with the carrier, outcome not yet known    |
 * | `queued`, `sending`                        | `sent`      | in flight; not a distinct user-visible state |
 * | `sending_failed`, `delivery_failed`, `expired` | `failed` | terminal, no retry will change it          |
 *
 * Any inbound message is `received` regardless of `to[]` — the `to[]` on an inbound message is
 * *our* number, and its status describes our own receipt, not a delivery we performed.
 *
 * Multiple recipients are reduced worst-first: a single `failed` makes the message `failed`, then
 * `sent` beats `delivered`, so a fan-out is never reported as fully delivered while one leg is
 * still moving. `undefined` when no recipient carries a status Telnyx has filled in yet.
 */
export function telnyxDeliveryStatus(
	payload: Pick<TelnyxMessage, "direction" | "to">,
): TelnyxDeliveryStatus | undefined {
	if (payload.direction === "inbound") {
		return "received";
	}
	let sawSent = false;
	let sawDelivered = false;
	for (const recipient of payload.to ?? []) {
		switch (recipient.status) {
			case "sending_failed":
			case "delivery_failed":
			case "expired":
				return "failed";
			case "delivered":
			case "webhook_delivered":
				sawDelivered = true;
				break;
			case "sent":
			case "queued":
			case "sending":
				sawSent = true;
				break;
			default:
				break;
		}
	}
	if (sawSent) {
		return "sent";
	}
	if (sawDelivered) {
		return "delivered";
	}
	return undefined;
}

/**
 * `POST /v2/messages` input.
 *
 * At least one of `text` / `mediaUrls` must be present — Telnyx rejects a send with neither, and
 * unlike fax both together is legal (an MMS with a caption). That is checked here, before the
 * round trip, by {@link assertMessageContent}.
 */
export interface SendMessageInput {
	/** An E.164 number on a messaging profile, or an alphanumeric sender id where permitted. */
	readonly from: string;
	readonly to: string;
	readonly text?: string;
	readonly mediaUrls?: readonly string[];
	readonly messagingProfileId?: string;
	/** MMS only; ignored on an SMS. */
	readonly subject?: string;
	readonly webhookUrl?: string;
	/** Our correlation token. Echoed on every `message.*` webhook. Required by this client. */
	readonly clientState: string;
	readonly useProfileWebhooks?: boolean;
	readonly type?: TelnyxMessageType;
}

/** Raised for a send whose content is missing, before any network call. */
export class TelnyxMessageRequestError extends TelnyxError {
	readonly field: string;
	constructor(field: string, detail: string) {
		super(`Telnyx message request invalid (${field}): ${detail}`);
		this.field = field;
	}
}

/** Throws unless at least one of `text` / `mediaUrls` carries content. */
export function assertMessageContent(input: Pick<SendMessageInput, "text" | "mediaUrls">): void {
	const hasText = input.text !== undefined && input.text.length > 0;
	const hasMedia = input.mediaUrls !== undefined && input.mediaUrls.length > 0;
	if (!hasText && !hasMedia) {
		throw new TelnyxMessageRequestError("text", "at least one of text or media_urls is required");
	}
}

export interface MessagesResource {
	/**
	 * Send an SMS or MMS. Returns the message with its carrier id; delivery is asynchronous and
	 * reported over the `message.*` webhooks. Never auto-retries — a repeat is a second message and
	 * a second bill. See the module header.
	 */
	readonly send: (input: SendMessageInput) => Promise<TelnyxMessage>;
	/** Read a message back by its carrier id — the reconciliation path after an ambiguous send. */
	readonly get: (messageId: string) => Promise<TelnyxMessage>;
}

export function makeMessages(transport: TelnyxTransport): MessagesResource {
	return {
		send: async (input) => {
			assertMessageContent(input);
			const response = await transport.request({
				method: "POST",
				path: "/messages",
				// See the header, and `resources/faxes.ts` before it: a retried send is a second
				// message on someone's handset, so a dead socket is resolved by reading, never by
				// sending again.
				retryable: false,
				body: {
					from: input.from,
					to: input.to,
					...(input.text === undefined ? {} : { text: input.text }),
					...(input.mediaUrls === undefined ? {} : { media_urls: [...input.mediaUrls] }),
					...(input.messagingProfileId === undefined
						? {}
						: { messaging_profile_id: input.messagingProfileId }),
					...(input.subject === undefined ? {} : { subject: input.subject }),
					...(input.webhookUrl === undefined ? {} : { webhook_url: input.webhookUrl }),
					...(input.useProfileWebhooks === undefined
						? {}
						: { use_profile_webhooks: input.useProfileWebhooks }),
					...(input.type === undefined ? {} : { type: input.type }),
					client_state: input.clientState,
				},
				schema: messageResponse,
			});
			return response.data;
		},

		get: async (messageId) => {
			const response = await transport.request({
				method: "GET",
				path: `/messages/${encodeURIComponent(messageId)}`,
				schema: messageResponse,
			});
			return response.data;
		},
	};
}
