"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { queueTopic } from "~/lib/live/protocol";
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
	parseTrunkStatusEvent,
	parseWaitingRecord,
	rankWaiting,
	type LiveAgentState,
	type LiveChannel,
	type LiveKvState,
	type LiveRegistration,
	type LiveTrunkStatus,
	type LiveWaitingRecord,
	type WaitingCaller,
} from "~/lib/live/store";
import { PBX_RESOURCES } from "~/lib/pbx/client";
import { queryKeys } from "~/lib/query-keys";
import { useLiveTopic } from "../_context/live-context";
import { useActiveOrganization, usePermission } from "../_context/session-context";
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
	/** The line, in served order, with a position and a wait on each. Empty until a frame arrives. */
	readonly waiting: readonly WaitingCaller[];
	/** The record as the bucket holds it, for a caller that wants `updatedAt` or the raw entries. */
	readonly record: LiveWaitingRecord | null;
	readonly loaded: boolean;
	readonly permitted: boolean;
}

/**
 * Callers waiting in one queue, from the `queue-waiting` bucket.
 *
 * ## Why this is a single RECORD and not a keyed map
 *
 * Every other live topic here is a KV projection with one key per thing, so `useKvTopic`'s map is
 * the right shape and a snapshot replaces it wholesale. This bucket is keyed `<orgId>.<queueId>`
 * and the VALUE is the entire line — `packages/events` argues why (a position is a rank over the
 * whole line, so a per-caller key would turn every announcement into a range read and would let a
 * half-applied write produce an order nobody ever held). So there is exactly one row to hold, and
 * any frame carrying one replaces everything this client knew.
 *
 * That also solves a problem the generic hook cannot: the `queue:<id>` topic multiplexes THREE
 * sources — the waiting bucket, the agent-state bucket and the queue event stream — and a snapshot
 * frame does not say which source it came from. A keyed map would have the agent-state snapshot
 * clobber the waiting snapshot or the reverse, depending on which arrived last. Holding one record
 * and only replacing it when a frame actually parses as a line makes the order between the two
 * frames irrelevant.
 *
 * The consequence is stated rather than hidden: the absence of a frame is NOT evidence of an empty
 * line, so a record is never cleared by silence. What converges the display instead is the lease —
 * `rankWaiting` drops entries whose `expiresAt` has passed, so a queue that empties and stops being
 * written about drains on screen within one lease rather than staying frozen.
 *
 * ## `resumed` comes from the EVENT, not from the entry
 *
 * `queue.caller.joined` carries it and the bucket entry does not: what the entry holds is the
 * restored `joinedAt`, which is the effect rather than the fact. So joins observed while this tab
 * is open are remembered by call id and the badge is rendered for those; a caller who was already
 * waiting when the page opened is shown without one rather than with a guess.
 */
export function useLiveQueue(queueId: string | null): LiveQueueResult {
	const permitted = usePermission("queues.monitor");
	const [record, setRecord] = useState<LiveWaitingRecord | null>(null);
	const [resumedCallIds, setResumedCallIds] = useState<ReadonlySet<string>>(() => new Set());
	const [loaded, setLoaded] = useState(false);
	const [tick, setTick] = useState(() => Date.now());

	const onSnapshot = useCallback((event: LiveSnapshotEvent) => {
		for (const row of event.rows) {
			const parsed = parseWaitingRecord(row.value);
			if (parsed !== undefined) {
				setRecord(parsed);
			}
		}
		// True even for the agent-state frame that carries no line: the topic answered, and a queue
		// with nobody waiting produces exactly this — a subscriber that waited for a line before
		// admitting it was connected would show "not loaded" for every quiet queue.
		setLoaded(true);
	}, []);

	const onUpdate = useCallback((event: LiveUpdateEvent) => {
		if (event.kind === "put") {
			const parsed = parseWaitingRecord(event.data);
			if (parsed !== undefined) {
				setRecord(parsed);
				setLoaded(true);
			}
			return;
		}
		if (event.kind !== "caller.joined") {
			return;
		}
		const payload = (event.data as { data?: Record<string, unknown> } | undefined)?.data;
		if (payload?.resumed !== true || typeof payload.callId !== "string") {
			return;
		}
		const callId = payload.callId;
		setResumedCallIds((previous) => {
			if (previous.has(callId)) {
				return previous;
			}
			const next = new Set(previous);
			next.add(callId);
			return next;
		});
	}, []);

	useLiveTopic(
		queueId === null ? null : queueTopic(queueId),
		{ onSnapshot, onUpdate },
		{
			enabled: permitted,
		},
	);

	/**
	 * The clock the ranking is computed against.
	 *
	 * A caller's wait grows without anything arriving on the socket, so a line rendered only when a
	 * frame lands would freeze at whatever the last write said — "waiting 12s" for four minutes.
	 * One second is the resolution the numbers are displayed at; anything faster would re-render for
	 * digits nobody can read.
	 *
	 * It does not run for an EMPTY line, which matters on a wallboard: a tenant with a dozen queues
	 * mounts a dozen of these, and ticking each one once a second to re-derive an empty array is a
	 * background tab burning a core to display nothing. An empty record cannot become non-empty
	 * without a frame, and a frame re-runs this effect.
	 */
	const pending = record?.entries.length ?? 0;
	useEffect(() => {
		if (queueId === null || !permitted || pending === 0) {
			return;
		}
		const handle = setInterval(() => {
			setTick(Date.now());
		}, 1_000);
		return () => {
			clearInterval(handle);
		};
	}, [queueId, permitted, pending]);

	const waiting = useMemo(
		() => rankWaiting(record, tick, resumedCallIds),
		[record, tick, resumedCallIds],
	);

	return { waiting, record, loaded, permitted };
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

// ---------------------------------------------------------------------------------------------
// trunks
// ---------------------------------------------------------------------------------------------

export interface LiveTrunksResult {
	/** Keyed by `trunk.id`. Empty until a carrier moves while the page is open. */
	readonly statuses: ReadonlyMap<string, LiveTrunkStatus>;
	readonly permitted: boolean;
}

/**
 * Live trunk status, from `trunk.status.changed`.
 *
 * ## The map starts EMPTY, and overlays rather than replaces
 *
 * Exactly the voicemail shape, and for the same reason stated one topic over: there is no KV
 * projection behind `trunks`, so there is no snapshot frame and the socket can only say what
 * CHANGED while the page was open. The statuses a screen renders come from the HTTP list — the
 * `trunk.status*` columns, which the API's durable consumer writes — and this map overlays the ones
 * that have moved since. A caller reads `statuses.get(id) ?? row`, which is correct before any
 * event and after one.
 *
 * Building a bucket to make a snapshot possible was the alternative, and the server rejected it on
 * the grounds that it would be a third copy of a fact the columns hold and the list already
 * returned.
 *
 * ## Why this does NOT invalidate the trunk list, where `useLiveAgentStates` does
 *
 * The agent case invalidates because the socket only knows the STATUS changed while the row carries
 * `statusChangedAt` and everything else the table renders — only the server can say what those are
 * now. Here the event carries all four of them: the status, the reason, the latency and the moment.
 * There is nothing the row would tell us that the frame has not, so a refetch would be a request
 * per carrier transition that returned what is already on screen — and a flapping peer would turn
 * into list traffic. The persisted columns converge on their own through the API's consumer, and
 * the next natural read picks them up.
 *
 * The consequence is stated rather than hidden: this overlay is per tab and does not survive a
 * reload, which is fine, because after a reload the columns are the answer.
 */
export function useLiveTrunks(): LiveTrunksResult {
	const permitted = usePermission("trunks.read");
	const [statuses, setStatuses] = useState<ReadonlyMap<string, LiveTrunkStatus>>(() => new Map());

	const onUpdate = useCallback((event: LiveUpdateEvent) => {
		if (event.kind !== "status.changed") {
			return;
		}
		const parsed = parseTrunkStatusEvent(event.data, event.at);
		if (parsed === undefined) {
			return;
		}
		setStatuses((previous) => {
			const held = previous.get(parsed.trunkId);
			// Same object back when nothing moved, so a republished transition does not re-render the
			// whole table — the rule `applyUpdate` follows for the KV topics.
			if (held?.status === parsed.status && held.at === parsed.at) {
				return previous;
			}
			const next = new Map(previous);
			next.set(parsed.trunkId, parsed);
			return next;
		});
	}, []);

	useLiveTopic("trunks", { onUpdate }, { enabled: permitted });

	return { statuses, permitted };
}
