import { describe, expect, it } from "bun:test";
import { kvKeyFor } from "@optimiq-voice/events";
import { FakeClaimBucket } from "../nats/claim-store.fake";
import { CLAIM_LEASE_MS, ParkRegistry, parkSlotFor } from "./park-registry";
import type { ParkedCall } from "./park-registry";
import type { ParkClaim } from "@optimiq-voice/events";

const LOT = { slotStart: 401, slotEnd: 403 };
const LOT_ID = "0195c0f0-1c2f-7000-8000-0000000000f1";
const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const OTHER_LOT_ID = "0195c0f0-1c2f-7000-8000-0000000000f2";
const NOW = 1_700_000_000_000;

/** The claim a bucket holds for an orbit. Throws rather than short-circuiting: a spec that reached
 * here expecting a claim and found none should fail loudly at the read. */
function claimAt(bucket: FakeClaimBucket<ParkClaim>, slot: number): ParkClaim {
	const held = bucket.entries.get(kvKeyFor.parkClaim(ORG, LOT_ID, slot));
	if (held === undefined) {
		throw new Error(`no claim on orbit ${String(slot)}`);
	}
	return held.value as ParkClaim;
}

function entry(mediaChannelId: string): Omit<ParkedCall, "slot"> {
	return {
		parkLotId: LOT_ID,
		mediaChannelId,
		legId: `leg-${mediaChannelId}`,
		callId: `call-${mediaChannelId}`,
		organizationId: ORG,
		parkedAtMs: 1_000,
	};
}

async function parkedSlot(registry: ParkRegistry, channel: string): Promise<number> {
	const result = await registry.park(LOT, entry(channel));
	if (result.kind !== "parked") {
		throw new Error(`expected a park, got ${result.kind}`);
	}
	return result.entry.slot;
}

/** A registry backed by a shared claim bucket, plus the bucket, plus a clock a spec can move. */
function shared(options: { readonly now?: () => number } = {}): {
	readonly registry: ParkRegistry;
	readonly bucket: FakeClaimBucket<ParkClaim>;
} {
	const bucket = new FakeClaimBucket<ParkClaim>();
	const registry = new ParkRegistry();
	registry.bindClaims(bucket, "engine-a", options.now ?? (() => NOW));
	return { registry, bucket };
}

// ---------------------------------------------------------------------------------------------
// The unshared path: exactly what it always did
// ---------------------------------------------------------------------------------------------

describe("claiming an orbit — single instance", () => {
	it("hands out the lowest free slot and remembers who is in it", async () => {
		const registry = new ParkRegistry();
		expect(await parkedSlot(registry, "c1")).toBe(401);
		expect(await parkedSlot(registry, "c2")).toBe(402);
		expect(registry.at(LOT_ID, 401)?.mediaChannelId).toBe("c1");
		expect(registry.forChannel("c2")?.slot).toBe(402);
		expect(registry.parkedCount).toBe(2);
	});

	it("reports that claims are not shared, which is a deployment choice and not a fault", () => {
		expect(new ParkRegistry().isShared).toBe(false);
	});

	it("lists a lot in slot order regardless of arrival order", async () => {
		const registry = new ParkRegistry();
		await registry.park(LOT, entry("c3"), 403);
		await registry.park(LOT, entry("c1"), 401);
		expect(registry.lot(LOT_ID).map((call) => call.slot)).toEqual([401, 403]);
	});

	it("refuses a full lot rather than overwriting an occupant", async () => {
		const registry = new ParkRegistry();
		await parkedSlot(registry, "c1");
		await parkedSlot(registry, "c2");
		await parkedSlot(registry, "c3");
		expect(await registry.park(LOT, entry("c4"))).toEqual({ kind: "lot-full", capacity: 3 });
		expect(registry.at(LOT_ID, 401)?.mediaChannelId).toBe("c1");
	});

	it("refuses a requested orbit that is taken — somebody has already announced that number", async () => {
		const registry = new ParkRegistry();
		await registry.park(LOT, entry("c1"), 402);
		expect(await registry.park(LOT, entry("c2"), 402)).toEqual({
			kind: "slot-unavailable",
			slot: 402,
		});
		expect(registry.at(LOT_ID, 402)?.mediaChannelId).toBe("c1");
	});

	it("refuses an orbit outside the lot", async () => {
		const registry = new ParkRegistry();
		expect(await registry.park(LOT, entry("c1"), 999)).toEqual({
			kind: "slot-unavailable",
			slot: 999,
		});
	});

	it("keeps lots separate — slot 401 exists in each of them", async () => {
		const registry = new ParkRegistry();
		await registry.park(LOT, entry("c1"), 401);
		await registry.park(LOT, { ...entry("c2"), parkLotId: OTHER_LOT_ID }, 401);
		expect(registry.at(LOT_ID, 401)?.mediaChannelId).toBe("c1");
		expect(registry.at(OTHER_LOT_ID, 401)?.mediaChannelId).toBe("c2");
	});
});

describe("retrieval — single instance", () => {
	it("is exclusive: two retrievals of one slot produce one winner", async () => {
		const registry = new ParkRegistry();
		await parkedSlot(registry, "c1");
		const first = await registry.claim(LOT_ID, 401);
		expect(first.kind === "claimed" && first.entry.mediaChannelId).toBe("c1");
		// The loser is told the truth rather than bridged to a caller somebody else already has.
		expect((await registry.claim(LOT_ID, 401)).kind).toBe("absent");
	});

	it("reports absent for an empty slot and for an unknown lot", async () => {
		const registry = new ParkRegistry();
		expect((await registry.claim(LOT_ID, 401)).kind).toBe("absent");
		expect((await registry.claim(OTHER_LOT_ID, 401)).kind).toBe("absent");
	});

	it("forgets the channel index too, so a later release is a no-op", async () => {
		const registry = new ParkRegistry();
		await parkedSlot(registry, "c1");
		await registry.claim(LOT_ID, 401);
		expect(registry.forChannel("c1")).toBeUndefined();
		expect(await registry.release("c1")).toBeUndefined();
		expect(registry.parkedCount).toBe(0);
	});

	it("puts a failed retrieval back in its own slot rather than stranding the call", async () => {
		const registry = new ParkRegistry();
		await parkedSlot(registry, "c1");
		const claimed = await registry.claim(LOT_ID, 401);
		expect(claimed.kind).toBe("claimed");
		expect(await registry.restore((claimed as { entry: ParkedCall }).entry)).toBe(true);
		expect(registry.at(LOT_ID, 401)?.mediaChannelId).toBe("c1");
	});

	it("refuses to restore into a slot somebody else has taken in the meantime", async () => {
		const registry = new ParkRegistry();
		await parkedSlot(registry, "c1");
		const claimed = await registry.claim(LOT_ID, 401);
		await registry.park(LOT, entry("c2"), 401);
		expect(await registry.restore((claimed as { entry: ParkedCall }).entry)).toBe(false);
		expect(registry.at(LOT_ID, 401)?.mediaChannelId).toBe("c2");
	});
});

describe("release", () => {
	it("frees the slot a hung-up leg was holding", async () => {
		const registry = new ParkRegistry();
		await parkedSlot(registry, "c1");
		expect((await registry.release("c1"))?.slot).toBe(401);
		expect(registry.at(LOT_ID, 401)).toBeUndefined();
		// And the freed orbit is the next one handed out.
		expect(await parkedSlot(registry, "c2")).toBe(401);
	});

	it("is a no-op for a leg that was never parked", async () => {
		expect(await new ParkRegistry().release("ghost")).toBeUndefined();
	});

	it("drops everything on clear", async () => {
		const registry = new ParkRegistry();
		await parkedSlot(registry, "c1");
		registry.clear();
		expect(registry.parkedCount).toBe(0);
		expect(registry.lot(LOT_ID)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------
// Shared claims
// ---------------------------------------------------------------------------------------------

describe("the shared claim", () => {
	it("writes the orbit's key, so two instances collide on one key", async () => {
		const { registry, bucket } = shared();
		await parkedSlot(registry, "c1");
		expect([...bucket.entries.keys()]).toEqual([kvKeyFor.parkClaim(ORG, LOT_ID, 401)]);
	});

	it("carries the owning instance and a lease, which is what makes a crash survivable", async () => {
		const { registry, bucket } = shared();
		await parkedSlot(registry, "c1");
		const claim = bucket.entries.get(kvKeyFor.parkClaim(ORG, LOT_ID, 401))?.value as ParkClaim;
		expect(claim.instanceId).toBe("engine-a");
		expect(claim.expiresAt).toBe(NOW + CLAIM_LEASE_MS);
		expect(claim.slot).toBe(401);
	});

	it("releases the key when the slot is retrieved", async () => {
		const { registry, bucket } = shared();
		await parkedSlot(registry, "c1");
		await registry.claim(LOT_ID, 401, ORG);
		expect(bucket.size).toBe(0);
	});

	it("releases the key when the parked leg hangs up", async () => {
		const { registry, bucket } = shared();
		await parkedSlot(registry, "c1");
		await registry.release("c1");
		expect(bucket.size).toBe(0);
	});
});

describe("two engine instances on one bucket", () => {
	/** Instance A and instance B, sharing one bucket exactly as two engines behind one Asterisk do. */
	function pair(now: () => number = () => NOW): {
		readonly a: ParkRegistry;
		readonly b: ParkRegistry;
		readonly bucket: FakeClaimBucket<ParkClaim>;
	} {
		const bucket = new FakeClaimBucket<ParkClaim>();
		const a = new ParkRegistry();
		const b = new ParkRegistry();
		a.bindClaims(bucket, "engine-a", now);
		b.bindClaims(bucket.peer(), "engine-b", now);
		return { a, b, bucket };
	}

	it("never puts two calls in one orbit — the loser moves to the next slot", async () => {
		const { a, b } = pair();
		expect(await parkedSlot(a, "c1")).toBe(401);
		// B's local map is empty, so it PICKS 401 too — and the compare-and-set is what stops it.
		expect(await parkedSlot(b, "c2")).toBe(402);
	});

	it("refuses a requested orbit another instance holds, rather than reassigning it", async () => {
		const { a, b } = pair();
		await a.park(LOT, entry("c1"), 402);
		expect(await b.park(LOT, entry("c2"), 402)).toEqual({ kind: "slot-unavailable", slot: 402 });
	});

	it("reports a lot full when every orbit is held somewhere in the cluster", async () => {
		const { a, b } = pair();
		await parkedSlot(a, "c1");
		await parkedSlot(a, "c2");
		await parkedSlot(a, "c3");
		expect((await b.park(LOT, entry("c4"))).kind).toBe("lot-full");
	});

	it("tells a retriever the call is on another instance, not that the slot is empty", async () => {
		const { a, b } = pair();
		await parkedSlot(a, "c1");
		const result = await b.claim(LOT_ID, 401, ORG);
		expect(result).toEqual({ kind: "elsewhere", instanceId: "engine-a" });
	});

	it("still answers absent for a slot nobody holds", async () => {
		const { b } = pair();
		expect((await b.claim(LOT_ID, 403, ORG)).kind).toBe("absent");
	});

	it("refuses to restore into an orbit another instance took in the meantime", async () => {
		const { a, b } = pair();
		await parkedSlot(a, "c1");
		const claimed = await a.claim(LOT_ID, 401, ORG);
		await b.park(LOT, entry("c2"), 401);
		expect(await a.restore((claimed as { entry: ParkedCall }).entry)).toBe(false);
	});
});

describe("stale claims", () => {
	it("takes over an orbit whose owner stopped heartbeating", async () => {
		let now = NOW;
		const bucket = new FakeClaimBucket<ParkClaim>();
		const dead = new ParkRegistry();
		dead.bindClaims(bucket, "engine-dead", () => now);
		await parkedSlot(dead, "c1");

		// The owning instance is gone: no heartbeat, and the lease elapses.
		now = NOW + CLAIM_LEASE_MS;
		const live = new ParkRegistry();
		live.bindClaims(bucket.peer(), "engine-live", () => now);
		const result = await live.park(LOT, entry("c2"), 401);
		expect(result.kind).toBe("parked");
		expect(claimAt(bucket, 401).instanceId).toBe("engine-live");
	});

	it("treats an expired claim as an empty slot for a retriever, not as a call elsewhere", async () => {
		let now = NOW;
		const bucket = new FakeClaimBucket<ParkClaim>();
		const dead = new ParkRegistry();
		dead.bindClaims(bucket, "engine-dead", () => now);
		await parkedSlot(dead, "c1");

		now = NOW + CLAIM_LEASE_MS + 1;
		const live = new ParkRegistry();
		live.bindClaims(bucket.peer(), "engine-live", () => now);
		expect((await live.claim(LOT_ID, 401, ORG)).kind).toBe("absent");
	});

	it("does not take over a claim that is still within its lease", async () => {
		const bucket = new FakeClaimBucket<ParkClaim>();
		const owner = new ParkRegistry();
		owner.bindClaims(bucket, "engine-a", () => NOW);
		await parkedSlot(owner, "c1");

		const other = new ParkRegistry();
		other.bindClaims(bucket.peer(), "engine-b", () => NOW + CLAIM_LEASE_MS - 1);
		expect(await other.park(LOT, entry("c2"), 401)).toEqual({
			kind: "slot-unavailable",
			slot: 401,
		});
	});
});

describe("the heartbeat", () => {
	it("pushes every held claim's expiry forward", async () => {
		let now = NOW;
		const bucket = new FakeClaimBucket<ParkClaim>();
		const registry = new ParkRegistry();
		registry.bindClaims(bucket, "engine-a", () => now);
		await parkedSlot(registry, "c1");

		now = NOW + 30_000;
		expect(await registry.heartbeat()).toBe(1);
		expect(claimAt(bucket, 401).expiresAt).toBe(now + CLAIM_LEASE_MS);
	});

	it("drops a claim another instance took over rather than fighting for it", async () => {
		let now = NOW;
		const bucket = new FakeClaimBucket<ParkClaim>();
		const registry = new ParkRegistry();
		registry.bindClaims(bucket, "engine-a", () => now);
		await parkedSlot(registry, "c1");

		// Somebody reaped it: the revision this instance holds is now stale.
		const key = kvKeyFor.parkClaim(ORG, LOT_ID, 401);
		const stolen = bucket.entries.get(key) as { value: ParkClaim; revision: number };
		await bucket.update(key, { ...stolen.value, instanceId: "engine-b" }, stolen.revision);

		now = NOW + 30_000;
		expect(await registry.heartbeat()).toBe(0);
		expect(registry.at(LOT_ID, 401)).toBeUndefined();
	});

	it("keeps a claim it could not renew, because the lease outlives a blip", async () => {
		const bucket = new FakeClaimBucket<ParkClaim>();
		const registry = new ParkRegistry();
		registry.bindClaims(bucket, "engine-a", () => NOW);
		await parkedSlot(registry, "c1");

		bucket.failing = true;
		expect(await registry.heartbeat()).toBe(0);
		expect(registry.at(LOT_ID, 401)?.mediaChannelId).toBe("c1");
	});

	it("does nothing at all when claims are not shared", async () => {
		const registry = new ParkRegistry();
		await parkedSlot(registry, "c1");
		expect(await registry.heartbeat()).toBe(0);
	});
});

/**
 * The degradation decision, asserted rather than documented: a bucket that is CONFIGURED and
 * unreachable refuses the park. Falling back to a local claim would be the split-brain the bucket
 * exists to prevent, arriving during the incident when nobody is watching park lots.
 */
describe("when a configured bucket cannot be reached", () => {
	it("refuses the park loudly rather than parking on a local claim", async () => {
		const bucket = new FakeClaimBucket<ParkClaim>({ failing: true });
		const registry = new ParkRegistry();
		registry.bindClaims(bucket, "engine-a", () => NOW);

		const result = await registry.park(LOT, entry("c1"));
		expect(result.kind).toBe("claims-unavailable");
		expect(registry.parkedCount).toBe(0);
	});

	it("carries the broker's own reason, because the operator reading it is who can fix it", async () => {
		const bucket = new FakeClaimBucket<ParkClaim>({ failing: true });
		const registry = new ParkRegistry();
		registry.bindClaims(bucket, "engine-a", () => NOW);
		const result = await registry.park(LOT, entry("c1"));
		expect(result.kind === "claims-unavailable" && result.reason).toContain("failing");
	});

	it("refuses a restore rather than putting a call in an unclaimed orbit", async () => {
		const bucket = new FakeClaimBucket<ParkClaim>();
		const registry = new ParkRegistry();
		registry.bindClaims(bucket, "engine-a", () => NOW);
		await parkedSlot(registry, "c1");
		const claimed = await registry.claim(LOT_ID, 401, ORG);

		bucket.failing = true;
		expect(await registry.restore((claimed as { entry: ParkedCall }).entry)).toBe(false);
	});

	it("refuses a park whose ids cannot form a key, rather than parking unclaimed", async () => {
		const bucket = new FakeClaimBucket<ParkClaim>();
		const registry = new ParkRegistry();
		registry.bindClaims(bucket, "engine-a", () => NOW);
		const result = await registry.park(LOT, { ...entry("c1"), parkLotId: "lot.with.dots" });
		expect(result.kind).toBe("claims-unavailable");
	});
});

describe("parkSlotFor", () => {
	it("accepts a dialled orbit inside the lot and rejects everything else", () => {
		expect(parkSlotFor(LOT, "402")).toBe(402);
		expect(parkSlotFor(LOT, "404")).toBeUndefined();
		expect(parkSlotFor(LOT, "40a")).toBeUndefined();
		expect(parkSlotFor(LOT, "")).toBeUndefined();
	});
});
