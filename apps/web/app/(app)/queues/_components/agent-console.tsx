"use client";

import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody } from "~/components/ui/card";
import { Input } from "~/components/ui/field";
import { actionForStatus } from "~/lib/live/agent-session";
import { useAgentSessionAction, useMyAgentSession } from "../../_hooks/use-agent-session";
import { useLiveAgentStates } from "../../_hooks/use-live-queries";
import { useLiveStatus } from "../../_context/live-context";
import { AGENT_STATUS_LABELS, AgentStatusBadge } from "./queue-shared";
import type { QueueAgentStatus } from "~/lib/pbx/contracts";

/**
 * The agent's own availability, as a strip above the queues.
 *
 * ## Why it renders nothing rather than an empty state
 *
 * Most members of an organization are not agents. A strip that said "you have no agent seat" on
 * every visit to the queues page would be a permanent apology for a feature that does not apply,
 * so the absence of a link is the absence of the control. An administrator who wants somebody to
 * have one links a user on the agent's dialog, and it appears.
 *
 * ## The status comes from the SOCKET, and the query is the fallback
 *
 * `queue_agent.status` is a persisted last-known value — `packages/pbx-db` says so — and the
 * `agent-state` bucket is what distribution actually reads. The engine writes `ringing` and
 * `on-call` into the bucket without touching Postgres at all, so a console that rendered the
 * column would show an agent as "available" while their phone was ringing. The query is used only
 * until the first frame arrives, which is what makes the first paint say something true instead of
 * nothing.
 *
 * ## Buttons the machine would refuse are not offered
 *
 * `actionForStatus` returns `undefined` where the ACD state machine has no edge — there is no
 * `on-call → on-break`, because a break that interrupted a live call is a state the switch could
 * not honour. Rendering the button anyway would be offering a 409.
 */
export function AgentConsole() {
	const seat = useMyAgentSession();
	const live = useLiveAgentStates();
	const connection = useLiveStatus();
	const action = useAgentSessionAction();
	const [reason, setReason] = useState("");
	const [showReason, setShowReason] = useState(false);

	const agent = seat.data;
	if (seat.isPending || agent === null || agent === undefined || !agent.canManageSelf) {
		return null;
	}

	const liveEntry = live.byAgentId.get(agent.agentId);
	const status = (liveEntry?.status ?? agent.status) as QueueAgentStatus;
	const currentReason = liveEntry?.reason ?? agent.reason;
	const shiftAction = actionForStatus(status, "toggle-shift");
	const breakAction = actionForStatus(status, "toggle-break");
	const loggedOut = status === "logged-out";

	return (
		<Card>
			<CardBody className="flex flex-wrap items-center gap-x-4 gap-y-3">
				<div className="flex min-w-0 flex-1 items-center gap-3">
					<AgentStatusBadge status={status} />
					<div className="min-w-0">
						<p className="truncate text-sm font-medium text-foreground">{agent.name}</p>
						<p className="truncate text-xs text-muted-foreground">
							{currentReason
								? `${AGENT_STATUS_LABELS[status]} — ${currentReason}`
								: describeConnection(connection, liveEntry !== undefined)}
						</p>
					</div>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					{showReason && breakAction === "pause" ? (
						<Input
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							placeholder="Back in ten minutes"
							maxLength={128}
							aria-label="Break reason"
							className="w-56"
						/>
					) : null}

					{breakAction === undefined ? null : breakAction === "resume" ? (
						<Button
							size="sm"
							variant="secondary"
							loading={action.isPending}
							onClick={() => {
								setShowReason(false);
								setReason("");
								action.run({ agentId: agent.agentId, action: "resume" });
							}}
						>
							End break
						</Button>
					) : (
						<Button
							size="sm"
							variant="secondary"
							disabled={loggedOut}
							loading={action.isPending}
							onClick={() => {
								if (!showReason) {
									// The reason is optional, so the first press reveals the field rather
									// than blocking on it: an agent leaving their desk should not have to
									// type to do it.
									setShowReason(true);
									return;
								}
								action.run({
									agentId: agent.agentId,
									action: "pause",
									...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
								});
								setShowReason(false);
								setReason("");
							}}
						>
							{showReason ? "Start break" : "Take a break"}
						</Button>
					)}

					{shiftAction === undefined ? null : (
						<Button
							size="sm"
							variant={shiftAction === "login" ? "primary" : "ghost"}
							loading={action.isPending}
							onClick={() => {
								setShowReason(false);
								setReason("");
								action.run({ agentId: agent.agentId, action: shiftAction });
							}}
						>
							{shiftAction === "login" ? "Log in" : "Log out"}
						</Button>
					)}
				</div>
			</CardBody>
		</Card>
	);
}

/**
 * What the sub-line says when there is no break reason to show.
 *
 * The distinction that matters is "this is live" versus "this is the last thing we were told":
 * an agent whose socket dropped is still being distributed calls against whatever the bucket says,
 * and a console that looked identical either way would let them believe a Log out had taken.
 */
function describeConnection(status: string, hasLiveEntry: boolean): string {
	if (status === "open") {
		return hasLiveEntry ? "Live" : "Live — no state recorded yet";
	}
	if (status === "refused") {
		return "Not live — sign in again to reconnect";
	}
	return "Last known state — reconnecting";
}

/**
 * The supervisor's version: one agent's controls, for the agents table.
 *
 * Split from the strip rather than parameterised because the two answer different questions. The
 * strip is "am I taking calls?" and is about the person reading it; this is "is Ada taking calls?"
 * and is about somebody else — which is why it has no break-reason field (a supervisor typing a
 * reason on somebody's behalf is inventing one) and why it is gated on `canManage` rather than
 * `canManageSelf`.
 */
export function AgentSessionControls({
	agentId,
	agentName,
	status,
	canManage,
}: {
	agentId: string;
	agentName: string;
	status: QueueAgentStatus;
	canManage: boolean;
}) {
	const action = useAgentSessionAction();
	if (!canManage) {
		return null;
	}
	const shiftAction = actionForStatus(status, "toggle-shift");
	if (shiftAction === undefined) {
		return null;
	}
	return (
		<Button
			size="sm"
			variant="ghost"
			loading={action.isPending}
			onClick={() => action.run({ agentId, action: shiftAction })}
			aria-label={`${shiftAction === "login" ? "Log in" : "Log out"} ${agentName}`}
		>
			{shiftAction === "login" ? "Log in" : "Log out"}
		</Button>
	);
}

/** A small "Live" / "Reconnecting" pill for a page header. */
export function LiveIndicator({ label = "Live" }: { label?: string }) {
	const status = useLiveStatus();
	if (status === "open") {
		return (
			<Badge tone="success">
				<span
					aria-hidden
					className="size-1.5 rounded-full bg-current motion-safe:animate-pulse"
				/>
				{label}
			</Badge>
		);
	}
	if (status === "refused") {
		return <Badge tone="danger">Not live</Badge>;
	}
	return <Badge tone="neutral">Reconnecting</Badge>;
}
