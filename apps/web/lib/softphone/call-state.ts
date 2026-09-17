/**
 * The softphone's state machine — pure, and the part worth testing.
 *
 * The SIP stack (jssip over a WebSocket) is integration and untestable without a socket; the
 * DECISIONS a softphone makes — is it registered, is there a call, is it held, is it muted, why did
 * it end — are a reducer over events, and that is unit work. `jssip-adapter.ts` translates jssip's
 * events into the {@link SoftphoneEvent} union below and dispatches them; nothing here imports
 * jssip.
 *
 * One call at a time, deliberately: a browser softphone is a single line, and a second INVITE while
 * one is up is refused at the adapter rather than modelled as a call-waiting stack this UI has no
 * controls for. The one exception is an ATTENDED TRANSFER's consultation, which is a second dialog
 * by definition — it lives in `transfer.ts`'s own machine and never becomes `call`.
 */

import { IDLE_TRANSFER, transferReducer, type TransferEvent, type TransferState } from "./transfer";

export type RegistrationState =
	| "unregistered"
	| "registering"
	| "registered"
	| "registration-failed";

/**
 * The lifecycle of the single call.
 *
 * `ringing` covers BOTH directions — an outgoing call we are placing (remote alerting) and an
 * incoming one alerting us — distinguished by `direction`. `active` is a confirmed dialog;
 * `ended` is a terminal state that carries why, and is cleared by `RESET_CALL` when the UI
 * dismisses it.
 */
export type CallStatus = "idle" | "ringing" | "active" | "ended";

export type CallDirection = "incoming" | "outgoing";

export interface CallPeer {
	/** The bare user or number, e.g. `1002` or `+15551234567`. */
	readonly identity: string;
	readonly displayName: string | null;
}

export interface CallState {
	readonly status: CallStatus;
	readonly direction: CallDirection | null;
	readonly peer: CallPeer | null;
	readonly muted: boolean;
	/** Held BY US. The button's own state. */
	readonly onHold: boolean;
	/**
	 * Held by the OTHER party — a re-INVITE that turned their media direction to `sendonly`/`inactive`.
	 *
	 * Separate from {@link onHold} because they are separate facts with separate remedies: our hold
	 * has a Resume button, theirs has nothing to press and only needs saying. Without this the held
	 * party's panel read `Connected` through a silence it could not explain.
	 */
	readonly remoteHold: boolean;
	/** Epoch ms when the dialog was confirmed, for a duration timer. `null` until `active`. */
	readonly connectedAt: number | null;
	/** Why the last call ended, for the ended card. `null` while a call is live. */
	readonly endedReason: string | null;
	/** The DTMF digits sent during this call, in order — what the keypad echoes back. */
	readonly dtmfSent: string;
}

export interface SoftphoneState {
	readonly registration: RegistrationState;
	/** The last registration/transport error, surfaced once and cleared on the next success. */
	readonly error: string | null;
	readonly call: CallState;
	readonly transfer: TransferState;
}

export const IDLE_CALL: CallState = {
	status: "idle",
	direction: null,
	peer: null,
	muted: false,
	onHold: false,
	remoteHold: false,
	connectedAt: null,
	endedReason: null,
	dtmfSent: "",
};

export const INITIAL_SOFTPHONE_STATE: SoftphoneState = {
	registration: "unregistered",
	error: null,
	call: IDLE_CALL,
	transfer: IDLE_TRANSFER,
};

export type SoftphoneEvent =
	| {
			readonly type: "REGISTRATION_CHANGED";
			readonly state: RegistrationState;
			readonly error?: string;
	  }
	| { readonly type: "INCOMING_CALL"; readonly peer: CallPeer }
	| { readonly type: "OUTGOING_CALL"; readonly peer: CallPeer }
	| { readonly type: "CALL_CONFIRMED"; readonly at: number }
	| { readonly type: "CALL_ENDED"; readonly reason: string }
	| { readonly type: "HOLD_CHANGED"; readonly onHold: boolean }
	| { readonly type: "REMOTE_HOLD_CHANGED"; readonly onHold: boolean }
	| { readonly type: "MUTE_CHANGED"; readonly muted: boolean }
	| { readonly type: "DTMF_SENT"; readonly tone: string }
	| { readonly type: "RESET_CALL" }
	| { readonly type: "CLEAR_ERROR" }
	| TransferEvent;

function startCall(direction: CallDirection, peer: CallPeer): CallState {
	return { ...IDLE_CALL, status: "ringing", direction, peer };
}

/**
 * The reducer. Total and pure: every event maps the current state to the next with no side effect,
 * so a test can drive a whole call by folding a list of events.
 *
 * The guards are the interesting part. A `CALL_CONFIRMED` or a hold/mute/DTMF event that arrives
 * with no live call is ignored rather than fabricating one — jssip can emit a late `ended` after a
 * failure, and a UI that resurrected a call from a stray event would show a phantom line.
 */
export function softphoneReducer(state: SoftphoneState, event: SoftphoneEvent): SoftphoneState {
	switch (event.type) {
		case "REGISTRATION_CHANGED":
			return {
				...state,
				registration: event.state,
				error:
					event.state === "registration-failed"
						? (event.error ?? "Registration failed")
						: event.state === "registered"
							? null
							: state.error,
			};

		case "INCOMING_CALL":
			// A second call while one is live is not modelled — the adapter refuses it. If one slips
			// through, keep the established call rather than replacing it.
			if (state.call.status === "active" || state.call.status === "ringing") {
				return state;
			}
			return { ...state, call: startCall("incoming", event.peer) };

		case "OUTGOING_CALL":
			if (state.call.status === "active" || state.call.status === "ringing") {
				return state;
			}
			return { ...state, call: startCall("outgoing", event.peer) };

		case "CALL_CONFIRMED":
			if (state.call.status !== "ringing") {
				return state;
			}
			return { ...state, call: { ...state.call, status: "active", connectedAt: event.at } };

		case "CALL_ENDED":
			if (state.call.status === "idle") {
				return state;
			}
			return {
				...state,
				// A transfer that was still in flight goes with the call, EXCEPT a failed one: the reason
				// it failed is the only thing that explains the call the user is still holding.
				transfer: state.transfer.status === "failed" ? state.transfer : IDLE_TRANSFER,
				call: {
					...state.call,
					status: "ended",
					onHold: false,
					remoteHold: false,
					muted: false,
					endedReason: event.reason,
				},
			};

		case "HOLD_CHANGED":
			if (state.call.status !== "active") {
				return state;
			}
			return { ...state, call: { ...state.call, onHold: event.onHold } };

		case "REMOTE_HOLD_CHANGED":
			if (state.call.status !== "active") {
				return state;
			}
			return { ...state, call: { ...state.call, remoteHold: event.onHold } };

		case "MUTE_CHANGED":
			if (state.call.status !== "active") {
				return state;
			}
			return { ...state, call: { ...state.call, muted: event.muted } };

		case "DTMF_SENT":
			if (state.call.status !== "active") {
				return state;
			}
			return { ...state, call: { ...state.call, dtmfSent: state.call.dtmfSent + event.tone } };

		case "RESET_CALL":
			// Only a terminal call is dismissable; dismissing a live one would strand the SIP session.
			if (state.call.status !== "ended") {
				return state;
			}
			return { ...state, call: IDLE_CALL };

		case "CLEAR_ERROR":
			return { ...state, error: null };

		case "TRANSFER_REQUESTED":
		case "CONSULT_CONFIRMED":
		case "TRANSFER_COMPLETING":
		case "TRANSFER_FAILED":
		case "TRANSFER_CANCELLED": {
			// A transfer only exists on an established call; the machine itself does not know that.
			if (state.call.status !== "active" && event.type === "TRANSFER_REQUESTED") {
				return state;
			}
			const transfer = transferReducer(state.transfer, event);
			return transfer === state.transfer ? state : { ...state, transfer };
		}

		default: {
			// Exhaustiveness: a new event type that is not handled fails the type-check here.
			const _never: never = event;
			return state;
		}
	}
}

/** Whether the UA is ready to place or take a call. */
export function canPlaceCall(state: SoftphoneState): boolean {
	return state.registration === "registered" && state.call.status === "idle";
}

/** Whether the current call offers in-call controls (hold / mute / DTMF). */
export function hasActiveCall(state: SoftphoneState): boolean {
	return state.call.status === "active";
}
