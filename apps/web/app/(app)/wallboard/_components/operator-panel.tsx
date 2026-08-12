"use client";

import Link from "next/link";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { EmptyState } from "~/components/ui/empty-state";
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
import { ApiError } from "~/lib/api-client";
import { DEFAULT_SLA_SECONDS } from "~/lib/cdr/client";
import { formatDuration } from "~/lib/cdr/format";
import { emptyQueueStats, formatWait, waitTone } from "~/lib/cdr/queue-stats";
import { longestWaitMs } from "~/lib/live/store";
import { PBX_CHILDREN, PBX_RESOURCES } from "~/lib/pbx/client";
import { QUEUE_PRIORITY_MIN } from "~/lib/pbx/contracts";
import { routes } from "~/lib/routes";
import { usePermission } from "../../_context/session-context";
import { useQueueStats } from "../../_hooks/use-cdr-queries";
import { useLiveAgentStates, useLiveQueue } from "../../_hooks/use-live-queries";
import { usePbxChildren, usePbxItem, usePbxList } from "../../_hooks/use-pbx-queries";
import { AgentSessionControls, LiveIndicator } from "../../queues/_components/agent-console";
import { AgentStatusBadge } from "../../queues/_components/queue-shared";
import { ServiceLevelBadge, WallTile } from "./wallboard-shared";
import type { QueueAgentRow, QueueAgentStatus, QueueRow, QueueTierRow } from "~/lib/pbx/contracts";

/**
 * One queue's floor: the line as the callers in it are standing, and the agents who could take
 * them.
 *
 * ## Not the queue's own page, and the difference is who opens it
 *
 * `/queues/<id>` is configuration — the strategy, the wait caps, where the overflow points — gated
 * by `queues.read` and edited under `queues.write`. This is gated by `queues.monitor` and shows
 * what is happening RIGHT NOW, which is what somebody opens with a customer on hold. The two pages
 * are about the same queue and answer different questions, and merging them would have put a form
 * that republishes the dial plan on a screen people open in a hurry.
 *
 * ## Watching and acting are separate grants, and the page honours that
 *
 * Everything visible here rides `queues.monitor`. The only ACTIONS — moving an agent in or out of
 * distribution — ride `queues.manage-agents`, which most people watching a wallboard do not hold.
 * They are gated per control rather than by hiding the agents table: a supervisor who can see that
 * three agents are on a break and cannot end one still needs to know it, because the next thing
 * they do is telephone somebody.
 *
 * ## There is no "remove this caller"
 *
 * A waiting caller is on a live leg held by an engine instance, and there is no endpoint that ends
 * one — deliberately. What exists is the queue's own machinery: the wait caps, the exit key and the
 * timeout destination. Offering a button here that could only ever 404 would be worse than the
 * absence.
 */
export function OperatorPanel({ queueId }: { queueId: string }) {
	const queue = usePbxItem<QueueRow>(PBX_RESOURCES.queues, queueId);
	const tiers = usePbxChildren<QueueTierRow>(PBX_CHILDREN.queueTiers, "queues", queueId);
	const agents = usePbxList<QueueAgentRow>(PBX_RESOURCES.queueAgents, { page: 1, limit: 100 });

	const live = useLiveQueue(queueId);
	const agentStates = useLiveAgentStates();
	const stats = useQueueStats({ queueId });

	const canManageAgents = usePermission(PBX_RESOURCES.queueAgents.permissions.write);
	const canJoinAny = usePermission("queues.join");

	if (queue.isPending) {
		return <LoadingPanel label="Loading queue" />;
	}

	/**
	 * A 403 here is not a broken page: this route is gated on `queues.monitor` and the queue ROW is
	 * `queues.read`, which are genuinely different grants. Saying so is better than an empty shell,
	 * and the live half is not rendered without the roster to make sense of it.
	 */
	if (
		queue.error instanceof ApiError &&
		(queue.error.status === 403 || queue.error.status === 404)
	) {
		return (
			<EmptyState
				title={queue.error.status === 403 ? "You may watch queues, not read them" : "No such queue"}
				description={
					queue.error.status === 403
						? "This panel needs to read the queue's configuration to label what it is showing, and your role does not include that. An administrator can grant it under Settings → Members."
						: "It may have been deleted from another session."
				}
				action={
					<Button render={<Link href={routes.wallboard} />} variant="secondary">
						Back to the wallboard
					</Button>
				}
			/>
		);
	}

	if (!queue.data) {
		return (
			<EmptyState
				title="Could not load this queue"
				description={queue.error instanceof Error ? queue.error.message : "Try again in a moment."}
			/>
		);
	}

	const row = queue.data;
	const agentsById = new Map(agents.rows.map((agent) => [agent.id, agent]));
	/** `(level, position)` — the order the engine offers calls in, which is what makes it a ladder. */
	const roster = [...(tiers.data ?? [])].sort(
		(a, b) => a.level - b.level || a.position - b.position || a.id.localeCompare(b.id),
	);
	const levels = [...new Set(roster.map((tier) => tier.level))].sort((a, b) => a - b);

	const waiting = live.waiting;
	const longest = waiting.length === 0 ? null : longestWaitMs(waiting);
	const tone = longest === null ? "neutral" : waitTone(longest);

	let available = 0;
	let staffed = 0;
	for (const tier of roster) {
		const status = agentStates.byAgentId.get(tier.queueAgentId)?.status;
		if (status !== undefined && status !== "logged-out") {
			staffed += 1;
		}
		if (status === "available") {
			available += 1;
		}
	}

	const windowStats = stats.byQueueId.get(queueId) ?? emptyQueueStats(queueId);

	return (
		<>
			<PageHeader
				title={row.name}
				description={`The line and the floor, live. ${
					row.maxWaitSeconds === 0
						? "This queue holds callers indefinitely."
						: `Callers are held up to ${String(row.maxWaitSeconds)} seconds.`
				}${row.exitKey ? ` Pressing ${row.exitKey} leaves the line.` : ""}`}
				actions={
					<div className="flex items-center gap-2">
						<LiveIndicator />
						<Button render={<Link href={routes.wallboard} />} variant="ghost">
							All queues
						</Button>
						<Button render={<Link href={routes.queue(row.id)} />} variant="secondary">
							Queue settings
						</Button>
					</div>
				}
			/>

			<div className="grid gap-4 sm:grid-cols-4">
				<WallTile label="Waiting" value={String(waiting.length)} tone={tone} />
				<WallTile label="Longest wait" value={formatWait(longest)} tone={tone} />
				<WallTile
					label="Available"
					value={String(available)}
					tone={waiting.length > 0 && staffed === 0 ? "alert" : "neutral"}
					hint={`${String(staffed)} of ${String(roster.length)} staffed`}
				/>
				{/*
				 * The one number here that is not live. No window control on this page on purpose: it is
				 * opened with somebody on hold, and the question is "is this queue coping", not "how did
				 * last Tuesday go". The window is therefore the endpoint's own default — the last 24
				 * hours — and the tile says which, from the range the SERVER echoed rather than from a
				 * constant this component chose.
				 */}
				<WallTile
					label="Answered"
					value={String(windowStats.answered)}
					hint={
						<span className="inline-flex flex-wrap items-center gap-1.5">
							<ServiceLevelBadge serviceLevelPct={windowStats.serviceLevelPct} />
							<span>
								inside {String(stats.slaSeconds ?? DEFAULT_SLA_SECONDS)}s
								{stats.range ? `, since ${new Date(stats.range.from).toLocaleString()}` : null}
							</span>
						</span>
					}
				/>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>The line</CardTitle>
					<CardDescription>
						Ordered as the queue will answer them: priority first, then the moment they joined. A
						caller who hung up and rang back inside the discard window keeps the place they had,
						which is why one can appear ahead of somebody who has been holding longer.
					</CardDescription>
				</CardHeader>
				<CardBody className="px-0 py-0">
					{waiting.length === 0 ? (
						<p className="px-6 py-8 text-center text-sm text-muted-foreground">
							{live.loaded
								? "Nobody is waiting."
								: "Waiting for the queue's first frame — this shows the whole line, not just what arrives from now on."}
						</p>
					) : (
						<TableContainer className="rounded-none border-0">
							<Table>
								<caption className="sr-only">Callers waiting in this queue</caption>
								<TableHeader>
									<TableRow>
										<TableHead>Position</TableHead>
										<TableHead>Caller</TableHead>
										<TableHead>Waiting</TableHead>
										<TableHead>Priority</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{waiting.map((caller) => (
										<TableRow key={caller.callId}>
											<TableCell className="font-medium" data-tabular>
												{caller.position}
											</TableCell>
											<TableCell>
												<div className="flex items-center gap-2">
													{/*
													 * A withheld number is a caller the engine could not read a
													 * number off, and it is worth saying rather than leaving blank:
													 * it is also the one caller who can never be offered an
													 * abandoned-resume promise, because the promise is keyed by
													 * number.
													 */}
													<span>{caller.callerNumber ?? "Withheld"}</span>
													{caller.resumed ? (
														<Badge tone="accent" title="Rang back and kept their place">
															Resumed
														</Badge>
													) : null}
												</div>
											</TableCell>
											<TableCell data-tabular>{formatDuration(caller.waitedMs)}</TableCell>
											<TableCell>
												{caller.priority === QUEUE_PRIORITY_MIN ? (
													<span className="text-sm text-muted-foreground">—</span>
												) : (
													<Badge tone="warning" data-tabular>
														{caller.priority}
													</Badge>
												)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</TableContainer>
					)}
				</CardBody>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>The floor</CardTitle>
					<CardDescription>
						Grouped by ring level, because that is the order the queue tries them: every agent at a
						level is offered the call before the next level is brought in. Status comes from the
						live agent store, which is what distribution actually reads — the stored column is only
						the last thing anybody wrote down.
					</CardDescription>
				</CardHeader>
				<CardBody className="flex flex-col gap-5">
					{tiers.isPending || agents.query.isPending ? (
						<LoadingPanel label="Loading the roster" />
					) : roster.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							Nobody serves this queue, so a caller reaching it waits out the cap and then takes the
							timeout destination.
						</p>
					) : (
						levels.map((level) => (
							<section key={level} className="flex flex-col gap-2">
								<h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
									Level {level}
									{level === levels[0] ? " · tried first" : null}
								</h3>
								<ul className="flex flex-col gap-2">
									{roster
										.filter((tier) => tier.level === level)
										.map((tier) => {
											const agent = agentsById.get(tier.queueAgentId);
											// The socket first and the row second: the engine writes ringing and
											// on-call into the bucket without touching Postgres, so the column is
											// behind by construction and never ahead.
											const status = (agentStates.byAgentId.get(tier.queueAgentId)?.status ??
												agent?.status ??
												"logged-out") as QueueAgentStatus;
											const reason = agentStates.byAgentId.get(tier.queueAgentId)?.reason;
											return (
												<li
													key={tier.id}
													className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border border-border bg-canvas px-3 py-2"
												>
													<span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
														{agent?.name ?? `${tier.queueAgentId.slice(0, 8)}…`}
													</span>
													<span className="text-xs text-muted-foreground" data-tabular>
														#{tier.position}
													</span>
													{tier.announcePromptId ? (
														<Badge tone="neutral" title="This tier plays its own whisper">
															Own whisper
														</Badge>
													) : null}
													{agent && !agent.enabled ? <Badge tone="neutral">Disabled</Badge> : null}
													<AgentStatusBadge status={status} />
													{reason ? (
														<span className="truncate text-xs text-muted-foreground">{reason}</span>
													) : null}
													{agent ? (
														<AgentSessionControls
															agentId={agent.id}
															agentName={agent.name}
															status={status}
															canManage={canManageAgents || canJoinAny}
														/>
													) : null}
												</li>
											);
										})}
								</ul>
							</section>
						))
					)}

					{!canManageAgents ? (
						<p className="text-xs text-subtle-foreground">
							Changing who is taking calls needs the staffing grant, which your role does not
							include. Everything above is what the floor looks like from here.
						</p>
					) : null}
				</CardBody>
			</Card>
		</>
	);
}
