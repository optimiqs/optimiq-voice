import { describe, expect, it } from "bun:test";
import {
	aggregateDeviceState,
	assertCallStateTransition,
	CALL_STATES,
	callStateTransitionsFrom,
	DEVICE_STATES,
	INITIAL_CALL_STATE,
	isAlertingCallState,
	isAnsweredCallState,
	isCallState,
	isDeviceState,
	isTerminalCallState,
	isValidCallStateTransition,
	VALID_CALL_STATE_TRANSITIONS,
	type CallState,
} from "./call-state";
import { InvalidCallStateTransitionError } from "./errors";

/**
 * Call states are published to BLF subscribers, so an incorrect edge shows up as a desk phone with
 * a stuck lamp — the most visible class of PBX bug there is. Pinned against
 * `plans/reference/freeswitch-capabilities.md` §1.
 */
describe("call state machine", () => {
	it("covers exactly the nine documented states, with no duplicates", () => {
		expect(CALL_STATES).toHaveLength(9);
		expect(new Set(CALL_STATES).size).toBe(CALL_STATES.length);
		expect(Object.keys(VALID_CALL_STATE_TRANSITIONS).sort()).toEqual([...CALL_STATES].sort());
	});

	it("starts at down", () => {
		expect(INITIAL_CALL_STATE).toBe("down");
	});

	it("only ever targets states that exist, never itself, never twice", () => {
		for (const state of CALL_STATES) {
			const targets = callStateTransitionsFrom(state);
			expect(new Set(targets).size).toBe(targets.length);
			expect(targets).not.toContain(state);
			for (const target of targets) {
				expect(isCallState(target)).toBe(true);
			}
		}
	});

	it("makes hangup the one terminal state, reachable from everywhere else", () => {
		expect(CALL_STATES.filter(isTerminalCallState)).toEqual(["hangup"]);
		for (const state of CALL_STATES) {
			if (state !== "hangup") {
				expect(isValidCallStateTransition(state, "hangup")).toBe(true);
			}
		}
	});

	// You cannot hold a leg that was never answered.
	it("reaches held only from active or unheld", () => {
		const toHeld = CALL_STATES.filter((state) => isValidCallStateTransition(state, "held"));
		expect(toHeld).toEqual(["active", "unheld"]);
	});

	// unheld is a pass-through so watchers can tell "resumed" from "never held".
	it("reaches unheld only from held, and leaves it only to active, held or hangup", () => {
		const toUnheld = CALL_STATES.filter((state) => isValidCallStateTransition(state, "unheld"));
		expect(toUnheld).toEqual(["held"]);
		expect(callStateTransitionsFrom("unheld")).toEqual(["active", "held", "hangup"]);
	});

	it("reaches active from every pre-answer state", () => {
		for (const state of ["down", "dialing", "ring-wait", "ringing", "early"] as const) {
			expect(isValidCallStateTransition(state, "active")).toBe(true);
		}
	});

	it("classifies answered and alerting states", () => {
		expect(CALL_STATES.filter(isAnsweredCallState)).toEqual(["active", "held", "unheld"]);
		expect(CALL_STATES.filter(isAlertingCallState)).toEqual([
			"dialing",
			"ring-wait",
			"ringing",
			"early",
		]);
	});

	it("guards before executing, and reports both ends of the rejected edge", () => {
		expect(() => assertCallStateTransition("down", "held")).toThrow(
			InvalidCallStateTransitionError,
		);
		expect(() => assertCallStateTransition("active", "ringing")).toThrow(
			InvalidCallStateTransitionError,
		);
		expect(() => assertCallStateTransition("hangup", "active")).toThrow(
			InvalidCallStateTransitionError,
		);
		expect(() => assertCallStateTransition("ringing", "active")).not.toThrow();

		try {
			assertCallStateTransition("hangup", "down");
			expect.unreachable();
		} catch (error) {
			const transition = error as InvalidCallStateTransitionError;
			expect(transition.from).toBe("hangup");
			expect(transition.to).toBe("down");
		}
	});

	it("guards values arriving from the wire", () => {
		expect(isCallState("ring-wait")).toBe(true);
		expect(isCallState("RING_WAIT")).toBe(false);
		expect(isDeviceState("active-multi")).toBe(true);
		expect(isDeviceState("active_multi")).toBe(false);
	});
});

/**
 * Device-state aggregation is what a busy-lamp key renders. It must be total and deterministic:
 * an ambiguous rule shows up as a lamp that flickers between two calls.
 */
describe("aggregateDeviceState", () => {
	it("covers exactly the seven documented device states", () => {
		expect(DEVICE_STATES).toHaveLength(7);
		expect(new Set(DEVICE_STATES).size).toBe(DEVICE_STATES.length);
	});

	it("reports down for a device with no channels", () => {
		expect(aggregateDeviceState([])).toBe("down");
	});

	it("reports down when every channel is idle", () => {
		expect(aggregateDeviceState(["down", "down"])).toBe("down");
	});

	it("reports hangup only when every channel has hung up", () => {
		expect(aggregateDeviceState(["hangup"])).toBe("hangup");
		expect(aggregateDeviceState(["hangup", "hangup"])).toBe("hangup");
		expect(aggregateDeviceState(["hangup", "ringing"])).toBe("ringing");
		expect(aggregateDeviceState(["hangup", "active"])).toBe("active");
	});

	// Outbound dialing lights the lamp too: the user is on the phone either way.
	it.each([["dialing"], ["ring-wait"], ["ringing"], ["early"]] as const)(
		"reports ringing for a lone %s channel",
		(state) => {
			expect(aggregateDeviceState([state])).toBe("ringing");
		},
	);

	it("reports active for a single answered channel", () => {
		expect(aggregateDeviceState(["active"])).toBe("active");
	});

	it("reports active-multi for more than one answered channel", () => {
		expect(aggregateDeviceState(["active", "active"])).toBe("active-multi");
		expect(aggregateDeviceState(["active", "active", "active"])).toBe("active-multi");
	});

	it("reports unheld while a single channel is resuming", () => {
		expect(aggregateDeviceState(["unheld"])).toBe("unheld");
	});

	it("counts a resuming channel as answered when others are answered too", () => {
		expect(aggregateDeviceState(["unheld", "active"])).toBe("active-multi");
	});

	it("reports held only when nothing is answered", () => {
		expect(aggregateDeviceState(["held"])).toBe("held");
		expect(aggregateDeviceState(["held", "held"])).toBe("held");
	});

	// Answered beats held: a user with one live call and one parked call is "on a call".
	it("prefers an answered channel over a held one", () => {
		expect(aggregateDeviceState(["held", "active"])).toBe("active");
		expect(aggregateDeviceState(["active", "held"])).toBe("active");
	});

	it("prefers held over alerting", () => {
		expect(aggregateDeviceState(["held", "ringing"])).toBe("held");
	});

	it("ignores idle and reaped channels alongside live ones", () => {
		expect(aggregateDeviceState(["down", "hangup", "ringing"])).toBe("ringing");
		expect(aggregateDeviceState(["down", "hangup", "active"])).toBe("active");
	});

	it("is total over every call state and always returns a known device state", () => {
		for (const state of CALL_STATES) {
			expect(isDeviceState(aggregateDeviceState([state]))).toBe(true);
		}
	});

	it("is order-independent", () => {
		const states = ["held", "ringing", "active", "down"] as const satisfies readonly CallState[];
		expect(aggregateDeviceState([...states].reverse())).toBe(aggregateDeviceState(states));
	});
});
