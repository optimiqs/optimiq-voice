"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "~/components/ui/toast";
import { ApiError } from "~/lib/api-client";
import {
	applyAgentSessionAction,
	fetchMyAgentSession,
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

export function useMyAgentSession(): UseQueryResult<AgentSessionView | null> {
	const organizationId = useActiveOrganization()?.id ?? "";
	// `queues.read` is the route's floor; without it the request is a guaranteed 403 and asking
	// would put a red line in every agent's console for a feature they cannot use.
	const canRead = useAnyPermission(["queues.read"]);
	return useQuery({
		queryKey: queryKeys.myAgentSession(organizationId),
		queryFn: fetchMyAgentSession,
		enabled: organizationId.length > 0 && canRead,
		// A 403 or a 404 here is an answer, not a transient failure: this user is not an agent, or
		// may not ask. Retrying would be four requests to learn the same thing.
		retry: false,
	});
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
		mutationFn: async (input: {
			agentId: string;
			action: AgentSessionAction;
			reason?: string;
		}) =>
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
