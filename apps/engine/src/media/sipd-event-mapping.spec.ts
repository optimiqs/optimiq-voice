import { describe, expect, it } from "bun:test";
import { makeSipDialogEvent, subjectFor } from "@optimiq-voice/events";
import { decodeSipdEvent, toMediaEventFromSipd } from "./sipd-event-mapping";
import type { SipDialogEventInput, SipTerminationReason } from "@optimiq-voice/events";

/**
 * The signalling plane's translation into the engine's own event union.
 *
 * Two things are worth proving here and nowhere else. That the six wire events land on members the
 * orchestrator ALREADY branches on — which is the whole claim of the third mapping file, and the
 * only way `leg-arrived` from either plane can be one code path. And that the Q.850 cause survives
 * this file untouched: `apps/sipd` saw the SIP response and may have been handed an RFC 3326 `Reason`
 * header, so a mapping that re-derived a cause would be replacing evidence with a guess.
 */

const ORG = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293";
const CALL = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b4c";
const LEG = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b53";

const IDENTITY = { sipCallId: "a84b4c76e66710@pc33", localTag: "9f2a11", remoteTag: "as58c1f2" };

function base(): { legId: string; callId: string; instanceId: string; role: "uas" } {
	return { legId: LEG, callId: CALL, instanceId: "sipd-7c9f", role: "uas" };
}

function progressed(overrides: { status?: number; hasEarlyMedia?: boolean } = {}) {
	return makeSipDialogEvent("dialog.progressed", {
		orgId: ORG,
		source: "sipd",
		data: {
			...base(),
			identity: IDENTITY,
			status: overrides.status ?? 180,
			hasEarlyMedia: overrides.hasEarlyMedia ?? false,
		},
	} as SipDialogEventInput<"dialog.progressed">);
}

function answered() {
	return makeSipDialogEvent("dialog.answered", {
		orgId: ORG,
		source: "sipd",
		data: { ...base(), identity: IDENTITY, setupMs: 4_200 },
	} as SipDialogEventInput<"dialog.answered">);
}

function held(direction: "sendonly" | "inactive" = "sendonly") {
	return makeSipDialogEvent("dialog.held", {
		orgId: ORG,
		source: "sipd",
		data: { ...base(), identity: IDENTITY, direction },
	} as SipDialogEventInput<"dialog.held">);
}

function resumed() {
	return makeSipDialogEvent("dialog.resumed", {
		orgId: ORG,
		source: "sipd",
		data: { ...base(), identity: IDENTITY, direction: "sendrecv" },
	} as SipDialogEventInput<"dialog.resumed">);
}

function terminated(
	overrides: {
		reason?: SipTerminationReason;
		cause?: number;
		causeFromReasonHeader?: boolean;
		status?: number;
	} = {},
) {
	return makeSipDialogEvent("dialog.terminated", {
		orgId: ORG,
		source: "sipd",
		data: {
			...base(),
			identity: IDENTITY,
			reason: overrides.reason ?? "bye",
			cause: overrides.cause ?? 16,
			causeFromReasonHeader: overrides.causeFromReasonHeader ?? false,
			...(overrides.status === undefined ? {} : { status: overrides.status }),
			initiator: "remote",
			answeredForSeconds: 42,
		},
	} as SipDialogEventInput<"dialog.terminated">);
}

function dtmf(overrides: { digit?: string; durationMs?: number } = {}) {
	return makeSipDialogEvent("dialog.dtmf", {
		orgId: ORG,
		source: "sipd",
		data: {
			...base(),
			identity: IDENTITY,
			digit: overrides.digit ?? "5",
			...(overrides.durationMs === undefined ? {} : { durationMs: overrides.durationMs }),
		},
	} as SipDialogEventInput<"dialog.dtmf">);
}

describe("translating a dialog event", () => {
	it("maps a plain 180 to ringing and a 183 with a body to early", () => {
		expect(toMediaEventFromSipd(progressed())).toEqual({
			type: "call-state-changed",
			channelId: LEG,
			callState: "ringing",
		});
		// The ONLY thing that separates them, and it is a billing fact rather than a nicety: a `183`
		// carrying an answer commits the offer/answer exchange and the caller may already hear audio.
		expect(toMediaEventFromSipd(progressed({ status: 183, hasEarlyMedia: true }))).toEqual({
			type: "call-state-changed",
			channelId: LEG,
			callState: "early",
		});
	});

	it("maps an answered dialog to the active state the CDR bills from", () => {
		expect(toMediaEventFromSipd(answered())).toEqual({
			type: "call-state-changed",
			channelId: LEG,
			callState: "active",
		});
	});

	it("maps hold and resume onto the members the orchestrator already has", () => {
		// `sendonly` versus `inactive` is deliberately dropped: `MediaLegHeldEvent`'s one optional
		// field is a MUSIC CLASS, and a direction attribute is not one.
		expect(toMediaEventFromSipd(held("inactive"))).toEqual({ type: "leg-held", channelId: LEG });
		expect(toMediaEventFromSipd(resumed())).toEqual({ type: "leg-unheld", channelId: LEG });
	});

	it("maps a SIP INFO digit onto the same member RFC 4733 digits land on", () => {
		expect(toMediaEventFromSipd(dtmf({ digit: "#", durationMs: 120 }))).toEqual({
			type: "dtmf-received",
			channelId: LEG,
			digit: "#",
			durationMs: 120,
		});
	});

	it("reports a missing INFO duration as zero rather than dropping the keypress", () => {
		// INFO bodies routinely omit it. A digit that never reached the inbox is a caller pressing 1
		// in an IVR and nothing happening.
		expect(toMediaEventFromSipd(dtmf())).toMatchObject({ digit: "5", durationMs: 0 });
	});
});

describe("the hangup cause on a terminated dialog", () => {
	it("carries the edge's Q.850 cause through untouched, name and code", () => {
		expect(
			toMediaEventFromSipd(terminated({ reason: "rejected", cause: 17, status: 486 })),
		).toEqual({ type: "leg-ended", channelId: LEG, cause: "USER_BUSY", causeCode: 17 });
	});

	it("does not re-derive a cause the far end supplied in an RFC 3326 Reason header", () => {
		// The far end's own switch said 21. Deriving 41 from the `503` it happened to arrive on would
		// be discarding better evidence for worse.
		const event = toMediaEventFromSipd(
			terminated({ reason: "rejected", cause: 21, status: 503, causeFromReasonHeader: true }),
		);
		expect(event).toMatchObject({ cause: "CALL_REJECTED", causeCode: 21 });
	});

	it("keeps a carrier's unnamed cause as the code, and names it from the termination reason", () => {
		// 60 is a real Q.850 point the domain taxonomy does not name. The NUMBER is the evidence and
		// survives; the name falls back to something a report can group by, not to a flat "unspecified".
		expect(toMediaEventFromSipd(terminated({ reason: "cancelled", cause: 60 }))).toEqual({
			type: "leg-ended",
			channelId: LEG,
			cause: "ORIGINATOR_CANCEL",
			causeCode: 60,
		});
	});

	it("names a reaped dialog as a temporary failure, distinctly from a timeout", () => {
		// A timeout is one call that went wrong; `instance-lost` is a pod that went away with N calls
		// on it, and the CDR should be able to tell an operator which of those happened.
		expect(toMediaEventFromSipd(terminated({ reason: "instance-lost", cause: 900 }))).toMatchObject(
			{
				cause: "NORMAL_TEMPORARY_FAILURE",
				causeCode: 900,
			},
		);
		expect(toMediaEventFromSipd(terminated({ reason: "timeout", cause: 900 }))).toMatchObject({
			cause: "ALLOTTED_TIMEOUT",
		});
	});

	it("names a replaced dialog as an attended transfer, so the CDR keeps the transfer", () => {
		expect(toMediaEventFromSipd(terminated({ reason: "replaced", cause: 900 }))).toMatchObject({
			cause: "ATTENDED_TRANSFER",
		});
	});
});

describe("decoding a delivered message", () => {
	it("accepts a well-formed event on its own subject", () => {
		const envelope = answered();
		const decoded = decodeSipdEvent(
			subjectFor.sipDialog(ORG, LEG, "dialog.answered"),
			JSON.parse(JSON.stringify(envelope)) as unknown,
		);

		expect(decoded?.envelope.type).toBe("dialog.answered");
		expect(decoded?.event).toMatchObject({ type: "call-state-changed", callState: "active" });
	});

	it("refuses a payload whose leg id disagrees with its subject", () => {
		// The mismatch nobody checks is the one that tears down somebody else's call.
		const other = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b99";
		expect(
			decodeSipdEvent(
				subjectFor.sipDialog(ORG, other, "dialog.terminated"),
				JSON.parse(JSON.stringify(terminated())) as unknown,
			),
		).toBeUndefined();
	});

	it("ignores a subject from another family, even a well-formed one", () => {
		// `sip.reg.v1` shares two of its three tokens with `sip.evt.v1` and is the family this one is
		// most likely to be confused with, so it is the one worth naming here.
		expect(
			decodeSipdEvent(
				`sip.reg.v1.${ORG}.aorhash.registered`,
				JSON.parse(JSON.stringify(answered())) as unknown,
			),
		).toBeUndefined();
	});

	it("ignores a payload that is not the contract rather than throwing at the subscription", () => {
		expect(
			decodeSipdEvent(subjectFor.sipDialog(ORG, LEG, "dialog.answered"), {
				type: "dialog.answered",
			}),
		).toBeUndefined();
		expect(decodeSipdEvent("sip.evt.v1.>", {})).toBeUndefined();
	});
});
