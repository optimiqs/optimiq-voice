import { describe, expect, it } from "bun:test";
import { makeMediaEvent, subjectFor } from "@optimiq-voice/events";
import { decodeMediadEvent, toMediaEventFromMediad } from "./mediad-event-mapping";
import type { MediaSessionEndReason } from "@optimiq-voice/events";

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
			// failure in the same CDR bucket as every unexplained hangup.
			["rtp-timeout", "NORMAL_TEMPORARY_FAILURE", 41],
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
	 * A deliberate MIRROR of the ARI path, not an omission. `toMediaEvent` drops Asterisk's
	 * `PlaybackFinished` because `MediaPort.play` returns as soon as audio has STARTED and nothing
	 * above the seam waits for a prompt to end. Raising a member here would make the two drivers
	 * disagree about a shape no consumer branches on — and would give the mediad driver a behaviour
	 * a confirmation IVR was never written against.
	 */
	it("drops playback.finished on every reason, exactly as the ARI path drops PlaybackFinished", () => {
		for (const reason of ["completed", "stopped", "error"] as const) {
			expect(toMediaEventFromMediad(playbackFinished(reason))).toBeUndefined();
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

	it("validates a playback.finished without raising a domain event", () => {
		// It still has to PARSE: the payload is written by a Go process, and a decoder that dropped
		// the type before validating would hide a drift the CI gate exists to catch.
		const envelope = playbackFinished("error");
		const decoded = decodeMediadEvent(envelope.subject, overTheWire(envelope));
		expect(decoded).toBeDefined();
		expect(decoded?.event).toBeUndefined();
		expect(decoded?.envelope.type).toBe("playback.finished");
		if (decoded?.envelope.type === "playback.finished") {
			expect(decoded.envelope.data.playbackRef).toBe("pb-1");
			expect(decoded.envelope.data.playedMs).toBe(1_240);
		}
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
