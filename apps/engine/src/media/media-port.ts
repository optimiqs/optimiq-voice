import type { SipTransport } from "@optimiq-voice/events";
import type { BridgeMode, HangupCause } from "@optimiq-voice/telephony";

/**
 * The engine-facing media contract.
 *
 * ## Why this interface exists at all
 *
 * The plan's whole media strategy (§3.4, §8 risk 1) rests on one claim: when `apps/mediad`
 * replaces Asterisk, the engine does not change. That claim is only true if there is a seam, and
 * this is it. `packages/media-ari` implements it today; `mediad`'s client will implement it
 * tomorrow; the verb executor above it never learns which.
 *
 * So the vocabulary here is DOMAIN vocabulary — `HangupCause`, milliseconds, playback references —
 * not ARI's. Translation to `reason_code` integers and to `maxDurationSeconds` happens in the
 * adapter below the seam, never above it. The day an ARI concept appears in this file is the day
 * the swap stops being free.
 *
 * It is also what makes the orchestrator testable: a fake implementing these methods is a complete
 * media server as far as the engine's logic is concerned.
 *
 * ## The P3 additions
 *
 * The routing executor needs four capabilities the P2 slice did not: originate a leg, put two legs
 * in a bridge, record a leg, and serve music on hold. They are added here rather than reached for
 * through the ARI client directly, because the moment a plan walker imports `AriClient` the seam
 * this file exists to hold is gone. Everything below still speaks domain vocabulary — a Q.850
 * `reason_code`, ARI's `maxDurationSeconds` and its live-recording-addressed-by-name quirk all
 * stay inside `ari-media.adapter.ts`.
 */

/** A handle to audio in flight, so it can be stopped. */
export interface PlaybackHandle {
	readonly playbackRef: string;
}

export interface PlayRequest {
	/**
	 * Media URIs in the media server's vocabulary (`sound:hello`, `tone:ring`). Translating the
	 * domain's `MediaRef` scheme to the server's is the routing/prompt layer's job in P3; the
	 * engine passes through for now.
	 */
	readonly media: readonly string[];
	/** Client-assigned, so a stop can name it without holding server state. */
	readonly playbackRef: string;
	readonly language?: string;
}

/**
 * Where a `sipd`-driven originate should place its INVITE, in the domain's own vocabulary.
 *
 * Mirrors `sipDialTargetSchema` in `@optimiq-voice/events` exactly — a tagged object rather than a
 * discriminated union so it survives the Go border, the same shape the wire carries. It exists
 * because a template like `PJSIP/{trunk}` hides everything that makes a trunk dialable (its proxy,
 * credentials and transport), per `plans/sipd-invite-design.md` §5.1: `endpoint` stays for the ARI
 * adapter, and this rides alongside it for the composite.
 */
export type DialTarget =
	| {
			readonly kind: "aor";
			readonly aor: string;
			readonly contactUri?: string;
			/**
			 * What `rpc.sip.v1.resolve-target` said about THIS contact, when a resolution has already
			 * happened. ENGINE-LOCAL and never on the wire — `SplitPlaneMediaPort.originate` strips it
			 * when it builds the request, because `sipDialTargetSchema` is the shape the Go side reads.
			 *
			 * It exists so the dial does not re-resolve what the walk resolved milliseconds earlier.
			 * The edge answers `resolve-target` in ~2 ms idle and ~90 ms at a hundred concurrent calls,
			 * so the second lookup was a whole round trip in the middle of a call setup that could only
			 * ever produce the answer already in hand.
			 */
			readonly resolvedEdge?: { readonly instanceId: string; readonly transport: SipTransport };
	  }
	| { readonly kind: "trunk"; readonly trunkId: string; readonly number: string }
	| { readonly kind: "uri"; readonly uri: string };

/**
 * A leg the engine asks the media server to create.
 *
 * `channelId` is CLIENT-assigned and required, not optional: the plan walker has to be able to
 * subscribe to the new leg's events before the leg exists, and a server-generated id arrives only
 * with the response — by which time a fast `StasisStart` has already been dropped on the floor.
 */
export interface OriginateRequest {
	/** Technology + resource in the media server's vocabulary (`PJSIP/1001`, `Local/1001@ctx`). */
	readonly endpoint: string;
	/** The application the answered leg is handed to. */
	readonly application: string;
	readonly applicationArgs?: string;
	readonly channelId: string;
	/** `"Name" <number>` as the far end should see it. */
	readonly callerId?: string;
	/** Ring time. `undefined` leaves the media server's default in place. */
	readonly timeoutSeconds?: number;
	/** The leg this one is being originated for; accounting and linkedid follow it. */
	readonly originatorChannelId?: string;
	/** Variables set BEFORE the leg is dialled — the export seam onto the B-leg. */
	readonly variables?: Readonly<Record<string, string>>;
	/**
	 * Where to dial, in the domain's vocabulary — the `sipd` composite's input.
	 *
	 * ADDITIVE and optional, per `plans/sipd-invite-design.md` §5.1. The composite reads it and
	 * refuses `bad_request` when it is absent; `AriMediaAdapter` and `MediadMediaPort` ignore it and
	 * dial {@link endpoint}, so adding it breaks neither. `endpoint` is a media-server template string
	 * that hides a trunk's proxy and credentials; this carries them structurally instead.
	 */
	readonly target?: DialTarget;
	/**
	 * Whether {@link callerId} may be shown to the called party — CLIP/CLIR for this call.
	 *
	 * ADDITIVE and optional on the same contract {@link target} states: the `sipd` composite forwards
	 * it and the edge writes the headers, while `AriMediaAdapter` and `MediadMediaPort` ignore it and
	 * dial as before. Absent means `allowed`, so nothing that never sets it changes behaviour.
	 *
	 * The engine says only what it INTENDS. Anonymising is the edge's to do because only the edge
	 * knows the trunk it is leaving on — see `sipOriginateRequestSchema.callerIdPresentation`.
	 */
	readonly callerIdPresentation?: "allowed" | "restricted";
}

export interface OriginatedChannel {
	readonly channelId: string;
	readonly name?: string;
}

/**
 * A bridge, as the engine names it.
 *
 * There is no mode on the REQUEST, deliberately. A route that asked for `bypass` on Asterisk would
 * get a mixing bridge anyway — ARI has one bridge type the engine can use — and a request field
 * the adapter silently ignores is the exact defect this wave exists to remove. What the bridge
 * runs in is a property of the driver, declared once at {@link MediaPort.bridgeMode}; a per-route
 * mode becomes a request field on the day a driver can honour more than one.
 */
export interface CreateBridgeRequest {
	/** Client-assigned, so the id is known before the bridge exists (and is a domain UUID). */
	readonly bridgeId: string;
	readonly name?: string;
}

export interface BridgeHandle {
	readonly bridgeId: string;
}

/** What the engine asks the media server to write to disk. */
export interface RecordRequest {
	/** The recording's name. It is also how it is stopped, and it names the file. */
	readonly name: string;
	/** Container: `wav`, `gsm`, … */
	readonly format: string;
	readonly maxDurationSeconds?: number;
	readonly maxSilenceSeconds?: number;
	readonly beep?: boolean;
	/** DTMF digits that end the recording, or `none`. */
	readonly terminateOn?: string;
}

export interface RecordingHandle {
	readonly name: string;
	readonly format: string;
}

/** Which direction of the media path a mute or a tap applies to. */
export type MediaDirection = "in" | "out" | "both";

/** Digits generated towards the far end. Milliseconds, as everywhere above this seam. */
export interface SendDtmfRequest {
	readonly digits: string;
	readonly toneDurationMs?: number;
	readonly gapMs?: number;
}

/**
 * A channel that listens to another channel.
 *
 * The tap primitive behind on-demand recording, and the reason recording does not need a bridge
 * API: a snoop channel spying on `both` directions of a bridged leg hears the whole conversation,
 * so recording it produces one object with both parties in it, on any media server that can tap a
 * channel at all.
 *
 * `snoopChannelId` is CLIENT-assigned for exactly the same reason {@link OriginateRequest}'s is:
 * the tap is handed to the engine's own application, so its `StasisStart` must be recognisable
 * BEFORE it arrives or the tap is filed as a new inbound call.
 */
export interface SnoopRequest {
	/** The leg being listened to. */
	readonly channelId: string;
	readonly snoopChannelId: string;
	/** The application the tap is handed to. Must match the engine's own. */
	readonly application: string;
	/** Which direction to listen to. `both` is what a call recording needs. */
	readonly spy: MediaDirection;
	/** Which direction to inject audio into. Absent means listen only. */
	readonly whisper?: MediaDirection;
}

/**
 * Which side of a monitored conversation a tap listens to, or speaks to.
 *
 * The same `a`/`b` leg roles `packages/telephony` names — the originating side and the side
 * originated for it — rather than the `in`/`out` of {@link MediaDirection}. That is the whole
 * distinction this vocabulary exists to draw: a DIRECTION is a property of one channel, and a SIDE
 * is a party in a conversation. A supervisor coaching "the agent" is making a statement about a
 * party, and only the adapter below this seam should have to know that on Asterisk the party is
 * reached by injecting into one direction of one channel.
 *
 * `none` is only ever meaningful on `speakTo`.
 */
export type TapSide = "a" | "b" | "both" | "none";

/**
 * A supervisor joining a conversation they are not part of — `*0`, and eavesdrop/whisper/barge.
 *
 * ## Why this is not {@link SnoopRequest} with extra fields
 *
 * A snoop is a listener glued to ONE leg, because on ARI everything is addressed by channel id and
 * a tap therefore has to BE a channel. That constraint is Asterisk's, not the domain's, and
 * `plans/mediad-design.md` §10 question 4 records the decision it forced: `mediad` refuses `snoop`
 * PERMANENTLY, so a supervision feature built on it would either be built twice or would pin `*0`
 * to `ENGINE_MEDIA_DRIVER=ari` forever.
 *
 * So a tap is specified as what it actually is: an ASYMMETRIC BRIDGE PARTICIPANT. {@link hear} says
 * which parties reach the supervisor, {@link speakTo} says which parties the supervisor reaches,
 * and the three features in every PBX brochure are three argument combinations with no branch
 * between them:
 *
 * ```text
 * eavesdrop   hear: "both"   speakTo: "none"
 * whisper     hear: "both"   speakTo: <the coached leg>
 * barge       hear: "both"   speakTo: "both"
 * ```
 *
 * That shape is also, exactly, a mix-minus participant — which is what rung 6 builds — so the day
 * `mediad` can serve this, it serves it by arriving rather than by renegotiating a contract that
 * already shipped.
 *
 * ## Every id is client-assigned, for the reason they always are here
 *
 * On the ARI driver the tap materialises as a snoop CHANNEL that enters the engine's own Stasis
 * application, and a channel the orchestrator has never heard of is filed as a new inbound call.
 * So {@link tapChannelId} must be watchable before it exists — the same rule
 * {@link OriginateRequest.channelId} and {@link SnoopRequest.snoopChannelId} follow, for the same
 * race. {@link bridgeId} follows from that: the tap and the supervisor's own leg have to meet
 * somewhere, and a bridge the engine did not name is one it cannot tear down after a restart.
 *
 * A driver with no channel concept simply ignores both. That is not a wasted field — it is the
 * adapter absorbing a difference between two media planes, which is what `MediadMediaPort` already
 * does for `createBridge` (recorded locally, no round trip, because a relay with no members is
 * nothing on the wire).
 */
export interface TapRequest {
	/** Client-assigned handle for the tap itself; {@link MediaPort.stopTap} names it. */
	readonly tapId: string;
	/** Any leg in the conversation being joined. On ARI this is the leg that is snooped. */
	readonly targetChannelId: string;
	/**
	 * Which side of that conversation {@link targetChannelId} IS.
	 *
	 * The datum that makes the side vocabulary implementable on a plane that addresses one channel
	 * at a time: "speak to the agent" is a direction on this channel only once you know whether
	 * this channel is the agent. The supervision runtime taps the extension it was asked to
	 * monitor, so this is `b` on an inbound call and `a` on one that extension placed.
	 */
	readonly targetSide: "a" | "b";
	/** The supervisor's own leg. Whatever the tap hears is joined to THIS. */
	readonly supervisorChannelId: string;
	/** Client-assigned identity for the tap participant. See the note above. */
	readonly tapChannelId: string;
	/** Client-assigned id for the bridge the tap and the supervisor's leg meet in. */
	readonly bridgeId: string;
	/** The application the tap is handed to. Must match the engine's own. */
	readonly application: string;
	/** Which parties the supervisor hears. `both` for all three features. */
	readonly hear: TapSide;
	/** Which parties hear the supervisor. `none` is the silent case, and is the default one. */
	readonly speakTo: TapSide;
	/**
	 * The feature's own name for this combination — `eavesdrop`, `whisper`, `barge`.
	 *
	 * For LOGS only, and deliberately not authoritative: {@link hear} and {@link speakTo} are the
	 * contract, and a driver that branched on this instead would be able to disagree with them.
	 * It is carried because "opened a barge on channel X" is a line an operator can read at three
	 * in the morning and `hear=both speakTo=both` is one they have to decode.
	 */
	readonly mode?: string;
}

/**
 * A live tap, and everything {@link MediaPort.stopTap} needs to take it down.
 *
 * The handle carries the ids rather than the driver remembering them, so `AriMediaAdapter` stays
 * stateless — a stopTap keyed only by `tapId` would force every driver to hold a map that an engine
 * restart loses, on a feature whose failure mode is a supervisor silently still listening.
 */
export interface TapHandle {
	readonly tapId: string;
	/** The media-plane object the tap runs as. Equal to the request's on every driver today. */
	readonly tapChannelId: string;
	readonly bridgeId: string;
}

/**
 * Everything the engine asks a media server to do.
 *
 * Still deliberately small, and still domain-shaped. `transfer` and `park` are absent and will stay
 * absent: neither is a media operation. A transfer is "take this leg out of that bridge, resolve a
 * destination for it, put it in a new one" and a park is "take it out and play it music until
 * somebody dials its slot" — both are compositions of the primitives below plus routing the media
 * server knows nothing about, and a media server that implemented them would be making routing
 * decisions on the far side of this seam.
 */
export interface MediaPort {
	/**
	 * Live contacts grouped by decreasing SIP preference; used before creating outbound legs.
	 *
	 * `legId` is the leg the resolution is being done FOR — the A-leg the walker is planning — so a
	 * refusal is attributed to a real leg rather than to the lookup itself.
	 */
	resolveTargets?(
		orgId: string,
		target: DialTarget,
		legId: string,
	): Promise<readonly (readonly DialTarget[])[]>;
	/**
	 * The mode this driver's bridges actually run in.
	 *
	 * A DECLARATION, not a request: `packages/telephony/src/bridge.ts` names four modes and the two
	 * drivers behind this seam deliver different ones. Asterisk's mixing bridge decodes the audio,
	 * so it is `media` and every media bug in §5 — recording, eavesdrop, inband detection — can
	 * attach to it. `mediad`'s v1 relays packets and never decodes them, so it is `proxy-media`:
	 * the packets pass through us and the samples do not exist, which is precisely why it refuses
	 * `snoop` by name and cannot record a live conversation.
	 *
	 * Stated here rather than rediscovered at each call site so a feature asks
	 * `supportsRecording(port.bridgeMode)` once, in domain terms, instead of every runtime
	 * re-deriving what its media plane can do and one of them getting it wrong.
	 */
	readonly bridgeMode: BridgeMode;
	/** Sample-level supervision can be supported by a relay that decodes audio on demand. */
	readonly supportsSupervision?: boolean;
	/** Records both parties directly when the driver does not need an auxiliary snoop channel. */
	recordConversation?(channelId: string, request: RecordRequest): Promise<RecordingHandle>;

	/** SIP 200 OK. Starts billing. */
	answer(channelId: string): Promise<void>;

	/** SIP 180. Alerting, no media. */
	ring(channelId: string): Promise<void>;

	/**
	 * SIP 183 with an answer. Alerting WITH media, and still not billable.
	 *
	 * Separate from {@link ring} rather than an argument on it because the two differ in what the
	 * driver must produce, not just in the status number: a 180 is a status line, while a 183 commits
	 * this leg's offer/answer exchange and therefore needs a real SDP answer from the media plane
	 * before it can be sent. A driver whose signalling and media are the same server (`AriMediaAdapter`)
	 * has no way to say "answer the offer but do not answer the call" and refuses with
	 * {@link import("./media-not-supported.error").MediaOperationNotSupportedError}, which is the same refusal `verb-executor.ts` already
	 * makes for the `earlyMedia` verb on ARI.
	 *
	 * Idempotent by contract: a carrier that sends `183` several times must not re-negotiate the
	 * caller's media or re-send the response on each one.
	 *
	 * `relayFrom` is the leg whose early media this is — the callee's. A driver whose media plane
	 * only carries audio between legs it has been told about needs it: on a split plane the two
	 * sessions have no path between them until they are bridged, so the `183` alone reaches the
	 * caller as signalling and never as sound. Optional, and ignored by a driver that is already in
	 * both media paths.
	 */
	earlyMedia(channelId: string, relayFrom?: string): Promise<void>;

	/** Start audio. Returns the handle the engine will stop it with. */
	play(channelId: string, request: PlayRequest): Promise<PlaybackHandle>;

	/** Stop audio started by {@link play}. Stopping an already-finished playback is a no-op. */
	stopPlayback(playbackRef: string): Promise<void>;

	/** Tear the leg down with a domain cause. The adapter maps it to the wire. */
	hangup(channelId: string, cause: HangupCause): Promise<void>;

	/** Read a channel variable; `undefined` when unset. */
	getVariable(channelId: string, name: string): Promise<string | undefined>;

	/** Set a channel variable. */
	setVariable(channelId: string, name: string, value: string): Promise<void>;

	/** Whether the media server considers this channel to still exist. */
	channelExists(channelId: string): Promise<boolean>;

	/**
	 * Keep receiving this channel's events after it leaves the engine's application.
	 *
	 * Not an optimisation — it is what makes the CDR reliable. The engine deliberately opens a
	 * NARROW event subscription (`ARI_SUBSCRIBE_ALL=false`, so one instance on a shared media
	 * server does not see every tenant's channels), and a narrow subscription stops at the moment a
	 * channel leaves the application. Teardown is exactly that moment: `StasisEnd` fires first and
	 * `ChannelDestroyed` — the event that publishes `channel.hangup`, `channel.destroyed` and the
	 * CDR — arrives afterwards, to nobody.
	 *
	 * So every leg the engine accepts is explicitly subscribed to, and the CDR stops depending on
	 * whether the far end or the engine ended the call.
	 */
	watchChannel(channelId: string): Promise<void>;

	// --- P3: the routing executor's media surface --------------------------------------------

	/**
	 * Create and dial a new leg.
	 *
	 * @throws when the media server refuses the request outright — an endpoint that is not
	 * configured, or one with no contact to send an INVITE to. The walker reads that as
	 * "not registered", which is the only thing it can honestly mean.
	 */
	originate(request: OriginateRequest): Promise<OriginatedChannel>;

	/** Create an empty mixing bridge. */
	createBridge(request: CreateBridgeRequest): Promise<BridgeHandle>;

	/** Join legs to a bridge. Media starts flowing between them as they arrive. */
	addToBridge(bridgeId: string, channelIds: readonly string[]): Promise<void>;

	/** Separate legs from a bridge WITHOUT hanging them up. */
	removeFromBridge(bridgeId: string, channelIds: readonly string[]): Promise<void>;

	/** Destroy a bridge. Members are ejected, never hung up. Already-gone is a no-op. */
	destroyBridge(bridgeId: string): Promise<void>;

	/** Start writing this leg's audio to the media server's recording store. */
	record(channelId: string, request: RecordRequest): Promise<RecordingHandle>;

	/** Finalise a recording started by {@link record}. Already-finished is a no-op. */
	stopRecording(name: string): Promise<void>;

	/**
	 * Stop capturing audio into a live recording WITHOUT ending its file. PCI.
	 *
	 * A caller reads a card number, the agent pauses, and the recording stays ONE artifact with
	 * silence where the number was. That is the whole reason this is not
	 * {@link stopRecording} followed by {@link record}: a stop ends the object, publishes the
	 * "it is safe to archive" event for half a call, and gives the rest a different object key —
	 * so the CDR row that names the recording names half of it, and the boundary falls exactly
	 * where a compliance reviewer is looking.
	 *
	 * Idempotent in both directions, and pausing a recording that has already finished is a no-op
	 * for the same reason stopping one is: it may have hit its own limit first.
	 *
	 * The intervals themselves ride the driver's own "recording finished" event, because only the
	 * process that wrote the audio knows where in the file the silence landed.
	 *
	 * @throws {import("./media-not-supported.error").MediaOperationNotSupportedError} when the
	 * driver cannot pause a live recording.
	 */
	pauseRecording(name: string, paused: boolean): Promise<void>;

	/** Start music on hold from a configured class. Separate from hold, which is signalling. */
	startMusicOnHold(channelId: string, mohClass?: string): Promise<void>;

	/** Stop music on hold. */
	stopMusicOnHold(channelId: string): Promise<void>;

	// --- P4: the call-control surface ----------------------------------------------------------

	/**
	 * Tell the far end this leg is on hold (SIP re-INVITE, `sendonly`).
	 *
	 * SIGNALLING only, and deliberately separate from {@link startMusicOnHold}: the phone at the
	 * other end needs to know so it can light its hold key, and the person on the leg needs to hear
	 * something. They are different facts about different parties and a call-control runtime uses
	 * them independently — a call held mid-attended-transfer wants the music without the re-INVITE,
	 * because renegotiating twice in three seconds is how phones drop audio.
	 */
	hold(channelId: string): Promise<void>;

	/** Release the signalling hold. */
	unhold(channelId: string): Promise<void>;

	/** Stop audio flowing in one or both directions without touching the bridge. */
	mute(channelId: string, direction: MediaDirection): Promise<void>;

	/** Undo {@link mute}. */
	unmute(channelId: string, direction: MediaDirection): Promise<void>;

	/** Generate DTMF towards the far end. */
	sendDtmf(channelId: string, request: SendDtmfRequest): Promise<void>;

	/**
	 * Create a channel that listens to another one.
	 *
	 * The tap enters the engine's own application, so the caller MUST make the id recognisable
	 * before calling this — see {@link SnoopRequest}.
	 */
	snoop(request: SnoopRequest): Promise<OriginatedChannel>;

	/**
	 * Join a conversation on asymmetric terms — eavesdrop, whisper and barge.
	 *
	 * The tap enters the engine's own application on drivers that materialise it as a channel, so
	 * the caller MUST watch {@link TapRequest.tapChannelId} before calling this. See
	 * {@link TapRequest} for the whole argument about why this is not `snoop`.
	 *
	 * @throws {import("./media-not-supported.error").MediaOperationNotSupportedError} when the
	 * selected media plane cannot route one participant's audio per peer. The caller ANNOUNCES —
	 * a supervisor who dialled `*0` and got silence would assume they were listening.
	 */
	tap(request: TapRequest): Promise<TapHandle>;

	/**
	 * Take a tap down, leaving the monitored conversation running.
	 *
	 * The one invariant worth stating out loud: this must never end the call being monitored. A
	 * supervisor hanging up has to leave the customer talking to the agent, and getting that wrong
	 * would drop live customer calls every time somebody stopped listening.
	 *
	 * Idempotent. Stopping a tap that is already gone is a no-op, because the engine retries this
	 * on teardown and a monitored call that outlived the retry is not a failure.
	 */
	stopTap(tap: TapHandle): Promise<void>;

	/**
	 * Loop this leg's own audio back to it — `*43`, the echo test.
	 *
	 * ## Why it is a port operation and not a composition of the ones above
	 *
	 * There is no arrangement of `play`, `record`, `snoop` and `addToBridge` that echoes a caller to
	 * themselves. A mixing bridge deliberately does NOT feed a member its own audio (that is what
	 * makes conferences usable), a snoop hears the leg but has nowhere to put what it hears, and
	 * record/play is a file round trip measured in seconds. Echo is a primitive of the media plane,
	 * so it belongs on the media plane's interface.
	 *
	 * ## The leg leaves the engine's application, and that is the point
	 *
	 * An echo test has no routing left in it: there is nothing to decide, nothing to bridge, and no
	 * next node. The Asterisk driver therefore hands the channel to `Echo()` in the dialplan and the
	 * caller stays there until they hang up. The walk that called this is OVER — it reports
	 * `bridged`, the walk status that means "the walk is finished and the call is up", exactly as a
	 * parked call does. `watchChannel` keeps the CDR arriving after the channel leaves Stasis.
	 *
	 * @throws {import("./media-not-supported.error").MediaOperationNotSupportedError} when the
	 * selected media plane cannot echo. The caller announces rather than leaving the line silent.
	 */
	echo(channelId: string): Promise<void>;
}
