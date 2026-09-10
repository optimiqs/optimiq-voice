"use client";

import { Badge } from "~/components/ui/badge";
import type { QueueAgentStatus } from "~/lib/pbx/contracts";

/**
 * An agent's status, coloured by whether the queue can currently offer them a call.
 *
 * Only `available` is green: everything else — logged out, on a break, already talking, wrapping up
 * — means this seat does not take the next caller, and colouring "on a call" as success would make
 * a fully-busy queue look fully staffed. `unavailable` is the one that is a problem rather than a
 * state, so it gets the danger tone.
 *
 * Shared because the agents list and each queue's membership table must not disagree about what
 * "on-break" looks like.
 */
const STATUS_TONES: Readonly<
	Record<QueueAgentStatus, "success" | "warning" | "neutral" | "danger">
> = {
	"logged-out": "neutral",
	available: "success",
	"on-break": "warning",
	"on-call": "warning",
	"wrap-up": "warning",
	unavailable: "danger",
};

export const AGENT_STATUS_LABELS: Readonly<Record<QueueAgentStatus, string>> = {
	"logged-out": "Logged out",
	available: "Available",
	"on-break": "On a break",
	"on-call": "On a call",
	"wrap-up": "Wrapping up",
	unavailable: "Unavailable",
};

/**
 * The two `unavailable` reasons the DISTRIBUTOR writes, and what each is called on screen.
 *
 * `unavailable` is one status and two situations, and a supervisor needs them apart: an agent who
 * set themselves unavailable will come back, and an agent the engine benched is a handset nobody is
 * picking up — somebody has to walk over. That distinction is the entire point of RONA, so it is
 * carried in the LABEL rather than in a colour of its own: the tone vocabulary already says "this is
 * a problem", and a sixth colour would say it again less clearly.
 *
 * `rona` is one unanswered offer on a queue that asks for that; `max-no-answer` is the ceiling on
 * the agent's own record. Anything else in `reason` was typed by a person.
 */
const ENGINE_BENCH_LABELS: Readonly<Record<string, string>> = {
	rona: "Not answering",
	"max-no-answer": "Missed too many",
};

const ENGINE_BENCH_TITLES: Readonly<Record<string, string>> = {
	rona: "Benched by the distributor after one unanswered call. A supervisor has to put them back.",
	"max-no-answer":
		"Benched by the distributor after the misses allowed on this agent's record. A supervisor has to put them back.",
};

export function AgentStatusBadge({
	status,
	reason,
}: {
	status: QueueAgentStatus;
	/** The live entry's reason, when there is one. A person's free text is ignored here. */
	reason?: string | undefined;
}) {
	if (status === "unavailable" && reason !== undefined) {
		const benched = ENGINE_BENCH_LABELS[reason];
		if (benched !== undefined) {
			return (
				<Badge tone="danger" title={ENGINE_BENCH_TITLES[reason]}>
					{benched}
				</Badge>
			);
		}
	}
	return <Badge tone={STATUS_TONES[status]}>{AGENT_STATUS_LABELS[status]}</Badge>;
}
