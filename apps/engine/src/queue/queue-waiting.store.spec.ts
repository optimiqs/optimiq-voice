import { describe, expect, it } from "bun:test";
import { queueWaitingRecordSchema } from "@optimiq-voice/events";
import { QUEUE_WAITING_LEASE_MS, QUEUE_WAITING_RENEW_AFTER_MS } from "./queue-waiting";
import { QueueWaitingStore } from "./queue-waiting.store";
import type { JetStreamService } from "../nats/jetstream.service";
import type { QueueWaitingRecord } from "@optimiq-voice/events";
import type { KV } from "nats";

/**
 * The waiting line's writer, over a fake bucket.
 *
 * The ORDERING is tested in `queue-waiting.spec.ts`, where it is pure. What is left here is the half
 * that only exists because the record is shared: the compare-and-set, what happens when it loses,
 * and — the cases that matter most — what the session is told when the broker cannot answer at all.
 *
 * The failure direction is the whole point. Every one of these paths ends in a position of 0, which
 * the session reads as "do not announce anything", rather than in a thrown error or a number this
 * process invented from the callers it happens to be holding. Announcing a wrong position is the
 * exact defect the shared line was built to fix; announcing nothing is the honest degradation.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const QUEUE = "0195c0f0-1c2f-7000-8000-0000000000e1";
const CALL = "0195c0f0-1c2f-7000-8000-0000000000c1";
const OTHER_CALL = "0195c0f0-1c2f-7000-8000-0000000000c2";
const LEG = "0195c0f0-1c2f-7000-8000-0000000000a1";
const NOW = Date.parse("2026-08-05T12:00:00.000Z");

interface FakeBucket {
	kv: KV;
	record: QueueWaitingRecord | undefined;
	revision: number;
	/** Writes to fail with a conflict before one is allowed through. */
	conflicts: number;
	/** Reads and writes to fail with a broker error. */
	unavailable: boolean;
	/** Bytes to return instead of the record, so an unparseable value can be exercised. */
	corrupt: boolean;
	creates: number;
	updates: number;
}

class Conflict extends Error {
	readonly api_error = { err_code: 10071 };
}

function fakeBucket(): FakeBucket {
	const state: FakeBucket = {
		kv: undefined as unknown as KV,
		record: undefined,
		revision: 0,
		conflicts: 0,
		unavailable: false,
		corrupt: false,
		creates: 0,
		updates: 0,
	};

	const write = (value: Uint8Array): number => {
		if (state.unavailable) {
			throw new Error("broker unreachable");
		}
		if (state.conflicts > 0) {
			state.conflicts -= 1;
			throw new Conflict("wrong last sequence");
		}
		state.record = queueWaitingRecordSchema.parse(
			JSON.parse(new TextDecoder().decode(value)),
		) as QueueWaitingRecord;
		state.revision += 1;
		return state.revision;
	};

	state.kv = {
		get: async (_key: string) => {
			if (state.unavailable) {
				throw new Error("broker unreachable");
			}
			if (state.corrupt) {
				return { value: new TextEncoder().encode("{not json"), revision: 7 };
			}
			if (state.record === undefined) {
				return null;
			}
			return {
				value: new TextEncoder().encode(JSON.stringify(state.record)),
				revision: state.revision,
			};
		},
		create: async (_key: string, value: Uint8Array) => {
			state.creates += 1;
			return write(value);
		},
		update: async (_key: string, value: Uint8Array, _revision: number) => {
			state.updates += 1;
			return write(value);
		},
	} as unknown as KV;

	return state;
}

function storeOver(bucket: FakeBucket | undefined): QueueWaitingStore {
	return new QueueWaitingStore({ queueWaiting: bucket?.kv } as unknown as JetStreamService);
}

function joinOf(overrides: Record<string, unknown> = {}) {
	return {
		orgId: ORG,
		queueId: QUEUE,
		callId: CALL,
		legId: LEG,
		priority: 0,
		instanceId: "engine-1",
		now: NOW,
		resumeAllowed: false,
		...overrides,
	} as never;
}

describe("writing the shared line", () => {
	it("creates the record for the first caller, and updates it for the second", async () => {
		const bucket = fakeBucket();
		const store = storeOver(bucket);

		expect((await store.join(joinOf())).position).toBe(1);
		expect(bucket.creates).toBe(1);

		const second = await store.join(joinOf({ callId: OTHER_CALL, now: NOW + 1_000 }));
		expect(second.position).toBe(2);
		expect(second.waiting).toBe(2);
		expect(bucket.updates).toBe(1);
	});

	/**
	 * A lost compare-and-set is the normal case, not an error: another instance wrote between our
	 * read and our write. The retry re-READS, because re-applying to the value we already had would
	 * undo whatever they did — which on this record means evicting their caller from the line.
	 */
	it("retries a lost write against the newer value rather than the one it read", async () => {
		const bucket = fakeBucket();
		const store = storeOver(bucket);
		await store.join(joinOf());

		bucket.conflicts = 2;
		const view = await store.join(joinOf({ callId: OTHER_CALL, now: NOW + 1_000 }));

		expect(view.position).toBe(2);
		// The first caller is still there: the retry did not overwrite the line with a stale copy.
		expect(view.waiting).toBe(2);
		expect(store.stats.conflicts).toBe(2);
	});

	it("gives up after repeated conflicts, with an unknown position rather than a thrown error", async () => {
		const bucket = fakeBucket();
		bucket.conflicts = 99;
		const view = await storeOver(bucket).join(joinOf());
		expect(view.position).toBe(0);
	});

	it("reports an unknown position when the broker cannot be reached", async () => {
		const bucket = fakeBucket();
		bucket.unavailable = true;
		const store = storeOver(bucket);
		expect((await store.join(joinOf())).position).toBe(0);
		expect((await store.refresh(joinOf({ joinedAt: NOW }))).position).toBe(0);
	});

	/**
	 * NOT "the queue is empty". Starting a fresh line over an unreadable record would evict every
	 * other instance's callers from their places — the one failure worse than announcing nothing.
	 */
	it("refuses to write over a record it could not read", async () => {
		const bucket = fakeBucket();
		bucket.corrupt = true;
		expect((await storeOver(bucket).join(joinOf())).position).toBe(0);
		expect(bucket.creates + bucket.updates).toBe(0);
	});

	it("reports an unknown position for an id that is not a valid key token", async () => {
		const view = await storeOver(fakeBucket()).join(joinOf({ queueId: "queue with spaces" }));
		expect(view.position).toBe(0);
	});
});

describe("leases and refreshes", () => {
	it("re-reads without writing while the lease is fresh", async () => {
		const bucket = fakeBucket();
		const store = storeOver(bucket);
		await store.join(joinOf());
		const writesBefore = bucket.creates + bucket.updates;

		const view = await store.refresh(joinOf({ joinedAt: NOW, now: NOW + 1_000 }));

		expect(view.position).toBe(1);
		expect(bucket.creates + bucket.updates).toBe(writesBefore);
	});

	it("pushes the lease forward once enough of it has passed", async () => {
		const bucket = fakeBucket();
		const store = storeOver(bucket);
		await store.join(joinOf());
		const writesBefore = bucket.creates + bucket.updates;

		await store.refresh(joinOf({ joinedAt: NOW, now: NOW + QUEUE_WAITING_RENEW_AFTER_MS + 1 }));

		expect(bucket.creates + bucket.updates).toBe(writesBefore + 1);
	});

	/**
	 * A caller whose entry lapsed — a write of ours that lost, or an instance that stalled — is put
	 * BACK with the place they had, not with the time they were noticed missing. Re-joining them at
	 * the back would punish a caller for their engine's hiccup.
	 */
	it("restores a caller whose entry lapsed, at the place they held", async () => {
		const bucket = fakeBucket();
		const store = storeOver(bucket);
		await store.join(joinOf({ callId: OTHER_CALL, now: NOW }));
		await store.join(joinOf({ now: NOW + 1_000 }));

		const later = NOW + QUEUE_WAITING_LEASE_MS + 5_000;
		// Both leases have lapsed by now; ours is renewed with its original `joinedAt`.
		const view = await store.refresh(joinOf({ joinedAt: NOW + 1_000, now: later }));

		expect(view.position).toBe(1);
		expect(view.waiting).toBe(1);
	});
});

describe("without a bucket configured", () => {
	/**
	 * A deployment with no JetStream KV is a deployment saying "one instance", and one instance's
	 * line IS the whole line — so this is not a degradation there, it is the correct answer. It is
	 * also what every spec in this package runs on.
	 */
	it("keeps a local line with the same ordering and the same counts", async () => {
		const store = storeOver(undefined);
		await store.join(joinOf({ callId: OTHER_CALL, now: NOW }));
		const view = await store.join(joinOf({ now: NOW + 1_000, priority: 900 }));

		expect(view.position).toBe(1);
		expect(view.waiting).toBe(2);
		expect(store.waitingCount).toBe(2);
	});

	it("gives a caller's place back when they leave", async () => {
		const store = storeOver(undefined);
		await store.join(joinOf());
		await store.leave({ orgId: ORG, queueId: QUEUE, callId: CALL, now: NOW + 1_000 });
		expect(store.waitingCount).toBe(0);
	});

	it("writes the resume promise and the removal in one operation", async () => {
		const store = storeOver(undefined);
		await store.join(joinOf({ callerNumber: "+15551234567" }));
		await store.leave({
			orgId: ORG,
			queueId: QUEUE,
			callId: CALL,
			now: NOW + 5_000,
			tombstone: {
				callerNumber: "+15551234567",
				joinedAt: NOW,
				priority: 0,
				abandonedAt: NOW + 5_000,
				expiresAt: NOW + 65_000,
			},
		});

		expect(store.waitingCount).toBe(0);
		const resumed = await store.join(
			joinOf({
				callId: OTHER_CALL,
				callerNumber: "+15551234567",
				now: NOW + 10_000,
				resumeAllowed: true,
			}),
		);
		expect(resumed.resumed).toBe(true);
		expect(resumed.joinedAt).toBe(NOW);
	});

	it("gives the caller their old priority back when it was higher than the new one", async () => {
		const store = storeOver(undefined);
		await store.leave({
			orgId: ORG,
			queueId: QUEUE,
			callId: CALL,
			now: NOW,
			tombstone: {
				callerNumber: "+15551234567",
				joinedAt: NOW - 60_000,
				priority: 900,
				abandonedAt: NOW,
				expiresAt: NOW + 60_000,
			},
		});
		await store.join(joinOf({ callId: OTHER_CALL, now: NOW + 1_000, priority: 500 }));
		const resumed = await store.join(
			joinOf({
				callerNumber: "+15551234567",
				now: NOW + 2_000,
				priority: 0,
				resumeAllowed: true,
			}),
		);
		expect(resumed.resumed).toBe(true);
		// Priority 900 restored, so they are ahead of the 500 who joined while they were gone.
		expect(resumed.position).toBe(1);
	});
});
