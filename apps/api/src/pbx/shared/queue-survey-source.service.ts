import {
	and,
	eq,
	gte,
	inArray,
	lt,
	queueSurveyQuestion,
	queueSurveyResponse,
	sql,
} from "@optimiq-voice/pbx-db";
import {
	QUEUE_SURVEY_MAX_ANSWER,
	QUEUE_SURVEY_MIN_ANSWER,
} from "../../cdr/query/queue-survey.port";
import type {
	QueueSurveyCallAnswer,
	QueueSurveyQuestionSummary,
	QueueSurveySource,
	QueueSurveySummary,
} from "../../cdr/query/queue-survey.port";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * `QueueSurveySource`, implemented against the PBX database's answer rows.
 *
 * Bound by `pbx-cdr-ports.module.ts` and reached only from the CDR area's report service, which
 * joins what comes back to its own call rows by call id. See the port for why that join is in
 * TypeScript and not in SQL.
 *
 * ## The aggregate is one statement per window, not one per question
 *
 * `count(*) filter (where answer = n)` for each of the five answers, grouped by question. A busy
 * queue's window holds tens of thousands of rows and the report wants five numbers per question, so
 * shipping the rows to count them here would move the whole window across a socket to throw it
 * away. The question's own label and position come from a join inside the same database, which is
 * the join that IS allowed: both tables are PBX-owned.
 *
 * ## An unanswered question contributes nothing
 *
 * There is no row for a caller who pressed nothing — `packages/pbx-db` says so and the engine's
 * survey runner honours it — so `responses` is a count of answers given and the average is over
 * those. Nothing here invents a zero, and a question nobody answered has a `null` average rather
 * than a 0.0 that would read as the worst possible score.
 */
export class QueueSurveySourceService implements QueueSurveySource {
	constructor(private readonly database: PbxDatabaseClient) {}

	async summaries(input: {
		readonly organizationId: string;
		readonly from: Date;
		readonly to: Date;
		readonly queueId?: string;
	}): Promise<readonly QueueSurveySummary[]> {
		const rows = await this.database.withTenantScope(
			input.organizationId,
			async (transaction) =>
				await transaction
					.select({
						queueId: queueSurveyResponse.queueId,
						questionId: queueSurveyResponse.questionId,
						position: queueSurveyQuestion.position,
						label: queueSurveyQuestion.label,
						responses: sql<number>`count(*)`,
						total: sql<number>`sum(${queueSurveyResponse.answer})`,
						...this.answerCounts(),
					})
					.from(queueSurveyResponse)
					.innerJoin(
						queueSurveyQuestion,
						eq(queueSurveyQuestion.id, queueSurveyResponse.questionId),
					)
					.where(
						and(
							gte(queueSurveyResponse.answeredAt, input.from),
							lt(queueSurveyResponse.answeredAt, input.to),
							...(input.queueId === undefined
								? []
								: [eq(queueSurveyResponse.queueId, input.queueId)]),
						),
					)
					.groupBy(
						queueSurveyResponse.queueId,
						queueSurveyResponse.questionId,
						queueSurveyQuestion.position,
						queueSurveyQuestion.label,
					),
		);

		const byQueue = new Map<
			string,
			{ responses: number; total: number; questions: QueueSurveyQuestionSummary[] }
		>();
		for (const row of rows) {
			const responses = Number(row.responses);
			const total = Number(row.total);
			const queue = byQueue.get(row.queueId) ?? { responses: 0, total: 0, questions: [] };
			queue.responses += responses;
			queue.total += total;
			queue.questions.push({
				questionId: row.questionId,
				position: row.position,
				label: row.label,
				responses,
				distribution: this.distributionOf(row),
				average: mean(total, responses),
			});
			byQueue.set(row.queueId, queue);
		}

		return [...byQueue.entries()].map(([queueId, queue]) => ({
			queueId,
			responses: queue.responses,
			average: mean(queue.total, queue.responses),
			// By position, so the report reads in the order the caller was asked rather than in
			// whatever order the aggregate came back.
			questions: [...queue.questions].sort((left, right) => left.position - right.position),
		}));
	}

	async answersForCalls(input: {
		readonly organizationId: string;
		readonly callIds: readonly string[];
	}): Promise<readonly QueueSurveyCallAnswer[]> {
		if (input.callIds.length === 0) {
			return [];
		}
		const rows = await this.database.withTenantScope(
			input.organizationId,
			async (transaction) =>
				await transaction
					.select({
						callId: queueSurveyResponse.callId,
						queueId: queueSurveyResponse.queueId,
						questionId: queueSurveyResponse.questionId,
						position: queueSurveyQuestion.position,
						label: queueSurveyQuestion.label,
						answer: queueSurveyResponse.answer,
						answeredAt: queueSurveyResponse.answeredAt,
					})
					.from(queueSurveyResponse)
					.innerJoin(
						queueSurveyQuestion,
						eq(queueSurveyQuestion.id, queueSurveyResponse.questionId),
					)
					.where(inArray(queueSurveyResponse.callId, [...input.callIds])),
		);

		return rows
			.map((row) => ({
				callId: row.callId,
				queueId: row.queueId,
				questionId: row.questionId,
				position: row.position,
				label: row.label,
				answer: row.answer,
				answeredAt: row.answeredAt.toISOString(),
			}))
			.sort((left, right) => left.position - right.position);
	}

	/** One `count(*) filter` per accepted answer, keyed `answer1`…`answer5`. */
	private answerCounts(): Record<string, ReturnType<typeof sql<number>>> {
		const counts: Record<string, ReturnType<typeof sql<number>>> = {};
		for (let answer = QUEUE_SURVEY_MIN_ANSWER; answer <= QUEUE_SURVEY_MAX_ANSWER; answer += 1) {
			counts[`answer${String(answer)}`] =
				sql<number>`count(*) filter (where ${queueSurveyResponse.answer} = ${answer})`;
		}
		return counts;
	}

	private distributionOf(row: Record<string, unknown>): readonly number[] {
		const distribution: number[] = [];
		for (let answer = QUEUE_SURVEY_MIN_ANSWER; answer <= QUEUE_SURVEY_MAX_ANSWER; answer += 1) {
			distribution.push(Number(row[`answer${String(answer)}`] ?? 0));
		}
		return distribution;
	}
}

/** The mean to one decimal, or `null` when nothing was answered. See the class doc. */
function mean(total: number, responses: number): number | null {
	if (responses === 0) {
		return null;
	}
	return Math.round((total / responses) * 10) / 10;
}
