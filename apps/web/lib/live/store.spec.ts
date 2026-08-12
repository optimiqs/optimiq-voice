import { describe, expect, it } from "bun:test";
import {
	applyConferenceSnapshot,
	applyConferenceUpdate,
	applySnapshot,
	applyUpdate,
	CONFERENCE_UNITY_GAIN_PERCENT,
	conferenceIdFromClaimKey,
	conferenceRoomViews,
	countLiveCalls,
	emptyConferenceState,
	emptyKvState,
	isChannelLive,
	isRegistrationLive,
	longestWaitMs,
	parseAgentState,
	parseChannel,
	parseConferenceClaim,
	parseConferenceEvent,
	parseRegistration,
	parseTrunkStatusEvent,
	parseWaitingRecord,
	rankWaiting,
	type LiveChannel,
	type LiveRegistration,
	type LiveWaitingEntry,
	type LiveWaitingRecord,
} from "./store";
import type { LiveSnapshotEvent, LiveUpdateEvent } from "./client";

/**
 * Reducing live frames into rendered state.
 *
 * The assertions worth having are the ones that stop a dashboard from stating something untrue: a
 * call that ended, a phone that is unplugged, and a number that appeared before the data behind it
 * did.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";

function registration(overrides: Partial<LiveRegistration> = {}): LiveRegistration {
	return {
		orgId: ORG,
		aor: "sip:1001@acme.example",
		aorHash: "aaaa",
		contact: "sip:1001@192.0.2.10",
		transport: "udp",
		registeredAt: "2026-08-06T09:00:00.000Z",
		expiresAt: "2026-08-06T09:05:00.000Z",
		...overrides,
	};
}

function channel(overrides: Partial<LiveChannel> = {}): LiveChannel {
	return {
		channelId: "leg-1",
		callId: "call-1",
		organizationId: ORG,
		direction: "inbound",
		state: "executing",
		createdAt: 1,
		...overrides,
	};
}

describe("applySnapshot", () => {
	/**
	 * The protocol has no cursor, so the gap before a snapshot is unbounded. Merging would keep a
	 * call that ended while the tab was hidden — and a wallboard showing a call that is not
	 * happening is worse than one showing none.
	 */
	it("replaces the whole state rather than merging into it", () => {
		const before = applySnapshot(
			{ topic: "registrations", at: "t1", rows: [{ key: "a", value: registration() }] },
			parseRegistration,
		);
		const after = applySnapshot(
			{
				topic: "registrations",
				at: "t2",
				rows: [{ key: "b", value: registration({ aorHash: "bbbb" }) }],
			},
			parseRegistration,
		);
		expect(before.rows.has("a")).toBe(true);
		expect(after.rows.has("a")).toBe(false);
		expect(after.rows.has("b")).toBe(true);
	});

	it("drops a row it cannot make sense of rather than rendering a blank line", () => {
		const state = applySnapshot(
			{
				topic: "registrations",
				at: "t",
				rows: [
					{ key: "a", value: registration() },
					{ key: "b", value: { nothing: true } },
				],
			},
			parseRegistration,
		);
		expect(state.rows.size).toBe(1);
	});

	/** `loaded` is what lets a tile show a dash instead of a confidently wrong zero. */
	it("marks the state loaded, even when the snapshot is empty", () => {
		expect(emptyKvState().loaded).toBe(false);
		expect(
			applySnapshot({ topic: "registrations", at: "t", rows: [] }, parseRegistration).loaded,
		).toBe(true);
	});
});

describe("applyUpdate", () => {
	const seeded = applySnapshot(
		{ topic: "registrations", at: "t", rows: [{ key: "org.aaaa", value: registration() }] },
		parseRegistration,
	);

	it("upserts a put by its key", () => {
		const next = applyUpdate(
			seeded,
			{
				topic: "registrations",
				kind: "put",
				at: "t2",
				key: "org.bbbb",
				data: registration({ aorHash: "bbbb" }),
			},
			parseRegistration,
		);
		expect(next.rows.size).toBe(2);
	});

	/** A deletion carries no value, so the KEY is the only identity there is. */
	it("removes a delete by its key", () => {
		const next = applyUpdate(
			seeded,
			{ topic: "registrations", kind: "delete", at: "t2", key: "org.aaaa", data: null },
			parseRegistration,
		);
		expect(next.rows.size).toBe(0);
	});

	/**
	 * Returning the same object is what lets React skip a render. A bucket that republishes an
	 * unchanged registration on every phone refresh would otherwise re-render the table once per
	 * device per minute for no visible reason.
	 */
	it("returns the same state when nothing changed", () => {
		expect(
			applyUpdate(
				seeded,
				{ topic: "registrations", kind: "delete", at: "t2", key: "org.unknown", data: null },
				parseRegistration,
			),
		).toBe(seeded);
		expect(
			applyUpdate(
				seeded,
				{ topic: "registrations", kind: "put", at: "t2", key: "org.x", data: { junk: 1 } },
				parseRegistration,
			),
		).toBe(seeded);
	});

	it("ignores a stream event, which has no key to file it under", () => {
		expect(
			applyUpdate(
				seeded,
				{ topic: "agent-state", kind: "agent.state", at: "t", data: {} },
				parseRegistration,
			),
		).toBe(seeded);
	});

	/**
	 * A reconnect that delivers an update before its snapshot must not leave a tile showing a dash
	 * forever: the update itself proves the topic is live.
	 */
	it("marks the state loaded even without a snapshot", () => {
		const next = applyUpdate(
			emptyKvState<LiveRegistration>(),
			{ topic: "registrations", kind: "put", at: "t", key: "k", data: registration() },
			parseRegistration,
		);
		expect(next.loaded).toBe(true);
	});
});

describe("isRegistrationLive", () => {
	/**
	 * The bucket's TTL is an hour and a device's `Expires:` is minutes, so an entry can be present
	 * and long dead. A column that read presence as "registered" would show an unplugged phone as
	 * online for the rest of the hour.
	 */
	it("reads a present-but-lapsed binding as offline", () => {
		const binding = registration();
		expect(isRegistrationLive(binding, Date.parse("2026-08-06T09:04:00.000Z"))).toBe(true);
		expect(isRegistrationLive(binding, Date.parse("2026-08-06T09:06:00.000Z"))).toBe(false);
	});

	it("treats an unreadable expiry as offline rather than as forever", () => {
		expect(isRegistrationLive(registration({ expiresAt: "soon" }), Date.now())).toBe(false);
	});
});

describe("channels", () => {
	it("counts a leg in teardown as gone, whichever half of the write landed", () => {
		for (const state of ["hangup", "reporting", "destroyed"]) {
			expect(isChannelLive(channel({ state }))).toBe(false);
		}
		expect(isChannelLive(channel({ hangupAt: 5 }))).toBe(false);
		expect(isChannelLive(channel())).toBe(true);
	});

	/**
	 * The bucket holds one entry per LEG, and a bridged call is two of them. Counting entries would
	 * show every answered call twice and make "3 active calls" mean six phones or three.
	 */
	it("counts distinct calls, not legs", () => {
		expect(
			countLiveCalls([
				channel({ channelId: "a", callId: "call-1" }),
				channel({ channelId: "b", callId: "call-1" }),
				channel({ channelId: "c", callId: "call-2" }),
			]),
		).toBe(2);
	});

	it("does not count a torn-down leg's call", () => {
		expect(countLiveCalls([channel({ state: "destroyed" })])).toBe(0);
	});
});

describe("the parsers", () => {
	it("accept the shapes the server sends and refuse the rest", () => {
		expect(parseRegistration(registration())).not.toBe(undefined);
		expect(parseRegistration({ aor: "sip:x" })).toBe(undefined);
		expect(parseChannel(channel())).not.toBe(undefined);
		expect(parseChannel({ callId: "c" })).toBe(undefined);
		expect(parseAgentState({ agentId: "a", status: "available" })).not.toBe(undefined);
		expect(parseAgentState({ agentId: "a" })).toBe(undefined);
		expect(parseAgentState(null)).toBe(undefined);
	});
});

/**
 * The trunk status parser, which is the only one here that reads an ENVELOPE rather than a bucket
 * value — `trunks` is a stream topic with no KV projection behind it, so the trunk it is about is
 * carried in the subject rather than in a key.
 *
 * What these assert is the pair of things that would put something untrue on the trunks screen: a
 * status word this build has no badge for, and a transition attributed to the wrong trunk.
 */
describe("parseTrunkStatusEvent", () => {
	const TRUNK = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
	const SUBJECT = `trunk.evt.v1.${ORG}.${TRUNK}.status.changed`;
	const RECEIVED = "2026-08-06T09:00:05.000Z";

	function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			subject: SUBJECT,
			at: "2026-08-06T09:00:00.000Z",
			data: { status: "down", reason: "Unreachable", latencyMs: 0 },
			...overrides,
		};
	}

	it("takes the trunk id from the subject, which is where the address lives", () => {
		expect(parseTrunkStatusEvent(envelope(), RECEIVED)?.trunkId).toBe(TRUNK);
	});

	/**
	 * The transition's own moment, not this tab's. A page opened after an outage started and then
	 * handed a republished event would otherwise claim the carrier went down just now.
	 */
	it("prefers the envelope's timestamp over the moment the frame arrived", () => {
		expect(parseTrunkStatusEvent(envelope(), RECEIVED)?.at).toBe("2026-08-06T09:00:00.000Z");
		expect(parseTrunkStatusEvent(envelope({ at: undefined }), RECEIVED)?.at).toBe(RECEIVED);
	});

	/**
	 * The five words `trunk.status` can hold. A sixth is a status the server has learned and this
	 * build has not, and rendering it would paint an unstyled badge OVER the value the row already
	 * carries — strictly worse than leaving the row's answer alone until the page is reloaded.
	 */
	it("refuses a status the column could not hold, so the row's own answer survives", () => {
		for (const status of ["unknown", "up", "down", "degraded", "disabled"]) {
			expect(parseTrunkStatusEvent(envelope({ data: { status } }), RECEIVED)?.status).toBe(status);
		}
		expect(parseTrunkStatusEvent(envelope({ data: { status: "flapping" } }), RECEIVED)).toBe(
			undefined,
		);
		expect(parseTrunkStatusEvent(envelope({ data: { status: 3 } }), RECEIVED)).toBe(undefined);
	});

	it("refuses an envelope with no subject, no payload, or no trunk token in the subject", () => {
		expect(parseTrunkStatusEvent(envelope({ subject: undefined }), RECEIVED)).toBe(undefined);
		expect(parseTrunkStatusEvent(envelope({ data: undefined }), RECEIVED)).toBe(undefined);
		expect(parseTrunkStatusEvent(envelope({ subject: "trunk.evt.v1" }), RECEIVED)).toBe(undefined);
		expect(parseTrunkStatusEvent(null, RECEIVED)).toBe(undefined);
	});

	/** The two optional fields are omitted rather than nulled, so a caller's `??` reaches the row. */
	it("omits the reason and the latency when the media server reported neither", () => {
		const parsed = parseTrunkStatusEvent(envelope({ data: { status: "up" } }), RECEIVED);

		expect(parsed).toEqual({ trunkId: TRUNK, status: "up", at: "2026-08-06T09:00:00.000Z" });
		expect(parsed && "reason" in parsed).toBe(false);
		expect(parsed && "latencyMs" in parsed).toBe(false);
	});
});

// ---------------------------------------------------------------------------------------------
// the waiting line
// ---------------------------------------------------------------------------------------------

/**
 * The line a wallboard draws, which is the one place in this app where getting an ORDER wrong is
 * worse than showing nothing: a supervisor watching positions move is deciding who to help, and a
 * client that ranked differently from the engine would show them a queue answering out of turn.
 */
describe("the waiting line", () => {
	const NOW = 1_760_000_000_000;
	const QUEUE = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";

	function entry(overrides: Partial<LiveWaitingEntry> = {}): LiveWaitingEntry {
		return {
			callId: "019fd3c2-aaaa-76be-a6b3-b0f1914e39b6",
			legId: "019fd3c2-bbbb-76be-a6b3-b0f1914e39b6",
			priority: 0,
			joinedAt: NOW - 30_000,
			expiresAt: NOW + 60_000,
			...overrides,
		};
	}

	function record(entries: readonly LiveWaitingEntry[]): LiveWaitingRecord {
		return { orgId: ORG, queueId: QUEUE, entries, updatedAt: NOW };
	}

	it("parses the bucket's value and drops an entry with no lease on it", () => {
		const parsed = parseWaitingRecord({
			orgId: ORG,
			queueId: QUEUE,
			entries: [entry(), { callId: "no-lease", joinedAt: NOW, priority: 0 }],
			tombstones: [],
			updatedAt: NOW,
		});

		expect(parsed?.queueId).toBe(QUEUE);
		expect(parsed?.entries).toHaveLength(1);
	});

	it("refuses anything that is not a line", () => {
		expect(parseWaitingRecord(null)).toBe(undefined);
		expect(parseWaitingRecord({ queueId: QUEUE })).toBe(undefined);
		expect(parseWaitingRecord({ entries: [] })).toBe(undefined);
	});

	/** `(priority DESC, joinedAt ASC, callId ASC)` — the engine's comparator, restated. */
	it("ranks by priority first, then by arrival", () => {
		const ranked = rankWaiting(
			record([
				entry({ callId: "a", joinedAt: NOW - 120_000, priority: 0 }),
				entry({ callId: "b", joinedAt: NOW - 10_000, priority: 900 }),
				entry({ callId: "c", joinedAt: NOW - 60_000, priority: 0 }),
			]),
			NOW,
		);

		expect(ranked.map((caller) => caller.callId)).toEqual(["b", "a", "c"]);
		expect(ranked.map((caller) => caller.position)).toEqual([1, 2, 3]);
	});

	/**
	 * Two callers can join in the same millisecond — two engine instances writing in one CAS round
	 * is the normal case at the top of the hour — and without the id tie-break each reader's rank
	 * would depend on the array order the record happened to be written in.
	 */
	it("breaks a same-millisecond tie by call id, so every reader agrees", () => {
		const entries = [
			entry({ callId: "b", joinedAt: NOW - 5_000 }),
			entry({ callId: "a", joinedAt: NOW - 5_000 }),
		];

		expect(rankWaiting(record(entries), NOW).map((caller) => caller.callId)).toEqual(["a", "b"]);
		expect(rankWaiting(record([...entries].reverse()), NOW).map((caller) => caller.callId)).toEqual(
			["a", "b"],
		);
	});

	/**
	 * A lapsed lease is a caller who is no longer on the phone. The engine prunes on its way past,
	 * so between two writes the value still holds them — and a wallboard rendering one is showing a
	 * call that is not happening, which is the single thing it must not do.
	 */
	it("drops a caller whose lease has lapsed rather than waiting for the next write", () => {
		const ranked = rankWaiting(
			record([
				entry({ callId: "live", expiresAt: NOW + 1 }),
				entry({ callId: "lapsed", expiresAt: NOW - 1 }),
			]),
			NOW,
		);

		expect(ranked.map((caller) => caller.callId)).toEqual(["live"]);
	});

	it("counts the wait from the place a resumed caller was restored to, and never negatively", () => {
		const ranked = rankWaiting(
			record([
				entry({ callId: "restored", joinedAt: NOW - 240_000 }),
				entry({ callId: "skewed", joinedAt: NOW + 5_000 }),
			]),
			NOW,
			new Set(["restored"]),
		);

		expect(ranked[0]?.callId).toBe("restored");
		expect(ranked[0]?.waitedMs).toBe(240_000);
		expect(ranked[0]?.resumed).toBe(true);
		// A caller whose join is in this browser's future is clock skew between the engine and the
		// laptop watching it, not a negative wait.
		expect(ranked[1]?.waitedMs).toBe(0);
		expect(ranked[1]?.resumed).toBe(false);
	});

	it("reports the longest wait, which an average would hide", () => {
		const ranked = rankWaiting(
			record([
				entry({ callId: "a", joinedAt: NOW - 10_000 }),
				entry({ callId: "b", joinedAt: NOW - 660_000 }),
				entry({ callId: "c", joinedAt: NOW - 10_000 }),
			]),
			NOW,
		);

		expect(longestWaitMs(ranked)).toBe(660_000);
		expect(longestWaitMs([])).toBe(0);
	});

	it("treats an absent record as an empty line rather than as unknown", () => {
		expect(rankWaiting(null, NOW)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------
// conferences
// ---------------------------------------------------------------------------------------------

/**
 * The one topic that reduces a BUCKET and a STREAM into one picture.
 *
 * The assertions worth having are the ones that stop a moderation panel from offering a control
 * that cannot work: a room nobody is in, a participant who has left, a lock that a reconnect
 * forgot, and a member list that claims to be complete when it is not.
 */

const CONF = "019fd400-2222-7000-8000-000000000001";
const OTHER_CONF = "019fd400-2222-7000-8000-000000000002";
const CONF_NOW = 1_800_000_000_000;

function claim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		orgId: ORG,
		conferenceId: CONF,
		bridgeId: "bridge-1",
		claimedAt: CONF_NOW - 60_000,
		contributions: {
			"engine-a": { memberCount: 2, moderatorPresent: false, expiresAt: CONF_NOW + 60_000 },
		},
		...overrides,
	};
}

function snapshotOf(...claims: Record<string, unknown>[]): LiveSnapshotEvent {
	return {
		topic: "conferences",
		at: "t1",
		rows: claims.map((value) => ({ key: `${ORG}.${String(value.conferenceId)}`, value })),
	};
}

function conferenceFrame(
	kind: string,
	data: Record<string, unknown>,
	at = "2026-08-12T10:00:00.000Z",
): LiveUpdateEvent {
	return {
		topic: "conferences",
		kind,
		at,
		data: { subject: `calls.evt.v1.${ORG}.call-1.${kind}`, at, data },
	};
}

describe("parseConferenceClaim", () => {
	it("reads a room and keeps every leased contribution", () => {
		const parsed = parseConferenceClaim(claim());

		expect(parsed?.conferenceId).toBe(CONF);
		expect(parsed?.bridgeId).toBe("bridge-1");
		expect(parsed?.contributions["engine-a"]?.memberCount).toBe(2);
		// Absent means unlocked: a claim written by a release predating moderation is a room nobody
		// has locked, which is what it was.
		expect(parsed?.locked).toBeUndefined();
	});

	it("refuses a value with no bridge, because the bridge is what a room IS", () => {
		expect(parseConferenceClaim({ conferenceId: CONF, contributions: {} })).toBeUndefined();
		expect(parseConferenceClaim(null)).toBeUndefined();
	});

	/**
	 * `expiresAt` is the lease. A contribution without one could never stop counting, so a crashed
	 * instance's seats would hold a meeting open on screen for the bucket's whole fifteen minutes.
	 */
	it("drops a contribution carrying no lease", () => {
		const parsed = parseConferenceClaim(
			claim({
				contributions: {
					"engine-a": { memberCount: 2, moderatorPresent: false, expiresAt: CONF_NOW + 1 },
					"engine-b": { memberCount: 9, moderatorPresent: true },
				},
			}),
		);

		expect(Object.keys(parsed?.contributions ?? {})).toEqual(["engine-a"]);
	});
});

describe("conferenceIdFromClaimKey", () => {
	/** A `delete` carries no value, so the key is the only identity the room removal has. */
	it("reads the room out of an <org>.<conference> key", () => {
		expect(conferenceIdFromClaimKey(`${ORG}.${CONF}`)).toBe(CONF);
	});

	it("refuses anything that is not exactly two segments", () => {
		expect(conferenceIdFromClaimKey(ORG)).toBeUndefined();
		expect(conferenceIdFromClaimKey(`${ORG}.${CONF}.extra`)).toBeUndefined();
		expect(conferenceIdFromClaimKey(`${ORG}.`)).toBeUndefined();
	});
});

describe("parseConferenceEvent", () => {
	/**
	 * The lock state is the frame's KIND and not a payload field, because the payload has none —
	 * the event type IS the transition.
	 */
	it("reads lock and unlock from the event type", () => {
		const locked = parseConferenceEvent(
			"conference.locked",
			{ data: { conferenceId: CONF, roomNumber: "3001", memberCount: 4 } },
			"t",
		);
		const unlocked = parseConferenceEvent(
			"conference.unlocked",
			{ data: { conferenceId: CONF, roomNumber: "3001", memberCount: 4 } },
			"t",
		);

		expect(locked).toEqual({ kind: "lock", conferenceId: CONF, locked: true });
		expect(unlocked).toEqual({ kind: "lock", conferenceId: CONF, locked: false });
	});

	/**
	 * A caller entering a room is unmuted, undeafened and at unity, always — the join event carries
	 * none of the four for exactly that reason, and inventing them here is what makes the first
	 * render of a new arrival true rather than blank.
	 */
	it("gives a joiner the state the engine says every joiner has", () => {
		const parsed = parseConferenceEvent(
			"conference.joined",
			{
				at: "2026-08-12T10:00:00.000Z",
				data: {
					legId: "leg-1",
					conferenceId: CONF,
					roomNumber: "3001",
					bridgeId: "bridge-1",
					moderator: true,
					memberCount: 1,
				},
			},
			"2026-08-12T10:00:05.000Z",
		);

		expect(parsed?.kind).toBe("joined");
		if (parsed?.kind !== "joined") {
			throw new Error("expected a join");
		}
		expect(parsed.participant.muted).toBe(false);
		expect(parsed.participant.deafened).toBe(false);
		expect(parsed.participant.talkGainPercent).toBe(CONFERENCE_UNITY_GAIN_PERCENT);
		expect(parsed.participant.moderator).toBe(true);
		// The envelope's own stamp, never the moment this tab was handed the frame.
		expect(parsed.participant.joinedAt).toBe(Date.parse("2026-08-12T10:00:00.000Z"));
	});

	it("falls back to the frame's clock when the envelope carries no usable one", () => {
		const parsed = parseConferenceEvent(
			"conference.joined",
			{ data: { legId: "leg-1", conferenceId: CONF, roomNumber: "3001", moderator: false } },
			"2026-08-12T10:00:05.000Z",
		);

		expect(parsed?.kind === "joined" ? parsed.participant.joinedAt : undefined).toBe(
			Date.parse("2026-08-12T10:00:05.000Z"),
		);
	});

	/** Absent is `hung-up`: an artifact of a release predating moderation is not a mass kicking. */
	it("reads an absent leave reason as a hang-up and keeps a real one", () => {
		const plain = parseConferenceEvent(
			"conference.left",
			{ data: { legId: "leg-1", conferenceId: CONF, roomNumber: "3001" } },
			"t",
		);
		const kicked = parseConferenceEvent(
			"conference.left",
			{ data: { legId: "leg-1", conferenceId: CONF, roomNumber: "3001", reason: "kicked" } },
			"t",
		);

		expect(plain).toEqual({ kind: "left", conferenceId: CONF, legId: "leg-1", reason: "hung-up" });
		expect(kicked?.kind === "left" ? kicked.reason : undefined).toBe("kicked");
	});

	/**
	 * Both gains are REQUIRED on the wire because 100 is a real answer and an absent field is not.
	 * A frame missing one is a build disagreement, and rendering a level nobody set would be worse
	 * than dropping the frame.
	 */
	it("refuses a participant update with no gains", () => {
		expect(
			parseConferenceEvent(
				"conference.participant.updated",
				{
					data: {
						legId: "leg-1",
						conferenceId: CONF,
						roomNumber: "3001",
						muted: true,
						deafened: false,
						moderator: false,
					},
				},
				"t",
			),
		).toBeUndefined();
	});

	it("ignores an event kind this build has never heard of", () => {
		expect(
			parseConferenceEvent("conference.something.new", { data: { conferenceId: CONF } }, "t"),
		).toBeUndefined();
	});
});

describe("applyConferenceSnapshot", () => {
	it("keys rooms by the claim's own conference id, not by the <org>.<id> KV key", () => {
		const state = applyConferenceSnapshot(snapshotOf(claim()));

		expect([...state.rooms.keys()]).toEqual([CONF]);
		expect(state.loaded).toBe(true);
	});

	/**
	 * A participant list carried across a reconnect would show somebody who left while the socket
	 * was down — with a Remove button beside them that can only ever 404. The gap before a snapshot
	 * is unbounded, so the members are rebuilt from the events that follow.
	 */
	it("clears the participants it had, not only the rooms", () => {
		let state = applyConferenceSnapshot(snapshotOf(claim()));
		state = applyConferenceUpdate(
			state,
			conferenceFrame("conference.joined", {
				legId: "leg-1",
				conferenceId: CONF,
				roomNumber: "3001",
				moderator: false,
			}),
		);
		expect(state.participants.get(CONF)?.size).toBe(1);

		const reconnected = applyConferenceSnapshot(snapshotOf(claim()));
		expect(reconnected.participants.size).toBe(0);
	});
});

describe("applyConferenceUpdate", () => {
	const seeded = applyConferenceSnapshot(snapshotOf(claim()));

	it("overlays participants onto the room the snapshot established", () => {
		const state = applyConferenceUpdate(
			seeded,
			conferenceFrame("conference.joined", {
				legId: "leg-1",
				conferenceId: CONF,
				roomNumber: "3001",
				moderator: false,
			}),
		);

		expect(state.rooms.size).toBe(1);
		expect(state.participants.get(CONF)?.get("leg-1")?.roomNumber).toBe("3001");
	});

	it("replaces a member's whole state on an update rather than applying a delta", () => {
		let state = applyConferenceUpdate(
			seeded,
			conferenceFrame("conference.joined", {
				legId: "leg-1",
				conferenceId: CONF,
				roomNumber: "3001",
				moderator: false,
			}),
		);
		state = applyConferenceUpdate(
			state,
			conferenceFrame("conference.participant.updated", {
				legId: "leg-1",
				conferenceId: CONF,
				roomNumber: "3001",
				muted: true,
				deafened: true,
				moderator: false,
				talkGainPercent: 100,
				listenGainPercent: 100,
			}),
		);

		const member = state.participants.get(CONF)?.get("leg-1");
		expect(member?.muted).toBe(true);
		expect(member?.deafened).toBe(true);
	});

	/**
	 * `conference.participant.updated` does not carry a join time, so a merge is the only way the
	 * one clock a row has been ticking survives a mute.
	 */
	it("keeps the join clock across a participant update", () => {
		let state = applyConferenceUpdate(
			seeded,
			conferenceFrame(
				"conference.joined",
				{ legId: "leg-1", conferenceId: CONF, roomNumber: "3001", moderator: false },
				"2026-08-12T10:00:00.000Z",
			),
		);
		const joinedAt = state.participants.get(CONF)?.get("leg-1")?.joinedAt;

		state = applyConferenceUpdate(
			state,
			conferenceFrame("conference.participant.updated", {
				legId: "leg-1",
				conferenceId: CONF,
				roomNumber: "3001",
				muted: true,
				deafened: false,
				moderator: false,
				talkGainPercent: 100,
				listenGainPercent: 100,
			}),
		);

		expect(joinedAt).toBe(Date.parse("2026-08-12T10:00:00.000Z"));
		expect(state.participants.get(CONF)?.get("leg-1")?.joinedAt).toBe(joinedAt);
	});

	it("prunes a participant who left, and the room's entry with the last of them", () => {
		let state = applyConferenceUpdate(
			seeded,
			conferenceFrame("conference.joined", {
				legId: "leg-1",
				conferenceId: CONF,
				roomNumber: "3001",
				moderator: false,
			}),
		);
		state = applyConferenceUpdate(
			state,
			conferenceFrame("conference.left", {
				legId: "leg-1",
				conferenceId: CONF,
				roomNumber: "3001",
				reason: "kicked",
			}),
		);

		expect(state.participants.has(CONF)).toBe(false);
		// The ROOM survives its last known member leaving: the claim still says people are in it,
		// and this tab simply cannot name them.
		expect(state.rooms.has(CONF)).toBe(true);
	});

	it("applies a lock transition to a room it holds, in both directions", () => {
		const locked = applyConferenceUpdate(
			seeded,
			conferenceFrame("conference.locked", { conferenceId: CONF, roomNumber: "3001" }),
		);
		expect(locked.rooms.get(CONF)?.locked).toBe(true);

		const unlocked = applyConferenceUpdate(
			locked,
			conferenceFrame("conference.unlocked", { conferenceId: CONF, roomNumber: "3001" }),
		);
		expect(unlocked.rooms.get(CONF)?.locked).toBe(false);
	});

	/**
	 * There is nothing to render the badge on, and the engine rewrites the claim under
	 * compare-and-set when it locks — so the `put` carrying the same fact is already on its way.
	 */
	it("drops a lock for a room it has no claim for", () => {
		const state = applyConferenceUpdate(
			seeded,
			conferenceFrame("conference.locked", { conferenceId: OTHER_CONF, roomNumber: "3002" }),
		);

		expect(state).toBe(seeded);
	});

	it("takes the members with the room when the claim is deleted", () => {
		let state = applyConferenceUpdate(
			seeded,
			conferenceFrame("conference.joined", {
				legId: "leg-1",
				conferenceId: CONF,
				roomNumber: "3001",
				moderator: false,
			}),
		);
		state = applyConferenceUpdate(state, {
			topic: "conferences",
			kind: "delete",
			at: "t9",
			data: null,
			key: `${ORG}.${CONF}`,
		});

		expect(state.rooms.size).toBe(0);
		expect(state.participants.size).toBe(0);
	});

	it("becomes loaded from a claim put alone, for a deployment with no bucket to snapshot", () => {
		const state = applyConferenceUpdate(emptyConferenceState(), {
			topic: "conferences",
			kind: "put",
			at: "t1",
			data: claim(),
			key: `${ORG}.${CONF}`,
		});

		expect(state.loaded).toBe(true);
		expect(state.rooms.get(CONF)?.bridgeId).toBe("bridge-1");
	});

	/**
	 * A contribution's lease rolls forward on a heartbeat without anything about the room changing.
	 * Re-rendering a table of expanded meetings once per instance per heartbeat is the bug the
	 * same-object rule exists to prevent — but a claim whose lease genuinely moved is a NEW value,
	 * so what is asserted here is the frames that carry nothing at all.
	 */
	it("returns the same object for a frame that changes nothing", () => {
		expect(applyConferenceUpdate(seeded, conferenceFrame("conference.joined", {}))).toBe(seeded);
		expect(
			applyConferenceUpdate(seeded, {
				topic: "conferences",
				kind: "delete",
				at: "t2",
				data: null,
				key: `${ORG}.${OTHER_CONF}`,
			}),
		).toBe(seeded);
		expect(
			applyConferenceUpdate(seeded, {
				topic: "conferences",
				kind: "put",
				at: "t2",
				data: { nonsense: true },
				key: `${ORG}.${CONF}`,
			}),
		).toBe(seeded);
	});
});

describe("conferenceRoomViews", () => {
	/**
	 * A claim outliving every instance that held it is what a crash looks like from here. The next
	 * joiner reaps it, but until then the value is in the bucket — and a panel offering Lock on a
	 * room nobody is in is offering a 404.
	 */
	it("drops a room whose every contribution has lapsed", () => {
		const state = applyConferenceSnapshot(
			snapshotOf(
				claim(),
				claim({
					conferenceId: OTHER_CONF,
					contributions: {
						"engine-b": { memberCount: 5, moderatorPresent: true, expiresAt: CONF_NOW - 1 },
					},
				}),
			),
		);

		expect(conferenceRoomViews(state, CONF_NOW).map((room) => room.conferenceId)).toEqual([CONF]);
	});

	it("sums the unexpired contributions across instances, and reports a moderator anywhere", () => {
		const state = applyConferenceSnapshot(
			snapshotOf(
				claim({
					contributions: {
						"engine-a": { memberCount: 2, moderatorPresent: false, expiresAt: CONF_NOW + 1 },
						"engine-b": { memberCount: 3, moderatorPresent: true, expiresAt: CONF_NOW + 1 },
						"engine-dead": { memberCount: 9, moderatorPresent: true, expiresAt: CONF_NOW - 1 },
					},
				}),
			),
		);
		const [room] = conferenceRoomViews(state, CONF_NOW);

		expect(room?.memberCount).toBe(5);
		expect(room?.moderatorPresent).toBe(true);
	});

	/**
	 * The claim counts everybody; the events only describe what has moved since this tab connected.
	 * Saying so is what stops an operator concluding somebody left when they merely joined first.
	 */
	it("says the member list is incomplete until it accounts for the whole room", () => {
		let state = applyConferenceSnapshot(snapshotOf(claim()));
		expect(conferenceRoomViews(state, CONF_NOW)[0]?.incomplete).toBe(true);

		for (const legId of ["leg-1", "leg-2"]) {
			state = applyConferenceUpdate(
				state,
				conferenceFrame("conference.joined", {
					legId,
					conferenceId: CONF,
					roomNumber: "3001",
					moderator: false,
				}),
			);
		}

		expect(conferenceRoomViews(state, CONF_NOW)[0]?.incomplete).toBe(false);
	});

	it("puts moderators first, then whoever this tab saw arrive earliest", () => {
		let state = applyConferenceSnapshot(snapshotOf(claim()));
		state = applyConferenceUpdate(
			state,
			conferenceFrame(
				"conference.joined",
				{ legId: "early", conferenceId: CONF, roomNumber: "3001", moderator: false },
				"2026-08-12T10:00:00.000Z",
			),
		);
		state = applyConferenceUpdate(
			state,
			conferenceFrame(
				"conference.joined",
				{ legId: "late-moderator", conferenceId: CONF, roomNumber: "3001", moderator: true },
				"2026-08-12T10:05:00.000Z",
			),
		);
		// Somebody who was already in the room: known only because a mute named them, so no clock.
		state = applyConferenceUpdate(
			state,
			conferenceFrame("conference.participant.updated", {
				legId: "was-already-here",
				conferenceId: CONF,
				roomNumber: "3001",
				muted: true,
				deafened: false,
				moderator: false,
				talkGainPercent: 100,
				listenGainPercent: 100,
			}),
		);

		expect(
			conferenceRoomViews(state, CONF_NOW)[0]?.participants.map((member) => member.legId),
		).toEqual(["late-moderator", "early", "was-already-here"]);
	});

	it("orders rooms by size, with a stable tie-break so cards do not swap under a tick", () => {
		const state = applyConferenceSnapshot(
			snapshotOf(
				claim({
					contributions: {
						"engine-a": { memberCount: 2, moderatorPresent: false, expiresAt: CONF_NOW + 1 },
					},
				}),
				claim({
					conferenceId: OTHER_CONF,
					contributions: {
						"engine-a": { memberCount: 7, moderatorPresent: false, expiresAt: CONF_NOW + 1 },
					},
				}),
			),
		);

		expect(conferenceRoomViews(state, CONF_NOW).map((room) => room.conferenceId)).toEqual([
			OTHER_CONF,
			CONF,
		]);
	});
});
