import { z } from "zod";
import { subjectFor, type MediaSessionEvent } from "../subjects";
import { defineEvent, makeEvent, type EventInput } from "./envelope";

/**
 * Media-plane session events — `media.evt.v1.<orgId>.<sessionId>.<event>`.
 *
 * Published by `apps/mediad` (Go); consumed by `apps/engine`, which turns them into members of its
 * own media-server-agnostic event union. This is the TELL half of the media contract; the ASK half
 * is `rpc.media.v1.*` in `rpc.ts`.
 *
 * ## Why these are JetStream and the commands are not
 *
 * "Ask over core, tell over JetStream", the split the whole backbone uses. A command
 * (`allocate-session`) is a synchronous question inside a call setup whose answer is worthless a
 * second later. A session ending is a fact about a call that outlives the moment it happened: it is
 * the reason a leg was torn down, so it is what a support ticket, a quality report and eventually
 * the CDR's media columns are reconstructed from. Publishing it fire-and-forget would mean the
 * evidence for "why did that call drop" is the one thing a broker restart deletes.
 *
 * `apps/mediad` publishes with the envelope id as `Nats-Msg-Id`, exactly as
 * `apps/sipd/internal/events` does, so a publish retried after a timeout is collapsed by the MEDIA
 * stream's duplicate window rather than counted twice.
 *
 * The engine still reads them with a CORE subscription. A JetStream publish is a publish: a core
 * subscriber on the same subject sees it live, while the stream keeps it for whoever needs it
 * later. The engine wants the former (a leg to tear down NOW) and must not pay for a durable
 * consumer's ack round trip on the call path to get it.
 *
 * ## `sessionId`, not `channelId`
 *
 * `mediad` has no notion of a channel. It owns RTP sessions, the engine owns legs, and the mapping
 * between them is the engine's — which is exactly why the seam holds when Asterisk is swapped out:
 * a media server that talked about channels would be a media server that had opinions about call
 * control.
 */

/** How long a session existed, and what it carried. Present on every lifecycle event. */
const sessionCountersShape = {
	/** The RTP port the session held. The RTCP port is always this + 1 (RFC 3550 §11). */
	rtpPort: z.int().min(1).max(65_534),
	packetsReceived: z.int().min(0),
	packetsSent: z.int().min(0),
};

const sessionIdentityShape = {
	/**
	 * The engine-assigned session id. Always equal to the subject's session token — carried in the
	 * payload too so a replayed file is self-describing.
	 */
	sessionId: z.string().min(1).max(128),
	/**
	 * The `mediad` process that held the session.
	 *
	 * Load-bearing rather than decorative: a session lives on exactly ONE instance, and this is what
	 * lets a reader (or an operator staring at a log) tell "instance B refused a command for a
	 * session on instance A" from "the session is gone". It is the same value the `media-sessions`
	 * KV directory is keyed to.
	 */
	instanceId: z.string().min(1).max(128),
	/** The call the leg belonged to, when the allocate carried one. */
	callId: z.string().min(1).max(128).optional(),
	/** The engine's leg id, when the allocate carried one. */
	legId: z.string().min(1).max(128).optional(),
};

/**
 * Why a media session stopped existing.
 *
 * A closed vocabulary because a consumer branches on it, and the branch that matters is
 * `released` (the engine asked, so the call ended normally) against everything else (the media
 * plane decided, so something went wrong and the engine's picture of the call is now stale).
 */
export const MEDIA_SESSION_END_REASONS = [
	/** The engine issued `rpc.media.v1.release-session`. The normal end of a leg. */
	"released",
	/** No RTP arrived for the configured window. Preceded by a `session.rtp-timeout`. */
	"rtp-timeout",
	/** The idle reaper collected a session the engine stopped releasing. A port-leak backstop. */
	"idle-reaped",
	/** The instance shut down while the session was live. Audio on that call stopped. */
	"drained",
	/** The read loop failed. `detail` is whatever could be said about it. */
	"error",
] as const;

export const mediaSessionEndReasonSchema = z.enum(MEDIA_SESSION_END_REASONS);
export type MediaSessionEndReason = (typeof MEDIA_SESSION_END_REASONS)[number];

/**
 * `session.ended` — the RTP session is gone and its port is back in the pool.
 *
 * The engine treats a non-`released` reason as a media failure on a leg it still believes is up,
 * which is what turns "the call was connected and we could not hear each other" into an event
 * somebody can act on rather than a support ticket nobody can reproduce.
 */
export const mediaSessionEndedDataSchema = z.object({
	...sessionIdentityShape,
	...sessionCountersShape,
	reason: mediaSessionEndReasonSchema,
	/** How long the session existed. Milliseconds, as everywhere on this backbone. */
	durationMs: z.int().min(0),
	/** Free text for the `error` reason, and for anything an operator would want in a log line. */
	detail: z.string().max(512).optional(),
});

/**
 * `session.rtp-timeout` — audio stopped while the session was still allocated.
 *
 * Separate from `session.ended` even though one immediately follows the other, because they answer
 * different questions: this one says the far end went silent (a NAT binding that expired, a network
 * that dropped, an endpoint that crashed without a BYE), and the `ended` that follows says the
 * resources were reclaimed. Folding them together would mean a consumer counting media failures had
 * to reason about a reason code on an event whose subject says "ended".
 */
export const mediaSessionRtpTimeoutDataSchema = z.object({
	...sessionIdentityShape,
	...sessionCountersShape,
	/** How long the session had gone without a packet when the timeout fired. */
	silentForMs: z.int().min(0),
	/**
	 * The far end the session had latched onto, `ip:port`, when it had latched at all.
	 *
	 * Absent means the session never received a single packet — a different failure (the far end
	 * never sent, so the SDP answer probably advertised an address it could not reach) from one that
	 * had audio and lost it.
	 */
	remoteAddress: z.string().max(64).optional(),
});

/**
 * Why a playback stopped.
 *
 * Three outcomes, and the reason a consumer cares which is that only one of them is a defect:
 * `completed` and `stopped` are both the system working (a prompt that ran out, and a caller who
 * barged in), while `error` is a leg that was told a prompt would play and heard silence.
 */
export const MEDIA_PLAYBACK_END_REASONS = [
	/** The last frame was sent. The caller heard the whole prompt. */
	"completed",
	/**
	 * `rpc.media.v1.stop-playback`, or the session ending underneath it.
	 *
	 * The COMMON case and not an exceptional one: every `gather` stops its own prompt the moment
	 * collection ends, so a healthy IVR produces one of these per menu.
	 */
	"stopped",
	/** The frame source failed mid-playback. `detail` is whatever could be said about it. */
	"error",
] as const;

export const mediaPlaybackEndReasonSchema = z.enum(MEDIA_PLAYBACK_END_REASONS);
export type MediaPlaybackEndReason = (typeof MEDIA_PLAYBACK_END_REASONS)[number];

/**
 * `playback.finished` — a prompt stopped, and why.
 *
 * ## The engine does not branch on this, and it is published anyway
 *
 * `MediaPort.play` returns as soon as audio has STARTED, and the orchestrator consumes a twelve
 * member `MediaEvent` union with no playback member in it: on the ARI path `PlaybackFinished` is
 * one of the events `toMediaEvent` deliberately drops, because nothing above the seam waits for a
 * prompt to end. `mediad`'s mapping mirrors that exactly — `toMediaEventFromMediad` answers
 * `undefined` — so adding this event changes no engine behaviour and adds no union member. That is
 * the point: a union member nobody branches on is a shape two media servers would have to agree on
 * for no reason.
 *
 * What it is for is the same thing `session.rtp-timeout` is for. A playback that ends `error` is a
 * caller sitting in silence where a menu should be, on a call that is otherwise perfectly healthy,
 * and it is invisible to every other signal the platform has: the command already answered `ok`,
 * the session is still up, and no CDR field records it. Publishing it durably is what turns "the
 * caller says nothing played" from an unreproducible ticket into a lookup by session id.
 *
 * It is also the only place `playedMs` exists. The engine's `PlaybackResult.elapsedMs` measures how
 * long the COMMAND took, not how much audio the far end actually received, and on a barge-in those
 * two numbers are not close.
 */
export const mediaPlaybackFinishedDataSchema = z.object({
	...sessionIdentityShape,
	/** The reference the engine assigned in `rpc.media.v1.start-playback`. */
	playbackRef: z.string().min(1).max(128),
	reason: mediaPlaybackEndReasonSchema,
	/** How much audio actually reached the far end, in milliseconds. See the note above. */
	playedMs: z.int().min(0),
	/** Free text for the `error` reason, and for anything an operator would want in a log line. */
	detail: z.string().max(512).optional(),
});

/**
 * Why a recording stopped.
 *
 * Wider than the playback vocabulary because a recording can end for reasons the engine did not
 * ask for and still be a perfectly good file — a voicemail that ran out of silence is the NORMAL
 * end of a voicemail, not a failure — and the consumer has to be able to tell those from the one
 * outcome that means there is no usable audio.
 */
export const MEDIA_RECORDING_END_REASONS = [
	/** `rpc.media.v1.stop-recording`. The engine asked, and the file is complete up to that point. */
	"stopped",
	/** `maxDurationMs` elapsed. A complete file of exactly that length. */
	"max-duration",
	/**
	 * `maxSilenceMs` of continuous quiet. The normal end of a voicemail: the caller stopped talking.
	 *
	 * The trailing silence is IN the file — trimming it would mean the duration on this event and
	 * the duration of the audio disagreed, and a consumer cannot tell which one a player will show.
	 */
	"max-silence",
	/**
	 * The session went away underneath it — released, reaped, timed out or drained.
	 *
	 * Still a complete file: the recorder finalises on the way down, so a caller who hangs up
	 * mid-message leaves a playable message rather than a partial nobody can open.
	 */
	"session-ended",
	/** The file could not be written or finalised. There is NO usable recording. `detail` says why. */
	"error",
] as const;

export const mediaRecordingEndReasonSchema = z.enum(MEDIA_RECORDING_END_REASONS);
export type MediaRecordingEndReason = (typeof MEDIA_RECORDING_END_REASONS)[number];

/**
 * `recording.finished` — the file is closed, named, and safe to read.
 *
 * ## The one media event the engine really does act on
 *
 * `session.rtp-timeout` and `playback.finished` map to nothing above the seam, and this one does
 * not: `plan-walker`'s voicemail node and `call-control`'s on-demand recording both BLOCK on "the
 * recording finished" before they publish `channel.record.stopped`, and `apps/api`'s archiver
 * copies the object the moment that lands. So the ordering here is a contract rather than an
 * implementation detail — this event is published after the WAV header has been patched with the
 * real lengths, the bytes fsynced, and the file renamed from its `.partial` name into the object
 * key below. Anything published earlier would archive a file that is still being written, which is
 * a truncated recording discovered weeks later by the person who needed it.
 *
 * ## Why `bytes` is on it
 *
 * Because nothing else counts them. The engine's `channel.record.stopped` carries an optional
 * `bytes` it has never been able to fill — it does not hold the file — so `recordings.size_bytes`
 * is written as zero on every row today. The process that wrote the audio is the only one that can
 * say how much there was, and a recording whose duration is 30 s and whose size is 400 bytes is a
 * failure the duration alone hides completely.
 */
export const mediaRecordingFinishedDataSchema = z.object({
	...sessionIdentityShape,
	/** The reference the engine assigned in `rpc.media.v1.start-recording`. */
	recordingRef: z.string().min(1).max(128),
	reason: mediaRecordingEndReasonSchema,
	/** How much audio the file holds. Milliseconds, as everywhere on this backbone. */
	durationMs: z.int().min(0),
	/** The size of the finished file, header included. Zero when `reason` is `error`. */
	bytes: z.int().min(0),
	/**
	 * The object key the audio landed under, relative to the recordings root:
	 * `<orgId>/<callId>/<recordingRef>.wav`.
	 *
	 * Relative rather than absolute because the same directory is mounted at a different path in
	 * every container that touches it, and an absolute path would be true only for the media plane.
	 * This is the value that joins to `recordings.object_key` in `cdr-db`.
	 */
	objectKey: z.string().min(1).max(1_024),
	/** Which side of the session was captured. */
	direction: z.enum(["receive", "both"]),
	/** Free text for the `error` reason, and for anything an operator would want in a log line. */
	detail: z.string().max(512).optional(),
});

/**
 * `dtmf.received` — a party pressed a key, and the media plane decoded it.
 *
 * ## Exactly one of these per keypress, and that is the whole difficulty
 *
 * RFC 4733 sends ONE digit as MANY packets: an update every 20 ms while the tone lasts, then a
 * final packet carrying the END bit which §2.5.1.4 requires the sender to transmit three times back
 * to back. A naive detector that published per packet would turn a 100 ms keypress into eight
 * `dtmf.received` events, and an IVR collecting a four-digit PIN would fill on the first one. So the
 * de-duplication is `apps/mediad`'s and this event is the DIGIT, not the packet — `mediad` surfaces
 * it once, at the END bit, and drops the two retransmissions that follow.
 *
 * ## Why there is no `dtmf.started`
 *
 * The marker bit on the first packet of a digit is a real signal and nothing above this seam could
 * use it. `MediaPort` has no "a tone began" operation, the ARI path publishes only
 * `ChannelDtmfReceived` (which Asterisk also raises at the END of the tone), and a consumer handed
 * both would have to decide which one a `gather` should count. One event per digit is what the
 * driver being replaced does, and matching it is what lets the confirmation IVR and the feature-code
 * collector run unchanged on either plane.
 *
 * ## Detection is a TAP, not a consumption
 *
 * A digit that arrives on a bridged session is still RELAYED to the peer byte for byte — that is
 * rung 2's DTMF-is-free property and it must survive rung 3's receive half, because the far end of
 * an attended transfer is entitled to hear the keypress the caller made. The event fires regardless
 * of whether the session is bridged, exactly as ARI's `ChannelDtmfReceived` fires on a channel
 * whether or not it is in a bridge.
 */
export const mediaDtmfReceivedDataSchema = z.object({
	...sessionIdentityShape,
	/**
	 * The key, as one character: `0`-`9`, `*`, `#`, or `A`-`D`.
	 *
	 * A STRING rather than an RFC 4733 event code, because that is the vocabulary every consumer
	 * already speaks: `MediaPort.sendDtmf` takes characters, `plan-walker`'s `gather` matches
	 * characters, and the ARI path delivers characters. Handing the engine an integer would make the
	 * two drivers disagree about a value that is compared against dialplan digits.
	 */
	digit: z.string().regex(/^[0-9A-D*#]$/),
	/**
	 * How long the tone lasted, in milliseconds, as the SENDER measured it.
	 *
	 * Derived from the telephone-event duration field — the digit's own RTP clock — and never from
	 * the receiver's wall clock, which would fold this network's jitter into a number describing
	 * somebody's finger. It is the same field `ChannelDtmfReceived.duration_ms` carries, so a
	 * consumer that thresholds on it behaves the same on both planes.
	 */
	durationMs: z.int().min(0),
});

export const MEDIA_EVENT_DEFINITIONS = {
	"session.ended": defineEvent("media", "session.ended", mediaSessionEndedDataSchema),
	"session.rtp-timeout": defineEvent(
		"media",
		"session.rtp-timeout",
		mediaSessionRtpTimeoutDataSchema,
	),
	"playback.finished": defineEvent("media", "playback.finished", mediaPlaybackFinishedDataSchema),
	"recording.finished": defineEvent(
		"media",
		"recording.finished",
		mediaRecordingFinishedDataSchema,
	),
	"dtmf.received": defineEvent("media", "dtmf.received", mediaDtmfReceivedDataSchema),
} as const;

export type MediaEventDefinitions = typeof MEDIA_EVENT_DEFINITIONS;

export type MediaEventOf<TType extends MediaSessionEvent> = z.infer<
	MediaEventDefinitions[TType]["envelope"]
>;

export type MediaEventDataOf<TType extends MediaSessionEvent> = z.infer<
	MediaEventDefinitions[TType]["data"]
>;

/** Every media-session event as one discriminated union. */
export const mediaEventSchema = z.discriminatedUnion("type", [
	MEDIA_EVENT_DEFINITIONS["session.ended"].envelope,
	MEDIA_EVENT_DEFINITIONS["session.rtp-timeout"].envelope,
	MEDIA_EVENT_DEFINITIONS["playback.finished"].envelope,
	MEDIA_EVENT_DEFINITIONS["recording.finished"].envelope,
	MEDIA_EVENT_DEFINITIONS["dtmf.received"].envelope,
]);

export type MediaEventEnvelope = z.infer<typeof mediaEventSchema>;

export type MediaSessionEndedData = z.infer<typeof mediaSessionEndedDataSchema>;
export type MediaSessionRtpTimeoutData = z.infer<typeof mediaSessionRtpTimeoutDataSchema>;
export type MediaPlaybackFinishedData = z.infer<typeof mediaPlaybackFinishedDataSchema>;
export type MediaRecordingFinishedData = z.infer<typeof mediaRecordingFinishedDataSchema>;
export type MediaDtmfReceivedData = z.infer<typeof mediaDtmfReceivedDataSchema>;

/**
 * Input for {@link makeMediaEvent}. The subject is derived from `orgId` and `data.sessionId`, so a
 * caller cannot publish a payload whose session disagrees with the subject it arrived on.
 */
export type MediaEventInput<TType extends MediaSessionEvent> = Omit<
	EventInput<MediaEventDataOf<TType>>,
	"subject"
>;

/** Builds and validates a media-session event, deriving its subject. */
export function makeMediaEvent<TType extends MediaSessionEvent>(
	type: TType,
	input: MediaEventInput<TType>,
): MediaEventOf<TType> {
	const definition = MEDIA_EVENT_DEFINITIONS[type];
	const subject = subjectFor.media(input.orgId, input.data.sessionId, type);
	// See the note in `makeCallEvent`: the definition index and the payload are correlated by
	// `type`, which TypeScript cannot express across a lookup, so the cast is at the one call site
	// that knows they agree.
	return makeEvent(definition, { ...input, subject } as never) as MediaEventOf<TType>;
}
