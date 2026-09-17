import { expect } from "chai";
import { kvKeyFor } from "@optimiq-voice/events/streams";
import { projectSipAclEntry, SipAclPublisher } from "../../src/pbx/security/sip-acl.publisher";
import type { SipAclRow } from "../../src/pbx/security/sip-acl.publisher";
import type { PbxEnv } from "../../src/pbx/shared/pbx-env";
import type { SipAclEntry } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";
import type { KV } from "nats";

/**
 * The `sip-acl` read model — the projection, and the reconcile that maintains the bucket.
 *
 * `queueMembershipProjection.test.ts` pins only the pure half and leaves the KV round trip to
 * `verify-pbx.ts`, and for a roster that is the right line: a wrong roster rings the wrong phone,
 * loudly, and the projection is where "wrong" lives. This bucket is an access-control boundary and
 * the reconcile is where its failures are, so the line moves one step out. What is worth pinning
 * here is everything that decides whether a stranger's packet is admitted:
 *
 *  1. **The key.** `kvKeyFor.sipAcl` folds a CIDR because dots, slashes and colons are not key
 *     tokens. The writer and `apps/sipd` must fold identically or the edge looks up a key nobody
 *     wrote — which, under "absence is refusal", silently refuses every carrier.
 *  2. **Delete on delete.** The rule this bucket must never break is a network still admitted by a
 *     rule that was removed. A missed delete is that bug.
 *  3. **`trunkId` reaching the value.** The column exists so a matched packet can be attributed to a
 *     carrier; absent means "admits without attributing", which is what every pre-column row means.
 *  4. **Contested keys published as NOTHING.** The key is the network alone and the table's
 *     uniqueness is `(organization_id, scope, network)`, so two legal rows can collide. Picking one
 *     would make an access-control decision turn on write order.
 *
 * The database is never reached: `reconcile` takes rows, which is exactly why it is the seam the
 * rebuild script also uses.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const OTHER_ORG = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const TRUNK = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const UPDATED = new Date("2026-08-12T09:00:00.000Z");
const KEY = kvKeyFor.sipAcl(ORG, "trunk", "203.0.113.0/24");

function row(overrides: Partial<SipAclRow> = {}): SipAclRow {
	return {
		network: "203.0.113.0/24",
		action: "allow",
		scope: "trunk",
		priority: 100,
		trunkId: null,
		name: "Telnyx signalling",
		enabled: true,
		updatedAt: UPDATED,
		...overrides,
	};
}

/**
 * An in-memory stand-in for the KV view, holding the same bytes the broker would.
 *
 * Values are stored ENCODED rather than as objects, so the JSON round trip and the schema parse on
 * the way back in are both exercised — the change comparison runs over a parsed value, and a test
 * that skipped the parse would not notice a field the schema drops.
 */
interface FakeBucket {
	readonly kv: KV;
	readonly store: Map<string, Uint8Array>;
	readonly puts: string[];
	readonly deletes: string[];
}

function fakeBucket(seed: Record<string, unknown> = {}): FakeBucket {
	const store = new Map<string, Uint8Array>();
	const puts: string[] = [];
	const deletes: string[] = [];
	for (const [key, value] of Object.entries(seed)) {
		store.set(key, new TextEncoder().encode(JSON.stringify(value)));
	}
	const kv = {
		put: async (key: string, value: Uint8Array) => {
			puts.push(key);
			store.set(key, value);
			return await Promise.resolve(1);
		},
		get: async (key: string) => {
			const value = store.get(key);
			return await Promise.resolve(value === undefined ? null : { value });
		},
		delete: async (key: string) => {
			deletes.push(key);
			store.delete(key);
			await Promise.resolve();
		},
		// The filter is honoured, because the reconcile's whole delete pass now depends on it: a fake
		// that returned every key would hide a prefix that does not match what was written.
		keys: async (filter?: string) => {
			if (filter === "*") {
				// `*` is one token, not a prefix — the legacy key shape the reconcile sweeps.
				return await Promise.resolve([...store.keys()].filter((key) => !key.includes(".")));
			}
			const prefix = filter === undefined ? "" : filter.replace(/>$/u, "");
			return await Promise.resolve([...store.keys()].filter((key) => key.startsWith(prefix)));
		},
	} as unknown as KV;
	return { kv, store, puts, deletes };
}

/** The publisher with its broker replaced. `onModuleInit` is the connection's business, not ours. */
function publisherOn(bucket: FakeBucket): SipAclPublisher {
	const publisher = new SipAclPublisher({} as PbxEnv, {} as PbxDatabaseClient);
	(publisher as unknown as { bucket: KV | undefined }).bucket = bucket.kv;
	return publisher;
}

function storedAt(bucket: FakeBucket, key: string): SipAclEntry {
	const raw = bucket.store.get(key);
	expect(raw, `nothing stored at ${key}`).to.not.equal(undefined);
	return JSON.parse(new TextDecoder().decode(raw as Uint8Array)) as SipAclEntry;
}

describe("kvKeyFor.sipAcl", () => {
	/**
	 * The key is `(organization_id, scope, network)` — the table's unique index — with the network's
	 * separators folded. The fold is the one transformation in the whole key space and the one both
	 * sides have to agree on; it is pinned against literals rather than against a re-implementation,
	 * because a test that folded the CIDR itself would agree with a broken folder.
	 */
	it("folds every separator a CIDR can contain", () => {
		expect(kvKeyFor.sipAcl(ORG, "trunk", "203.0.113.0/24")).to.equal(`${ORG}.trunk.203-0-113-0-24`);
		expect(kvKeyFor.sipAcl(ORG, "trunk", "198.51.100.7/32")).to.equal(
			`${ORG}.trunk.198-51-100-7-32`,
		);
		expect(kvKeyFor.sipAcl(ORG, "trunk", "0.0.0.0/0")).to.equal(`${ORG}.trunk.0-0-0-0-0`);
	});

	/**
	 * IPv6 is not a future case — `sip_acl_entry.network` is a `cidr` and takes it today. A folder
	 * that handled only the v4 pair would throw on the first IPv6 carrier, at write time in here or
	 * at boot in the edge, and both are worse places to discover it.
	 */
	it("folds IPv6, whose colons are as unusable as the dots", () => {
		expect(kvKeyFor.sipAcl(ORG, "trunk", "2001:db8::/32")).to.equal(`${ORG}.trunk.2001-db8---32`);
		expect(kvKeyFor.sipAcl(ORG, "trunk", "2001:db8:1:2::/64")).to.equal(
			`${ORG}.trunk.2001-db8-1-2---64`,
		);
	});

	/**
	 * The reason the organization and the scope are in the key at all: without them, two tenants
	 * naming one CIDR — or one tenant naming it in both edge scopes — contended for a single entry on
	 * a security boundary, and the loser's rule was published as nothing.
	 */
	it("keeps two tenants, and two scopes, on separate keys", () => {
		expect(kvKeyFor.sipAcl(ORG, "trunk", "203.0.113.0/24")).to.not.equal(
			kvKeyFor.sipAcl(OTHER_ORG, "trunk", "203.0.113.0/24"),
		);
		expect(kvKeyFor.sipAcl(ORG, "trunk", "203.0.113.0/24")).to.not.equal(
			kvKeyFor.sipAcl(ORG, "registration", "203.0.113.0/24"),
		);
		expect(kvKeyFor.sipAclPrefix(ORG)).to.equal(`${ORG}.>`);
	});

	it("refuses a network with nothing usable left in it", () => {
		expect(() => kvKeyFor.sipAcl(ORG, "trunk", "")).to.throw();
		expect(() => kvKeyFor.sipAcl(ORG, "trunk", "   ")).to.throw();
	});
});

describe("projectSipAclEntry", () => {
	it("carries the tenant in the value, because the key cannot", () => {
		const entry = projectSipAclEntry(ORG, row());
		expect(entry.orgId).to.equal(ORG);
		expect(entry.network).to.equal("203.0.113.0/24");
		expect(entry.action).to.equal("allow");
		expect(entry.scope).to.equal("trunk");
		expect(entry.priority).to.equal(100);
		expect(entry.updatedAt).to.equal(UPDATED.getTime());
	});

	it("carries trunkId when the entry attributes a carrier", () => {
		expect(projectSipAclEntry(ORG, row({ trunkId: TRUNK })).trunkId).to.equal(TRUNK);
	});

	/**
	 * Absent, never `null`. The schema's optionals are `.optional()` and a `null` fails the parse on
	 * the way back in — and the absence is also the meaning, so a row written before the column
	 * existed and one deliberately left unbound are correctly the same wire fact.
	 */
	it("omits trunkId rather than sending null when the entry attributes nothing", () => {
		const entry = projectSipAclEntry(ORG, row({ trunkId: null }));
		expect(entry).to.not.have.property("trunkId");
		expect(Object.hasOwn(entry, "trunkId")).to.equal(false);
	});

	it("omits an absent name for the same reason", () => {
		expect(projectSipAclEntry(ORG, row({ name: null }))).to.not.have.property("name");
	});

	/** A disabled rule stays in the bucket and does not match. Removal is a DELETE, not a flag. */
	it("projects a disabled entry rather than dropping it", () => {
		expect(projectSipAclEntry(ORG, row({ enabled: false })).enabled).to.equal(false);
	});
});

describe("SipAclPublisher.reconcile", () => {
	it("writes a new rule under the folded network key", async () => {
		const bucket = fakeBucket();
		const result = await publisherOn(bucket).reconcile(ORG, [row()]);

		expect(result.published).to.equal(1);
		expect(result.skipped).to.equal(false);
		expect(bucket.puts).to.deep.equal([KEY]);
		expect(storedAt(bucket, KEY).orgId).to.equal(ORG);
	});

	it("carries trunkId into the bucket", async () => {
		const bucket = fakeBucket();
		await publisherOn(bucket).reconcile(ORG, [row({ trunkId: TRUNK })]);

		expect(storedAt(bucket, KEY).trunkId).to.equal(TRUNK);
	});

	it("rewrites the key in place when the rule changes", async () => {
		const bucket = fakeBucket();
		const publisher = publisherOn(bucket);
		await publisher.reconcile(ORG, [row({ action: "allow" })]);
		const second = await publisher.reconcile(ORG, [row({ action: "deny" })]);

		expect(second.published).to.equal(1);
		expect(bucket.store.size).to.equal(1);
		expect(storedAt(bucket, KEY).action).to.equal("deny");
	});

	/**
	 * Binding a rule to a trunk is a rewrite, not a no-op. It would be an easy thing to lose: the
	 * value the edge MATCHES on is unchanged, and only the attribution moves.
	 */
	it("rewrites when only the trunk binding changes", async () => {
		const bucket = fakeBucket();
		const publisher = publisherOn(bucket);
		await publisher.reconcile(ORG, [row()]);
		const second = await publisher.reconcile(ORG, [row({ trunkId: TRUNK })]);

		expect(second.published).to.equal(1);
		expect(storedAt(bucket, KEY).trunkId).to.equal(TRUNK);
	});

	/**
	 * An unchanged rule is not republished. Every write here wakes every watching `sipd`, and the
	 * process least able to afford watch churn is the one on the INVITE path.
	 */
	it("leaves an unchanged rule alone", async () => {
		const bucket = fakeBucket();
		const publisher = publisherOn(bucket);
		await publisher.reconcile(ORG, [row()]);
		const second = await publisher.reconcile(ORG, [row()]);

		expect(second.published).to.equal(0);
		expect(second.unchanged).to.equal(1);
		expect(bucket.puts).to.have.length(1);
	});

	/**
	 * The failure this bucket must never have. A network still admitted by a rule an operator
	 * deleted is the boundary failing OPEN, which is the direction the zero TTL and this delete
	 * exist to prevent.
	 */
	it("deletes the key when the rule is gone", async () => {
		const bucket = fakeBucket();
		const publisher = publisherOn(bucket);
		await publisher.reconcile(ORG, [row()]);
		const second = await publisher.reconcile(ORG, []);

		expect(second.deleted).to.equal(1);
		expect(bucket.deletes).to.deep.equal([KEY]);
		expect(bucket.store.has(KEY)).to.equal(false);
	});

	/**
	 * The same failure, from the key change. Before the organization and the scope entered the key an
	 * entry was the folded network alone, and the reconcile's range read over this organization's
	 * prefix cannot see one. The edge watches the whole bucket by network, so a legacy key left behind
	 * keeps admitting a network whose rule was deleted.
	 */
	it("deletes a legacy key this organization wrote before the key carried the organization", async () => {
		const bucket = fakeBucket({
			"203-0-113-0-24": {
				network: "203.0.113.0/24",
				orgId: ORG,
				action: "allow",
				scope: "trunk",
				priority: 100,
				enabled: true,
				updatedAt: UPDATED.getTime(),
			},
		});
		const result = await publisherOn(bucket).reconcile(ORG, []);

		expect(result.deleted).to.equal(1);
		expect(bucket.deletes).to.deep.equal(["203-0-113-0-24"]);
		expect(bucket.store.has("203-0-113-0-24")).to.equal(false);
	});

	/** Another tenant's legacy key is not this reconcile's to remove; the rebuild script reports it. */
	it("leaves a legacy key belonging to another organization alone", async () => {
		const bucket = fakeBucket({
			"198-51-100-0-24": {
				network: "198.51.100.0/24",
				orgId: OTHER_ORG,
				action: "allow",
				scope: "trunk",
				priority: 100,
				enabled: true,
				updatedAt: UPDATED.getTime(),
			},
		});
		const result = await publisherOn(bucket).reconcile(ORG, []);

		expect(result.deleted).to.equal(0);
		expect(bucket.store.has("198-51-100-0-24")).to.equal(true);
	});

	/** `provisioning` and `api` are HTTP surfaces with in-tenant readers; the edge guards two scopes. */
	it("publishes only the scopes the edge guards", async () => {
		const bucket = fakeBucket();
		await publisherOn(bucket).reconcile(ORG, [
			row({ network: "203.0.113.0/24", scope: "trunk" }),
			row({ network: "198.51.100.0/24", scope: "registration" }),
			row({ network: "192.0.2.0/24", scope: "provisioning" }),
			row({ network: "10.0.0.0/8", scope: "api" }),
		]);

		expect([...bucket.store.keys()].sort()).to.deep.equal(
			[kvKeyFor.sipAcl(ORG, "registration", "198.51.100.0/24"), KEY].sort(),
		);
	});

	/**
	 * The same network in both edge scopes. Two legal rows, two keys, both published — before the key
	 * carried the scope they contended and neither was.
	 */
	it("publishes a network a tenant claims in both edge scopes", async () => {
		const bucket = fakeBucket();
		const result = await publisherOn(bucket).reconcile(ORG, [
			row({ scope: "trunk", action: "allow" }),
			row({ scope: "registration", action: "deny" }),
		]);

		expect(result.published).to.equal(2);
		expect(storedAt(bucket, KEY).action).to.equal("allow");
		expect(
			storedAt(bucket, kvKeyFor.sipAcl(ORG, "registration", "203.0.113.0/24")).action,
		).to.equal("deny");
	});

	/**
	 * Another tenant naming the same network. Its entry is on its own key, so ours publishes and
	 * theirs is neither overwritten nor deleted — the cross-tenant suppression the old key allowed.
	 */
	it("publishes a network another tenant also claims, without touching theirs", async () => {
		const theirKey = kvKeyFor.sipAcl(OTHER_ORG, "trunk", "203.0.113.0/24");
		const bucket = fakeBucket({ [theirKey]: projectSipAclEntry(OTHER_ORG, row()) });
		const result = await publisherOn(bucket).reconcile(ORG, [row()]);

		expect(result.published).to.equal(1);
		expect(storedAt(bucket, KEY).orgId).to.equal(ORG);
		expect(storedAt(bucket, theirKey).orgId).to.equal(OTHER_ORG);
		expect(bucket.deletes).to.deep.equal([]);
	});

	/** Another tenant's untouched rules are not swept by our reconcile's delete pass. */
	it("leaves another tenant's unrelated rules alone", async () => {
		const theirKey = kvKeyFor.sipAcl(OTHER_ORG, "trunk", "198.51.100.0/24");
		const bucket = fakeBucket({
			[theirKey]: projectSipAclEntry(OTHER_ORG, row({ network: "198.51.100.0/24" })),
		});
		await publisherOn(bucket).reconcile(ORG, []);

		expect(bucket.deletes).to.deep.equal([]);
		expect(bucket.store.has(theirKey)).to.equal(true);
	});

	/** No broker means nothing was attempted — distinct from "there was nothing to do". */
	it("reports skipped when there is no bucket", async () => {
		const publisher = new SipAclPublisher({} as PbxEnv, {} as PbxDatabaseClient);
		const result = await publisher.reconcile(ORG, [row()]);

		expect(result.skipped).to.equal(true);
		expect(result.published).to.equal(0);
	});
});
