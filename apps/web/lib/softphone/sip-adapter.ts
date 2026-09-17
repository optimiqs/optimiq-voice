/**
 * The seam between the app and whichever SIP library drives the socket.
 *
 * The UI, the reducer and the context talk to this interface and never to jssip directly. That is
 * what keeps the library swappable (jssip today; sip.js is the same surface) and, more importantly,
 * what keeps the tested part of the softphone — the state machine — free of a WebSocket. The
 * adapter's job is narrow: open a registration, place/answer/end ONE call, and translate the
 * library's events into {@link SoftphoneEvent}s the reducer already understands.
 */

import type { SoftphoneEvent } from "./call-state";
import type { ResolvedSoftphoneCredentials } from "./contracts";

/** Audio output selected by the application. */
export interface SipMediaSinks {
	readonly remoteAudio?: HTMLAudioElement | null;
}

export interface SipUserAgent {
	/** Open the WebSocket and REGISTER. Emits `REGISTRATION_CHANGED` as it progresses. */
	start(): void;
	/**
	 * Un-REGISTER (`Expires: 0`) and close the socket. Idempotent.
	 *
	 * This is what "Go offline" and the `pagehide` handler call. It matters that it is deliberate and
	 * reachable: a WS binding is only usable over the socket that made it, so a tab that goes away
	 * without this leaves a contact every later call to the extension forks to and gets `connection
	 * refused` from — wasted originates and phantom CDR legs, until the registration lapses.
	 */
	stop(): void;
	/** Place a call to `target` (a bare extension/number or a full SIP URI). */
	call(target: string): void;
	/** Answer the ringing incoming call, if any. */
	answer(): void;
	/** Hang up / decline the current call, if any. */
	hangup(): void;
	/** Put the active call on hold / take it off. */
	setHold(onHold: boolean): void;
	/** Mute / unmute the local microphone on the active call. */
	setMuted(muted: boolean): void;
	/** Send a DTMF tone on the active call. */
	sendDtmf(tone: string): void;
	/**
	 * Blind transfer: `REFER` the established call to `target` and let go of it.
	 *
	 * The transferor never learns whether the transferee answered — SIP's `NOTIFY` reports the REFER,
	 * not the resulting call — so this ends with the call ending, and the UI must not promise more.
	 */
	transferBlind(target: string): void;
	/**
	 * Attended transfer, step one: hold the current call and place a CONSULTATION call to `target`.
	 *
	 * The consultation is a second dialog. It is deliberately not modelled as the softphone's one
	 * `call` — the first party is still there, on hold, and must come back if the user cancels.
	 */
	startConsult(target: string): void;
	/** Attended transfer, step two: `REFER` the first call to the consultation with `Replaces`. */
	completeTransfer(): void;
	/** Abandon the consultation: hang it up and take the first call off hold. */
	cancelTransfer(): void;
}

export interface SipUserAgentOptions {
	readonly credentials: ResolvedSoftphoneCredentials;
	/** Refresh short-lived relay credentials before establishing each media connection. */
	readonly refreshCredentials?: () => Promise<ResolvedSoftphoneCredentials>;
	readonly media: SipMediaSinks;
	/** Every state transition the reducer needs, already translated out of the library's vocabulary. */
	readonly onEvent: (event: SoftphoneEvent) => void;
}

/** How the concrete adapter is constructed — one factory so the context does not name jssip. */
export type SipUserAgentFactory = (options: SipUserAgentOptions) => SipUserAgent;
