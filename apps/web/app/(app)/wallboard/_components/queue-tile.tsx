"use client";

import Link from "next/link";
import { Badge } from "~/components/ui/badge";
import { formatWait, waitTone } from "~/lib/cdr/queue-stats";
import { longestWaitMs } from "~/lib/live/store";
import { PBX_CHILDREN } from "~/lib/pbx/client";
import { routes } from "~/lib/routes";
import { useLiveQueue } from "../../_hooks/use-live-queries";
import { usePbxChildren } from "../../_hooks/use-pbx-queries";
import { WallTile } from "./wallboard-shared";
import type { LiveAgentStatesResult } from "../../_hooks/use-live-queries";
import type { QueueRow } from "~/lib/pbx/contracts";

/**
 * One queue's live state: who is holding, how long the worst of them has been, and who could take
 * them.
 *
 * ## Why this is a COMPONENT per queue rather than a loop in the screen
 *
 * Each tile subscribes to its own `queue:<id>` topic and reads its own tier list, and hooks cannot
 * be called in a loop. That is not a workaround — it is the right decomposition: a tile mounts and
 * unmounts with its queue, so a queue deleted while the wallboard is open takes its subscription
 * with it rather than leaving a socket topic held by a screen that no longer draws it.
 *
 * ## The three numbers, and what each is actually made of
 *
 * - **Waiting** is the `queue-waiting` bucket, which the API now feeds into this topic. It is a
 *   snapshot plus a watch rather than a replay of joins, so a page opened mid-shift is correct
 *   immediately — the honest "counting from when you opened this" caveat the old event-derived
 *   count carried is gone, and with it the reason a supervisor could not trust the number.
 * - **Longest wait** ticks client-side from each entry's `joinedAt`, because nothing arrives on the
 *   socket while a caller simply keeps holding — which is exactly the situation the number exists
 *   to show.
 * - **Available** is the org-wide `agent-state` topic joined against THIS queue's tiers. The
 *   roster is what makes an agent's status mean something here: an agent who is `available` and
 *   tiered into three other queues is not available to this one.
 */
export function QueueTile({
	queue,
	agentStates,
}: {
	queue: QueueRow;
	/** Passed down rather than subscribed per tile: one org-wide topic, however many queues. */
	agentStates: LiveAgentStatesResult;
}) {
	const live = useLiveQueue(queue.id);
	const tiers = usePbxChildren(PBX_CHILDREN.queueTiers, "queues", queue.id);

	const roster = tiers.data ?? [];
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

	const waiting = live.waiting.length;
	const longest = waiting === 0 ? null : longestWaitMs(live.waiting);
	const tone = longest === null ? "neutral" : waitTone(longest);

	/**
	 * The one condition worth colouring the whole tile for.
	 *
	 * Callers holding with nobody logged in is not a slow queue, it is a queue that cannot answer —
	 * and it is the state `maxWaitNoAgentSeconds` exists for. It outranks the wait thresholds
	 * because a thirty-second wait on an unstaffed queue is worse news than a four-minute wait on a
	 * staffed one.
	 */
	const unattended = waiting > 0 && staffed === 0;

	return (
		<article className="flex flex-col gap-3 rounded-panel border border-border bg-surface p-4">
			<header className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h2 className="truncate text-base font-semibold text-foreground">
						<Link
							href={routes.wallboardQueue(queue.id)}
							className="underline-offset-4 hover:underline"
						>
							{queue.name}
						</Link>
					</h2>
					<p className="truncate text-xs text-muted-foreground">
						{queue.extensionNumber ? `Dial ${queue.extensionNumber} · ` : null}
						{queue.strategy}
					</p>
				</div>
				{unattended ? (
					<Badge tone="danger">Nobody logged in</Badge>
				) : queue.enabled ? null : (
					<Badge tone="neutral">Disabled</Badge>
				)}
			</header>

			<div className="grid grid-cols-3 gap-3">
				<WallTile
					label="Waiting"
					value={String(waiting)}
					tone={unattended ? "alert" : waiting === 0 ? "neutral" : tone}
				/>
				<WallTile label="Longest wait" value={formatWait(longest)} tone={tone} />
				<WallTile
					label="Available"
					value={String(available)}
					tone={unattended ? "alert" : "neutral"}
					hint={`${String(staffed)} of ${String(roster.length)} staffed`}
				/>
			</div>

			{!live.loaded ? (
				<p className="text-xs text-subtle-foreground">Waiting for the first frame…</p>
			) : null}
		</article>
	);
}
