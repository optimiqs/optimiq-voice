import { Controller, Inject } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import { routingResolveRequestSchema } from "@optimiq-voice/events/schemas";
import { RPC_SUBJECTS } from "@optimiq-voice/events/subjects";
import { getLogger } from "@optimiq-voice/logging";
import { PublicRoute } from "../../auth/public-route.decorator";
import { RoutingService } from "./routing.service";
import type { RoutingResolveResponse } from "@optimiq-voice/events/schemas";

const logger = getLogger("api.pbx");

/**
 * The `rpc.routing.v1.resolve` responder.
 *
 * NestJS's built-in NATS transport, per plan §3.5 ("no custom NATS framework" — the transport for
 * request-reply, raw JetStream only for KV and durable publishes). `main.ts` attaches the
 * microservice when `NATS_URL` is set; without a broker this controller simply never receives
 * anything, and the REST surface is unaffected.
 *
 * ## The request is validated here, not trusted
 *
 * The engine and the API are separate deployables on separate release trains, so a payload that
 * does not satisfy `routingResolveRequestSchema` is a version skew, not an impossibility. It is
 * answered with `matched: false` and a reason rather than by throwing: a rejected reply the engine
 * can log beats a timeout it has to guess about while a caller listens to silence.
 *
 * ## Authorization
 *
 * `@PublicRoute()` because the global session guard is an HTTP concern and there is no session on
 * a broker message. The subject itself is the boundary: reaching it requires NATS credentials for
 * this cluster, which is the same trust level every other `rpc.*` subject assumes. The tenant
 * comes from the request's `orgId` and every read it drives runs inside that organization's RLS
 * transaction, so a malformed or hostile `orgId` can only ever see its own (probably empty)
 * configuration.
 */
@Controller()
export class RoutingRpcController {
	constructor(@Inject(RoutingService) private readonly routing: RoutingService) {}

	@PublicRoute()
	@MessagePattern(RPC_SUBJECTS.routingResolve)
	async resolve(@Payload() payload: unknown): Promise<RoutingResolveResponse> {
		const parsed = routingResolveRequestSchema.safeParse(payload);
		if (!parsed.success) {
			const reason = parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; ");
			logger.warn({ reason }, "rejected a malformed rpc.routing.v1.resolve request");
			return { matched: false, reason: reason.slice(0, 256) };
		}

		try {
			return await this.routing.resolve(parsed.data);
		} catch (error) {
			// A resolve failure must not become a broker-level timeout: the engine has a live call
			// waiting and needs an answer it can act on.
			logger.error({ orgId: parsed.data.orgId, error }, "rpc.routing.v1.resolve failed");
			return {
				matched: false,
				reason:
					`routing resolve failed: ${error instanceof Error ? error.message : String(error)}`.slice(
						0,
						256,
					),
			};
		}
	}
}
