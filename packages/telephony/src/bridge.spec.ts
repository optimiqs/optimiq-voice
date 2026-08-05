import { describe, expect, it } from "bun:test";
import {
	assertBridgeTransition,
	BRIDGE_MODES,
	BRIDGE_STATES,
	bridgeModeDecodesMedia,
	bridgeModeRelaysMedia,
	bridgeTransitionsFrom,
	DEFAULT_BRIDGE_MODE,
	INITIAL_BRIDGE_STATE,
	isBridgeMode,
	isBridgeState,
	isLegRole,
	isTerminalBridgeState,
	isValidBridgeTransition,
	LEG_ROLES,
	oppositeLegRole,
	requiresRenegotiation,
	supportsMediaBug,
	supportsRecording,
	VALID_BRIDGE_TRANSITIONS,
} from "./bridge";
import { InvalidBridgeTransitionError } from "./errors";

/**
 * The bridge mode decides which features are physically possible, so the predicates below are
 * load-bearing: a feature runtime that records a bypassed bridge produces a silent file and a
 * compliance incident. Pinned against `plans/reference/freeswitch-capabilities.md` §1 and §5.
 */
describe("bridge modes", () => {
	it("covers exactly the four documented modes", () => {
		expect(BRIDGE_MODES).toHaveLength(4);
		expect([...BRIDGE_MODES].sort()).toEqual(["bypass", "media", "proxy-media", "signal-only"]);
		expect(DEFAULT_BRIDGE_MODE).toBe("media");
	});

	it("relays media only in the two modes where packets pass through us", () => {
		expect(BRIDGE_MODES.filter(bridgeModeRelaysMedia).sort()).toEqual(["media", "proxy-media"]);
	});

	it("decodes media only in full-media mode", () => {
		expect(BRIDGE_MODES.filter(bridgeModeDecodesMedia)).toEqual(["media"]);
	});

	// Everything in §5 that reads or rewrites audio needs decoded samples.
	it("allows media bugs and recording only where media is decoded", () => {
		for (const mode of BRIDGE_MODES) {
			expect(supportsMediaBug(mode)).toBe(bridgeModeDecodesMedia(mode));
			expect(supportsRecording(mode)).toBe(bridgeModeDecodesMedia(mode));
		}
		expect(supportsRecording("bypass")).toBe(false);
		expect(supportsRecording("proxy-media")).toBe(false);
	});

	it("treats decoding as strictly stronger than relaying", () => {
		for (const mode of BRIDGE_MODES) {
			if (bridgeModeDecodesMedia(mode)) {
				expect(bridgeModeRelaysMedia(mode)).toBe(true);
			}
		}
	});

	it("requires renegotiation exactly when the mode changes", () => {
		for (const from of BRIDGE_MODES) {
			for (const to of BRIDGE_MODES) {
				expect(requiresRenegotiation(from, to)).toBe(from !== to);
			}
		}
	});

	it("guards values arriving from the wire", () => {
		expect(isBridgeMode("proxy-media")).toBe(true);
		expect(isBridgeMode("bypass-media")).toBe(false);
	});
});

describe("leg roles", () => {
	it("has exactly two sides that are each other's opposite", () => {
		expect(LEG_ROLES).toEqual(["a", "b"]);
		expect(oppositeLegRole("a")).toBe("b");
		expect(oppositeLegRole("b")).toBe("a");
		for (const role of LEG_ROLES) {
			expect(oppositeLegRole(oppositeLegRole(role))).toBe(role);
		}
	});

	it("guards values arriving from the wire", () => {
		expect(isLegRole("a")).toBe(true);
		expect(isLegRole("A")).toBe(false);
		expect(isLegRole("c")).toBe(false);
	});
});

describe("bridge lifecycle", () => {
	it("covers exactly the three documented states", () => {
		expect(BRIDGE_STATES).toEqual(["pending", "bridged", "unbridged"]);
		expect(Object.keys(VALID_BRIDGE_TRANSITIONS).sort()).toEqual([...BRIDGE_STATES].sort());
		expect(INITIAL_BRIDGE_STATE).toBe("pending");
	});

	it("never lists a state as its own successor", () => {
		for (const state of BRIDGE_STATES) {
			expect(bridgeTransitionsFrom(state)).not.toContain(state);
		}
	});

	// Rejoining the same legs mints a new bridge id, which keeps CDR bridge records unambiguous.
	it("makes unbridged terminal and never walks back to bridged", () => {
		expect(BRIDGE_STATES.filter(isTerminalBridgeState)).toEqual(["unbridged"]);
		expect(isValidBridgeTransition("unbridged", "bridged")).toBe(false);
		expect(isValidBridgeTransition("unbridged", "pending")).toBe(false);
		expect(isValidBridgeTransition("bridged", "pending")).toBe(false);
	});

	// A ring-all dial abandons its pending bridges without any of them ever joining.
	it("lets a pending bridge be abandoned without bridging", () => {
		expect(isValidBridgeTransition("pending", "unbridged")).toBe(true);
	});

	it("guards before executing, and reports both ends of the rejected edge", () => {
		expect(() => assertBridgeTransition("pending", "bridged")).not.toThrow();

		try {
			assertBridgeTransition("unbridged", "bridged");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidBridgeTransitionError);
			const transition = error as InvalidBridgeTransitionError;
			expect(transition.from).toBe("unbridged");
			expect(transition.to).toBe("bridged");
		}
	});

	it("guards values arriving from the wire", () => {
		expect(isBridgeState("bridged")).toBe(true);
		expect(isBridgeState("BRIDGED")).toBe(false);
	});
});
