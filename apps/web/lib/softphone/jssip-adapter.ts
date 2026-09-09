/** Browser SIP registration and calls over WSS, with fresh ICE credentials for each call. */

import { UA, WebSocketInterface } from "jssip";
import type { CallPeer, SoftphoneEvent } from "./call-state";
import type { ResolvedSoftphoneCredentials } from "./contracts";
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
	/** The credentials the UA is currently registered with. Rotated by {@link peerConfiguration}. */
	private credentials: ResolvedSoftphoneCredentials;
	private session: RTCSession | null = null;
	private stopped = false;
	private starting = false;
	private generation = 0;
	private readonly attachedConnections = new WeakSet<RTCPeerConnection>();

	constructor(options: SipUserAgentOptions) {
		this.options = options;
		const { credentials } = options;
		this.credentials = credentials;

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
		session.on("ended", (event: EndEvent) => this.endSession(session, event.cause));
		session.on("failed", (event: EndEvent) => this.endSession(session, event.cause));
		session.on("hold", () => this.emit({ type: "HOLD_CHANGED", onHold: true }));
		session.on("unhold", () => this.emit({ type: "HOLD_CHANGED", onHold: false }));
		session.on("muted", () => this.emit({ type: "MUTE_CHANGED", muted: true }));
		session.on("unmuted", () => this.emit({ type: "MUTE_CHANGED", muted: false }));
		session.on("peerconnection", (data: { peerconnection: RTCPeerConnection }) => {
			this.attachRemoteAudio(data.peerconnection);
		});
		// UA.call creates the connection synchronously before returning the session.
		if (session.connection) {
			this.attachRemoteAudio(session.connection);
		}
	}

	/** Attach the decrypted remote track to the configured audio element. */
	private attachRemoteAudio(pc: RTCPeerConnection): void {
		const audio = this.options.media.remoteAudio;
		if (!audio || this.attachedConnections.has(pc)) {
			return;
		}
		this.attachedConnections.add(pc);
		const play = (stream: MediaStream) => {
			audio.srcObject = stream;
			void audio.play().catch(() => {
				/* The browser may require a user gesture before playback. */
			});
		};
		pc.addEventListener("track", (event) => {
			if (this.session?.connection !== pc) {
				return;
			}
			play(event.streams[0] ?? new MediaStream([event.track]));
		});
		const tracks = pc
			.getReceivers()
			.map((receiver) => receiver.track)
			.filter((track) => track.kind === "audio");
		if (tracks.length) {
			play(new MediaStream(tracks));
		}
	}

	private endSession(session: RTCSession, cause: string): void {
		if (this.session !== session) {
			return;
		}
		this.session = null;
		if (this.options.media.remoteAudio) {
			this.options.media.remoteAudio.srcObject = null;
		}
		this.emit({ type: "CALL_ENDED", reason: cause || "Call ended" });
	}

	start(): void {
		this.stopped = false;
		this.ua.start();
	}

	stop(): void {
		this.stopped = true;
		this.generation++;
		this.ua.stop();
	}

	call(target: string): void {
		if (this.session || this.starting || this.stopped) {
			return;
		}
		this.starting = true;
		const generation = ++this.generation;
		void (async () => {
			try {
				const pcConfig = await this.peerConfiguration();
				if (generation !== this.generation || this.session || this.stopped) {
					return;
				}
				const session = this.ua.call(target, {
					mediaConstraints: AUDIO_ONLY,
					pcConfig,
					eventHandlers: {},
				});
				this.session = session;
				this.wireSession(session);
				this.emit({ type: "OUTGOING_CALL", peer: peerFrom(session) });
			} catch {
				if (generation === this.generation && !this.stopped) {
					this.emit({
						type: "CALL_ENDED",
						reason: "Calling could not start. Reconnect the softphone and try again.",
					});
				}
			} finally {
				this.starting = false;
			}
		})();
	}

	answer(): void {
		const session = this.session;
		if (!session || this.starting || this.stopped) {
			return;
		}
		this.starting = true;
		const generation = this.generation;
		void (async () => {
			try {
				const pcConfig = await this.peerConfiguration();
				if (
					generation !== this.generation ||
					this.session !== session ||
					session.isEnded() ||
					this.stopped
				) {
					return;
				}
				session.answer({ mediaConstraints: AUDIO_ONLY, pcConfig });
			} catch {
				if (this.session === session && !session.isEnded()) {
					// Say why. A bare 480 declines the call with nothing on screen to explain it.
					this.emit({
						type: "CALL_ENDED",
						reason: "The call could not be answered. Reconnect the softphone and try again.",
					});
					session.terminate({ status_code: 480 });
				}
			} finally {
				this.starting = false;
			}
		})();
	}

	/**
	 * The relay configuration for the next media connection, from freshly fetched credentials.
	 *
	 * Only a changed `sipUri` is fatal: that means a different account — an org switch, or the
	 * extension reassigned — and placing a call as somebody else is worse than not placing one. A
	 * changed PASSWORD is the ordinary case this refresh exists for (an admin regenerating the SIP
	 * secret), so it re-registers with the new secret and the call goes ahead. Refusing it used to
	 * leave a softphone that showed "Registered" and silently declined every call.
	 */
	private async peerConfiguration(): Promise<RTCConfiguration> {
		const original = this.credentials;
		const credentials = (await this.options.refreshCredentials?.()) ?? original;
		if (!credentials.webrtcSupported) {
			throw new Error("Browser audio is disabled for this account");
		}
		if (credentials.sipUri !== original.sipUri) {
			throw new Error("The calling account changed");
		}
		if (
			credentials.password !== original.password ||
			credentials.authorizationUser !== original.authorizationUser
		) {
			this.credentials = credentials;
			this.ua.set("authorization_user", credentials.authorizationUser);
			this.ua.set("password", credentials.password);
			// A REGISTER with the new secret, not a restart: the socket and any session on it stay up,
			// and the next in-dialog challenge is answered with the credentials the server now holds.
			this.ua.register();
		}
		return { iceServers: [...(credentials.iceServers ?? [])] };
	}

	hangup(): void {
		this.generation++;
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
