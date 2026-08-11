import type { CallState, HangupCause } from "@optimiq-voice/telephony";

/**
 * The engine-facing media EVENT contract — the other half of the seam `media-port.ts` opens.
 *
 * ## Why this file exists
 *
 * `MediaPort` made COMMANDS swappable: the engine asks for `answer`, `originate`, `hangup` in
 * domain vocabulary and `ari-media.adapter.ts` is the only file that knows those become HTTP verbs
 * against Asterisk. Events had no such seam. The orchestrator imported `AriEvent` from
 * `@optimiq-voice/media-ari` and branched on Asterisk's own event names — `StasisStart`,
 * `ChannelDestroyed`, `ChannelDtmfReceived` — which meant the swap the plan rests on was only half
 * available. Replacing the media server would have meant either rewriting the orchestrator on live
 * calls, or making `mediad` emit synthetic ARI events forever: embedding Asterisk's vocabulary
 * permanently in the service built to replace it.
 *
 * So this is the event vocabulary the engine owns. `toMediaEvent` in `calls/ari-mapping.ts`
 * translates at the boundary, `AriConnectionService` applies it before the orchestrator is called,
 * and `mediad` will emit these shapes natively.
 *
 * ## What is in the union, and what is not
 *
 * Only what the orchestrator ACTUALLY consumes. Everything Asterisk emits that the engine does not
 * act on — bridge membership, playback progress, dial state, channel creation — has no member here
 * and `toMediaEvent` answers `undefined` for it. That is today's silent `default:` fallthrough in
 * the orchestrator's dispatch, made explicit and moved to the layer that knows what it dropped.
 *
 * Adding a member is therefore a deliberate act with a consumer attached, not a transcription
 * exercise: a union member nobody branches on is a shape two media servers would have to agree on
 * for no reason.
 *
 * ## Every field is already domain-shaped
 *
 * Values are translated on the way in, never re-derived above this seam. A hangup cause arrives as
 * a {@link HangupCause} (with the raw Q.850 integer alongside it, because an unnamed cause maps to
 * `NORMAL_UNSPECIFIED` and the number is then the only evidence of what really happened), a channel
 * state as a {@link CallState}, a recording duration in milliseconds. The day an ARI concept
 * appears in this file is the day the swap stops being free — the same rule `media-port.ts` states
 * for the command direction.
 */

/**
 * The facts about a leg the engine reads when that leg arrives.
 *
 * Deliberately not "the channel": a media server's channel object carries thirty fields and the
 * engine reads six. Passing the whole thing would put every one of them into the contract `mediad`
 * has to satisfy, and the ones nobody reads are exactly the ones that would be wrong.
 *
 * Values are passed through as the media server gave them, NOT normalised. Whether an empty caller
 * number becomes `unknown` (`dialStringOr`) or `undefined` (`emptyToUndefined`) differs by which
 * consumer is asking — the CDR and the wire contract want different answers — so the decision stays
 * with the consumer rather than being made once here and silently applied to both.
 */
export interface MediaChannelSnapshot {
	/** The media server's id for the leg. The key every registry and signal is keyed by. */
	readonly id: string;
	/** The media server's name for the leg (`PJSIP/trunk-00000001`). Lands on the CDR. */
	readonly name?: string;
	readonly callerName?: string;
	readonly callerNumber?: string;
	/** What the caller dialled, as the media server received it. */
	readonly dialedNumber?: string;
	/** The context the call arrived in, which is a routing input when no variable overrides it. */
	readonly context?: string;
	/**
	 * Variables the media server volunteered with the event.
	 *
	 * An OPTIMISATION, never the source of truth: a media server that does not export variables
	 * with its events sends `{}`, and the engine falls back to reading each one over the port.
	 */
	readonly variables: Readonly<Record<string, string>>;
}

/**
 * A leg reached the engine — the entry point for a call, and for every leg the engine originated.
 *
 * Carries the whole snapshot rather than an id because this is the one event where the engine has
 * no prior record of the leg: everything it will ever know about who called whom arrives here.
 */
export interface MediaLegArrivedEvent {
	readonly type: "leg-arrived";
	readonly channel: MediaChannelSnapshot;
}

/**
 * The leg left the engine's control. Teardown has begun and no further verb will run on it.
 *
 * NOT the same as {@link MediaLegEndedEvent}: the leg still exists, and on a media server with a
 * dialplan it may go on doing something else. This is why `watchChannel` exists — without it the
 * subscription would stop here and the leg's end would arrive to nobody.
 */
export interface MediaLegLeftEvent {
	readonly type: "leg-left";
	readonly channelId: string;
}

/**
 * The leg's user-visible state moved.
 *
 * `callState` is the domain state, never the media server's. A state with no user-visible meaning
 * (Asterisk's `Busy`, `OffHook`, or anything a future release invents) produces NO event at all —
 * see `toMediaEvent`, which is where that judgement is made and where it is tested.
 */
export interface MediaCallStateChangedEvent {
	readonly type: "call-state-changed";
	readonly channelId: string;
	readonly callState: CallState;
}

/** One digit the party pressed. `durationMs` is how long the tone lasted. */
export interface MediaDtmfReceivedEvent {
	readonly type: "dtmf-received";
	readonly channelId: string;
	readonly digit: string;
	readonly durationMs: number;
}

/**
 * The far end asked to hang up.
 *
 * Arrives BEFORE {@link MediaLegEndedEvent} and with a more specific cause, which is the whole
 * reason it is a separate member: the engine fixes the cause here, first-wins, so the CDR records
 * why the call ended rather than the generic code the teardown reports afterwards.
 */
export interface MediaHangupRequestedEvent {
	readonly type: "hangup-requested";
	readonly channelId: string;
	readonly cause: HangupCause;
}

/**
 * The leg is gone. The CDR is written from this event.
 *
 * Both the named cause AND the raw wire code, because they are different facts: carriers use
 * Q.850 points the taxonomy does not name, those become `NORMAL_UNSPECIFIED`, and the integer is
 * then the only evidence left of what actually happened. A media server with no Q.850 notion of
 * its own reports the closest code it can defend rather than inventing one.
 */
export interface MediaLegEndedEvent {
	readonly type: "leg-ended";
	readonly channelId: string;
	readonly cause: HangupCause;
	readonly causeCode: number;
}

/**
 * A variable was set on a leg.
 *
 * Channel-scoped only. A media server that also has global variables has nothing to tell the
 * engine with them — the engine's state is per-leg — so `toMediaEvent` drops those.
 */
export interface MediaVariableSetEvent {
	readonly type: "variable-set";
	readonly channelId: string;
	readonly variable: string;
	readonly value: string;
}

/**
 * The phone at this end pressed hold.
 *
 * The party who needs music is the FAR end, so the engine acts on the peer rather than on this
 * leg. `musicClass` is what the far end's phone asked for, when it asked for anything.
 */
export interface MediaLegHeldEvent {
	readonly type: "leg-held";
	readonly channelId: string;
	readonly musicClass?: string;
}

/** Hold was released at this end. */
export interface MediaLegUnheldEvent {
	readonly type: "leg-unheld";
	readonly channelId: string;
}

/** Recording began. Named, not id'd — the name is also how it is stopped. See `RecordRequest`. */
export interface MediaRecordingStartedEvent {
	readonly type: "recording-started";
	readonly recordingName: string;
}

/** Recording finished normally; the file is complete. Milliseconds, as everywhere above the seam. */
export interface MediaRecordingFinishedEvent {
	readonly type: "recording-finished";
	readonly recordingName: string;
	readonly durationMs: number;
}

/** Recording failed. `reason` is whatever the media server could say about why. */
export interface MediaRecordingFailedEvent {
	readonly type: "recording-failed";
	readonly recordingName: string;
	readonly reason: string;
}

/** Every event a media server can tell this engine about. */
export type MediaEvent =
	| MediaLegArrivedEvent
	| MediaLegLeftEvent
	| MediaCallStateChangedEvent
	| MediaDtmfReceivedEvent
	| MediaHangupRequestedEvent
	| MediaLegEndedEvent
	| MediaVariableSetEvent
	| MediaLegHeldEvent
	| MediaLegUnheldEvent
	| MediaRecordingStartedEvent
	| MediaRecordingFinishedEvent
	| MediaRecordingFailedEvent;

/**
 * The event names, as data.
 *
 * For assertions and for the `mediad` wire contract to enumerate against, so that "the engine
 * consumes twelve events" is a fact a test can check rather than a claim in a comment.
 */
export const MEDIA_EVENT_TYPES = [
	"leg-arrived",
	"leg-left",
	"call-state-changed",
	"dtmf-received",
	"hangup-requested",
	"leg-ended",
	"variable-set",
	"leg-held",
	"leg-unheld",
	"recording-started",
	"recording-finished",
	"recording-failed",
] as const satisfies readonly MediaEvent["type"][];

export type MediaEventType = (typeof MEDIA_EVENT_TYPES)[number];

/** Narrows the union by event name. */
export type MediaEventOf<TType extends MediaEventType> = Extract<MediaEvent, { type: TType }>;
