import {
	mediaAllocateSessionResponseSchema,
	mediaBridgeSessionsResponseSchema,
	mediaHoldSessionResponseSchema,
	mediaMuteSessionResponseSchema,
	mediaReleaseSessionResponseSchema,
	mediaSendDtmfResponseSchema,
	mediaStartPlaybackResponseSchema,
	mediaStartRecordingResponseSchema,
	mediaStopPlaybackResponseSchema,
	mediaStopRecordingResponseSchema,
	mediaTapSessionResponseSchema,
	mediaUnbridgeSessionsResponseSchema,
	mediaUntapSessionResponseSchema,
	RPC_SUBJECTS,
} from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import {
	MediaCommandRefusedError,
	MediaOperationNotSupportedError,
} from "./media-not-supported.error";
import type {
	BridgeHandle,
	CreateBridgeRequest,
	MediaDirection,
	MediaPort,
	OriginateRequest,
	OriginatedChannel,
	PlaybackHandle,
	PlayRequest,
	RecordRequest,
	RecordingHandle,
	SendDtmfRequest,
	SnoopRequest,
	TapHandle,
	TapRequest,
} from "./media-port";
import type { MediadTransport } from "./mediad-transport";
import type { MediaAllocateSessionResponse } from "@optimiq-voice/events";
import type { BridgeMode, HangupCause } from "@optimiq-voice/telephony";

/**
 * {@link MediaPort} over `apps/mediad`, at rung 4 of `plans/mediad-design.md` §2.
 *
 * ## The coverage map, and why it is the whole point of this file
 *
 * `MediaPort` has 27 methods because Asterisk can do 27 things. `mediad` can do twenty of them
 * today, and the honest expression of that is not a partial implementation that pretends — it is an
 * implementation where every unreached rung throws {@link MediaOperationNotSupportedError} naming
 * the capability and the rung it arrives on.
 *
 * ```text
 * SUPPORTED
 *   createBridge        local: a relay with no members is nothing on the wire (see below)
 *   addToBridge         rpc.media.v1.bridge-sessions — two is a relay, three or more is a room
 *   removeFromBridge    rpc.media.v1.unbridge-sessions
 *   destroyBridge       rpc.media.v1.unbridge-sessions
 *   hangup              rpc.media.v1.release-session — the MEDIA half of a teardown
 *   channelExists       answered from this adapter's own session registry
 *   watchChannel        satisfied by construction: mediad events are org-wide, not per-leg
 *   play                rpc.media.v1.start-playback — rung 1, a session sourcing from a file
 *   stopPlayback        rpc.media.v1.stop-playback, keyed by reference alone
 *   sendDtmf            rpc.media.v1.send-dtmf — rung 3, RFC 4733 under the leg's own type
 *   record              rpc.media.v1.start-recording — rung 4, one direction (see the method)
 *   stopRecording       rpc.media.v1.stop-recording, keyed by reference alone
 *   tap, stopTap        rpc.media.v1.tap-session — rung 6, a mix-minus participant
 *   mute, unmute        rpc.media.v1.mute-session — rung 5, one direction of one leg
 *   hold, unhold        rpc.media.v1.hold-session — rung 5, the MEDIA half (see the method)
 *   startMusicOnHold    rpc.media.v1.start-playback of a `moh:` ref — rung 5 (see the method)
 *   stopMusicOnHold     rpc.media.v1.stop-playback of the reference this adapter minted
 *
 * NOT SUPPORTED — throws, naming the capability
 *   answer, ring                       SIP responses; apps/sipd owns signalling (design doc §5)
 *   originate                          creating a leg is signalling, not media
 *   getVariable, setVariable           channel variables are a dialplan concept mediad has none of
 *   snoop                              an Asterisk-ism this media plane does not need — a session
 *                                      records both directions directly. NOT a rung; see the method
 *   echo                               an Asterisk APPLICATION, not a media capability. NOT a rung
 * ```
 *
 * ## What is still missing and is NOT on this map, because `MediaPort` cannot say it
 *
 * **Per-participant gain in a room.** `apps/mediad/internal/rtp/mixer.go`'s `Member.SetGain(rx, tx)`
 * exists, is atomic and is applied on every mixed frame — and there is no subject that reaches it,
 * because `JoinOptions.GainRx/GainTx` are only ever set at join time by a caller inside the process.
 * So a moderator's volume slider is a typed refusal on BOTH drivers rather than on one: ARI has no
 * per-participant gain on a mixing bridge at all, and this plane has the mechanism and no wire. The
 * seam is a `rpc.media.v1.conference-gain` carrying `{bridgeId, sessionId, talkGainPercent,
 * listenGainPercent}` — one subject, one handler, one `SetGain` call — and it is deliberately not in
 * this wave: a contract for a control only one of two drivers could ever serve is worth declaring
 * once the surface above it has a second reason to exist.
 *
 * Two rung-4 arguments are refused at the WIRE rather than here, with the same distinction `play`
 * draws for `tone:`: the operation exists and this media plane cannot serve that argument. `beep`
 * needs a tone generator, and a real `terminateOn` needs DTMF DETECTION — the receive half of rung 3
 * — so a voicemail asking for either routes to Asterisk rather than recording without a beep and
 * ignoring `#`.
 *
 * `play` is supported for the media refs `apps/engine/src/routing/media-refs.ts` actually emits —
 * `sound:`, which is what every domain `MediaRef` renders into. Asterisk's GENERATOR schemes are
 * refused by `mediad` at the wire with `not_supported` and the scheme named, which is a
 * {@link MediaCommandRefusedError} here rather than a capability refusal: the operation exists, this
 * media plane cannot serve that argument.
 *
 * ## Why `createBridge` needs no round trip
 *
 * On Asterisk a bridge is a server-side object that exists before anybody joins it. On a RELAY it is
 * two pointers: there is no such thing as an empty one. So `createBridge` records the
 * client-assigned id locally and the first `addToBridge` that reaches two members issues the actual
 * `bridge-sessions`. That is not the adapter being clever — it is the adapter absorbing a difference
 * between two media planes, which is exactly what an adapter is for, and it is why the orchestrator
 * above the seam did not have to learn anything.
 *
 * ## Why a leg id IS a session id
 *
 * Under this driver the engine's channel id and `mediad`'s session id are the same string, because
 * both are assigned by the engine (`OriginateRequest.channelId` and
 * `mediaAllocateSessionRequestSchema.sessionId` are client-assigned for the same reason: the caller
 * must be able to release something whose reply it never received). Keeping them equal means there
 * is no mapping table to lose on an engine restart.
 */
/**
 * `RecordRequest` speaks seconds because ARI does; every `rpc.media.v1.*` payload speaks
 * milliseconds because the rest of this backbone does. The conversion lives at the adapter, which is
 * the only place that knows both.
 */
const MILLIS_PER_SECOND = 1_000;

/** `mediad`'s own default music class, and Asterisk's. See `audio.DefaultMOHClass`. */
const DEFAULT_MOH_CLASS = "default";

/**
 * The reference a leg's hold-music loop plays under.
 *
 * DERIVED from the channel id rather than random, and that is the point: `MediaPort.stopMusicOnHold`
 * carries a channel and `rpc.media.v1.stop-playback` is keyed by a reference, so something has to
 * join the two — and a derivation survives a process restart where a Map does not. A caller left
 * listening to hold music because the engine that started it was replaced is a worse failure than
 * any this saves.
 */
function musicRefFor(channelId: string): string {
	return `moh:${channelId}`;
}

export class MediadMediaPort implements MediaPort {
	/**
	 * v1 relays RTP without decoding it — the header is rewritten and the payload is passed through
	 * byte for byte. That is `proxy-media` exactly, and it is the reason `snoop` is refused
	 * permanently below rather than pending: there are no samples to tap. See
	 * {@link MediaPort.bridgeMode}.
	 */
	readonly bridgeMode = "proxy-media" satisfies BridgeMode;

	private readonly logger = getLogger("engine.mediad");

	/**
	 * Bridges this adapter has been asked to create, and who is in them.
	 *
	 * In memory, and that is a KNOWN limitation rather than an oversight: a bridge that only this
	 * process knows about cannot be repaired by another instance after a crash. The durable half —
	 * the `bridgeId` on each session's `media-sessions` directory entry — is written by `mediad`, so
	 * the information survives; what does not survive is this adapter's view of a bridge whose
	 * second member has not arrived yet. That window is milliseconds inside one call setup, which is
	 * the right amount of durability to buy for it today. Design doc open question 3 (drain) is
	 * where this gets revisited, because that is when it starts to matter.
	 */
	private readonly bridges = new Map<string, Set<string>>();

	/** Sessions this adapter believes are allocated on `mediad`, so `channelExists` can answer. */
	private readonly sessions = new Set<string>();

	/**
	 * Which playback reference each leg's hold-music loop is running under.
	 *
	 * A cache and not the source of truth, which is why {@link stopMusicOnHold} falls back to
	 * recomputing the reference: the map is lost on a restart and the loop is not.
	 */
	private readonly music = new Map<string, string>();

	constructor(
		private readonly transport: MediadTransport,
		private readonly timeoutMs: number,
	) {}

	// --- the media plane's own surface, above MediaPort -----------------------------------------

	/**
	 * Allocates an RTP session and answers an SDP offer.
	 *
	 * NOT a `MediaPort` method, and deliberately so: `MediaPort` is the vocabulary of an engine
	 * driving a media server that also terminates SIP, and it has no concept of an offer because
	 * Asterisk never showed it one. SDP arrives at the engine only on the `apps/sipd` path, so this
	 * is the surface that path will call, and putting it on the shared interface would add a method
	 * `AriMediaAdapter` could only throw from.
	 */
	async allocateSession(request: {
		readonly sessionId: string;
		readonly orgId: string;
		readonly callId: string;
		readonly legId?: string;
		readonly sdpOffer: string;
		readonly direction?: "sendrecv" | "sendonly" | "recvonly" | "inactive";
	}): Promise<MediaAllocateSessionResponse> {
		const response = await this.call(
			RPC_SUBJECTS.mediaAllocateSession,
			{
				sessionId: request.sessionId,
				orgId: request.orgId,
				callId: request.callId,
				...(request.legId === undefined ? {} : { legId: request.legId }),
				sdpOffer: request.sdpOffer,
				direction: request.direction ?? "sendrecv",
			},
			mediaAllocateSessionResponseSchema,
		);
		this.sessions.add(request.sessionId);
		return response;
	}

	/**
	 * Starts a recording, naming which side of the session to capture.
	 *
	 * NOT a `MediaPort` method, and for the same reason {@link allocateSession} is not: the shared
	 * interface has no way to say it. `RecordRequest` carries no direction because on Asterisk the
	 * direction is encoded in WHICH CHANNEL is recorded — the leg itself for one side, a snoop
	 * channel spying on `both` for the conversation — and a media plane with no snoop primitive needs
	 * to be asked directly.
	 *
	 * `direction: "both"` is the snoop replacement, and it is what an on-demand call recording means:
	 * both directions decoded, summed and written as one mono stream. It is the surface a
	 * driver-aware caller uses instead of {@link snoop} followed by {@link record}.
	 *
	 * @returns the object key the audio will land under, relative to the recordings root — the same
	 * `<orgId>/<callId>/<recordingRef>.<format>` the engine computes for `channel.record.started`,
	 * which is what makes the two agree without either telling the other.
	 */
	async startRecording(request: {
		readonly sessionId: string;
		readonly recordingRef: string;
		readonly direction?: "receive" | "both";
		readonly format?: string;
		readonly maxDurationMs?: number;
		readonly maxSilenceMs?: number;
		readonly beep?: boolean;
		readonly terminateOn?: string;
	}): Promise<string | undefined> {
		const response = await this.call(
			RPC_SUBJECTS.mediaStartRecording,
			{
				sessionId: request.sessionId,
				recordingRef: request.recordingRef,
				direction: request.direction ?? "both",
				format: request.format ?? "wav",
				...(request.maxDurationMs === undefined ? {} : { maxDurationMs: request.maxDurationMs }),
				...(request.maxSilenceMs === undefined ? {} : { maxSilenceMs: request.maxSilenceMs }),
				...(request.beep === undefined ? {} : { beep: request.beep }),
				...(request.terminateOn === undefined ? {} : { terminateOn: request.terminateOn }),
			},
			mediaStartRecordingResponseSchema,
		);
		return response.objectKey;
	}

	/** Frees a session and its directory entry. Idempotent — a repeat is `released: false`. */
	async releaseSession(sessionId: string): Promise<boolean> {
		const response = await this.call(
			RPC_SUBJECTS.mediaReleaseSession,
			{ sessionId },
			mediaReleaseSessionResponseSchema,
		);
		this.sessions.delete(sessionId);
		this.forgetMember(sessionId);
		return response.released;
	}

	// --- MediaPort: supported --------------------------------------------------------------------

	/**
	 * Records a bridge id. No round trip — see the class doc.
	 *
	 * `name` is accepted and dropped: a relay has no name to carry, and refusing a request over a
	 * field that only exists for an Asterisk operator's `bridge show` output would be refusing a
	 * call for a debugging convenience.
	 */
	async createBridge(request: CreateBridgeRequest): Promise<BridgeHandle> {
		this.bridges.set(request.bridgeId, new Set());
		await Promise.resolve();
		return { bridgeId: request.bridgeId };
	}

	/**
	 * Joins legs to a bridge, issuing the command once there are at least two.
	 *
	 * A third member USED TO BE REFUSED here, naming rung 6, because N-way audio is mixing and this
	 * plane relayed. Rung 6 arrived and `bridge-sessions` now takes two to eight, so a conference
	 * bridge is the same call a two-party one is — which member of the pair is a relay and which is a
	 * mix is `mediad`'s decision, made from the count, and deliberately not stated here. An adapter
	 * that named the mechanism would be holding an opinion about a mixer it cannot see.
	 *
	 * The re-send on every arrival is not waste and is not a retry. A room's membership is the WHOLE
	 * list, not a delta — `mediad` seats everybody named and destroys a room it could not finish
	 * building — so a fourth member joining is one command carrying four ids. The alternative, a
	 * per-member add, would need a second subject whose failure mode is a half-built room.
	 */
	async addToBridge(bridgeId: string, channelIds: readonly string[]): Promise<void> {
		const members = this.bridges.get(bridgeId) ?? new Set<string>();
		for (const channelId of channelIds) {
			members.add(channelId);
		}
		this.bridges.set(bridgeId, members);

		if (members.size < 2) {
			// One member is a leg waiting for its peer — the normal state between an A-leg answering
			// and a B-leg being dialled. There is nothing to relay yet and nothing to report.
			return;
		}

		const sessionIds = [...members];
		await this.call(
			RPC_SUBJECTS.mediaBridgeSessions,
			{ bridgeId, sessionIds },
			mediaBridgeSessionsResponseSchema,
		);
	}

	/**
	 * Separates legs from a bridge WITHOUT hanging them up.
	 *
	 * A relay is all-or-nothing between two parties, so removing either one ends it. The survivor
	 * stays allocated, which is what an attended transfer needs: the leg is about to be put in a
	 * different bridge, and tearing its session down in between would drop the call being moved.
	 */
	async removeFromBridge(bridgeId: string, channelIds: readonly string[]): Promise<void> {
		const members = this.bridges.get(bridgeId);
		if (members === undefined) {
			// Already gone. Not an error: the engine retries, and a media plane that threw here
			// would turn a duplicate teardown into a failed call.
			return;
		}
		for (const channelId of channelIds) {
			members.delete(channelId);
		}
		await this.unbridge(bridgeId);
	}

	/** Destroys a bridge. Members are ejected, never hung up. Already-gone is a no-op. */
	async destroyBridge(bridgeId: string): Promise<void> {
		this.bridges.delete(bridgeId);
		await this.unbridge(bridgeId);
	}

	/**
	 * Frees the leg's media session.
	 *
	 * The MEDIA half of a teardown, and the boundary is worth being exact about: `mediad` never
	 * speaks SIP (design doc §5), so this does not send a BYE and cannot. The signalling half is
	 * `apps/sipd`'s, driven by the engine on the same teardown. What this guarantees is that the
	 * port is back in the pool and the session directory entry is gone.
	 *
	 * `cause` is accepted and dropped: a Q.850 code is a signalling fact, and a media plane that
	 * recorded one would be keeping a second opinion about why a call ended.
	 */
	async hangup(channelId: string, cause: HangupCause): Promise<void> {
		void cause;
		await this.releaseSession(channelId);
	}

	/** Whether this adapter still holds a session for the leg. */
	async channelExists(channelId: string): Promise<boolean> {
		await Promise.resolve();
		return this.sessions.has(channelId);
	}

	/**
	 * Plays audio towards the leg's far end. Rung 1 of `plans/mediad-design.md` §2.
	 *
	 * ## It returns when playback has STARTED, and that is the contract
	 *
	 * `MediaPort.play` hands back a handle the moment audio begins, never when the prompt ends. The
	 * verb executor says so directly, and barge-in depends on it: a caller who presses a digit must
	 * be able to interrupt without this call holding a fiber for the length of the menu. So this is
	 * one 1 s command, and the end of the prompt is a `media.evt.v1.…playback.finished` event.
	 *
	 * ## Why nothing here waits for that event
	 *
	 * Because nothing above the seam does. The orchestrator's twelve-member `MediaEvent` union has
	 * no playback member, and on the ARI path `PlaybackFinished` is one of the events `toMediaEvent`
	 * deliberately drops. `mediad-event-mapping.ts` mirrors that exactly, which is what makes a
	 * confirmation IVR or a voicemail greeting behave identically on either driver: both learn a
	 * prompt started from the command's reply and stop it by reference, and neither waits.
	 *
	 * ## The media ref is passed through, not translated
	 *
	 * `apps/engine/src/routing/media-refs.ts` has already rendered every domain `MediaRef` into the
	 * media server's flat vocabulary, and `mediad` resolves the one member of it that names a file:
	 * `sound:`. Asterisk's generators — `tone:`, `digits:`, `number:`, `characters:` — are refused
	 * by `mediad` as `not_supported` with the scheme in the message, which surfaces here as a
	 * {@link MediaCommandRefusedError} the caller can route around. Translating them into something
	 * `mediad` would accept is not possible: they are a synthesiser, not a path.
	 */
	async play(channelId: string, request: PlayRequest): Promise<PlaybackHandle> {
		await this.call(
			RPC_SUBJECTS.mediaStartPlayback,
			{
				sessionId: channelId,
				playbackRef: request.playbackRef,
				media: [...request.media],
				...(request.language === undefined ? {} : { language: request.language }),
			},
			mediaStartPlaybackResponseSchema,
		);
		// The CALLER's reference, not the reply's. They are equal by contract — `playbackRef` is
		// client-assigned so a stop can name it without holding server state — and returning the one
		// the caller already holds means a lost reply cannot produce a handle it does not recognise.
		return { playbackRef: request.playbackRef };
	}

	/**
	 * Stops a prompt by reference. Stopping an already-finished playback is a no-op.
	 *
	 * The no-op is the COMMON path rather than an edge case: `gather` stops its prompt the moment
	 * collection ends, whatever ended it, so a caller who listens to the whole menu and then presses
	 * a digit produces exactly this on every call. `mediad` answers `ok: true, stopped: false` for
	 * it, so this resolves rather than throwing — which is what the interface promises and what the
	 * barge-in path in `plan-walker.ts` is written against.
	 */
	async stopPlayback(playbackRef: string): Promise<void> {
		await this.call(
			RPC_SUBJECTS.mediaStopPlayback,
			{ playbackRef },
			mediaStopPlaybackResponseSchema,
		);
	}

	/**
	 * Generates DTMF towards the leg's far end. Rung 3 of `plans/mediad-design.md` §2.
	 *
	 * ## Generating, not forwarding
	 *
	 * Digits a party PRESSES have crossed a `mediad` bridge since rung 2 — a telephone-event payload
	 * is just bytes to a relay. What that path cannot do is originate one, because there is no
	 * inbound packet to forward, and originating is what this method is for: an attended transfer
	 * punching an extension into a far-end IVR, or a confirmed transfer answering "press 1" on the
	 * caller's behalf.
	 *
	 * ## It resolves when injection has STARTED
	 *
	 * Exactly what `client.channels.sendDtmf` does on ARI — Asterisk queues the frames and answers —
	 * so the two drivers behave identically at this seam, which is the property the cutover rests on.
	 * The interface returns `void` and hands back no handle, so a late resolution would tell a caller
	 * nothing an early one did not. Everything refusable is decided before the first packet.
	 *
	 * ## A leg that negotiated no RFC 4733 type is refused, not approximated
	 *
	 * `mediad` answers `not_supported` and this surfaces as a {@link MediaCommandRefusedError} the
	 * caller can route around. The two alternatives are worse: sending under a payload type the far
	 * end never agreed to produces digits it silently drops, and an inband tone needs a synthesiser
	 * this media plane does not have — the same deferral `tone://` carries at {@link play}.
	 */
	async sendDtmf(channelId: string, request: SendDtmfRequest): Promise<void> {
		await this.call(
			RPC_SUBJECTS.mediaSendDtmf,
			{
				sessionId: channelId,
				digits: request.digits,
				...(request.toneDurationMs === undefined ? {} : { toneDurationMs: request.toneDurationMs }),
				...(request.gapMs === undefined ? {} : { gapMs: request.gapMs }),
			},
			mediaSendDtmfResponseSchema,
		);
	}

	/**
	 * Writes the leg's audio to a file. Rung 4 of `plans/mediad-design.md` §2.
	 *
	 * ## Why this records ONE direction
	 *
	 * Because that is what the ARI method it stands in for records. `client.channels.record` on a
	 * plain channel captures what the channel is SAYING — the party on it — which is what
	 * `plan-walker.ts`'s voicemail node wants: a mailbox message should hold the caller, not the
	 * greeting that was played at them. The conversation case only exists on ARI because
	 * `call-control.ts` interposes a snoop channel first, and `RecordRequest` has no direction on it
	 * for exactly that reason: the direction was encoded in which channel id was passed.
	 *
	 * A driver-aware caller that wants both directions asks {@link startRecording} for them. That is
	 * the same split {@link allocateSession} makes: a capability the shared interface cannot express
	 * lives above `MediaPort` rather than being smuggled into a method whose meaning would then
	 * differ between the two drivers.
	 *
	 * ## Where the file goes, and why this does not say
	 *
	 * `mediad` derives `<orgId>/<callId>/<name>.wav` from the session it already holds, which is
	 * byte-for-byte the object key `call-control.ts` and `plan-walker.ts` compute for the same
	 * recording. Passing a path would be the engine dictating a layout the media plane can work out
	 * for itself, over a wire where a malformed one is a write to an arbitrary directory.
	 *
	 * ## What is refused rather than dropped
	 *
	 * `beep` and a real `terminateOn` are both `not_supported` at the wire — the first needs a tone
	 * generator, the second needs DTMF DETECTION, which is the receive half of rung 3 and not built.
	 * Both surface here as {@link MediaCommandRefusedError}, and the engine routes that leg to
	 * Asterisk. Accepting them and doing nothing would produce a voicemail with no beep whose
	 * caller's first words are clipped, and one that ignores `#` and runs to its duration limit.
	 */
	async record(channelId: string, request: RecordRequest): Promise<RecordingHandle> {
		await this.startRecording({
			sessionId: channelId,
			recordingRef: request.name,
			direction: "receive",
			format: request.format,
			...(request.maxDurationSeconds === undefined
				? {}
				: { maxDurationMs: request.maxDurationSeconds * MILLIS_PER_SECOND }),
			...(request.maxSilenceSeconds === undefined
				? {}
				: { maxSilenceMs: request.maxSilenceSeconds * MILLIS_PER_SECOND }),
			...(request.beep === undefined ? {} : { beep: request.beep }),
			...(request.terminateOn === undefined ? {} : { terminateOn: request.terminateOn }),
		});
		// The CALLER's name and format, not the reply's — they are equal by contract, and returning
		// the ones the caller already holds means a lost reply cannot produce a handle it does not
		// recognise. Same argument as `play`.
		return { name: request.name, format: request.format };
	}

	/**
	 * Finalises a recording by reference. Already-finished is a no-op.
	 *
	 * The no-op is the normal case rather than an edge one: a recording that hit its duration limit,
	 * or whose leg hung up, has already finalised itself by the time a teardown gets around to
	 * stopping it. `mediad` answers `ok: true, stopped: false` for that, so this resolves rather than
	 * throwing — which is what the interface promises.
	 *
	 * The reply says the recorder was TOLD to stop. The file being safe to read is
	 * `media.evt.v1.…recording.finished`, which arrives as a `recording-finished` `MediaEvent` and is
	 * what the callers above this seam already block on.
	 */
	async stopRecording(name: string): Promise<void> {
		await this.call(
			RPC_SUBJECTS.mediaStopRecording,
			{ recordingRef: name },
			mediaStopRecordingResponseSchema,
		);
	}

	/**
	 * Satisfied by construction, which is why it is not a refusal.
	 *
	 * `watchChannel` exists because ARI's narrow subscription STOPS when a channel leaves the
	 * application, so the event that writes the CDR arrives to nobody. `mediad` has no such notion:
	 * it publishes `media.evt.v1.<orgId>.<sessionId>.*` for every session it holds, and the engine's
	 * subscription is org-wide. There is no per-leg subscription to extend because there was never a
	 * per-leg subscription.
	 *
	 * This is the one method where doing nothing is the correct implementation rather than a silent
	 * no-op, and the difference is that the CONTRACT is met — the caller's events keep arriving —
	 * rather than quietly unmet.
	 */
	async watchChannel(channelId: string): Promise<void> {
		void channelId;
		await Promise.resolve();
	}

	// --- rung 5: hold, mute, and music -----------------------------------------------------------

	/**
	 * Plays a hold-music class at the leg WITHOUT taking it out of the conversation.
	 *
	 * ## Why this is a playback and not `hold-session`
	 *
	 * `MediaPort` says so directly — "start music on hold from a configured class. Separate from
	 * hold, which is signalling" — and the case that needs the separation is a queue: a caller
	 * hearing hold music is very much still in a conversation with the queue, and holding them would
	 * make them inaudible to the agent who then answers to silence. So this is `start-playback` of a
	 * looping `moh:` reference, exactly what it is on Asterisk, where `channels.startMoh` is a
	 * playback too.
	 *
	 * ## The reference is minted here, and that is what makes {@link stopMusicOnHold} possible
	 *
	 * `MediaPort.stopMusicOnHold(channelId)` carries a CHANNEL and no reference, while
	 * `stop-playback` is keyed by reference and carries no session — the two do not meet, and the
	 * only place that can join them is the adapter that started the loop. So the reference is
	 * derived from the channel id rather than random: a restart loses this map, and a
	 * deterministically-named loop is one a later stop can still name. Asterisk needs none of this
	 * because `channels.stopMoh` is addressed by channel; this is the adapter absorbing that
	 * difference, which is what an adapter is for.
	 *
	 * The class defaults to `default`, which is `mediad`'s own default class and Asterisk's.
	 */
	async startMusicOnHold(channelId: string, mohClass?: string): Promise<void> {
		const playbackRef = musicRefFor(channelId);
		await this.call(
			RPC_SUBJECTS.mediaStartPlayback,
			{
				sessionId: channelId,
				playbackRef,
				media: [`moh:${mohClass ?? DEFAULT_MOH_CLASS}`],
			},
			mediaStartPlaybackResponseSchema,
		);
		this.music.set(channelId, playbackRef);
	}

	/**
	 * Stops the loop {@link startMusicOnHold} started. Stopping one that already finished is a no-op.
	 *
	 * It falls back to the derived reference when this process did not start the loop, which is the
	 * case that matters after a restart: `mediad` still has the playback running under a name this
	 * adapter can recompute, and refusing to stop it because a Map is empty would leave a caller
	 * listening to hold music nobody is holding.
	 */
	async stopMusicOnHold(channelId: string): Promise<void> {
		const playbackRef = this.music.get(channelId) ?? musicRefFor(channelId);
		this.music.delete(channelId);
		await this.call(
			RPC_SUBJECTS.mediaStopPlayback,
			{ playbackRef },
			mediaStopPlaybackResponseSchema,
		);
	}

	/**
	 * Takes the leg out of the conversation — the MEDIA half of a hold.
	 *
	 * Not the whole of one, and the boundary is worth being exact about: the SIP re-INVITE that
	 * lights the far end's hold key is `apps/sipd`'s, and an engine that wants both sends both. This
	 * suppresses both directions so the other party stops hearing them, which is the half a caller
	 * notices immediately and the half a compliance review asks about.
	 *
	 * No music. `MediaPort.hold` takes no class and `startMusicOnHold` is the separate call for it,
	 * so passing one here would be this adapter deciding that a held party should hear something —
	 * a decision the interface deliberately leaves to the caller, because "the held caller hears the
	 * queue's music" and "the holding agent hears nothing" are two different commands about two
	 * different legs.
	 */
	async hold(channelId: string): Promise<void> {
		await this.call(
			RPC_SUBJECTS.mediaHoldSession,
			{ sessionId: channelId, unhold: false },
			mediaHoldSessionResponseSchema,
		);
	}

	/** Puts the leg back in the conversation. Unholding a leg that was not held is a no-op. */
	async unhold(channelId: string): Promise<void> {
		await this.call(
			RPC_SUBJECTS.mediaHoldSession,
			{ sessionId: channelId, unhold: true },
			mediaHoldSessionResponseSchema,
		);
	}

	/**
	 * Gates one or both directions of the leg without touching the bridge.
	 *
	 * ADDITIVE, which is the contract's word and the reason it is worth repeating here: muting `in`
	 * on a leg already muted `out` leaves both set. The reply carries the state afterwards; this
	 * method returns `void` because {@link MediaPort} does, so the state is discarded here and read
	 * by whoever asked through the surface above.
	 */
	async mute(channelId: string, direction: MediaDirection): Promise<void> {
		await this.call(
			RPC_SUBJECTS.mediaMuteSession,
			{ sessionId: channelId, direction, unmute: false },
			mediaMuteSessionResponseSchema,
		);
	}

	/** Lifts a mute on one or both directions. Lifts only what it names. */
	async unmute(channelId: string, direction: MediaDirection): Promise<void> {
		await this.call(
			RPC_SUBJECTS.mediaMuteSession,
			{ sessionId: channelId, direction, unmute: true },
			mediaMuteSessionResponseSchema,
		);
	}

	// --- MediaPort: not supported at this rung ---------------------------------------------------

	async answer(channelId: string): Promise<void> {
		void channelId;
		return this.refuse("answer", "SIP signalling, which apps/sipd owns (design doc §5)");
	}

	async ring(channelId: string): Promise<void> {
		void channelId;
		return this.refuse("ring", "SIP signalling, which apps/sipd owns (design doc §5)");
	}

	async getVariable(channelId: string, name: string): Promise<string | undefined> {
		void channelId;
		void name;
		return this.refuse("getVariable", "channel variables, which are a dialplan concept");
	}

	async setVariable(channelId: string, name: string, value: string): Promise<void> {
		void channelId;
		void name;
		void value;
		return this.refuse("setVariable", "channel variables, which are a dialplan concept");
	}

	async originate(request: OriginateRequest): Promise<OriginatedChannel> {
		void request;
		return this.refuse("originate", "SIP signalling, which apps/sipd owns (design doc §5)");
	}

	/**
	 * Creates a channel that listens to another one — REFUSED, and this is the one refusal on this
	 * driver that is not a rung.
	 *
	 * A snoop channel is an Asterisk-ism. ARI addresses everything by channel id, so a tap has to BE
	 * a channel in order to be a thing a command can name, and `call-control.ts` therefore creates
	 * one spying on `both` directions before it records it.
	 *
	 * `mediad` has no such constraint: a session already is both directions — what it receives is the
	 * far party, what it sends is everything the far party was told — so the direction is an argument
	 * on {@link startRecording} rather than a second object with its own port, its own lifecycle and
	 * its own `leg-arrived` for a leg that does not exist. Synthesising one would be exactly the
	 * "emit fake ARI events forever" outcome `plans/mediad-design.md` §3.2 exists to avoid.
	 *
	 * The consequence is named rather than hidden: `call-control.ts`'s on-demand recording path calls
	 * `snoop` before `record`, so it routes to Asterisk under this driver until that path learns to
	 * ask the media plane for a two-direction recording directly. The capability is here; the caller
	 * has not been pointed at it yet.
	 */
	async snoop(request: SnoopRequest): Promise<OriginatedChannel> {
		void request;
		return this.refuse(
			"snoop",
			"a snoop tap, which this media plane does not need: a session records both directions " +
				"directly (see startRecording with direction 'both')",
		);
	}

	/**
	 * Loops a leg's audio back to itself — REFUSED, and for the same reason `snoop` is: the thing
	 * being asked for is an Asterisk application, not a media capability this relay is missing.
	 *
	 * The Asterisk driver serves `*43` by handing the channel to `Echo()` in the dialplan, which is
	 * a door `mediad` does not have and should not grow: it has no dialplan, and a relay that
	 * reflected a session's own packets back at it would be inventing an application on the far side
	 * of the seam that exists to keep applications OFF it.
	 *
	 * So the refusal names the operation rather than a rung. The walker announces "not available",
	 * and a deployment that wants an echo test sets `ENGINE_MEDIA_DRIVER=ari` — which is exactly the
	 * per-capability cutover `plans/mediad-design.md` §2 describes.
	 */
	/**
	 * A supervisor joining a conversation on asymmetric terms. Rung 6.
	 *
	 * ## The distinction from {@link snoop} directly above is the whole design
	 *
	 * `snoop` is refused PERMANENTLY because it asks for an Asterisk-ism — a tap that has to be its
	 * own channel — that this plane has no need of and could only fake. `tap` asks for something
	 * real: routing one participant's audio to one peer and not the other, which is a MIX. That was
	 * rung 6 and is now built, and it was served by the mixer ARRIVING rather than by the contract
	 * being renegotiated — which is exactly what `plans/mediad-design.md` §10 question 4 predicted
	 * when it insisted the full `hear`/`speakTo` shape ship before any responder existed.
	 *
	 * ## What is passed, and what is deliberately dropped
	 *
	 * `targetSide` is passed, and it closes the one gap the first implementation named out loud: the
	 * media plane used to fix the convention "`a` is the target session" and rely on the engine
	 * ordering its arguments to match. The engine knows which leg is the target — the supervision
	 * runtime taps the extension it was asked to monitor — so it states the fact instead.
	 *
	 * `tapChannelId` and `bridgeId` are dropped, and that is not a lost field. Both exist because on
	 * ARI a tap materialises as a CHANNEL that enters the engine's own Stasis application, so it must
	 * be watchable before it exists; here the tap is the supervisor's own already-allocated session
	 * and the room is resolved from the target. `TapRequest` says so directly: "a driver with no
	 * channel concept simply ignores both".
	 *
	 * The returned handle echoes the caller's ids so `stopTap` names what the caller holds.
	 */
	async tap(request: TapRequest): Promise<TapHandle> {
		const reply = await this.call(
			RPC_SUBJECTS.mediaTapSession,
			{
				tapId: request.tapId,
				tapSessionId: request.supervisorChannelId,
				targetSessionId: request.targetChannelId,
				targetSide: request.targetSide,
				hear: request.hear,
				speakTo: request.speakTo,
				...(request.mode === undefined ? {} : { mode: request.mode }),
			},
			mediaTapSessionResponseSchema,
		);
		return {
			tapId: request.tapId,
			tapChannelId: request.supervisorChannelId,
			// The room mediad actually put the tap in, which on a converted two-party call is the
			// bridge's own id and not the one the caller minted for a bridge this plane never made.
			bridgeId: reply.bridgeId ?? request.bridgeId,
		};
	}

	/**
	 * Ends a tap, leaving the monitored conversation running.
	 *
	 * Idempotent: untapping something already gone answers `ok: true, untapped: false`, so this
	 * resolves rather than throwing — the engine retries an untap on teardown, and a monitored call
	 * that outlived the retry is not a failure.
	 *
	 * What it never does is convert the conversation back to a relay. That is `mediad`'s decision and
	 * is recorded there: switching a live call from mix to relay means dropping the buffered frames
	 * and resetting both codecs mid-sentence, to give back sixty milliseconds the call has already
	 * had.
	 */
	async stopTap(tap: TapHandle): Promise<void> {
		await this.call(
			RPC_SUBJECTS.mediaUntapSession,
			{ tapId: tap.tapId },
			mediaUntapSessionResponseSchema,
		);
	}

	async echo(channelId: string): Promise<void> {
		void channelId;
		return this.refuse(
			"echo",
			"Asterisk's Echo() application, which is a dialplan application rather than a media " +
				"capability this relay is missing",
		);
	}

	// --- internals -------------------------------------------------------------------------------

	/**
	 * Always throws. A function rather than an inline `throw` so every refusal is one line and the
	 * coverage map above stays readable as a map.
	 */
	private refuse(operation: string, capability: string): never {
		throw new MediaOperationNotSupportedError(operation, capability);
	}

	/** Drops a session from whichever bridge it is in, so a released leg leaves no stale member. */
	private forgetMember(sessionId: string): void {
		for (const [bridgeId, members] of this.bridges) {
			if (members.delete(sessionId) && members.size === 0) {
				this.bridges.delete(bridgeId);
			}
		}
	}

	private async unbridge(bridgeId: string): Promise<void> {
		await this.call(
			RPC_SUBJECTS.mediaUnbridgeSessions,
			{ bridgeId },
			mediaUnbridgeSessionsResponseSchema,
		);
	}

	/**
	 * Issues one command, validates the reply against the contract, and turns a refusal into a
	 * typed error.
	 *
	 * Validating the reply is not ceremony. The responder is a DIFFERENT LANGUAGE compiled from the
	 * same schema, so the one failure this catches is the one nothing else can: a Go struct that
	 * drifted from the Zod source. Failing here names the field; failing later names a call.
	 */
	private async call<TSchema extends { parse(value: unknown): unknown }>(
		subject: string,
		payload: unknown,
		schema: TSchema,
	): Promise<ReturnType<TSchema["parse"]> extends infer T ? T : never> {
		const raw = await this.transport.request(subject, payload, this.timeoutMs);
		const reply = schema.parse(raw) as {
			ok: boolean;
			reason?: string;
			error?: string;
			instanceId?: string;
		};

		if (!reply.ok) {
			this.logger.warn(
				{ subject, reason: reply.reason, instanceId: reply.instanceId },
				"mediad refused a media command",
			);
			throw new MediaCommandRefusedError(
				subject,
				reply.reason ?? "internal",
				reply.error ?? "no detail",
				reply.instanceId,
			);
		}
		return reply as never;
	}
}
