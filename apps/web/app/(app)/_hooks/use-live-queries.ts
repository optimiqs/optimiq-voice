"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
	applySnapshot,
	applyUpdate,
	countLiveCalls,
	emptyKvState,
	isChannelLive,
	isRegistrationLive,
	parseAgentState,
	parseChannel,
	parseRegistration,
	type LiveAgentState,
	type LiveChannel,
	type LiveKvState,
	type LiveRegistration,
} from "~/lib/live/store";
import { queueTopic } from "~/lib/live/protocol";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { queryKeys } from "~/lib/query-keys";
import { useActiveOrganization, usePermission } from "../_context/session-context";
import { useLiveTopic } from "../_context/live-context";
import type { LiveSnapshotEvent, LiveUpdateEvent } from "~/lib/live/client";

/**
 * Live state, as the screens consume it.
 *
 * ## Live state is NOT in the query cache, and that is deliberate
 *
 * The obvious move is `queryClient.setQueryData` on every frame. It is wrong here for the reason
 * `lib/query-client.ts` sets `staleTime: Infinity`: the cache holds things that were FETCHED and
 * whose staleness is a question. A registration binding is not fetched and has no staleness — it
 * is either the current contents of a KV bucket or it is nothing — and putting it in the cache
 * would give it a `gcTime`, a refetch path and a `queryFn` that cannot exist.
 *
 * So live topics are held in component state, and the cache is INVALIDATED where the two overlap:
 * an `agent.state` transition changes `queue_agent.status`, which is a fetched column, so the
 * agents list has to be refetched rather than patched — the server is the authority on the row and
 * the socket only knows the status changed. That invalidation is the thing the web foundation's
 * `staleTime: Infinity` was waiting for.
 */

/** One `use` per topic; each returns a keyed map plus whatever the screen actually asks. */
function useKvTopic<TValue>(
	topic: Parameters<typeof useLiveTopic>[0],
	parse: (value: unknown) => TValue | undefined,
	options: { readonly enabled?: boolean } = {},
): LiveKvState<TValue> {
	const [state, setState] = useState<LiveKvState<TValue>>(() => emptyKvState<TValue>());

	const onSnapshot = useCallback(
		(event: LiveSnapshotEvent) => {
			// Replace, never merge. The protocol has no cursor, so the gap before a snapshot is
			// unbounded and a merge would keep a call that ended while the tab was hidden.
			setState(applySnapshot(event, parse));
		},
		[parse],
	);
	const onUpdate = useCallback(
		(event: LiveUpdateEvent) => {
			setState((previous) => applyUpdate(previous, event, parse));
		},
		[parse],
	);

	useLiveTopic(topic, { onSnapshot, onUpdate }, options);
	return state;
}

// ---------------------------------------------------------------------------------------------
// registrations
// ---------------------------------------------------------------------------------------------

export interface LiveRegistrationsResult {
	readonly rows: readonly LiveRegistration[];
	/** Bindings whose granted interval has not lapsed. See `isRegistrationLive`. */
	readonly liveCount: number;
	readonly loaded: boolean;
	/** Whether this session may watch the topic at all. */
	readonly permitted: boolean;
	readonly byExtensionId: ReadonlyMap<string, LiveRegistration>;
}

export function useLiveRegistrations(): LiveRegistrationsResult {
	const permitted = usePermission("extensions.read");
	const state = useKvTopic("registrations", parseRegistration, { enabled: permitted });

	return useMemo(() => {
		const now = Date.now();
		const rows = [...state.rows.values()];
		const byExtensionId = new Map<string, LiveRegistration>();
		for (const row of rows) {
			if (row.extensionId !== undefined && isRegistrationLive(row, now)) {
				byExtensionId.set(row.extensionId, row);
			}
		}
		return {
			rows,
			liveCount: rows.filter((row) => isRegistrationLive(row, now)).length,
			loaded: state.loaded,
			permitted,
			byExtensionId,
		};
	}, [state, permitted]);
}

// ---------------------------------------------------------------------------------------------
// active calls
// ---------------------------------------------------------------------------------------------

export interface LiveCallsResult {
	readonly legs: readonly LiveChannel[];
	/** Distinct CALLS, not legs: a bridged call is two entries and one conversation. */
	readonly callCount: number;
	readonly answeredCount: number;
	readonly loaded: boolean;
	readonly permitted: boolean;
}

export function useLiveActiveCalls(): LiveCallsResult {
	const permitted = usePermission("cdr.read");
	const state = useKvTopic("active-calls", parseChannel, { enabled: permitted });

	return useMemo(() => {
		const legs = [...state.rows.values()].filter(isChannelLive);
		const answered = new Set<string>();
		for (const leg of legs) {
			if (leg.answeredAt !== undefined) {
				answered.add(leg.callId);
			}
		}
		return {
			legs,
			callCount: countLiveCalls(legs),
			answeredCount: answered.size,
			loaded: state.loaded,
			permitted,
		};
	}, [state, permitted]);
}

// ---------------------------------------------------------------------------------------------
// agent state
// ---------------------------------------------------------------------------------------------

export interface LiveAgentStatesResult {
	readonly byAgentId: ReadonlyMap<string, LiveAgentState>;
	readonly availableCount: number;
	readonly staffedCount: number;
	readonly loaded: boolean;
	readonly permitted: boolean;
}

/**
 * Every agent's live status for the organization.
 *
 * Also invalidates the queue-agents list on a transition. The socket knows the STATUS changed; the
 * row carries a `statusChangedAt` and everything else the table renders, and only the server can
 * say what those are now — so the cache is invalidated rather than patched. This is precisely the
 * WS-driven invalidation `lib/query-client.ts`'s `staleTime: Infinity` was written against.
 */
export function useLiveAgentStates(): LiveAgentStatesResult {
	const permitted = usePermission("queues.monitor");
	const queryClient = useQueryClient();
	const organizationId = useActiveOrganization()?.id ?? "";
	const [state, setState] = useState<LiveKvState<LiveAgentState>>(() =>
		emptyKvState<LiveAgentState>(),
	);

	const onSnapshot = useCallback((event: LiveSnapshotEvent) => {
		setState(applySnapshot(event, parseAgentState));
	}, []);

	const onUpdate = useCallback(
		(event: LiveUpdateEvent) => {
			setState((previous) => {
				const next = applyUpdate(previous, event, parseAgentState);
				if (next !== previous && organizationId.length > 0) {
					// Fired outside the state update on the next tick would be tidier, but the
					// invalidation is idempotent and TanStack batches it — and doing it here keeps the
					// "a transition happened" condition in one place rather than in a second effect
					// watching a derived value.
					void queryClient.invalidateQueries({
						queryKey: queryKeys.pbxResource(organizationId, PBX_RESOURCES.queueAgents.key),
					});
				}
				return next;
			});
		},
		[organizationId, queryClient],
	);

	useLiveTopic("agent-state", { onSnapshot, onUpdate }, { enabled: permitted });

	return useMemo(() => {
		const byAgentId = new Map<string, LiveAgentState>();
		for (const entry of state.rows.values()) {
			byAgentId.set(entry.agentId, entry);
		}
		let available = 0;
		let staffed = 0;
		for (const entry of byAgentId.values()) {
			if (entry.status !== "logged-out") {
				staffed += 1;
			}
			if (entry.status === "available") {
				available += 1;
			}
		}
		return {
			byAgentId,
			availableCount: available,
			staffedCount: staffed,
			loaded: state.loaded,
			permitted,
		};
	}, [state, permitted]);
}

// ---------------------------------------------------------------------------------------------
// one queue
// ---------------------------------------------------------------------------------------------

export interface LiveQueueResult {
	/** Callers currently waiting, keyed by call id, oldest first. */
	readonly waiting: readonly { readonly callId: string; readonly since: string; readonly callerNumber?: string }[];
	readonly loaded: boolean;
	readonly permitted: boolean;
}

/**
 * Callers waiting in one queue, derived from the queue event stream.
 *
 * There is no KV bucket of waiting callers — the engine holds that in memory — so this is built by
 * following `caller.joined` / `caller.answered` / `caller.abandoned`. That has a real consequence
 * and it is stated rather than hidden: a page opened while callers are ALREADY waiting starts at
 * zero and becomes correct as the queue turns over, because there is no snapshot to ask for. A
 * count that claimed otherwise would be worse than one that is honestly incomplete, so the caller
 * gets `loaded` and can label it.
 */
export function useLiveQueue(queueId: string | null): LiveQueueResult {
	const permitted = usePermission("queues.monitor");
	const [waiting, setWaiting] = useState<
		readonly { callId: string; since: string; callerNumber?: string }[]
	>([]);
	const [loaded, setLoaded] = useState(false);

	const onUpdate = useCallback((event: LiveUpdateEvent) => {
		const envelope = event.data as { type?: string; at?: string; data?: Record<string, unknown> };
		const payload = envelope?.data;
		if (payload === undefined || typeof payload.callId !== "string") {
			return;
		}
		const callId = payload.callId;
		setLoaded(true);
		if (event.kind === "caller.joined") {
			setWaiting((previous) =>
				previous.some((entry) => entry.callId === callId)
					? previous
					: [
							...previous,
							{
								callId,
								since: envelope.at ?? event.at,
								...(typeof payload.callerNumber === "string"
									? { callerNumber: payload.callerNumber }
									: {}),
							},
						],
			);
			return;
		}
		if (event.kind === "caller.answered" || event.kind === "caller.abandoned") {
			setWaiting((previous) => {
				const next = previous.filter((entry) => entry.callId !== callId);
				return next.length === previous.length ? previous : next;
			});
		}
	}, []);

	useLiveTopic(queueId === null ? null : queueTopic(queueId), { onUpdate }, {
		enabled: permitted,
	});

	return { waiting, loaded, permitted };
}

// ---------------------------------------------------------------------------------------------
// voicemail
// ---------------------------------------------------------------------------------------------

export interface LiveMailboxCounts {
	readonly newCount: number;
	readonly savedCount: number;
}

export interface LiveVoicemailResult {
	/** Keyed by `voicemail_box.id`. Empty until a mailbox's counts change while the page is open. */
	readonly counts: ReadonlyMap<string, LiveMailboxCounts>;
	readonly permitted: boolean;
}

/**
 * Live mailbox counts, from `voicemail.mwi.updated`.
 *
 * ## Why the map starts EMPTY and that is not a bug
 *
 * There is no KV projection behind this topic, so there is no snapshot frame: the socket can only
 * say what CHANGED while the page was open. The counts a screen renders therefore come from the
 * HTTP list (`mailbox.newCount`), and this map OVERLAYS the ones that have moved since. A caller
 * reads `counts.get(boxId) ?? fetched`, which is correct in both directions — before any event,
 * and after one.
 *
 * Building a bucket to make the snapshot possible was the alternative, and it would be a third
 * copy of a number that `voicemail_message` already holds and the list endpoint already returns.
 *
 * ## The mailbox id comes from the SUBJECT
 *
 * `voicemail.evt.v1.<orgId>.<mailboxId>.mwi.updated` — the box is the address, not the payload,
 * which is the rule `packages/events` applies to `queueId` and `callId` too. So the envelope's own
 * `subject` is parsed rather than a field being invented for it.
 */
export function useLiveVoicemail(): LiveVoicemailResult {
	const permitted = usePermission("voicemail.read");
	const [counts, setCounts] = useState<ReadonlyMap<string, LiveMailboxCounts>>(() => new Map());

	const onUpdate = useCallback((event: LiveUpdateEvent) => {
		if (event.kind !== "mwi.updated") {
			return;
		}
		const envelope = event.data as {
			subject?: string;
			data?: { newCount?: unknown; savedCount?: unknown };
		};
		const mailboxId = envelope?.subject?.split(".")[4];
		const payload = envelope?.data;
		if (
			mailboxId === undefined ||
			payload === undefined ||
			typeof payload.newCount !== "number" ||
			typeof payload.savedCount !== "number"
		) {
			return;
		}
		const next: LiveMailboxCounts = {
			newCount: payload.newCount,
			savedCount: payload.savedCount,
		};
		setCounts((previous) => {
			const held = previous.get(mailboxId);
			if (held?.newCount === next.newCount && held.savedCount === next.savedCount) {
				return previous;
			}
			const updated = new Map(previous);
			updated.set(mailboxId, next);
			return updated;
		});
	}, []);

	useLiveTopic("voicemail", { onUpdate }, { enabled: permitted });

	return { counts, permitted };
}
