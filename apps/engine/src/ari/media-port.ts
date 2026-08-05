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
 * It is also what makes the orchestrator testable: a fake implementing these eight methods is a
 * complete media server as far as the engine's logic is concerned.
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
 * Everything the engine asks a media server to do, in the P2 slice.
 *
 * Deliberately small. Verbs that are not yet implemented (dial, bridge, transfer, park, record)
 * are absent rather than present-and-throwing: an interface that lies about its capabilities is
 * worse than one that is honestly incomplete, and the verb registry already reports an
 * unimplemented verb as a typed failure.
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
}
