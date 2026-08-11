import { describe, expect, it } from "bun:test";
import {
	makeMediaEvent,
	mediaDtmfReceivedDataSchema,
	MEDIA_RECORDING_END_REASONS,
} from "./media-events";
import {
	mediaSendDtmfRequestSchema,
	mediaSendDtmfResponseSchema,
	mediaStartRecordingRequestSchema,
	mediaStartRecordingResponseSchema,
	mediaStopRecordingRequestSchema,
	mediaStopRecordingResponseSchema,
} from "./rpc";

/**
 * Rungs 3 and 4 of `plans/mediad-design.md` §2 — DTMF generation and recording.
 *
 * The assertions here are the ones a Go responder would otherwise discover at runtime: which
 * fields are required, which defaults the engine may rely on without sending them, and that
 * `recording.finished` derives its subject from the SESSION rather than the call.
 */

const ORG = "018f2b7c-0000-7000-8000-0000000000aa";
const SESSION = "018f2b7c-0000-7000-8000-0000000000dd";
const CALL = "018f2b7c-0000-7000-8000-0000000000bb";

describe("rpc.media.v1.send-dtmf", () => {
	it("takes a session and a digit string, and leaves the timings optional", () => {
		const parsed = mediaSendDtmfRequestSchema.parse({ sessionId: SESSION, digits: "1234" });
		expect(parsed).toEqual({ sessionId: SESSION, digits: "1234" });
	});

	it("accepts every digit RFC 4733 can carry", () => {
		expect(
			mediaSendDtmfRequestSchema.safeParse({ sessionId: SESSION, digits: "0123456789*#ABCD" })
				.success,
		).toBe(true);
	});

	it("refuses a character no telephone-event code exists for", () => {
		// A digit the media plane cannot encode must fail at the contract, not halfway through a
		// string: a caller who sent `12X4` and got `ok` would have delivered `12` and `4` to a far-end
		// IVR with no indication that anything was dropped.
		expect(
			mediaSendDtmfRequestSchema.safeParse({ sessionId: SESSION, digits: "12X4" }).success,
		).toBe(false);
		expect(mediaSendDtmfRequestSchema.safeParse({ sessionId: SESSION, digits: "" }).success).toBe(
			false,
		);
	});

	it("floors the tone at 40 ms, because a 20 ms digit is one packet a single loss erases", () => {
		expect(
			mediaSendDtmfRequestSchema.safeParse({ sessionId: SESSION, digits: "1", toneDurationMs: 20 })
				.success,
		).toBe(false);
		expect(
			mediaSendDtmfRequestSchema.safeParse({ sessionId: SESSION, digits: "1", gapMs: 0 }).success,
		).toBe(true);
	});

	it("carries a machine-readable reason when the leg negotiated no telephone-event type", () => {
		const parsed = mediaSendDtmfResponseSchema.parse({
			ok: false,
			sessionId: SESSION,
			instanceId: "mediad-7c9f",
			reason: "not_supported",
			error: "this leg negotiated no RFC 4733 payload type",
		});
		expect(parsed.reason).toBe("not_supported");
		// Defaulted rather than required, so a refusal need not echo a string it is rejecting.
		expect(parsed.digits).toBe("");
	});

	it("reports how long the far end will be receiving the digits", () => {
		const parsed = mediaSendDtmfResponseSchema.parse({
			ok: true,
			sessionId: SESSION,
			digits: "12",
			queuedMs: 340,
			telephoneEventPayloadType: 101,
		});
		expect(parsed.queuedMs).toBe(340);
	});
});

describe("rpc.media.v1.start-recording", () => {
	it("defaults to capturing both directions as a WAV", () => {
		const parsed = mediaStartRecordingRequestSchema.parse({
			sessionId: SESSION,
			recordingRef: "rec-1",
		});
		expect(parsed).toEqual({
			sessionId: SESSION,
			recordingRef: "rec-1",
			direction: "both",
			format: "wav",
		});
	});

	it("takes `receive` for the direction a voicemail needs", () => {
		const parsed = mediaStartRecordingRequestSchema.parse({
			sessionId: SESSION,
			recordingRef: "rec-1",
			direction: "receive",
			maxDurationMs: 120_000,
			maxSilenceMs: 5_000,
		});
		expect(parsed.direction).toBe("receive");
		expect(parsed.maxSilenceMs).toBe(5_000);
	});

	it("has no field for a path: the layout is derived, never dictated", () => {
		// A caller-supplied directory would let a malformed request write anywhere the process can,
		// and the engine has nothing to say about the layout mediad cannot derive from the session.
		const parsed = mediaStartRecordingRequestSchema.parse({
			sessionId: SESSION,
			recordingRef: "rec-1",
			// biome-ignore lint/suspicious/noExplicitAny: asserting an unknown key is stripped.
			path: "/etc/passwd",
		} as any);
		expect("path" in parsed).toBe(false);
	});

	it("answers with the object key the archive pipeline joins on", () => {
		const parsed = mediaStartRecordingResponseSchema.parse({
			ok: true,
			sessionId: SESSION,
			recordingRef: "rec-1",
			objectKey: `${ORG}/${CALL}/rec-1.wav`,
			instanceId: "mediad-7c9f",
		});
		expect(parsed.objectKey).toBe(`${ORG}/${CALL}/rec-1.wav`);
	});
});

describe("rpc.media.v1.stop-recording", () => {
	it("is keyed by the recording reference alone", () => {
		// `MediaPort.stopRecording(name)` carries nothing else, so neither does this.
		const parsed = mediaStopRecordingRequestSchema.parse({ recordingRef: "rec-1" });
		expect(parsed).toEqual({ recordingRef: "rec-1" });
		expect("sessionId" in parsed).toBe(false);
	});

	it("treats stopping a finished recording as a success", () => {
		const parsed = mediaStopRecordingResponseSchema.parse({ ok: true, recordingRef: "rec-1" });
		expect(parsed.stopped).toBe(false);
		expect(parsed.ok).toBe(true);
	});
});

describe("media.evt.v1 recording.finished", () => {
	it("derives its subject from the session, not the call", () => {
		const event = makeMediaEvent("recording.finished", {
			orgId: ORG,
			source: "mediad",
			data: {
				sessionId: SESSION,
				instanceId: "mediad-7c9f",
				callId: CALL,
				recordingRef: "rec-1",
				reason: "stopped",
				durationMs: 4_000,
				bytes: 64_044,
				objectKey: `${ORG}/${CALL}/rec-1.wav`,
				direction: "both",
			},
		});
		expect(event.subject).toBe(`media.evt.v1.${ORG}.${SESSION}.recording.finished`);
		expect(event.type).toBe("recording.finished");
	});

	it("distinguishes the four complete-file endings from the one that has no audio", () => {
		expect(MEDIA_RECORDING_END_REASONS).toEqual([
			"stopped",
			"max-duration",
			"max-silence",
			"session-ended",
			"error",
		]);
	});

	it("carries the byte count nothing else on this backbone can supply", () => {
		// `channel.record.stopped` has an optional `bytes` the engine has never been able to fill: it
		// does not hold the file. A 30 s recording that is 400 bytes long is a failure the duration
		// hides completely.
		const event = makeMediaEvent("recording.finished", {
			orgId: ORG,
			source: "mediad",
			data: {
				sessionId: SESSION,
				instanceId: "mediad-7c9f",
				recordingRef: "rec-1",
				reason: "max-silence",
				durationMs: 8_000,
				bytes: 128_044,
				objectKey: `${ORG}/${CALL}/rec-1.wav`,
				direction: "receive",
			},
		});
		expect(event.data.bytes).toBe(128_044);
	});
});

/**
 * Rung 3's RECEIVE half — the digit a party PRESSED, as opposed to the one `send-dtmf` originates.
 *
 * There is no command half to assert here, because detection is not something the engine asks for:
 * a session decodes what arrives on it, always, and the engine is told. What the contract has to
 * pin is the unit — ONE keypress, one character — because RFC 4733 puts a single digit on the wire
 * as an update every 20 ms plus three copies of the END packet, and a payload that let a batch or a
 * packet through would push the de-duplication into every consumer.
 */
describe("media.evt.v1 dtmf.received", () => {
	it("derives its subject from the session, like every event in the family", () => {
		const event = makeMediaEvent("dtmf.received", {
			orgId: ORG,
			source: "mediad",
			data: {
				sessionId: SESSION,
				instanceId: "mediad-7c9f",
				callId: CALL,
				legId: "leg-1",
				digit: "7",
				durationMs: 130,
			},
		});
		expect(event.subject).toBe(`media.evt.v1.${ORG}.${SESSION}.dtmf.received`);
		expect(event.type).toBe("dtmf.received");
		expect(event.data.digit).toBe("7");
	});

	it("accepts every key an RFC 4733 keypad can send, and only those", () => {
		for (const digit of ["0", "5", "9", "*", "#", "A", "B", "C", "D"]) {
			expect(
				mediaDtmfReceivedDataSchema.safeParse({
					sessionId: SESSION,
					instanceId: "mediad-7c9f",
					digit,
					durationMs: 100,
				}).success,
			).toBe(true);
		}
		// Lower case is refused rather than normalised: the value is compared against dialplan
		// digits, and two spellings of one key is a feature code that matches on some phones.
		for (const digit of ["a", "E", "!", ""]) {
			expect(
				mediaDtmfReceivedDataSchema.safeParse({
					sessionId: SESSION,
					instanceId: "mediad-7c9f",
					digit,
					durationMs: 100,
				}).success,
			).toBe(false);
		}
	});

	it("refuses more than one key in one event", () => {
		// One event is one PRESS. Letting "12" through would mean a media plane could batch, and a
		// `gather` counting presses would be short by one for the rest of the collection.
		expect(
			mediaDtmfReceivedDataSchema.safeParse({
				sessionId: SESSION,
				instanceId: "mediad-7c9f",
				digit: "12",
				durationMs: 100,
			}).success,
		).toBe(false);
	});

	it("requires the duration, because a consumer may threshold on it", () => {
		expect(
			mediaDtmfReceivedDataSchema.safeParse({
				sessionId: SESSION,
				instanceId: "mediad-7c9f",
				digit: "1",
			}).success,
		).toBe(false);
		expect(
			mediaDtmfReceivedDataSchema.safeParse({
				sessionId: SESSION,
				instanceId: "mediad-7c9f",
				digit: "1",
				durationMs: -1,
			}).success,
		).toBe(false);
	});
});
