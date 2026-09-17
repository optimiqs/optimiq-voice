"use client";

import { Badge } from "~/components/ui/badge";
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
import { formatDuration } from "~/lib/cdr/format";
import { hasUsableWrapUp, talkSharePct } from "~/lib/cdr/reporting";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { QUEUE_DISPOSITION_UNSET } from "~/lib/pbx/contracts";
import { usePbxRoster } from "../../_hooks/use-pbx-queries";
import type { AgentStatsResult } from "../../_hooks/use-cdr-queries";
import type { QueueAgentRow, QueueRow } from "~/lib/pbx/contracts";

/**
 * Who took the calls, and what happened between them.
 *
 * ## The rows come from the LEDGER, not from the roster
 *
 * The wallboard's service-level table is driven by the queue list and filled in from the stats,
 * because a configured queue that received nothing all morning is sometimes the incident. This one
 * is the other way round: it lists the agents who actually took a call in the window. An agent who
 * took none has no row here, and that is right — a report ranking a team by handling should not be
 * eighty rows of zeroes with four rows of work buried in them, and "who was idle" is a question the
 * live wallboard answers with presence rather than one this can answer with an absence.
 *
 * ## Names are joined HERE, from a roster this app already has
 *
 * `agentId` is a `queue_agent` row id and the CDR database holds no names — the server does not
 * join `pbx-db` to invent them, because that is a cross-database join this architecture does not
 * have. So the label comes from the queue-agent roster, indexed through a `Map` rather than a
 * `.find` per row, and an agent deleted since the window renders as their id rather than vanishing.
 *
 * ## Wrap-up is rendered with its sample count or not at all
 *
 * The server's wrap-up is a PROXY — the capped gap between an agent's consecutive calls, because
 * nothing on this platform records an after-call-work state. A mean of two gaps and a mean of four
 * hundred must not look the same on a page somebody takes into a performance conversation, so below the
 * threshold `reporting.ts` names the cell says how thin the evidence is instead of printing a
 * confident number.
 */
export function AgentStatsTable({ stats }: { readonly stats: AgentStatsResult }) {
	const agents = usePbxRoster<QueueAgentRow>(PBX_RESOURCES.queueAgents);
	const queues = usePbxRoster<QueueRow>(PBX_RESOURCES.queues);

	const agentNames = new Map(agents.rows.map((agent) => [agent.id, agent.name]));
	const queueNames = new Map(queues.rows.map((queue) => [queue.id, queue.name]));

	if (stats.query.isPending) {
		return <LoadingPanel label="Loading agent statistics" />;
	}

	if (stats.rows.length === 0) {
		return (
			<EmptyState
				title="Nobody took a queue call in this window"
				description="This table counts calls an agent answered from a queue. Widen the window, or check the wallboard for who is logged in right now."
			/>
		);
	}

	return (
		<>
			{stats.truncated ? (
				<p className="text-xs text-warning">
					This list stops at the server&apos;s group ceiling, so some agents are missing. Narrow the
					window or filter to one queue — there is no next page to fetch.
				</p>
			) : null}
			<TableContainer>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Agent</TableHead>
							<TableHead className="text-right">Answered</TableHead>
							<TableHead className="text-right">Talk time</TableHead>
							<TableHead className="text-right">Average call</TableHead>
							<TableHead className="text-right">Longest call</TableHead>
							<TableHead className="text-right">Picked up in</TableHead>
							<TableHead className="text-right">Caller waited</TableHead>
							<TableHead className="text-right">Wrap-up</TableHead>
							<TableHead>Closed as</TableHead>
							<TableHead>Queues</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{stats.rows.map((row) => {
							const share = talkSharePct(row);
							return (
								<TableRow key={row.agentId}>
									<TableCell className="font-medium">
										{agentNames.get(row.agentId) ?? row.agentId}
										{share === null ? null : (
											<span className="ml-2 text-xs text-muted-foreground">
												{share.toFixed(1)}% talking
											</span>
										)}
									</TableCell>
									<TableCell className="text-right tabular-nums">{row.answered}</TableCell>
									<TableCell className="text-right tabular-nums">
										{formatDuration(row.talkTimeMs)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{formatDuration(row.averageTalkTimeMs)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{formatDuration(row.longestTalkTimeMs)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{formatDuration(row.averageRingTimeMs)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{formatDuration(row.averageAnswerWaitMs)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{hasUsableWrapUp(row) ? (
											formatDuration(row.averageWrapUpMs)
										) : (
											<span
												className="text-muted-foreground"
												title={`Only ${String(row.wrapUpSamples)} gaps between calls fell inside the cap — too few to average.`}
											>
												Not enough data
											</span>
										)}
									</TableCell>
									{/*
									 * The wrap-up codes this agent's calls closed as.
									 *
									 * Rendered as counts and NEVER as a share of `answered`: the two do not have
									 * to agree. A leg dispositioned after the CDR consumer filed it keeps its
									 * NULL, and a queue that started asking halfway through the window has both
									 * kinds in it — so a percentage here would be a number the ledger cannot
									 * support, on a page somebody takes into a performance conversation.
									 *
									 * `unset` is one of the codes and is shown as one, because "the agent did not
									 * answer the question" is an outcome a supervisor wants to see rather than a
									 * gap to hide.
									 */}
									<TableCell>
										{row.dispositions.length === 0 ? (
											<span className="text-xs text-muted-foreground">Not asked</span>
										) : (
											<div className="flex flex-wrap gap-1">
												{row.dispositions.map((entry) => (
													<Badge
														key={entry.code}
														tone={entry.code === QUEUE_DISPOSITION_UNSET ? "warning" : "neutral"}
														title={
															entry.code === QUEUE_DISPOSITION_UNSET
																? "The wrap-up time ran out before a code was chosen."
																: undefined
														}
													>
														{entry.code} · {entry.count}
													</Badge>
												))}
											</div>
										)}
									</TableCell>
									<TableCell>
										<div className="flex flex-wrap gap-1">
											{row.queues.map((queue) => (
												<Badge key={queue.queueId} tone="neutral">
													{queueNames.get(queue.queueId) ?? queue.queueId} · {queue.answered}
												</Badge>
											))}
										</div>
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</TableContainer>
		</>
	);
}
