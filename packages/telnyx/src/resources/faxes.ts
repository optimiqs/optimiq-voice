import { z } from "zod";
import { TelnyxError } from "../errors";
import { dataEnvelope, telnyxTimestamp } from "../schemas";
import type { TelnyxTransport } from "../transport";

/**
 * `POST /v2/faxes` and its read — Telnyx Programmable Fax.
 *
 * ## Why fax lives at the carrier and not in the media plane
 *
 * A fax is a T.30 session negotiated over T.38 (or, worse, an audio-passthrough G.711 leg carrying
 * modem tones). mediad terminates neither — its last rung is voice RTP with DTMF and call-progress
 * tones, and there is no CNG/CED detector or T.38 gateway in it (`plans/parity-audit-2026-08-11.md`
 * rows 2.27, 4.20; mediad rung 8 is absent). So this platform routes fax at the **carrier edge**:
 * Telnyx receives the inbound fax, renders it to a document, and webhooks us; and we hand Telnyx a
 * document plus a to/from to send. This module is that hand-off, and nothing about it touches a
 * media leg.
 *
 * ## Sending a fax spends money and is not idempotent — same shape as an order
 *
 * There is no `Idempotency-Key` on `POST /v2/faxes` (Telnyx honours that header on seven
 * email/storage endpoints only; see `resources/number-orders.ts`). A retried send is a second fax
 * to the same recipient, which is both a bill and an embarrassment. So, exactly as with number
 * orders:
 *
 * 1. The request is sent with `retryable: false` — a socket that dies after Telnyx queued the fax
 *    must not be resolved by sending it again.
 * 2. Every send carries a `clientState` the caller supplies. Telnyx echoes it verbatim on every
 *    `fax.*` webhook, so it is our correlation token: the API layer passes the id of the
 *    `fax_message` row it is about to enqueue, and the whole lifecycle is traceable to that row
 *    without a carrier-side reference filter (faxes have none — reconciliation is by webhook on the
 *    `clientState`, or a `get(faxId)` on the id this call returns).
 *
 * `POST` returns **202 Accepted**, not 200/201 — the fax is queued, not sent — and
 * `GET /v2/faxes/{id}` returns the identical schema, so one parser serves both.
 *
 * Field names and enum members are pinned in `reference/telnyx-api.md` §Programmable Fax.
 */

/**
 * The fax lifecycle, at the object level. Outbound walks `queued → media.processed → originated →
 * sending → delivered | failed`; inbound is reported as `receiving → received`. Not narrowed to a
 * union in the schema (unknown members must not break a read — see `schemas.ts`) but listed so the
 * API layer can map to its own terminal/in-flight classification without inventing the list.
 */
export const TELNYX_FAX_STATUSES = [
	"queued",
	"media.processed",
	"originated",
	"sending",
	"delivered",
	"failed",
	"initiated",
	"receiving",
	"received",
] as const;
export type TelnyxFaxStatus = (typeof TELNYX_FAX_STATUSES)[number];

/** The two directions a fax record can have. `direction` is required — inbound and outbound are
 * filed into different mailboxes, so guessing it wrong misfiles the document. */
export const TELNYX_FAX_DIRECTIONS = ["inbound", "outbound"] as const;
export type TelnyxFaxDirection = (typeof TELNYX_FAX_DIRECTIONS)[number];

/** Render quality Telnyx accepts on send. `normal` is the default; `high`/`ultra` cost more time. */
export const TELNYX_FAX_QUALITIES = ["normal", "high", "ultra"] as const;
export type TelnyxFaxQuality = (typeof TELNYX_FAX_QUALITIES)[number];

/**
 * The webhook `event_type` strings Telnyx sends for fax, mapped by the moment they mark. All six
 * arrive on the same v2 envelope parsed by `webhooks/events.ts`; `asFaxWebhook` narrows a parsed
 * event to the payload below. `fax.received` is the only inbound one.
 */
export const TELNYX_FAX_EVENTS = {
	queued: "fax.queued",
	mediaProcessed: "fax.media.processed",
	sendingStarted: "fax.sending.started",
	delivered: "fax.delivered",
	failed: "fax.failed",
	received: "fax.received",
} as const;
export type TelnyxFaxEventType = (typeof TELNYX_FAX_EVENTS)[keyof typeof TELNYX_FAX_EVENTS];

/** Every fax `event_type` this integration understands, for the consumer's membership check. */
export const TELNYX_FAX_EVENT_TYPES = Object.values(
	TELNYX_FAX_EVENTS,
) as readonly TelnyxFaxEventType[];

/** `true` for a fax event type this client models. */
export function isTelnyxFaxEvent(eventType: string): eventType is TelnyxFaxEventType {
	return (TELNYX_FAX_EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * The fax object, returned by send and by read.
 *
 * Required iff we persist it or branch on it (the `schemas.ts` policy): `id` correlates the row,
 * `direction` files it, `status` drives the lifecycle. Everything else is optional and typed for
 * convenience — Telnyx adds fields here without a version bump.
 */
export const telnyxFaxSchema = z.looseObject({
	id: z.string(),
	record_type: z.string().optional(),
	direction: z.string(),
	status: z.string(),
	connection_id: z.string().nullish(),
	from: z.string().nullish(),
	to: z.string().nullish(),
	from_display_name: z.string().nullish(),
	quality: z.string().nullish(),
	media_url: z.string().nullish(),
	media_name: z.string().nullish(),
	original_media_url: z.string().nullish(),
	stored_media_url: z.string().nullish(),
	page_count: z.number().nullish(),
	store_media: z.boolean().optional(),
	t38_enabled: z.boolean().optional(),
	monochrome: z.boolean().optional(),
	webhook_url: z.string().nullish(),
	client_state: z.string().nullish(),
	failure_reason: z.string().nullish(),
	call_duration_secs: z.number().nullish(),
	created_at: telnyxTimestamp.optional(),
	updated_at: telnyxTimestamp.optional(),
});

export type TelnyxFax = z.infer<typeof telnyxFaxSchema>;

/**
 * The `payload` inside a `fax.*` webhook envelope. It is NOT the same shape as the fax object above:
 * the delivery-worthy fields are named `fax_id` (not `id`), and the received document arrives as
 * `media_url` while the source of an outbound send is `original_media_url`.
 *
 * `fax_id`, `direction` and `status` are required — they correlate the row and branch the handler;
 * a webhook missing any of them is one this integration does not model, so `asFaxWebhook` returns
 * `undefined` and the consumer 200s it rather than failing Telnyx's delivery forever.
 */
export const telnyxFaxWebhookPayloadSchema = z.looseObject({
	fax_id: z.string(),
	direction: z.string(),
	status: z.string(),
	connection_id: z.string().nullish(),
	user_id: z.string().nullish(),
	client_state: z.string().nullish(),
	from: z.string().nullish(),
	to: z.string().nullish(),
	/** Outbound only: the document we asked Telnyx to send. */
	original_media_url: z.string().nullish(),
	/** Inbound `fax.received`: the rendered document to download and file. */
	media_url: z.string().nullish(),
	page_count: z.number().nullish(),
	call_duration_secs: z.number().nullish(),
	/** `fax.failed` only. */
	failure_reason: z.string().nullish(),
});

export type TelnyxFaxWebhookPayload = z.infer<typeof telnyxFaxWebhookPayloadSchema>;

const faxResponse = dataEnvelope(telnyxFaxSchema);

/**
 * `POST /v2/faxes` input.
 *
 * Exactly one of `mediaUrl` / `mediaName` must be present — Telnyx rejects a send with neither, and
 * a send with both is ambiguous. That is checked here, before the round trip, by
 * {@link assertFaxMedia}, so a malformed request never reaches the carrier or the retry logic.
 */
export interface SendFaxInput {
	/** The fax-enabled connection / Fax Application the DID sends from. */
	readonly connectionId: string;
	readonly to: string;
	readonly from: string;
	readonly mediaUrl?: string;
	readonly mediaName?: string;
	readonly fromDisplayName?: string;
	readonly quality?: TelnyxFaxQuality;
	readonly monochrome?: boolean;
	readonly storeMedia?: boolean;
	readonly t38Enabled?: boolean;
	readonly webhookUrl?: string;
	/** Our correlation/idempotency token. Echoed on every `fax.*` webhook. Required by this client. */
	readonly clientState: string;
}

/** Raised for a send whose media is under- or over-specified, before any network call. */
export class TelnyxFaxRequestError extends TelnyxError {
	readonly field: string;
	constructor(field: string, detail: string) {
		super(`Telnyx fax request invalid (${field}): ${detail}`);
		this.field = field;
	}
}

/** Throws unless exactly one of `mediaUrl` / `mediaName` is present. */
export function assertFaxMedia(input: Pick<SendFaxInput, "mediaUrl" | "mediaName">): void {
	const hasUrl = input.mediaUrl !== undefined && input.mediaUrl.length > 0;
	const hasName = input.mediaName !== undefined && input.mediaName.length > 0;
	if (hasUrl === hasName) {
		throw new TelnyxFaxRequestError(
			"media_url",
			"exactly one of media_url or media_name is required",
		);
	}
}

export interface FaxesResource {
	/**
	 * Queue an outbound fax. Returns the fax with its carrier id and initial `queued` status; the
	 * document itself is delivered asynchronously and reported over the `fax.*` webhooks. Never
	 * auto-retries — a repeat could send a second fax. See the module header.
	 */
	readonly send: (input: SendFaxInput) => Promise<TelnyxFax>;
	/** Read a fax back by its carrier id — the reconciliation path after an ambiguous send. */
	readonly get: (faxId: string) => Promise<TelnyxFax>;
}

export function makeFaxes(transport: TelnyxTransport): FaxesResource {
	return {
		send: async (input) => {
			assertFaxMedia(input);
			const response = await transport.request({
				method: "POST",
				path: "/faxes",
				// See the header. This is the one call in the package besides ordering that must never
				// auto-retry, because a second send is a second fax.
				retryable: false,
				body: {
					connection_id: input.connectionId,
					to: input.to,
					from: input.from,
					...(input.mediaUrl === undefined ? {} : { media_url: input.mediaUrl }),
					...(input.mediaName === undefined ? {} : { media_name: input.mediaName }),
					...(input.fromDisplayName === undefined
						? {}
						: { from_display_name: input.fromDisplayName }),
					...(input.quality === undefined ? {} : { quality: input.quality }),
					...(input.monochrome === undefined ? {} : { monochrome: input.monochrome }),
					...(input.storeMedia === undefined ? {} : { store_media: input.storeMedia }),
					...(input.t38Enabled === undefined ? {} : { t38_enabled: input.t38Enabled }),
					...(input.webhookUrl === undefined ? {} : { webhook_url: input.webhookUrl }),
					client_state: input.clientState,
				},
				schema: faxResponse,
			});
			return response.data;
		},

		get: async (faxId) => {
			const response = await transport.request({
				method: "GET",
				path: `/faxes/${encodeURIComponent(faxId)}`,
				schema: faxResponse,
			});
			return response.data;
		},
	};
}
