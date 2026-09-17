import { describe, expect, it } from "bun:test";
import {
	canPauseRecording,
	canResumeRecording,
	IDLE_RECORDING,
	isRecordingControlVisible,
	recordingControlLabel,
	recordingReducer,
	observedRecording,
	recordingEventForObservation,
	recordingStatusLabel,
	type RecordedLeg,
	type RecordingEvent,
	type RecordingState,
} from "./recording";

/**
 * The recording control, driven the way an agent and a network drive it together.
 *
 * The assertions worth having are the ones that protect the PROMISE: the control says audio is not
 * being written, and an agent reads a card number on the strength of it. So the tests are about the
 * states it must never enter — paused before the engine said so, paused after a failure, paused on
 * a call whose recording has stopped — rather than about the happy path, which has one shape.
 */
const CALL = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";

function fold(
	events: readonly RecordingEvent[],
	from: RecordingState = IDLE_RECORDING,
): RecordingState {
	return events.reduce(recordingReducer, from);
}

function recording(): RecordingState {
	return fold([{ type: "RECORDING_STARTED", callId: CALL }]);
}

describe("the control's visibility", () => {
	it("is absent until the platform says the call is being recorded", () => {
		expect(isRecordingControlVisible(IDLE_RECORDING)).toBe(false);
		expect(isRecordingControlVisible(recording())).toBe(true);
	});

	it("disappears again when the recording stops", () => {
		const state = fold([{ type: "RECORDING_STOPPED" }], recording());
		expect(state).toEqual(IDLE_RECORDING);
		expect(isRecordingControlVisible(state)).toBe(false);
	});

	it("carries the call id the REST route names, and only while recording", () => {
		expect(recording().callId).toBe(CALL);
		expect(IDLE_RECORDING.callId).toBe(null);
	});
});

describe("pausing", () => {
	it("waits for the engine before it claims to be paused", () => {
		// The single most important assertion in this file: an optimistic `paused` would tell an agent
		// the card number is safe on a request that has not been answered.
		const pending = fold([{ type: "PAUSE_REQUESTED" }], recording());
		expect(pending.status).toBe("recording");
		expect(pending.pending).toBe(true);
		expect(recordingControlLabel(pending)).toBe("Pausing…");

		const paused = recordingReducer(pending, { type: "PAUSE_CONFIRMED" });
		expect(paused.status).toBe("paused");
		expect(paused.pending).toBe(false);
		expect(recordingStatusLabel(paused)).toBe("Recording paused");
	});

	it("refuses a second press while the first is in flight", () => {
		const pending = fold([{ type: "PAUSE_REQUESTED" }], recording());
		expect(canPauseRecording(pending)).toBe(false);
		expect(fold([{ type: "PAUSE_REQUESTED" }], pending)).toEqual(pending);
	});

	it("stays recording when the request fails, and says why", () => {
		const failed = fold(
			[{ type: "PAUSE_REQUESTED" }, { type: "RECORDING_CONTROL_FAILED", reason: "No engine" }],
			recording(),
		);
		expect(failed.status).toBe("recording");
		expect(failed.pending).toBe(false);
		expect(failed.error).toBe("No engine");
		expect(canPauseRecording(failed)).toBe(true);
	});

	it("ignores a confirmation for a request nothing made", () => {
		// A late reply for a call that has already moved on. Advancing on it would show "Paused" over
		// a recorder that is running.
		const state = recording();
		expect(recordingReducer(state, { type: "PAUSE_CONFIRMED" })).toEqual(state);
		expect(recordingReducer(IDLE_RECORDING, { type: "PAUSE_CONFIRMED" })).toEqual(IDLE_RECORDING);
	});

	it("cannot be resurrected by a confirmation that lands after the recording stopped", () => {
		const gone = fold(
			[{ type: "PAUSE_REQUESTED" }, { type: "RECORDING_STOPPED" }, { type: "PAUSE_CONFIRMED" }],
			recording(),
		);
		expect(gone).toEqual(IDLE_RECORDING);
	});
});

describe("resuming", () => {
	function paused(): RecordingState {
		return fold([{ type: "PAUSE_REQUESTED" }, { type: "PAUSE_CONFIRMED" }], recording());
	}

	it("is the only thing offered once paused", () => {
		expect(canPauseRecording(paused())).toBe(false);
		expect(canResumeRecording(paused())).toBe(true);
		expect(recordingControlLabel(paused())).toBe("Resume recording");
	});

	it("goes back to recording on the engine's word, not on the press", () => {
		const pending = fold([{ type: "RESUME_REQUESTED" }], paused());
		expect(pending.status).toBe("paused");
		expect(recordingControlLabel(pending)).toBe("Resuming…");
		expect(recordingReducer(pending, { type: "RESUME_CONFIRMED" }).status).toBe("recording");
	});

	it("stays paused when the resume fails, which is the safe direction", () => {
		const failed = fold(
			[{ type: "RESUME_REQUESTED" }, { type: "RECORDING_CONTROL_FAILED", reason: "409" }],
			paused(),
		);
		expect(failed.status).toBe("paused");
		expect(failed.error).toBe("409");
	});

	it("ignores a resume aimed at a recording that is running", () => {
		expect(fold([{ type: "RESUME_REQUESTED" }], recording()).pending).toBe(false);
	});
});

describe("starting over", () => {
	it("clears a stale error when a new recording begins", () => {
		const withError = fold(
			[{ type: "PAUSE_REQUESTED" }, { type: "RECORDING_CONTROL_FAILED", reason: "boom" }],
			recording(),
		);
		const fresh = recordingReducer(withError, { type: "RECORDING_STARTED", callId: "call-2" });
		expect(fresh).toEqual({ status: "recording", callId: "call-2", pending: false, error: null });
	});
});

// ---------------------------------------------------------------------------------------------
// The live feed's half
// ---------------------------------------------------------------------------------------------

const AGENT = "1001";
const OTHER_CALL = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";

function leg(overrides: Partial<RecordedLeg> = {}): RecordedLeg {
	return {
		callId: CALL,
		flags: ["answered", "recording"],
		profile: { callerIdNumber: AGENT, destinationNumber: "2065550100" },
		...overrides,
	};
}

describe("picking this agent's recorded call out of the live feed", () => {
	it("matches the leg the agent is on, whichever end of it they are", () => {
		expect(observedRecording([leg()], AGENT)).toEqual({ callId: CALL, paused: false });
		expect(
			observedRecording(
				[leg({ profile: { callerIdNumber: "2065550100", destinationNumber: AGENT } })],
				AGENT,
			),
		).toEqual({ callId: CALL, paused: false });
	});

	it("ignores every other leg in the organization", () => {
		// The feed is the whole tenant's. A softphone acting on a colleague's recorded call would be
		// pausing somebody else's compliance recording from a button that says nothing about them.
		const others = [
			leg({ callId: OTHER_CALL, profile: { callerIdNumber: "1002" } }),
			leg({ profile: { callerIdNumber: "1002", destinationNumber: "1003" } }),
		];
		expect(observedRecording(others, AGENT)).toBeUndefined();
	});

	it("ignores a leg nothing is recording", () => {
		expect(observedRecording([leg({ flags: ["answered"] })], AGENT)).toBeUndefined();
		expect(observedRecording([leg({ flags: undefined })], AGENT)).toBeUndefined();
	});

	it("reads the pause only behind the recording flag", () => {
		expect(observedRecording([leg({ flags: ["recording", "recording-paused"] })], AGENT)).toEqual({
			callId: CALL,
			paused: true,
		});
		// "Recording paused" for a call nothing is recording would tell an agent a card number is
		// safe from a recorder that is not running.
		expect(observedRecording([leg({ flags: ["recording-paused"] })], AGENT)).toBeUndefined();
	});

	it("matches nothing until the agent's own extension is known", () => {
		expect(observedRecording([leg()], null)).toBeUndefined();
		expect(observedRecording([leg()], "")).toBeUndefined();
	});
});

/**
 * The whole decision, from one frame of the topic to what the panel draws.
 *
 * The topic is `active-calls`, whose rows are the engine's own channel snapshots: it is the only
 * thing that carries `recording` / `recording-paused` to a browser, and it carries the agent's OWN
 * leg — the engine stamps both sides of the bridge, so the row the softphone matches on is the one
 * its own extension is on rather than the recorded party's. Its server-side gate is `cdr.read` OR
 * `calls.control` (`LIVE_TOPIC_ALTERNATE_PERMISSIONS` in `apps/api`); on `cdr.read` alone an agent
 * who may pause a recording was shown no control at all over a recorder they are allowed to stop.
 */
describe("the softphone's recording control, from one live-feed frame", () => {
	/** One frame of the topic: the agent's own leg and the colleague's, both flagged. */
	function frame(paused: boolean): RecordedLeg[] {
		const flags = paused
			? ["answered", "recording", "recording-paused"]
			: ["answered", "recording"];
		return [
			leg({ flags, profile: { callerIdNumber: "2065550100", destinationNumber: "1002" } }),
			leg({ flags }),
		];
	}

	function fromFeed(paused: boolean): RecordingState {
		const event = recordingEventForObservation(
			IDLE_RECORDING,
			observedRecording(frame(paused), AGENT),
		);
		return event === undefined ? IDLE_RECORDING : recordingReducer(IDLE_RECORDING, event);
	}

	it("shows the indicator and offers the pause for a recording nobody in this browser started", () => {
		const state = fromFeed(false);
		expect(state).toEqual({ status: "recording", callId: CALL, pending: false, error: null });
		expect(isRecordingControlVisible(state)).toBe(true);
		expect(recordingStatusLabel(state)).toBe("Recording");
		expect(canPauseRecording(state)).toBe(true);
	});

	it("says so when the recorder is already paused, whoever paused it", () => {
		const state = fromFeed(true);
		expect(recordingStatusLabel(state)).toBe("Recording paused");
		expect(canResumeRecording(state)).toBe(true);
		expect(canPauseRecording(state)).toBe(false);
	});

	it("draws nothing when the feed is empty, which is what no grant looks like", () => {
		// An agent whose token opens neither `cdr.read` nor `calls.control` gets no rows at all. The
		// control is HIDDEN rather than shown over a recorder whose state nothing can see.
		const event = recordingEventForObservation(IDLE_RECORDING, observedRecording([], AGENT));
		expect(event).toBeUndefined();
		expect(isRecordingControlVisible(IDLE_RECORDING)).toBe(false);
	});
});

describe("turning an observation into an event", () => {
	it("says nothing when the feed agrees with the control", () => {
		const recording = fold([{ type: "RECORDING_OBSERVED", callId: CALL, paused: false }]);
		expect(
			recordingEventForObservation(recording, { callId: CALL, paused: false }),
		).toBeUndefined();
		expect(recordingEventForObservation(IDLE_RECORDING, undefined)).toBeUndefined();
	});

	it("announces a recording the agent never started, and its pause", () => {
		// A supervisor pausing from a console, or the agent pausing from their desk phone. The
		// control has to follow the recorder, not only its own requests.
		expect(recordingEventForObservation(IDLE_RECORDING, { callId: CALL, paused: false })).toEqual({
			type: "RECORDING_OBSERVED",
			callId: CALL,
			paused: false,
		});
		const running = fold([{ type: "RECORDING_OBSERVED", callId: CALL, paused: false }]);
		expect(recordingEventForObservation(running, { callId: CALL, paused: true })).toEqual({
			type: "RECORDING_OBSERVED",
			callId: CALL,
			paused: true,
		});
	});

	it("takes the control away when the feed stops carrying the recording", () => {
		const running = fold([{ type: "RECORDING_OBSERVED", callId: CALL, paused: false }]);
		expect(recordingEventForObservation(running, undefined)).toEqual({ type: "RECORDING_STOPPED" });
	});

	it("leaves a request in flight alone, so a second press cannot slip through", () => {
		// The feed and the REST reply race. An observation landing mid-request would clear `pending`
		// and let a second press reach a recorder that has not answered the first.
		const pending = fold([
			{ type: "RECORDING_OBSERVED", callId: CALL, paused: false },
			{ type: "PAUSE_REQUESTED" },
		]);
		expect(pending.pending).toBe(true);
		expect(recordingEventForObservation(pending, { callId: CALL, paused: false })).toBeUndefined();
		expect(recordingEventForObservation(pending, { callId: CALL, paused: true })).toBeUndefined();
	});

	it("does follow the feed onto a DIFFERENT call even mid-request", () => {
		// The in-flight guard is about one recorder, not about the control: a request left pending on
		// a call that has ended must not stop the next call's recording from lighting the button.
		const pending = fold([
			{ type: "RECORDING_OBSERVED", callId: CALL, paused: false },
			{ type: "PAUSE_REQUESTED" },
		]);
		expect(recordingEventForObservation(pending, { callId: OTHER_CALL, paused: false })).toEqual({
			type: "RECORDING_OBSERVED",
			callId: OTHER_CALL,
			paused: false,
		});
	});

	it("clears a stale error when the server's own fact moves on", () => {
		const failed = fold([
			{ type: "RECORDING_OBSERVED", callId: CALL, paused: false },
			{ type: "PAUSE_REQUESTED" },
			{ type: "RECORDING_CONTROL_FAILED", reason: "the engine was unreachable" },
		]);
		expect(failed.error).not.toBeNull();
		expect(
			recordingReducer(failed, { type: "RECORDING_OBSERVED", callId: CALL, paused: true }),
		).toEqual({ status: "paused", callId: CALL, pending: false, error: null });
	});
});
