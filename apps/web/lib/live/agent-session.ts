import { apiFetch } from "../api-client";

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
	readonly availableAt: string | null;
	/** Which process last wrote it. `engine` for call transitions, `api` for shift ones. */
	readonly source: "engine" | "api" | null;
	/** False when only the persisted column has ever been written — "last known", not "live". */
	readonly live: boolean;
	readonly self: boolean;
	/** Whether the caller may move OTHER agents. Renders the supervisor controls. */
	readonly canManage: boolean;
	/** …and their own. Renders the console strip at all. */
	readonly canManageSelf: boolean;
}

export interface AgentSessionResult {
	readonly data: AgentSessionView;
	/** False when the action was already true — a double tap, two tabs, a retried request. */
	readonly changed: boolean;
}

/** The seat the acting user occupies, or `null`. Not an error: most members are not agents. */
export async function fetchMyAgentSession(): Promise<AgentSessionView | null> {
	const { data } = await apiFetch<{ data: AgentSessionView | null }>(
		"/queue-agents/session/me",
	);
	return data;
}

export async function fetchAgentSession(agentId: string): Promise<AgentSessionView> {
	const { data } = await apiFetch<{ data: AgentSessionView }>(
		`/queue-agents/${agentId}/session`,
	);
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
