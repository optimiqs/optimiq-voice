import { expect } from "chai";
import { kvKeyFor } from "@optimiq-voice/events/streams";
import {
	projectTrunkDirectoryEntry,
	TrunkDirectoryPublisher,
} from "../../src/pbx/trunks/trunk-directory.publisher";
import type { PbxEnv } from "../../src/pbx/shared/pbx-env";
import type { TrunkDirectoryRow } from "../../src/pbx/trunks/trunk-directory.publisher";
import type { TrunkDirectoryEntry } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";
import type { KV } from "nats";

/**
 * The `trunks` read model — the projection, and the reconcile that maintains the bucket.
 *
 * A missing or wrong entry here is not a degraded call, it is no call: the edge has no proxy address
 * to send an INVITE to and no credential to REGISTER with, so every outbound leg for the tenant
 * fails. What is worth pinning is therefore what the edge cannot recover from, plus the one thing
 * that would be a leak rather than an outage:
 *
 *  1. **The secret is never written.** `sipSecretRef` is a HANDLE and the password it names must not
 *     reach a bucket four services can open. The column list in `readTrunkDirectoryRows` is what
 *     makes that a property of a type, and this is the assertion that it stayed one.
 *  2. **The key.** `<orgId>.<trunkId>`, which is what makes "what does this tenant dial out over?"
 *     one range read and what makes a cross-tenant collision impossible by construction.
 *  3. **Delete on delete**, and a disabled trunk NOT being a delete — those are different wire facts
 *     and collapsing them would leave the edge guessing what tore a registration down.
 *
 * The database is never reached: `reconcile` takes rows, which is the seam `scripts/rebuild-trunks.ts`
 * uses too. The round trip against a real broker is `verify-pbx.ts`'s job.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const OTHER_ORG = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const TRUNK = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const OTHER_TRUNK = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";
const UPDATED = new Date("2026-08-12T09:00:00.000Z");

function row(overrides: Partial<TrunkDirectoryRow> = {}): TrunkDirectoryRow {
	return {
		id: TRUNK,
		name: "Telnyx",
		kind: "register",
		sipDomain: "sip.telnyx.example",
		sipProxy: "sip.telnyx.example:5060",
		outboundProxy: null,
		authUser: "optimiq-outbound",
		sipSecretRef: "secret://pbx/trunk/telnyx",
		transport: "udp",
		registerExpiresSeconds: 300,
		maxChannels: null,
		callerIdNumberOverride: null,
		enabled: true,
		updatedAt: UPDATED,
		...overrides,
	};
}

interface FakeBucket {
	readonly kv: KV;
	readonly store: Map<string, Uint8Array>;
	readonly puts: string[];
	readonly deletes: string[];
}

/**
 * An in-memory KV, with the ONE behaviour this publisher depends on that the ACL's does not: a
 * `keys(filter)` that honours the `<org>.*` prefix. The whole point of an org-scoped key is that
 * this publisher never reads another tenant's values, and a fake that ignored the filter would let a
 * regression to a full scan pass unnoticed.
 */
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
		keys: async (filter?: string) => {
			const keys = [...store.keys()];
			if (filter === undefined) {
				return await Promise.resolve(keys);
			}
			const prefix = filter.replace(/\*$/u, "");
			return await Promise.resolve(keys.filter((key) => key.startsWith(prefix)));
		},
	} as unknown as KV;
	return { kv, store, puts, deletes };
}

function publisherOn(bucket: FakeBucket): TrunkDirectoryPublisher {
	const publisher = new TrunkDirectoryPublisher({} as PbxEnv, {} as PbxDatabaseClient);
	(publisher as unknown as { bucket: KV | undefined }).bucket = bucket.kv;
	return publisher;
}

function storedAt(bucket: FakeBucket, key: string): TrunkDirectoryEntry {
	const raw = bucket.store.get(key);
	expect(raw, `nothing stored at ${key}`).to.not.equal(undefined);
	return JSON.parse(new TextDecoder().decode(raw as Uint8Array)) as TrunkDirectoryEntry;
}

describe("kvKeyFor.trunk", () => {
	it("is organization-first, so one range read answers what a tenant dials out over", () => {
		expect(kvKeyFor.trunk(ORG, TRUNK)).to.equal(`${ORG}.${TRUNK}`);
	});

	it("refuses a token that would not survive as a key", () => {
		expect(() => kvKeyFor.trunk(ORG, "")).to.throw();
	});
});

describe("projectTrunkDirectoryEntry", () => {
	/**
	 * The assertion this file exists for. Stated as "no property whose value is the secret" AND as
	 * "no key named for one", because the two ways this regresses are a renamed field carrying the
	 * password and a resolved handle carried under the right name.
	 */
	it("never carries the secret, only the handle", () => {
		const entry = projectTrunkDirectoryEntry(ORG, row());
		expect(entry.secretRef).to.equal("secret://pbx/trunk/telnyx");
		expect(entry).to.not.have.property("sipSecret");
		expect(entry).to.not.have.property("sipPassword");
		expect(entry).to.not.have.property("password");
		expect(JSON.stringify(entry)).to.not.contain("password");
	});

	/** Everything it takes to place one INVITE or send one REGISTER, and nothing else. */
	it("carries the whole dialable configuration", () => {
		const entry = projectTrunkDirectoryEntry(ORG, row({ outboundProxy: "sbc.example:5060" }));
		expect(entry.trunkId).to.equal(TRUNK);
		expect(entry.orgId).to.equal(ORG);
		expect(entry.kind).to.equal("register");
		expect(entry.sipDomain).to.equal("sip.telnyx.example");
		expect(entry.sipProxy).to.equal("sip.telnyx.example:5060");
		expect(entry.outboundProxy).to.equal("sbc.example:5060");
		expect(entry.authUser).to.equal("optimiq-outbound");
		expect(entry.transport).to.equal("udp");
		expect(entry.registerExpiresSeconds).to.equal(300);
		expect(entry.updatedAt).to.equal(UPDATED.getTime());
	});

	/**
	 * Reachability is a transition and travels as an event; the persisted view is the `status*`
	 * columns. They are not on the row type at all, which is what stops an OPTIONS flap becoming
	 * watch load on the process least able to afford it.
	 */
	it("carries no status, which is what keeps a carrier flap off the broker", () => {
		const entry = projectTrunkDirectoryEntry(ORG, row());
		expect(entry).to.not.have.property("status");
		expect(entry).to.not.have.property("statusChangedAt");
		expect(entry).to.not.have.property("codecPrefs");
	});

	/** Absent, never `null` — the schema's optionals are `.optional()` and a null fails the parse. */
	it("omits the nullable columns rather than sending null", () => {
		const entry = projectTrunkDirectoryEntry(ORG, row({ outboundProxy: null, authUser: null }));
		expect(entry).to.not.have.property("outboundProxy");
		expect(entry).to.not.have.property("authUser");
	});

	/** An `ip-auth` trunk has no credential at all, and that is a shape rather than a gap. */
	it("omits the handle for a trunk that has no credential", () => {
		const entry = projectTrunkDirectoryEntry(
			ORG,
			row({ kind: "ip-auth", authUser: null, sipSecretRef: null }),
		);
		expect(entry).to.not.have.property("secretRef");
		expect(entry.kind).to.equal("ip-auth");
	});
});

describe("TrunkDirectoryPublisher.reconcile", () => {
	it("writes a new trunk under its organization-scoped key", async () => {
		const bucket = fakeBucket();
		const result = await publisherOn(bucket).reconcile(ORG, [row()]);

		expect(result.published).to.equal(1);
		expect(bucket.puts).to.deep.equal([`${ORG}.${TRUNK}`]);
		expect(storedAt(bucket, `${ORG}.${TRUNK}`).sipProxy).to.equal("sip.telnyx.example:5060");
	});

	it("does not write the secret into the bucket", async () => {
		const bucket = fakeBucket();
		await publisherOn(bucket).reconcile(ORG, [row()]);

		const raw = new TextDecoder().decode(bucket.store.get(`${ORG}.${TRUNK}`) as Uint8Array);
		expect(raw).to.contain("secret://pbx/trunk/telnyx");
		expect(raw).to.not.contain("password");
		expect(JSON.parse(raw)).to.not.have.property("sipSecret");
	});

	it("rewrites the key in place when the trunk changes", async () => {
		const bucket = fakeBucket();
		const publisher = publisherOn(bucket);
		await publisher.reconcile(ORG, [row()]);
		const second = await publisher.reconcile(ORG, [row({ sipProxy: "sbc2.example:5060" })]);

		expect(second.published).to.equal(1);
		expect(bucket.store.size).to.equal(1);
		expect(storedAt(bucket, `${ORG}.${TRUNK}`).sipProxy).to.equal("sbc2.example:5060");
	});

	/**
	 * A timestamp-only difference is not a republish. `TrunkStatusConsumer` moves `updated_at` on
	 * every OPTIONS transition, and a value that differed only there would wake every watching `sipd`
	 * on every flap of every trunk, forever.
	 */
	it("does not republish for a moved timestamp alone", async () => {
		const bucket = fakeBucket();
		const publisher = publisherOn(bucket);
		await publisher.reconcile(ORG, [row()]);
		const second = await publisher.reconcile(ORG, [
			row({ updatedAt: new Date(UPDATED.getTime() + 60_000) }),
		]);

		expect(second.published).to.equal(0);
		expect(second.unchanged).to.equal(1);
		expect(bucket.puts).to.have.length(1);
	});

	it("deletes the key when the trunk is gone", async () => {
		const bucket = fakeBucket();
		const publisher = publisherOn(bucket);
		await publisher.reconcile(ORG, [row()]);
		const second = await publisher.reconcile(ORG, []);

		expect(second.deleted).to.equal(1);
		expect(bucket.deletes).to.deep.equal([`${ORG}.${TRUNK}`]);
		expect(bucket.store.has(`${ORG}.${TRUNK}`)).to.equal(false);
	});

	/**
	 * Disabled is not deleted. Collapsing the two would make "an operator turned this off" and "a
	 * publish was lost" the same fact at the edge.
	 */
	it("keeps a disabled trunk in the bucket", async () => {
		const bucket = fakeBucket();
		const result = await publisherOn(bucket).reconcile(ORG, [row({ enabled: false })]);

		expect(result.deleted).to.equal(0);
		expect(storedAt(bucket, `${ORG}.${TRUNK}`).enabled).to.equal(false);
	});

	/**
	 * The property the org-scoped key buys, asserted rather than assumed: another tenant's trunks are
	 * neither read nor swept, because the reconcile never looks outside its own prefix.
	 */
	it("never touches another tenant's trunks", async () => {
		const bucket = fakeBucket({
			[`${OTHER_ORG}.${OTHER_TRUNK}`]: projectTrunkDirectoryEntry(
				OTHER_ORG,
				row({ id: OTHER_TRUNK }),
			),
		});
		const result = await publisherOn(bucket).reconcile(ORG, []);

		expect(result.deleted).to.equal(0);
		expect(bucket.deletes).to.deep.equal([]);
		expect(bucket.store.has(`${OTHER_ORG}.${OTHER_TRUNK}`)).to.equal(true);
	});

	it("reports skipped when there is no bucket", async () => {
		const publisher = new TrunkDirectoryPublisher({} as PbxEnv, {} as PbxDatabaseClient);
		const result = await publisher.reconcile(ORG, [row()]);

		expect(result.skipped).to.equal(true);
		expect(result.published).to.equal(0);
	});
});
