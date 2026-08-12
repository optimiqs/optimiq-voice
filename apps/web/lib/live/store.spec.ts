import { describe, expect, it } from "bun:test";
import {
	applySnapshot,
	applyUpdate,
	countLiveCalls,
	emptyKvState,
	isChannelLive,
	isRegistrationLive,
	longestWaitMs,
	parseAgentState,
	parseChannel,
	parseRegistration,
	parseTrunkStatusEvent,
	parseWaitingRecord,
	rankWaiting,
	type LiveChannel,
	type LiveRegistration,
	type LiveWaitingEntry,
	type LiveWaitingRecord,
} from "./store";

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
