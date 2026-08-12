import { describe, expect, it } from "bun:test";
import {
	compareWaiting,
	emptyWaitingRecord,
	isRenewalDue,
	longestWaitMs,
	pruneWaiting,
	putTombstone,
	QUEUE_WAITING_LEASE_MS,
	rankOf,
	removeWaiting,
	takeTombstone,
	upsertWaiting,
} from "./queue-waiting";
import type { QueueWaitingEntry, QueueWaitingRecord } from "@optimiq-voice/events";

/**
 * The shared waiting line, as pure data.
 *
 * Everything the cluster-wide position, caller priority and abandoned-resume features do is decided
 * here; `queue-waiting.store.ts` only reads, applies one of these, and writes. So these are the
 * cases that say what the features MEAN, and they run with no broker and no clock.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const QUEUE = "0195c0f0-1c2f-7000-8000-0000000000e1";
const NOW = Date.parse("2026-08-05T12:00:00.000Z");

function entry(callId: string, overrides: Partial<QueueWaitingEntry> = {}): QueueWaitingEntry {
	return {
		callId,
		legId: "0195c0f0-1c2f-7000-8000-0000000000a1",
		priority: 0,
		joinedAt: NOW,
		instanceId: "engine-1",
		expiresAt: NOW + QUEUE_WAITING_LEASE_MS,
		...overrides,
	};
}

function lineOf(...entries: readonly QueueWaitingEntry[]): QueueWaitingRecord {
	return entries.reduce(
		(record, next) => upsertWaiting(record, next, NOW),
		emptyWaitingRecord(ORG, QUEUE, NOW),
	);
}

describe("the order", () => {
	it("puts the earlier arrival first when priorities match", () => {
		const record = lineOf(entry("c2", { joinedAt: NOW + 1_000 }), entry("c1", { joinedAt: NOW }));
		expect(rankOf(record, "c1", NOW)).toBe(1);
		expect(rankOf(record, "c2", NOW)).toBe(2);
	});

	/**
	 * The whole point of priority: it beats arrival order, rather than only breaking ties in it.
	 * A scheme that read priority second would leave a VIP behind whoever rang a second earlier,
	 * which is the feature not existing.
	 */
	it("puts a higher priority ahead of somebody who has been holding longer", () => {
		const record = lineOf(
			entry("waiting-ages", { joinedAt: NOW - 600_000, priority: 0 }),
			entry("vip", { joinedAt: NOW, priority: 800 }),
		);
		expect(rankOf(record, "vip", NOW)).toBe(1);
		expect(rankOf(record, "waiting-ages", NOW)).toBe(2);
	});

	/**
	 * Two callers can join in the same millisecond — two instances writing in one CAS round is the
	 * normal case at the top of the hour. Without a total order their ranks would depend on the
	 * array order the record happened to be written in, so two engines reading ONE record would
	 * disagree about who is next.
	 */
	it("is total, so two engines reading one record cannot disagree", () => {
		const a = entry("aaa");
		const b = entry("bbb");
		expect(compareWaiting(a, b, NOW)).toBeLessThan(0);
		expect(compareWaiting(b, a, NOW)).toBeGreaterThan(0);
		expect(compareWaiting(a, a, NOW)).toBe(0);
		expect(rankOf(lineOf(b, a), "aaa", NOW)).toBe(rankOf(lineOf(a, b), "aaa", NOW));
	});

	/**
	 * There is no ageing, and this pins that it stays that way. See the starvation argument on the
	 * module: what bounds a starved caller is the queue's own `maxWaitSeconds`, which ejects them to
	 * a destination the operator chose, not a priority that quietly stops meaning what it says.
	 */
	it("does not age a low-priority caller past a high-priority one, however long they wait", () => {
		const record = lineOf(
			entry("normal", { joinedAt: NOW - 3_600_000, priority: 0 }),
			entry("vip", { joinedAt: NOW, priority: 1 }),
		);
		expect(rankOf(record, "vip", NOW)).toBe(1);
	});

	it("reports 0 for a caller the line does not hold, rather than guessing 1", () => {
		expect(rankOf(lineOf(entry("c1")), "somebody-else", NOW)).toBe(0);
	});

	it("moves everybody up when a caller ahead of them leaves", () => {
		const record = lineOf(entry("c1"), entry("c2", { joinedAt: NOW + 1 }));
		expect(rankOf(removeWaiting(record, "c1", NOW), "c2", NOW)).toBe(1);
	});

	it("keeps a caller's place when their entry is written again", () => {
		const record = lineOf(entry("c1"), entry("c2", { joinedAt: NOW + 1 }));
		const renewed = upsertWaiting(record, entry("c1", { expiresAt: NOW + 999_999 }), NOW);
		expect(renewed.entries).toHaveLength(2);
		expect(rankOf(renewed, "c1", NOW)).toBe(1);
	});
});

describe("leases", () => {
	/**
	 * The direction of the mistake matters. Dropping a LIVE caller costs them their place and tells
	 * everybody behind them they are one further forward than they are; keeping a DEAD one for a
	 * minute tells everybody they are one further back. The second is the one to make, which is why
	 * the lease is many poll intervals long and why this test is about the boundary rather than the
	 * middle.
	 */
	it("keeps an entry until its lease has actually lapsed", () => {
		const record = lineOf(entry("c1", { expiresAt: NOW + 1 }));
		expect(pruneWaiting(record, NOW).entries).toHaveLength(1);
		expect(pruneWaiting(record, NOW + 1).entries).toHaveLength(0);
	});

	it("leaves the record untouched when nothing has lapsed, so a write is not invented", () => {
		const record = lineOf(entry("c1"));
		expect(pruneWaiting(record, NOW)).toBe(record);
	});

	it("asks for a renewal well before the lease runs out", () => {
		expect(isRenewalDue(entry("c1"), NOW)).toBe(false);
		expect(isRenewalDue(entry("c1"), NOW + QUEUE_WAITING_LEASE_MS - 1_000)).toBe(true);
	});

	it("reports the longest wait in the line, which is the wallboard's headline number", () => {
		const record = lineOf(entry("c1", { joinedAt: NOW - 90_000 }), entry("c2", { joinedAt: NOW }));
		expect(longestWaitMs(record, NOW)).toBe(90_000);
	});
});

describe("abandoned-resume tombstones", () => {
	function tombstone(overrides: Record<string, unknown> = {}) {
		return {
			callerNumber: "+15551234567",
			joinedAt: NOW - 60_000,
			priority: 0,
			abandonedAt: NOW,
			expiresAt: NOW + 60_000,
			...overrides,
		};
	}

	it("hands a returning caller the place they had before they hung up", () => {
		const record = putTombstone(emptyWaitingRecord(ORG, QUEUE, NOW), tombstone(), NOW);
		const claimed = takeTombstone(record, "+15551234567", NOW);
		expect(claimed.tombstone?.joinedAt).toBe(NOW - 60_000);
	});

	/**
	 * One abandoned call must not buy one number an unlimited number of line-jumps for the rest of
	 * the window — that would be a priority bypass anybody could dial.
	 */
	it("removes the promise as it is claimed, so it can only be used once", () => {
		const record = putTombstone(emptyWaitingRecord(ORG, QUEUE, NOW), tombstone(), NOW);
		const first = takeTombstone(record, "+15551234567", NOW);
		expect(first.tombstone).toBeDefined();
		expect(takeTombstone(first.record, "+15551234567", NOW).tombstone).toBeUndefined();
	});

	it("does not honour a promise that has expired", () => {
		const record = putTombstone(emptyWaitingRecord(ORG, QUEUE, NOW), tombstone(), NOW);
		expect(takeTombstone(record, "+15551234567", NOW + 60_001).tombstone).toBeUndefined();
	});

	it("has nothing to give a caller who withheld their number", () => {
		const record = putTombstone(emptyWaitingRecord(ORG, QUEUE, NOW), tombstone(), NOW);
		expect(takeTombstone(record, undefined, NOW).tombstone).toBeUndefined();
		expect(takeTombstone(record, "", NOW).tombstone).toBeUndefined();
	});

	it("keeps the EARLIER place when the same number abandons twice", () => {
		const first = putTombstone(emptyWaitingRecord(ORG, QUEUE, NOW), tombstone(), NOW);
		const second = putTombstone(first, tombstone({ joinedAt: NOW, abandonedAt: NOW + 10 }), NOW);
		expect(second.tombstones).toHaveLength(1);
		expect(second.tombstones[0]?.joinedAt).toBe(NOW - 60_000);
	});

	it("prunes a lapsed promise on the way past, like a lapsed entry", () => {
		const record = putTombstone(emptyWaitingRecord(ORG, QUEUE, NOW), tombstone(), NOW);
		expect(pruneWaiting(record, NOW + 60_001).tombstones).toHaveLength(0);
	});
});
