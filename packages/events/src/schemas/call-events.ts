import { z } from "zod";
import { subjectFor, type CallEvent } from "../subjects";
import { defineEvent, makeEvent, type EventInput } from "./envelope";
import {
	bridgeModeSchema,
	callDirectionSchema,
	dialStringSchema,
	dtmfDigitSchema,
	dtmfSourceSchema,
	hangupCauseCodeSchema,
	hangupCauseSchema,
	hangupSideSchema,
	legSideSchema,
	recordingKindSchema,
	recordingStopReasonSchema,
} from "./telephony";

/**
 * Channel lifecycle events — `calls.evt.v1.<orgId>.<callId>.<event>`.
 *
 * `orgId` and `callId` live in the SUBJECT and are therefore absent from every payload; `legId`
 * is always present because one call has many legs and the subject cannot name them all without
 * destroying per-call ordering. Recover the subject-carried ids with `parseSubject`.
 *
 * The vocabulary is the FS-semantic superset the plan names in §4.2, mapped from ARI today and
 * from `mediad` after the cutover — that mapping is the media adapter's job, not this package's.
 */

const legRef = z.object({ legId: z.uuid() });

/** `channel.created` — a leg exists; routing has not happened yet. */
export const channelCreatedDataSchema = z.object({
	legId: z.uuid(),
	leg: legSideSchema,
	direction: callDirectionSchema,
	from: z.object({ number: dialStringSchema, name: z.string().max(128).optional() }),
	to: z.object({ number: dialStringSchema }),
	/** The leg that originated this one; absent on an A-leg. */
	originatingLegId: z.uuid().optional(),
	/** SIP `Call-ID`, for correlating with a packet capture. */
	sipCallId: z.string().max(256).optional(),
	/** Named routing namespace — the "never let public traffic reach a trunk" boundary. */
	routingContext: z.string().max(64).optional(),
	/** Signalling peer, `host:port`. */
	remoteAddress: z.string().max(64).optional(),
});

/** `channel.ringing` — 180 sent/received, no media. */
export const channelRingingDataSchema = legRef;

/** `channel.early-media` — 183 + SDP; audio flows before answer and before billing. */
export const channelEarlyMediaDataSchema = legRef;

/** `channel.answered` — 200 OK; billing starts. */
export const channelAnsweredDataSchema = legRef;

/** `channel.bridged` — two legs joined; `mode` says whether media is relayed or peer-to-peer. */
export const channelBridgedDataSchema = z.object({
	legId: z.uuid(),
	peerLegId: z.uuid(),
	bridgeId: z.uuid(),
	mode: bridgeModeSchema,
});

/** `channel.unbridged` — the pair separated (transfer, hangup of one side, park…). */
export const channelUnbridgedDataSchema = z.object({
	legId: z.uuid(),
	peerLegId: z.uuid(),
	bridgeId: z.uuid(),
	reason: z.string().max(64).optional(),
});

/** `channel.held` — the peer was put on hold; MOH comes from a shared stream, not a per-call file. */
export const channelHeldDataSchema = z.object({
	legId: z.uuid(),
	mohClass: z.string().max(64).optional(),
});

/** `channel.unheld` */
export const channelUnheldDataSchema = legRef;

/** `channel.dtmf` — one collected digit; collection/regex logic lives in the engine. */
export const channelDtmfDataSchema = z.object({
	legId: z.uuid(),
	digit: dtmfDigitSchema,
	durationMs: z.int().min(0).max(60_000),
	source: dtmfSourceSchema,
});

/** `channel.record.started` — a media bug is now writing to `objectKey`. */
export const channelRecordStartedDataSchema = z.object({
	legId: z.uuid(),
	recordingId: z.uuid(),
	/** Object-store key; joins to `cdr-db` `recordings.object_key`. */
	objectKey: z.string().min(1).max(1024),
	kind: recordingKindSchema,
	/** True when each leg is written to its own channel (per-leg stereo). */
	stereo: z.boolean().optional(),
});

/** `channel.record.stopped` — the object is final; the CDR's `recordingKey` can be set. */
export const channelRecordStoppedDataSchema = z.object({
	legId: z.uuid(),
	recordingId: z.uuid(),
	objectKey: z.string().min(1).max(1024),
	durationMs: z.int().min(0),
	reason: recordingStopReasonSchema,
	bytes: z.int().min(0).optional(),
});

/**
 * `channel.hangup` — the leg is tearing down. `cause`/`causeCode` are the routing-significant
 * pair (`continue_on_fail` lists, outbound failover, `LOSE_RACE` cleanup); see `telephony.ts`
 * for why the cause is a shape-checked string rather than an enum.
 */
export const channelHangupDataSchema = z.object({
	legId: z.uuid(),
	cause: hangupCauseSchema,
	causeCode: hangupCauseCodeSchema,
	side: hangupSideSchema,
});

/** `channel.destroyed` — the session is gone; nothing further will be emitted for this leg. */
export const channelDestroyedDataSchema = z.object({
	legId: z.uuid(),
	durationMs: z.int().min(0).optional(),
});

/**
 * `conference.joined` — a leg entered a conference room's mixing bridge.
 *
 * `moderator` is the load-bearing field: a room with `waitForModerator` holds every participant
 * in music on hold until one arrives, so "who joined" is not enough — "as what" is the fact that
 * ends the hold.
 */
export const conferenceJoinedDataSchema = z.object({
	legId: z.uuid(),
	conferenceId: z.uuid(),
	roomNumber: dialStringSchema,
	bridgeId: z.uuid(),
	moderator: z.boolean(),
	/** Members in the room INCLUDING this one, after the join. */
	memberCount: z.int().min(1),
});

/** `conference.left` — the leg is out of the room. Paired with a `conference.joined`. */
export const conferenceLeftDataSchema = z.object({
	legId: z.uuid(),
	conferenceId: z.uuid(),
	roomNumber: dialStringSchema,
	bridgeId: z.uuid(),
	moderator: z.boolean(),
	/** Members remaining AFTER this one left. Zero means the bridge was torn down. */
	memberCount: z.int().min(0),
	durationMs: z.int().min(0).optional(),
});

/**
 * `call.emergency.dialed` — the Kari's Law notification seam.
 *
 * Published at the moment the first trunk attempt is made, not when it is answered: the statute
 * is about the attempt, and a call that failed over three carriers before reaching a PSAP is
 * exactly the one somebody at the front desk needs to hear about immediately.
 *
 * Every field a notification needs is here so a consumer never has to join back to the artifact:
 * what was dialed, who dialed it, what ANI the PSAP will see, and which dispatchable location
 * that ANI is registered against. `emergencyAddressId` may be absent — that is an organization
 * with no validated address, which is worth saying in the notification rather than hiding.
 */
export const callEmergencyDialedDataSchema = z.object({
	legId: z.uuid(),
	/** The dial string the caller entered, e.g. `911` or `9911`. */
	dialed: dialStringSchema,
	/** What went on the wire, after the outside-line prefix was stripped. */
	number: dialStringSchema,
	/** The calling station, when there is one. An API-originated leg may have none. */
	callerNumber: dialStringSchema.optional(),
	callerName: z.string().max(128).optional(),
	/** The ELIN actually presented. Absent means the call went out with no caller id at all. */
	elin: dialStringSchema.optional(),
	/** `emergency_address.id` the ELIN is registered against. */
	emergencyAddressId: z.uuid().optional(),
	/** The trunk the first attempt was placed over, for the "did it get out?" question. */
	trunkName: z.string().max(128).optional(),
});

/** Every call event contract, keyed by its `type` (which is also its subject event token). */
export const CALL_EVENT_DEFINITIONS = {
	"channel.created": defineEvent("call", "channel.created", channelCreatedDataSchema),
	"channel.ringing": defineEvent("call", "channel.ringing", channelRingingDataSchema),
	"channel.early-media": defineEvent("call", "channel.early-media", channelEarlyMediaDataSchema),
	"channel.answered": defineEvent("call", "channel.answered", channelAnsweredDataSchema),
	"channel.bridged": defineEvent("call", "channel.bridged", channelBridgedDataSchema),
	"channel.unbridged": defineEvent("call", "channel.unbridged", channelUnbridgedDataSchema),
	"channel.held": defineEvent("call", "channel.held", channelHeldDataSchema),
	"channel.unheld": defineEvent("call", "channel.unheld", channelUnheldDataSchema),
	"channel.dtmf": defineEvent("call", "channel.dtmf", channelDtmfDataSchema),
	"channel.record.started": defineEvent(
		"call",
		"channel.record.started",
		channelRecordStartedDataSchema,
	),
	"channel.record.stopped": defineEvent(
		"call",
		"channel.record.stopped",
		channelRecordStoppedDataSchema,
	),
	"channel.hangup": defineEvent("call", "channel.hangup", channelHangupDataSchema),
	"channel.destroyed": defineEvent("call", "channel.destroyed", channelDestroyedDataSchema),
	"conference.joined": defineEvent("call", "conference.joined", conferenceJoinedDataSchema),
	"conference.left": defineEvent("call", "conference.left", conferenceLeftDataSchema),
	"call.emergency.dialed": defineEvent(
		"call",
		"call.emergency.dialed",
		callEmergencyDialedDataSchema,
	),
} as const;

export type CallEventDefinitions = typeof CALL_EVENT_DEFINITIONS;

/** The envelope type of one call event, e.g. `CallEventOf<"channel.hangup">`. */
export type CallEventOf<TType extends CallEvent> = z.infer<CallEventDefinitions[TType]["envelope"]>;

/** The payload type of one call event. */
export type CallEventDataOf<TType extends CallEvent> = z.infer<CallEventDefinitions[TType]["data"]>;

/**
 * Every call event as one discriminated union — the schema a `CALLS` consumer passes to
 * `createDurableConsumer`, and the type its handler switches on.
 */
export const callEventSchema = z.discriminatedUnion("type", [
	CALL_EVENT_DEFINITIONS["channel.created"].envelope,
	CALL_EVENT_DEFINITIONS["channel.ringing"].envelope,
	CALL_EVENT_DEFINITIONS["channel.early-media"].envelope,
	CALL_EVENT_DEFINITIONS["channel.answered"].envelope,
	CALL_EVENT_DEFINITIONS["channel.bridged"].envelope,
	CALL_EVENT_DEFINITIONS["channel.unbridged"].envelope,
	CALL_EVENT_DEFINITIONS["channel.held"].envelope,
	CALL_EVENT_DEFINITIONS["channel.unheld"].envelope,
	CALL_EVENT_DEFINITIONS["channel.dtmf"].envelope,
	CALL_EVENT_DEFINITIONS["channel.record.started"].envelope,
	CALL_EVENT_DEFINITIONS["channel.record.stopped"].envelope,
	CALL_EVENT_DEFINITIONS["channel.hangup"].envelope,
	CALL_EVENT_DEFINITIONS["channel.destroyed"].envelope,
	CALL_EVENT_DEFINITIONS["conference.joined"].envelope,
	CALL_EVENT_DEFINITIONS["conference.left"].envelope,
	CALL_EVENT_DEFINITIONS["call.emergency.dialed"].envelope,
]);

export type CallEventEnvelope = z.infer<typeof callEventSchema>;

/** Input for {@link makeCallEvent}: the subject is derived, never passed. */
export interface CallEventInput<TType extends CallEvent> extends Omit<
	EventInput<CallEventDataOf<TType>>,
	"subject"
> {
	readonly callId: string;
}

/**
 * Builds and validates a call event, deriving `calls.evt.v1.<orgId>.<callId>.<type>` for you.
 * This is the only supported way to construct one.
 */
export function makeCallEvent<TType extends CallEvent>(
	type: TType,
	input: CallEventInput<TType>,
): CallEventOf<TType> {
	const definition = CALL_EVENT_DEFINITIONS[type];
	const subject = subjectFor.call(input.orgId, input.callId, type);
	// The record is keyed by the same union `type` ranges over, so the definition and the input
	// payload always agree; TypeScript cannot correlate the two through the index, hence the cast.
	return makeEvent(definition, { ...input, subject } as never) as CallEventOf<TType>;
}
