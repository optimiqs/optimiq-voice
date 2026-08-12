/**
 * The jssip-backed {@link SipUserAgent}.
 *
 * ## Why jssip
 *
 * jssip is a maintained (v3.x), purpose-built SIP-over-WebSocket + WebRTC user agent. Of the two
 * candidates in scope, it exposes exactly the surface a register-and-call softphone needs — `UA`,
 * `WebSocketInterface`, `RTCSession` with `hold`/`unhold`/`mute`/`sendDTMF` — behind a small,
 * event-driven API, where sip.js models a lower-level transaction/dialog layer this UI would have
 * to reassemble. It also ships its own TypeScript types (`lib/JsSIP.d.ts`), so the adapter is
 * type-checked against the real library rather than a hand-written shim.
 *
 * ## The honesty boundary, in code
 *
 * jssip always negotiates media over a WebRTC `RTCPeerConnection` — which is DTLS-SRTP, always.
 * sipd's WSS listener carries the SIGNALLING (REGISTER, INVITE, BYE) and `apps/mediad` has no SRTP,
 * so the INVITE is sent and the dialog is established but no audio traverses the platform's media
 * plane. This adapter does the real thing up to that line — it opens the socket, registers, sends
 * and answers INVITEs, and drives hold/mute/DTMF on the session — and stops exactly there. It does
 * NOT claim audio: the context exposes `webrtcSupported` from the API and the UI states the media
 * plane is the remaining piece.
 *
 * This file is integration code and is deliberately NOT unit-tested — the tested surface is the
 * reducer in `call-state.ts` and the shaping in `credentials.ts`. Everything here is a thin
 * translation of jssip events into {@link SoftphoneEvent}s.
 */

import { UA, WebSocketInterface } from "jssip";
import type { CallPeer, SoftphoneEvent } from "./call-state";
import type { SipUserAgent, SipUserAgentOptions } from "./sip-adapter";
import type { EndEvent, RTCSession } from "jssip/lib/RTCSession";
import type { RTCSessionEvent, UnRegisteredEvent } from "jssip/lib/UA";

/** Standard WebRTC audio-only constraints; jssip does `getUserMedia` with these when a call starts. */
const AUDIO_ONLY: MediaStreamConstraints = { audio: true, video: false };

function peerFrom(session: RTCSession): CallPeer {
	const identity = session.remote_identity;
	return {
		identity: identity?.uri?.user ?? "unknown",
		displayName: identity?.display_name || null,
	};
}

class JsSipUserAgent implements SipUserAgent {
	private readonly ua: UA;
	private readonly options: SipUserAgentOptions;
	private session: RTCSession | null = null;

	constructor(options: SipUserAgentOptions) {
		this.options = options;
		const { credentials } = options;

		const socket = new WebSocketInterface(credentials.wssUrl);
		this.ua = new UA({
			sockets: [socket],
			uri: credentials.sipUri,
			authorization_user: credentials.authorizationUser,
			password: credentials.password,
			realm: credentials.realm,
			display_name: credentials.displayName,
			register: true,
			register_expires: credentials.registerExpires,
			// A one-sided session timer is worse than none, and sipd defaults them off (`SIPD_SESSION_TIMERS`).
			session_timers: false,
		});

		this.wireRegistration();
		this.wireIncoming();
	}

	private emit(event: SoftphoneEvent): void {
		this.options.onEvent(event);
	}

	private wireRegistration(): void {
		this.ua.on("connecting", () =>
			this.emit({ type: "REGISTRATION_CHANGED", state: "registering" }),
		);
		this.ua.on("registered", () =>
			this.emit({ type: "REGISTRATION_CHANGED", state: "registered" }),
		);
		this.ua.on("unregistered", () =>
			this.emit({ type: "REGISTRATION_CHANGED", state: "unregistered" }),
		);
		this.ua.on("registrationFailed", (event: UnRegisteredEvent) =>
			this.emit({
				type: "REGISTRATION_CHANGED",
				state: "registration-failed",
				error: event.cause ? `Registration failed: ${event.cause}` : "Registration failed",
			}),
		);
		this.ua.on("disconnected", () =>
			this.emit({
				type: "REGISTRATION_CHANGED",
				state: "registration-failed",
				error: "Lost the connection to the SIP server.",
			}),
		);
	}

	private wireIncoming(): void {
		this.ua.on("newRTCSession", (event: RTCSessionEvent) => {
			const { session } = event;
			// One line: a second call while one is up is refused rather than stacked.
			if (this.session && this.session !== session) {
				session.terminate({ status_code: 486, reason_phrase: "Busy Here" });
				return;
			}
			if (session.direction === "incoming") {
				this.session = session;
				this.wireSession(session);
				this.emit({ type: "INCOMING_CALL", peer: peerFrom(session) });
			}
			// Outgoing sessions are wired in `call()` where they are created.
		});
	}

	private wireSession(session: RTCSession): void {
		session.on("confirmed", () => this.emit({ type: "CALL_CONFIRMED", at: Date.now() }));
		session.on("accepted", () => {
			// An outgoing call is confirmed on ACK; `accepted` is the earliest signal media would begin.
			if (session.isEstablished()) {
				this.emit({ type: "CALL_CONFIRMED", at: Date.now() });
			}
		});
		session.on("ended", (event: EndEvent) => this.endSession(event.cause));
		session.on("failed", (event: EndEvent) => this.endSession(event.cause));
		session.on("hold", () => this.emit({ type: "HOLD_CHANGED", onHold: true }));
		session.on("unhold", () => this.emit({ type: "HOLD_CHANGED", onHold: false }));
		session.on("muted", () => this.emit({ type: "MUTE_CHANGED", muted: true }));
		session.on("unmuted", () => this.emit({ type: "MUTE_CHANGED", muted: false }));
		session.on("peerconnection", (data: { peerconnection: RTCPeerConnection }) => {
			this.attachRemoteAudio(data.peerconnection);
		});
	}

	/**
	 * Attach whatever remote track arrives to the audio sink.
	 *
	 * On today's platform none will — mediad has no SRTP — so this is the wiring that becomes live
	 * the day DTLS-SRTP ships, not a claim that sound plays now.
	 */
	private attachRemoteAudio(pc: RTCPeerConnection): void {
		const audio = this.options.media.remoteAudio;
		if (!audio) {
			return;
		}
		pc.addEventListener("track", (event) => {
			const [stream] = event.streams;
			if (stream) {
				audio.srcObject = stream;
				void audio.play().catch(() => {
					/* autoplay may be blocked until a user gesture; the controls are that gesture. */
				});
			}
		});
	}

	private endSession(cause: string): void {
		this.session = null;
		this.emit({ type: "CALL_ENDED", reason: cause || "Call ended" });
	}

	start(): void {
		this.ua.start();
	}

	stop(): void {
		this.ua.stop();
	}

	call(target: string): void {
		if (this.session) {
			return;
		}
		const session = this.ua.call(target, {
			mediaConstraints: AUDIO_ONLY,
			eventHandlers: {},
		});
		this.session = session;
		this.wireSession(session);
		this.emit({ type: "OUTGOING_CALL", peer: peerFrom(session) });
	}

	answer(): void {
		this.session?.answer({ mediaConstraints: AUDIO_ONLY });
	}

	hangup(): void {
		if (!this.session) {
			return;
		}
		if (this.session.isEstablished() || this.session.isInProgress()) {
			this.session.terminate();
		}
	}

	setHold(onHold: boolean): void {
		if (onHold) {
			this.session?.hold();
		} else {
			this.session?.unhold();
		}
	}

	setMuted(muted: boolean): void {
		if (muted) {
			this.session?.mute({ audio: true });
		} else {
			this.session?.unmute({ audio: true });
		}
	}

	sendDtmf(tone: string): void {
		this.session?.sendDTMF(tone);
	}
}

/** The factory the context uses. Named separately so the context imports a function, not a class. */
export function createJsSipUserAgent(options: SipUserAgentOptions): SipUserAgent {
	return new JsSipUserAgent(options);
}
