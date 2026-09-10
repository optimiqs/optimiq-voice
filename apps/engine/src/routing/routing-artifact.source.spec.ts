import { afterEach, describe, expect, it } from "bun:test";
import { of, throwError } from "rxjs";
import { ROUTING_ARTIFACT_VERSION, routingCacheKey } from "@optimiq-voice/routing";
import { RoutingArtifactSource } from "./routing-artifact.source";
import type { EngineEnv } from "../config/engine-env";
import type { JetStreamService } from "../nats/jetstream.service";
import type { ClientProxy } from "@nestjs/microservices";
import type { RoutingArtifact } from "@optimiq-voice/routing";

/**
 * Artifact-source specs.
 *
 * The three layers — memory, KV, RPC — are exercised against a fake KV bucket and a fake
 * `ClientProxy`, so the ORDER of the layers and the invalidation rule are provable without a
 * broker. The live path is covered by the gated integration suite.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const OTHER_ORG = "0195c0f0-1c2f-7000-8000-000000000002";

function artifact(organizationId = ORG, snapshotHash = "hash-1"): RoutingArtifact {
	return {
		artifactVersion: ROUTING_ARTIFACT_VERSION,
		organizationId,
		snapshotHash,
		compiledAt: "2026-08-05T12:00:00.000Z",
		settings: {},
		nodes: {},
		timeConditions: {},
		inbound: { rules: [], didDefaults: {}, noMatchNodeId: "hangup:UNALLOCATED_NUMBER" },
		internal: {
			featureCodes: [],
			voicemailPrefixes: [],
			numbers: {},
			mailboxes: {},
			parkSlots: [],
			noMatchNodeId: "hangup:UNALLOCATED_NUMBER",
		},
		outbound: {
			enabled: true,
			rules: [],
			noMatchNodeId: "hangup:UNALLOCATED_NUMBER",
			deniedNodeId: "hangup:OUTGOING_CALL_BARRED",
		},
		callBlock: [],
		extensionsByNumber: {},
		diagnostics: [],
	} as unknown as RoutingArtifact;
}

function encode(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

interface WatchEntry {
	readonly key: string;
	readonly operation: string;
	readonly value: Uint8Array;
	readonly revision?: number;
}

/** A KV bucket whose `get` is a map and whose `watch` is a queue the spec pushes into. */
function fakeBucket(seed: Record<string, unknown> = {}) {
	const store = new Map<string, Uint8Array>(
		Object.entries(seed).map(([key, value]) => [key, encode(value)]),
	);
	const pending: WatchEntry[] = [];
	let notify: (() => void) | undefined;
	let stopped = false;
	let gets = 0;
	// The bucket's own last revision, which is what the stale guard compares the watch against.
	let lastSeq = 0;
	let watches = 0;

	const bucket = {
		get: async (key: string) => {
			gets += 1;
			const value = store.get(key);
			return value === undefined ? null : { key, value, operation: "PUT" };
		},
		status: async () => ({ streamInfo: { state: { last_seq: lastSeq } } }),
		watch: async () => {
			watches += 1;
			stopped = false;
			return {
				stop: () => {
					stopped = true;
					notify?.();
				},
				async *[Symbol.asyncIterator](): AsyncIterator<WatchEntry> {
					while (!stopped) {
						const next = pending.shift();
						if (next !== undefined) {
							yield next;
							continue;
						}
						await new Promise<void>((resolve) => {
							notify = resolve;
						});
					}
				},
			};
		},
	};

	return {
		bucket,
		gets: () => gets,
		watches: () => watches,
		push: (entry: WatchEntry) => {
			pending.push(entry);
			if (entry.revision !== undefined && entry.revision > lastSeq) {
				lastSeq = entry.revision;
			}
			notify?.();
		},
		/** A write the watch is NOT told about — the shape a stalled watch produces. */
		advanceBucket: (revision: number) => {
			lastSeq = revision;
		},
		put: (key: string, value: unknown) => {
			store.set(key, encode(value));
		},
		remove: (key: string) => {
			store.delete(key);
		},
	};
}

function env(overrides: Partial<EngineEnv> = {}): EngineEnv {
	return {
		ENGINE_ROUTING_RPC_TIMEOUT_MS: 500,
		ENGINE_ROUTING_WATCH_PROBE_MS: 25,
		...overrides,
	} as EngineEnv;
}

interface HarnessOptions {
	readonly seed?: Record<string, unknown>;
	readonly rpcReply?: unknown;
	readonly rpcFails?: boolean;
	readonly noBucket?: boolean;
}

const sources: RoutingArtifactSource[] = [];

function harness(options: HarnessOptions = {}) {
	const kv = fakeBucket(options.seed);
	const sent: { subject: string; payload: unknown }[] = [];
	const client = {
		send: (subject: string, payload: unknown) => {
			sent.push({ subject, payload });
			return options.rpcFails === true
				? throwError(() => new Error("no responder"))
				: of(options.rpcReply ?? { matched: true, artifact: artifact() });
		},
	} as unknown as ClientProxy;

	const jetstream = {
		get routingCache() {
			return options.noBucket === true ? undefined : kv.bucket;
		},
	} as unknown as JetStreamService;

	const source = new RoutingArtifactSource(env(), client, jetstream);
	sources.push(source);
	return { source, kv, sent };
}

afterEach(async () => {
	// The watch loop is a detached `while` — every source has to be told to stop, or the process
	// keeps a live iterator per spec.
	await Promise.all(sources.splice(0).map((source) => source.onApplicationShutdown()));
});

describe("layer order", () => {
	it("reads the KV bucket on a miss", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact() } });
		const found = await h.source.get(ORG);

		expect(found?.organizationId).toBe(ORG);
		expect(h.sent).toEqual([]);
		expect(h.source.stats.kvReads).toBe(1);
	});

	it("serves the SECOND call from memory, not from the broker", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact() } });
		await h.source.get(ORG);
		await h.source.get(ORG);

		expect(h.kv.gets()).toBe(1);
		expect(h.source.stats.hits).toBe(1);
	});

	it("de-duplicates concurrent misses into one load", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact() } });
		await Promise.all([h.source.get(ORG), h.source.get(ORG), h.source.get(ORG)]);
		expect(h.kv.gets()).toBe(1);
	});

	it("falls back to rpc.routing.v1.resolve when the bucket has nothing", async () => {
		const h = harness();
		const found = await h.source.get(ORG);

		expect(found?.organizationId).toBe(ORG);
		expect(h.sent[0]?.subject).toBe("rpc.routing.v1.resolve");
		expect(h.sent[0]?.payload).toMatchObject({ orgId: ORG, routingContext: "inbound" });
	});

	it("caches what the rpc returned, so the next call costs nothing", async () => {
		const h = harness();
		await h.source.get(ORG);
		await h.source.get(ORG);
		expect(h.sent).toHaveLength(1);
	});

	it("uses the rpc when there is no KV bucket at all", async () => {
		const h = harness({ noBucket: true });
		expect(await h.source.get(ORG)).toBeDefined();
		expect(h.sent).toHaveLength(1);
	});
});

describe("the version and tenancy guards", () => {
	it("DISCARDS a cached artifact from a version this release cannot read", async () => {
		const h = harness({
			seed: { [routingCacheKey(ORG)]: { ...artifact(), artifactVersion: 999 } },
		});
		const found = await h.source.get(ORG);

		// Discarded, then recompiled over the rpc — never walked best-effort.
		expect(found?.organizationId).toBe(ORG);
		expect(h.sent).toHaveLength(1);
	});

	it("discards an entry that is not an artifact at all", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: { hello: "world" } } });
		await h.source.get(ORG);
		expect(h.sent).toHaveLength(1);
	});

	it("REFUSES an artifact filed under another organization's key", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact(OTHER_ORG) } });
		await h.source.get(ORG);
		// Falls through to the rpc rather than routing one tenant's call with another's config.
		expect(h.sent).toHaveLength(1);
	});

	it("refuses an rpc reply compiled for another organization", async () => {
		const h = harness({ rpcReply: { matched: true, artifact: artifact(OTHER_ORG) } });
		expect(await h.source.get(ORG)).toBeUndefined();
	});

	it("refuses an rpc reply whose artifact this release cannot read", async () => {
		const h = harness({
			rpcReply: { matched: true, artifact: { ...artifact(), artifactVersion: 999 } },
		});
		expect(await h.source.get(ORG)).toBeUndefined();
	});

	it("returns undefined — never a guess — when the rpc has no responder", async () => {
		const h = harness({ rpcFails: true });
		expect(await h.source.get(ORG)).toBeUndefined();
	});

	it("returns undefined when the rpc answers without an artifact", async () => {
		const h = harness({ rpcReply: { matched: false, reason: "no configuration" } });
		expect(await h.source.get(ORG)).toBeUndefined();
	});
});

describe("invalidation", () => {
	it("drops one organization on demand", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact() } });
		await h.source.get(ORG);
		h.source.invalidate(ORG);

		await h.source.get(ORG);
		expect(h.kv.gets()).toBe(2);
		expect(h.source.stats.invalidations).toBe(1);
	});

	it("drops everything when this process stops being told about changes", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact() } });
		await h.source.get(ORG);
		h.source.invalidateAll();
		expect(h.source.stats.cached).toBe(0);
	});

	it("REPLACES the memory copy when the API publishes a new artifact", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact(ORG, "hash-1") } });
		await h.source.onModuleInit();
		await h.source.get(ORG);

		h.kv.push({
			key: routingCacheKey(ORG),
			operation: "PUT",
			value: encode(artifact(ORG, "hash-2")),
		});
		await settle();

		const found = await h.source.get(ORG);
		expect(found?.snapshotHash).toBe("hash-2");
		// Served from memory: the watch replaced it rather than merely evicting it.
		expect(h.kv.gets()).toBe(1);
	});

	it("keeps the existing entry when a recompile produced the SAME content hash", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact(ORG, "hash-1") } });
		await h.source.onModuleInit();
		await h.source.get(ORG);
		const before = h.source.stats.invalidations;

		h.kv.push({
			key: routingCacheKey(ORG),
			operation: "PUT",
			value: encode(artifact(ORG, "hash-1")),
		});
		await settle();

		expect(h.source.stats.invalidations).toBe(before);
	});

	it("evicts on a delete, so the next call recompiles", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact() } });
		await h.source.onModuleInit();
		await h.source.get(ORG);

		h.kv.remove(routingCacheKey(ORG));
		h.kv.push({ key: routingCacheKey(ORG), operation: "DEL", value: new Uint8Array() });
		await settle();

		await h.source.get(ORG);
		expect(h.sent).toHaveLength(1);
	});

	it("evicts when the published artifact cannot be read", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact() } });
		await h.source.onModuleInit();
		await h.source.get(ORG);

		h.kv.push({
			key: routingCacheKey(ORG),
			operation: "PUT",
			value: encode({ artifactVersion: 999 }),
		});
		await settle();

		expect(h.source.stats.cached).toBe(0);
	});

	/**
	 * The failure this closes was found end to end: the API restarted, re-made the KV bucket, and
	 * this process's watch iterator went on existing while delivering nothing. No error means no
	 * reconnect, so `invalidateAll` never ran and every plan published afterwards was compiled,
	 * stored, and never seen — calls walked the deleted plan for as long as the process lived.
	 */
	it("stops trusting a memory copy once the watch has gone silent", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact(ORG, "hash-1") } });
		await h.source.onModuleInit();
		await settle();
		await h.source.get(ORG);
		expect(h.kv.gets()).toBe(1);

		// The API published while the watch was deaf, so nothing arrived on it.
		h.kv.put(routingCacheKey(ORG), artifact(ORG, "hash-2"));
		const realNow = Date.now;
		Date.now = () => realNow() + 120_000;
		try {
			const found = await h.source.get(ORG);
			expect(found?.snapshotHash).toBe("hash-2");
			expect(h.kv.gets()).toBe(2);
		} finally {
			Date.now = realNow;
		}
	});

	it("reports that it is watching once the bucket is open", async () => {
		const h = harness();
		await h.source.onModuleInit();
		await settle();
		expect(h.source.stats.watching).toBe(true);
	});
});

describe("findTrunkEndpoint", () => {
	const TRUNK = "0195c0f0-1c2f-7000-8000-0000000000b1";
	const trunkNodes = {
		"trunk-dial:route-1": {
			id: "trunk-dial:route-1",
			kind: "trunk-dial",
			outboundRouteId: "route-1",
			tollClass: "national",
			attempts: [
				{
					trunkId: TRUNK,
					name: "carrier-a",
					kind: "register",
					sipDomain: "sip.carrier-a.example",
					sipProxy: "sip.carrier-a.example",
					transport: "udp",
					order: 1,
				},
			],
			continueOnCauses: [],
			recordEnabled: false,
		},
	};

	it("resolves a PJSIP endpoint name to the trunk row the artifact's attempts carry", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: { ...artifact(), nodes: trunkNodes } } });
		await h.source.get(ORG);

		expect(h.source.findTrunkEndpoint("carrier-a")).toEqual({
			organizationId: ORG,
			trunkId: TRUNK,
		});
	});

	it("answers undefined for an unknown endpoint without touching KV or the resolve rpc", async () => {
		// Memory only, by contract: a qualify tick must never become a KV read or a compile.
		const h = harness({ seed: { [routingCacheKey(ORG)]: { ...artifact(), nodes: trunkNodes } } });
		await h.source.get(ORG);
		const kvReadsBefore = h.kv.gets();

		expect(h.source.findTrunkEndpoint("carrier-z")).toBeUndefined();
		expect(h.kv.gets()).toBe(kvReadsBefore);
		expect(h.sent).toHaveLength(0);
	});
});

/** Lets the detached watch loop run. */
async function settle(): Promise<void> {
	for (let index = 0; index < 8; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

/**
 * The stalled-watch guard.
 *
 * A `kv.watch()` can stop delivering while staying open and erroring nothing — the broker refuses
 * the flow-control reply and simply stops pushing (see the class note, and
 * `routing-watch-stall.spec.ts` for the same thing against a real broker). Nothing inside the
 * client can see that, so the guard compares the bucket's own last revision against the highest
 * one the watch delivered, and re-establishes the watch when the bucket has moved on without it.
 */
describe("a watch that stalls without ending", () => {
	it("re-establishes the watch when the bucket has moved past it", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact() } });
		await h.source.onModuleInit();
		h.kv.push({
			key: routingCacheKey(ORG),
			operation: "PUT",
			value: encode(artifact()),
			revision: 4,
		});
		await settle();
		expect(h.kv.watches()).toBe(1);

		// A write the watch never sees: the bucket's revision advances, its delivery does not.
		h.kv.advanceBucket(9);
		await stale();

		expect(h.kv.watches()).toBeGreaterThan(1);
		expect(h.source.stats.staleRecoveries).toBe(1);
	});

	it("drops every memory copy when it recovers, so nothing unverified is served", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact() } });
		await h.source.onModuleInit();
		await h.source.get(ORG);
		expect(h.source.stats.cached).toBe(1);

		h.kv.advanceBucket(9);
		await stale();

		expect(h.source.stats.cached).toBe(0);
	});

	it("leaves a quiet bucket alone, however long it stays quiet", async () => {
		// The distinction the whole guard exists for: a tenant nobody is configuring produces the
		// same silence a wedged iterator does, and must not cost a watch re-create every probe.
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact() } });
		await h.source.onModuleInit();
		h.kv.push({
			key: routingCacheKey(ORG),
			operation: "PUT",
			value: encode(artifact()),
			revision: 4,
		});
		await stale();

		expect(h.kv.watches()).toBe(1);
		expect(h.source.stats.staleRecoveries).toBe(0);
	});

	it("needs two consecutive probes, so a write still in flight is not a stall", async () => {
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact() } });
		await h.source.onModuleInit();
		await settle();
		h.kv.advanceBucket(9);
		// One probe's worth of time, then the entry lands: the gap closes and no strike survives.
		await new Promise((resolve) => setTimeout(resolve, 30));
		h.kv.push({
			key: routingCacheKey(ORG),
			operation: "PUT",
			value: encode(artifact()),
			revision: 9,
		});
		await stale();

		expect(h.source.stats.staleRecoveries).toBe(0);
		expect(h.kv.watches()).toBe(1);
	});

	it("re-establishes ONCE for a revision no watch can reach", async () => {
		// A bucket whose newest revision belongs to a compacted-away write is a permanent gap. It
		// costs one recovery to find that out; it must not cost one every probe for ever.
		const h = harness({ seed: { [routingCacheKey(ORG)]: artifact() } });
		await h.source.onModuleInit();
		await settle();
		h.kv.advanceBucket(9);
		await stale();
		await stale();
		await stale();

		expect(h.source.stats.staleRecoveries).toBe(1);
	});
});

/**
 * Lets the stale guard strike twice AND lets the watch loop finish its reconnect backoff, which is
 * 250 ms on the first attempt — a recovery is not observable as a new watch until that has elapsed.
 */
async function stale(): Promise<void> {
	for (let index = 0; index < 20; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
