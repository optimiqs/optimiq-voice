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

/** Where the remote audio would attach. Wired even though media does not flow yet — see the note. */
export interface SipMediaSinks {
	/**
	 * The `<audio>` element the remote track would be attached to. Present so the plumbing is real
	 * and the day mediad ships DTLS-SRTP this adapter needs no new wiring — but on today's platform
	 * no track ever arrives, which the UI states plainly rather than leaving a silent element to
	 * imply otherwise.
	 */
	readonly remoteAudio?: HTMLAudioElement | null;
}

export interface SipUserAgent {
	/** Open the WebSocket and REGISTER. Emits `REGISTRATION_CHANGED` as it progresses. */
	start(): void;
	/** Unregister and close the socket. Idempotent. */
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
}

export interface SipUserAgentOptions {
	readonly credentials: ResolvedSoftphoneCredentials;
	readonly media: SipMediaSinks;
	/** Every state transition the reducer needs, already translated out of the library's vocabulary. */
	readonly onEvent: (event: SoftphoneEvent) => void;
}

/** How the concrete adapter is constructed — one factory so the context does not name jssip. */
export type SipUserAgentFactory = (options: SipUserAgentOptions) => SipUserAgent;
