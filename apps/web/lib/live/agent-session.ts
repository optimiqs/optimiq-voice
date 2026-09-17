import { apiFetch } from "../api-client";
import type { LiveAgentState } from "./store";

/**
 * The agent-availability client: `/api/v1/queue-agents/:id/session/*`.
 *
 * Separate from `lib/pbx/client.ts` because it is not CRUD. The PBX client is one declaration
 * covering ten structurally identical resources; this is four verbs on a sub-resource whose whole
 * point is that the ACTION is in the path — a body that could name a status would be a second,
 * unguarded way to write the ACD state machine (see the controller for the argument).
 */

export const AGENT_SESSION_ACTIONS = ["login", "logout", "pause", "resume"] as const;
export type AgentSessionAction = (typeof AGENT_SESSION_ACTIONS)[number];

/** What the server answers with. Mirrors `AgentSessionView` in `apps/api`. */
export interface AgentSessionView {
	readonly agentId: string;
	readonly name: string;
	readonly userId: string | null;
	readonly enabled: boolean;
	readonly status: string;
	readonly since: string | null;
	readonly reason: string | null;
	/**
	 * `reason`, but only when the DISTRIBUTOR benched the agent (`max-no-answer` / `rona`) rather
	 * than a person typing one. Null for every human-set reason, which `reason` still carries whole.
	 */
	readonly unavailableReason: string | null;
	readonly availableAt: string | null;
	/** Which process last wrote it. `engine` for call transitions, `api` for shift ones. */
	readonly source: "engine" | "api" | null;
	/**
	 * The live call and wrap-up fields, repeated from the `agent-state` bucket so the wallboard's
	 * supervise button and the console's wrap-up panel work with no socket. All null off a call.
	 *
	 * The server withholds them for another agent unless the caller holds `queues.monitor` — the
	 * same grant the socket topic is gated on — so a `null` here can mean "not on a call" or "not
	 * yours to see", and neither is something a UI should render differently.
	 */
	readonly callId: string | null;
	/** The queue that distributed {@link callId}; a supervise request needs both. */
	readonly queueId: string | null;
	readonly dispositionCallId: string | null;
	readonly dispositionCode: string | null;
	readonly dispositionRequired: boolean;
	/** False when only the persisted column has ever been written — "last known", not "live". */
	readonly live: boolean;
	readonly self: boolean;
	/** Whether the caller may move OTHER agents. Renders the supervisor controls. */
	readonly canManage: boolean;
	/** …and their own. Renders the console strip at all. */
	readonly canManageSelf: boolean;
}

/**
 * A session view as the `agent-state` bucket entry the live components read.
 *
 * The endpoint answers `null` where the bucket omits a key, so the two shapes differ by exactly
 * that and nothing else is converted. A component takes the socket entry whole or this whole, never
 * a mix: both describe one instant, and an agent whose entry says the wrap-up ended must not have
 * its call id filled back in from a REST answer fetched seconds earlier.
 */
export function agentStateFromSession(
	seat: AgentSessionView,
): Pick<
	LiveAgentState,
	| "agentId"
	| "availableAt"
	| "callId"
	| "dispositionCallId"
	| "dispositionCode"
	| "dispositionRequired"
	| "queueId"
	| "reason"
	| "status"
> {
	return {
		agentId: seat.agentId,
		status: seat.status,
		dispositionRequired: seat.dispositionRequired,
		...(seat.reason === null ? {} : { reason: seat.reason }),
		...(seat.availableAt === null ? {} : { availableAt: seat.availableAt }),
		...(seat.callId === null ? {} : { callId: seat.callId }),
		...(seat.queueId === null ? {} : { queueId: seat.queueId }),
		...(seat.dispositionCallId === null ? {} : { dispositionCallId: seat.dispositionCallId }),
		...(seat.dispositionCode === null ? {} : { dispositionCode: seat.dispositionCode }),
	};
}

export interface AgentSessionResult {
	readonly data: AgentSessionView;
	/** False when the action was already true — a double tap, two tabs, a retried request. */
	readonly changed: boolean;
}

/** The seat the acting user occupies, or `null`. Not an error: most members are not agents. */
export async function fetchMyAgentSession(): Promise<AgentSessionView | null> {
	const { data } = await apiFetch<{ data: AgentSessionView | null }>("/queue-agents/session/me");
	return data;
}

export async function fetchAgentSession(agentId: string): Promise<AgentSessionView> {
	const { data } = await apiFetch<{ data: AgentSessionView }>(`/queue-agents/${agentId}/session`);
	return data;
}

export async function applyAgentSessionAction(
	agentId: string,
	action: AgentSessionAction,
	options: { readonly reason?: string } = {},
): Promise<AgentSessionResult> {
	return await apiFetch<AgentSessionResult>(`/queue-agents/${agentId}/session/${action}`, {
		method: "POST",
		// `pause` is the only action with a body, and its reason is optional. The others send `{}`
		// rather than nothing, because the server's DTO is strict and an absent body would be a
		// request whose shape depends on the verb.
		body: JSON.stringify(action === "pause" && options.reason ? { reason: options.reason } : {}),
	});
}

/** What `POST …/session/disposition` answers with. Mirrors `QueueDispositionView` in `apps/api`. */
export interface QueueDispositionResult {
	readonly queueId: string;
	readonly agentId: string;
	readonly callId: string;
	readonly code: string;
	/** The `queue_disposition_code` row, or `null` when the wrap-up deadline chose. */
	readonly codeId: string | null;
	/** False when a person picked it. */
	readonly auto: boolean;
}

/**
 * The wrap-up code for the call this agent is finishing.
 *
 * `callId` is sent in the BODY, echoed from the agent's own `agent-state` entry, and that is what
 * makes a late submission refusable rather than silently attributed to the call that came after it:
 * the server compares it against `dispositionCallId` and answers `QUEUE_DISPOSITION_NO_LIVE_CALL`
 * when the engine has already moved on. The queue is not sent at all — it is read off the same
 * entry, which is what stops a code from one queue's vocabulary being filed against another's call.
 */
export async function submitAgentDisposition(
	agentId: string,
	input: { readonly callId: string; readonly code: string },
): Promise<QueueDispositionResult> {
	const { data } = await apiFetch<{ data: QueueDispositionResult }>(
		`/queue-agents/${agentId}/session/disposition`,
		{ method: "POST", body: JSON.stringify(input) },
	);
	return data;
}

/**
 * The action that moves an agent from where they are to where the button says.
 *
 * `undefined` means the button should not be offered: an agent on a call has no pause that the
 * machine allows, and a console that showed one would be offering a 409.
 */
export function actionForStatus(
	status: string,
	intent: "toggle-shift" | "toggle-break",
): AgentSessionAction | undefined {
	if (intent === "toggle-shift") {
		return status === "logged-out" ? "login" : "logout";
	}
	if (status === "on-break" || status === "unavailable") {
		return "resume";
	}
	// `on-call` and `ringing` have no edge to `on-break` — an agent goes to wrap-up first, because
	// a break that interrupted a live call is a state the switch could not honour.
	return status === "on-call" || status === "ringing" ? undefined : "pause";
}
