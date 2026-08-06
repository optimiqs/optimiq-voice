import { describe, expect, it } from "bun:test";
import { kvKeyFor } from "@optimiq-voice/events";
import { QueueMembershipSource } from "./queue-membership.source";
import { fakeAgent, fakeMembership } from "./queue-services.fake";
import type { JetStreamService } from "../nats/jetstream.service";
import type { QueueMembership } from "@optimiq-voice/events";

/**
 * The roster read.
 *
 * Mostly about REFUSING, like the DID index it is modelled on: an entry that fails its schema, an
 * entry filed under another queue's key, a bucket that is not there. Every one answers `undefined`,
 * and the session turns that into "the caller cannot be distributed" — deliberately distinct from
 * "this queue has no agents", because only one of those is fixed by telling people to log in.
 *
 * The cache is asserted through the read COUNT rather than through an internal, because "does a
 * second caller to the same queue hit KV again" is the whole reason this class exists.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const QUEUE = "0195c0f0-1c2f-7000-8000-0000000000a1";
const OTHER_QUEUE = "0195c0f0-1c2f-7000-8000-0000000000a2";

interface FakeBucketOptions {
	readonly entries?: Record<string, unknown>;
	readonly raw?: Record<string, string>;
	readonly failing?: readonly string[];
}

function fakeJetStream(options: FakeBucketOptions | undefined): {
	readonly service: JetStreamService;
	readonly reads: string[];
} {
	const reads: string[] = [];
	if (options === undefined) {
		return { service: { queueMembership: undefined } as unknown as JetStreamService, reads };
	}

	const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
	const bucket = {
		get: async (key: string) => {
			reads.push(key);
			if (options.failing?.includes(key) === true) {
				throw new Error("broker unreachable");
			}
			const raw = options.raw?.[key];
			if (raw !== undefined) {
				return { value: encode(raw) };
			}
			const entry = options.entries?.[key];
			if (entry === undefined) {
				return null;
			}
			return { value: encode(JSON.stringify(entry)) };
		},
		// The source's watch loop iterates this; a watch that never yields keeps it parked, which is
		// what a spec about READS wants.
		watch: async () => ({
			stop: () => undefined,
			[Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
		}),
	};

	return { service: { queueMembership: bucket } as unknown as JetStreamService, reads };
}

function sourceOver(options: FakeBucketOptions | undefined): {
	readonly source: QueueMembershipSource;
	readonly reads: string[];
} {
	const { service, reads } = fakeJetStream(options);
	return { source: new QueueMembershipSource(service), reads };
}

const ROSTER: QueueMembership = fakeMembership(ORG, QUEUE, [fakeAgent(ORG.replace("1", "9"))]);
const KEY = kvKeyFor.queueMembership(ORG, QUEUE);

describe("reading a roster", () => {
	it("returns the queue's agents", async () => {
		const { source } = sourceOver({ entries: { [KEY]: ROSTER } });
		const membership = await source.membershipFor(ORG, QUEUE);
		expect(membership?.agents).toHaveLength(1);
		expect(membership?.queueId).toBe(QUEUE);
	});

	it("caches, so a second caller to the same queue does not hit KV", async () => {
		const { source, reads } = sourceOver({ entries: { [KEY]: ROSTER } });
		await source.membershipFor(ORG, QUEUE);
		await source.membershipFor(ORG, QUEUE);
		expect(reads).toHaveLength(1);
		expect(source.stats.hits).toBe(1);
	});

	it("de-duplicates concurrent misses: twenty callers to a cold queue read once", async () => {
		const { source, reads } = sourceOver({ entries: { [KEY]: ROSTER } });
		await Promise.all(Array.from({ length: 20 }, async () => source.membershipFor(ORG, QUEUE)));
		expect(reads).toHaveLength(1);
	});

	it("re-reads after an invalidation", async () => {
		const { source, reads } = sourceOver({ entries: { [KEY]: ROSTER } });
		await source.membershipFor(ORG, QUEUE);
		source.invalidateAll();
		await source.membershipFor(ORG, QUEUE);
		expect(reads).toHaveLength(2);
	});
});

describe("refusing a roster", () => {
	it("answers undefined for a queue with no entry", async () => {
		const { source } = sourceOver({ entries: {} });
		expect(await source.membershipFor(ORG, QUEUE)).toBeUndefined();
		expect(source.stats.misses).toBe(1);
	});

	it("answers undefined when the bucket is not open", async () => {
		const { source } = sourceOver(undefined);
		expect(await source.membershipFor(ORG, QUEUE)).toBeUndefined();
	});

	it("answers undefined when the broker refuses the read, rather than throwing on a live call", async () => {
		const { source } = sourceOver({ entries: { [KEY]: ROSTER }, failing: [KEY] });
		expect(await source.membershipFor(ORG, QUEUE)).toBeUndefined();
	});

	it("discards an entry that is not JSON", async () => {
		const { source } = sourceOver({ raw: { [KEY]: "not json" } });
		expect(await source.membershipFor(ORG, QUEUE)).toBeUndefined();
	});

	it("discards an entry that fails the schema", async () => {
		const { source } = sourceOver({ entries: { [KEY]: { orgId: ORG, queueId: QUEUE } } });
		expect(await source.membershipFor(ORG, QUEUE)).toBeUndefined();
	});

	it("refuses a roster filed under another queue's key", async () => {
		const foreign = fakeMembership(ORG, OTHER_QUEUE, [fakeAgent("x")]);
		const { source } = sourceOver({ entries: { [KEY]: foreign } });
		expect(await source.membershipFor(ORG, QUEUE)).toBeUndefined();
	});

	it("refuses a roster belonging to another tenant", async () => {
		const foreign = fakeMembership("0195c0f0-1c2f-7000-8000-000000000002", QUEUE, [fakeAgent("x")]);
		const { source } = sourceOver({ entries: { [KEY]: foreign } });
		expect(await source.membershipFor(ORG, QUEUE)).toBeUndefined();
	});

	it("answers undefined for an id that could never have been a key", async () => {
		const { source, reads } = sourceOver({ entries: {} });
		expect(await source.membershipFor(ORG, "queue with spaces")).toBeUndefined();
		expect(reads).toEqual([]);
	});
});

describe("shutdown", () => {
	it("drops every cached roster", async () => {
		const { source } = sourceOver({ entries: { [KEY]: ROSTER } });
		await source.membershipFor(ORG, QUEUE);
		expect(source.stats.cached).toBe(1);
		await source.onApplicationShutdown();
		expect(source.stats.cached).toBe(0);
	});
});
