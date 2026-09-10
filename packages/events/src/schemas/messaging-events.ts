import { z } from "zod";
import { subjectFor, type MessagingEvent } from "../subjects";
import { defineEvent, makeEvent, type EventInput } from "./envelope";

/**
 * Messaging events — `messaging.evt.v1.<orgId>.<conversationId>.<event>`.
 *
 * `conversationId` is subject-carried and therefore absent from the payloads, on the same rule as
 * `mailboxId`, `queueId` and `callId`: one copy, in the address. A consumer that needs it reads it
 * back with `parseSubject`.
 *
 * ## Why `message.delivered` also carries `failed`
 *
 * A carrier delivery receipt is ONE fact with an outcome attached — the network has finished
 * trying, and here is how it went. Splitting it into `message.delivered` and `message.failed`
 * would make a consumer subscribe twice in order to learn one thing, and every one of them would
 * merge the two subjects straight back into a single "what happened to my message" row. It is the
 * argument `number_order.complete` makes in `packages/telnyx`, which reports a failed order on the
 * same event type its successes arrive on: branch on the PAYLOAD, not on the event type. `status`
 * is the field to branch on, and `errorReason` is populated exactly when it says `failed`.
 *
 * ## Why the inbound carries no message body beyond 4096 characters and no media bytes
 *
 * An event on this backbone is a NOTIFICATION, not a transfer. The content of a message — the full
 * body, and every MMS attachment — is fetched from the API by the consumer, under the tenant's own
 * permissions, which is the only place those permissions are actually checked. Putting the bytes on
 * the wire would move a per-tenant authorization decision onto a stream that is retained for thirty
 * days, replayed on every consumer restart and sized in gigabytes; `mediaCount` is enough for a
 * screen-pop to render "2 attachments" and to decide whether the fetch is worth making.
 *
 * The 4096-character ceiling on `body` is the same argument at a smaller scale: a concatenated SMS
 * has a practical ceiling far below it, so the bound never truncates real traffic, and it is what
 * stops one pathological message from setting the stream's per-message size.
 */

/**
 * `message.received` — an inbound SMS/MMS arrived on one of the tenant's messaging numbers.
 *
 * `messagingNumberId` is the row id of the number it arrived ON, not the number itself: a tenant
 * may re-present or re-label a number, and a consumer that filed rows against the digits would
 * split one number's history in two.
 */
export const messagingMessageReceivedDataSchema = z.object({
	/** UUID v7, minted by the ingesting service. The insert's idempotency key. */
	messageId: z.uuidv7(),
	/** The `messaging_number` row the message arrived on. */
	messagingNumberId: z.uuid(),
	fromE164: z.string().min(1).max(32),
	toE164: z.string().min(1).max(32),
	kind: z.enum(["SMS", "MMS"]),
	/** Truncated at the ceiling above; the authoritative copy is fetched from the API. */
	body: z.string().max(4096).optional(),
	/** How many attachments the message carries. The bytes are never on this wire. */
	mediaCount: z.int().min(0).optional(),
	receivedAt: z.iso.datetime(),
	/**
	 * `STOP`, `HELP`, `START` and friends, when the inbound WAS one.
	 *
	 * Present so a consumer can tell a conversation turn from a compliance instruction without
	 * re-implementing keyword matching: an opt-out is handled by the platform and must NOT
	 * screen-pop into an agent's CRM as if the customer had said something to them.
	 */
	complianceKeyword: z.string().max(32).optional(),
	/** The carrier's own id for the message, for a support ticket that starts at the carrier. */
	carrierMessageId: z.string().max(128).optional(),
});

/**
 * `message.delivered` — the carrier reported the final outcome of an OUTBOUND message.
 *
 * See the header: `failed` rides this event rather than one of its own. `segments` is what the
 * carrier actually billed, which is the number a tenant's invoice is reconciled against and is not
 * derivable from a body this event does not carry.
 */
export const messagingMessageDeliveredDataSchema = z.object({
	/** The same `messageId` the send minted, so the receipt joins its message without a lookup. */
	messageId: z.uuidv7(),
	messagingNumberId: z.uuid(),
	fromE164: z.string().min(1).max(32),
	toE164: z.string().min(1).max(32),
	/** The outcome. `sent` is accepted-by-carrier; `delivered` and `failed` are terminal. */
	status: z.enum(["sent", "delivered", "failed"]),
	/** Billed segments, as the carrier counted them. */
	segments: z.int().min(0).optional(),
	/** The carrier's failure text. Populated exactly when `status` is `failed`. */
	errorReason: z.string().max(512).optional(),
	occurredAt: z.iso.datetime(),
	carrierMessageId: z.string().max(128).optional(),
});

export const MESSAGING_EVENT_DEFINITIONS = {
	"message.received": defineEvent(
		"messaging",
		"message.received",
		messagingMessageReceivedDataSchema,
	),
	"message.delivered": defineEvent(
		"messaging",
		"message.delivered",
		messagingMessageDeliveredDataSchema,
	),
} as const;

export type MessagingEventDefinitions = typeof MESSAGING_EVENT_DEFINITIONS;

export type MessagingEventOf<TType extends MessagingEvent> = z.infer<
	MessagingEventDefinitions[TType]["envelope"]
>;

export type MessagingEventDataOf<TType extends MessagingEvent> = z.infer<
	MessagingEventDefinitions[TType]["data"]
>;

export type MessagingMessageReceivedData = z.infer<typeof messagingMessageReceivedDataSchema>;
export type MessagingMessageDeliveredData = z.infer<typeof messagingMessageDeliveredDataSchema>;

/** Every messaging event as one discriminated union. */
export const messagingEventSchema = z.discriminatedUnion("type", [
	MESSAGING_EVENT_DEFINITIONS["message.received"].envelope,
	MESSAGING_EVENT_DEFINITIONS["message.delivered"].envelope,
]);

export type MessagingEventEnvelope = z.infer<typeof messagingEventSchema>;

export interface MessagingEventInput<TType extends MessagingEvent> extends Omit<
	EventInput<MessagingEventDataOf<TType>>,
	"subject"
> {
	/** The thread this message belongs to. Becomes the subject's middle token. */
	readonly conversationId: string;
}

/**
 * Builds and validates a messaging event, deriving
 * `messaging.evt.v1.<orgId>.<conversationId>.<type>`.
 */
export function makeMessagingEvent<TType extends MessagingEvent>(
	type: TType,
	input: MessagingEventInput<TType>,
): MessagingEventOf<TType> {
	const definition = MESSAGING_EVENT_DEFINITIONS[type];
	const subject = subjectFor.messaging(input.orgId, input.conversationId, type);
	// See the note in `makeCallEvent`: the record index and the payload are correlated by `type`.
	return makeEvent(definition, { ...input, subject } as never) as MessagingEventOf<TType>;
}
