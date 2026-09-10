import { describe, expect, it } from "bun:test";
import { emptyQueueStats } from "./queue-stats";
import {
	formatSurveyAverage,
	orderedCallAnswers,
	ratedQueues,
	surveyAnswerCount,
	surveyBarPct,
	surveyResponseCount,
	surveyTone,
} from "./queue-survey";
import type { QueueStatsRow, QueueSurveyQuestionSummary, QueueSurveySummary } from "./contracts";

/**
 * Reading a post-call survey — where every failure is a plausible-looking number.
 *
 * The two that matter: a queue nobody rated must not be rendered as a queue rated 0.0, and a
 * question nobody answered must not be five zero-width bars that read as unanimous dissatisfaction.
 */

const QUEUE = "019fd5fb-de54-700b-8826-8cf8ab5199af";
const OTHER = "019fd5fb-de54-700b-8826-8cf8ab5199b0";

function question(overrides: Partial<QueueSurveyQuestionSummary> = {}): QueueSurveyQuestionSummary {
	return {
		questionId: "019fd5fb-aaaa-700b-8826-8cf8ab5199af",
		position: 1,
		label: "How did we do?",
		responses: 4,
		distribution: [1, 0, 0, 1, 2],
		average: 3.8,
		...overrides,
	};
}

function summary(overrides: Partial<QueueSurveySummary> = {}): QueueSurveySummary {
	return { queueId: QUEUE, responses: 4, average: 3.8, questions: [question()], ...overrides };
}

function row(queueId: string, survey?: QueueSurveySummary): QueueStatsRow {
	return survey === undefined ? emptyQueueStats(queueId) : { ...emptyQueueStats(queueId), survey };
}

describe("a survey average", () => {
	it("never renders an absent average as a score", () => {
		expect(formatSurveyAverage(null)).toBe("No answers");
		expect(surveyTone(null)).toBe("none");
		// The trap: 0 is a real score and null is not, and they must not collapse.
		expect(formatSurveyAverage(4.25)).toBe("4.3 / 5");
		expect(surveyTone(0)).toBe("poor");
	});

	it("colours by the two thresholds and not by rounding", () => {
		expect(surveyTone(4)).toBe("good");
		expect(surveyTone(3.9)).toBe("fair");
		expect(surveyTone(3)).toBe("fair");
		expect(surveyTone(2.9)).toBe("poor");
	});

	it("counts nothing for a queue with no survey at all", () => {
		expect(surveyResponseCount(undefined)).toBe(0);
		expect(surveyResponseCount(summary())).toBe(4);
	});
});

describe("a question's distribution", () => {
	it("turns counts into shares of the answers that question got", () => {
		const asked = question();
		expect(surveyBarPct(asked, 5)).toBe(50);
		expect(surveyBarPct(asked, 1)).toBe(25);
		expect(surveyBarPct(asked, 3)).toBe(0);
		expect(surveyAnswerCount(asked, 5)).toBe(2);
	});

	it("divides by nothing for a question nobody answered", () => {
		const unanswered = question({ responses: 0, distribution: [0, 0, 0, 0, 0], average: null });
		for (const answer of [1, 2, 3, 4, 5]) {
			expect(surveyBarPct(unanswered, answer)).toBe(0);
			expect(surveyAnswerCount(unanswered, answer)).toBe(0);
		}
	});

	it("reads a short distribution as zeros rather than undefined", () => {
		const truncated = question({ responses: 1, distribution: [1] });
		expect(surveyAnswerCount(truncated, 4)).toBe(0);
		expect(surveyBarPct(truncated, 1)).toBe(100);
	});
});

describe("the queues a survey panel lists", () => {
	it("keeps only queues with answers, worst first", () => {
		const rows = [
			row(QUEUE, summary({ average: 4.6 })),
			row(OTHER, summary({ queueId: OTHER, average: 2.1 })),
			row("019fd5fb-de54-700b-8826-8cf8ab5199b1"),
			// Configured but unanswered: a survey with no responses is not a rated queue.
			row("019fd5fb-de54-700b-8826-8cf8ab5199b2", summary({ responses: 0, average: null })),
		];

		expect(ratedQueues(rows).map((queue) => queue.queueId)).toEqual([OTHER, QUEUE]);
	});
});

describe("a call's own answers", () => {
	it("puts them back in the order the caller was asked", () => {
		const answer = (position: number) => ({
			callId: "019fd5fb-cccc-700b-8826-8cf8ab5199af",
			queueId: QUEUE,
			questionId: `q${String(position)}`,
			position,
			label: `Question ${String(position)}`,
			answer: position,
			answeredAt: "2026-09-10T08:00:00.000Z",
		});

		expect(
			orderedCallAnswers([answer(3), answer(1), answer(2)]).map((row) => row.position),
		).toEqual([1, 2, 3]);
	});
});
