/**
 * Session-protocol verbs — the commands an application sends down the call-control stream.
 *
 * Frozen sources of truth: `plans/reference/freeswitch-capabilities.md` §1 (answer semantics),
 * §2 (originate/dial), §3 (transfer/hold/park), §4 (DTMF collection), §5 (recording) and §8 (the
 * ESL outbound model this protocol replaces); `plans/optimiq-voice-master-plan.md` §4.2 for the
 * canonical verb list.
 *
 * One protocol, three consumers: the PBX feature runtimes, Autopilot, and customer voice apps
 * (the deleted voice package, whose verb names are preserved where they still make sense). The
 * union is discriminated on `verb`, so a handler is an exhaustive switch and adding a verb is a
 * compile error everywhere it must be handled.
 *
 * Durations are milliseconds with an explicit `Ms` suffix — the legacy voice surface
 * used bare seconds in some places and milliseconds in others, and that ambiguity is not carried
 * forward.
 */

import type { LegRole } from "./bridge";
import type { VariableScope } from "./channel";
import type { DtmfCollection, DtmfDigit } from "./dtmf";
import type { HangupCause } from "./hangup-causes";

/**
 * A reference to playable audio. A URI whose scheme selects the source, per §9 "Formats":
 * `file://` / `https://` (fetched + cached), `tone://` (synthesised ringback and tones),
 * `stream://` (a shared always-running source — this is how MOH is served, never as a per-call
 * file read), `tts://` (rendered speech), `prompt://` (an entry in the tenant prompt library).
 */
export type MediaRef = string;

/** The name of every verb, in the order they appear in the union below. */
export const VERB_NAMES = [
	"answer",
	"ringing",
	"earlyMedia",
	"play",
	"stopPlay",
	"playbackControl",
	"say",
	"stopSay",
	"gather",
	"record",
	"dial",
	"bridge",
	"unbridge",
	"transfer",
	"hold",
	"unhold",
	"park",
	"unpark",
	"playDtmf",
	"mute",
	"unmute",
	"stream",
	"stopStream",
	"streamGather",
	"stopStreamGather",
	"setVariable",
	"sleep",
	"hangup",
] as const;

export type VerbName = (typeof VERB_NAMES)[number];

/**
 * SIP responses the three progress verbs map to (§1 "Answer semantics").
 *
 * `ringing` is 180 with no media; `earlyMedia` is 183 with SDP, which opens an audio path BEFORE
 * answer and therefore before billing; `answer` is 200 OK and starts the billing clock. Sending
 * media-bearing verbs on a leg that has done neither is the single most common protocol error.
 */
export const PROGRESS_SIP_CODES = {
	ringing: 180,
	earlyMedia: 183,
	answer: 200,
} as const satisfies Record<"ringing" | "earlyMedia" | "answer", number>;

/** What a {@link GatherVerb} listens to. */
export const GATHER_SOURCES = ["dtmf", "speech", "dtmf-and-speech"] as const;

export type GatherSource = (typeof GATHER_SOURCES)[number];

/** How a {@link DialVerb} works its target list (§2 "Multi-target"). */
export const DIAL_STRATEGIES = ["simultaneous", "sequential"] as const;

export type DialStrategy = (typeof DIAL_STRATEGIES)[number];

/** What a dial target resolves to; decides which originator the engine uses. */
export const DIAL_TARGET_KINDS = ["extension", "user", "trunk", "external", "application"] as const;

export type DialTargetKind = (typeof DIAL_TARGET_KINDS)[number];

/** Blind hands the call off and walks away; attended keeps a consultation leg first (§3). */
export const TRANSFER_KINDS = ["blind", "attended"] as const;

export type TransferKind = (typeof TRANSFER_KINDS)[number];

/** Which direction of the media path a mute applies to. */
export const MUTE_DIRECTIONS = ["in", "out", "both"] as const;

export type MuteDirection = (typeof MUTE_DIRECTIONS)[number];

/** In-flight playback controls (§9 dptools). */
export const PLAYBACK_ACTIONS = ["pause", "resume", "restart", "forward", "rewind"] as const;

export type PlaybackAction = (typeof PLAYBACK_ACTIONS)[number];

/** Container the engine writes recordings in before upload. */
export const RECORD_FORMATS = ["wav", "mp3", "ogg"] as const;

export type RecordFormat = (typeof RECORD_FORMATS)[number];

/**
 * Answer confirmation for a dial target (§2 `group_confirm_key` / `group_confirm_file`).
 *
 * The target must press `key` after hearing `media` before the leg is treated as answered. This
 * is what stops a mobile voicemail box from winning a ring-all race.
 */
export type DialConfirm = {
	readonly media: MediaRef;
	readonly key: DtmfDigit;
	readonly timeoutMs: number;
};

/** One leg a {@link DialVerb} may originate. */
export type DialTarget = {
	readonly kind: DialTargetKind;
	/** Extension number, user address, E.164 number or application name, per `kind`. */
	readonly destination: string;
	/** Trunk/gateway to route through. Meaningful for `external` and `trunk` targets. */
	readonly trunkRef?: string;
	/** Overrides the dial-level caller id for this target only (§2 `[vars]` per-leg scope). */
	readonly callerId?: CallerIdOverride;
	/** Per-target ring time; falls back to the dial-level `timeoutMs`. */
	readonly timeoutMs?: number;
	/** Overrides the dial-level confirmation for this target only. */
	readonly confirm?: DialConfirm;
	/** Variables exported onto this leg only (§2 `[vars]`). */
	readonly variables?: Readonly<Record<string, string>>;
};

/** Caller identity presented on originated legs (§2 `origination_caller_id_*`). */
export type CallerIdOverride = {
	readonly name?: string;
	readonly number?: string;
};

/** Where a transfer sends the leg (§3). */
export type TransferDestination = {
	/** The number/extension to route on in the target context. */
	readonly destination: string;
	/** Routing namespace to re-enter. Defaults to the leg's current context. */
	readonly context?: string;
};

/** Answer the call (SIP 200 OK). Starts billing; required before any billable media verb. */
export type AnswerVerb = { readonly verb: "answer" };

/** Signal alerting without media (SIP 180). */
export type RingingVerb = { readonly verb: "ringing" };

/**
 * Open an early-media path (SIP 183 + SDP). Audio flows before answer and is NOT billable — this
 * is how pre-answer announcements, ringback substitution and "number not in service" messages work
 * without charging the caller.
 */
export type EarlyMediaVerb = { readonly verb: "earlyMedia" };

/** Play audio. `loop` of 0 means play until stopped; omitted means play once. */
export type PlayVerb = {
	readonly verb: "play";
	readonly media: MediaRef;
	readonly loop?: number;
	/** Handle for {@link PlaybackControlVerb} and {@link StopPlayVerb}. */
	readonly playbackRef?: string;
	/** Digits that abort playback (barge-in). */
	readonly terminators?: readonly DtmfDigit[];
};

/** Stop a playback started by {@link PlayVerb}; omitting `playbackRef` stops all of them. */
export type StopPlayVerb = {
	readonly verb: "stopPlay";
	readonly playbackRef?: string;
};

/** Control an in-flight playback. */
export type PlaybackControlVerb = {
	readonly verb: "playbackControl";
	readonly action: PlaybackAction;
	readonly playbackRef?: string;
};

/** Render text to speech and play it. */
export type SayVerb = {
	readonly verb: "say";
	readonly text: string;
	/** Voice from the tenant's TTS configuration; the org default is used when omitted. */
	readonly voiceRef?: string;
	readonly playbackRef?: string;
	readonly terminators?: readonly DtmfDigit[];
};

/** Stop an in-flight {@link SayVerb}. */
export type StopSayVerb = {
	readonly verb: "stopSay";
	readonly playbackRef?: string;
};

/**
 * Collect DTMF (and optionally speech) (§4).
 *
 * `timeoutMs` bounds the wait for the FIRST input; `interDigitTimeoutMs` bounds the gap between
 * subsequent digits. Both are required because defaulting either one is how IVRs end up hanging on
 * a silent caller. `regex` ends collection early on a match, which is what makes variable-length
 * input (an extension of 3 or 4 digits) expressible without a terminator key.
 */
export type GatherVerb = {
	readonly verb: "gather";
	readonly maxDigits: number;
	/** Keys that end collection. Excluded from the collected digits. */
	readonly terminators: readonly DtmfDigit[];
	readonly timeoutMs: number;
	readonly interDigitTimeoutMs: number;
	readonly regex?: string;
	readonly source?: GatherSource;
	/** Prompt played while collecting; barge-in stops it on the first digit. */
	readonly media?: MediaRef;
};

/**
 * Record the leg (§5).
 *
 * `stereo` puts each leg of a bridge on its own channel, which is what makes post-call
 * transcription able to attribute speech to a party.
 */
export type RecordVerb = {
	readonly verb: "record";
	readonly maxDurationMs?: number;
	/** Stop after this much continuous silence. */
	readonly silenceStopMs?: number;
	readonly stereo?: boolean;
	readonly format?: RecordFormat;
	readonly beep?: boolean;
	readonly terminators?: readonly DtmfDigit[];
};

/**
 * Originate one or more legs and bridge the first that answers (§2).
 *
 * `simultaneous` rings every target at once and hangs the losers up with `LOSE_RACE`;
 * `sequential` walks the list, moving on when a leg fails with a cause in `continueOnCauses`.
 * An empty or absent `continueOnCauses` means "stop at the first failure" — never "retry
 * everything", because retrying a `CALL_REJECTED` is how toll-fraud loops start.
 */
export type DialVerb = {
	readonly verb: "dial";
	readonly targets: readonly DialTarget[];
	readonly strategy: DialStrategy;
	/** Overall ring time for the dial. Per-target overrides win. */
	readonly timeoutMs: number;
	readonly callerId?: CallerIdOverride;
	readonly confirm?: DialConfirm;
	/** Failure causes that allow the dial to continue to the next target/route. */
	readonly continueOnCauses?: readonly HangupCause[];
	/** Stop waiting once progress (183) is seen, rather than at `timeoutMs`. */
	readonly progressTimeoutMs?: number;
	/** Treat early media from a target as an answer. */
	readonly bridgeEarlyMedia?: boolean;
	/** Ignore 183 from targets entirely, waiting for a real answer. */
	readonly ignoreEarlyMedia?: boolean;
	/** Hang the A-leg up when the bridge ends, instead of returning control to the app. */
	readonly hangupAfterBridge?: boolean;
	/** Variables exported onto every originated leg (§2 `{vars}`). */
	readonly variables?: Readonly<Record<string, string>>;
};

/** Join this leg to an existing one (the `uuid_bridge` equivalent, §3). */
export type BridgeVerb = {
	readonly verb: "bridge";
	/** The channel to join to. */
	readonly legId: string;
	/** Which side the target leg takes; defaults to `b`. */
	readonly role?: LegRole;
};

/** Separate this leg from its bridge without hanging either side up. */
export type UnbridgeVerb = { readonly verb: "unbridge" };

/**
 * Transfer the call (§3).
 *
 * `blind` resets the leg into the target context and returns nothing — the application's control
 * of this leg ends. `attended` holds the current party, originates a consultation leg, and
 * completes on the transferor's hangup. Legs hung up by a completed transfer carry
 * `BLIND_TRANSFER` (800) / `ATTENDED_TRANSFER` (801), which is what keeps a transfer out of the
 * "failed call" reports.
 */
export type TransferVerb = {
	readonly verb: "transfer";
	readonly kind: TransferKind;
	readonly destination: TransferDestination;
	/** Which leg to transfer; defaults to the leg the verb was sent on. */
	readonly leg?: LegRole;
	/** Where to send the leg if the transfer fails (`transfer_fallback_extension`). */
	readonly fallbackDestination?: TransferDestination;
	/** Attended only: digits that abort the consultation and return to the original party. */
	readonly cancelKey?: DtmfDigit;
};

/** Put the leg on hold and serve MOH from a shared stream, never a per-call file read (§3). */
export type HoldVerb = {
	readonly verb: "hold";
	readonly musicOnHold?: MediaRef;
	/** Soft hold keeps the media path up (used mid-attended-transfer) instead of a full re-INVITE. */
	readonly soft?: boolean;
};

/** Release hold. Publishes the transient `unheld` call state before settling back to `active`. */
export type UnholdVerb = { readonly verb: "unhold" };

/** Park the leg (§3). Omitting `orbit` auto-assigns a slot in `lot`. */
export type ParkVerb = {
	readonly verb: "park";
	readonly lot?: string;
	readonly orbit?: string;
	/** Return the call to the parker when it elapses. */
	readonly timeoutMs?: number;
	readonly musicOnHold?: MediaRef;
};

/** Retrieve a parked call onto this leg. */
export type UnparkVerb = {
	readonly verb: "unpark";
	readonly lot?: string;
	readonly orbit?: string;
};

/** Generate DTMF towards the far end. */
export type PlayDtmfVerb = {
	readonly verb: "playDtmf";
	readonly digits: readonly DtmfDigit[];
	readonly toneDurationMs?: number;
};

/** Mute the leg in one or both directions. */
export type MuteVerb = {
	readonly verb: "mute";
	readonly direction: MuteDirection;
};

/** Undo a {@link MuteVerb}. */
export type UnmuteVerb = {
	readonly verb: "unmute";
	readonly direction: MuteDirection;
};

/** Start streaming raw audio to/from the application (the AudioSocket seam). */
export type StreamVerb = {
	readonly verb: "stream";
	readonly direction: MuteDirection;
	readonly streamRef?: string;
};

/** Stop a stream started by {@link StreamVerb}. */
export type StopStreamVerb = {
	readonly verb: "stopStream";
	readonly streamRef?: string;
};

/** Stream audio for continuous recognition, emitting partial results as they arrive. */
export type StreamGatherVerb = {
	readonly verb: "streamGather";
	readonly source?: GatherSource;
	readonly streamRef?: string;
};

/** Stop a {@link StreamGatherVerb}. */
export type StopStreamGatherVerb = {
	readonly verb: "stopStreamGather";
	readonly streamRef?: string;
};

/**
 * Set a variable (§7 variable scopes).
 *
 * `export` scope copies the value onto every leg this channel originates — the routing compiler
 * allow-lists what may be exported so tenant data cannot ride onto a foreign leg.
 */
export type SetVariableVerb = {
	readonly verb: "setVariable";
	readonly name: string;
	readonly value: string;
	/** Defaults to `channel`. */
	readonly scope?: VariableScope;
};

/** Do nothing for a while, keeping the media path up. */
export type SleepVerb = {
	readonly verb: "sleep";
	readonly durationMs: number;
};

/** Tear the leg down. The cause is what routing, failover and CDR disposition all read. */
export type HangupVerb = {
	readonly verb: "hangup";
	/** Defaults to `NORMAL_CLEARING`. */
	readonly cause?: HangupCause;
};

/** Every command an application can send on the session stream. */
export type Verb =
	| AnswerVerb
	| RingingVerb
	| EarlyMediaVerb
	| PlayVerb
	| StopPlayVerb
	| PlaybackControlVerb
	| SayVerb
	| StopSayVerb
	| GatherVerb
	| RecordVerb
	| DialVerb
	| BridgeVerb
	| UnbridgeVerb
	| TransferVerb
	| HoldVerb
	| UnholdVerb
	| ParkVerb
	| UnparkVerb
	| PlayDtmfVerb
	| MuteVerb
	| UnmuteVerb
	| StreamVerb
	| StopStreamVerb
	| StreamGatherVerb
	| StopStreamGatherVerb
	| SetVariableVerb
	| SleepVerb
	| HangupVerb;

/** Narrows the union by verb name, so handlers can be typed per verb. */
export type VerbOf<N extends VerbName> = Extract<Verb, { verb: N }>;

/** Why a verb stopped running. Every verb result carries one. */
export const VERB_END_REASONS = [
	"completed",
	"terminator",
	"timeout",
	"cancelled",
	"hangup",
	"failed",
] as const;

export type VerbEndReason = (typeof VERB_END_REASONS)[number];

/** Outcome of a {@link GatherVerb}. */
export type GatherResult = {
	readonly verb: "gather";
	readonly endReason: VerbEndReason;
	readonly collection: DtmfCollection;
	readonly speech?: string;
	readonly elapsedMs: number;
};

/** Outcome of a {@link RecordVerb}. `mediaRef` addresses the stored object, not a local path. */
export type RecordResult = {
	readonly verb: "record";
	readonly endReason: VerbEndReason;
	readonly recordingId: string;
	readonly mediaRef: MediaRef;
	readonly durationMs: number;
	readonly format: RecordFormat;
};

/** Outcome of a {@link DialVerb}. */
export type DialResult = {
	readonly verb: "dial";
	readonly endReason: VerbEndReason;
	/** The channel that answered, when one did. */
	readonly answeredChannelId?: string;
	/** Which target index answered, when one did. */
	readonly answeredTargetIndex?: number;
	/** Cause of the last failed attempt; losers of a ring-all race carry `LOSE_RACE`. */
	readonly cause?: HangupCause;
	readonly bridgeId?: string;
	readonly elapsedMs: number;
};

/** Outcome of a playback verb (`play` / `say`). */
export type PlaybackResult = {
	readonly verb: "play" | "say";
	readonly endReason: VerbEndReason;
	readonly playbackRef?: string;
	/** The digit that barged in, when `endReason` is `terminator`. */
	readonly terminator?: DtmfDigit;
	readonly elapsedMs: number;
};

/** Outcome of any verb with no payload of its own. */
export type AcknowledgedResult = {
	readonly verb: Exclude<VerbName, "gather" | "record" | "dial" | "play" | "say">;
	readonly endReason: VerbEndReason;
};

/** Every result the engine can return for a verb. */
export type VerbResult =
	| GatherResult
	| RecordResult
	| DialResult
	| PlaybackResult
	| AcknowledgedResult;

const VERB_NAME_SET = new Set<string>(VERB_NAMES);

/**
 * Verbs that need audio to reach the caller, and therefore require the leg to have been answered
 * or to have an early-media path open (§1 answer semantics).
 *
 * Sending one of these to a leg that is neither answered nor in early media is a protocol error,
 * not something to paper over by implicitly answering: an implicit answer starts billing the
 * caller for a call they never got.
 */
export const MEDIA_PATH_VERBS = [
	"play",
	"say",
	"gather",
	"record",
	"playDtmf",
	"stream",
	"streamGather",
	"hold",
	"unhold",
	// Parking a leg that has not answered would put a ringing caller in an orbit slot with music
	// nobody can hear and a timeout nobody is waiting on; retrieving onto one would join a live
	// caller to a phone that has not picked up. Both are the media-path invariant, not a new rule.
	"park",
	"unpark",
] as const satisfies readonly VerbName[];

/**
 * Verbs that end the application's control of the leg. Nothing may follow them on the stream; the
 * engine closes the session after acknowledging.
 *
 * `transfer` is here because a blind transfer re-routes the leg into another context — the leg
 * lives on, but it is no longer this application's.
 */
export const TERMINAL_VERBS = ["hangup", "transfer"] as const satisfies readonly VerbName[];

/** Verbs that change the SIP progress state of the leg (§1). */
export const PROGRESS_VERBS = [
	"ringing",
	"earlyMedia",
	"answer",
] as const satisfies readonly VerbName[];

const MEDIA_PATH_VERB_SET = new Set<string>(MEDIA_PATH_VERBS);
const TERMINAL_VERB_SET = new Set<string>(TERMINAL_VERBS);
const PROGRESS_VERB_SET = new Set<string>(PROGRESS_VERBS);

/** Type guard for a verb name arriving on the session stream. */
export function isVerbName(value: string): value is VerbName {
	return VERB_NAME_SET.has(value);
}

/** Whether the verb needs an answered or early-media leg. See {@link MEDIA_PATH_VERBS}. */
export function verbRequiresMediaPath(verb: VerbName): boolean {
	return MEDIA_PATH_VERB_SET.has(verb);
}

/** Whether the verb ends the application's control of the leg. See {@link TERMINAL_VERBS}. */
export function isTerminalVerb(verb: VerbName): boolean {
	return TERMINAL_VERB_SET.has(verb);
}

/** Whether the verb drives SIP progress, and thus maps to a {@link PROGRESS_SIP_CODES} entry. */
export function isProgressVerb(verb: VerbName): boolean {
	return PROGRESS_VERB_SET.has(verb);
}
