import { describe, expect, it } from "bun:test";
import { ParkRegistry, parkSlotFor } from "./park-registry";
import type { ParkedCall } from "./park-registry";

const LOT = { slotStart: 401, slotEnd: 403 };
const LOT_ID = "0195c0f0-1c2f-7000-8000-0000000000f1";

function entry(mediaChannelId: string): Omit<ParkedCall, "slot"> {
	return {
		parkLotId: LOT_ID,
		mediaChannelId,
		legId: `leg-${mediaChannelId}`,
		callId: `call-${mediaChannelId}`,
		organizationId: "0195c0f0-1c2f-7000-8000-000000000001",
		parkedAtMs: 1_000,
	};
}

function parkedSlot(registry: ParkRegistry, channel: string): number {
	const result = registry.park(LOT, entry(channel));
	if (result.kind !== "parked") {
		throw new Error(`expected a park, got ${result.kind}`);
	}
	return result.entry.slot;
}

describe("claiming an orbit", () => {
	it("hands out the lowest free slot and remembers who is in it", () => {
		const registry = new ParkRegistry();
		expect(parkedSlot(registry, "c1")).toBe(401);
		expect(parkedSlot(registry, "c2")).toBe(402);
		expect(registry.at(LOT_ID, 401)?.mediaChannelId).toBe("c1");
		expect(registry.forChannel("c2")?.slot).toBe(402);
		expect(registry.parkedCount).toBe(2);
	});

	it("lists a lot in slot order regardless of arrival order", () => {
		const registry = new ParkRegistry();
		registry.park(LOT, entry("c3"), 403);
		registry.park(LOT, entry("c1"), 401);
		expect(registry.lot(LOT_ID).map((call) => call.slot)).toEqual([401, 403]);
	});

	it("refuses a full lot rather than overwriting an occupant", () => {
		const registry = new ParkRegistry();
		parkedSlot(registry, "c1");
		parkedSlot(registry, "c2");
		parkedSlot(registry, "c3");
		const result = registry.park(LOT, entry("c4"));
		expect(result).toEqual({ kind: "lot-full", capacity: 3 });
		expect(registry.at(LOT_ID, 401)?.mediaChannelId).toBe("c1");
	});

	it("refuses a requested orbit that is taken — somebody has already announced that number", () => {
		const registry = new ParkRegistry();
		registry.park(LOT, entry("c1"), 402);
		expect(registry.park(LOT, entry("c2"), 402)).toEqual({ kind: "slot-unavailable", slot: 402 });
		expect(registry.at(LOT_ID, 402)?.mediaChannelId).toBe("c1");
	});

	it("refuses an orbit outside the lot", () => {
		const registry = new ParkRegistry();
		expect(registry.park(LOT, entry("c1"), 999)).toEqual({ kind: "slot-unavailable", slot: 999 });
	});

	it("keeps lots separate — slot 401 exists in each of them", () => {
		const registry = new ParkRegistry();
		registry.park(LOT, entry("c1"), 401);
		registry.park(LOT, { ...entry("c2"), parkLotId: "other-lot" }, 401);
		expect(registry.at(LOT_ID, 401)?.mediaChannelId).toBe("c1");
		expect(registry.at("other-lot", 401)?.mediaChannelId).toBe("c2");
	});
});

describe("retrieval", () => {
	it("is exclusive: two retrievals of one slot produce one winner", () => {
		const registry = new ParkRegistry();
		parkedSlot(registry, "c1");
		expect(registry.claim(LOT_ID, 401)?.mediaChannelId).toBe("c1");
		// The loser is told the truth rather than bridged to a caller somebody else already has.
		expect(registry.claim(LOT_ID, 401)).toBeUndefined();
	});

	it("returns undefined for an empty slot and for an unknown lot", () => {
		const registry = new ParkRegistry();
		expect(registry.claim(LOT_ID, 401)).toBeUndefined();
		expect(registry.claim("nope", 401)).toBeUndefined();
	});

	it("forgets the channel index too, so a later release is a no-op", () => {
		const registry = new ParkRegistry();
		parkedSlot(registry, "c1");
		registry.claim(LOT_ID, 401);
		expect(registry.forChannel("c1")).toBeUndefined();
		expect(registry.release("c1")).toBeUndefined();
		expect(registry.parkedCount).toBe(0);
	});

	it("puts a failed retrieval back in its own slot rather than stranding the call", () => {
		const registry = new ParkRegistry();
		parkedSlot(registry, "c1");
		const claimed = registry.claim(LOT_ID, 401) as ParkedCall;
		expect(registry.restore(claimed)).toBe(true);
		expect(registry.at(LOT_ID, 401)?.mediaChannelId).toBe("c1");
	});

	it("refuses to restore into a slot somebody else has taken in the meantime", () => {
		const registry = new ParkRegistry();
		parkedSlot(registry, "c1");
		const claimed = registry.claim(LOT_ID, 401) as ParkedCall;
		registry.park(LOT, entry("c2"), 401);
		expect(registry.restore(claimed)).toBe(false);
		expect(registry.at(LOT_ID, 401)?.mediaChannelId).toBe("c2");
	});
});

describe("release", () => {
	it("frees the slot a hung-up leg was holding", () => {
		const registry = new ParkRegistry();
		parkedSlot(registry, "c1");
		expect(registry.release("c1")?.slot).toBe(401);
		expect(registry.at(LOT_ID, 401)).toBeUndefined();
		// And the freed orbit is the next one handed out.
		expect(parkedSlot(registry, "c2")).toBe(401);
	});

	it("is a no-op for a leg that was never parked", () => {
		const registry = new ParkRegistry();
		expect(registry.release("ghost")).toBeUndefined();
	});

	it("drops everything on clear", () => {
		const registry = new ParkRegistry();
		parkedSlot(registry, "c1");
		registry.clear();
		expect(registry.parkedCount).toBe(0);
		expect(registry.lot(LOT_ID)).toEqual([]);
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
