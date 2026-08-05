import { describe, expect, it } from "bun:test";
import {
	assertChannelTransition,
	CHANNEL_STATES,
	CHANNEL_TEARDOWN_STATES,
	channelTransitionsFrom,
	INITIAL_CHANNEL_STATE,
	isChannelState,
	isLiveChannelState,
	isTeardownChannelState,
	isTerminalChannelState,
	isValidChannelTransition,
	VALID_CHANNEL_TRANSITIONS,
	type ChannelState,
} from "./channel-state";
import { InvalidChannelTransitionError } from "./errors";

/**
 * The channel machine is the engine's only guarantee that a leg cannot be resurrected after
 * teardown, and that a hangup cause is fixed exactly once. These specs pin the topology derived
 * from `plans/reference/freeswitch-capabilities.md` §1.
 */
describe("channel state machine", () => {
	it("covers exactly the twelve documented states, with no duplicates", () => {
		expect(CHANNEL_STATES).toHaveLength(12);
		expect(new Set(CHANNEL_STATES).size).toBe(CHANNEL_STATES.length);
		expect(Object.keys(VALID_CHANNEL_TRANSITIONS).sort()).toEqual([...CHANNEL_STATES].sort());
	});

	it("starts at created", () => {
		expect(INITIAL_CHANNEL_STATE).toBe("created");
	});

	it("only ever targets states that exist", () => {
		for (const state of CHANNEL_STATES) {
			for (const target of channelTransitionsFrom(state)) {
				expect(isChannelState(target)).toBe(true);
			}
		}
	});

	it("never lists a state as its own successor", () => {
		for (const state of CHANNEL_STATES) {
			expect(channelTransitionsFrom(state)).not.toContain(state);
		}
	});

	it("never lists the same successor twice", () => {
		for (const state of CHANNEL_STATES) {
			const targets = channelTransitionsFrom(state);
			expect(new Set(targets).size).toBe(targets.length);
		}
	});

	it("makes destroyed the one terminal state", () => {
		const terminal = CHANNEL_STATES.filter(isTerminalChannelState);
		expect(terminal).toEqual(["destroyed"]);
	});

	// The teardown tail is one-way: this is what makes a per-leg CDR reproducible from the stream.
	it("reaches reporting only from hangup and destroyed only from reporting", () => {
		const toReporting = CHANNEL_STATES.filter((state) =>
			isValidChannelTransition(state, "reporting"),
		);
		const toDestroyed = CHANNEL_STATES.filter((state) =>
			isValidChannelTransition(state, "destroyed"),
		);

		expect(toReporting).toEqual(["hangup"]);
		expect(toDestroyed).toEqual(["reporting"]);
	});

	it("lets every live state hang up", () => {
		for (const state of CHANNEL_STATES) {
			if (isLiveChannelState(state)) {
				expect(isValidChannelTransition(state, "hangup")).toBe(true);
			}
		}
	});

	it("never routes out of the teardown tail", () => {
		for (const state of CHANNEL_TEARDOWN_STATES) {
			for (const target of channelTransitionsFrom(state)) {
				expect(isTeardownChannelState(target)).toBe(true);
			}
		}
	});

	it("classifies teardown and live states as complements", () => {
		for (const state of CHANNEL_STATES) {
			expect(isLiveChannelState(state)).toBe(!isTeardownChannelState(state));
		}
		expect(CHANNEL_STATES.filter(isTeardownChannelState)).toEqual([...CHANNEL_TEARDOWN_STATES]);
	});

	it("reaches every state from created", () => {
		const seen = new Set<ChannelState>([INITIAL_CHANNEL_STATE]);
		const queue: ChannelState[] = [INITIAL_CHANNEL_STATE];

		while (queue.length > 0) {
			const state = queue.shift() as ChannelState;
			for (const target of channelTransitionsFrom(state)) {
				if (!seen.has(target)) {
					seen.add(target);
					queue.push(target);
				}
			}
		}

		expect(seen.size).toBe(CHANNEL_STATES.length);
	});

	// The happy path from the frozen reference, walked end to end.
	it("walks the canonical inbound lifecycle", () => {
		const lifecycle = [
			"created",
			"initializing",
			"routing",
			"executing",
			"exchanging-media",
			"hangup",
			"reporting",
			"destroyed",
		] as const satisfies readonly ChannelState[];

		for (let index = 0; index < lifecycle.length - 1; index += 1) {
			expect(() => assertChannelTransition(lifecycle[index], lifecycle[index + 1])).not.toThrow();
		}
	});

	// Blind transfer resets a live leg back into routing in the target context (reference §3).
	it("allows a live leg to be reset into routing for a blind transfer", () => {
		expect(isValidChannelTransition("executing", "routing")).toBe(true);
		expect(isValidChannelTransition("exchanging-media", "routing")).toBe(true);
	});

	it("guards before executing, and reports both ends of the rejected edge", () => {
		expect(() => assertChannelTransition("created", "executing")).toThrow(
			InvalidChannelTransitionError,
		);

		try {
			assertChannelTransition("destroyed", "executing");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidChannelTransitionError);
			const transition = error as InvalidChannelTransitionError;
			expect(transition.from).toBe("destroyed");
			expect(transition.to).toBe("executing");
			expect(transition.name).toBe("InvalidChannelTransitionError");
		}
	});

	it("guards values arriving from the wire", () => {
		expect(isChannelState("exchanging-media")).toBe(true);
		expect(isChannelState("EXCHANGE_MEDIA")).toBe(false);
		expect(isChannelState("reset")).toBe(false);
	});
});
