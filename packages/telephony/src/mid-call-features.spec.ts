import { describe, expect, it } from "bun:test";
import { InvalidMidCallFeatureTransitionError } from "./errors";
import {
	argumentModeOf,
	assertMidCallFeatureTransition,
	DEFAULT_MID_CALL_FEATURE_SETTINGS,
	INITIAL_MID_CALL_FEATURE_STATE,
	isMidCallFeatureState,
	isValidMidCallFeatureTransition,
	MID_CALL_ARGUMENT_MODE,
	MID_CALL_FEATURE_ACTIONS,
	MID_CALL_FEATURE_STATES,
	MidCallFeatureMachine,
	midCallFeatureTransitionsFrom,
	orderMidCallFeatureCodes,
	VALID_MID_CALL_FEATURE_TRANSITIONS,
} from "./mid-call-features";
import type {
	MidCallFeatureCode,
	MidCallFeatureSettings,
	MidCallFeatureState,
	MidCallFeatureStep,
} from "./mid-call-features";

/**
 * The mid-call capture.
 *
 * The assertions that matter here are all about the digits the machine does NOT take. A feature
 * runtime that fires `*1` correctly and also swallows every `*` a caller presses at the far end's
 * IVR is worse than no feature at all, so most of this file is about pass-through and abandonment.
 */

const VANILLA: readonly MidCallFeatureCode[] = [
	{ code: "*1", action: "blind-transfer" },
	{ code: "*3", action: "record-toggle" },
	{ code: "*5", action: "park" },
];

function machine(
	table: readonly MidCallFeatureCode[] = VANILLA,
	settings: Partial<MidCallFeatureSettings> = {},
): MidCallFeatureMachine {
	return new MidCallFeatureMachine(table, settings);
}

/** Presses a string of digits at `t = 0`, returning every step in order. */
function press(m: MidCallFeatureMachine, digits: string, startMs = 0): MidCallFeatureStep[] {
	return [...digits].map((digit, index) => m.push(digit, startMs + index));
}

// ---------------------------------------------------------------------------------------------
// The machine's shape
// ---------------------------------------------------------------------------------------------

describe("the state machine", () => {
	it("has no terminal state, because the machine is reused for the life of the call", () => {
		for (const state of MID_CALL_FEATURE_STATES) {
			expect(midCallFeatureTransitionsFrom(state).length).toBeGreaterThan(0);
		}
	});

	it("reaches executing only from armed and collecting", () => {
		const sources = MID_CALL_FEATURE_STATES.filter((state) =>
			(VALID_MID_CALL_FEATURE_TRANSITIONS[state] as readonly MidCallFeatureState[]).includes(
				"executing",
			),
		);
		expect(sources).toEqual(["armed", "collecting"]);
	});

	it("reaches collecting only from armed", () => {
		const sources = MID_CALL_FEATURE_STATES.filter((state) =>
			(VALID_MID_CALL_FEATURE_TRANSITIONS[state] as readonly MidCallFeatureState[]).includes(
				"collecting",
			),
		);
		expect(sources).toEqual(["armed"]);
	});

	it("lets every capturing stage fall back to idle", () => {
		for (const state of ["armed", "collecting", "executing"] as const) {
			expect(midCallFeatureTransitionsFrom(state)).toContain("idle");
		}
	});

	it("never lists a state as its own successor", () => {
		for (const state of MID_CALL_FEATURE_STATES) {
			expect(midCallFeatureTransitionsFrom(state)).not.toContain(state);
		}
	});

	it("makes every state reachable from idle", () => {
		const seen = new Set<MidCallFeatureState>([INITIAL_MID_CALL_FEATURE_STATE]);
		const queue: MidCallFeatureState[] = [INITIAL_MID_CALL_FEATURE_STATE];
		while (queue.length > 0) {
			for (const next of midCallFeatureTransitionsFrom(queue.pop() as MidCallFeatureState)) {
				if (!seen.has(next)) {
					seen.add(next);
					queue.push(next);
				}
			}
		}
		expect(seen.size).toBe(MID_CALL_FEATURE_STATES.length);
	});

	it("guards a transition rather than reporting it", () => {
		expect(() => {
			assertMidCallFeatureTransition("idle", "executing");
		}).toThrow(InvalidMidCallFeatureTransitionError);
		expect(isValidMidCallFeatureTransition("armed", "executing")).toBe(true);
		expect(isValidMidCallFeatureTransition("idle", "collecting")).toBe(false);
	});

	it("guards a stage arriving from the wire", () => {
		expect(isMidCallFeatureState("collecting")).toBe(true);
		expect(isMidCallFeatureState("consulting")).toBe(false);
	});

	it("decides an argument mode for every action", () => {
		for (const action of MID_CALL_FEATURE_ACTIONS) {
			expect(MID_CALL_ARGUMENT_MODE[action]).toBeDefined();
		}
		expect(MID_CALL_ARGUMENT_MODE["blind-transfer"]).toBe("required");
		expect(MID_CALL_ARGUMENT_MODE.park).toBe("optional");
		expect(MID_CALL_ARGUMENT_MODE["record-toggle"]).toBe("none");
		expect(MID_CALL_ARGUMENT_MODE.cancel).toBe("none");
	});

	it("takes a row's own argument mode over the action's", () => {
		expect(argumentModeOf({ code: "*1", action: "blind-transfer" })).toBe("required");
		expect(argumentModeOf({ code: "*1", action: "blind-transfer", argumentMode: "none" })).toBe(
			"none",
		);
	});
});

// ---------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------

describe("the table", () => {
	it("orders longest code first, so *80 wins over *8", () => {
		const ordered = orderMidCallFeatureCodes([
			{ code: "*8", action: "park" },
			{ code: "*80", action: "record-toggle" },
		]);
		expect(ordered.map((entry) => entry.code)).toEqual(["*80", "*8"]);
	});

	it("drops a row nobody can press", () => {
		const ordered = orderMidCallFeatureCodes([
			{ code: "", action: "park" },
			{ code: "*x1", action: "park" },
			{ code: "*5", action: "park" },
		]);
		expect(ordered.map((entry) => entry.code)).toEqual(["*5"]);
	});

	it("is a total order, so the match is reproducible", () => {
		const rows: readonly MidCallFeatureCode[] = [
			{ code: "*3", action: "record-toggle" },
			{ code: "*1", action: "blind-transfer" },
			{ code: "*5", action: "park" },
		];
		expect(orderMidCallFeatureCodes(rows).map((entry) => entry.code)).toEqual(
			orderMidCallFeatureCodes([...rows].reverse()).map((entry) => entry.code),
		);
	});
});

// ---------------------------------------------------------------------------------------------
// Pass-through: the answer for almost every digit
// ---------------------------------------------------------------------------------------------

describe("digits that are not ours", () => {
	it("passes a plain digit straight through", () => {
		const m = machine();
		const step = m.push("5", 0);
		expect(step.kind).toBe("pass-through");
		expect(step.state).toBe("idle");
		expect(m.isCapturing).toBe(false);
	});

	it("passes a lead digit through when no row starts with it", () => {
		const m = machine([{ code: "#9", action: "park" }]);
		expect(m.push("*", 0).kind).toBe("pass-through");
	});

	it("passes a non-DTMF symbol through untouched", () => {
		const m = machine();
		expect(m.push("x", 0).kind).toBe("pass-through");
		expect(m.state).toBe("idle");
	});

	it("passes an entire IVR interaction through when the table is empty", () => {
		const m = machine([]);
		for (const step of press(m, "*123#")) {
			expect(step.kind).toBe("pass-through");
		}
	});

	it("hands back the digits it swallowed when the code matches nothing", () => {
		const m = machine();
		expect(m.push("*", 0).kind).toBe("captured");
		const abandoned = m.push("9", 1);
		expect(abandoned.kind).toBe("abandoned");
		expect(abandoned.swallowed).toBe("*9");
		expect(m.state).toBe("idle");
	});
});

// ---------------------------------------------------------------------------------------------
// Codes that take no argument
// ---------------------------------------------------------------------------------------------

describe("a code dialled alone", () => {
	it("fires the record toggle on the second digit", () => {
		const m = machine();
		expect(m.push("*", 0).kind).toBe("captured");
		const fired = m.push("3", 1);
		expect(fired.kind).toBe("execute");
		expect(fired.execution).toEqual({ action: "record-toggle", code: "*3", argument: "" });
		expect(m.state).toBe("executing");
	});

	it("asks for no timer once it is executing", () => {
		const m = machine();
		press(m, "*3");
		expect(m.push("7", 2).wakeAtMs).toBeUndefined();
	});

	it("swallows the digits pressed while the engine is still running the action", () => {
		const m = machine();
		press(m, "*3");
		const impatient = m.push("*", 5);
		expect(impatient.kind).toBe("captured");
		expect(impatient.state).toBe("executing");
	});

	it("returns to idle only when the engine says the action is done", () => {
		const m = machine();
		press(m, "*3");
		expect(m.settle().state).toBe("idle");
		expect(m.isCapturing).toBe(false);
		// And is immediately reusable.
		expect(m.push("*", 10).kind).toBe("captured");
	});

	it("ignores a settle that was not preceded by an execution", () => {
		const m = machine();
		expect(m.settle().state).toBe("idle");
	});
});

// ---------------------------------------------------------------------------------------------
// Codes that collect an argument
// ---------------------------------------------------------------------------------------------

describe("a code that takes a destination", () => {
	it("collects digits after *1 and fires on the terminator", () => {
		const m = machine();
		press(m, "*1");
		expect(m.state).toBe("collecting");
		press(m, "200", 2);
		const fired = m.push("#", 5);
		expect(fired.kind).toBe("execute");
		expect(fired.execution).toEqual({ action: "blind-transfer", code: "*1", argument: "200" });
	});

	it("fires on the inter-digit timeout when nobody presses hash", () => {
		const m = machine();
		press(m, "*1");
		const last = press(m, "200", 2).at(-1) as MidCallFeatureStep;
		expect(last.wakeAtMs).toBe(4 + DEFAULT_MID_CALL_FEATURE_SETTINGS.interDigitTimeoutMs);

		const fired = m.expire(last.wakeAtMs as number);
		expect(fired.kind).toBe("execute");
		expect(fired.execution?.argument).toBe("200");
	});

	it("re-arms the inter-digit deadline on every argument digit", () => {
		const m = machine();
		press(m, "*1");
		const first = m.push("2", 10);
		const second = m.push("0", 20);
		expect(second.wakeAtMs as number).toBeGreaterThan(first.wakeAtMs as number);
	});

	it("refuses to fire a transfer with no destination", () => {
		const m = machine();
		press(m, "*1");
		const abandoned = m.push("#", 5);
		expect(abandoned.kind).toBe("abandoned");
		expect(abandoned.swallowed).toBe("*1");
		expect(m.state).toBe("idle");
	});

	it("abandons a required argument that timed out empty", () => {
		const m = machine();
		const armed = press(m, "*1").at(-1) as MidCallFeatureStep;
		const expired = m.expire(armed.wakeAtMs as number);
		expect(expired.kind).toBe("abandoned");
	});

	it("fires park with no orbit, because its argument is optional", () => {
		const m = machine();
		const armed = press(m, "*5").at(-1) as MidCallFeatureStep;
		expect(m.state).toBe("collecting");
		const fired = m.expire(armed.wakeAtMs as number);
		expect(fired.execution).toEqual({ action: "park", code: "*5", argument: "" });
	});

	it("fires park with the orbit the parker asked for", () => {
		const m = machine();
		press(m, "*5");
		press(m, "401", 2);
		expect(m.push("#", 6).execution).toEqual({ action: "park", code: "*5", argument: "401" });
	});

	it("stops collecting at the bound rather than swallowing forever", () => {
		const m = machine([{ code: "*1", action: "blind-transfer" }], { maxArgumentDigits: 3 });
		press(m, "*1");
		press(m, "12", 2);
		const fired = m.push("3", 5);
		expect(fired.kind).toBe("execute");
		expect(fired.execution?.argument).toBe("123");
	});
});

// ---------------------------------------------------------------------------------------------
// Prefix codes: the reason `armed` waits
// ---------------------------------------------------------------------------------------------

describe("one code that is a prefix of another", () => {
	const TABLE: readonly MidCallFeatureCode[] = [
		{ code: "*1", action: "record-toggle" },
		{ code: "*12", action: "park", argumentMode: "none" },
	];

	it("does not fire the short code while the long one is still reachable", () => {
		const m = machine(TABLE);
		const armed = press(m, "*1").at(-1) as MidCallFeatureStep;
		expect(armed.kind).toBe("captured");
		expect(armed.state).toBe("armed");
		expect(armed.wakeAtMs).toBe(1 + DEFAULT_MID_CALL_FEATURE_SETTINGS.codeTimeoutMs);
	});

	it("fires the long code when the next digit arrives", () => {
		const m = machine(TABLE);
		press(m, "*1");
		expect(m.push("2", 2).execution?.action).toBe("park");
	});

	it("fires the short code when the code timeout elapses instead", () => {
		const m = machine(TABLE);
		const armed = press(m, "*1").at(-1) as MidCallFeatureStep;
		const fired = m.expire(armed.wakeAtMs as number);
		expect(fired.execution).toEqual({ action: "record-toggle", code: "*1", argument: "" });
	});
});

// ---------------------------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------------------------

describe("the timer contract", () => {
	it("reports a wake instant on every step that leaves a capture running", () => {
		const m = machine();
		expect(m.push("*", 0).wakeAtMs).toBe(DEFAULT_MID_CALL_FEATURE_SETTINGS.codeTimeoutMs);
	});

	it("ignores a timer that fired before the deadline", () => {
		const m = machine();
		const armed = m.push("*", 0);
		const early = m.expire((armed.wakeAtMs as number) - 1);
		expect(early.kind).toBe("captured");
		expect(m.state).toBe("armed");
	});

	it("does nothing on an expiry with no capture running", () => {
		const m = machine();
		expect(m.expire(10_000).kind).toBe("pass-through");
	});

	it("uses the longer inter-digit deadline once a code has matched", () => {
		const m = machine();
		const collecting = press(m, "*1").at(-1) as MidCallFeatureStep;
		expect((collecting.wakeAtMs as number) - 1).toBe(
			DEFAULT_MID_CALL_FEATURE_SETTINGS.interDigitTimeoutMs,
		);
	});
});

// ---------------------------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------------------------

describe("cancellation", () => {
	it("drops a half-typed code and hands the digits back", () => {
		const m = machine();
		press(m, "*1");
		press(m, "20", 2);
		const cancelled = m.cancel();
		expect(cancelled.kind).toBe("abandoned");
		expect(cancelled.swallowed).toBe("*120");
		expect(m.state).toBe("idle");
	});

	it("is a no-op when nothing is being captured", () => {
		const m = machine();
		expect(m.cancel().kind).toBe("pass-through");
	});
});

// ---------------------------------------------------------------------------------------------
// The cancel key
// ---------------------------------------------------------------------------------------------

describe("the attended-transfer cancel key", () => {
	it("fires on a single digit when the engine armed it as a code", () => {
		const m = machine([{ code: "*", action: "cancel" }]);
		const fired = m.push("*", 0);
		expect(fired.kind).toBe("execute");
		expect(fired.execution).toEqual({ action: "cancel", code: "*", argument: "" });
	});

	it("coexists with a longer code that starts with it", () => {
		const m = machine([
			{ code: "*", action: "cancel" },
			{ code: "*1", action: "blind-transfer" },
		]);
		const armed = m.push("*", 0);
		expect(armed.kind).toBe("captured");
		// The longer code wins when the caller keeps typing...
		expect(m.push("1", 1).state).toBe("collecting");

		// ...and the cancel fires on the timeout when they do not.
		const second = machine([
			{ code: "*", action: "cancel" },
			{ code: "*1", action: "blind-transfer" },
		]);
		const waiting = second.push("*", 0);
		expect(second.expire(waiting.wakeAtMs as number).execution?.action).toBe("cancel");
	});
});
