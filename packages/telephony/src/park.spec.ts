import { describe, expect, it } from "bun:test";
import { VALID_CHANNEL_TRANSITIONS } from "./channel-state";
import { InvalidParkTransitionError } from "./errors";
import {
	assertParkTransition,
	INITIAL_PARK_STATE,
	isParkEndReason,
	isParkSlotInRange,
	isParkState,
	isTerminalParkState,
	isUsableParkSlotRange,
	isValidParkTransition,
	nextFreeParkSlot,
	PARK_END_REASONS,
	PARK_STATES,
	PARK_TERMINAL_STATES,
	parkEndReasonFor,
	parkSlotCapacity,
	parkTransitionsFrom,
	parseParkSlot,
	VALID_PARK_TRANSITIONS,
} from "./park";
import type { ParkState } from "./park";

const LOT = { slotStart: 401, slotEnd: 405 };

function reachableFrom(start: ParkState): ReadonlySet<ParkState> {
	const seen = new Set<ParkState>();
	const pending: ParkState[] = [start];
	while (pending.length > 0) {
		const state = pending.pop() as ParkState;
		if (seen.has(state)) {
			continue;
		}
		seen.add(state);
		pending.push(...parkTransitionsFrom(state));
	}
	return seen;
}

describe("the park machine", () => {
	it("is total over its own state list", () => {
		expect(Object.keys(VALID_PARK_TRANSITIONS).sort()).toEqual([...PARK_STATES].sort());
		expect(new Set(PARK_STATES).size).toBe(PARK_STATES.length);
	});

	it("starts at parking", () => {
		expect(INITIAL_PARK_STATE).toBe("parking");
		expect(isParkState(INITIAL_PARK_STATE)).toBe(true);
	});

	it("has four terminals with no outgoing edges", () => {
		for (const state of PARK_STATES) {
			expect(isTerminalParkState(state)).toBe(
				(PARK_TERMINAL_STATES as readonly string[]).includes(state),
			);
			if (isTerminalParkState(state)) {
				expect(parkTransitionsFrom(state)).toEqual([]);
			}
		}
		expect(PARK_TERMINAL_STATES.length).toBe(4);
	});

	it("reaches retrieved only from retrieving — the claim is what decides the race for a slot", () => {
		const predecessors = PARK_STATES.filter((state) =>
			(parkTransitionsFrom(state) as readonly string[]).includes("retrieved"),
		);
		expect(predecessors).toEqual(["retrieving"]);
	});

	it("lets the caller hang up from every live stage", () => {
		for (const state of PARK_STATES) {
			if (isTerminalParkState(state)) {
				continue;
			}
			expect(isValidParkTransition(state, "abandoned")).toBe(true);
		}
	});

	it("puts a failed retrieval back in its slot rather than stranding the call", () => {
		expect(isValidParkTransition("retrieving", "parked")).toBe(true);
	});

	it("times out only from parked — a call being collected is no longer waiting", () => {
		const predecessors = PARK_STATES.filter((state) =>
			(parkTransitionsFrom(state) as readonly string[]).includes("timed-out"),
		);
		expect(predecessors).toEqual(["parked"]);
	});

	it("never lists a state as its own successor, and reaches every state from parking", () => {
		for (const state of PARK_STATES) {
			expect(parkTransitionsFrom(state)).not.toContain(state);
		}
		const reachable = reachableFrom("parking");
		for (const state of PARK_STATES) {
			expect(reachable.has(state)).toBe(true);
		}
	});
});

describe("assertParkTransition", () => {
	it("passes an existing edge and throws on one the machine does not have", () => {
		expect(() => {
			assertParkTransition("parked", "retrieving");
		}).not.toThrow();
		expect(() => {
			assertParkTransition("timed-out", "retrieved");
		}).toThrow(InvalidParkTransitionError);
	});

	it("carries both endpoints on the error", () => {
		try {
			assertParkTransition("abandoned", "parked");
			throw new Error("expected a throw");
		} catch (error) {
			expect((error as InvalidParkTransitionError).from).toBe("abandoned");
			expect((error as InvalidParkTransitionError).to).toBe("parked");
		}
	});
});

describe("end reasons", () => {
	it("maps every terminal but failed onto a wire reason", () => {
		expect(parkEndReasonFor("retrieved")).toBe("retrieved");
		expect(parkEndReasonFor("timed-out")).toBe("timeout");
		expect(parkEndReasonFor("abandoned")).toBe("abandoned");
		// A park that never happened has nothing to un-park.
		expect(parkEndReasonFor("failed")).toBeUndefined();
		expect(parkEndReasonFor("parked")).toBeUndefined();
	});

	it("recognises the wire vocabulary", () => {
		for (const reason of PARK_END_REASONS) {
			expect(isParkEndReason(reason)).toBe(true);
		}
		expect(isParkEndReason("retrieving")).toBe(false);
	});
});

describe("slot arithmetic", () => {
	it("measures a lot's capacity inclusively", () => {
		expect(parkSlotCapacity(LOT)).toBe(5);
		expect(parkSlotCapacity({ slotStart: 401, slotEnd: 401 })).toBe(1);
	});

	it("rejects a range that ends before it starts, or is not whole", () => {
		expect(isUsableParkSlotRange({ slotStart: 405, slotEnd: 401 })).toBe(false);
		expect(isUsableParkSlotRange({ slotStart: 401.5, slotEnd: 405 })).toBe(false);
		expect(parkSlotCapacity({ slotStart: 405, slotEnd: 401 })).toBe(0);
		expect(nextFreeParkSlot({ slotStart: 405, slotEnd: 401 }, [])).toBeUndefined();
	});

	it("knows which orbits belong to the lot", () => {
		expect(isParkSlotInRange(LOT, 401)).toBe(true);
		expect(isParkSlotInRange(LOT, 405)).toBe(true);
		expect(isParkSlotInRange(LOT, 400)).toBe(false);
		expect(isParkSlotInRange(LOT, 406)).toBe(false);
	});

	it("hands out the lowest free orbit, so announced slot numbers stay short", () => {
		expect(nextFreeParkSlot(LOT, [])).toBe(401);
		expect(nextFreeParkSlot(LOT, [401, 402])).toBe(403);
		expect(nextFreeParkSlot(LOT, [402, 403])).toBe(401);
	});

	it("reports a full lot rather than overflowing it", () => {
		expect(nextFreeParkSlot(LOT, [401, 402, 403, 404, 405])).toBeUndefined();
	});

	it("honours a requested orbit, and REFUSES it when taken rather than silently reassigning", () => {
		expect(nextFreeParkSlot(LOT, [401], 404)).toBe(404);
		// Somebody who announces "it's on 401" must not have the call land on 402.
		expect(nextFreeParkSlot(LOT, [401], 401)).toBeUndefined();
		expect(nextFreeParkSlot(LOT, [], 999)).toBeUndefined();
	});

	it("parses only bare digits", () => {
		expect(parseParkSlot("401")).toBe(401);
		expect(parseParkSlot("0401")).toBe(401);
		expect(parseParkSlot(" 401")).toBeUndefined();
		expect(parseParkSlot("401a")).toBeUndefined();
		expect(parseParkSlot("+401")).toBeUndefined();
		expect(parseParkSlot("")).toBeUndefined();
	});
});

describe("the channel states a park needs", () => {
	it("can move a bridged leg into the lot and back out to a new destination", () => {
		expect(VALID_CHANNEL_TRANSITIONS["exchanging-media"]).toContain("parked");
		expect(VALID_CHANNEL_TRANSITIONS.parked).toContain("exchanging-media");
		expect(VALID_CHANNEL_TRANSITIONS.parked).toContain("routing");
		expect(VALID_CHANNEL_TRANSITIONS.parked).toContain("hangup");
	});
});
