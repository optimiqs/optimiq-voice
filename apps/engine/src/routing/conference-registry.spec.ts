import { describe, expect, it } from "bun:test";
import { ConferenceRegistry } from "./conference-registry";
import type { ConferenceMember } from "./conference-registry";

/**
 * The registry's own edges.
 *
 * `plan-walker-conference.spec.ts` proves the paths a call actually takes. This file proves the
 * ones a call takes only when something has already gone wrong — a walk that aborted between the
 * media call and the registry call, a room that empties while somebody is holding in it — because
 * those are the paths that turn a hangup into a leaked bridge or a caller held forever.
 */

const ROOM = "conf-1";

function member(id: string, moderator = false): ConferenceMember {
	return { mediaChannelId: id, legId: `leg-${id}`, moderator, joinedAtMs: 0 };
}

describe("joining", () => {
	it("tells the first member it owns a bridge that has to be created", () => {
		const registry = new ConferenceRegistry();
		const first = registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		const second = registry.join(ROOM, member("b"), { newBridgeId: "b-2", maxMembers: 0 });

		expect(first).toMatchObject({ kind: "joined", created: true });
		expect(second).toMatchObject({ kind: "joined", created: false });
		// The second member's proposed bridge id is discarded: one room, one bridge.
		expect((second as { room: { bridgeId: string } }).room.bridgeId).toBe("b-1");
	});

	it("treats maxMembers 0 as no limit, which is what pbx-db's default means", () => {
		const registry = new ConferenceRegistry();
		for (const id of ["a", "b", "c", "d"]) {
			expect(registry.join(ROOM, member(id), { newBridgeId: "b-1", maxMembers: 0 }).kind).toBe(
				"joined",
			);
		}
	});

	it("refuses the member past the limit without disturbing the room", () => {
		const registry = new ConferenceRegistry();
		registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 1 });
		const refused = registry.join(ROOM, member("b"), { newBridgeId: "b-2", maxMembers: 1 });

		expect(refused).toEqual({ kind: "full", memberCount: 1 });
		expect(registry.room(ROOM)?.members).toHaveLength(1);
	});

	it("never lets the FIRST member be refused, whatever the limit says", () => {
		// A room configured with `maxMembers: 1` is a room one person can use, not a room nobody can.
		const registry = new ConferenceRegistry();
		expect(registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 1 }).kind).toBe(
			"joined",
		);
	});
});

describe("leaving", () => {
	it("reports the room as emptied so the caller knows to destroy the bridge", () => {
		const registry = new ConferenceRegistry();
		registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });

		expect(registry.leave(ROOM, "a")).toMatchObject({ memberCount: 0, emptied: true });
		expect(registry.room(ROOM)).toBeUndefined();
		expect(registry.roomCount).toBe(0);
	});

	it("does not throw for a member who is not in the room", () => {
		// A walk that aborted between the media call and the registry call produces exactly this,
		// and a throw on the teardown path is worse than a no-op.
		const registry = new ConferenceRegistry();
		expect(registry.leave(ROOM, "ghost")).toEqual({ memberCount: 0, emptied: false });

		registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		expect(registry.leave(ROOM, "ghost")).toMatchObject({ memberCount: 1, emptied: false });
	});

	it("gives the departing member back, so the leave event can say who it was", () => {
		const registry = new ConferenceRegistry();
		registry.join(ROOM, member("a", true), { newBridgeId: "b-1", maxMembers: 0 });
		expect(registry.leave(ROOM, "a").member?.moderator).toBe(true);
	});

	it("drops the room, so the next caller does not join a bridge that was torn down", () => {
		const registry = new ConferenceRegistry();
		registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		registry.leave(ROOM, "a");
		const rejoin = registry.join(ROOM, member("b"), { newBridgeId: "b-2", maxMembers: 0 });

		expect(rejoin).toMatchObject({ kind: "joined", created: true });
		expect((rejoin as { room: { bridgeId: string } }).room.bridgeId).toBe("b-2");
	});
});

describe("waiting for a moderator", () => {
	it("resolves immediately when one is already in the room", async () => {
		const registry = new ConferenceRegistry();
		registry.join(ROOM, member("a", true), { newBridgeId: "b-1", maxMembers: 0 });
		await expect(registry.awaitModerator(ROOM).arrived).resolves.toBeUndefined();
	});

	it("resolves immediately for a room nobody is in", async () => {
		// Not a hang: the caller re-checks `moderatorPresent` afterwards and decides for itself.
		const registry = new ConferenceRegistry();
		await expect(registry.awaitModerator(ROOM).arrived).resolves.toBeUndefined();
	});

	it("resolves when a moderator joins", async () => {
		const registry = new ConferenceRegistry();
		registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		const waiter = registry.awaitModerator(ROOM);
		registry.join(ROOM, member("b", true), { newBridgeId: "b-2", maxMembers: 0 });
		await expect(waiter.arrived).resolves.toBeUndefined();
	});

	it("does not resolve when another participant joins", async () => {
		const registry = new ConferenceRegistry();
		registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		const waiter = registry.awaitModerator(ROOM);
		registry.join(ROOM, member("b"), { newBridgeId: "b-2", maxMembers: 0 });

		const raced = await Promise.race([
			waiter.arrived.then(() => "arrived"),
			Promise.resolve("still waiting"),
		]);
		expect(raced).toBe("still waiting");
	});

	it("releases a waiter when the room empties, rather than holding it forever", async () => {
		const registry = new ConferenceRegistry();
		registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		const waiter = registry.awaitModerator(ROOM);
		registry.leave(ROOM, "a");
		await expect(waiter.arrived).resolves.toBeUndefined();
	});

	it("survives a cancel after it has already resolved", async () => {
		const registry = new ConferenceRegistry();
		registry.join(ROOM, member("a"), { newBridgeId: "b-1", maxMembers: 0 });
		const waiter = registry.awaitModerator(ROOM);
		registry.join(ROOM, member("b", true), { newBridgeId: "b-2", maxMembers: 0 });
		await waiter.arrived;
		expect(() => {
			waiter.cancel();
			waiter.cancel();
		}).not.toThrow();
	});
});
