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

export function AgentStatusBadge({ status }: { status: QueueAgentStatus }) {
	return <Badge tone={STATUS_TONES[status]}>{AGENT_STATUS_LABELS[status]}</Badge>;
}
