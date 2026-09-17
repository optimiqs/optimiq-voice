import { Inject, Injectable } from "@nestjs/common";
import { firstValueFrom, timeout } from "rxjs";
import {
	QUEUE_DISPOSITION_RPC,
	queueDispositionResponseSchema,
	QUEUE_SURVEY_RPC,
	queueSurveyResponseSchema,
} from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import { ROUTING_RPC_CLIENT } from "../nats/nats.tokens";
import type {
	QueueAfterCallPort,
	QueueDispositionReport,
	QueueSurveyReport,
} from "./queue-session";
import type { ClientProxy } from "@nestjs/microservices";
import type { QueueDispositionRequest, QueueSurveyRequest } from "@optimiq-voice/events";

/**
 * The two after-call records, over `rpc.pbx.v1.queue-disposition` and `rpc.pbx.v1.queue-survey`.
 *
 * ## Why the engine reports rather than writes
 *
 * It holds no database handle, and both rows are `pbx-db` — so this is the same shape `*69` and the
 * feature codes already have, on the same `ClientProxy`, with no new connection and no new stream.
 * The engine is nevertheless the only process that knows either fact: it owns the wrap-up timer
 * that expires with nobody having chosen, and it is the thing on the other end of the leg while the
 * caller presses the survey digits. Nobody else can observe them, and nobody else can file them.
 *
 * ## Nothing here throws, and that is the whole posture of this file
 *
 * Both call sites are reached through {@link import("./queue-session").QueueSession}'s `detach`,
 * from the bridge's `onEnded` callback — which runs on the ARI event socket, where an exception
 * takes every other live call on this process with it. And by the time either report is made the
 * call is OVER: the caller has gone, the agent is back in distribution, and everything here is a
 * record OF a call rather than part of one. A wrap-up code and a survey answer are both worth less
 * than the call, so a broker that is not there, a responder that refuses and a reply that does not
 * parse all end the same way — a line in the log naming the org and the call, and a resolved
 * promise.
 *
 * There is deliberately no retry. The disposition responder is idempotent on
 * `(org, call, agent)` and the survey responder on `(org, call, question)`, so re-reporting is safe
 * — but the thing that would have to hold the retry is a detached task on a process that is
 * draining, and a queue of after-call reports kept alive across a restart is a durability promise
 * this subject does not make. What is lost on a failure is one `unset` row or one caller's rating,
 * both of which the log names.
 */
@Injectable()
export class QueueAfterCallClient implements QueueAfterCallPort {
	private readonly logger = getLogger("engine.queue");
	private reports = 0;
	private failures = 0;

	constructor(@Inject(ROUTING_RPC_CLIENT) private readonly client: ClientProxy) {}

	/** Read by the specs, and available to a health surface, on the same terms as its neighbours. */
	get stats(): { readonly reports: number; readonly failures: number } {
		return { reports: this.reports, failures: this.failures };
	}

	async disposition(report: QueueDispositionReport): Promise<void> {
		this.reports += 1;
		if (report.code !== "unset" || !report.auto) {
			// The contract pins both fields, so a report naming a real code is not a payload the
			// responder would accept — it is this engine having grown a second way to write an agent's
			// answer. Refused HERE rather than at the broker, so the log names the call rather than a
			// schema path, and so the request is never made.
			this.failures += 1;
			this.logger.warn(
				{ orgId: report.orgId, callId: report.callId, code: report.code, auto: report.auto },
				"refused to report a queue disposition that is not the auto-wrap blank",
			);
			return;
		}

		const payload: QueueDispositionRequest = {
			orgId: report.orgId,
			queueId: report.queueId,
			agentId: report.agentId,
			callId: report.callId,
			code: "unset",
			auto: true,
		};
		try {
			const reply = queueDispositionResponseSchema.parse(
				await firstValueFrom(
					this.client
						.send(QUEUE_DISPOSITION_RPC.subject, payload)
						.pipe(timeout(QUEUE_DISPOSITION_RPC.timeoutMs)),
				),
			);
			if (!reply.recorded) {
				// NOT a failure. The ordinary reason is that the agent chose a code from their console
				// before the deadline fired, which is the feature working.
				this.logger.debug(
					{ orgId: report.orgId, callId: report.callId, reason: reply.reason },
					"an auto-wrap report was not recorded",
				);
			}
		} catch (error) {
			this.failures += 1;
			this.logger.warn(
				{ orgId: report.orgId, callId: report.callId, err: String(error) },
				"rpc.pbx.v1.queue-disposition did not answer; the wrap-up blank was not filed",
			);
		}
	}

	async surveyAnswered(report: QueueSurveyReport): Promise<void> {
		this.reports += 1;
		if (report.answers.length === 0) {
			// The session already declines to report an empty survey; this is the second half of the
			// same rule, kept here because the contract's `min(1)` would otherwise turn "nobody
			// answered" into a validation error on a live process.
			return;
		}

		const payload: QueueSurveyRequest = {
			orgId: report.orgId,
			queueId: report.queueId,
			agentId: report.agentId,
			callId: report.callId,
			answers: report.answers.map((answer) => ({
				questionId: answer.questionId,
				digit: answer.digit,
			})),
		};
		try {
			const reply = queueSurveyResponseSchema.parse(
				await firstValueFrom(
					this.client
						.send(QUEUE_SURVEY_RPC.subject, payload)
						.pipe(timeout(QUEUE_SURVEY_RPC.timeoutMs)),
				),
			);
			if (reply.recorded < report.answers.length) {
				// Short of what was sent is a replay (the rows are already there) or a refusal (a
				// question that is not this queue's). The responder's `reason` separates them, and both
				// are worth a line: the second is a bug, because a caller cannot press a digit for a
				// question they were never asked.
				this.logger.info(
					{
						orgId: report.orgId,
						callId: report.callId,
						sent: report.answers.length,
						recorded: reply.recorded,
						reason: reply.reason,
					},
					"a post-call survey report wrote fewer rows than it carried",
				);
			}
		} catch (error) {
			this.failures += 1;
			this.logger.warn(
				{ orgId: report.orgId, callId: report.callId, err: String(error) },
				"rpc.pbx.v1.queue-survey did not answer; the caller's answers were not filed",
			);
		}
	}
}
