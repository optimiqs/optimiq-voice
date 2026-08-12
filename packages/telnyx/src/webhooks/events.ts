import { z } from "zod";
import {
	type TelnyxFaxEventType,
	type TelnyxFaxWebhookPayload,
	isTelnyxFaxEvent,
	telnyxFaxWebhookPayloadSchema,
} from "../resources/faxes";
import { numberOrderSchema } from "../resources/number-orders";

/**
 * Telnyx webhook bodies, for `webhook_api_version: "2"`.
 *
 * ## Version 2 is not optional
 *
 * Telnyx's default is version `"1"`, which delivers a **different envelope** — flat, with
 * `metadata` rather than `meta` and the event nested under `metadata.event`. This parser
 * understands exactly one of those, so `credential-connections.ts` sets `webhook_api_version: "2"`
 * unconditionally on every connection it creates. A connection created any other way will deliver
 * webhooks this file rejects, which is the correct and visible outcome rather than a silent
 * mis-parse.
 *
 * ## The event types worth handling
 *
 * `number_order.complete` for provisioning, and the `fax.*` family for Programmable Fax. There is
 * no `number_order.status_update` — that string is the *OpenAPI webhook key*, not the value Telnyx
 * puts in `event_type` — and there are **no `phone_number.*` events at all**: number state changes
 * are polled, not pushed.
 *
 * `number_order.complete` fires for both outcomes, so the branch is on
 * `data.payload.status` (`success` | `failure`), never on the event type. Getting that backwards
 * produces a system that treats every failed order as a success. The fax family, by contrast, names
 * the outcome in `event_type` (`fax.delivered` vs `fax.failed`), with the terminal detail — page
 * count, failure reason — in the payload.
 *
 * ## Duplicates are expected
 *
 * Order is not guaranteed and redelivery is normal, so a consumer must dedupe on `data.id`, which
 * is a UUID per delivery-worthy event. That is the receiver's job; this module only parses.
 */

export const TELNYX_NUMBER_ORDER_EVENT = "number_order.complete";

const eventEnvelope = z.looseObject({
	data: z.looseObject({
		record_type: z.string().optional(),
		event_type: z.string(),
		id: z.string(),
		occurred_at: z.string().optional(),
		payload: z.unknown(),
	}),
	meta: z
		.looseObject({
			attempt: z.number().optional(),
			delivered_to: z.string().optional(),
		})
		.optional(),
});

export interface TelnyxWebhookEvent {
	readonly eventType: string;
	/** Per-event UUID. The dedupe key. */
	readonly id: string;
	readonly occurredAt?: string;
	readonly attempt?: number;
	readonly deliveredTo?: string;
	readonly payload: unknown;
}

/** The narrowed shape for the one event type this integration acts on. */
export interface TelnyxNumberOrderWebhook extends TelnyxWebhookEvent {
	readonly eventType: typeof TELNYX_NUMBER_ORDER_EVENT;
	readonly order: z.infer<typeof numberOrderSchema>;
}

/**
 * Parses a verified webhook body into the generic event shape.
 *
 * Returns `undefined` rather than throwing when the body is not a v2 envelope: by the time this is
 * called the signature has already proven the delivery came from Telnyx, so an unparseable body is
 * an event type we do not model — something to log and 200, not something to fail the request
 * over. Failing would make Telnyx retry a delivery that will never parse, and eventually disable
 * the endpoint.
 */
export function parseTelnyxWebhookEvent(body: unknown): TelnyxWebhookEvent | undefined {
	const parsed = eventEnvelope.safeParse(body);
	if (!parsed.success) {
		return undefined;
	}
	const { data, meta } = parsed.data;
	return {
		eventType: data.event_type,
		id: data.id,
		payload: data.payload,
		...(data.occurred_at === undefined ? {} : { occurredAt: data.occurred_at }),
		...(meta?.attempt === undefined ? {} : { attempt: meta.attempt }),
		...(meta?.delivered_to === undefined ? {} : { deliveredTo: meta.delivered_to }),
	};
}

/**
 * Narrows a parsed event to the number-order shape, or `undefined` when it is something else.
 *
 * The payload is re-validated with the order schema rather than trusted: a webhook body is
 * attacker-influenced input that happens to be signed, and "signed by Telnyx" is not "shaped the
 * way our order parser expects".
 */
export function asNumberOrderWebhook(
	event: TelnyxWebhookEvent,
): TelnyxNumberOrderWebhook | undefined {
	if (event.eventType !== TELNYX_NUMBER_ORDER_EVENT) {
		return undefined;
	}
	const order = numberOrderSchema.safeParse(event.payload);
	if (!order.success) {
		return undefined;
	}
	return { ...event, eventType: TELNYX_NUMBER_ORDER_EVENT, order: order.data };
}

/** The narrowed shape for any of the `fax.*` events, inbound or outbound. */
export interface TelnyxFaxWebhook extends TelnyxWebhookEvent {
	readonly eventType: TelnyxFaxEventType;
	readonly fax: TelnyxFaxWebhookPayload;
}

/**
 * Narrows a parsed event to a fax event, or `undefined` when it is something else.
 *
 * Two gates, and both matter. First the `event_type` must be one of the six fax events this
 * integration models — an unmodelled `fax.*` (Telnyx adds them) is logged-and-200'd, not acted on.
 * Then the payload is re-validated with the fax payload schema rather than trusted: a signed webhook
 * body is still attacker-influenced input, and "signed by Telnyx" is not "shaped the way our fax
 * handler expects". A body that passes the signature but fails the schema is a shape drift to fix in
 * `reference/telnyx-api.md`, surfaced by the consumer as an unhandled event rather than a crash.
 */
export function asFaxWebhook(event: TelnyxWebhookEvent): TelnyxFaxWebhook | undefined {
	if (!isTelnyxFaxEvent(event.eventType)) {
		return undefined;
	}
	const fax = telnyxFaxWebhookPayloadSchema.safeParse(event.payload);
	if (!fax.success) {
		return undefined;
	}
	return { ...event, eventType: event.eventType, fax: fax.data };
}
