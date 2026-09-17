import type {
	QueueStatsRow,
	QueueSurveyCallAnswer,
	QueueSurveyQuestionSummary,
	QueueSurveySummary,
} from "./contracts";

/**
 * Reading a post-call survey, without a React component in sight.
 *
 * Everything a survey panel has to decide is arithmetic over five counts, and it is arithmetic with
 * two traps in it — so it lives here where a test can drive it rather than inside a `.map` nobody
 * can assert against.
 *
 * ## The two traps
 *
 * **A missing average is not a zero.** Nobody answering is not everybody answering 1. The server
 * sends `null` for it and every function here keeps the null all the way to the string a reader
 * sees, which says "no answers" rather than "1.0".
 *
 * **A percentage of nothing is nothing.** {@link surveyBarPct} answers 0 for an empty
 * distribution rather than dividing by it, and the panel renders an empty state instead of five
 * zero-width bars that look like a survey everybody scored 0 on.
 */

/** The keypad a survey question accepts, lowest first — the order the bars are drawn in. */
export const SURVEY_ANSWERS: readonly number[] = [1, 2, 3, 4, 5];

/** Where a survey average stops being good news. Mirrors nothing on the server: it is a display rule. */
export const SURVEY_GOOD_AVERAGE = 4;
export const SURVEY_POOR_AVERAGE = 3;

export type SurveyTone = "good" | "fair" | "poor" | "none";

/** The tone an average is rendered in. `none` is "nobody answered", never a bad score. */
export function surveyTone(average: number | null): SurveyTone {
	if (average === null) {
		return "none";
	}
	if (average >= SURVEY_GOOD_AVERAGE) {
		return "good";
	}
	return average >= SURVEY_POOR_AVERAGE ? "fair" : "poor";
}

/** An average as a reader sees it: one decimal out of five, or the honest absence of one. */
export function formatSurveyAverage(average: number | null): string {
	return average === null ? "No answers" : `${average.toFixed(1)} / 5`;
}

/** How many callers answered anything at all, across every question. */
export function surveyResponseCount(summary: QueueSurveySummary | undefined): number {
	return summary?.responses ?? 0;
}

/** One bar's share of its question, 0-100 and rounded. Zero for a question nobody answered. */
export function surveyBarPct(question: QueueSurveyQuestionSummary, answer: number): number {
	if (question.responses <= 0) {
		return 0;
	}
	const count = question.distribution[answer - 1] ?? 0;
	return Math.round((count / question.responses) * 100);
}

/** The count behind one bar. Absent entries are zero, never `undefined` reaching a renderer. */
export function surveyAnswerCount(question: QueueSurveyQuestionSummary, answer: number): number {
	return question.distribution[answer - 1] ?? 0;
}

/** Every queue in the window that actually has answers, worst average first. */
export function ratedQueues(
	rows: readonly QueueStatsRow[],
): readonly (QueueStatsRow & { readonly survey: QueueSurveySummary })[] {
	return rows
		.filter(
			(row): row is QueueStatsRow & { readonly survey: QueueSurveySummary } =>
				row.survey !== undefined && row.survey.responses > 0,
		)
		.sort((left, right) => (left.survey.average ?? 0) - (right.survey.average ?? 0));
}

/**
 * One call's answers, in the order the caller was asked.
 *
 * Sorted here rather than trusted from the wire: the answers come back from a second database and
 * an ordering a report depends on should be the report's own.
 */
export function orderedCallAnswers(
	answers: readonly QueueSurveyCallAnswer[],
): readonly QueueSurveyCallAnswer[] {
	return [...answers].sort((left, right) => left.position - right.position);
}
