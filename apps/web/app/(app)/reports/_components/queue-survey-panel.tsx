"use client";

import { EmptyState } from "~/components/ui/empty-state";
import { LoadingPanel } from "~/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableHeader,
	TableRow,
} from "~/components/ui/table";
import {
	formatSurveyAverage,
	ratedQueues,
	SURVEY_ANSWERS,
	surveyAnswerCount,
	surveyBarPct,
	surveyTone,
} from "~/lib/cdr/queue-survey";
import { cn } from "~/lib/cn";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { usePbxRoster } from "../../_hooks/use-pbx-queries";
import type { QueueStatsResult } from "../../_hooks/use-cdr-queries";
import type { QueueSurveyQuestionSummary } from "~/lib/cdr/contracts";
import type { QueueRow } from "~/lib/pbx/contracts";

/**
 * What callers said about the queue after the agent hung up.
 *
 * ## Only queues with answers, and worst first
 *
 * A survey panel listing every configured queue would be mostly rows saying nothing, and the one
 * row worth acting on would be somewhere in the middle of them. `ratedQueues` drops queues with no
 * answers and sorts by average ascending, so the queue a supervisor should look at is the first
 * thing on the panel.
 *
 * ## The distribution is drawn, the average is written, and neither is invented
 *
 * A mean of five 4s and a mean of one 5 and four 3s are the same number and not the same queue, so
 * the five counts are rendered as bars beside it. A question nobody answered gets the words "No
 * answers", never 0.0 — see `lib/cdr/queue-survey.ts` for why that distinction is load-bearing
 * rather than pedantic.
 *
 * ## Names come from the roster, as the agent table's do
 *
 * `queueId` is a uuid and the call ledger holds no queue names. The label is joined from the roster
 * this app already has, and a queue deleted since the window renders as its id rather than
 * disappearing from a report of what happened.
 */
export function QueueSurveyPanel({ stats }: { readonly stats: QueueStatsResult }) {
	const queues = usePbxRoster<QueueRow>(PBX_RESOURCES.queues);
	const queueNames = new Map(queues.rows.map((queue) => [queue.id, queue.name]));

	if (stats.query.isPending) {
		return <LoadingPanel label="Loading survey results" />;
	}

	const rated = ratedQueues(stats.rows);
	if (rated.length === 0) {
		return (
			<EmptyState
				title="No caller answered a survey in this window"
				description="A post-call survey is asked only after an answered queue call, and only on queues that have one configured. Add questions on the queue, or widen the window."
			/>
		);
	}

	return (
		<TableContainer>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Queue</TableHead>
						<TableHead>Question</TableHead>
						<TableHead className="text-right">Answers</TableHead>
						<TableHead className="text-right">Average</TableHead>
						<TableHead className="w-[40%]">Scores</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rated.flatMap((queue) =>
						queue.survey.questions.map((question, index) => (
							<TableRow key={`${queue.queueId}:${question.questionId}`}>
								<TableCell className="font-medium">
									{/* The queue is named once per queue, not once per question. */}
									{index === 0 ? (
										<>
											{queueNames.get(queue.queueId) ?? queue.queueId}
											<span className="ml-2 text-xs text-muted-foreground">
												{formatSurveyAverage(queue.survey.average)} overall
											</span>
										</>
									) : null}
								</TableCell>
								<TableCell>{question.label}</TableCell>
								<TableCell className="text-right tabular-nums">{question.responses}</TableCell>
								<TableCell
									className={cn("text-right tabular-nums", toneClassName(question.average))}
								>
									{formatSurveyAverage(question.average)}
								</TableCell>
								<TableCell>
									<ScoreBars question={question} />
								</TableCell>
							</TableRow>
						)),
					)}
				</TableBody>
			</Table>
		</TableContainer>
	);
}

/** Five bars, one per key the caller could press, labelled with the count behind them. */
function ScoreBars({ question }: { readonly question: QueueSurveyQuestionSummary }) {
	return (
		<div className="flex flex-col gap-1">
			{SURVEY_ANSWERS.map((answer) => {
				const pct = surveyBarPct(question, answer);
				return (
					<div key={answer} className="flex items-center gap-2">
						<span className="w-3 text-right text-xs tabular-nums text-muted-foreground">
							{answer}
						</span>
						<div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-primary"
								style={{ width: `${String(pct)}%` }}
							/>
						</div>
						<span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
							{surveyAnswerCount(question, answer)} ({pct}%)
						</span>
					</div>
				);
			})}
		</div>
	);
}

function toneClassName(average: number | null): string {
	switch (surveyTone(average)) {
		case "good": {
			return "text-success";
		}
		case "fair": {
			return "text-foreground";
		}
		case "poor": {
			return "text-warning";
		}
		default: {
			return "text-muted-foreground";
		}
	}
}
