import type { HangupCause } from "@optimiq-voice/telephony";

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
}

export interface OriginatedChannel {
	readonly channelId: string;
	readonly name?: string;
}

/**
 * A bridge, as the engine names it.
 *
 * `mixing` is the only mode the walker asks for today. A two-party call could use the cheaper
 * `proxy_media`, but a mixing bridge is the one that can be recorded and the one DTMF survives,
 * and both of those are the next wave rather than a hypothetical.
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

/**
 * Everything the engine asks a media server to do.
 *
 * Still deliberately small: transfer, park, snoop and hold/unhold are absent rather than
 * present-and-throwing, because an interface that lies about its capabilities is worse than one
 * that is honestly incomplete — the verb executor already reports an unimplemented verb as a typed
 * failure.
 */
export interface MediaPort {
	/** SIP 200 OK. Starts billing. */
	answer(channelId: string): Promise<void>;

	/** SIP 180. Alerting, no media. */
	ring(channelId: string): Promise<void>;

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

	/** Start music on hold from a configured class. Separate from hold, which is signalling. */
	startMusicOnHold(channelId: string, mohClass?: string): Promise<void>;

	/** Stop music on hold. */
	stopMusicOnHold(channelId: string): Promise<void>;
}
