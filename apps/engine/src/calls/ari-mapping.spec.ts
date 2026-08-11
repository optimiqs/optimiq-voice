import { describe, expect, it } from "bun:test";
import { ARI_CHANNEL_STATES, ARI_EVENT_TYPES, parseAriEvent } from "@optimiq-voice/media-ari";
import {
	EXTENDED_HANGUP_CAUSES,
	HANGUP_CAUSE_CODES,
	Q850_HANGUP_CAUSES,
} from "@optimiq-voice/telephony";
import { MEDIA_EVENT_TYPES } from "../media/media-event";
import {
	ariReasonCodeFor,
	callDirectionFrom,
	callStateFromAriChannelState,
	dialStringOr,
	hangupCauseFromAri,
	hangupSideFor,
	toMediaEvent,
	UNKNOWN_DIAL_STRING,
} from "./ari-mapping";

describe("callDirectionFrom", () => {
	it("reads the three known directions, case-insensitively", () => {
		expect(callDirectionFrom("inbound")).toBe("inbound");
		expect(callDirectionFrom("OUTBOUND")).toBe("outbound");
		expect(callDirectionFrom(" Internal ")).toBe("internal");
	});

	it("defaults to inbound — the only direction that cannot bill a tenant wrongly", () => {
		expect(callDirectionFrom(undefined)).toBe("inbound");
		expect(callDirectionFrom("")).toBe("inbound");
		expect(callDirectionFrom("sideways")).toBe("inbound");
	});
});

describe("callStateFromAriChannelState", () => {
	it("maps the pre-dial states to down", () => {
		expect(callStateFromAriChannelState("Down")).toBe("down");
		expect(callStateFromAriChannelState("Rsrvd")).toBe("down");
		expect(callStateFromAriChannelState("Pre-ring")).toBe("down");
	});

	it("maps both alerting states to ringing, because a BLF watcher cannot tell them apart", () => {
		expect(callStateFromAriChannelState("Ring")).toBe("ringing");
		expect(callStateFromAriChannelState("Ringing")).toBe("ringing");
	});

	it("maps Up to active — where the billing clock starts", () => {
		expect(callStateFromAriChannelState("Up")).toBe("active");
	});

	it("maps the dialing states to dialing", () => {
		expect(callStateFromAriChannelState("Dialing")).toBe("dialing");
		expect(callStateFromAriChannelState("Dialing Offhook")).toBe("dialing");
	});

	it("returns undefined rather than inventing a transition for a state with no meaning", () => {
		expect(callStateFromAriChannelState("Busy")).toBeUndefined();
		expect(callStateFromAriChannelState("OffHook")).toBeUndefined();
		expect(callStateFromAriChannelState("Unknown")).toBeUndefined();
		expect(callStateFromAriChannelState("SomethingAsterisk23Invents")).toBeUndefined();
	});

	it("handles every state Asterisk 22 documents without throwing", () => {
		for (const state of ARI_CHANNEL_STATES) {
			expect(() => callStateFromAriChannelState(state)).not.toThrow();
		}
	});
});

describe("hangupCauseFromAri", () => {
	it("names the codes the taxonomy knows", () => {
		expect(hangupCauseFromAri(16)).toBe("NORMAL_CLEARING");
		expect(hangupCauseFromAri(17)).toBe("USER_BUSY");
		expect(hangupCauseFromAri(21)).toBe("CALL_REJECTED");
		expect(hangupCauseFromAri(0)).toBe("NONE");
	});

	it("falls back to NORMAL_UNSPECIFIED for an unnamed Q.850 point", () => {
		// 47 is "resource unavailable, unspecified" — real, and deliberately not named.
		expect(hangupCauseFromAri(47)).toBe("NORMAL_UNSPECIFIED");
		expect(hangupCauseFromAri(9999)).toBe("NORMAL_UNSPECIFIED");
	});

	it("round-trips every named Q.850 cause", () => {
		for (const cause of Q850_HANGUP_CAUSES) {
			expect(hangupCauseFromAri(HANGUP_CAUSE_CODES[cause])).toBe(cause);
		}
	});
});

describe("ariReasonCodeFor", () => {
	it("passes a Q.850 cause through unchanged", () => {
		expect(ariReasonCodeFor("NORMAL_CLEARING")).toBe(16);
		expect(ariReasonCodeFor("USER_BUSY")).toBe(17);
		expect(ariReasonCodeFor("INTERWORKING")).toBe(127);
	});

	it("has a surrogate for EVERY extended cause — the gap the type system cannot see", () => {
		for (const cause of EXTENDED_HANGUP_CAUSES) {
			const code = ariReasonCodeFor(cause);
			expect(code).toBeGreaterThanOrEqual(0);
			expect(code).toBeLessThanOrEqual(127);
		}
	});

	it("keeps a losing ring-all leg distinguishable from a caller who hung up", () => {
		expect(ariReasonCodeFor("LOSE_RACE")).toBe(26);
		expect(ariReasonCodeFor("LOSE_RACE")).not.toBe(ariReasonCodeFor("NORMAL_CLEARING"));
	});

	it("maps every timeout onto the recovery-on-timer point", () => {
		expect(ariReasonCodeFor("ALLOTTED_TIMEOUT")).toBe(102);
		expect(ariReasonCodeFor("MEDIA_TIMEOUT")).toBe(102);
		expect(ariReasonCodeFor("PROGRESS_TIMEOUT")).toBe(102);
	});
});

describe("hangupSideFor", () => {
	it("attributes an engine-initiated hangup to the system", () => {
		expect(hangupSideFor({ leg: "a", initiatedByEngine: true })).toBe("system");
		expect(hangupSideFor({ leg: "b", initiatedByEngine: true })).toBe("system");
	});

	it("attributes a far-end hangup by the leg's role", () => {
		expect(hangupSideFor({ leg: "a", initiatedByEngine: false })).toBe("caller");
		expect(hangupSideFor({ leg: "b", initiatedByEngine: false })).toBe("callee");
	});
});

describe("dialStringOr", () => {
	it("passes a real value through, trimmed", () => {
		expect(dialStringOr(" +15551234567 ")).toBe("+15551234567");
	});

	it("substitutes a marker for the empty caller id of an anonymous call", () => {
		expect(dialStringOr(undefined)).toBe(UNKNOWN_DIAL_STRING);
		expect(dialStringOr("")).toBe(UNKNOWN_DIAL_STRING);
		expect(dialStringOr("   ")).toBe(UNKNOWN_DIAL_STRING);
	});

	it("never returns an empty string, which the wire contract rejects", () => {
		for (const input of [undefined, "", " ", "x"]) {
			expect(dialStringOr(input).length).toBeGreaterThan(0);
		}
	});
});

/**
 * The event seam.
 *
 * This is the file that decides what the engine is told, so these cases are the proof that
 * replacing Asterisk is a change to `ari-mapping.ts` and `ari-media.adapter.ts` and nothing else.
 * Two properties matter more than any single mapping: that every ARI event is ACCOUNTED FOR (never
 * a crash, never a silent misread), and that every `MediaEvent` member is REACHABLE from a real
 * frame — a domain member nothing produces is a shape `mediad` would have to guess at.
 */
describe("toMediaEvent", () => {
	const CHANNEL = {
		id: "1754400000.42",
		name: "PJSIP/trunk-00000001",
		state: "Ring",
		caller: { name: "Ada", number: "+15551234567" },
		dialplan: { context: "local-ctx", exten: "+15559876543", priority: 1 },
	};

	function mapped(type: string, extra: Record<string, unknown> = {}) {
		return toMediaEvent(parseAriEvent({ type, application: "optimiq-engine", ...extra }));
	}

	it("lifts an arriving leg into a domain snapshot of the six fields the engine reads", () => {
		expect(
			mapped("StasisStart", { channel: { ...CHANNEL, channelvars: { OPTIMIQ_LEG: "b" } } }),
		).toEqual({
			type: "leg-arrived",
			channel: {
				id: "1754400000.42",
				name: "PJSIP/trunk-00000001",
				callerName: "Ada",
				callerNumber: "+15551234567",
				dialedNumber: "+15559876543",
				context: "local-ctx",
				variables: { OPTIMIQ_LEG: "b" },
			},
		});
	});

	it("gives an anonymous call an empty snapshot rather than dropping the arrival", () => {
		// No caller, no dialplan, no exported variables — an INVITE the edge could not enrich. The
		// call still has to be routed, so the fields are absent and the consumers decide what an
		// absent caller id means to them.
		expect(mapped("StasisStart", { channel: { id: "x", name: "", state: "Down" } })).toEqual({
			type: "leg-arrived",
			channel: { id: "x", name: "", variables: {} },
		});
	});

	it("translates a state change into the domain call state, not the media server's", () => {
		expect(mapped("ChannelStateChange", { channel: { ...CHANNEL, state: "Up" } })).toEqual({
			type: "call-state-changed",
			channelId: CHANNEL.id,
			callState: "active",
		});
	});

	it("produces NO event for a state with no user-visible meaning", () => {
		// The engine's old `default:` dropped these one layer up. Dropping them here is what keeps
		// `MediaEvent` free of an ARI-shaped hole — a state change carrying no domain state.
		for (const state of ["Busy", "OffHook", "Unknown", "SomethingAsterisk23Invents"]) {
			expect(mapped("ChannelStateChange", { channel: { ...CHANNEL, state } })).toBeUndefined();
		}
	});

	it("carries a digit and its tone length", () => {
		expect(
			mapped("ChannelDtmfReceived", { channel: CHANNEL, digit: "7", duration_ms: 130 }),
		).toEqual({ type: "dtmf-received", channelId: CHANNEL.id, digit: "7", durationMs: 130 });
	});

	it("names the cause on a hangup request, and reads a missing one as a normal hangup", () => {
		expect(mapped("ChannelHangupRequest", { channel: CHANNEL, cause: 17 })).toEqual({
			type: "hangup-requested",
			channelId: CHANNEL.id,
			cause: "USER_BUSY",
		});
		// The request arrived, so somebody ended the call deliberately; `NONE` would say the
		// opposite — that no cause was ever signalled.
		expect(mapped("ChannelHangupRequest", { channel: CHANNEL })).toEqual({
			type: "hangup-requested",
			channelId: CHANNEL.id,
			cause: "NORMAL_CLEARING",
		});
	});

	it("keeps the raw code beside the named cause when the leg ends", () => {
		// 47 is real and deliberately unnamed: without the integer the CDR would lose the only
		// evidence of what the carrier actually said.
		expect(mapped("ChannelDestroyed", { channel: CHANNEL, cause: 47 })).toEqual({
			type: "leg-ended",
			channelId: CHANNEL.id,
			cause: "NORMAL_UNSPECIFIED",
			causeCode: 47,
		});
	});

	it("passes a channel-scoped variable through and drops a global one", () => {
		expect(
			mapped("ChannelVarset", { channel: CHANNEL, variable: "OPTIMIQ_X", value: "1" }),
		).toEqual({
			type: "variable-set",
			channelId: CHANNEL.id,
			variable: "OPTIMIQ_X",
			value: "1",
		});
		// The engine's state is per-leg; a global has nothing to be applied to.
		expect(mapped("ChannelVarset", { variable: "OPTIMIQ_X", value: "1" })).toBeUndefined();
	});

	it("splits hold and unhold into two members, carrying the music class only where it exists", () => {
		expect(mapped("ChannelHold", { channel: CHANNEL, musicclass: "default" })).toEqual({
			type: "leg-held",
			channelId: CHANNEL.id,
			musicClass: "default",
		});
		expect(mapped("ChannelHold", { channel: CHANNEL })).toEqual({
			type: "leg-held",
			channelId: CHANNEL.id,
		});
		expect(mapped("ChannelUnhold", { channel: CHANNEL })).toEqual({
			type: "leg-unheld",
			channelId: CHANNEL.id,
		});
	});

	it("converts a recording duration to milliseconds, the unit above the seam", () => {
		const recording = { name: "call-1", format: "wav", target_uri: "", state: "done" };
		expect(mapped("RecordingFinished", { recording: { ...recording, duration: 12 } })).toEqual({
			type: "recording-finished",
			recordingName: "call-1",
			durationMs: 12_000,
		});
		// A finished recording with no duration is a zero-length one, not an unknown one.
		expect(mapped("RecordingFinished", { recording })).toEqual({
			type: "recording-finished",
			recordingName: "call-1",
			durationMs: 0,
		});
		expect(mapped("RecordingStarted", { recording })).toEqual({
			type: "recording-started",
			recordingName: "call-1",
		});
	});

	it("reports a recording failure with whatever reason the media server could give", () => {
		const recording = { name: "call-1", format: "wav", target_uri: "", state: "failed" };
		expect(mapped("RecordingFailed", { recording: { ...recording, cause: "disk full" } })).toEqual({
			type: "recording-failed",
			recordingName: "call-1",
			reason: "disk full",
		});
		expect(mapped("RecordingFailed", { recording })).toEqual({
			type: "recording-failed",
			recordingName: "call-1",
			reason: "unknown",
		});
	});

	it("answers undefined for every event the engine does not act on", () => {
		// Real information, no consumer. Listed one by one rather than as "the rest", so that
		// wiring one up later is a deliberate deletion from this list.
		const bridge = { id: "b1", technology: "simple_bridge" };
		const playback = { id: "p1", media_uri: "sound:hello", target_uri: "", state: "done" };
		expect(mapped("ChannelCreated", { channel: CHANNEL })).toBeUndefined();
		expect(mapped("ChannelDialplan", { channel: CHANNEL })).toBeUndefined();
		expect(mapped("PlaybackStarted", { playback })).toBeUndefined();
		expect(mapped("PlaybackFinished", { playback })).toBeUndefined();
		expect(mapped("BridgeCreated", { bridge })).toBeUndefined();
		expect(mapped("BridgeDestroyed", { bridge })).toBeUndefined();
		expect(mapped("ChannelEnteredBridge", { bridge, channel: CHANNEL })).toBeUndefined();
		expect(mapped("ChannelLeftBridge", { bridge, channel: CHANNEL })).toBeUndefined();
		expect(mapped("Dial", { peer: CHANNEL, dialstatus: "ANSWER" })).toBeUndefined();
		expect(mapped("PeerStatusChange", { peer: { peer_status: "Reachable" } })).toBeUndefined();
	});

	it("accounts for EVERY ARI event type — no throw, and a decision either way", () => {
		const bridge = { id: "b1", technology: "simple_bridge" };
		const recording = { name: "call-1", format: "wav", target_uri: "", state: "done" };
		const playback = { id: "p1", media_uri: "sound:hello", target_uri: "", state: "done" };
		for (const type of ARI_EVENT_TYPES) {
			const event = () =>
				mapped(type, {
					channel: CHANNEL,
					peer: CHANNEL,
					bridge,
					recording,
					playback,
					variable: "OPTIMIQ_X",
					value: "1",
					digit: "1",
					dialstatus: "ANSWER",
				});
			expect(event).not.toThrow();
		}
	});

	it("can produce every member of MediaEvent from a real frame", () => {
		const bridge = { id: "b1", technology: "simple_bridge" };
		const recording = { name: "call-1", format: "wav", target_uri: "", state: "done" };
		const playback = { id: "p1", media_uri: "sound:hello", target_uri: "", state: "done" };
		const produced = new Set(
			ARI_EVENT_TYPES.map(
				(type) =>
					mapped(type, {
						channel: { ...CHANNEL, state: "Up" },
						peer: CHANNEL,
						bridge,
						recording,
						playback,
						variable: "OPTIMIQ_X",
						value: "1",
						digit: "1",
						dialstatus: "ANSWER",
					})?.type,
			).filter((type) => type !== undefined),
		);
		expect([...produced].sort()).toEqual([...MEDIA_EVENT_TYPES].sort());
	});
});
