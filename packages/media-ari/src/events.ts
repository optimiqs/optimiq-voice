import { AriEventParseError } from "./errors";
import {
	ariBridgeSchema,
	ariChannelSchema,
	ariEndpointSchema,
	ariLiveRecordingSchema,
	ariPeerSchema,
	ariPlaybackSchema,
} from "./models";
import type {
	AriBridge,
	AriCallerId,
	AriChannel,
	AriEndpoint,
	AriLiveRecording,
	AriPeer,
	AriPlayback,
} from "./models";

/**
 * The ARI event vocabulary, as a discriminated union on `type`.
 *
 * ## Scope
 *
 * Only the events the engine consumes are given a typed shape. Everything else Asterisk emits —
 * and it emits a great deal, from `ContactStatusChange` to `DeviceStateChanged` — arrives as
 * {@link AriUnknownEvent}, which keeps its raw payload. Dropping unknown events at this edge would
 * mean a new Asterisk release silently loses information the engine could have logged; typing all
 * ~60 of them would mean maintaining a schema for events nobody reads.
 *
 * ## Why parsing is hand-written and not Zod
 *
 * This is the hot path: an ARI event arrives for every state change of every leg of every call.
 * The parse is a `switch` over a string plus one schema call for the embedded resource object,
 * which is the resource we DO validate (see `models.ts` for why). A discriminated Zod union over
 * 20 members would re-walk every branch on every event for no additional safety.
 */

/** Fields Asterisk puts on every event. */
export interface AriEventBase {
	/** The Stasis application the event was delivered to. */
	readonly application: string;
	/** ISO-8601 with a numeric offset, e.g. `2026-08-05T10:00:00.000+0000`. */
	readonly timestamp?: string;
	/** Unique id of the Asterisk system that produced it; identifies the box in a cluster. */
	readonly asteriskId?: string;
}

/** Every event name this adapter gives a typed shape to. */
export const ARI_EVENT_TYPES = [
	"StasisStart",
	"StasisEnd",
	"ChannelCreated",
	"ChannelStateChange",
	"ChannelDtmfReceived",
	"ChannelDestroyed",
	"ChannelHangupRequest",
	"ChannelVarset",
	"ChannelHold",
	"ChannelUnhold",
	"ChannelDialplan",
	"PlaybackStarted",
	"PlaybackFinished",
	"RecordingStarted",
	"RecordingFinished",
	"RecordingFailed",
	"BridgeCreated",
	"BridgeDestroyed",
	"ChannelEnteredBridge",
	"ChannelLeftBridge",
	"Dial",
	"PeerStatusChange",
] as const;

export type AriEventType = (typeof ARI_EVENT_TYPES)[number];

const ARI_EVENT_TYPE_SET = new Set<string>(ARI_EVENT_TYPES);

/** Whether an event name is one this adapter models. */
export function isAriEventType(value: string): value is AriEventType {
	return ARI_EVENT_TYPE_SET.has(value);
}

/**
 * A channel entered the Stasis application — the engine's entry point for a call. `args` are the
 * arguments the dialplan passed to `Stasis(app,arg1,arg2)`.
 *
 * `replaceChannel` is present when this channel is replacing another one mid-masquerade (an
 * attended transfer completing, a pickup); ignoring it is how transfers lose their call id.
 */
export interface AriStasisStartEvent extends AriEventBase {
	readonly type: "StasisStart";
	readonly channel: AriChannel;
	readonly args: readonly string[];
	readonly replaceChannel?: AriChannel;
}

/** The channel left the Stasis application. It may still exist in the dialplan afterwards. */
export interface AriStasisEndEvent extends AriEventBase {
	readonly type: "StasisEnd";
	readonly channel: AriChannel;
}

/** A channel was created. Only delivered when the application subscribes to channel events. */
export interface AriChannelCreatedEvent extends AriEventBase {
	readonly type: "ChannelCreated";
	readonly channel: AriChannel;
}

/** The channel's `state` field changed — `Ring`, `Ringing`, `Up`, … */
export interface AriChannelStateChangeEvent extends AriEventBase {
	readonly type: "ChannelStateChange";
	readonly channel: AriChannel;
}

/** One DTMF digit. `durationMs` is how long the tone lasted, as Asterisk measured it. */
export interface AriChannelDtmfReceivedEvent extends AriEventBase {
	readonly type: "ChannelDtmfReceived";
	readonly channel: AriChannel;
	readonly digit: string;
	readonly durationMs: number;
}

/**
 * The channel is gone. `cause` is the Q.850 numeric cause — the single most important integer in
 * the whole protocol, since outbound failover, `continueOnCauses` and CDR disposition all key off
 * it. `causeText` is Asterisk's human rendering of the same number.
 */
export interface AriChannelDestroyedEvent extends AriEventBase {
	readonly type: "ChannelDestroyed";
	readonly channel: AriChannel;
	readonly cause: number;
	readonly causeText: string;
}

/** The far end asked to hang up. `soft` means it is a request, not yet a teardown. */
export interface AriChannelHangupRequestEvent extends AriEventBase {
	readonly type: "ChannelHangupRequest";
	readonly channel: AriChannel;
	readonly cause?: number;
	readonly soft?: boolean;
}

/** A channel variable was set. Also fires for variables Asterisk itself sets. */
export interface AriChannelVarsetEvent extends AriEventBase {
	readonly type: "ChannelVarset";
	/** Absent for global variables. */
	readonly channel?: AriChannel;
	readonly variable: string;
	readonly value: string;
}

/** The channel was put on hold by its peer. */
export interface AriChannelHoldEvent extends AriEventBase {
	readonly type: "ChannelHold";
	readonly channel: AriChannel;
	readonly musicClass?: string;
}

/** Hold was released. */
export interface AriChannelUnholdEvent extends AriEventBase {
	readonly type: "ChannelUnhold";
	readonly channel: AriChannel;
}

/** The channel started executing a new dialplan application. */
export interface AriChannelDialplanEvent extends AriEventBase {
	readonly type: "ChannelDialplan";
	readonly channel: AriChannel;
	readonly dialplanApp: string;
	readonly dialplanAppData: string;
}

/** Playback began. */
export interface AriPlaybackStartedEvent extends AriEventBase {
	readonly type: "PlaybackStarted";
	readonly playback: AriPlayback;
}

/**
 * Playback ended — whether it completed, was stopped or failed. ARI has no separate
 * `PlaybackFailed`; `playback.state` carries the outcome.
 */
export interface AriPlaybackFinishedEvent extends AriEventBase {
	readonly type: "PlaybackFinished";
	readonly playback: AriPlayback;
}

/** Recording began. */
export interface AriRecordingStartedEvent extends AriEventBase {
	readonly type: "RecordingStarted";
	readonly recording: AriLiveRecording;
}

/** Recording finished normally; the file is complete. */
export interface AriRecordingFinishedEvent extends AriEventBase {
	readonly type: "RecordingFinished";
	readonly recording: AriLiveRecording;
}

/** Recording failed. `recording.cause` says why (disk full, unknown format, …). */
export interface AriRecordingFailedEvent extends AriEventBase {
	readonly type: "RecordingFailed";
	readonly recording: AriLiveRecording;
}

/** A bridge was created. */
export interface AriBridgeCreatedEvent extends AriEventBase {
	readonly type: "BridgeCreated";
	readonly bridge: AriBridge;
}

/** A bridge was destroyed. */
export interface AriBridgeDestroyedEvent extends AriEventBase {
	readonly type: "BridgeDestroyed";
	readonly bridge: AriBridge;
}

/** A channel joined a bridge. */
export interface AriChannelEnteredBridgeEvent extends AriEventBase {
	readonly type: "ChannelEnteredBridge";
	readonly bridge: AriBridge;
	readonly channel: AriChannel;
}

/** A channel left a bridge. */
export interface AriChannelLeftBridgeEvent extends AriEventBase {
	readonly type: "ChannelLeftBridge";
	readonly bridge: AriBridge;
	readonly channel: AriChannel;
}

/**
 * Progress of a dial to a peer. `dialstatus` is `""` while ringing and then one of `ANSWER`,
 * `BUSY`, `NOANSWER`, `CANCEL`, `CONGESTION`, `CHANUNAVAIL` — the outbound-failover signal.
 */
export interface AriDialEvent extends AriEventBase {
	readonly type: "Dial";
	readonly caller?: AriChannel;
	readonly peer: AriChannel;
	readonly forward?: string;
	readonly forwarded?: AriChannel;
	readonly dialstring?: string;
	readonly dialstatus: string;
}

/**
 * A peer's qualify status changed — `Reachable`, `Unreachable`, `Unknown`, `Created`, `Removed`.
 *
 * The OPTIONS pinger's verdict on a trunk. Asterisk qualifies every PJSIP endpoint that carries a
 * `qualify_frequency` and raises this on the TRANSITION, not on every ping — which is exactly the
 * shape the trunk write-back wants, and why this event graduated out of {@link AriUnknownEvent}.
 * Delivered only when the application subscribes beyond its own channels (`subscribeAll`), which
 * the engine's ARI connection is configured for.
 *
 * `endpoint` is optional structurally rather than semantically: Asterisk always sends one, but a
 * frame that lost it still parses, and the consumer (the engine's trunk-status mapping) answers
 * `undefined` for it rather than this parser inventing an endpoint name to satisfy a type.
 */
export interface AriPeerStatusChangeEvent extends AriEventBase {
	readonly type: "PeerStatusChange";
	readonly endpoint?: AriEndpoint;
	readonly peer: AriPeer;
}

/**
 * Any event this adapter does not model. The raw payload is retained so the engine can log it,
 * count it, or grow a typed member for it later without a protocol change.
 */
export interface AriUnknownEvent extends AriEventBase {
	readonly type: "Unknown";
	readonly ariType: string;
	readonly raw: Readonly<Record<string, unknown>>;
}

/** Every event the adapter can deliver. */
export type AriEvent =
	| AriStasisStartEvent
	| AriStasisEndEvent
	| AriChannelCreatedEvent
	| AriChannelStateChangeEvent
	| AriChannelDtmfReceivedEvent
	| AriChannelDestroyedEvent
	| AriChannelHangupRequestEvent
	| AriChannelVarsetEvent
	| AriChannelHoldEvent
	| AriChannelUnholdEvent
	| AriChannelDialplanEvent
	| AriPlaybackStartedEvent
	| AriPlaybackFinishedEvent
	| AriRecordingStartedEvent
	| AriRecordingFinishedEvent
	| AriRecordingFailedEvent
	| AriBridgeCreatedEvent
	| AriBridgeDestroyedEvent
	| AriChannelEnteredBridgeEvent
	| AriChannelLeftBridgeEvent
	| AriDialEvent
	| AriPeerStatusChangeEvent
	| AriUnknownEvent;

/** Narrows the union by event name. */
export type AriEventOf<TType extends AriEvent["type"]> = Extract<AriEvent, { type: TType }>;

/** The channel an event is about, or `undefined` for the events that are not channel-scoped. */
export function channelOfEvent(event: AriEvent): AriChannel | undefined {
	switch (event.type) {
		case "StasisStart":
		case "StasisEnd":
		case "ChannelCreated":
		case "ChannelStateChange":
		case "ChannelDtmfReceived":
		case "ChannelDestroyed":
		case "ChannelHangupRequest":
		case "ChannelHold":
		case "ChannelUnhold":
		case "ChannelDialplan":
		case "ChannelEnteredBridge":
		case "ChannelLeftBridge":
			return event.channel;
		case "ChannelVarset":
			return event.channel;
		case "Dial":
			return event.peer;
		default:
			return undefined;
	}
}

type RawEvent = Record<string, unknown>;

function requireObject(value: unknown, field: string, ariType: string): RawEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new AriEventParseError(`${ariType} is missing the object field "${field}"`, ariType);
	}
	return value as RawEvent;
}

function optionalString(raw: RawEvent, field: string): string | undefined {
	const value = raw[field];
	return typeof value === "string" ? value : undefined;
}

function requiredString(raw: RawEvent, field: string, ariType: string): string {
	const value = raw[field];
	if (typeof value !== "string") {
		throw new AriEventParseError(`${ariType} is missing the string field "${field}"`, ariType);
	}
	return value;
}

function optionalNumber(raw: RawEvent, field: string): number | undefined {
	const value = raw[field];
	return typeof value === "number" ? value : undefined;
}

function parseChannel(raw: RawEvent, field: string, ariType: string): AriChannel {
	const result = ariChannelSchema.safeParse(requireObject(raw[field], field, ariType));
	if (!result.success) {
		throw new AriEventParseError(
			`${ariType}.${field} is not a valid Channel: ${result.error.issues.map((issue) => issue.message).join(", ")}`,
			ariType,
		);
	}
	return result.data;
}

function parseOptionalChannel(
	raw: RawEvent,
	field: string,
	ariType: string,
): AriChannel | undefined {
	return raw[field] === undefined ? undefined : parseChannel(raw, field, ariType);
}

function parseBridge(raw: RawEvent, ariType: string): AriBridge {
	const result = ariBridgeSchema.safeParse(requireObject(raw.bridge, "bridge", ariType));
	if (!result.success) {
		throw new AriEventParseError(
			`${ariType}.bridge is not a valid Bridge: ${result.error.issues.map((issue) => issue.message).join(", ")}`,
			ariType,
		);
	}
	return result.data;
}

function parsePlayback(raw: RawEvent, ariType: string): AriPlayback {
	const result = ariPlaybackSchema.safeParse(requireObject(raw.playback, "playback", ariType));
	if (!result.success) {
		throw new AriEventParseError(
			`${ariType}.playback is not a valid Playback: ${result.error.issues.map((issue) => issue.message).join(", ")}`,
			ariType,
		);
	}
	return result.data;
}

function parseRecording(raw: RawEvent, ariType: string): AriLiveRecording {
	const result = ariLiveRecordingSchema.safeParse(
		requireObject(raw.recording, "recording", ariType),
	);
	if (!result.success) {
		throw new AriEventParseError(
			`${ariType}.recording is not a valid LiveRecording: ${result.error.issues.map((issue) => issue.message).join(", ")}`,
			ariType,
		);
	}
	return result.data;
}

function parsePeer(raw: RawEvent, ariType: string): AriPeer {
	const result = ariPeerSchema.safeParse(requireObject(raw.peer, "peer", ariType));
	if (!result.success) {
		throw new AriEventParseError(
			`${ariType}.peer is not a valid Peer: ${result.error.issues.map((issue) => issue.message).join(", ")}`,
			ariType,
		);
	}
	return result.data;
}

function parseOptionalEndpoint(raw: RawEvent, ariType: string): AriEndpoint | undefined {
	if (raw.endpoint === undefined) {
		return undefined;
	}
	const result = ariEndpointSchema.safeParse(requireObject(raw.endpoint, "endpoint", ariType));
	if (!result.success) {
		throw new AriEventParseError(
			`${ariType}.endpoint is not a valid Endpoint: ${result.error.issues.map((issue) => issue.message).join(", ")}`,
			ariType,
		);
	}
	return result.data;
}

function parseArgs(raw: RawEvent): readonly string[] {
	const value = raw.args;
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === "string");
}

/**
 * Turns one decoded ARI JSON frame into a typed event.
 *
 * @throws {AriEventParseError} when the frame is not an object with a string `type`, or when a
 * resource object the event is defined by (its channel, bridge, playback or recording) is
 * malformed. An unrecognised `type` is NOT an error — it becomes {@link AriUnknownEvent}.
 */
export function parseAriEvent(payload: unknown): AriEvent {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new AriEventParseError("frame is not a JSON object", sampleOf(payload));
	}

	const raw = payload as RawEvent;
	const ariType = raw.type;
	if (typeof ariType !== "string" || ariType === "") {
		throw new AriEventParseError('frame has no string "type"', sampleOf(payload));
	}

	const base: AriEventBase = {
		application: typeof raw.application === "string" ? raw.application : "",
		timestamp: optionalString(raw, "timestamp"),
		asteriskId: optionalString(raw, "asterisk_id"),
	};

	switch (ariType) {
		case "StasisStart":
			return {
				...base,
				type: "StasisStart",
				channel: parseChannel(raw, "channel", ariType),
				args: parseArgs(raw),
				replaceChannel: parseOptionalChannel(raw, "replace_channel", ariType),
			};
		case "StasisEnd":
			return { ...base, type: "StasisEnd", channel: parseChannel(raw, "channel", ariType) };
		case "ChannelCreated":
			return { ...base, type: "ChannelCreated", channel: parseChannel(raw, "channel", ariType) };
		case "ChannelStateChange":
			return {
				...base,
				type: "ChannelStateChange",
				channel: parseChannel(raw, "channel", ariType),
			};
		case "ChannelDtmfReceived":
			return {
				...base,
				type: "ChannelDtmfReceived",
				channel: parseChannel(raw, "channel", ariType),
				digit: requiredString(raw, "digit", ariType),
				durationMs: optionalNumber(raw, "duration_ms") ?? 0,
			};
		case "ChannelDestroyed":
			return {
				...base,
				type: "ChannelDestroyed",
				channel: parseChannel(raw, "channel", ariType),
				cause: optionalNumber(raw, "cause") ?? 0,
				causeText: optionalString(raw, "cause_txt") ?? "",
			};
		case "ChannelHangupRequest":
			return {
				...base,
				type: "ChannelHangupRequest",
				channel: parseChannel(raw, "channel", ariType),
				cause: optionalNumber(raw, "cause"),
				soft: typeof raw.soft === "boolean" ? raw.soft : undefined,
			};
		case "ChannelVarset":
			return {
				...base,
				type: "ChannelVarset",
				channel: parseOptionalChannel(raw, "channel", ariType),
				variable: requiredString(raw, "variable", ariType),
				value: optionalString(raw, "value") ?? "",
			};
		case "ChannelHold":
			return {
				...base,
				type: "ChannelHold",
				channel: parseChannel(raw, "channel", ariType),
				musicClass: optionalString(raw, "musicclass"),
			};
		case "ChannelUnhold":
			return { ...base, type: "ChannelUnhold", channel: parseChannel(raw, "channel", ariType) };
		case "ChannelDialplan":
			return {
				...base,
				type: "ChannelDialplan",
				channel: parseChannel(raw, "channel", ariType),
				dialplanApp: optionalString(raw, "dialplan_app") ?? "",
				dialplanAppData: optionalString(raw, "dialplan_app_data") ?? "",
			};
		case "PlaybackStarted":
			return { ...base, type: "PlaybackStarted", playback: parsePlayback(raw, ariType) };
		case "PlaybackFinished":
			return { ...base, type: "PlaybackFinished", playback: parsePlayback(raw, ariType) };
		case "RecordingStarted":
			return { ...base, type: "RecordingStarted", recording: parseRecording(raw, ariType) };
		case "RecordingFinished":
			return { ...base, type: "RecordingFinished", recording: parseRecording(raw, ariType) };
		case "RecordingFailed":
			return { ...base, type: "RecordingFailed", recording: parseRecording(raw, ariType) };
		case "BridgeCreated":
			return { ...base, type: "BridgeCreated", bridge: parseBridge(raw, ariType) };
		case "BridgeDestroyed":
			return { ...base, type: "BridgeDestroyed", bridge: parseBridge(raw, ariType) };
		case "ChannelEnteredBridge":
			return {
				...base,
				type: "ChannelEnteredBridge",
				bridge: parseBridge(raw, ariType),
				channel: parseChannel(raw, "channel", ariType),
			};
		case "ChannelLeftBridge":
			return {
				...base,
				type: "ChannelLeftBridge",
				bridge: parseBridge(raw, ariType),
				channel: parseChannel(raw, "channel", ariType),
			};
		case "Dial":
			return {
				...base,
				type: "Dial",
				caller: parseOptionalChannel(raw, "caller", ariType),
				peer: parseChannel(raw, "peer", ariType),
				forward: optionalString(raw, "forward"),
				forwarded: parseOptionalChannel(raw, "forwarded", ariType),
				dialstring: optionalString(raw, "dialstring"),
				dialstatus: optionalString(raw, "dialstatus") ?? "",
			};
		case "PeerStatusChange":
			return {
				...base,
				type: "PeerStatusChange",
				endpoint: parseOptionalEndpoint(raw, ariType),
				peer: parsePeer(raw, ariType),
			};
		default:
			return { ...base, type: "Unknown", ariType, raw };
	}
}

/** Decodes a raw WebSocket text frame and parses it. */
export function parseAriEventFrame(frame: string): AriEvent {
	let decoded: unknown;
	try {
		decoded = JSON.parse(frame);
	} catch (cause) {
		throw new AriEventParseError(`frame is not JSON (${String(cause)})`, sampleOf(frame));
	}
	return parseAriEvent(decoded);
}

/** Caps the payload retained on a parse error — event frames carry caller-id data. */
function sampleOf(value: unknown): string {
	const rendered = typeof value === "string" ? value : JSON.stringify(value);
	return (rendered ?? String(value)).slice(0, 200);
}

/** Structural caller-id read that tolerates ARI's habit of omitting the object entirely. */
export function callerIdOf(channel: AriChannel): AriCallerId {
	return channel.caller ?? { name: "", number: "" };
}
