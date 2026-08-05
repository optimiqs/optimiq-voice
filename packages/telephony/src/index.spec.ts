import { describe, expect, it } from "bun:test";
import packageJson from "../package.json" with { type: "json" };
import * as telephony from "./index";

/**
 * `@optimiq-voice/telephony` is the pure call domain. Its value comes entirely from being safe to
 * import anywhere — the engine, the control plane, the routing compiler, the CDR writer, a test —
 * which only holds while it stays dependency-free. A single `drizzle-orm` or `@nestjs/common`
 * import here drags a database driver into every consumer, so the constraint is enforced rather
 * than documented.
 */
describe("package purity", () => {
	it("declares no runtime dependencies", () => {
		expect((packageJson as { dependencies?: Record<string, string> }).dependencies).toBeUndefined();
	});

	it("declares no peer dependencies", () => {
		expect(
			(packageJson as { peerDependencies?: Record<string, string> }).peerDependencies,
		).toBeUndefined();
	});
});

describe("public surface", () => {
	it("re-exports every module's entry points", () => {
		for (const name of [
			"VALID_CHANNEL_TRANSITIONS",
			"assertChannelTransition",
			"VALID_CALL_STATE_TRANSITIONS",
			"aggregateDeviceState",
			"HANGUP_CAUSES",
			"isRetryableCause",
			"BRIDGE_MODES",
			"assertBridgeTransition",
			"VERB_NAMES",
			"verbRequiresMediaPath",
			"DTMF_DIGITS",
			"parseDtmfDigits",
			"CALL_EVENT_NAMES",
			"CHANNEL_FLAGS",
			"InvalidChannelTransitionError",
		] as const) {
			expect(telephony).toHaveProperty(name);
		}
	});

	it("gives every telephony error a common base", () => {
		expect(new telephony.InvalidChannelTransitionError("created", "executing")).toBeInstanceOf(
			telephony.TelephonyError,
		);
		expect(new telephony.InvalidCallStateTransitionError("down", "held")).toBeInstanceOf(
			telephony.TelephonyError,
		);
		expect(new telephony.InvalidBridgeTransitionError("unbridged", "bridged")).toBeInstanceOf(
			telephony.TelephonyError,
		);
	});
});
