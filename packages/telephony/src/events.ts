/**
 * Call event vocabulary — the semantic events the engine emits for one call.
 *
 * Frozen source of truth: `plans/reference/freeswitch-capabilities.md` §8 ("Core types to
 * reproduce: CHANNEL_CREATE/ORIGINATE/PROGRESS/… CHANNEL_STATE, CHANNEL_CALLSTATE, DEVICE_STATE,
 * DTMF, RECORD_START/STOP, PLAYBACK_START/STOP, …"), narrowed to the call domain.
 *
 * Scope boundary, deliberately: this package owns the **vocabulary and payload shapes**.
 * `packages/events` owns the NATS subject taxonomy, the Zod schemas and the envelope
 * (`eventId`, `occurredAt`, `organizationId`, sequencing) that wrap these; `packages/cdr-db`
 * persists the forensic subset. Keeping the names here means the routing executor, the session
 * protocol and the CDR writer cannot drift on what "bridged" means.
 *
 * Names are dot-namespaced `<entity>.<past-tense-fact>`: an event is something that already
 * happened, which is what makes replaying the stream to rebuild a CDR sound.
 */

import type { BridgeMode, LegRole, UnbridgeReason } from "./bridge";
import type { CallState, DeviceState } from "./call-state";
import type { CallerProfile, ChannelDirection } from "./channel";
import type { ChannelState } from "./channel-state";
import type { DtmfDigit, DtmfSource } from "./dtmf";
import type { HangupCause } from "./hangup-causes";
import type { TransferKind, VerbName } from "./verbs";

/** Every event name the engine emits for a call. */
export const CALL_EVENT_NAMES = [
	"channel.created",
	"channel.originated",
	"channel.routing",
	"channel.progress",
	"channel.early-media",
	"channel.answered",
	"channel.state-changed",
	"channel.callstate-changed",
	"channel.verb-started",
	"channel.verb-completed",
	"channel.dtmf",
	"channel.hangup",
	"channel.destroyed",
	"bridge.created",
	"bridge.bridged",
	"bridge.unbridged",
	"call.held",
	"call.unheld",
	"call.parked",
	"call.unparked",
	"call.transfer-started",
	"call.transfer-completed",
	"call.transfer-failed",
	"record.started",
	"record.stopped",
	"playback.started",
	"playback.stopped",
	"device.state-changed",
] as const;

export type CallEventName = (typeof CALL_EVENT_NAMES)[number];

/**
 * Fields every call event carries. The envelope (`eventId`, `occurredAt`, ordering) is added by
 * `packages/events`; this is only the domain correlation, which is what makes an event routable
 * and tenant-scoped without opening its payload.
 */
export type CallEventBase = {
	readonly organizationId: string;
	/** Groups the A-leg and every leg originated for it. */
	readonly callId: string;
	readonly channelId: string;
};

export type ChannelCreatedEvent = CallEventBase & {
	readonly event: "channel.created";
	readonly direction: ChannelDirection;
	readonly profile: CallerProfile;
};

export type ChannelOriginatedEvent = CallEventBase & {
	readonly event: "channel.originated";
	readonly profile: CallerProfile;
	/** The channel that asked for this leg, when the engine originated it for another call. */
	readonly originatorChannelId?: string;
};

export type ChannelRoutingEvent = CallEventBase & {
	readonly event: "channel.routing";
	readonly profile: CallerProfile;
	/** Entry that matched, when routing resolved. Absent means routing failed. */
	readonly matchedRouteId?: string;
};

/** SIP 180: the far end is alerting. No media. */
export type ChannelProgressEvent = CallEventBase & {
	readonly event: "channel.progress";
};

/** SIP 183 + SDP: audio before answer, before billing. */
export type ChannelEarlyMediaEvent = CallEventBase & {
	readonly event: "channel.early-media";
};

/** SIP 200 OK: the billing clock starts here, not at bridge time. */
export type ChannelAnsweredEvent = CallEventBase & {
	readonly event: "channel.answered";
};

export type ChannelStateChangedEvent = CallEventBase & {
	readonly event: "channel.state-changed";
	readonly from: ChannelState;
	readonly to: ChannelState;
};

export type ChannelCallStateChangedEvent = CallEventBase & {
	readonly event: "channel.callstate-changed";
	readonly from: CallState;
	readonly to: CallState;
};

export type ChannelVerbStartedEvent = CallEventBase & {
	readonly event: "channel.verb-started";
	readonly verb: VerbName;
	/** Correlates start with completion for a single verb execution. */
	readonly executionId: string;
};

export type ChannelVerbCompletedEvent = CallEventBase & {
	readonly event: "channel.verb-completed";
	readonly verb: VerbName;
	readonly executionId: string;
	readonly durationMs: number;
};

export type ChannelDtmfEvent = CallEventBase & {
	readonly event: "channel.dtmf";
	readonly digit: DtmfDigit;
	readonly durationMs: number;
	readonly source: DtmfSource;
};

export type ChannelHangupEvent = CallEventBase & {
	readonly event: "channel.hangup";
	readonly cause: HangupCause;
	/** Which side tore it down, when the engine can attribute it. */
	readonly initiator?: "caller" | "callee" | "system";
};

export type ChannelDestroyedEvent = CallEventBase & {
	readonly event: "channel.destroyed";
};

export type BridgeCreatedEvent = CallEventBase & {
	readonly event: "bridge.created";
	readonly bridgeId: string;
	readonly mode: BridgeMode;
};

export type BridgeBridgedEvent = CallEventBase & {
	readonly event: "bridge.bridged";
	readonly bridgeId: string;
	readonly mode: BridgeMode;
	readonly peerChannelId: string;
	readonly role: LegRole;
};

export type BridgeUnbridgedEvent = CallEventBase & {
	readonly event: "bridge.unbridged";
	readonly bridgeId: string;
	readonly peerChannelId: string;
	readonly reason: UnbridgeReason;
	readonly durationMs: number;
};

export type CallHeldEvent = CallEventBase & { readonly event: "call.held" };

export type CallUnheldEvent = CallEventBase & { readonly event: "call.unheld" };

export type CallParkedEvent = CallEventBase & {
	readonly event: "call.parked";
	readonly lot: string;
	readonly orbit: string;
};

export type CallUnparkedEvent = CallEventBase & {
	readonly event: "call.unparked";
	readonly lot: string;
	readonly orbit: string;
	/** The channel that retrieved the call. */
	readonly retrievedByChannelId?: string;
};

export type CallTransferStartedEvent = CallEventBase & {
	readonly event: "call.transfer-started";
	readonly kind: TransferKind;
	readonly destination: string;
	readonly context?: string;
};

export type CallTransferCompletedEvent = CallEventBase & {
	readonly event: "call.transfer-completed";
	readonly kind: TransferKind;
	readonly destination: string;
	/** The consultation leg, for an attended transfer. */
	readonly consultationChannelId?: string;
};

export type CallTransferFailedEvent = CallEventBase & {
	readonly event: "call.transfer-failed";
	readonly kind: TransferKind;
	readonly destination: string;
	readonly cause: HangupCause;
};

export type RecordStartedEvent = CallEventBase & {
	readonly event: "record.started";
	readonly recordingId: string;
	readonly stereo: boolean;
};

export type RecordStoppedEvent = CallEventBase & {
	readonly event: "record.stopped";
	readonly recordingId: string;
	readonly durationMs: number;
};

export type PlaybackStartedEvent = CallEventBase & {
	readonly event: "playback.started";
	readonly playbackRef: string;
	readonly media: string;
};

export type PlaybackStoppedEvent = CallEventBase & {
	readonly event: "playback.stopped";
	readonly playbackRef: string;
	readonly durationMs: number;
};

/**
 * The aggregate presence value for a device/extension, recomputed from every channel it owns.
 *
 * Carries no `channelId` correlation of its own beyond the base — a device state is about the
 * device, and it is the only event a BLF subscriber needs.
 */
export type DeviceStateChangedEvent = {
	readonly event: "device.state-changed";
	readonly organizationId: string;
	/** The extension/device whose lamp changes. */
	readonly deviceRef: string;
	readonly from: DeviceState;
	readonly to: DeviceState;
};

/** Every call event, discriminated on `event`. */
export type CallEvent =
	| ChannelCreatedEvent
	| ChannelOriginatedEvent
	| ChannelRoutingEvent
	| ChannelProgressEvent
	| ChannelEarlyMediaEvent
	| ChannelAnsweredEvent
	| ChannelStateChangedEvent
	| ChannelCallStateChangedEvent
	| ChannelVerbStartedEvent
	| ChannelVerbCompletedEvent
	| ChannelDtmfEvent
	| ChannelHangupEvent
	| ChannelDestroyedEvent
	| BridgeCreatedEvent
	| BridgeBridgedEvent
	| BridgeUnbridgedEvent
	| CallHeldEvent
	| CallUnheldEvent
	| CallParkedEvent
	| CallUnparkedEvent
	| CallTransferStartedEvent
	| CallTransferCompletedEvent
	| CallTransferFailedEvent
	| RecordStartedEvent
	| RecordStoppedEvent
	| PlaybackStartedEvent
	| PlaybackStoppedEvent
	| DeviceStateChangedEvent;

/** Narrows the union by event name. */
export type CallEventOf<N extends CallEventName> = Extract<CallEvent, { event: N }>;

const CALL_EVENT_NAME_SET = new Set<string>(CALL_EVENT_NAMES);

/** Type guard for an event name arriving from NATS or a webhook. */
export function isCallEventName(value: string): value is CallEventName {
	return CALL_EVENT_NAME_SET.has(value);
}

/**
 * The event announcing a channel-state change, for the two states that are also lifecycle
 * milestones. Everything else rides `channel.state-changed`.
 */
export const CHANNEL_STATE_MILESTONE_EVENTS = {
	routing: "channel.routing",
	hangup: "channel.hangup",
	destroyed: "channel.destroyed",
} as const satisfies Partial<Record<ChannelState, CallEventName>>;

/** The call-state changes that also raise a dedicated semantic event. */
export const CALL_STATE_MILESTONE_EVENTS = {
	ringing: "channel.progress",
	early: "channel.early-media",
	active: "channel.answered",
	held: "call.held",
	unheld: "call.unheld",
	hangup: "channel.hangup",
} as const satisfies Partial<Record<CallState, CallEventName>>;
