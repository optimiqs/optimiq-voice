import { describe, expect, it } from "bun:test";
import {
	CHANNEL_DIRECTIONS,
	CHANNEL_FLAGS,
	hasChannelFlag,
	hasMediaPath,
	isChannelDirection,
	isChannelFlag,
	isVariableScope,
	VARIABLE_SCOPES,
	type ChannelSnapshot,
} from "./channel";

const baseChannel: ChannelSnapshot = {
	channelId: "chan-1",
	callId: "call-1",
	organizationId: "org-1",
	direction: "inbound",
	state: "executing",
	callState: "ringing",
	flags: [],
	profile: { destinationNumber: "1001", context: "default" },
	variables: {},
	createdAt: 0,
};

/** Pinned against `plans/reference/freeswitch-capabilities.md` §1 (flags) and §7 (variable scopes). */
describe("channel shape", () => {
	it("covers the documented flags exactly once each", () => {
		expect(new Set(CHANNEL_FLAGS).size).toBe(CHANNEL_FLAGS.length);
		for (const flag of [
			"answered",
			"outbound",
			"early-media",
			"bridged",
			"hold",
			"transfer",
			"attended-transfer",
			"redirect",
			"park",
			"proxy-mode",
			"proxy-media",
			"video",
		] as const) {
			expect(CHANNEL_FLAGS).toContain(flag);
		}
	});

	it("has two directions and three variable scopes", () => {
		expect(CHANNEL_DIRECTIONS).toEqual(["inbound", "outbound"]);
		expect(VARIABLE_SCOPES).toEqual(["channel", "export", "global"]);
	});

	it("guards values arriving from the wire", () => {
		expect(isChannelDirection("outbound")).toBe(true);
		expect(isChannelDirection("OUTBOUND")).toBe(false);
		expect(isChannelFlag("early-media")).toBe(true);
		expect(isChannelFlag("EARLY_MEDIA")).toBe(false);
		expect(isVariableScope("export")).toBe(true);
		expect(isVariableScope("nolocal")).toBe(false);
	});

	// Flags combine: a leg can be answered and bridged and held and mid-transfer at once, and
	// collapsing that into a single enum is how transfer bugs are born.
	it("reads flags independently of each other", () => {
		const channel: ChannelSnapshot = {
			...baseChannel,
			callState: "held",
			flags: ["answered", "bridged", "hold", "transfer", "attended-transfer"],
		};

		expect(hasChannelFlag(channel, "answered")).toBe(true);
		expect(hasChannelFlag(channel, "attended-transfer")).toBe(true);
		expect(hasChannelFlag(channel, "park")).toBe(false);
	});
});

/**
 * Media verbs need an answered or early-media leg (reference §1). Answering implicitly to satisfy
 * a play verb bills the caller for a call they never got.
 */
describe("hasMediaPath", () => {
	it("is false before any progress", () => {
		expect(hasMediaPath(baseChannel)).toBe(false);
		expect(hasMediaPath({ ...baseChannel, flags: ["outbound"] })).toBe(false);
	});

	it("is true once early media is open, before answer", () => {
		expect(hasMediaPath({ ...baseChannel, callState: "early", flags: ["early-media"] })).toBe(true);
	});

	it("is true once answered", () => {
		expect(hasMediaPath({ ...baseChannel, callState: "active", flags: ["answered"] })).toBe(true);
	});
});
