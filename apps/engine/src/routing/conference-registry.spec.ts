import { describe, expect, it } from "bun:test";
import { kvKeyFor } from "@optimiq-voice/events";
import { FakeClaimBucket } from "../nats/claim-store.fake";
import { ConferenceRegistry } from "./conference-registry";
import { CLAIM_LEASE_MS } from "./park-registry";
import type { ConferenceMember } from "./conference-registry";
import type { ConferenceClaim } from "@optimiq-voice/events";

/**
 * The registry's own edges.
 *
 * `plan-walker-conference.spec.ts` proves the paths a call actually takes. This file proves the
 * ones a call takes only when something has already gone wrong — a walk that aborted between the
 * media call and the registry call, a room that empties while somebody is holding in it — because
 * those are the paths that turn a hangup into a leaked bridge or a caller held forever.
 */

const ROOM = "conf-1";
const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const OTHER_ORG = "0195c0f0-1c2f-7000-8000-000000000002";
const NOW = 1_700_000_000_000;

function member(id: string, moderator = false): ConferenceMember {
	return { mediaChannelId: id, legId: `leg-${id}`, moderator, joinedAtMs: 0 };
}

describe("joining", () => {
	it("tells the first member it owns a bridge that has to be created", async () => {
		const registry = new ConferenceRegistry();
		const first = await registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		const second = await registry.join(ROOM, member("b"), { newBridgeId: "b-2", maxMembers: 0 });

		expect(first).toMatchObject({ kind: "joined", created: true });
		expect(second).toMatchObject({ kind: "joined", created: false });
		// The second member's proposed bridge id is discarded: one room, one bridge.
		expect((second as { room: { bridgeId: string } }).room.bridgeId).toBe("b-1");
	});

	it("treats maxMembers 0 as no limit, which is what pbx-db's default means", async () => {
		const registry = new ConferenceRegistry();
		for (const id of ["a", "b", "c", "d"]) {
			expect(
				(await registry.join(ROOM, member(id), { newBridgeId: "b-1", maxMembers: 0 })).kind,
			).toBe("joined");
		}
	});

	it("refuses the member past the limit without disturbing the room", async () => {
		const registry = new ConferenceRegistry();
		await registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 1 });
		const refused = await registry.join(ROOM, member("b"), { newBridgeId: "b-2", maxMembers: 1 });

		expect(refused).toEqual({ kind: "full", memberCount: 1 });
		expect(registry.room(ROOM)?.members).toHaveLength(1);
	});

	it("never lets the FIRST member be refused, whatever the limit says", async () => {
		// A room configured with `maxMembers: 1` is a room one person can use, not a room nobody can.
		const registry = new ConferenceRegistry();
		expect(
			(await registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 1 })).kind,
		).toBe("joined");
	});

	it("keeps identical conference ids separate across organizations in local mode", async () => {
		const registry = new ConferenceRegistry();
		const first = await registry.join(ROOM, member("org-a"), {
			newBridgeId: "bridge-a",
			maxMembers: 0,
			organizationId: ORG,
		});
		const second = await registry.join(ROOM, member("org-b"), {
			newBridgeId: "bridge-b",
			maxMembers: 0,
			organizationId: OTHER_ORG,
		});

		expect(first).toMatchObject({ kind: "joined", created: true });
		expect(second).toMatchObject({ kind: "joined", created: true });
		expect(registry.room(ROOM, ORG)?.bridgeId).toBe("bridge-a");
		expect(registry.room(ROOM, OTHER_ORG)?.bridgeId).toBe("bridge-b");
		expect(registry.room(ROOM)).toBeUndefined();

		await registry.leave(ROOM, "org-a", ORG);
		expect(registry.room(ROOM, ORG)).toBeUndefined();
		expect(registry.room(ROOM, OTHER_ORG)?.members[0]?.mediaChannelId).toBe("org-b");
	});
});

describe("leaving", () => {
	it("reports the room as emptied so the caller knows to destroy the bridge", async () => {
		const registry = new ConferenceRegistry();
		await registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });

		expect(await registry.leave(ROOM, "a")).toMatchObject({ memberCount: 0, emptied: true });
		expect(registry.room(ROOM)).toBeUndefined();
		expect(registry.roomCount).toBe(0);
	});

	it("does not throw for a member who is not in the room", async () => {
		// A walk that aborted between the media call and the registry call produces exactly this,
		// and a throw on the teardown path is worse than a no-op.
		const registry = new ConferenceRegistry();
		expect(await registry.leave(ROOM, "ghost")).toEqual({ memberCount: 0, emptied: false });

		await registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		expect(await registry.leave(ROOM, "ghost")).toMatchObject({ memberCount: 1, emptied: false });
	});

	it("gives the departing member back, so the leave event can say who it was", async () => {
		const registry = new ConferenceRegistry();
		await registry.join(ROOM, member("a", true), { newBridgeId: "b-1", maxMembers: 0 });
		expect((await registry.leave(ROOM, "a")).member?.moderator).toBe(true);
	});

	it("drops the room, so the next caller does not join a bridge that was torn down", async () => {
		const registry = new ConferenceRegistry();
		await registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		await registry.leave(ROOM, "a");
		const rejoin = await registry.join(ROOM, member("b"), { newBridgeId: "b-2", maxMembers: 0 });

		expect(rejoin).toMatchObject({ kind: "joined", created: true });
		expect((rejoin as { room: { bridgeId: string } }).room.bridgeId).toBe("b-2");
	});
});

describe("waiting for a moderator", () => {
	it("resolves immediately when one is already in the room", async () => {
		const registry = new ConferenceRegistry();
		await registry.join(ROOM, member("a", true), { newBridgeId: "b-1", maxMembers: 0 });
		await expect(registry.awaitModerator(ROOM).arrived).resolves.toBeUndefined();
	});

	it("resolves immediately for a room nobody is in", async () => {
		// Not a hang: the caller re-checks `moderatorPresent` afterwards and decides for itself.
		const registry = new ConferenceRegistry();
		await expect(registry.awaitModerator(ROOM).arrived).resolves.toBeUndefined();
	});

	it("resolves when a moderator joins", async () => {
		const registry = new ConferenceRegistry();
		await registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		const waiter = registry.awaitModerator(ROOM);
		await registry.join(ROOM, member("b", true), { newBridgeId: "b-2", maxMembers: 0 });
		await expect(waiter.arrived).resolves.toBeUndefined();
	});

	it("does not resolve when another participant joins", async () => {
		const registry = new ConferenceRegistry();
		await registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		const waiter = registry.awaitModerator(ROOM);
		await registry.join(ROOM, member("b"), { newBridgeId: "b-2", maxMembers: 0 });

		const raced = await Promise.race([
			waiter.arrived.then(() => "arrived"),
			Promise.resolve("still waiting"),
		]);
		expect(raced).toBe("still waiting");
	});

	it("releases a waiter when the room empties, rather than holding it forever", async () => {
		const registry = new ConferenceRegistry();
		await registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		const waiter = registry.awaitModerator(ROOM);
		await registry.leave(ROOM, "a");
		await expect(waiter.arrived).resolves.toBeUndefined();
	});

	it("survives a cancel after it has already resolved", async () => {
		const registry = new ConferenceRegistry();
		await registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		const waiter = registry.awaitModerator(ROOM);
		await registry.join(ROOM, member("b", true), { newBridgeId: "b-2", maxMembers: 0 });
		await waiter.arrived;
		expect(() => {
			waiter.cancel();
			waiter.cancel();
		}).not.toThrow();
	});
});

// ---------------------------------------------------------------------------------------------
// Shared claims
// ---------------------------------------------------------------------------------------------

/** Instance A and instance B, sharing one bucket exactly as two engines behind one Asterisk do. */
function cluster(now: () => number = () => NOW): {
	readonly a: ConferenceRegistry;
	readonly b: ConferenceRegistry;
	readonly bucket: FakeClaimBucket<ConferenceClaim>;
} {
	const bucket = new FakeClaimBucket<ConferenceClaim>();
	const a = new ConferenceRegistry();
	const b = new ConferenceRegistry();
	a.bindClaims(bucket, "engine-a", now);
	b.bindClaims(bucket.peer(), "engine-b", now);
	return { a, b, bucket };
}

const OPTIONS = { maxMembers: 0, organizationId: ORG } as const;

/**
 * The split this whole mechanism exists to prevent: two instances each minting their own bridge for
 * room 3001, everybody hearing music and nobody hearing anybody.
 */
describe("two engine instances in one room", () => {
	it("makes the second instance join the FIRST one's bridge", async () => {
		const { a, b } = cluster();
		await a.join(ROOM, member("a"), { newBridgeId: "b-1", ...OPTIONS });
		const second = await b.join(ROOM, member("b"), { newBridgeId: "b-2", ...OPTIONS });

		expect(second.kind).toBe("joined");
		expect((second as { room: { bridgeId: string } }).room.bridgeId).toBe("b-1");
	});

	it("tells the second instance to create the bridge too, because the id is an upsert", async () => {
		const { a, b } = cluster();
		await a.join(ROOM, member("a"), { newBridgeId: "b-1", ...OPTIONS });
		const second = await b.join(ROOM, member("b"), { newBridgeId: "b-2", ...OPTIONS });
		expect(second).toMatchObject({ created: true });
	});

	it("counts members across the cluster, which is what makes maxMembers a cap", async () => {
		const { a, b } = cluster();
		await a.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 2, organizationId: ORG });
		const second = await b.join(ROOM, member("b"), {
			newBridgeId: "b-2",
			maxMembers: 2,
			organizationId: ORG,
		});
		expect(second.kind).toBe("joined");

		const third = await b.join(ROOM, member("c"), {
			newBridgeId: "b-3",
			maxMembers: 2,
			organizationId: ORG,
		});
		expect(third).toEqual({ kind: "full", memberCount: 2 });
	});

	it("decrements the cluster count when somebody leaves, freeing the seat", async () => {
		const { a, b } = cluster();
		await a.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 2, organizationId: ORG });
		await b.join(ROOM, member("b"), { newBridgeId: "b-2", maxMembers: 2, organizationId: ORG });
		await b.leave(ROOM, "b");

		expect(
			(await b.join(ROOM, member("c"), { newBridgeId: "b-3", maxMembers: 2, organizationId: ORG }))
				.kind,
		).toBe("joined");
	});

	it("does not let the last member on one instance destroy a bridge others are still in", async () => {
		const { a, b } = cluster();
		await a.join(ROOM, member("a"), { newBridgeId: "b-1", ...OPTIONS });
		await b.join(ROOM, member("b"), { newBridgeId: "b-2", ...OPTIONS });

		const departure = await a.leave(ROOM, "a");
		expect(departure.memberCount).toBe(1);
		// `emptied` is "may I destroy the bridge?" and the answer here is no.
		expect(departure.emptied).toBe(false);
	});

	it("releases the room's key when the last member anywhere leaves", async () => {
		const { a, b, bucket } = cluster();
		await a.join(ROOM, member("a"), { newBridgeId: "b-1", ...OPTIONS });
		await b.join(ROOM, member("b"), { newBridgeId: "b-2", ...OPTIONS });
		await a.leave(ROOM, "a");
		expect(bucket.size).toBe(1);

		const last = await b.leave(ROOM, "b");
		expect(last.emptied).toBe(true);
		expect(bucket.size).toBe(0);
	});

	it("takes over a room whose owning instance stopped heartbeating", async () => {
		let now = NOW;
		const bucket = new FakeClaimBucket<ConferenceClaim>();
		const dead = new ConferenceRegistry();
		dead.bindClaims(bucket, "engine-dead", () => now);
		await dead.join(ROOM, member("a"), { newBridgeId: "b-dead", ...OPTIONS });

		now = NOW + CLAIM_LEASE_MS;
		const live = new ConferenceRegistry();
		live.bindClaims(bucket.peer(), "engine-live", () => now);
		const joined = await live.join(ROOM, member("b"), { newBridgeId: "b-live", ...OPTIONS });
		// A fresh room: the previous owner's bridge went with the process that made it.
		expect((joined as { room: { bridgeId: string } }).room.bridgeId).toBe("b-live");
	});
});

describe("a moderator on another instance", () => {
	it("is invisible to a local waiter until the claim is re-read", async () => {
		const { a, b } = cluster();
		await a.join(ROOM, member("a"), { newBridgeId: "b-1", ...OPTIONS });
		const waiter = a.awaitModerator(ROOM);
		await b.join(ROOM, member("m", true), { newBridgeId: "b-2", ...OPTIONS });

		const raced = await Promise.race([
			waiter.arrived.then(() => "arrived"),
			Promise.resolve("still waiting"),
		]);
		expect(raced).toBe("still waiting");
	});

	it("wakes the local waiter on a refresh, which is what the held caller polls", async () => {
		const { a, b } = cluster();
		await a.join(ROOM, member("a"), { newBridgeId: "b-1", ...OPTIONS });
		const waiter = a.awaitModerator(ROOM);
		await b.join(ROOM, member("m", true), { newBridgeId: "b-2", ...OPTIONS });

		expect(await a.refresh(ROOM)).toBe(true);
		await expect(waiter.arrived).resolves.toBeUndefined();
	});

	it("reports no moderator from a refresh when there still is not one", async () => {
		const { a, b } = cluster();
		await a.join(ROOM, member("a"), { newBridgeId: "b-1", ...OPTIONS });
		await b.join(ROOM, member("b"), { newBridgeId: "b-2", ...OPTIONS });
		expect(await a.refresh(ROOM)).toBe(false);
	});

	it("is a no-op for a room this instance is not in", async () => {
		const { a } = cluster();
		expect(await a.refresh(ROOM)).toBe(false);
	});
});

describe("the conference heartbeat", () => {
	it("pushes the room's expiry forward", async () => {
		let now = NOW;
		const bucket = new FakeClaimBucket<ConferenceClaim>();
		const registry = new ConferenceRegistry();
		registry.bindClaims(bucket, "engine-a", () => now);
		await registry.join(ROOM, member("a"), { newBridgeId: "b-1", ...OPTIONS });

		now = NOW + 30_000;
		expect(await registry.heartbeat()).toBe(1);
		const claim = bucket.entries.get(kvKeyFor.conferenceClaim(ORG, ROOM))?.value as ConferenceClaim;
		// Expiry lives per contribution now — the claim is held jointly, and a top-level expiry
		// would let one instance's silence kill a room other instances are still heartbeating.
		expect(claim.contributions["engine-a"]?.expiresAt).toBe(now + CLAIM_LEASE_MS);
	});

	/**
	 * A conference claim is held JOINTLY. Another instance renewing it first is normal, not a
	 * takeover — the room must survive it, unlike a park claim, where a lost heartbeat means the
	 * orbit now belongs to somebody else.
	 */
	it("adopts a revision another participant's instance wrote, rather than dropping the room", async () => {
		const { a, b } = cluster();
		await a.join(ROOM, member("a"), { newBridgeId: "b-1", ...OPTIONS });
		await b.join(ROOM, member("b"), { newBridgeId: "b-2", ...OPTIONS });
		// B's join moved the revision, so A's is stale.
		expect(await a.heartbeat()).toBe(0);
		expect(a.room(ROOM)?.members).toHaveLength(1);
		// And the next heartbeat, on the adopted revision, succeeds.
		expect(await a.heartbeat()).toBe(1);
	});

	it("does nothing at all when claims are not shared", async () => {
		const registry = new ConferenceRegistry();
		await registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		expect(await registry.heartbeat()).toBe(0);
	});
});

/**
 * The degradation decision. A joiner that proceeded on an unrecorded claim is one caller alone in a
 * bridge they believe is a meeting, which is worse than being told the room is unavailable.
 */
describe("when a configured bucket cannot be reached", () => {
	it("refuses the join rather than creating a bridge nobody else agrees on", async () => {
		const bucket = new FakeClaimBucket<ConferenceClaim>({ failing: true });
		const registry = new ConferenceRegistry();
		registry.bindClaims(bucket, "engine-a", () => NOW);

		const joined = await registry.join(ROOM, member("a"), { newBridgeId: "b-1", ...OPTIONS });
		expect(joined.kind).toBe("claims-unavailable");
		expect(registry.roomCount).toBe(0);
	});

	it("does not attempt to create a room after its claim read is unavailable", async () => {
		const bucket = new FakeClaimBucket<ConferenceClaim>({ failing: true });
		const registry = new ConferenceRegistry();
		registry.bindClaims(bucket, "engine-a", () => NOW);

		expect(
			await registry.join(ROOM, member("a"), { newBridgeId: "b-1", ...OPTIONS }),
		).toMatchObject({
			kind: "claims-unavailable",
		});
		expect(bucket.calls.map((call) => call.method)).toEqual(["get"]);
	});

	it("refuses a join with no organization, because there is no key to claim under", async () => {
		const bucket = new FakeClaimBucket<ConferenceClaim>();
		const registry = new ConferenceRegistry();
		registry.bindClaims(bucket, "engine-a", () => NOW);
		const joined = await registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		expect(joined.kind).toBe("claims-unavailable");
	});

	it("still lets an unshared registry join with no organization at all", async () => {
		const registry = new ConferenceRegistry();
		const joined = await registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		expect(joined.kind).toBe("joined");
	});

	it("lets a leave succeed locally rather than stranding a member in a room they left", async () => {
		const bucket = new FakeClaimBucket<ConferenceClaim>();
		const registry = new ConferenceRegistry();
		registry.bindClaims(bucket, "engine-a", () => NOW);
		await registry.join(ROOM, member("a"), { newBridgeId: "b-1", ...OPTIONS });

		bucket.failing = true;
		const departure = await registry.leave(ROOM, "a");
		expect(departure.member?.mediaChannelId).toBe("a");
		expect(registry.room(ROOM)).toBeUndefined();
	});
});
