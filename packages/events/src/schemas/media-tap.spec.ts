import { describe, expect, it } from "bun:test";
import { makeCallEvent } from "./call-events";
import {
	mediaTapSessionRequestSchema,
	mediaTapSessionResponseSchema,
	mediaUntapSessionRequestSchema,
	mediaUntapSessionResponseSchema,
} from "./rpc";
import { TAP_MODES } from "./telephony";

/**
 * The supervision contract — `rpc.media.v1.tap-session` and the two audit events beside it.
 *
 * These assertions exist because this pair is the ONE media family declared before its responder:
 * `mediad` refuses the operation until rung 6, so nothing on the wire is exercising the shape yet
 * and the only thing standing between it and a silent drift is this file. What is pinned is
 * therefore what a rung-6 implementer must be able to rely on: that `hear` and `speakTo` are
 * independent, that the defaults are the SILENT ones, and that the three industry features are
 * three argument combinations rather than three fields.
 *
 * The design decision behind that shape — a tap is an asymmetric bridge participant, not a snoop
 * channel — is recorded in `plans/mediad-design.md` §10 question 4.
 */

const TAP_SESSION = "018f2b7c-0000-7000-8000-0000000000e1";
const TARGET_SESSION = "018f2b7c-0000-7000-8000-0000000000e2";
const ORG = "018f2b7c-0000-7000-8000-0000000000aa";
const CALL = "018f2b7c-0000-7000-8000-0000000000bb";
const SUPERVISOR_LEG = "018f2b7c-0000-7000-8000-0000000000cc";
const TARGET_LEG = "018f2b7c-0000-7000-8000-0000000000cd";

describe("rpc.media.v1.tap-session", () => {
	it("defaults to the silent combination, so a forgotten field cannot make a supervisor audible", () => {
		const parsed = mediaTapSessionRequestSchema.parse({
			tapId: "tap-1",
			tapSessionId: TAP_SESSION,
			targetSessionId: TARGET_SESSION,
		});

		expect(parsed.hear).toBe("both");
		expect(parsed.speakTo).toBe("none");
	});

	it("expresses eavesdrop, whisper and barge as three points on two axes", () => {
		const of = (hear: string, speakTo: string) =>
			mediaTapSessionRequestSchema.parse({
				tapId: "tap-1",
				tapSessionId: TAP_SESSION,
				targetSessionId: TARGET_SESSION,
				hear,
				speakTo,
			});

		expect(of("both", "none")).toMatchObject({ hear: "both", speakTo: "none" });
		expect(of("both", "b")).toMatchObject({ hear: "both", speakTo: "b" });
		expect(of("both", "both")).toMatchObject({ hear: "both", speakTo: "both" });
	});

	it("carries the feature's own name for the log, and it is optional", () => {
		for (const mode of TAP_MODES) {
			const parsed = mediaTapSessionRequestSchema.parse({
				tapId: "tap-1",
				tapSessionId: TAP_SESSION,
				targetSessionId: TARGET_SESSION,
				mode,
			});
			expect(parsed.mode).toBe(mode);
		}

		expect(
			mediaTapSessionRequestSchema.parse({
				tapId: "tap-1",
				tapSessionId: TAP_SESSION,
				targetSessionId: TARGET_SESSION,
			}).mode,
		).toBeUndefined();
	});

	it("names the target by SESSION, never by bridge", () => {
		// On the relay a bridge only exists once two members are in it, so a caller that had to
		// supply a bridge id would be naming something it may never have been told about.
		const result = mediaTapSessionRequestSchema.safeParse({
			tapId: "tap-1",
			tapSessionId: TAP_SESSION,
			bridgeId: "bridge-1",
		});
		expect(result.success).toBe(false);
	});

	it("refuses a side outside the lattice", () => {
		const result = mediaTapSessionRequestSchema.safeParse({
			tapId: "tap-1",
			tapSessionId: TAP_SESSION,
			targetSessionId: TARGET_SESSION,
			hear: "everyone",
		});
		expect(result.success).toBe(false);
	});

	it("answers with an empty session list on a refusal rather than omitting the field", () => {
		const parsed = mediaTapSessionResponseSchema.parse({
			ok: false,
			tapId: "tap-1",
			reason: "not_supported",
			error: "asymmetric bridge participation is rung 6",
		});
		expect(parsed.sessionIds).toEqual([]);
		expect(parsed.bridgeId).toBeUndefined();
	});
});

describe("rpc.media.v1.untap-session", () => {
	it("is keyed by the tap reference alone", () => {
		expect(mediaUntapSessionRequestSchema.parse({ tapId: "tap-1" })).toEqual({ tapId: "tap-1" });
	});

	it("reports an already-gone tap as a success", () => {
		// The engine retries an untap when a reply is lost, and a monitored conversation that
		// survived the retry is not a failure.
		const parsed = mediaUntapSessionResponseSchema.parse({ ok: true, tapId: "tap-1" });
		expect(parsed.untapped).toBe(false);
	});
});

describe("the tap audit trail", () => {
	it("puts a tap on the MONITORED call's subject, not the supervisor's", () => {
		const event = makeCallEvent("call.tap.started", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: {
				legId: SUPERVISOR_LEG,
				mode: "eavesdrop",
				supervisorExtension: "1900",
				targetExtension: "1001",
				targetLegId: TARGET_LEG,
			},
		});

		expect(event.subject).toBe(`calls.evt.v1.${ORG}.${CALL}.call.tap.started`);
		expect(event.data.legId).toBe(SUPERVISOR_LEG);
	});

	it("distinguishes a first tap from an escalation by whether previousMode is present", () => {
		const first = makeCallEvent("call.tap.started", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: {
				legId: SUPERVISOR_LEG,
				mode: "eavesdrop",
				supervisorExtension: "1900",
				targetExtension: "1001",
			},
		});
		const escalated = makeCallEvent("call.tap.started", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: {
				legId: SUPERVISOR_LEG,
				mode: "barge",
				previousMode: "eavesdrop",
				supervisorExtension: "1900",
				targetExtension: "1001",
			},
		});

		expect(first.data.previousMode).toBeUndefined();
		expect(escalated.data.previousMode).toBe("eavesdrop");
	});

	it("keeps 'the supervisor left' and 'the call ended' as different facts", () => {
		const ended = makeCallEvent("call.tap.ended", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: {
				legId: SUPERVISOR_LEG,
				mode: "eavesdrop",
				supervisorExtension: "1900",
				targetExtension: "1001",
				reason: "supervisor-ended",
				durationMs: 12_000,
			},
		});
		expect(ended.data.reason).toBe("supervisor-ended");

		// The other outcome is a DIFFERENT statement — the conversation finished on its own and the
		// rest of it was never unmonitored — which is why they are not one `ended` reason.
		const targetEnded = makeCallEvent("call.tap.ended", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: {
				legId: SUPERVISOR_LEG,
				mode: "eavesdrop",
				supervisorExtension: "1900",
				targetExtension: "1001",
				reason: "target-ended",
			},
		});
		expect(targetEnded.data.reason).toBe("target-ended");
		expect(targetEnded.data.durationMs).toBeUndefined();
	});
});

describe("the paging audit trail", () => {
	it("reports what was attempted and what actually answered", () => {
		const started = makeCallEvent("call.paging.started", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: {
				legId: SUPERVISOR_LEG,
				pagingGroupId: TARGET_LEG,
				pagingGroupName: "Warehouse",
				memberCount: 12,
				answeredCount: 10,
				oneWay: true,
			},
		});

		expect(started.data.memberCount).toBe(12);
		expect(started.data.answeredCount).toBe(10);
		expect(started.data.oneWay).toBe(true);
	});

	it("pairs with an ended event that bounds the announcement", () => {
		const ended = makeCallEvent("call.paging.ended", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: {
				legId: SUPERVISOR_LEG,
				pagingGroupId: TARGET_LEG,
				pagingGroupName: "Warehouse",
				durationMs: 9_500,
			},
		});

		expect(ended.subject).toBe(`calls.evt.v1.${ORG}.${CALL}.call.paging.ended`);
		expect(ended.data.durationMs).toBe(9_500);
	});
});
