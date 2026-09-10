/**
 * The recording pause/resume control — pure, and the part worth testing.
 *
 * ## What it is for
 *
 * PCI-DSS says a card number must not land in a recording, and the answer is not to stop and
 * restart the recorder: that produces two objects, two rows and two timelines. `apps/mediad` pauses
 * in place — one file, silence for the gap, and the intervals filed on the finished recording — and
 * `POST /api/v1/calls/:id/recording/{pause,resume}` is the surface an agent presses. This module is
 * the button's state, kept out of the component so the guards are unit work: it is the only part
 * that decides whether a card number is safe to read aloud.
 *
 * ## Optimism is deliberately absent
 *
 * `PAUSE_REQUESTED` moves to `pending` and NOT to `paused`. The whole value of the control is the
 * promise that audio is not being written, and a button that showed "Paused" before the engine
 * acknowledged would be making that promise on a request that may still fail — with an agent
 * reading digits into it. So the paused state is only ever entered by a confirmation, and a failure
 * returns to `recording` with the reason to show.
 *
 * ## Where the status comes from
 *
 * The SERVER, and only the server: jssip knows about a SIP dialog and nothing about what the
 * platform is writing to disk. The engine flags a recorded leg on its channel snapshot
 * (`packages/telephony`'s `recording` / `recording-paused`), the snapshot is mirrored into the
 * `channels` bucket on every change, and the `active-calls` live topic carries it to this browser.
 * {@link observedRecording} picks this agent's own leg out of that feed and
 * {@link recordingEventForObservation} turns it into the one event that needs dispatching.
 *
 * That observation is also the only thing that can enter `paused` WITHOUT a local confirmation, and
 * it must be: an agent who paused from their desk phone, or a supervisor who paused from a console,
 * changed the recorder, and a control that only believed its own requests would show "Recording"
 * over a recorder that is silent.
 */

/**
 * What the recorder is doing on this call.
 *
 * `off` covers both "this call is not recorded" and "we have not been told", and the two are the
 * same thing to a button: it is not shown. There is no separate `unknown` because a control that
 * rendered a disabled placeholder for a call that is simply not recorded would be telling every
 * agent on every call that a feature is broken.
 */
export type RecordingStatus = "off" | "recording" | "paused";

export interface RecordingState {
	readonly status: RecordingStatus;
	/** The call the REST route names. `null` exactly when `status` is `off`. */
	readonly callId: string | null;
	/** A pause or a resume is in flight. The window in which a second press must be refused. */
	readonly pending: boolean;
	/** Why the last attempt failed, for the control to show. `null` unless one did. */
	readonly error: string | null;
}

export const IDLE_RECORDING: RecordingState = {
	status: "off",
	callId: null,
	pending: false,
	error: null,
};

export type RecordingEvent =
	/** The platform started recording this call. Carries the id every later request needs. */
	| { readonly type: "RECORDING_STARTED"; readonly callId: string }
	/** The recording ended, or the call did. Terminal — the control disappears. */
	| { readonly type: "RECORDING_STOPPED" }
	| { readonly type: "PAUSE_REQUESTED" }
	| { readonly type: "RESUME_REQUESTED" }
	| { readonly type: "PAUSE_CONFIRMED" }
	| { readonly type: "RESUME_CONFIRMED" }
	/** The API refused or could not be reached. The recorder is in the state it already was. */
	| { readonly type: "RECORDING_CONTROL_FAILED"; readonly reason: string }
	/**
	 * What the platform says the recorder is doing right now, off the live channel feed.
	 *
	 * Distinct from `RECORDING_STARTED` because it carries the pause too, and because it is a
	 * REPORT rather than a transition: it is dispatched only when it disagrees with what the control
	 * already shows (see {@link recordingEventForObservation}), so a feed that republishes an
	 * unchanged row does not churn the reducer.
	 */
	| { readonly type: "RECORDING_OBSERVED"; readonly callId: string; readonly paused: boolean };

/**
 * The reducer.
 *
 * Every guard here exists because the button is pressed by a person and answered by a network: a
 * confirmation for a request the call already outlived, a second press while the first is in
 * flight, a resume for a recording that stopped. Advancing on any of them would put the control in
 * a state the recorder is not in — and on this control that is not a cosmetic bug.
 */
export function recordingReducer(state: RecordingState, event: RecordingEvent): RecordingState {
	switch (event.type) {
		case "RECORDING_STARTED":
			return { status: "recording", callId: event.callId, pending: false, error: null };
		case "RECORDING_STOPPED":
			return IDLE_RECORDING;
		case "PAUSE_REQUESTED":
			return canPauseRecording(state) ? { ...state, pending: true, error: null } : state;
		case "RESUME_REQUESTED":
			return canResumeRecording(state) ? { ...state, pending: true, error: null } : state;
		case "PAUSE_CONFIRMED":
			// Only from a pause we asked for. A confirmation that arrived after the recording stopped
			// must not resurrect the control.
			return state.pending && state.status === "recording"
				? { ...state, status: "paused", pending: false, error: null }
				: state;
		case "RESUME_CONFIRMED":
			return state.pending && state.status === "paused"
				? { ...state, status: "recording", pending: false, error: null }
				: state;
		case "RECORDING_OBSERVED":
			// The server's own fact wins, including over a stale error: the reason a previous attempt
			// failed is not worth showing beside a status that has since moved.
			return {
				status: event.paused ? "paused" : "recording",
				callId: event.callId,
				pending: false,
				error: null,
			};
		case "RECORDING_CONTROL_FAILED":
			// The status is UNCHANGED on purpose: the API's contract is that a refused or unreachable
			// request changed nothing, so the safe reading is the state we were already in.
			return state.pending ? { ...state, pending: false, error: event.reason } : state;
		default:
			return state;
	}
}

/** Whether the control should be on screen at all. */
export function isRecordingControlVisible(state: RecordingState): boolean {
	return state.status !== "off";
}

export function canPauseRecording(state: RecordingState): boolean {
	return state.status === "recording" && !state.pending && state.callId !== null;
}

export function canResumeRecording(state: RecordingState): boolean {
	return state.status === "paused" && !state.pending && state.callId !== null;
}

/**
 * What the button says.
 *
 * The pending labels name the DESTINATION rather than the action ("Pausing…"), because the press
 * has already happened and the only useful thing left to say is what is being waited for.
 */
export function recordingControlLabel(state: RecordingState): string {
	if (state.pending) {
		return state.status === "recording" ? "Pausing…" : "Resuming…";
	}
	return state.status === "paused" ? "Resume recording" : "Pause recording";
}

/**
 * What the panel says about the recorder, beside the button.
 *
 * "Recording" and not "This call is being recorded": the notice that the call is recorded is the
 * tenant's announcement at the top of the call, which is a legal artefact and not a label in a
 * panel. This one is a status for the person holding the phone.
 */
export function recordingStatusLabel(state: RecordingState): string {
	return state.status === "paused" ? "Recording paused" : "Recording";
}

// ---------------------------------------------------------------------------------------------
// The live feed's half — pure, and the part worth testing
// ---------------------------------------------------------------------------------------------

/** What the platform says about the recorder on this agent's call. `undefined` means nothing is. */
export interface RecordingObservation {
	readonly callId: string;
	readonly paused: boolean;
}

/**
 * One leg of the live channel feed, narrowed to what this decision reads.
 *
 * Structural rather than an import of `lib/live/store`'s `LiveChannel`, so this module stays pure
 * and testable with three object literals — the rule every other file in `lib/softphone` follows.
 */
export interface RecordedLeg {
	readonly callId: string;
	readonly flags?: readonly string[];
	readonly profile?: {
		readonly callerIdNumber?: string;
		readonly destinationNumber?: string;
	};
}

/** Mirrors `LIVE_CHANNEL_RECORDING_FLAGS` in `packages/events`. */
const RECORDING_FLAG = "recording";
const RECORDING_PAUSED_FLAG = "recording-paused";

/**
 * This agent's own recorded call, out of the whole organization's live feed.
 *
 * ## Why the extension is the key
 *
 * The feed carries every live leg in the tenant and the browser must act on exactly one of them.
 * The softphone knows two things about its call that the feed also knows: the agent's own extension
 * number, which the engine resolves onto the leg as either the caller id (a call the agent placed)
 * or the destination (a call that rang them), and nothing else. A leg matching that, on a call
 * something is recording, is this agent's — and if a second one somehow matched, both are the same
 * agent's calls and the first in the feed's own order is taken rather than a coin flipped.
 *
 * ## The paused flag is only read behind the active one
 *
 * The reader's half of the rule the engine writes under, and the same one `recordingStateOf` states
 * in `packages/events`: "Recording paused" for a call nothing is recording tells an agent a card
 * number is safe from a recorder that is not running.
 *
 * @param legs every live leg the `active-calls` topic is carrying
 * @param extension the agent's own extension number, or `null` before it is known
 */
export function observedRecording(
	legs: Iterable<RecordedLeg>,
	extension: string | null,
): RecordingObservation | undefined {
	if (extension === null || extension === "") {
		return undefined;
	}
	for (const leg of legs) {
		if (leg.flags?.includes(RECORDING_FLAG) !== true) {
			continue;
		}
		if (leg.profile?.callerIdNumber !== extension && leg.profile?.destinationNumber !== extension) {
			continue;
		}
		return { callId: leg.callId, paused: leg.flags.includes(RECORDING_PAUSED_FLAG) };
	}
	return undefined;
}

/**
 * The event to dispatch for what the feed now says, or `undefined` when nothing needs saying.
 *
 * ## The two guards, and what each one is for
 *
 * A request IN FLIGHT on the same call is left alone. The feed and the REST reply race — the engine
 * mirrors the snapshot and answers the request in either order — and a `RECORDING_OBSERVED` landing
 * mid-request would clear `pending` and let a second press through onto a recorder that has not
 * answered the first.
 *
 * And an observation that AGREES with what is shown produces nothing, so a bucket republishing an
 * unchanged row does not re-render the control on every frame.
 */
export function recordingEventForObservation(
	state: RecordingState,
	observation: RecordingObservation | undefined,
): RecordingEvent | undefined {
	if (observation === undefined) {
		return state.status === "off" ? undefined : { type: "RECORDING_STOPPED" };
	}
	if (state.pending && state.callId === observation.callId) {
		return undefined;
	}
	const unchanged =
		state.callId === observation.callId &&
		state.status === (observation.paused ? "paused" : "recording");
	return unchanged
		? undefined
		: { type: "RECORDING_OBSERVED", callId: observation.callId, paused: observation.paused };
}
