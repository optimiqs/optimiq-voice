import { describe, expect, it } from "bun:test";
import { makeMediaEvent, subjectFor } from "@optimiq-voice/events";
import { decodeMediadEvent, toMediaEventFromMediad } from "./mediad-event-mapping";
import type { MediaRecordingEndReason, MediaSessionEndReason } from "@optimiq-voice/events";

const ORG = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293";
const CALL = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b4c";
const SESSION = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b53";

function ended(reason: MediaSessionEndReason) {
	return makeMediaEvent("session.ended", {
		orgId: ORG,
		source: "mediad",
		data: {
			sessionId: SESSION,
			instanceId: "mediad-1",
			callId: CALL,
			legId: "leg-1",
			rtpPort: 30_002,
			packetsReceived: 1_500,
			packetsSent: 1_490,
			reason,
			durationMs: 42_000,
		},
	});
}

function timedOut() {
	return makeMediaEvent("session.rtp-timeout", {
		orgId: ORG,
		source: "mediad",
		data: {
			sessionId: SESSION,
			instanceId: "mediad-1",
			callId: CALL,
			rtpPort: 30_002,
			packetsReceived: 640,
			packetsSent: 640,
			silentForMs: 30_000,
			remoteAddress: "203.0.113.9:41000",
		},
	});
}

function playbackFinished(reason: "completed" | "stopped" | "error" = "stopped") {
	return makeMediaEvent("playback.finished", {
		orgId: ORG,
		source: "mediad",
		data: {
			sessionId: SESSION,
			instanceId: "mediad-1",
			callId: CALL,
			playbackRef: "pb-1",
			reason,
			playedMs: 1_240,
		},
	});
}

function recordingFinished(reason: MediaRecordingEndReason = "stopped", detail?: string) {
	return makeMediaEvent("recording.finished", {
		orgId: ORG,
		source: "mediad",
		data: {
			sessionId: SESSION,
			instanceId: "mediad-1",
			callId: CALL,
			recordingRef: "rec-1",
			reason,
			durationMs: 4_000,
			bytes: 64_044,
			objectKey: `${ORG}/${CALL}/rec-1.wav`,
			direction: "both" as const,
			...(detail === undefined ? {} : { detail }),
		},
	});
}

function dtmfReceived(digit = "7", durationMs = 130) {
	return makeMediaEvent("dtmf.received", {
		orgId: ORG,
		source: "mediad",
		data: {
			sessionId: SESSION,
			instanceId: "mediad-1",
			callId: CALL,
			legId: "leg-1",
			digit,
			durationMs,
		},
	});
}

/** A consumer receives JSON, not the object the builder returned. */
function overTheWire(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value)) as unknown;
}

describe("toMediaEventFromMediad", () => {
	it("turns session.ended into the leg-ended the CDR is written from", () => {
		const event = toMediaEventFromMediad(ended("released"));
		expect(event).toEqual({
			type: "leg-ended",
			// The engine's leg id and mediad's session id are the same string: both are
			// engine-assigned, so there is no mapping table to lose on a restart.
			channelId: SESSION,
			cause: "NORMAL_CLEARING",
			causeCode: 16,
		});
	});

	/**
	 * A media plane has no Q.850 opinion — it never saw a SIP response — so the mapping picks the
	 * closest code it can DEFEND. Each of these is a claim, not a convenience.
	 */
	it("maps every end reason to a cause it can justify", () => {
		const cases: readonly [MediaSessionEndReason, string, number][] = [
			// The engine asked, so the call ended the way calls end.
			["released", "NORMAL_CLEARING", 16],
			// The network stopped carrying audio. NOT 31 NORMAL_UNSPECIFIED, which would bury a media
			// failure in the same CDR bucket as every unexplained hangup — and not the general 41
			// NORMAL_TEMPORARY_FAILURE either: the taxonomy has a cause that means exactly this, and
			// the Asterisk-side watchdog raises it, so the two drivers must agree on the name.
			["rtp-timeout", "MEDIA_TIMEOUT", 804],
			// Literally what happened: a timer the engine should have beaten expired.
			["idle-reaped", "RECOVERY_ON_TIMER_EXPIRE", 102],
			// The channel this call was using went away underneath it.
			["drained", "REQUESTED_CHAN_UNAVAIL", 44],
			["error", "NORMAL_TEMPORARY_FAILURE", 41],
		];

		for (const [reason, cause, code] of cases) {
			const event = toMediaEventFromMediad(ended(reason));
			expect(event).toMatchObject({ type: "leg-ended", cause, causeCode: code });
		}
	});

	/**
	 * The timeout is the DIAGNOSIS that precedes the fact. Emitting both would tear the leg down
	 * twice — once on the warning and once on the ending it warned about.
	 */
	it("drops session.rtp-timeout, because the ended event that follows carries the reason", () => {
		expect(toMediaEventFromMediad(timedOut())).toBeUndefined();
	});

	/**
	 * The one number no layer above the packet path can compute.
	 *
	 * This mapping used to answer `undefined`, and the argument was sound for as long as nothing
	 * above the seam waited for a prompt to end. `CallControl.announceConsent` does: it writes a
	 * compliance record naming the parties the recording-disclosure prompt reached, and it used to
	 * stamp that record when `MediaPort.play` RESOLVED. `play` resolves on acceptance, so a WebRTC
	 * party still finishing ICE and DTLS was written down as announced to while this very event was
	 * reporting `playedMs 0` on the same prompt. The fact was on the wire; the engine dropped it.
	 */
	it("turns playback.finished into the playback-finished the consent gate waits for", () => {
		expect(toMediaEventFromMediad(playbackFinished("completed"))).toEqual({
			type: "playback-finished",
			// The session id IS the engine's channel id under this driver.
			channelId: SESSION,
			// Echoed back verbatim from the `start-playback` the engine sent, so a waiter can key on
			// the reference it assigned rather than on the leg — two prompts on one leg must not see
			// each other's completion.
			playbackRef: "pb-1",
			playedMs: 1_240,
			reason: "completed",
		});
	});

	/**
	 * `playedMs 0` is the live failure, and it must survive the mapping as a NUMBER.
	 *
	 * `mediad` accepted the prompt, decoded it, scheduled 52 frames and wrote every one of them into
	 * a transport with no peer. Nothing else about the call is wrong. If this mapped to an absent
	 * `playedMs` the consumer could not tell it from a driver that does not measure delivery at all,
	 * and would credit the party with an announcement it demonstrably did not receive.
	 */
	it("carries a playedMs of 0 through as 0, with the media plane's own reason and detail", () => {
		const envelope = makeMediaEvent("playback.finished", {
			orgId: ORG,
			source: "mediad",
			data: {
				sessionId: SESSION,
				instanceId: "mediad-1",
				callId: CALL,
				playbackRef: "pb-1",
				reason: "error",
				playedMs: 0,
				detail: "rtp: sending a playback frame to 127.0.0.1:9: WebRTC media is not connected",
			},
		});
		expect(toMediaEventFromMediad(envelope)).toEqual({
			type: "playback-finished",
			channelId: SESSION,
			playbackRef: "pb-1",
			playedMs: 0,
			reason: "error",
			detail: "rtp: sending a playback frame to 127.0.0.1:9: WebRTC media is not connected",
		});
	});

	/** No detail is a missing KEY, not an explicit `undefined` — the shape every member here keeps. */
	it("omits detail entirely when the media plane volunteered none", () => {
		expect(toMediaEventFromMediad(playbackFinished("stopped"))).not.toHaveProperty("detail");
	});

	/**
	 * The one media event the layer above genuinely waits for. `plan-walker`'s voicemail node and
	 * `call-control`'s on-demand recording both block until a recording has finished before they
	 * publish `channel.record.stopped`, which is what triggers the archive in `apps/api` — so
	 * dropping this one would hang a voicemail until its own timeout and file no message at all.
	 */
	it("turns recording.finished into the recording-finished the callers block on", () => {
		expect(toMediaEventFromMediad(recordingFinished())).toEqual({
			type: "recording-finished",
			// Named, not id'd: ARI has no recording id and the seam inherited that, so `record(name)`,
			// `stopRecording(name)` and every waiter key on the same string.
			recordingName: "rec-1",
			durationMs: 4_000,
			bytes: 64_044,
		});
	});

	it("carries the PCI pause intervals through, since nothing above the seam can produce them", () => {
		const event = makeMediaEvent("recording.finished", {
			orgId: ORG,
			source: "mediad",
			data: {
				sessionId: SESSION,
				instanceId: "mediad-1",
				callId: CALL,
				recordingRef: "rec-1",
				reason: "stopped" as const,
				durationMs: 30_000,
				bytes: 480_044,
				objectKey: `${ORG}/${CALL}/rec-1.wav`,
				direction: "both" as const,
				pauses: [{ startMs: 8_000, endMs: 14_000 }],
			},
		});

		expect(toMediaEventFromMediad(event)).toMatchObject({
			type: "recording-finished",
			pauses: [{ startMs: 8_000, endMs: 14_000 }],
		});
	});

	it("leaves the pauses off a recording nobody paused", () => {
		expect(toMediaEventFromMediad(recordingFinished())).not.toHaveProperty("pauses");
	});

	it("treats every complete-file ending as finished, however the recording stopped", () => {
		// A voicemail that ran out of silence is the NORMAL end of a voicemail, and a caller who hung
		// up mid-message still left a playable message. Reporting either as a failure would throw
		// away a file that exists and is good.
		for (const reason of ["stopped", "max-duration", "max-silence", "session-ended"] as const) {
			expect(toMediaEventFromMediad(recordingFinished(reason))).toMatchObject({
				type: "recording-finished",
			});
		}
	});

	/**
	 * Split from the above rather than folded in, mirroring ARI's own `RecordingFinished` /
	 * `RecordingFailed` split — and the callers branch on it: a failure means there is NO file, so no
	 * voicemail message is filed and no recording key lands on the CDR. Folding them together would
	 * make a caller treat a missing file as a zero-length one.
	 */
	it("turns a failed recording into recording-failed, carrying what the media plane could say", () => {
		expect(toMediaEventFromMediad(recordingFinished("error", "no space left on device"))).toEqual({
			type: "recording-failed",
			recordingName: "rec-1",
			reason: "no space left on device",
		});
	});

	/**
	 * The whole point of rung 3's receive half: this produces the SAME union member, with the same
	 * three fields, that `calls/ari-mapping.ts` produces from `ChannelDtmfReceived`. The
	 * confirmation IVR, the feature-code collector and voicemail's digit terminator all read the
	 * orchestrator's `DtmfInbox`, and none of them can tell which media plane filled it.
	 */
	it("turns dtmf.received into the same dtmf-received member the ARI path produces", () => {
		expect(toMediaEventFromMediad(dtmfReceived())).toEqual({
			type: "dtmf-received",
			// mediad's session id IS the engine's channel id under this driver: both are the same
			// engine-assigned string, so there is no mapping table to lose on a restart.
			channelId: SESSION,
			digit: "7",
			durationMs: 130,
		});
	});

	it("carries every key an RFC 4733 keypad can send, as a character", () => {
		// A character rather than an event code, because that is what a dialplan compares against —
		// `gather`'s match set and the feature-code table are both strings.
		for (const digit of ["0", "9", "*", "#", "A", "D"]) {
			expect(toMediaEventFromMediad(dtmfReceived(digit))).toMatchObject({
				type: "dtmf-received",
				digit,
			});
		}
	});

	it("never leaves a failed recording without a reason", () => {
		// A caller logs this and files no message; an empty string would be a voicemail that vanished
		// with nothing attached to explain it.
		const event = toMediaEventFromMediad(recordingFinished("error"));
		expect(event).toMatchObject({ type: "recording-failed" });
		if (event?.type === "recording-failed") {
			expect(event.reason.length).toBeGreaterThan(0);
		}
	});
});

describe("decodeMediadEvent", () => {
	it("validates and translates a delivered message", () => {
		const envelope = ended("released");
		const decoded = decodeMediadEvent(envelope.subject, overTheWire(envelope));
		expect(decoded?.event).toMatchObject({ type: "leg-ended", channelId: SESSION });
		expect(decoded?.envelope.data.instanceId).toBe("mediad-1");
	});

	it("returns the envelope even when there is no domain event to raise", () => {
		const envelope = timedOut();
		const decoded = decodeMediadEvent(envelope.subject, overTheWire(envelope));
		expect(decoded).toBeDefined();
		expect(decoded?.event).toBeUndefined();
		expect(decoded?.envelope.type).toBe("session.rtp-timeout");
	});

	it("decodes a playback.finished and raises the domain event", () => {
		// It still has to PARSE: the payload is written by a Go process, and a decoder that trusted
		// the type before validating would hide a drift the CI gate exists to catch.
		const envelope = playbackFinished("error");
		const decoded = decodeMediadEvent(envelope.subject, overTheWire(envelope));
		expect(decoded).toBeDefined();
		expect(decoded?.envelope.type).toBe("playback.finished");
		expect(decoded?.event).toMatchObject({ type: "playback-finished", playedMs: 1_240 });
		if (decoded?.envelope.type === "playback.finished") {
			expect(decoded.envelope.data.playbackRef).toBe("pb-1");
			expect(decoded.envelope.data.playedMs).toBe(1_240);
		}
	});

	it("carries the object key and byte count through on the envelope", () => {
		// Neither is on the domain union, because nothing above the seam branches on them — but the
		// envelope is what a consumer asking "where is that file, and is it plausible" reads, and the
		// byte count is a number nothing else on this backbone can supply.
		const envelope = recordingFinished();
		const decoded = decodeMediadEvent(envelope.subject, overTheWire(envelope));
		expect(decoded?.envelope.type).toBe("recording.finished");
		if (decoded?.envelope.type === "recording.finished") {
			expect(decoded.envelope.data.objectKey).toBe(`${ORG}/${CALL}/rec-1.wav`);
			expect(decoded.envelope.data.bytes).toBe(64_044);
			expect(decoded.envelope.data.direction).toBe("both");
		}
	});

	it("validates and translates a keypress off the wire", () => {
		const envelope = dtmfReceived("*", 90);
		const decoded = decodeMediadEvent(envelope.subject, overTheWire(envelope));
		expect(decoded?.event).toEqual({
			type: "dtmf-received",
			channelId: SESSION,
			digit: "*",
			durationMs: 90,
		});
	});

	it("refuses a keypress that is not one key", () => {
		// One event is one PRESS. A payload carrying "12" would mean the media plane had batched two
		// keys into one event, and a `gather` counting presses would be short by one for the rest of
		// the collection.
		const subject = subjectFor.media(ORG, SESSION, "dtmf.received");
		const envelope = overTheWire(dtmfReceived()) as { data: Record<string, unknown> };
		envelope.data.digit = "12";
		expect(decodeMediadEvent(subject, envelope)).toBeUndefined();
		envelope.data.digit = "E";
		expect(decodeMediadEvent(subject, envelope)).toBeUndefined();
	});

	/**
	 * The publisher is a Go process, so a drifted payload is a real possibility rather than a
	 * theoretical one — and an orchestrator handed a half-parsed event would tear down a leg on the
	 * strength of a field that is not there.
	 */
	it("refuses a payload that does not satisfy the contract", () => {
		const subject = subjectFor.media(ORG, SESSION, "session.ended");
		expect(decodeMediadEvent(subject, { type: "session.ended" })).toBeUndefined();
		expect(decodeMediadEvent(subject, "not an object")).toBeUndefined();
	});

	/**
	 * A leg torn down because SOMEBODY ELSE's session ended is the worst possible outcome of a
	 * mismatch nobody checked, which is why the subject's token and the payload's id are compared.
	 */
	it("refuses an event whose subject names a different session", () => {
		const envelope = ended("released");
		const otherSubject = subjectFor.media(
			ORG,
			"0192c7a1-0000-7000-8000-000000000001",
			"session.ended",
		);
		expect(decodeMediadEvent(otherSubject, overTheWire(envelope))).toBeUndefined();
	});

	it("ignores a subject from another family", () => {
		const callSubject = subjectFor.call(ORG, CALL, "channel.answered");
		expect(decodeMediadEvent(callSubject, overTheWire(ended("released")))).toBeUndefined();
		expect(decodeMediadEvent("nonsense", {})).toBeUndefined();
	});
});
