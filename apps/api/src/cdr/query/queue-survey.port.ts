/**
 * The PBX → CDR port that puts post-call survey answers on a report.
 *
 * Declared HERE and implemented in the PBX area, exactly as {@link
 * import("./self-parties").CDR_SELF_PARTIES} is: the answers live in `pbx-db` and the calls they
 * are about live in `cdr-db`, the two areas are siblings composed conditionally in `main.ts`, and
 * an import in either direction would couple their boot conditions. `PbxCdrPortsModule` binds the
 * implementation when both are present.
 *
 * ## Why the join is in the service and not in SQL
 *
 * Two databases, two connection pools, two tenancy scopes. There is no statement that can name
 * `queue_survey_response` and `call_legs` at once, and inventing one (a foreign data wrapper, a
 * replicated table) would make the report's correctness depend on replication lag. So the CDR
 * service asks each side its own question and joins the answers by CALL ID in memory — the only
 * key the two sides share, and the one `queue_survey_response.call_id` was deliberately left as a
 * plain uuid for.
 *
 * Injected `@Optional()`, like every other port here. Absent means the PBX area is not mounted, and
 * a report then carries no survey rather than failing: a call ledger is still a call ledger without
 * one.
 */
export const CDR_QUEUE_SURVEY = Symbol("api/cdr/QueueSurvey");

/** The lowest and highest answer a survey question accepts, mirroring `packages/pbx-db`'s CHECK. */
export const QUEUE_SURVEY_MIN_ANSWER = 1;
export const QUEUE_SURVEY_MAX_ANSWER = 5;

/** One question's answers over a window. */
export interface QueueSurveyQuestionSummary {
	readonly questionId: string;
	readonly position: number;
	readonly label: string;
	/** How many callers answered THIS question. Never the queue's call count — see the port doc. */
	readonly responses: number;
	/**
	 * Answers 1-5, in order, as counts. Always five entries, so a distribution with no 3s in it is
	 * a zero at index 2 rather than a gap a reader has to notice.
	 */
	readonly distribution: readonly number[];
	/** The mean of the answers given, to one decimal. `null` when nobody answered. */
	readonly average: number | null;
}

/** One queue's survey over a window. */
export interface QueueSurveySummary {
	readonly queueId: string;
	/** Answers across every question. Not callers: one caller answering two questions is two. */
	readonly responses: number;
	/** The mean across every question, to one decimal. `null` when nobody answered. */
	readonly average: number | null;
	readonly questions: readonly QueueSurveyQuestionSummary[];
}

/** One answer one caller gave, as a call's own record of it. */
export interface QueueSurveyCallAnswer {
	readonly callId: string;
	readonly queueId: string;
	readonly questionId: string;
	readonly position: number;
	readonly label: string;
	readonly answer: number;
	readonly answeredAt: string;
}

export interface QueueSurveySource {
	/**
	 * Every queue's survey over one window, for the queue stats report.
	 *
	 * Aggregated in SQL on the PBX side rather than returning rows: a busy tenant's window holds
	 * tens of thousands of answers and the report wants five counts per question.
	 */
	summaries(input: {
		readonly organizationId: string;
		readonly from: Date;
		readonly to: Date;
		readonly queueId?: string;
	}): Promise<readonly QueueSurveySummary[]>;

	/** What the callers on these calls answered. Empty for a call that was never surveyed. */
	answersForCalls(input: {
		readonly organizationId: string;
		readonly callIds: readonly string[];
	}): Promise<readonly QueueSurveyCallAnswer[]>;
}
