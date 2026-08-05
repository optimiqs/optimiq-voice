import { describe, expect, it } from "bun:test";
import { ARI_CHANNEL_STATES } from "@optimiq-voice/media-ari";
import {
	EXTENDED_HANGUP_CAUSES,
	HANGUP_CAUSE_CODES,
	Q850_HANGUP_CAUSES,
} from "@optimiq-voice/telephony";
import {
	ariReasonCodeFor,
	callDirectionFrom,
	callStateFromAriChannelState,
	dialStringOr,
	hangupCauseFromAri,
	hangupSideFor,
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
