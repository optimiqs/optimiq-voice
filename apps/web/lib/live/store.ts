import type { LiveSnapshotEvent, LiveUpdateEvent } from "./client";

/**
 * Reducing a live topic's frames into something a component can render.
 *
 * Pure and framework-free, so the interesting part — what a `delete` for a key nobody has seen
 * means, what happens to a stale row after a reconnect — is testable without a socket or a DOM.
 * `use-live-queries.ts` holds the result in React state and does nothing else.
 *
 * ## A snapshot REPLACES
 *
 * The protocol has no cursor: a reconnect is answered with the current bucket contents and the gap
 * before it is unbounded. Merging would keep a call that ended while the laptop lid was shut, and
 * a wallboard showing a call that is not happening is worse than one showing none.
 */

export interface LiveKvState<TValue> {
	/** Keyed by the KV key, which is the identity a `delete` names. */
	readonly rows: ReadonlyMap<string, TValue>;
	/** When the state last changed. `null` before the first frame. */
	readonly at: string | null;
	/** Whether a snapshot has been received. `false` means "not loaded", not "empty". */
	readonly loaded: boolean;
}

export function emptyKvState<TValue>(): LiveKvState<TValue> {
	return { rows: new Map(), at: null, loaded: false };
}

/**
 * Applies a snapshot.
 *
 * `parse` returns `undefined` for a row this build cannot make sense of, which is dropped rather
 * than rendered as a blank line. The server already validated it against the shared schema, so this
 * is the second line and exists because the browser is on its own release cadence.
 */
export function applySnapshot<TValue>(
	event: LiveSnapshotEvent,
	parse: (value: unknown) => TValue | undefined,
): LiveKvState<TValue> {
	const rows = new Map<string, TValue>();
	for (const row of event.rows) {
		const parsed = parse(row.value);
		if (parsed !== undefined) {
			rows.set(row.key, parsed);
		}
	}
	return { rows, at: event.at, loaded: true };
}

/**
 * Applies one `put` or `delete`.
 *
 * Returns the SAME object when nothing changed, so React can skip a render: a KV bucket that
 * republishes an unchanged registration every time a phone refreshes would otherwise re-render a
 * table once per device per minute for no visible reason.
 */
export function applyUpdate<TValue>(
	state: LiveKvState<TValue>,
	event: LiveUpdateEvent,
	parse: (value: unknown) => TValue | undefined,
): LiveKvState<TValue> {
	if (event.key === undefined) {
		// A stream event, not a KV projection. Nothing to key it by, so it is not this state's.
		return state;
	}
	if (event.kind === "delete") {
		if (!state.rows.has(event.key)) {
			return state;
		}
		const rows = new Map(state.rows);
		rows.delete(event.key);
		return { rows, at: event.at, loaded: state.loaded };
	}
	if (event.kind !== "put") {
		return state;
	}
	const parsed = parse(event.data);
	if (parsed === undefined) {
		return state;
	}
	const rows = new Map(state.rows);
	rows.set(event.key, parsed);
	// `loaded` becomes true even without a snapshot: an update proves the topic is live, and a
	// component that waited for a snapshot it will not get again after a reconnect would render an
	// empty state forever.
	return { rows, at: event.at, loaded: true };
}

// ---------------------------------------------------------------------------------------------
// The shapes the screens read. Mirrors of `packages/events`' KV value contracts.
// ---------------------------------------------------------------------------------------------

export interface LiveRegistration {
	readonly orgId: string;
	readonly aor: string;
	readonly aorHash: string;
	readonly contact: string;
	readonly transport: string;
	readonly userAgent?: string;
	readonly sourceAddress?: string;
	readonly extensionId?: string;
	readonly registeredAt: string;
	readonly expiresAt: string;
}

export function parseRegistration(value: unknown): LiveRegistration | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	return typeof value.aor === "string" && typeof value.aorHash === "string"
		? (value as unknown as LiveRegistration)
		: undefined;
}

/**
 * Whether a binding's granted interval has lapsed.
 *
 * The bucket's TTL is an hour and a device's `Expires:` is minutes, so an entry can be PRESENT and
 * long dead. A panel that reads presence as "registered" shows an unplugged phone as online for
 * the rest of the hour, which is exactly the lie a registrations table exists to prevent.
 */
export function isRegistrationLive(registration: LiveRegistration, now: number): boolean {
	const expires = Date.parse(registration.expiresAt);
	return !Number.isNaN(expires) && now < expires;
}

export interface LiveChannel {
	readonly channelId: string;
	readonly callId: string;
	readonly organizationId: string;
	readonly direction: "inbound" | "outbound";
	readonly state: string;
	readonly callState?: string;
	readonly flags?: readonly string[];
	readonly profile?: {
		readonly callerIdNumber?: string;
		readonly callerIdName?: string;
		readonly destinationNumber?: string;
	};
	readonly bridgeId?: string;
	readonly createdAt: number;
	readonly answeredAt?: number;
	readonly hangupAt?: number;
}

export function parseChannel(value: unknown): LiveChannel | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	return typeof value.channelId === "string" && typeof value.callId === "string"
		? (value as unknown as LiveChannel)
		: undefined;
}

/** Mirrors `isLiveChannel` in `packages/events`: the teardown tail, plus a stamped hangup. */
const CHANNEL_TEARDOWN: ReadonlySet<string> = new Set(["hangup", "reporting", "destroyed"]);

export function isChannelLive(channel: LiveChannel): boolean {
	return !CHANNEL_TEARDOWN.has(channel.state) && channel.hangupAt === undefined;
}

/**
 * Distinct CALLS, not legs.
 *
 * The bucket holds one entry per LEG, and a bridged call is two of them — so counting entries
 * would show every answered call twice and make "3 active calls" mean six phones or three.
 */
export function countLiveCalls(channels: Iterable<LiveChannel>): number {
	const calls = new Set<string>();
	for (const channel of channels) {
		if (isChannelLive(channel)) {
			calls.add(channel.callId);
		}
	}
	return calls.size;
}

export interface LiveAgentState {
	readonly orgId: string;
	readonly agentId: string;
	readonly status: string;
	readonly since: string;
	readonly previousStatus?: string;
	readonly reason?: string;
	readonly queueId?: string;
	readonly source?: "engine" | "api";
}

export function parseAgentState(value: unknown): LiveAgentState | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	return typeof value.agentId === "string" && typeof value.status === "string"
		? (value as unknown as LiveAgentState)
		: undefined;
}

/**
 * One `trunk.status.changed` transition, addressed by the trunk it is about.
 *
 * ## Why this is a function over the ENVELOPE and not over a value
 *
 * The other three parsers here read a KV bucket entry: a bucket is a key→value map, the key is the
 * identity, and the value is the whole payload. `trunks` has no bucket behind it — the current
 * statuses live in the `trunk.status*` columns and the trunk list has already fetched them over
 * HTTP, so a projection would be a third copy of something two places agree on. What the socket
 * carries is a STREAM event, and a stream event has no key.
 *
 * So the identity comes from the SUBJECT: `trunk.evt.v1.<orgId>.<trunkId>.status.changed`, index 4.
 * That is the same rule `packages/events` applies to `queueId`, `callId` and `mailboxId` — the
 * addressed thing appears once, in the address — and it is why `useLiveVoicemail` reads its mailbox
 * id the same way.
 *
 * ## What it refuses
 *
 * A payload whose `status` is not one of the five the column can hold, and a subject that does not
 * have a trunk id where one belongs. Both are dropped rather than rendered: the server validated
 * the event against the shared schema before it forwarded it, so this is the second line and exists
 * because the browser ships on its own cadence — a build that met a sixth status word would
 * otherwise paint an unstyled badge over a status the row already knows.
 */
export const LIVE_TRUNK_STATUSES: ReadonlySet<string> = new Set([
	"unknown",
	"up",
	"down",
	"degraded",
	"disabled",
]);

export interface LiveTrunkStatus {
	readonly trunkId: string;
	readonly status: string;
	/** The media server's word, verbatim (`Reachable`, `Unreachable`). Absent when it said nothing. */
	readonly reason?: string;
	readonly latencyMs?: number;
	/** When the transition happened, from the envelope — never the moment this tab received it. */
	readonly at: string;
}

export function parseTrunkStatusEvent(
	envelope: unknown,
	receivedAt: string,
): LiveTrunkStatus | undefined {
	if (!isRecord(envelope)) {
		return undefined;
	}
	const subject = envelope.subject;
	if (typeof subject !== "string") {
		return undefined;
	}
	const trunkId = subject.split(".")[4];
	if (trunkId === undefined || trunkId.length === 0) {
		return undefined;
	}
	const payload = envelope.data;
	if (!isRecord(payload)) {
		return undefined;
	}
	const status = payload.status;
	if (typeof status !== "string" || !LIVE_TRUNK_STATUSES.has(status)) {
		return undefined;
	}
	return {
		trunkId,
		status,
		...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
		...(typeof payload.latencyMs === "number" ? { latencyMs: payload.latencyMs } : {}),
		at: typeof envelope.at === "string" ? envelope.at : receivedAt,
	};
}

// ---------------------------------------------------------------------------------------------
// the waiting line
// ---------------------------------------------------------------------------------------------

/**
 * One caller standing in one queue's line, as the `queue-waiting` bucket holds them.
 *
 * Mirrors `queueWaitingEntrySchema` in `packages/events`, epoch millis and all. Those timestamps
 * are the exception that package makes to its own ISO rule and the reason is the same one that
 * applies here: they are COMPARED against a clock rather than read, once a second per waiting
 * caller, and this screen re-ranks the line on the same tick.
 */
export interface LiveWaitingEntry {
	readonly callId: string;
	readonly legId: string;
	/** Higher dequeues first. The same 0-1000 scale the queue's `defaultPriority` is on. */
	readonly priority: number;
	/** Epoch millis. The order within a priority, and what an abandoned-resume restores. */
	readonly joinedAt: number;
	/** Epoch millis. Past this with no renewal, any writer may prune the entry — and so does this. */
	readonly expiresAt: number;
	readonly callerNumber?: string;
}

/**
 * One queue's whole line, which is ONE key in the bucket rather than one key per caller.
 *
 * That shape is the reason `useLiveQueue` can hold a single record instead of a keyed map: the
 * value IS the line, complete by construction, so any frame carrying one replaces everything this
 * client knew. The tombstones are carried but not rendered — a promise held for somebody who has
 * hung up is not a caller on a wallboard, and showing it as one would inflate every waiting count.
 */
export interface LiveWaitingRecord {
	readonly orgId: string;
	readonly queueId: string;
	readonly entries: readonly LiveWaitingEntry[];
	readonly updatedAt: number;
}

export function parseWaitingRecord(value: unknown): LiveWaitingRecord | undefined {
	if (!isRecord(value) || typeof value.queueId !== "string" || !Array.isArray(value.entries)) {
		return undefined;
	}
	const entries: LiveWaitingEntry[] = [];
	for (const candidate of value.entries) {
		// `expiresAt` is required rather than tolerated: it is the lease, and an entry without one
		// could never be pruned by a reader — a caller who hung up would stay on the wallboard until
		// the engine's next write, which on a quiet queue is exactly when nobody is writing.
		if (
			isRecord(candidate) &&
			typeof candidate.callId === "string" &&
			typeof candidate.joinedAt === "number" &&
			typeof candidate.priority === "number" &&
			typeof candidate.expiresAt === "number"
		) {
			entries.push(candidate as unknown as LiveWaitingEntry);
		}
	}
	return {
		orgId: typeof value.orgId === "string" ? value.orgId : "",
		queueId: value.queueId,
		entries,
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
	};
}

/** A caller in the line, with the two things the record does not store: their place and their wait. */
export interface WaitingCaller extends LiveWaitingEntry {
	/** 1-based, computed from the whole line — the record stores no position and never should. */
	readonly position: number;
	/** `now - joinedAt`. For a resumed caller this counts from the place they were RESTORED to. */
	readonly waitedMs: number;
	/**
	 * Whether this caller rang back inside the discard window and was put back where they were.
	 *
	 * Not a field on the entry, because it is a property of the JOIN rather than of the place: the
	 * engine reports it on `queue.caller.joined` and the KV record only carries the restored
	 * `joinedAt`. So a page opened AFTER a resumed caller joined cannot know, and does not claim to
	 * — the badge appears for joins this tab observed. Worth showing at all because without it a
	 * supervisor sees somebody arrive at position 2 ahead of a caller who has been holding a minute
	 * and has no way to tell a restored place from a bug.
	 */
	readonly resumed: boolean;
}

/**
 * The line in served order, with the lapsed entries dropped and a position on each.
 *
 * ## The comparator is the engine's, restated
 *
 * `(priority DESC, joinedAt ASC, callId ASC)` — `apps/engine/src/queue/queue-waiting.ts` argues
 * each key at length. The `callId` tie-break is the one that looks like decoration and is not: two
 * callers can join in the same millisecond, and without a total order the rank of each would depend
 * on the array order the record happened to be written in. A wallboard that ordered differently
 * from the engine would show a supervisor a queue that answers out of order.
 *
 * ## Expired entries are dropped HERE too
 *
 * A record is one key, so per-caller server-side expiry does not exist and the engine prunes on its
 * way past. Between two writes a lapsed entry is still in the value this client holds, and
 * rendering it is a wallboard showing a caller who hung up — which is the one thing a wallboard
 * must not do. Dropping it costs nothing: the next write agrees.
 */
export function rankWaiting(
	record: LiveWaitingRecord | null,
	now: number,
	resumedCallIds: ReadonlySet<string> = new Set(),
): readonly WaitingCaller[] {
	if (record === null) {
		return [];
	}
	return record.entries
		.filter((entry) => entry.expiresAt > now)
		.sort(
			(left, right) =>
				right.priority - left.priority ||
				left.joinedAt - right.joinedAt ||
				left.callId.localeCompare(right.callId),
		)
		.map((entry, index) => ({
			...entry,
			position: index + 1,
			// Clamped at zero: a caller whose `joinedAt` is in this browser's future is a clock skew
			// between the engine and the viewer, and a negative wait on a wallboard reads as a bug in
			// the queue rather than in the laptop it is being watched from.
			waitedMs: Math.max(0, now - entry.joinedAt),
			resumed: resumedCallIds.has(entry.callId),
		}));
}

/**
 * The longest wait in the line, in milliseconds. `0` for an empty line.
 *
 * The number a supervisor actually reacts to, and deliberately not an average: a queue holding
 * nineteen callers for ten seconds and one for eleven minutes has an unremarkable mean and one
 * customer who is about to hang up.
 */
export function longestWaitMs(callers: readonly WaitingCaller[]): number {
	let longest = 0;
	for (const caller of callers) {
		if (caller.waitedMs > longest) {
			longest = caller.waitedMs;
		}
	}
	return longest;
}

/** The agent statuses that count as staffing a queue. Mirrors the engine's `isStaffing`. */
export function isStaffing(status: string): boolean {
	return status !== "logged-out";
}

/** …and the ones a wallboard shows as ready to take a call. */
export function isAvailable(status: string): boolean {
	return status === "available";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
