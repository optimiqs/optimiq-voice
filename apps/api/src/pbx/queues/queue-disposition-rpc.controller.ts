import { Controller, Inject } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import { z } from "zod/v4";
import { QUEUE_DISPOSITION_RPC } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { QUEUE_DISPOSITION_UNSET } from "@optimiq-voice/pbx-db";
import { PublicRoute } from "../../auth/public-route.decorator";
import { QueueAgentSessionService } from "./queue-agent-session.service";

const logger = getLogger("api.pbx");

/**
 * What the engine may say, which is deliberately almost nothing.
 *
 * `code` is pinned to {@link QUEUE_DISPOSITION_UNSET} and `auto` to `true` — this is the ONLY
 * report the distributor is entitled to make. An engine that could name a real code here would be
 * an unauthenticated second way to write an agent's answer, and the point of `unset` is that it is
 * the absence of one. A payload naming anything else is answered rather than thrown, for the reason
 * every other responder here gives: version skew between two deployables must not become a timeout
 * on a live call.
 */
const autoDispositionRequestSchema = z.object({
	orgId: z.uuid(),
	queueId: z.uuid(),
	agentId: z.uuid(),
	callId: z.uuid(),
	code: z.literal(QUEUE_DISPOSITION_UNSET),
	auto: z.literal(true),
});

/** What the engine gets back. `recorded: false` means the agent had already chosen — not an error. */
export interface AutoDispositionReply {
	readonly recorded: boolean;
	readonly reason?: string;
}

/**
 * `rpc.pbx.v1.queue-disposition` — the wrap-up deadline, reported by the process that owns it.
 *
 * The engine is the only thing that knows a wrap-up window closed with nothing chosen, and the
 * control plane is the only thing that can write it down. `@PublicRoute()` because the global
 * session guard is an HTTP concern and there is no session on a broker message; the authorization
 * that replaces it is the schema above.
 *
 * ## Why an RPC, and why this one
 *
 * The engine already reaches into the API this way for `*69` (`rpc.pbx.v1.last-caller`) and for the
 * extension feature codes, over the same application-wide microservice transport, so this costs no
 * new connection, no new consumer and no new stream. The alternative — a `queue.evt.v1` event the
 * API consumed — would have needed a durable consumer, a new subject in the events registry and an
 * at-least-once delivery story for a message whose whole content is "nobody chose". Request-reply
 * gives the engine an answer it can log and drop, and the retry is its own.
 *
 * ## The subject comes from the registry
 *
 * It is `RPC_SUBJECTS.pbxQueueDisposition`, in the `rpc.pbx.v1.*` namespace the other API
 * responders already occupy. It was a literal in this file for one wave, while `packages/events`
 * was another change's to edit, and the cost of that was written down here: the engine had to spell
 * the same string and nothing checked it. It is a contract now, so both ends and the broker's grant
 * list read from one definition.
 */
@Controller()
export class QueueDispositionRpcController {
	constructor(
		@Inject(QueueAgentSessionService) private readonly sessions: QueueAgentSessionService,
	) {}

	@PublicRoute()
	@MessagePattern(QUEUE_DISPOSITION_RPC.subject)
	async report(@Payload() payload: unknown): Promise<AutoDispositionReply> {
		const parsed = autoDispositionRequestSchema.safeParse(payload);
		if (!parsed.success) {
			const reason = parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; ");
			logger.warn({ reason }, "rejected a malformed rpc.pbx.v1.queue-disposition report");
			return { recorded: false, reason: reason.slice(0, 256) };
		}
		try {
			return await this.sessions.recordAutoDisposition({
				organizationId: parsed.data.orgId,
				queueId: parsed.data.queueId,
				agentId: parsed.data.agentId,
				callId: parsed.data.callId,
			});
		} catch (error) {
			// The backstop the other responders keep: a defect below this line must not become a broker
			// timeout the engine waits out while a caller is on the phone. The deadline has already
			// ended the agent's wrap-up either way; what is lost is the `unset` row, and the engine's
			// own retry is what recovers it.
			logger.error(
				{ orgId: parsed.data.orgId, callId: parsed.data.callId, err: error },
				"could not record an auto-wrap disposition",
			);
			return { recorded: false, reason: "the disposition could not be recorded" };
		}
	}
}
