import { Catch, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { ProvisionRateLimitedException } from "./provision.errors";
import type { FastifyReply } from "fastify";

/**
 * Puts `Retry-After` on the one refusal that has to carry it.
 *
 * A `429` without `Retry-After` tells a phone it went too fast and nothing about when to try again,
 * so the firmware picks its own interval — which on several vendors is "immediately", turning a
 * rate limit into a tight loop against the endpoint it was meant to protect. The header is the
 * whole point of answering 429 rather than the area's usual opaque 404.
 *
 * A filter rather than a header set at the throw site because the throw is four call frames deep in
 * `ProvisionService`, inside a method whose job is authorization rather than HTTP. Threading a
 * `FastifyReply` down to it so it could set one header would put the transport into the middle of
 * the security path, and every future check would have the same handle available for no reason.
 *
 * Scoped to the provisioning controller with `@UseFilters`, not registered globally: it exists for
 * one exception type on two routes, and a global filter would be a piece of the application's
 * error-handling contract that nothing else needs.
 */
@Catch(ProvisionRateLimitedException)
export class ProvisionRateLimitFilter implements ExceptionFilter<ProvisionRateLimitedException> {
	catch(exception: ProvisionRateLimitedException, host: ArgumentsHost): void {
		const reply = host.switchToHttp().getResponse<FastifyReply>();
		void reply
			.status(exception.getStatus())
			.header("retry-after", String(exception.retryAfterSeconds))
			.header("cache-control", "no-store")
			.send(exception.getResponse());
	}
}
