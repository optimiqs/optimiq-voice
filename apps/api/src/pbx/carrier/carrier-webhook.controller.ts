import { Controller, Headers, HttpCode, HttpStatus, Inject, Post, Req } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import {
	asFaxWebhook,
	asNumberOrderWebhook,
	parseTelnyxWebhookEvent,
	TELNYX_SIGNATURE_HEADER,
	TELNYX_TIMESTAMP_HEADER,
	TelnyxSignatureError,
	verifyTelnyxWebhook,
} from "@optimiq-voice/telnyx";
import { PublicRoute } from "../../auth/public-route.decorator";
import { FaxInboundService } from "../fax/fax-inbound.service";
import {
	CarrierSignatureInvalidException,
	CarrierWebhookNotConfiguredException,
} from "./carrier.errors";
import { CARRIER_ENV } from "./carrier.tokens";
import type { CarrierEnv } from "./carrier-env";
import type { RawBodyRequest } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

const logger = getLogger("api.pbx");

/**
 * `POST /api/v1/carrier/webhooks/telnyx`.
 *
 * ## What this does today, and what it deliberately does not
 *
 * It verifies the Ed25519 signature, parses the envelope, logs the event, and answers 200. It does
 * **not** yet act on `number_order.complete` by updating a row — that is recorded as a follow-up
 * rather than guessed at, because the interesting version of it needs a decision this change is
 * not the place to make: our order path already waits for the order to reach `success` before it
 * writes anything, so the only orders a webhook could tell us about are the ones that were
 * `pending` when we gave up waiting, and what to do with a DID that completes an hour after the
 * admin gave up is a product question.
 *
 * The verification is not a placeholder, though, and that is the point of shipping the endpoint
 * now. An unauthenticated webhook receiver is a public endpoint that accepts state changes from
 * anyone who guesses the URL; adding the signature check later, once something depends on the
 * payload, is how that gets forgotten.
 *
 * ## Why there is no permission guard
 *
 * There cannot be one: the caller is Telnyx, which has no session and no organization. The
 * signature IS the authentication — a valid Ed25519 signature over `${timestamp}|${rawBody}` is
 * unforgeable without the account's private key, and the timestamp window makes a captured
 * delivery unreplayable after five minutes.
 *
 * ## Why an unconfigured key is a 503 and not a 200
 *
 * A deployment with no `TELNYX_PUBLIC_KEY` cannot verify anything. Accepting deliveries anyway
 * "because we ignore the payload" would make the endpoint a place where anyone can inject events
 * the moment somebody starts consuming them. Refusing is loud, correct, and reversible by setting
 * the key.
 */
@Controller("api/v1/carrier/webhooks")
export class CarrierWebhookController {
	constructor(
		@Inject(CARRIER_ENV) private readonly env: CarrierEnv,
		@Inject(FaxInboundService) private readonly fax: FaxInboundService,
	) {}

	/**
	 * `@PublicRoute()` — the deny-by-default guard has to be opted out of explicitly, and this is
	 * the one route in the area that must be. Telnyx has no session and no organization; the
	 * Ed25519 signature below is the authentication, and it is stronger than a bearer token because
	 * it also proves the body was not altered in transit.
	 */
	@Post("telnyx")
	@PublicRoute()
	@HttpCode(HttpStatus.OK)
	async handle(
		@Req() request: RawBodyRequest<FastifyRequest>,
		@Headers() headers: Record<string, string | undefined>,
	): Promise<{ readonly received: true }> {
		const publicKey = this.env.TELNYX_PUBLIC_KEY;
		if (publicKey === undefined) {
			throw new CarrierWebhookNotConfiguredException();
		}

		/**
		 * The exact bytes, never a re-serialization. `main.ts` sets `rawBody: true` for this route's
		 * sake; if that ever regresses, `rawBody` is `undefined` here and the delivery is rejected
		 * rather than verified against a body that was silently reconstructed.
		 */
		const rawBody = request.rawBody;
		if (rawBody === undefined) {
			logger.error(
				"telnyx webhook received without a raw body — NestFactory is missing `rawBody: true`",
			);
			throw new CarrierSignatureInvalidException("raw-body-unavailable");
		}

		// Header lookup is case-insensitive by construction: Telnyx's own documentation pages
		// disagree about the case, and Fastify lower-cases incoming header names.
		const signature = headers[TELNYX_SIGNATURE_HEADER];
		const timestamp = headers[TELNYX_TIMESTAMP_HEADER];

		try {
			verifyTelnyxWebhook({ rawBody, signature, timestamp, publicKey });
		} catch (error) {
			if (error instanceof TelnyxSignatureError) {
				logger.warn({ reason: error.reason }, "rejected a telnyx webhook");
				throw new CarrierSignatureInvalidException(error.reason);
			}
			throw error;
		}

		const event = parseTelnyxWebhookEvent(JSON.parse(rawBody.toString("utf8")) as unknown);
		if (event === undefined) {
			// Signed by Telnyx, but not a v2 envelope we model. 200 rather than 4xx: retrying will
			// never make it parse, and a permanently-failing endpoint is one Telnyx eventually
			// disables — taking the events we DO care about with it.
			logger.info("received an unrecognized telnyx webhook envelope");
			return { received: true };
		}

		// Programmable Fax: file inbound faxes and advance outbound rows through their lifecycle. The
		// service never throws — a webhook must be answered 200 or Telnyx eventually disables the
		// endpoint — so a fax we cannot handle is logged there and still 200s here.
		const fax = asFaxWebhook(event);
		if (fax !== undefined) {
			const outcome = await this.fax.handle(fax);
			logger.info(
				{ eventId: event.id, eventType: event.eventType, outcome },
				"telnyx fax webhook handled",
			);
			return { received: true };
		}

		const order = asNumberOrderWebhook(event);
		if (order !== undefined) {
			// `number_order.complete` fires for both outcomes, so the branch is on the payload's
			// status, never on the event type. Reading it the other way treats every failed order as
			// a success.
			logger.info(
				{
					eventId: event.id,
					orderId: order.order.id,
					status: order.order.status,
					customerReference: order.order.customer_reference,
					attempt: event.attempt,
				},
				"telnyx number order completed",
			);
			return { received: true };
		}

		logger.info({ eventId: event.id, eventType: event.eventType }, "telnyx webhook received");
		return { received: true };
	}
}
