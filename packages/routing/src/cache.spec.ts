import { describe, expect, it } from "bun:test";
import {
	affectsRouting,
	canonicalizeSnapshot,
	invalidationKeysFor,
	invalidationKeysForBatch,
	isArtifactFresh,
	isRoutingEntityKind,
	ROUTING_CACHE_ARTIFACT_NAME,
	ROUTING_CACHE_BUCKET,
	ROUTING_ENTITY_KINDS,
	ROUTING_TABLE_TO_ENTITY,
	routingCacheKey,
	snapshotHash,
} from "./cache";
import { RoutingSnapshotError } from "./errors";
import { anExtension, anInboundRoute, aPhoneNumber, aSnapshot, compiled, ORG_ID } from "./fixtures";
import { emptySnapshot, SNAPSHOT_COLLECTIONS } from "./snapshot";

describe("routingCacheKey", () => {
	it("matches the shape kvKeyFor.routingCache(orgId, 'artifact') produces", () => {
		expect(routingCacheKey("0198c1f0")).toBe(`0198c1f0.${ROUTING_CACHE_ARTIFACT_NAME}`);
	});

	it("accepts a UUID, whose hyphens are legal subject-token characters", () => {
		expect(routingCacheKey("0198c1f0-2b3c-7d4e-8f90-1a2b3c4d5e6f")).toBe(
			"0198c1f0-2b3c-7d4e-8f90-1a2b3c4d5e6f.artifact",
		);
	});

	it("rejects an id containing a dot, which would forge a key segment", () => {
		expect(() => routingCacheKey("org.evil")).toThrow(RoutingSnapshotError);
	});

	it("rejects an id containing a wildcard", () => {
		expect(() => routingCacheKey("*")).toThrow(RoutingSnapshotError);
	});

	it("rejects an empty id", () => {
		expect(() => routingCacheKey("")).toThrow(RoutingSnapshotError);
	});

	it("names the bucket from packages/events", () => {
		expect(ROUTING_CACHE_BUCKET).toBe("routing-cache");
	});
});

/**
 * The invalidation contract. One artifact per organization, one key per organization — see the
 * module header for why sub-keys do not survive the destination graph.
 */
describe("invalidation contract", () => {
	it("covers every snapshot collection plus settings", () => {
		expect([...ROUTING_ENTITY_KINDS].sort()).toEqual(
			[...SNAPSHOT_COLLECTIONS, "settings" as const].sort(),
		);
	});

	it("maps every routing table to an entity kind that exists", () => {
		for (const kind of Object.values(ROUTING_TABLE_TO_ENTITY)) {
			expect(isRoutingEntityKind(kind)).toBe(true);
		}
	});

	it("maps every entity kind from at least one table", () => {
		const mapped = new Set(Object.values(ROUTING_TABLE_TO_ENTITY));
		for (const kind of ROUTING_ENTITY_KINDS) {
			expect(mapped.has(kind)).toBe(true);
		}
	});

	it("recognises a routing table", () => {
		expect(affectsRouting("ivr_menu_option")).toBe(true);
	});

	it("ignores a table routing does not read", () => {
		// A voicemail message, a CDR row or an agent status change must not evict a hot artifact.
		expect(affectsRouting("voicemail_message")).toBe(false);
		expect(affectsRouting("call_legs")).toBe(false);
		expect(affectsRouting("queue_agent")).toBe(false);
	});

	it("invalidates the organization's one key for a routing mutation", () => {
		expect(
			invalidationKeysFor({ organizationId: ORG_ID, table: "extension", operation: "update" }),
		).toEqual([`${ORG_ID}.artifact`]);
	});

	it("invalidates the same key whichever routing table changed", () => {
		const keys = new Set(
			Object.keys(ROUTING_TABLE_TO_ENTITY).map(
				(table) =>
					invalidationKeysFor({ organizationId: ORG_ID, table, operation: "update" })[0] as string,
			),
		);
		expect([...keys]).toEqual([`${ORG_ID}.artifact`]);
	});

	it("invalidates nothing for a non-routing mutation", () => {
		expect(
			invalidationKeysFor({ organizationId: ORG_ID, table: "cdr", operation: "insert" }),
		).toEqual([]);
	});

	it("is indifferent to the operation", () => {
		for (const operation of ["insert", "update", "delete"] as const) {
			expect(
				invalidationKeysFor({ organizationId: ORG_ID, table: "trunk", operation }),
			).toHaveLength(1);
		}
	});

	it("collapses a transaction's mutations to one key", () => {
		expect(
			invalidationKeysForBatch([
				{ organizationId: ORG_ID, table: "extension", operation: "update" },
				{ organizationId: ORG_ID, table: "ring_group_destination", operation: "insert" },
				{ organizationId: ORG_ID, table: "voicemail_message", operation: "insert" },
			]),
		).toEqual([`${ORG_ID}.artifact`]);
	});

	it("keeps one key per organization in a cross-tenant batch", () => {
		expect(
			invalidationKeysForBatch([
				{ organizationId: "org-b", table: "extension", operation: "update" },
				{ organizationId: "org-a", table: "extension", operation: "update" },
			]),
		).toEqual(["org-a.artifact", "org-b.artifact"]);
	});

	it("returns nothing for an empty batch", () => {
		expect(invalidationKeysForBatch([])).toEqual([]);
	});
});

describe("canonicalizeSnapshot", () => {
	const snapshot = aSnapshot({
		extensions: [anExtension(), anExtension({ id: "ext-2", number: "1002" })],
		phoneNumbers: [aPhoneNumber()],
	});

	it("is independent of row order", () => {
		const reversed = aSnapshot({ ...snapshot, extensions: [...snapshot.extensions].reverse() });
		expect(canonicalizeSnapshot(reversed)).toBe(canonicalizeSnapshot(snapshot));
	});

	it("is independent of object-key order within a row", () => {
		const shuffled = aSnapshot({
			...snapshot,
			extensions: snapshot.extensions.map(
				(extension) =>
					// Rebuild each row with its keys in reverse order; canonical form must not notice.
					Object.fromEntries(
						Object.entries(extension).reverse(),
					) as unknown as (typeof snapshot.extensions)[number],
			),
		});
		expect(canonicalizeSnapshot(shuffled)).toBe(canonicalizeSnapshot(snapshot));
	});

	it("includes every collection, even the empty ones", () => {
		const canonical = canonicalizeSnapshot(emptySnapshot(ORG_ID));
		for (const collection of SNAPSHOT_COLLECTIONS) {
			expect(canonical).toContain(`"${collection}"`);
		}
	});

	it("distinguishes absent settings from present ones", () => {
		expect(canonicalizeSnapshot(aSnapshot({ settings: {} }))).not.toBe(
			canonicalizeSnapshot(aSnapshot()),
		);
	});
});

describe("snapshotHash", () => {
	const snapshot = aSnapshot({ extensions: [anExtension()] });

	it("is a 64-character hex digest", () => {
		expect(snapshotHash(snapshot)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is stable for the same content", () => {
		expect(snapshotHash(snapshot)).toBe(snapshotHash(aSnapshot({ extensions: [anExtension()] })));
	});

	it("moves when a routing-relevant field changes", () => {
		expect(snapshotHash(snapshot)).not.toBe(
			snapshotHash(aSnapshot({ extensions: [anExtension({ tollClass: "premium" })] })),
		);
	});

	it("moves when a row is added", () => {
		expect(snapshotHash(snapshot)).not.toBe(
			snapshotHash(
				aSnapshot({ extensions: [anExtension(), anExtension({ id: "ext-2", number: "1002" })] }),
			),
		);
	});

	it("moves when a row is removed", () => {
		expect(snapshotHash(snapshot)).not.toBe(snapshotHash(emptySnapshot(ORG_ID)));
	});

	it("differs between organizations with identical configuration", () => {
		expect(snapshotHash(snapshot)).not.toBe(
			snapshotHash({ ...snapshot, organizationId: "org-0002" }),
		);
	});

	it("does not move when a loader reorders its rows", () => {
		const rows = [anExtension(), anExtension({ id: "ext-2", number: "1002" })];
		expect(snapshotHash(aSnapshot({ extensions: rows }))).toBe(
			snapshotHash(aSnapshot({ extensions: [...rows].reverse() })),
		);
	});
});

describe("isArtifactFresh", () => {
	const snapshot = aSnapshot({
		extensions: [anExtension()],
		phoneNumbers: [aPhoneNumber()],
		inboundRoutes: [anInboundRoute()],
	});

	it("says a just-compiled artifact is fresh", () => {
		expect(isArtifactFresh(compiled(snapshot), snapshot)).toBe(true);
	});

	it("says an artifact is stale once the configuration changes", () => {
		const artifact = compiled(snapshot);
		const changed = aSnapshot({
			...snapshot,
			inboundRoutes: [anInboundRoute({ priority: 50 })],
		});
		expect(isArtifactFresh(artifact, changed)).toBe(false);
	});

	it("says an artifact from another organization is never fresh", () => {
		expect(isArtifactFresh(compiled(snapshot), { ...snapshot, organizationId: "org-0002" })).toBe(
			false,
		);
	});

	it("lets a redundant recompile be skipped", () => {
		// A save that changes nothing routing reads must not churn the cache.
		const artifact = compiled(snapshot);
		expect(isArtifactFresh(artifact, { ...snapshot })).toBe(true);
	});
});
