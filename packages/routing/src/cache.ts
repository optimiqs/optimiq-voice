/**
 * The cache-invalidation contract.
 *
 * `plans/reference/fusionpbx-inventory.md` §7 names this the single most load-bearing integration
 * behaviour in the system, and §5 item 1 describes how upstream does it: PHP deletes memcached keys
 * on every save, by convention, at 73 call sites. Convention is exactly the wrong mechanism for a
 * behaviour whose failure mode is "the PBX quietly routes calls with yesterday's configuration".
 *
 * So the contract here is small enough to state completely:
 *
 * 1. **One artifact per organization, one key per organization.**
 *    `routingCacheKey(orgId)` → `"<orgId>.artifact"`, stored in the `routing-cache` KV bucket.
 * 2. **Any mutation to any entity in `SNAPSHOT_COLLECTIONS` invalidates that one key.**
 *    `invalidationKeysFor(change)` returns it, or nothing if the entity is not a routing input.
 * 3. **Freshness is proved by content, not by trust.** The artifact carries `snapshotHash`, the
 *    SHA-256 of its canonical input. A reader that already has a snapshot can compare hashes; a
 *    writer that recompiles to the same hash can skip the write entirely.
 *
 * # Why not finer-grained keys
 *
 * The obvious refinement — `<orgId>.inbound`, `<orgId>.outbound`, `<orgId>.internal`, invalidated
 * independently — does not survive contact with the destination graph. An extension is a ring
 * group member, a ring group is an IVR option's target, an IVR is a DID's destination, and an
 * outbound route's failover destination can be any of them. Editing one extension's
 * "forward on busy" therefore changes nodes reachable from all three tables. Sub-keys would either
 * be invalidated together on every write (identical behaviour, three times the bookkeeping) or be
 * invalidated selectively and be wrong.
 *
 * The refinement that *does* pay is the other axis: knowing which mutations are routing inputs at
 * all. A voicemail *message*, a CDR row, an agent status change and a device provisioning edit are
 * not, and `affectsRouting` says so, so the API does not evict a hot artifact on every voicemail.
 *
 * # Alignment with `packages/events`
 *
 * `ROUTING_CACHE_KV` and `kvKeyFor.routingCache(orgId, artifact, discriminator?)` already exist
 * there. This module produces exactly the key that builder produces for
 * `kvKeyFor.routingCache(orgId, "artifact")` — the format is asserted in `cache.spec.ts` against
 * the same token rule — but does not import it: `@optimiq-voice/events` depends on `nats` and
 * `zod`, and dragging a broker client into the pure compiler would defeat the purpose of both.
 */

import { canonicalJson } from "./canonical-json";
import { RoutingSnapshotError } from "./errors";
import { sha256 } from "./sha256";
import { SNAPSHOT_COLLECTIONS } from "./snapshot";
import type { OrgRoutingSnapshot, SnapshotCollection } from "./snapshot";

/** The KV bucket compiled artifacts live in. Mirrors `ROUTING_CACHE_KV.name` in `packages/events`. */
export const ROUTING_CACHE_BUCKET = "routing-cache";

/**
 * The artifact discriminator inside an organization's key space. One value today, and that is the
 * contract — see the "why not finer-grained keys" note above.
 */
export const ROUTING_CACHE_ARTIFACT_NAME = "artifact";

/** Mirrors `isSubjectToken` in `packages/events`: NATS subject tokens are `[A-Za-z0-9_-]+`. */
const KEY_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The `routing-cache` key holding an organization's compiled artifact. */
export function routingCacheKey(organizationId: string): string {
	if (!KEY_TOKEN_PATTERN.test(organizationId)) {
		throw new RoutingSnapshotError(
			"organizationId",
			`${JSON.stringify(organizationId)} is not a usable KV key token ([A-Za-z0-9_-]+)`,
		);
	}
	return `${organizationId}.${ROUTING_CACHE_ARTIFACT_NAME}`;
}

/**
 * Every entity kind whose mutation can change a compiled artifact.
 *
 * Derived from `SNAPSHOT_COLLECTIONS` plus the settings row, so the list cannot drift from what the
 * compiler actually reads: adding a collection to the snapshot without listing it here is a
 * TypeScript error.
 */
export const ROUTING_ENTITY_KINDS = [...SNAPSHOT_COLLECTIONS, "settings"] as const;

export type RoutingEntityKind = (typeof ROUTING_ENTITY_KINDS)[number];

const ROUTING_ENTITY_KIND_SET: ReadonlySet<string> = new Set(ROUTING_ENTITY_KINDS);

/**
 * Physical table name → snapshot collection.
 *
 * The API writes rows, not collections, so the invalidation hook speaks table names. Anything not
 * in this map is not a routing input and must not evict the cache.
 */
export const ROUTING_TABLE_TO_ENTITY: Readonly<Record<string, RoutingEntityKind>> = {
	extension: "extensions",
	phone_number: "phoneNumbers",
	trunk: "trunks",
	inbound_route: "inboundRoutes",
	outbound_route: "outboundRoutes",
	time_condition: "timeConditions",
	time_condition_rule: "timeConditionRules",
	ivr_menu: "ivrMenus",
	ivr_menu_option: "ivrMenuOptions",
	ring_group: "ringGroups",
	ring_group_destination: "ringGroupDestinations",
	queue: "queues",
	voicemail_box: "voicemailBoxes",
	conference: "conferences",
	park_lot: "parkLots",
	feature_code: "featureCodes",
	call_block_rule: "callBlockRules",
	org_setting: "settings",
} as const;

export function isRoutingEntityKind(value: string): value is RoutingEntityKind {
	return ROUTING_ENTITY_KIND_SET.has(value);
}

/** Whether a mutation to this table can change routing. The cheap gate before any eviction. */
export function affectsRouting(tableName: string): boolean {
	return tableName in ROUTING_TABLE_TO_ENTITY;
}

export const ROUTING_CHANGE_OPERATIONS = ["insert", "update", "delete"] as const;

export type RoutingChangeOperation = (typeof ROUTING_CHANGE_OPERATIONS)[number];

/** One mutation, as the API's write path reports it. */
export interface RoutingSnapshotChange {
	readonly organizationId: string;
	/** Physical table name, e.g. `ivr_menu_option`. */
	readonly table: string;
	readonly operation: RoutingChangeOperation;
	/** The mutated row id, for the audit trail. Never affects which keys are invalidated. */
	readonly entityId?: string;
}

/**
 * The cache keys a mutation invalidates. Empty when the table is not a routing input.
 *
 * Returns a list rather than a single key so a future second artifact per organization (a
 * provisioning artifact, say) can be added without changing every call site.
 */
export function invalidationKeysFor(change: RoutingSnapshotChange): readonly string[] {
	return affectsRouting(change.table) ? [routingCacheKey(change.organizationId)] : [];
}

/** Deduplicated, sorted keys for a batch of mutations — one transaction, one eviction. */
export function invalidationKeysForBatch(
	changes: readonly RoutingSnapshotChange[],
): readonly string[] {
	const keys = new Set<string>();
	for (const change of changes) {
		for (const key of invalidationKeysFor(change)) {
			keys.add(key);
		}
	}
	return [...keys].sort();
}

/**
 * Canonical form of a snapshot: collections in `SNAPSHOT_COLLECTIONS` order, each sorted by id,
 * object keys sorted, `undefined` dropped.
 *
 * Sorting rows by id is what makes the hash independent of the loader's `ORDER BY`. Row *order*
 * within a collection carries no routing meaning — `priority` and `ordinal` do, and they are
 * fields — so sorting loses nothing and buys a hash that only moves when content moves.
 */
export function canonicalizeSnapshot(snapshot: OrgRoutingSnapshot): string {
	const collections: Record<string, unknown> = {};
	for (const collection of SNAPSHOT_COLLECTIONS) {
		// Every collection is an array of rows carrying an `id`; the union of their element types is
		// not, which is the one thing a per-collection cast buys over seventeen literal accesses.
		collections[collection] = sortById(
			snapshot[collection as SnapshotCollection] as readonly { readonly id: string }[],
		);
	}
	return canonicalJson({
		organizationId: snapshot.organizationId,
		settings: snapshot.settings ?? null,
		...collections,
	});
}

function sortById<T extends { readonly id: string }>(rows: readonly T[]): readonly T[] {
	return [...rows].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * The content hash of a snapshot: SHA-256 of its canonical form, lower-case hex.
 *
 * This is the artifact's `snapshotHash` and the cache-validity token. Two snapshots hash the same
 * exactly when they would compile to the same artifact.
 */
export function snapshotHash(snapshot: OrgRoutingSnapshot): string {
	return sha256(canonicalizeSnapshot(snapshot));
}

/** Whether a cached artifact is still the compilation of this snapshot. */
export function isArtifactFresh(
	artifact: { readonly organizationId: string; readonly snapshotHash: string },
	snapshot: OrgRoutingSnapshot,
): boolean {
	return (
		artifact.organizationId === snapshot.organizationId &&
		artifact.snapshotHash === snapshotHash(snapshot)
	);
}
