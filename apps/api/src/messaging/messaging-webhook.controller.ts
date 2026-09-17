import { Controller, Headers, HttpCode, HttpStatus, Inject, Post, Req } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { PublicRoute } from "../auth/public-route.decorator";
import { MessagingInboundService } from "./messaging-inbound.service";
import {
	MessagingNotConfiguredException,
	MessagingSignatureInvalidException,
} from "./messaging.errors";
import { messagingWebhooksTotal } from "./messaging.metrics";
import { MESSAGING_PROVIDER } from "./messaging.tokens";
import {
	MessagingWebhookAuthError,
	type MessagingProvider,
} from "./provider/messaging-provider.port";
import type { RawBodyRequest } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

const logger = getLogger("api.messaging");

/**
 * `POST /api/v1/messaging/webhooks/:provider` — inbound messages and delivery receipts.
 *
 * # Why messaging has its own webhook route and does not ride the carrier one
 *
 * `carrier-webhook.controller.ts` already terminates Telnyx deliveries, and folding messaging into
 * it would have been fewer lines. It is a separate route because the two differ on the thing that
 * decides route boundaries: WHO authenticates the caller. The carrier route's verifier is fixed —
 * Telnyx, Ed25519, one account key — while this one asks the configured PROVIDER to authenticate,
 * because the whole feature is built behind a port so a fake provider can drive it end to end. A
 * shared route would either have to know about the port (making the carrier route depend on
 * messaging) or the fake would have to forge Telnyx signatures, which means shipping a private key.
 *
 * The `:provider` segment is in the path for the same reason and is checked against the configured
 * driver, so a deployment running the fake cannot have a delivery accepted at the Telnyx path.
 *
 * # Why there is no permission guard
 *
 * There cannot be one: the caller is a carrier, which has no session and no organization. The
 * SIGNATURE is the authentication — and it is stronger than a bearer token, because it also proves
 * the body was not altered in transit. The verification is delegated to the provider, which is the
 * only thing that knows the scheme.
 *
 * # The status codes, and why almost everything is a 200
 *
 * A carrier retries anything that is not a 2xx and eventually disables an endpoint that keeps
 * failing — taking the events we DO care about with it. So the only non-200 outcomes are the two
 * that are genuinely the caller's problem or genuinely ours: a signature that does not verify (403,
 * because accepting it would let anyone who guesses the URL inject a consumer's opt-out), and an
 * unconfigured deployment (503, because it cannot verify anything and accepting unverified
 * deliveries "since we ignore them" is how that gets forgotten). Everything else — an envelope we do
 * not model, a number with no messaging line, a receipt that correlates to nothing — is logged and
 * answered 200.
 */
@Controller("api/v1/messaging/webhooks")
export class MessagingWebhookController {
	constructor(
		@Inject(MESSAGING_PROVIDER) private readonly provider: MessagingProvider | undefined,
		@Inject(MessagingInboundService) private readonly inbound: MessagingInboundService,
	) {}

	@Post("telnyx")
	@PublicRoute()
	@HttpCode(HttpStatus.OK)
	async telnyx(
		@Req() request: RawBodyRequest<FastifyRequest>,
		@Headers() headers: Record<string, string | undefined>,
	): Promise<{ readonly received: true }> {
		return await this.handle("telnyx", request, headers);
	}

	/**
	 * The fake provider's endpoint.
	 *
	 * Mounted unconditionally and gated by the driver check below rather than by a conditional
	 * controller, because a route that exists only in some builds is a route nobody can reason about
	 * from the source. A deployment running Telnyx answers 503 here, naming the configured driver.
	 */
	@Post("fake")
	@PublicRoute()
	@HttpCode(HttpStatus.OK)
	async fake(
		@Req() request: RawBodyRequest<FastifyRequest>,
		@Headers() headers: Record<string, string | undefined>,
	): Promise<{ readonly received: true }> {
		return await this.handle("fake", request, headers);
	}

	private async handle(
		expected: string,
		request: RawBodyRequest<FastifyRequest>,
		headers: Record<string, string | undefined>,
	): Promise<{ readonly received: true }> {
		const provider = this.provider;
		if (provider === undefined || provider.name !== expected) {
			messagingWebhooksTotal.inc({ outcome: "not-configured" });
			throw new MessagingNotConfiguredException();
		}

		/**
		 * The exact bytes, never a re-serialisation. `main.ts` sets `rawBody: true` for this route's
		 * sake as well as the carrier one; if that regresses, `rawBody` is `undefined` here and the
		 * delivery is REJECTED rather than verified against a body that was silently reconstructed —
		 * which would be a verifier that always passes.
		 */
		const rawBody = request.rawBody;
		if (rawBody === undefined) {
			logger.error(
				"messaging webhook received without a raw body — NestFactory is missing `rawBody: true`",
			);
			messagingWebhooksTotal.inc({ outcome: "raw-body-unavailable" });
			throw new MessagingSignatureInvalidException("raw-body-unavailable");
		}

		let event;
		try {
			event = await provider.parseWebhook({ rawBody, headers });
		} catch (error) {
			if (error instanceof MessagingWebhookAuthError) {
				// The reason is what a log line needs to tell "somebody is probing us" apart from "our
				// key is stale after a portal rotation", and a boolean would discard it at exactly the
				// moment it is worth the most.
				logger.warn({ reason: error.reason }, "rejected a messaging webhook");
				messagingWebhooksTotal.inc({ outcome: "rejected" });
				throw new MessagingSignatureInvalidException(error.reason);
			}
			throw error;
		}

		if (event === undefined) {
			logger.info("received a messaging webhook this platform does not model");
			messagingWebhooksTotal.inc({ outcome: "unmodelled" });
			return { received: true };
		}

		// The service never throws — a webhook must be answered 200 — so a delivery it cannot handle
		// is logged there and still 200s here.
		const outcome = await this.inbound.handle(event);
		messagingWebhooksTotal.inc({ outcome });
		logger.info({ kind: event.kind, outcome }, "messaging webhook handled");
		return { received: true };
	}
}
