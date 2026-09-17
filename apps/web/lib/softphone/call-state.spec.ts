import { describe, expect, it } from "bun:test";
import {
	canPlaceCall,
	hasActiveCall,
	INITIAL_SOFTPHONE_STATE,
	softphoneReducer,
	type SoftphoneEvent,
	type SoftphoneState,
} from "./call-state";

/**
 * The softphone state machine, driven by folding event lists.
 *
 * The reducer is the whole tested surface of the SIP stack — the socket is integration and lives in
 * the jssip adapter. What matters here is that a call walks its lifecycle correctly and that stray
 * events (a late `ended`, a hold with no call, a second incoming while one is up) are ignored rather
 * than fabricating or corrupting a call.
 */

function run(events: readonly SoftphoneEvent[], from = INITIAL_SOFTPHONE_STATE): SoftphoneState {
	return events.reduce(softphoneReducer, from);
}

const REGISTERED: SoftphoneEvent = { type: "REGISTRATION_CHANGED", state: "registered" };
const INCOMING: SoftphoneEvent = {
	type: "INCOMING_CALL",
	peer: { identity: "1002", displayName: "Sales" },
};
const OUTGOING: SoftphoneEvent = {
	type: "OUTGOING_CALL",
	peer: { identity: "1003", displayName: null },
};

describe("registration", () => {
	it("clears the error on a successful registration", () => {
		const state = run([
			{ type: "REGISTRATION_CHANGED", state: "registration-failed", error: "boom" },
			REGISTERED,
		]);
		expect(state.registration).toBe("registered");
		expect(state.error).toBeNull();
	});

	it("records the failure reason and defaults it", () => {
		expect(run([{ type: "REGISTRATION_CHANGED", state: "registration-failed" }]).error).toBe(
			"Registration failed",
		);
	});

	it("gates call placement on being registered and idle", () => {
		expect(canPlaceCall(INITIAL_SOFTPHONE_STATE)).toBe(false);
		expect(canPlaceCall(run([REGISTERED]))).toBe(true);
		expect(canPlaceCall(run([REGISTERED, OUTGOING]))).toBe(false);
	});
});

describe("a full incoming call", () => {
	it("rings, confirms, then ends", () => {
		const ringing = run([REGISTERED, INCOMING]);
		expect(ringing.call.status).toBe("ringing");
		expect(ringing.call.direction).toBe("incoming");
		expect(ringing.call.peer?.identity).toBe("1002");

		const active = softphoneReducer(ringing, { type: "CALL_CONFIRMED", at: 1000 });
		expect(active.call.status).toBe("active");
		expect(active.call.connectedAt).toBe(1000);
		expect(hasActiveCall(active)).toBe(true);

		const ended = softphoneReducer(active, { type: "CALL_ENDED", reason: "Normal Clearing" });
		expect(ended.call.status).toBe("ended");
		expect(ended.call.endedReason).toBe("Normal Clearing");
	});
});

describe("in-call controls only apply to an active call", () => {
	const active = run([REGISTERED, OUTGOING, { type: "CALL_CONFIRMED", at: 5 }]);

	it("tracks hold and mute", () => {
		const held = softphoneReducer(active, { type: "HOLD_CHANGED", onHold: true });
		expect(held.call.onHold).toBe(true);
		const muted = softphoneReducer(active, { type: "MUTE_CHANGED", muted: true });
		expect(muted.call.muted).toBe(true);
	});

	it("accumulates DTMF in order", () => {
		const dialed = run(
			[
				{ type: "DTMF_SENT", tone: "1" },
				{ type: "DTMF_SENT", tone: "2" },
			],
			active,
		);
		expect(dialed.call.dtmfSent).toBe("12");
	});

	it("ignores hold/mute/DTMF when the call is only ringing", () => {
		const ringing = run([REGISTERED, OUTGOING]);
		expect(softphoneReducer(ringing, { type: "HOLD_CHANGED", onHold: true }).call.onHold).toBe(
			false,
		);
		expect(softphoneReducer(ringing, { type: "DTMF_SENT", tone: "9" }).call.dtmfSent).toBe("");
	});
});

describe("stray events do not corrupt state", () => {
	it("ignores a second incoming call while one is live", () => {
		const busy = run([REGISTERED, INCOMING]);
		const second = softphoneReducer(busy, {
			type: "INCOMING_CALL",
			peer: { identity: "9999", displayName: null },
		});
		expect(second.call.peer?.identity).toBe("1002");
	});

	it("ignores CALL_CONFIRMED with no ringing call", () => {
		const state = run([REGISTERED, { type: "CALL_CONFIRMED", at: 1 }]);
		expect(state.call.status).toBe("idle");
	});

	it("ignores CALL_ENDED when idle", () => {
		expect(run([REGISTERED, { type: "CALL_ENDED", reason: "x" }]).call.status).toBe("idle");
	});

	it("only resets a terminal call", () => {
		const active = run([REGISTERED, OUTGOING, { type: "CALL_CONFIRMED", at: 1 }]);
		expect(softphoneReducer(active, { type: "RESET_CALL" }).call.status).toBe("active");
		const ended = softphoneReducer(active, { type: "CALL_ENDED", reason: "bye" });
		expect(softphoneReducer(ended, { type: "RESET_CALL" }).call.status).toBe("idle");
	});
});
