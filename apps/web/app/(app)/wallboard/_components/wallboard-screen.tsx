"use client";

import Link from "next/link";
import { parseAsInteger, useQueryState } from "nuqs";
import { useId } from "react";
import { EmptyState } from "~/components/ui/empty-state";
import { inputClassName } from "~/components/ui/field";
import { PageHeader } from "~/components/ui/page-header";
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
import { DEFAULT_SLA_SECONDS, MAX_SLA_SECONDS } from "~/lib/cdr/client";
import { formatDuration } from "~/lib/cdr/format";
import { describeShortfalls, emptyQueueStats } from "~/lib/cdr/queue-stats";
import { cn } from "~/lib/cn";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { routes } from "~/lib/routes";
import { useQueueStats } from "../../_hooks/use-cdr-queries";
import { useLiveAgentStates } from "../../_hooks/use-live-queries";
import { usePbxList } from "../../_hooks/use-pbx-queries";
import {
	RANGE_PRESET_LABELS,
	RANGE_PRESETS,
	useTimeRangeState,
	type RangePreset,
} from "../../cdr/_components/time-range";
import { LiveIndicator } from "../../queues/_components/agent-console";
import { QueueTile } from "./queue-tile";
import { ServiceLevelBadge } from "./wallboard-shared";
import type { QueueRow } from "~/lib/pbx/contracts";

/**
 * The wallboard: every queue's line, live, over a service level for the window underneath.
 *
 * ## Two clocks on one screen, and they are not the same clock
 *
 * The tiles are NOW — a KV snapshot and a watch, ticking client-side between frames — and the table
 * is a WINDOW, a grouped aggregate over the call ledger re-asked on a timer. They are deliberately
 * not merged into one row per queue: "three people are waiting" and "we answered 94% of yesterday
 * inside twenty seconds" are answers to different questions, and a single row implying the second
 * describes the first is how somebody reads an SLA that has not moved yet as evidence that a queue
 * which is currently on fire is fine.
 *
 * So the live half is above, large, and the reporting half is below with its window and its target
 * stated on it.
 *
 * ## Every configured queue is listed, including the silent ones
 *
 * The stats endpoint groups over legs that exist, so a queue with no traffic in the window is simply
 * absent from its response. The rows are therefore driven by the QUEUE LIST and filled in from the
 * stats — see `emptyQueueStats`. Driving them from the response instead would make a queue that
 * received no calls all morning indistinguishable from one that was deleted, and the first of those
 * is sometimes the incident somebody opened this page about.
 */
export function WallboardScreen() {
	const queues = usePbxList<QueueRow>(PBX_RESOURCES.queues, { page: 1, limit: 100 });
	const agentStates = useLiveAgentStates();
	const range = useTimeRangeState();

	/**
	 * The target lives in the URL beside the window, because it is a QUESTION rather than a setting.
	 * "How are we at twenty seconds" and "how are we at sixty" are two things a supervisor compares,
	 * and the server takes it as a query parameter precisely so that comparison is not two writes and
	 * a race. In the URL, both are one link somebody can paste into a conversation.
	 */
	const [slaSeconds, setSlaSeconds] = useQueryState(
		"sla",
		parseAsInteger.withDefault(DEFAULT_SLA_SECONDS).withOptions({ clearOnDefault: true }),
	);

	const stats = useQueueStats({ from: range.from, to: range.to, slaSeconds });
	const slaId = useId();
	const presetId = useId();

	const rows = queues.rows;

	return (
		<>
			<PageHeader
				title="Wallboard"
				description="Who is holding right now, and how the queues have been doing over the window below. Nothing here can be edited — this is the floor as it is."
				actions={
					<div className="flex items-center gap-2">
						<LiveIndicator />
					</div>
				}
			/>

			{queues.query.isPending ? (
				<LoadingPanel label="Loading queues" />
			) : rows.length === 0 ? (
				<EmptyState
					title="There are no queues to watch"
					description="A queue holds callers until somebody is free to take them. Once one exists and calls reach it, this screen fills in."
				/>
			) : (
				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
					{rows.map((queue) => (
						<QueueTile key={queue.id} queue={queue} agentStates={agentStates} />
					))}
				</div>
			)}

			<section className="flex flex-col gap-3">
				<header className="flex flex-wrap items-end justify-between gap-3">
					<div>
						<h2 className="text-sm font-semibold text-foreground">Service level</h2>
						<p className="max-w-prose text-xs text-muted-foreground">
							{stats.range
								? `Calls from ${new Date(stats.range.from).toLocaleString()} to ${new Date(stats.range.to).toLocaleString()}, answered within ${String(stats.slaSeconds ?? slaSeconds)} seconds — as a share of every call the queue was asked to serve, not of the ones it answered.`
								: "Answered within the target, as a share of every call the queue was asked to serve."}
						</p>
					</div>

					<div className="flex flex-wrap items-end gap-3">
						<div className="flex flex-col gap-1.5">
							<label htmlFor={presetId} className="text-xs font-medium text-muted-foreground">
								Window
							</label>
							<select
								id={presetId}
								value={range.preset}
								onChange={(event) => {
									range.setPreset(event.target.value as RangePreset);
								}}
								className={cn(inputClassName, "w-44 pr-8")}
							>
								{RANGE_PRESETS.map((preset) => (
									<option key={preset} value={preset}>
										{RANGE_PRESET_LABELS[preset]}
									</option>
								))}
							</select>
						</div>

						{range.preset === "custom" ? (
							<>
								<div className="flex flex-col gap-1.5">
									<label
										htmlFor={`${presetId}-from`}
										className="text-xs font-medium text-muted-foreground"
									>
										From
									</label>
									<input
										id={`${presetId}-from`}
										type="datetime-local"
										value={range.customFrom}
										onChange={(event) => {
											range.setCustomFrom(event.target.value);
										}}
										className={inputClassName}
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<label
										htmlFor={`${presetId}-to`}
										className="text-xs font-medium text-muted-foreground"
									>
										To
									</label>
									<input
										id={`${presetId}-to`}
										type="datetime-local"
										value={range.customTo}
										onChange={(event) => {
											range.setCustomTo(event.target.value);
										}}
										className={inputClassName}
									/>
								</div>
							</>
						) : null}

						<div className="flex flex-col gap-1.5">
							<label htmlFor={slaId} className="text-xs font-medium text-muted-foreground">
								Target (seconds)
							</label>
							<input
								id={slaId}
								type="number"
								min={1}
								max={MAX_SLA_SECONDS}
								value={slaSeconds}
								onChange={(event) => {
									const next = Number(event.target.value);
									// Anything unparseable falls back to the server's own default rather than
									// being sent: a half-typed number is a keystroke, not a question.
									void setSlaSeconds(Number.isFinite(next) && next > 0 ? next : null);
								}}
								className={cn(inputClassName, "w-28")}
							/>
						</div>
					</div>
				</header>

				<TableContainer>
					<Table>
						<caption className="sr-only">Service level by queue over the selected window</caption>
						<TableHeader>
							<TableRow>
								<TableHead>Queue</TableHead>
								<TableHead>Service level</TableHead>
								<TableHead>Offered</TableHead>
								<TableHead>Answered</TableHead>
								<TableHead>Average wait</TableHead>
								<TableHead>Longest wait</TableHead>
								<TableHead>Not served</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((queue) => {
								const row = stats.byQueueId.get(queue.id) ?? emptyQueueStats(queue.id);
								const shortfalls = describeShortfalls(row);
								return (
									<TableRow key={queue.id}>
										<TableCell className="font-medium">
											<Link
												href={routes.wallboardQueue(queue.id)}
												className="text-primary underline-offset-4 hover:underline"
											>
												{queue.name}
											</Link>
										</TableCell>
										<TableCell>
											<ServiceLevelBadge serviceLevelPct={row.serviceLevelPct} />
										</TableCell>
										<TableCell data-tabular>{row.offered}</TableCell>
										<TableCell data-tabular>{row.answered}</TableCell>
										{/*
										 * Answered calls only, which is the server's choice and is stated in the
										 * header rather than hidden: an average that included the callers who
										 * gave up would FALL as a queue got worse.
										 */}
										<TableCell data-tabular>
											{row.answered === 0 ? "—" : formatDuration(row.averageAnswerWaitMs)}
										</TableCell>
										<TableCell data-tabular>
											{row.answered === 0 ? "—" : formatDuration(row.longestAnswerWaitMs)}
										</TableCell>
										<TableCell>
											{shortfalls.length === 0 ? (
												<span className="text-sm text-muted-foreground">—</span>
											) : (
												<span className="text-sm text-muted-foreground">
													{shortfalls
														.map((entry) => `${entry.label}: ${String(entry.value)}`)
														.join(" · ")}
												</span>
											)}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</TableContainer>

				<p className="text-xs text-subtle-foreground">
					A queue with no calls in the window has no service level at all, and says so rather than
					reporting 0% — an idle queue and a failing one must not look the same. These numbers are
					re-asked every thirty seconds; the tiles above are live.
				</p>
			</section>
		</>
	);
}
