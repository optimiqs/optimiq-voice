"use client";

import { useEffect, useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody } from "~/components/ui/card";
import { agentStateFromSession } from "~/lib/live/agent-session";
import { PBX_CHILDREN } from "~/lib/pbx/client";
import { useMyAgentSession, useSubmitDisposition } from "../../_hooks/use-agent-session";
import { useLiveAgentStates } from "../../_hooks/use-live-queries";
import { usePbxChildren } from "../../_hooks/use-pbx-queries";
import type { QueueDispositionCodeRow } from "~/lib/pbx/contracts";

/**
 * "What was that call?" — the after-call work, for the agent who just had it.
 *
 * ## It appears because the ENGINE said so, not because this app noticed a hangup
 *
 * The live `agent-state` entry carries `dispositionCallId` for exactly as long as the agent owes a
 * code for that call, and the engine sets and clears it. So this panel is a rendering of one field:
 * it appears when the field does, it names the call the field names, and it disappears when the
 * engine clears it — including when the wrap-up deadline expires while the agent is still deciding.
 * Deriving the same thing from the last CDR row would be a panel that lags the ledger by seconds the
 * agent does not have.
 *
 * ## `dispositionRequired` insists; it does not block
 *
 * This is the load-bearing sentence of the whole feature. The engine's wrap-up deadline ends the
 * after-call work whatever this screen is showing, and records `unset`. A UI that refused to let the
 * agent continue would therefore be holding a form open over a state the platform has already left —
 * and it would be doing it to the one person who cannot fix it. So "required" buys emphasis: the
 * codes are highlighted, the countdown is louder, and nothing is disabled.
 *
 * ## The countdown is derived, never counted
 *
 * `availableAt` is an instant the engine wrote. Rendering `availableAt - now` means a console opened
 * halfway through a wrap-up is right on its first frame, and one whose socket dropped stops moving
 * rather than confidently counting a window that has already closed. The tick only runs while there
 * is a call to close out.
 */
export function AgentWrapUpPanel() {
	const live = useLiveAgentStates();
	// The socket is what normally keeps this fresh. When it has not warmed up — or this console is
	// on a build with no socket at all — the seat endpoint carries the same fields, and a five-second
	// poll of one row is what makes the panel appear inside a ten-second wrap-up window.
	const socketCold = !live.permitted || !live.loaded;
	const seat = useMyAgentSession(socketCold ? { pollMs: 5_000 } : {});
	const submit = useSubmitDisposition();

	const agent = seat.data;
	const entry = agent ? live.byAgentId.get(agent.agentId) : undefined;
	/**
	 * The bucket entry whole, or the REST view whole — never a mix. Both describe the same instant
	 * and the fields are read together: an agent whose entry says the wrap-up ended must not have its
	 * call id filled back in from a REST answer fetched seconds earlier.
	 */
	const wrapUp =
		entry ?? (agent === null || agent === undefined ? undefined : agentStateFromSession(agent));
	const callId = wrapUp?.dispositionCallId;
	const queueId = wrapUp?.queueId;

	const codes = usePbxChildren<QueueDispositionCodeRow>(
		PBX_CHILDREN.queueDispositionCodes,
		"queues",
		callId === undefined ? undefined : queueId,
	);

	const remaining = useRemainingSeconds(wrapUp?.availableAt, callId !== undefined);

	if (agent === null || agent === undefined || !agent.canManageSelf || callId === undefined) {
		return null;
	}

	const offered = (codes.data ?? [])
		.filter((code) => code.enabled)
		.sort((a, b) => a.position - b.position || a.code.localeCompare(b.code));
	const chosen = wrapUp?.dispositionCode;
	const required = wrapUp?.dispositionRequired === true;

	return (
		<Card>
			<CardBody className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
					<div className="min-w-0">
						<p className="text-sm font-medium text-foreground">
							{chosen === undefined ? "How did that call end?" : "Call closed"}
						</p>
						<p className="text-xs text-muted-foreground">
							{chosen === undefined
								? required
									? "This queue asks for a code on every call. If the wrap-up time runs out first it is recorded as 'unset'."
									: "Optional — the call is recorded either way."
								: "You can still change it until the wrap-up time runs out."}
						</p>
					</div>
					{remaining === null ? null : (
						<Badge tone={required && chosen === undefined ? "warning" : "neutral"} data-tabular>
							{remaining <= 0 ? "Wrap-up over" : `${String(remaining)}s left`}
						</Badge>
					)}
				</div>

				{codes.isPending ? (
					<p className="text-xs text-muted-foreground">Loading this queue's codes…</p>
				) : offered.length === 0 ? (
					<p className="text-xs text-muted-foreground">
						This queue offers no wrap-up codes, so there is nothing to pick — the call is recorded
						without one.
					</p>
				) : (
					<div className="flex flex-wrap gap-2">
						{offered.map((code) => (
							<Button
								key={code.id}
								size="sm"
								variant={chosen === code.code ? "primary" : "secondary"}
								loading={submit.isPending}
								onClick={() => submit.run({ agentId: agent.agentId, callId, code: code.code })}
								aria-pressed={chosen === code.code}
							>
								{code.label}
							</Button>
						))}
					</div>
				)}
			</CardBody>
		</Card>
	);
}

/**
 * Seconds left until `availableAt`, ticking once a second and only while it matters.
 *
 * `null` when the entry names no deadline — an agent whose wrap-up is untimed, or an entry written
 * before the engine knew. A zero would be a lie in that case: it would read as "your time is up"
 * rather than "nobody set one".
 */
function useRemainingSeconds(availableAt: string | undefined, active: boolean): number | null {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active || availableAt === undefined) {
			return;
		}
		const handle = setInterval(() => {
			setNow(Date.now());
		}, 1_000);
		return () => {
			clearInterval(handle);
		};
	}, [active, availableAt]);

	if (availableAt === undefined) {
		return null;
	}
	const deadline = Date.parse(availableAt);
	if (Number.isNaN(deadline)) {
		return null;
	}
	return Math.max(0, Math.ceil((deadline - now) / 1000));
}
