import { describe, expect, it } from "bun:test";
import { VALID_CHANNEL_TRANSITIONS } from "./channel-state";
import { InvalidTransferTransitionError } from "./errors";
import {
	assertTransferTransition,
	FIRST_TRANSFER_STATE_BY_KIND,
	hangupCauseForTransfer,
	INITIAL_TRANSFER_STATE,
	isTerminalTransferState,
	isTransferState,
	isValidTransferTransition,
	TRANSFER_STATES,
	TRANSFER_TERMINAL_STATES,
	transferTransitionsFrom,
	VALID_TRANSFER_TRANSITIONS,
} from "./transfer";
import { TRANSFER_KINDS } from "./verbs";
import type { TransferState } from "./transfer";

function reachableFrom(start: TransferState): ReadonlySet<TransferState> {
	const seen = new Set<TransferState>();
	const pending: TransferState[] = [start];
	while (pending.length > 0) {
		const state = pending.pop() as TransferState;
		if (seen.has(state)) {
			continue;
		}
		seen.add(state);
		pending.push(...transferTransitionsFrom(state));
	}
	return seen;
}

describe("the transfer machine", () => {
	it("is total over its own state list", () => {
		expect(Object.keys(VALID_TRANSFER_TRANSITIONS).sort()).toEqual([...TRANSFER_STATES].sort());
		expect(new Set(TRANSFER_STATES).size).toBe(TRANSFER_STATES.length);
	});

	it("starts at initiated", () => {
		expect(INITIAL_TRANSFER_STATE).toBe("initiated");
		expect(isTransferState(INITIAL_TRANSFER_STATE)).toBe(true);
	});

	it("has exactly three terminals, and they have no outgoing edges", () => {
		for (const state of TRANSFER_STATES) {
			expect(isTerminalTransferState(state)).toBe(
				(TRANSFER_TERMINAL_STATES as readonly string[]).includes(state),
			);
			if (isTerminalTransferState(state)) {
				expect(transferTransitionsFrom(state)).toEqual([]);
			}
		}
		expect(TRANSFER_TERMINAL_STATES.length).toBe(3);
	});

	it("reaches completed only from completing — a transfer cannot succeed without committing", () => {
		const predecessors = TRANSFER_STATES.filter((state) =>
			(transferTransitionsFrom(state) as readonly string[]).includes("completed"),
		);
		expect(predecessors).toEqual(["completing"]);
	});

	it("lets every live stage fail, and every pre-commit stage cancel", () => {
		for (const state of TRANSFER_STATES) {
			if (isTerminalTransferState(state)) {
				continue;
			}
			expect(isValidTransferTransition(state, "failed")).toBe(true);
			expect(isValidTransferTransition(state, "cancelled")).toBe(state !== "completing");
		}
	});

	it("never lists a state as its own successor", () => {
		for (const state of TRANSFER_STATES) {
			expect(transferTransitionsFrom(state)).not.toContain(state);
		}
	});

	it("makes every state reachable from initiated", () => {
		const reachable = reachableFrom("initiated");
		for (const state of TRANSFER_STATES) {
			expect(reachable.has(state)).toBe(true);
		}
	});

	it("walks the blind path in two steps and the attended path in four", () => {
		const blind: readonly TransferState[] = ["initiated", "completing", "completed"];
		const attended: readonly TransferState[] = [
			"initiated",
			"held",
			"consulting",
			"completing",
			"completed",
		];
		for (const path of [blind, attended]) {
			for (const [index, state] of path.slice(1).entries()) {
				expect(isValidTransferTransition(path[index] as TransferState, state)).toBe(true);
			}
		}
	});

	it("lets a consultation be re-held — an attended transfer that toggles back to the transferee", () => {
		expect(isValidTransferTransition("consulting", "held")).toBe(true);
	});
});

describe("assertTransferTransition", () => {
	it("passes an existing edge", () => {
		expect(() => {
			assertTransferTransition("initiated", "held");
		}).not.toThrow();
	});

	it("throws the typed error on an edge the machine does not have", () => {
		expect(() => {
			assertTransferTransition("cancelled", "completed");
		}).toThrow(InvalidTransferTransitionError);
	});

	it("carries both endpoints on the error, so a log says what was attempted", () => {
		try {
			assertTransferTransition("completed", "consulting");
			throw new Error("expected a throw");
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidTransferTransitionError);
			expect((error as InvalidTransferTransitionError).from).toBe("completed");
			expect((error as InvalidTransferTransitionError).to).toBe("consulting");
		}
	});
});

describe("kind-specific behaviour", () => {
	it("sends a blind transfer straight to completing and an attended one to held", () => {
		expect(FIRST_TRANSFER_STATE_BY_KIND.blind).toBe("completing");
		expect(FIRST_TRANSFER_STATE_BY_KIND.attended).toBe("held");
		for (const kind of TRANSFER_KINDS) {
			expect(isValidTransferTransition("initiated", FIRST_TRANSFER_STATE_BY_KIND[kind])).toBe(true);
		}
	});

	it("leaves the transferor a transfer cause, never NORMAL_CLEARING", () => {
		expect(hangupCauseForTransfer("blind")).toBe("BLIND_TRANSFER");
		expect(hangupCauseForTransfer("attended")).toBe("ATTENDED_TRANSFER");
	});
});

describe("the channel states a transfer needs", () => {
	/**
	 * The transfer machine tracks the OPERATION; the channel machine tracks each leg. These are the
	 * three edges a transfer walks on the channel machine, asserted here because a change to
	 * `channel-state.ts` that removed one of them would break transfers with no failing test in
	 * this file's own subject.
	 */
	it("can re-route a bridged leg, hold one aside, and bring it back", () => {
		expect(VALID_CHANNEL_TRANSITIONS["exchanging-media"]).toContain("routing");
		expect(VALID_CHANNEL_TRANSITIONS["exchanging-media"]).toContain("hibernating");
		expect(VALID_CHANNEL_TRANSITIONS.hibernating).toContain("exchanging-media");
	});
});
