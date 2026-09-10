import { Controller, Inject } from "@nestjs/common";
import { MessagePattern, Payload } from "@nestjs/microservices";
import { QUEUE_SURVEY_RPC, queueSurveyRequestSchema } from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { PublicRoute } from "../../auth/public-route.decorator";
import { QueueAgentSessionService } from "./queue-agent-session.service";
import type { QueueSurveyResponse } from "@optimiq-voice/events";

const logger = getLogger("api.pbx");

/**
 * `rpc.pbx.v1.queue-survey` — what the caller pressed after the agent hung up.
 *
 * ## Why the engine reports and this writes
 *
 * The same split `rpc.pbx.v1.queue-disposition` has, and for the same two reasons: the engine is
 * the only process still on the caller's leg when the questions are asked, and it holds no database
 * handle. It is request-reply rather than an event because the whole message is a handful of digits
 * whose retry the engine can own, and because the answer — how many rows this actually wrote —
 * is worth having at the caller: a report short of what it carried is either a replay or a bug, and
 * the engine's log is where somebody sees it.
 *
 * ## The contract is the authorization
 *
 * `@PublicRoute()` because the global session guard is an HTTP concern and there is no session on a
 * broker message. What replaces it is `queueSurveyRequestSchema` plus the responder's own check
 * that every `questionId` belongs to the queue named in the request — so a report cannot file a
 * rating against another queue's question, and cannot file a digit the survey never offered.
 *
 * A malformed payload is ANSWERED rather than thrown, for the reason every other responder here
 * gives: version skew between two deployables must not become a timeout that the engine's detached
 * task waits out.
 */
@Controller()
export class QueueSurveyRpcController {
	constructor(
		@Inject(QueueAgentSessionService) private readonly sessions: QueueAgentSessionService,
	) {}

	@PublicRoute()
	@MessagePattern(QUEUE_SURVEY_RPC.subject)
	async report(@Payload() payload: unknown): Promise<QueueSurveyResponse> {
		const parsed = queueSurveyRequestSchema.safeParse(payload);
		if (!parsed.success) {
			const reason = parsed.error.issues
				.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
				.join("; ");
			logger.warn({ reason }, "rejected a malformed rpc.pbx.v1.queue-survey report");
			return { recorded: 0, reason: reason.slice(0, 256) };
		}
		try {
			return await this.sessions.recordSurveyAnswers({
				organizationId: parsed.data.orgId,
				queueId: parsed.data.queueId,
				agentId: parsed.data.agentId,
				callId: parsed.data.callId,
				// The digit is a string on the wire because that is what a DTMF buffer produces; it
				// becomes the `integer` the row stores exactly once, here, so the range check below and
				// the column's own constraint can never be reading two different values.
				answers: parsed.data.answers.map((answer) => ({
					questionId: answer.questionId,
					answer: Number(answer.digit),
				})),
			});
		} catch (error) {
			// The backstop its neighbour keeps: a defect below this line must not become a broker
			// timeout. What is lost is one caller's rating, which the engine has already logged.
			logger.error(
				{ orgId: parsed.data.orgId, callId: parsed.data.callId, err: error },
				"could not record a post-call survey",
			);
			return { recorded: 0, reason: "the survey answers could not be recorded" };
		}
	}
}
