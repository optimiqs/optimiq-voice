"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "~/components/ui/toast";
import { ApiError } from "~/lib/api-client";
import {
	applyAgentSessionAction,
	fetchAgentSession,
	fetchMyAgentSession,
	submitAgentDisposition,
	type AgentSessionAction,
	type AgentSessionView,
} from "~/lib/live/agent-session";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { queryKeys } from "~/lib/query-keys";
import { useActiveOrganization, useAnyPermission } from "../_context/session-context";
import type { UseQueryResult } from "@tanstack/react-query";

/**
 * The agent console's server state.
 *
 * ## What is cached and what is not
 *
 * The LINK — which agent seat this user occupies — is a database row and is cached. The STATUS is
 * live state that arrives over the socket, so the cached view is a starting point that the
 * `agent-state` topic then supersedes; the console reads the socket first and falls back to this.
 * Caching the status as if it were fetched would give it a `staleTime` question it does not have.
 *
 * ## Why a mutation invalidates rather than patches
 *
 * The response carries the new view, and setting it directly would be one render faster. It would
 * also be the client deciding what the server now holds, on a resource TWO processes write — the
 * engine moves the same agent to `ringing` without this browser being involved. So the write is
 * acknowledged and the truth comes back through the socket and the invalidated query.
 */

export function useMyAgentSession(
	options: { readonly pollMs?: number } = {},
): UseQueryResult<AgentSessionView | null> {
	const organizationId = useActiveOrganization()?.id ?? "";
	// `queues.read` is the route's floor; without it the request is a guaranteed 403 and asking
	// would put a red line in every agent's console for a feature they cannot use.
	const canRead = useAnyPermission(["queues.read"]);
	return useQuery({
		queryKey: queryKeys.myAgentSession(organizationId),
		queryFn: fetchMyAgentSession,
		enabled: organizationId.length > 0 && canRead,
		// Off by default: the socket is what keeps this fresh. A caller passes an interval only for
		// the case the socket cannot cover — a cold or unpermitted one — and then it is a poll of one
		// row, not a second live channel.
		...(options.pollMs === undefined ? {} : { refetchInterval: options.pollMs }),
		// A 403 or a 404 here is an answer, not a transient failure: this user is not an agent, or
		// may not ask. Retrying would be four requests to learn the same thing.
		retry: false,
	});
}

/**
 * The live seats of named agents, over HTTP.
 *
 * The wallboard reads agent state off the `agent-state` socket; this is what it falls back to when
 * that socket has not warmed up or the operator does not hold `queues.monitor` on it. The session
 * endpoint carries the same call and disposition fields, so the supervise button appears either way.
 *
 * Deliberately driven by an explicit id list rather than the whole roster: this is one request per
 * agent, and a wallboard watching forty seats must not turn a cold socket into forty polls. The
 * caller passes only the agents whose persisted status says they are on a call.
 */
export function useAgentSessions(
	agentIds: readonly string[],
	options: { readonly pollMs?: number } = {},
): Map<string, AgentSessionView> {
	const organizationId = useActiveOrganization()?.id ?? "";
	const canRead = useAnyPermission(["queues.read"]);
	const enabled = organizationId.length > 0 && canRead;
	const results = useQueries({
		queries: agentIds.map((agentId) => ({
			queryKey: queryKeys.agentSession(organizationId, agentId),
			queryFn: async () => await fetchAgentSession(agentId),
			enabled,
			...(options.pollMs === undefined ? {} : { refetchInterval: options.pollMs }),
			retry: false,
		})),
	});
	const seats = new Map<string, AgentSessionView>();
	for (const result of results) {
		if (result.data !== undefined) {
			seats.set(result.data.agentId, result.data);
		}
	}
	return seats;
}

export interface AgentSessionMutation {
	readonly run: (input: {
		readonly agentId: string;
		readonly action: AgentSessionAction;
		readonly reason?: string;
	}) => void;
	readonly isPending: boolean;
	readonly error: unknown;
}

export function useAgentSessionAction(): AgentSessionMutation {
	const queryClient = useQueryClient();
	const organizationId = useActiveOrganization()?.id ?? "";

	const mutation = useMutation({
		mutationFn: async (input: { agentId: string; action: AgentSessionAction; reason?: string }) =>
			await applyAgentSessionAction(
				input.agentId,
				input.action,
				input.reason === undefined ? {} : { reason: input.reason },
			),
		onSuccess: (result, input) => {
			if (result.changed) {
				toast.success(MESSAGES[input.action](result.data.name));
			}
			if (organizationId.length === 0) {
				return;
			}
			void queryClient.invalidateQueries({
				queryKey: queryKeys.myAgentSession(organizationId),
			});
			// The agents table renders `status` and `statusChangedAt` from the row, and the row is
			// what the server just updated. Invalidating is what makes the queues page agree with
			// the console strip above it without either knowing about the other.
			void queryClient.invalidateQueries({
				queryKey: queryKeys.pbxResource(organizationId, PBX_RESOURCES.queueAgents.key),
			});
		},
		onError: (error) => {
			toast.error(agentSessionMessage(error));
		},
	});

	return {
		run: (input) => mutation.mutate(input),
		isPending: mutation.isPending,
		error: mutation.error,
	};
}

export interface DispositionMutation {
	readonly run: (input: {
		readonly agentId: string;
		readonly callId: string;
		readonly code: string;
	}) => void;
	readonly isPending: boolean;
	readonly error: unknown;
}

/**
 * The wrap-up code for the call an agent is finishing.
 *
 * No invalidation, unlike the four availability actions, and the difference is what each write
 * touches: those move `queue_agent.status`, which the roster table renders from the ROW. This one
 * writes a `queue_call_disposition` nothing on screen reads and stamps `dispositionCode` on the live
 * `agent-state` entry — which arrives over the socket a moment later and is what makes the panel
 * acknowledge itself. Invalidating the agents list here would refetch a table for a value that is
 * not in it.
 *
 * A failure is a toast rather than a field error: the only refusal an agent can act on is
 * `QUEUE_DISPOSITION_NO_LIVE_CALL`, which means the wrap-up ended while they were choosing, and the
 * honest thing to say is that the platform has already recorded `unset`.
 */
export function useSubmitDisposition(): DispositionMutation {
	const mutation = useMutation({
		mutationFn: async (input: { agentId: string; callId: string; code: string }) =>
			await submitAgentDisposition(input.agentId, { callId: input.callId, code: input.code }),
		onSuccess: (result) => {
			toast.success(`Call closed as ${result.code}.`);
		},
		onError: (error) => {
			toast.error(dispositionMessage(error));
		},
	});

	return {
		run: (input) => mutation.mutate(input),
		isPending: mutation.isPending,
		error: mutation.error,
	};
}

/** A refused wrap-up code, in words the agent can act on — which is usually "it is too late". */
export function dispositionMessage(error: unknown): string {
	if (!(error instanceof ApiError)) {
		return "The wrap-up code could not be recorded. Check your connection and try again.";
	}
	const body = error.body as { code?: string; message?: string } | null;
	switch (body?.code) {
		case "QUEUE_DISPOSITION_NO_LIVE_CALL":
			return "The wrap-up window for that call has closed, so it was recorded without a code. You are back on the floor.";
		case "QUEUE_DISPOSITION_CODE_UNKNOWN":
			return body.message ?? "That code is not one this queue offers any more.";
		case "QUEUE_AGENT_SESSION_FORBIDDEN":
			return body.message ?? "You may not close out this agent's call.";
		default:
			return body?.message ?? `The wrap-up code could not be recorded (${String(error.status)}).`;
	}
}

const MESSAGES: Record<AgentSessionAction, (name: string) => string> = {
	login: (name) => `${name} is now taking calls.`,
	logout: (name) => `${name} is logged out.`,
	pause: (name) => `${name} is on a break.`,
	resume: (name) => `${name} is back and taking calls.`,
};

/**
 * A failure, in words an operator can act on.
 *
 * The three codes this surface produces each need a different next step — re-read the state, ask
 * an administrator, or wait for the broker — and a single "Something went wrong" would send all
 * three to the same place.
 */
export function agentSessionMessage(error: unknown): string {
	if (!(error instanceof ApiError)) {
		return "Availability could not be changed. Check your connection and try again.";
	}
	const body = error.body as { code?: string; message?: string } | null;
	switch (body?.code) {
		case "AGENT_TRANSITION_REFUSED":
			return body.message ?? "That change is not possible from the agent's current state.";
		case "QUEUE_AGENT_SESSION_FORBIDDEN":
			return body.message ?? "You may not change this agent's availability.";
		case "AGENT_STATE_UNAVAILABLE":
			return "The live agent store is unreachable, so nothing was changed. Calls are still being distributed against the last known state.";
		default:
			return body?.message ?? `Availability could not be changed (${String(error.status)}).`;
	}
}
