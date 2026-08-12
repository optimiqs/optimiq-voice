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

// ---------------------------------------------------------------------------------------------
// conferences — the rooms from a bucket, the people in them from a stream
// ---------------------------------------------------------------------------------------------

/**
 * The `conferences` topic is the only one that multiplexes a BUCKET and a STREAM into one picture,
 * and the two halves answer different questions that neither could answer alone.
 *
 * `conference-claims-kv` is the ROOMS: which meetings are running, how many people are in each
 * cluster-wide, and whether the room is locked. It is an ownership record the engines already
 * maintain to agree on a bridge, so a console opening mid-meeting gets all of that in one snapshot
 * with no new writer anywhere.
 *
 * `conference-events` is the PARTICIPANTS. The claim deliberately does not name them — it would be
 * rewritten on every mute — so who is in the room is assembled from `conference.joined` /
 * `conference.left` and kept honest by `conference.participant.updated`, which carries a member's
 * WHOLE state after every change rather than a delta.
 *
 * ## The consequence is stated rather than hidden
 *
 * A tab that connects mid-meeting knows the room and its COUNT immediately and learns the members
 * as they move. So {@link LiveConferenceRoomView.incomplete} is a real, renderable fact and the
 * panel says so — the same honesty the wallboard's `resumed` badge practises, and for the same
 * reason: a moderation surface that implied "these four are everybody" would have an operator
 * concluding somebody had left when they had merely joined before the page did.
 */

export interface LiveConferenceContribution {
	/** Members this ONE engine instance holds. The room's total is the sum of the unexpired ones. */
	readonly memberCount: number;
	readonly moderatorPresent: boolean;
	/** Epoch millis. Past this, this instance's seats stop counting toward the room. */
	readonly expiresAt: number;
}

/** One running room, as the `conference-claims` bucket holds it. Mirrors `conferenceClaimSchema`. */
export interface LiveConferenceRoom {
	readonly orgId: string;
	readonly conferenceId: string;
	/** The media server's bridge. Every instance in this room uses THIS one. */
	readonly bridgeId: string;
	readonly claimedAt: number;
	/** Keyed by engine instance id. Each instance contributes only the members it owns. */
	readonly contributions: Readonly<Record<string, LiveConferenceContribution>>;
	/**
	 * Whether the room has stopped admitting people.
	 *
	 * On the CLAIM rather than on a contribution, and deliberately NOT leased: a contribution
	 * expires because its owner may have crashed, and a meeting that unlocked itself because an
	 * unrelated instance restarted would be a room the moderator has to keep re-locking.
	 */
	readonly locked?: boolean;
	readonly lockedByUserId?: string;
	readonly lockedAtMs?: number;
}

export function parseConferenceClaim(value: unknown): LiveConferenceRoom | undefined {
	if (
		!isRecord(value) ||
		typeof value.conferenceId !== "string" ||
		typeof value.bridgeId !== "string" ||
		!isRecord(value.contributions)
	) {
		return undefined;
	}
	const contributions: Record<string, LiveConferenceContribution> = {};
	for (const [instanceId, candidate] of Object.entries(value.contributions)) {
		// `expiresAt` is required rather than tolerated, exactly as it is for a waiting entry: it is
		// the lease, and a contribution without one could never stop counting — a crashed instance's
		// seats would hold a room open on screen until the bucket's fifteen-minute TTL expired it.
		if (
			isRecord(candidate) &&
			typeof candidate.memberCount === "number" &&
			typeof candidate.expiresAt === "number"
		) {
			contributions[instanceId] = {
				memberCount: candidate.memberCount,
				moderatorPresent: candidate.moderatorPresent === true,
				expiresAt: candidate.expiresAt,
			};
		}
	}
	return {
		orgId: typeof value.orgId === "string" ? value.orgId : "",
		conferenceId: value.conferenceId,
		bridgeId: value.bridgeId,
		claimedAt: typeof value.claimedAt === "number" ? value.claimedAt : 0,
		contributions,
		...(typeof value.locked === "boolean" ? { locked: value.locked } : {}),
		...(typeof value.lockedByUserId === "string" ? { lockedByUserId: value.lockedByUserId } : {}),
		...(typeof value.lockedAtMs === "number" ? { lockedAtMs: value.lockedAtMs } : {}),
	};
}

/**
 * The room a KV key names.
 *
 * `conference-claims` is keyed `<orgId>.<conferenceId>` (`packages/events`' key table), and a
 * `delete` carries no value — so on the one frame that matters most, removing a room that has ended,
 * the key is the ONLY identity there is. Both ids are UUIDs and contain no dot, so the second
 * segment is unambiguous.
 */
export function conferenceIdFromClaimKey(key: string): string | undefined {
	const parts = key.split(".");
	return parts.length === 2 && parts[1] !== undefined && parts[1].length > 0 ? parts[1] : undefined;
}

/**
 * One person in one room, as this tab has been told about them.
 *
 * Every mutable field is present because `conference.participant.updated` carries the member's whole
 * state after every change — a consumer that applied a delta to a row it had drawn from a frame it
 * missed would render a mute button that disagrees with the mixer, which is the one failure a
 * moderation panel cannot tolerate.
 */
export interface LiveConferenceParticipant {
	readonly conferenceId: string;
	/**
	 * The leg, which is the `:ref` every moderation route takes.
	 *
	 * Not a media channel id: that is the engine's private handle onto a media server and changes
	 * with the driver. The leg id is what `conference.joined` publishes and what the control plane
	 * addresses, so it is the only identifier this panel ever holds.
	 */
	readonly legId: string;
	readonly roomNumber: string;
	readonly moderator: boolean;
	/** Whether the ROOM hears them. */
	readonly muted: boolean;
	/** Whether THEY hear the room. Independent of {@link muted}; both can be true. */
	readonly deafened: boolean;
	readonly talkGainPercent: number;
	readonly listenGainPercent: number;
	/**
	 * Epoch millis of the join — and ONLY when this tab observed it.
	 *
	 * Absent for somebody who was already in the room when the page connected, because the claim
	 * carries a count and not a member list and nothing else on this topic knows when they arrived.
	 * A panel that defaulted it to "now" would show every pre-existing participant as having just
	 * walked in, which is the lie a join clock exists to prevent.
	 */
	readonly joinedAt?: number;
}

/** Unity. The gain a member is at unless somebody moved them, and a renderable answer. */
export const CONFERENCE_UNITY_GAIN_PERCENT = 100;

/** Why a participant left. Mirrors `CONFERENCE_LEAVE_REASONS` in `packages/events`. */
export const CONFERENCE_LEAVE_REASONS = ["hung-up", "kicked", "room-ended"] as const;
export type ConferenceLeaveReason = (typeof CONFERENCE_LEAVE_REASONS)[number];

/**
 * One conference stream frame, narrowed.
 *
 * A discriminated union rather than five exported parsers, on the shape `parseTrunkStatusEvent`
 * already has: the reducer is the only caller, the frames are only meaningful as a set, and a spec
 * that can hand this function an envelope and read back a tagged value is testing the same thing
 * the reducer depends on.
 */
export type LiveConferenceEvent =
	| { readonly kind: "joined"; readonly participant: LiveConferenceParticipant }
	| {
			readonly kind: "left";
			readonly conferenceId: string;
			readonly legId: string;
			readonly reason: ConferenceLeaveReason;
	  }
	| { readonly kind: "updated"; readonly participant: LiveConferenceParticipant }
	| { readonly kind: "lock"; readonly conferenceId: string; readonly locked: boolean };

/**
 * Narrows a `conference.*` envelope.
 *
 * The lock state comes from the frame's KIND (`conference.locked` against `conference.unlocked`) and
 * not from the payload, because the payload has no such field — the event type IS the transition.
 *
 * `receivedAt` is the fallback for a join clock, used only when the envelope's own `at` is missing
 * or unparseable. The envelope's stamp is preferred for the reason `parseTrunkStatusEvent` prefers
 * it: it is when the thing HAPPENED, never the moment this tab was handed it.
 */
export function parseConferenceEvent(
	kind: string,
	envelope: unknown,
	receivedAt: string,
): LiveConferenceEvent | undefined {
	if (!isRecord(envelope)) {
		return undefined;
	}
	const payload = envelope.data;
	if (!isRecord(payload) || typeof payload.conferenceId !== "string") {
		return undefined;
	}
	const conferenceId = payload.conferenceId;

	if (kind === "conference.locked" || kind === "conference.unlocked") {
		return { kind: "lock", conferenceId, locked: kind === "conference.locked" };
	}

	if (typeof payload.legId !== "string") {
		return undefined;
	}
	const legId = payload.legId;

	if (kind === "conference.left") {
		// Absent is `hung-up`, and that reading is load-bearing: an artifact of a release predating
		// moderation is not a room where everybody was kicked.
		const reason = payload.reason;
		return {
			kind: "left",
			conferenceId,
			legId,
			reason: isLeaveReason(reason) ? reason : "hung-up",
		};
	}

	if (kind === "conference.joined") {
		const stamped = typeof envelope.at === "string" ? Date.parse(envelope.at) : Number.NaN;
		const fallback = Date.parse(receivedAt);
		const joinedAt = Number.isNaN(stamped) ? fallback : stamped;
		return {
			kind: "joined",
			participant: {
				conferenceId,
				legId,
				roomNumber: typeof payload.roomNumber === "string" ? payload.roomNumber : "",
				moderator: payload.moderator === true,
				// A caller entering a room is unmuted, undeafened and at unity, always — the engine's
				// registry says so and the join event carries none of the four for exactly that reason.
				muted: false,
				deafened: false,
				talkGainPercent: CONFERENCE_UNITY_GAIN_PERCENT,
				listenGainPercent: CONFERENCE_UNITY_GAIN_PERCENT,
				...(Number.isNaN(joinedAt) ? {} : { joinedAt }),
			},
		};
	}

	if (kind !== "conference.participant.updated") {
		return undefined;
	}
	if (
		typeof payload.talkGainPercent !== "number" ||
		typeof payload.listenGainPercent !== "number"
	) {
		// Both are REQUIRED on the wire because 100 is a real answer and an absent field is not. A
		// frame missing one is a build disagreement, and dropping it is better than rendering a
		// slider at a level nobody set.
		return undefined;
	}
	return {
		kind: "updated",
		participant: {
			conferenceId,
			legId,
			roomNumber: typeof payload.roomNumber === "string" ? payload.roomNumber : "",
			moderator: payload.moderator === true,
			muted: payload.muted === true,
			deafened: payload.deafened === true,
			talkGainPercent: payload.talkGainPercent,
			listenGainPercent: payload.listenGainPercent,
		},
	};
}

function isLeaveReason(value: unknown): value is ConferenceLeaveReason {
	return (
		typeof value === "string" && (CONFERENCE_LEAVE_REASONS as readonly string[]).includes(value)
	);
}

/**
 * Everything the topic has told this tab: the rooms, and the members of each.
 *
 * Two maps rather than participants nested inside the room, because the two halves arrive from
 * different upstreams and neither may clobber the other. The queue topic learned that lesson first —
 * a snapshot frame does not say which source produced it — and here the shapes differ enough that a
 * single map could not hold both anyway.
 */
export interface LiveConferenceState {
	/** Keyed by `conferenceId` — taken from the claim's VALUE, not from the `<org>.<id>` KV key. */
	readonly rooms: ReadonlyMap<string, LiveConferenceRoom>;
	/** `conferenceId` → `legId` → member. Empty for a room nobody has moved in since connecting. */
	readonly participants: ReadonlyMap<string, ReadonlyMap<string, LiveConferenceParticipant>>;
	readonly at: string | null;
	readonly loaded: boolean;
}

export function emptyConferenceState(): LiveConferenceState {
	return { rooms: new Map(), participants: new Map(), at: null, loaded: false };
}

/**
 * Applies the claims snapshot.
 *
 * It REPLACES, and it clears the participants too. The second half is the one worth arguing: the
 * protocol has no cursor, so the gap before a snapshot is unbounded, and a participant list carried
 * across a reconnect would show somebody who left while the socket was down — with a Kick button
 * beside them that can only ever 404. Rebuilding from the events that follow is the honest version,
 * and {@link LiveConferenceRoomView.incomplete} says so while it is happening.
 */
export function applyConferenceSnapshot(event: LiveSnapshotEvent): LiveConferenceState {
	const rooms = new Map<string, LiveConferenceRoom>();
	for (const row of event.rows) {
		const parsed = parseConferenceClaim(row.value);
		if (parsed !== undefined) {
			rooms.set(parsed.conferenceId, parsed);
		}
	}
	return { rooms, participants: new Map(), at: event.at, loaded: true };
}

/**
 * Applies one frame — a claim `put`/`delete`, or a `conference.*` event.
 *
 * Returns the SAME object when nothing changed, the rule every reducer in this file follows: a
 * republished claim whose contribution lease merely rolled forward must not re-render a table of
 * expanded rooms once per instance per heartbeat.
 */
export function applyConferenceUpdate(
	state: LiveConferenceState,
	event: LiveUpdateEvent,
): LiveConferenceState {
	if (event.kind === "put" || event.kind === "delete") {
		return applyClaimFrame(state, event);
	}
	const parsed = parseConferenceEvent(event.kind, event.data, event.at);
	if (parsed === undefined) {
		return state;
	}
	if (parsed.kind === "lock") {
		const room = state.rooms.get(parsed.conferenceId);
		// A lock for a room this tab holds no claim for is dropped rather than remembered. There is
		// nothing to render the badge on, and the engine rewrites the claim under compare-and-set when
		// it locks — so the `put` that carries the same fact is already on its way.
		if (room === undefined || (room.locked ?? false) === parsed.locked) {
			return state;
		}
		const rooms = new Map(state.rooms);
		rooms.set(parsed.conferenceId, { ...room, locked: parsed.locked });
		return { ...state, rooms, at: event.at };
	}
	if (parsed.kind === "left") {
		return removeParticipant(state, parsed.conferenceId, parsed.legId, event.at);
	}
	return putParticipant(state, parsed.participant, event.at);
}

function applyClaimFrame(state: LiveConferenceState, event: LiveUpdateEvent): LiveConferenceState {
	if (event.key === undefined) {
		return state;
	}
	if (event.kind === "delete") {
		const conferenceId = conferenceIdFromClaimKey(event.key);
		if (conferenceId === undefined || !state.rooms.has(conferenceId)) {
			return state;
		}
		const rooms = new Map(state.rooms);
		rooms.delete(conferenceId);
		// The members go with the room. The bridge is gone, so every `:ref` under it is unaddressable
		// and a row left behind would offer a Kick that the control plane answers with a 404.
		const participants = new Map(state.participants);
		participants.delete(conferenceId);
		return { rooms, participants, at: event.at, loaded: true };
	}
	const parsed = parseConferenceClaim(event.data);
	if (parsed === undefined) {
		return state;
	}
	const rooms = new Map(state.rooms);
	rooms.set(parsed.conferenceId, parsed);
	// `loaded` becomes true without a snapshot, the rule `applyUpdate` follows: a deployment where
	// the claims bucket does not exist yet gets no snapshot at all, and a panel that waited for one
	// would render "not loaded" over a meeting it is receiving events about.
	return { ...state, rooms, at: event.at, loaded: true };
}

function putParticipant(
	state: LiveConferenceState,
	participant: LiveConferenceParticipant,
	at: string,
): LiveConferenceState {
	const held = state.participants.get(participant.conferenceId);
	const previous = held?.get(participant.legId);
	// The join clock survives an update, which is the whole reason this is a merge rather than a set:
	// `conference.participant.updated` does not carry a join time, so a mute would otherwise erase
	// the one clock the row has been ticking.
	const next: LiveConferenceParticipant = {
		...participant,
		...(participant.joinedAt === undefined && previous?.joinedAt !== undefined
			? { joinedAt: previous.joinedAt }
			: {}),
	};
	if (previous !== undefined && sameParticipant(previous, next)) {
		return state;
	}
	const room = new Map(held ?? []);
	room.set(next.legId, next);
	const participants = new Map(state.participants);
	participants.set(next.conferenceId, room);
	return { ...state, participants, at, loaded: true };
}

function removeParticipant(
	state: LiveConferenceState,
	conferenceId: string,
	legId: string,
	at: string,
): LiveConferenceState {
	const held = state.participants.get(conferenceId);
	if (held === undefined || !held.has(legId)) {
		return state;
	}
	const participants = new Map(state.participants);
	if (held.size === 1) {
		participants.delete(conferenceId);
	} else {
		const room = new Map(held);
		room.delete(legId);
		participants.set(conferenceId, room);
	}
	return { ...state, participants, at };
}

function sameParticipant(a: LiveConferenceParticipant, b: LiveConferenceParticipant): boolean {
	return (
		a.muted === b.muted &&
		a.deafened === b.deafened &&
		a.moderator === b.moderator &&
		a.talkGainPercent === b.talkGainPercent &&
		a.listenGainPercent === b.listenGainPercent &&
		a.roomNumber === b.roomNumber &&
		a.joinedAt === b.joinedAt
	);
}

/**
 * A room's cluster-wide member count, from the contributions that have not lapsed.
 *
 * Expired contributions are dropped HERE and not only by whoever reaps the claim, for the reason
 * `rankWaiting` drops lapsed waiting entries: between two writes a crashed instance's seats are
 * still in the value this client holds, and counting them shows a meeting with people in it that
 * nobody is in.
 */
export function conferenceMemberCount(room: LiveConferenceRoom, now: number): number {
	let total = 0;
	for (const contribution of Object.values(room.contributions)) {
		if (contribution.expiresAt > now) {
			total += contribution.memberCount;
		}
	}
	return total;
}

export function conferenceModeratorPresent(room: LiveConferenceRoom, now: number): boolean {
	for (const contribution of Object.values(room.contributions)) {
		if (contribution.expiresAt > now && contribution.moderatorPresent) {
			return true;
		}
	}
	return false;
}

/** One room as the panel renders it: the claim's facts, plus the members this tab knows about. */
export interface LiveConferenceRoomView {
	readonly conferenceId: string;
	readonly bridgeId: string;
	/** Cluster-wide, from the unexpired contributions. Never smaller than `participants.length`. */
	readonly memberCount: number;
	readonly moderatorPresent: boolean;
	readonly locked: boolean;
	/** Moderators first, then in join order. See {@link conferenceRoomViews} for the comparator. */
	readonly participants: readonly LiveConferenceParticipant[];
	/**
	 * Whether this tab holds fewer members than the room counts.
	 *
	 * True for any console that connected mid-meeting, and it stops being true as the people already
	 * in the room are moved. The panel renders it rather than hiding it — see the note at the top of
	 * this section for why a moderation surface must never imply a partial list is a whole one.
	 */
	readonly incomplete: boolean;
}

/**
 * The running rooms, busiest first, with their members attached.
 *
 * ## A room with no unexpired contribution is DROPPED
 *
 * Not rendered as an empty meeting. A claim outliving every instance that held it is what a crash
 * looks like from here, and the next joiner reaps it — but until then the value is still in the
 * bucket, and a moderation panel offering Lock on a room nobody is in would be offering a 404.
 *
 * ## The comparator
 *
 * `(memberCount DESC, conferenceId ASC)`. The busiest room is the one somebody opened this panel
 * about; the id tie-break is not decoration but the thing that stops two equally sized rooms from
 * swapping places on every tick, which would make the expand control unusable.
 */
export function conferenceRoomViews(
	state: LiveConferenceState,
	now: number,
): readonly LiveConferenceRoomView[] {
	const views: LiveConferenceRoomView[] = [];
	for (const room of state.rooms.values()) {
		const memberCount = conferenceMemberCount(room, now);
		if (memberCount === 0) {
			continue;
		}
		const participants = [...(state.participants.get(room.conferenceId)?.values() ?? [])].sort(
			compareParticipants,
		);
		views.push({
			conferenceId: room.conferenceId,
			bridgeId: room.bridgeId,
			memberCount,
			moderatorPresent: conferenceModeratorPresent(room, now),
			locked: room.locked ?? false,
			participants,
			incomplete: participants.length < memberCount,
		});
	}
	return views.sort(
		(left, right) =>
			right.memberCount - left.memberCount || left.conferenceId.localeCompare(right.conferenceId),
	);
}

/**
 * Moderators first, then whoever this tab saw arrive earliest, then by leg for a total order.
 *
 * A member with no join time sorts AFTER one that has it, because an absent clock means "was
 * already here when we connected" — which, of the two readings available, is the one that is always
 * true. Without the final `legId` key the order of two members who joined in the same millisecond
 * would depend on map insertion order and could change under a re-render.
 */
function compareParticipants(
	left: LiveConferenceParticipant,
	right: LiveConferenceParticipant,
): number {
	if (left.moderator !== right.moderator) {
		return left.moderator ? -1 : 1;
	}
	const leftAt = left.joinedAt ?? Number.POSITIVE_INFINITY;
	const rightAt = right.joinedAt ?? Number.POSITIVE_INFINITY;
	return leftAt - rightAt || left.legId.localeCompare(right.legId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
