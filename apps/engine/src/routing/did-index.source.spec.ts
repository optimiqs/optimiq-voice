import { describe, expect, it } from "bun:test";
import { kvKeyFor } from "@optimiq-voice/events";
import { DidIndexSource } from "./did-index.source";
import type { JetStreamService } from "../nats/jetstream.service";

/**
 * The DID → organization lookup.
 *
 * This is the decision that decides which TENANT a call belongs to, so the cases below are mostly
 * about refusing: an entry that is unreadable, an entry whose organization id is not an entity id,
 * a bucket that is not there. Every one of them answers `undefined`, which the orchestrator turns
 * into `INVALID_PROFILE` — a rejected call the carrier can fail over is a better outcome than a
 * call answered on behalf of a tenant nobody verified.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const DID = "+12125550100";

interface FakeBucketOptions {
	readonly entries?: Record<string, unknown>;
	/** Keys whose `get` throws, standing in for a broker that went away mid-call. */
	readonly failing?: readonly string[];
	/** Raw bytes for a key, for the "unparseable value" case. */
	readonly raw?: Record<string, string>;
}

function fakeJetStream(options: FakeBucketOptions | undefined): {
	readonly service: JetStreamService;
	readonly reads: string[];
} {
	const reads: string[] = [];
	if (options === undefined) {
		return {
			service: {
				didIndex: undefined,
				didIndexKey: (did: string) => kvKeyFor.didIndex(did),
			} as unknown as JetStreamService,
			reads,
		};
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
	};

	return {
		service: {
			didIndex: bucket,
			didIndexKey: (did: string) => kvKeyFor.didIndex(did),
		} as unknown as JetStreamService,
		reads,
	};
}

function sourceWith(options: FakeBucketOptions | undefined): {
	readonly source: DidIndexSource;
	readonly reads: string[];
} {
	const { service, reads } = fakeJetStream(options);
	return { source: new DidIndexSource(service), reads };
}

describe("DidIndexSource", () => {
	it("resolves the organization that owns a dialled number", async () => {
		const { source } = sourceWith({
			entries: {
				[kvKeyFor.didIndex(DID)]: {
					organizationId: ORG,
					phoneNumberId: "0195c0f0-1c2f-7000-8000-0000000000f1",
					e164: DID,
					enabled: true,
				},
			},
		});

		expect(await source.organizationFor(DID)).toEqual({
			organizationId: ORG,
			phoneNumberId: "0195c0f0-1c2f-7000-8000-0000000000f1",
			e164: DID,
			enabled: true,
		});
	});

	/**
	 * The normalisation that makes the index usable at all: the control plane stores `+12125550100`
	 * and a carrier may deliver any of these. One key, or the whole thing is a lookup that works on
	 * a developer box and misses in production.
	 */
	it.each(["+12125550100", "12125550100", "+1 (212) 555-0100", "1-212-555-0100"])(
		"finds the same entry for %s",
		async (dialled) => {
			const { source } = sourceWith({
				entries: { [kvKeyFor.didIndex(DID)]: { organizationId: ORG, enabled: true } },
			});
			expect((await source.organizationFor(dialled))?.organizationId).toBe(ORG);
		},
	);

	it("reports a miss for a number nobody has provisioned", async () => {
		const { source } = sourceWith({ entries: {} });
		expect(await source.organizationFor("+19998887777")).toBeUndefined();
		expect(source.stats).toMatchObject({ lookups: 1, hits: 0, misses: 1 });
	});

	it("reads the bucket every time, never a cache", async () => {
		// A stale DID→org mapping attributes a call to the wrong tenant, which is a billing error and
		// an isolation breach at once. One KV round trip is the price of not having one.
		const { source, reads } = sourceWith({
			entries: { [kvKeyFor.didIndex(DID)]: { organizationId: ORG, enabled: true } },
		});

		await source.organizationFor(DID);
		await source.organizationFor(DID);

		expect(reads).toHaveLength(2);
	});

	it("treats a dialled string with no digits as not-a-DID rather than an error", async () => {
		const { source, reads } = sourceWith({ entries: {} });
		expect(await source.organizationFor("operator")).toBeUndefined();
		// Not even attempted: there is no key such a value could occupy.
		expect(reads).toEqual([]);
		expect(source.stats.lookups).toBe(0);
	});

	it.each([undefined, "", "   "])(
		"answers undefined for %p without touching the bucket",
		async (value) => {
			const { source, reads } = sourceWith({ entries: {} });
			expect(await source.organizationFor(value)).toBeUndefined();
			expect(reads).toEqual([]);
		},
	);

	it("refuses an entry whose organizationId is not an entity id", async () => {
		// The bucket is writable by an operator with `nats kv put`. "It was in the KV" is not, on its
		// own, grounds to bill somebody.
		const { source } = sourceWith({
			entries: { [kvKeyFor.didIndex(DID)]: { organizationId: "acme-corp", enabled: true } },
		});
		expect(await source.organizationFor(DID)).toBeUndefined();
	});

	it("refuses an entry that is not JSON", async () => {
		const { source } = sourceWith({ raw: { [kvKeyFor.didIndex(DID)]: "{not json" } });
		expect(await source.organizationFor(DID)).toBeUndefined();
	});

	it("answers undefined when the broker is unreachable, rather than throwing into StasisStart", async () => {
		// This runs inside a WebSocket callback: an exception here is an unhandled rejection that
		// takes every other live call down with it.
		const { source } = sourceWith({ failing: [kvKeyFor.didIndex(DID)] });
		expect(await source.organizationFor(DID)).toBeUndefined();
	});

	it("answers undefined when there is no bucket at all", async () => {
		const { source } = sourceWith(undefined);
		expect(await source.organizationFor(DID)).toBeUndefined();
	});

	/**
	 * A disabled number still belongs to its tenant. Attributing the call and letting that tenant's
	 * own routing reject it is what puts the rejection in the right CDR; treating it as unallocated
	 * here would file it nowhere.
	 */
	it("still attributes a disabled number, and says it is disabled", async () => {
		const { source } = sourceWith({
			entries: { [kvKeyFor.didIndex(DID)]: { organizationId: ORG, enabled: false } },
		});

		const hit = await source.organizationFor(DID);
		expect(hit?.organizationId).toBe(ORG);
		expect(hit?.enabled).toBe(false);
	});
});
