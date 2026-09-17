/** Browser SIP registration and calls over WSS, with fresh ICE credentials for each call. */

import { UA, WebSocketInterface } from "jssip";
import { wantsAutoAnswer } from "./auto-answer";
import type { CallPeer, SoftphoneEvent } from "./call-state";
import type { ResolvedSoftphoneCredentials } from "./contracts";
import type { SipUserAgent, SipUserAgentOptions } from "./sip-adapter";
import type { DTMF_TRANSPORT } from "jssip/lib/Constants";
import type { EndEvent, HoldEvent, RTCSession } from "jssip/lib/RTCSession";
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
	/**
	 * The attended transfer's second dialog.
	 *
	 * Kept apart from {@link session} deliberately: the first party is still there, on hold, and a
	 * cancelled consultation has to give them back. Folding both into one field is how a cancelled
	 * consultation ends up hanging up the wrong call.
	 */
	private consult: RTCSession | null = null;
	private consultTarget: string | null = null;
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
			// Outgoing sessions are OURS — `call()` and `startConsult()` are the only things that
			// create one, and each wires the session it is handed. This event fires synchronously
			// from inside `UA.call`, before either has had a chance to record it, so a busy check
			// here cannot tell the attended transfer's consultation from a stray second call and
			// used to answer its own consultation with 486.
			if (session.direction !== "incoming") {
				return;
			}
			// One line: a second INCOMING call while one is up is refused rather than stacked.
			if (this.session && this.session !== session) {
				session.terminate({ status_code: 486, reason_phrase: "Busy Here" });
				return;
			}
			this.session = session;
			this.wireSession(session);
			// The INCOMING_CALL is emitted either way: a page still belongs in the call UI and in the
			// recents list, and the user still needs a Hang up button for it. Auto-answer only
			// removes the need to press Answer.
			this.emit({ type: "INCOMING_CALL", peer: peerFrom(session) });
			// Guarded rather than assumed: a throw here would happen INSIDE the newRTCSession handler
			// and would take the whole incoming-call path down with it, turning a missing header into
			// a phone that never rings.
			const header = (name: string): string | undefined =>
				event.request?.getHeader?.(name) ?? undefined;
			if (wantsAutoAnswer(header)) {
				this.answer();
			}
		});
	}

	private wireSession(session: RTCSession): void {
		session.on("confirmed", () => this.emit({ type: "CALL_CONFIRMED", at: Date.now() }));
		session.on("ended", (event: EndEvent) => this.endSession(session, event.cause));
		session.on("failed", (event: EndEvent) => this.endSession(session, event.cause));
		// `originator` is the whole point: "remote" is the far end's re-INVITE turning its media
		// direction to sendonly/inactive, which is a different fact from our own Hold button and has
		// no Resume to press. Reporting both as one state left the held party reading "Connected"
		// through a silence nothing on screen explained.
		session.on("hold", (event: HoldEvent) => this.emitHold(session, event, true));
		session.on("unhold", (event: HoldEvent) => this.emitHold(session, event, false));
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

	private emitHold(session: RTCSession, event: HoldEvent, onHold: boolean): void {
		// The consultation's own hold is an implementation detail of the transfer, not a UI state.
		if (this.session !== session) {
			return;
		}
		this.emit({
			type: event.originator === "remote" ? "REMOTE_HOLD_CHANGED" : "HOLD_CHANGED",
			onHold,
		});
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
		if (this.consult === session) {
			// The consultation died on its own — a busy transferee, a decline, a network failure. Say
			// so and give the first party back rather than leaving a Complete button that would REFER
			// to a dialog that no longer exists.
			this.consult = null;
			this.consultTarget = null;
			this.resumeAfterConsult();
			this.emit({ type: "TRANSFER_FAILED", reason: cause || "The consultation call ended." });
			return;
		}
		if (this.session !== session) {
			return;
		}
		this.consult?.terminate();
		this.consult = null;
		this.consultTarget = null;
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

	/**
	 * Hang up, cancel or REJECT — one button in the UI, three things on the wire.
	 *
	 * jssip's `terminate()` defaults an unanswered INCOMING session to `480 Temporarily
	 * Unavailable`, which is the code for "this account exists but nothing is reachable". A user who
	 * pressed Reject is reachable and said no, and the difference is not cosmetic: 480 is what the
	 * dial plan reads as "keep hunting / try the fallback", while `486 Busy Here` is a final answer
	 * from the endpoint. Sending 480 for a deliberate decline made every rejected call arrive at the
	 * caller as "Unavailable" and, where a no-answer destination is configured, kept ringing on.
	 *
	 * An ESTABLISHED session takes jssip's default (a BYE), and an outgoing one in progress takes a
	 * CANCEL — neither carries a status code.
	 */
	hangup(): void {
		this.generation++;
		const session = this.session;
		if (!session) {
			return;
		}
		if (session.isEstablished()) {
			session.terminate();
			return;
		}
		if (!session.isInProgress()) {
			return;
		}
		if (session.direction === "incoming") {
			session.terminate({ status_code: 486, reason_phrase: "Busy Here" });
			return;
		}
		session.terminate();
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

	/**
	 * A keypress, on the media plane when the leg negotiated one.
	 *
	 * RFC 4733 rather than JsSIP's default of SIP INFO, and the difference is not cosmetic. An INFO
	 * digit reaches `sipd`, which turns it into a dialog event for the engine — so an IVR this phone
	 * is talking to hears it, and the far end of a BRIDGED call never does, because nothing on the
	 * media path carries it. A telephone-event travels in the RTP stream `mediad` is already
	 * relaying: the engine still sees it (`mediad` detects and publishes every digit it forwards)
	 * AND the party on the other end of the bridge hears it, which is what a caller pressing digits
	 * into somebody else's phone system needs.
	 *
	 * INFO stays as the fallback for a leg that negotiated no `telephone-event` payload type, where
	 * `canInsertDTMF` is false and `sendDTMF` would enqueue the digit into a sender that can never
	 * emit it — a keypress that disappears with only a JsSIP warning to show for it.
	 */
	sendDtmf(tone: string): void {
		const session = this.session;
		if (session === null) {
			return;
		}
		// The enum is a runtime object in jssip, and importing it for two string members would pull a
		// value import into a module that otherwise takes only types from that file.
		const transportType = (
			canInsertDtmf(session.connection) ? "RFC2833" : "INFO"
		) as DTMF_TRANSPORT;
		session.sendDTMF(tone, { transportType });
	}

	transferBlind(target: string): void {
		const session = this.session;
		const trimmed = target.trim();
		if (!session || !session.isEstablished() || this.consult || trimmed.length === 0) {
			return;
		}
		this.emit({ type: "TRANSFER_REQUESTED", mode: "blind", target: trimmed });
		this.refer(session, trimmed);
	}

	startConsult(target: string): void {
		const session = this.session;
		const trimmed = target.trim();
		if (!session || !session.isEstablished() || this.consult || trimmed.length === 0) {
			return;
		}
		this.emit({ type: "TRANSFER_REQUESTED", mode: "attended", target: trimmed });
		// Hold FIRST. The consultation grabs the microphone, and a first party still hearing the room
		// while their transfer is discussed is the failure this ordering exists to prevent.
		session.hold();
		const generation = this.generation;
		void (async () => {
			try {
				const pcConfig = await this.peerConfiguration();
				if (generation !== this.generation || this.session !== session || this.consult) {
					return;
				}
				const consult = this.ua.call(trimmed, {
					mediaConstraints: AUDIO_ONLY,
					pcConfig,
					eventHandlers: {},
				});
				this.consult = consult;
				this.consultTarget = trimmed;
				consult.on("confirmed", () => {
					if (this.consult === consult) {
						this.emit({ type: "CONSULT_CONFIRMED" });
					}
				});
				consult.on("ended", (event: EndEvent) => this.endSession(consult, event.cause));
				consult.on("failed", (event: EndEvent) => this.endSession(consult, event.cause));
				consult.on("peerconnection", (data: { peerconnection: RTCPeerConnection }) => {
					this.attachRemoteAudio(data.peerconnection);
				});
				if (consult.connection) {
					this.attachRemoteAudio(consult.connection);
				}
			} catch {
				if (generation === this.generation && this.session === session) {
					this.resumeAfterConsult();
					this.emit({ type: "TRANSFER_FAILED", reason: "The consultation call could not start." });
				}
			}
		})();
	}

	completeTransfer(): void {
		const session = this.session;
		const consult = this.consult;
		const target = this.consultTarget;
		if (!session || !consult || target === null || !consult.isEstablished()) {
			return;
		}
		this.emit({ type: "TRANSFER_COMPLETING" });
		// `Replaces` names the consultation dialog: the transferee's phone is told to take over THAT
		// call rather than be dialled afresh, which is what makes it attended rather than blind.
		this.refer(session, target, consult);
	}

	cancelTransfer(): void {
		const consult = this.consult;
		this.consult = null;
		this.consultTarget = null;
		consult?.terminate();
		this.resumeAfterConsult();
		this.emit({ type: "TRANSFER_CANCELLED" });
	}

	/**
	 * Give the first party back, but only if we are the ones holding them.
	 *
	 * A blind transfer never held anybody, and an unconditional `unhold()` there is a re-INVITE that
	 * says "resume" about a call that was never paused.
	 */
	private resumeAfterConsult(): void {
		const session = this.session;
		if (session && !session.isEnded() && session.isOnHold().local) {
			session.unhold();
		}
	}

	/**
	 * Send the REFER and translate its subscription into one of two outcomes.
	 *
	 * jssip reports the REFER's own fate: `requestFailed` (the REFER was refused — sipd answers 401
	 * to one it can neither match to a dialog nor authenticate, 4xx to a target it will not reach)
	 * and `failed` (the NOTIFY said
	 * the transfer did not complete). Either leaves the call where it was, so the first party comes
	 * off hold and the panel says why. `accepted` is NOT reported as success: the transferee may
	 * still never answer, and the call ending is the only honest end of this story.
	 */
	private refer(session: RTCSession, target: string, replaces?: RTCSession): void {
		const fail = (reason: string) => {
			if (this.session !== session) {
				return;
			}
			this.consult?.terminate();
			this.consult = null;
			this.consultTarget = null;
			this.resumeAfterConsult();
			this.emit({ type: "TRANSFER_FAILED", reason });
		};
		try {
			session.refer(target, {
				...(replaces ? { replaces } : {}),
				eventHandlers: {
					requestFailed: () => fail(`The transfer to ${target} was refused.`),
					failed: () => fail(`${target} did not accept the transfer.`),
				},
			});
		} catch {
			// `normalizeTarget` throws on a target that is not a dialable user or URI.
			fail(`${target} is not a number this softphone can transfer to.`);
		}
	}
}

/**
 * Whether this connection can put a digit into its own audio stream.
 *
 * False before the answer settles the `telephone-event` payload type, and false for a peer that
 * offered none — the browser then has nowhere to write the tone. Defensive about the shape of what
 * it is handed because it runs on a connection JsSIP owns, which is `undefined` between the call
 * and the first `peerconnection` event.
 */
function canInsertDtmf(connection: RTCPeerConnection | null | undefined): boolean {
	if (connection === null || connection === undefined) {
		return false;
	}
	for (const sender of connection.getSenders()) {
		if (sender.track?.kind === "audio") {
			return sender.dtmf?.canInsertDTMF === true;
		}
	}
	return false;
}

/** The factory the context uses. Named separately so the context imports a function, not a class. */
export function createJsSipUserAgent(options: SipUserAgentOptions): SipUserAgent {
	return new JsSipUserAgent(options);
}
