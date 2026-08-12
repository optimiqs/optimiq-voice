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
	parkEndReasonSchema,
	pickupKindSchema,
	recordingKindSchema,
	recordingStopReasonSchema,
	tapEndReasonSchema,
	tapModeSchema,
	transferKindSchema,
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

/**
 * Why a participant left a room.
 *
 * `hung-up` is the ordinary end and covers every departure the participant chose. `kicked` is a
 * moderator's decision and is the whole reason this field exists: a report that could not tell the
 * two apart would show a meeting where four people left early and no evidence that somebody removed
 * them. `room-ended` is the room going away underneath a member — the last moderator left a room
 * that requires one, or the bridge was torn down.
 */
export const CONFERENCE_LEAVE_REASONS = ["hung-up", "kicked", "room-ended"] as const;
export const conferenceLeaveReasonSchema = z.enum(CONFERENCE_LEAVE_REASONS);
export type ConferenceLeaveReason = (typeof CONFERENCE_LEAVE_REASONS)[number];

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
	/**
	 * Why they left. OPTIONAL, and absent is read as `hung-up`: an artifact of a release that
	 * predates moderation is not a room where everybody was kicked. See
	 * {@link conferenceLeaveReasonSchema}.
	 */
	reason: conferenceLeaveReasonSchema.optional(),
	/** The control-plane user who kicked them. Present only with `reason: "kicked"`. */
	byUserId: z.uuid().optional(),
});

/**
 * `conference.participant.updated` — a member's state inside the room changed.
 *
 * ## The whole state, every time
 *
 * Every mutable field is REQUIRED and carries the value AFTER the change, rather than the schema
 * modelling a delta with one optional field set. A participant list is rebuilt from these, and a
 * consumer that applied a delta to a row it had drawn from a frame it missed would show a mute
 * button that disagrees with the mixer — which is the one failure a moderation panel cannot
 * tolerate, because the operator's next action is based on what it says.
 *
 * ## Not published on join or leave
 *
 * Those are `conference.joined` and `conference.left`, which already carry the member. Publishing
 * this alongside them would make every arrival two events and every departure two, and a consumer
 * counting participants would have to know which of the pair to ignore.
 */
export const conferenceParticipantUpdatedDataSchema = z.object({
	legId: z.uuid(),
	conferenceId: z.uuid(),
	roomNumber: dialStringSchema,
	/** Whether the ROOM hears this member. */
	muted: z.boolean(),
	/** Whether this member hears the room. Independent of {@link muted}; both can be true. */
	deafened: z.boolean(),
	moderator: z.boolean(),
	/**
	 * The member's gain, in percent of unity, as the mixer is applying it.
	 *
	 * Percent for the reason `conferenceControlRequestSchema.gainPercent` gives, and REQUIRED
	 * rather than optional-when-unchanged: 100 is a real, renderable answer ("this member is at
	 * normal volume") and an absent field is not.
	 *
	 * On a media plane with no per-participant gain both stay at 100 forever, which is honest — the
	 * mixer is applying unity because it can apply nothing else — and the refusal the operator sees
	 * when they move the slider comes from the command, not from this event.
	 */
	talkGainPercent: z.int().min(0).max(400),
	listenGainPercent: z.int().min(0).max(400),
	/** The control-plane user who made the change. Absent when the member did it themselves (`*6`). */
	byUserId: z.uuid().optional(),
});

/**
 * `conference.locked` / `conference.unlocked` — the room stopped, or resumed, admitting people.
 *
 * `legId` is deliberately absent, unlike every other event on this root: a lock is a fact about the
 * ROOM and the leg that happens to be publishing it is an implementation detail of which instance
 * served the command. Carrying one would invite a consumer to attribute the lock to a participant.
 */
export const conferenceLockChangedDataSchema = z.object({
	conferenceId: z.uuid(),
	roomNumber: dialStringSchema,
	/** Members in the room, cluster-wide, when the lock changed. */
	memberCount: z.int().min(0),
	/** The control-plane user who locked or unlocked it. */
	byUserId: z.uuid().optional(),
});

/**
 * `call.parked` — a call is sitting in an orbit slot.
 *
 * `slot` is the number somebody dials to collect it, which is why it is a dial string rather than
 * an integer: it is announced over a PA system and typed into a phone, and a slot that had to be
 * re-derived from a lot id and an offset would be a different number in every consumer.
 *
 * `parkedByLegId` is the leg that put the call there — the parker. It is optional because a call
 * can also be parked by a routing plan that sends a DID straight to a lot, in which case nobody
 * parked it and inventing a parker would be a lie the timeout ringback then acts on.
 */
export const callParkedDataSchema = z.object({
	legId: z.uuid(),
	parkLotId: z.uuid(),
	slot: dialStringSchema,
	/** When the lot will return the call to the parker. Absent means the lot has no timeout. */
	timeoutMs: z.int().min(0).optional(),
	parkedByLegId: z.uuid().optional(),
	mohClass: z.string().max(64).optional(),
});

/** `call.unparked` — the call left the slot, and why. Paired with a `call.parked`. */
export const callUnparkedDataSchema = z.object({
	legId: z.uuid(),
	parkLotId: z.uuid(),
	slot: dialStringSchema,
	reason: parkEndReasonSchema,
	/** The leg that collected the call. Present only when `reason` is `retrieved`. */
	retrievedByLegId: z.uuid().optional(),
	/** How long the call sat in the lot. */
	durationMs: z.int().min(0).optional(),
});

/**
 * `call.transferred` — a call was handed to a new party, and the handover completed.
 *
 * All three legs are named because a transfer is the one operation where "which call is this?"
 * has three defensible answers. `legId` is the TRANSFEREE — the party that was handed over and is
 * still on the phone — because that is the leg a consumer follows afterwards.
 */
export const callTransferredDataSchema = z.object({
	/** The transferee: the party handed to a new destination. */
	legId: z.uuid(),
	kind: transferKindSchema,
	/** What was dialled for them, in the target context. */
	destination: dialStringSchema,
	/** Routing namespace the destination was resolved in. */
	routingContext: z.string().max(64).optional(),
	/** The party that asked for the transfer, if it was still up when the transfer completed. */
	transferorLegId: z.uuid().optional(),
	/** The consultation leg, for an attended transfer. */
	targetLegId: z.uuid().optional(),
});

/**
 * `call.picked-up` — somebody answered a call that was ringing at another extension.
 *
 * `legId` is the leg that DID the picking up. `pickedUpLegId` is the caller they took over, which
 * is the A-leg of the original call rather than the ringing phone — the ringing phone is hung up
 * with `PICKED_OFF` and has no call left to be part of.
 */
export const callPickedUpDataSchema = z.object({
	legId: z.uuid(),
	pickedUpLegId: z.uuid(),
	kind: pickupKindSchema,
	/** The extension whose ringing call was taken. */
	extension: dialStringSchema,
	/** The leg that was ringing and is now hung up with `PICKED_OFF`. */
	abandonedLegId: z.uuid().optional(),
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

/**
 * `call.tap.started` — a supervisor is now listening to a call that is not theirs.
 *
 * ## Why the subject is the TARGET call, not the supervisor's
 *
 * Both are real calls with real ids, and the supervisor's leg has its own `channel.created`. The
 * subject is the monitored one because that is the call anybody ever asks about: a compliance
 * review starts from "this customer conversation" and needs to discover who was on it. Keyed the
 * other way, finding the taps on a call would mean scanning every call in the org.
 *
 * `legId` is therefore the SUPERVISOR's leg — the one this event is news about — matching the
 * convention `call.picked-up` uses, where `legId` is the party that acted.
 *
 * ## Published again on escalation
 *
 * `*0` starts in `eavesdrop` and DTMF moves it to `whisper` (5) or `barge` (6). Each transition
 * publishes a fresh `started` carrying the new `mode`, with `previousMode` set. A single event
 * with the final mode would mean a supervisor who listened silently for ten minutes and then
 * barged is indistinguishable from one who barged immediately.
 */
export const callTapStartedDataSchema = z.object({
	/** The supervisor's own leg — the party doing the listening. */
	legId: z.uuid(),
	mode: tapModeSchema,
	/** The supervising extension, as the engine authenticated it. */
	supervisorExtension: dialStringSchema,
	/** The extension whose call is being monitored — what `*0` was dialled with. */
	targetExtension: dialStringSchema,
	/** The monitored party's leg inside the target call, when it is known. */
	targetLegId: z.uuid().optional(),
	/**
	 * The mode this replaced, on an escalation. Absent on the first `started` of a tap, which is
	 * what distinguishes "began monitoring" from "changed how they were monitoring".
	 */
	previousMode: tapModeSchema.optional(),
	/** The supervisor's own call id, so the two calls can be joined without a scan. */
	supervisorCallId: z.uuid().optional(),
});

/** `call.tap.ended` — the supervisor stopped listening. Bounds the monitored interval. */
export const callTapEndedDataSchema = z.object({
	legId: z.uuid(),
	mode: tapModeSchema,
	supervisorExtension: dialStringSchema,
	targetExtension: dialStringSchema,
	reason: tapEndReasonSchema,
	/** How long the tap was open. Absent when the engine lost the start (a restart mid-tap). */
	durationMs: z.int().min(0).optional(),
});

/**
 * `call.paging.started` — a one-way announcement was opened to a group of handsets.
 *
 * `answeredCount` is the number of members whose phone actually auto-answered, and it is the
 * point of the event: a page to a group of twelve where two phones were unregistered is a page
 * the person making it believes reached everybody. `memberCount` is what was attempted, so the
 * pair is a delivery report rather than an intention.
 */
export const callPagingStartedDataSchema = z.object({
	/** The pager's own leg — the party talking. */
	legId: z.uuid(),
	/** `paging_group.id`. */
	pagingGroupId: z.uuid(),
	pagingGroupName: z.string().max(128),
	/** The dial code that opened it, e.g. `*81` plus the group's number. */
	dialed: dialStringSchema.optional(),
	pagerExtension: dialStringSchema.optional(),
	/** Members the page was offered to. */
	memberCount: z.int().min(0),
	/** Members whose handset came up. */
	answeredCount: z.int().min(0),
	/**
	 * False for a talkback page, where members can answer back.
	 *
	 * Required rather than defaulted, because the publisher always knows: it is compiled onto the
	 * paging node and the engine read it in order to decide which way to point the audio. A default
	 * here would let a producer that forgot the field report a one-way announcement for a page the
	 * whole warehouse could talk over.
	 */
	oneWay: z.boolean(),
});

/** `call.paging.ended` — the announcement finished and its bridge went away. */
export const callPagingEndedDataSchema = z.object({
	legId: z.uuid(),
	pagingGroupId: z.uuid(),
	pagingGroupName: z.string().max(128),
	/** How long the page was open. */
	durationMs: z.int().min(0).optional(),
	/** Members still connected when it ended, for the "did anybody hang up early?" question. */
	answeredCount: z.int().min(0).optional(),
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
	"conference.participant.updated": defineEvent(
		"call",
		"conference.participant.updated",
		conferenceParticipantUpdatedDataSchema,
	),
	"conference.locked": defineEvent("call", "conference.locked", conferenceLockChangedDataSchema),
	"conference.unlocked": defineEvent(
		"call",
		"conference.unlocked",
		conferenceLockChangedDataSchema,
	),
	"call.parked": defineEvent("call", "call.parked", callParkedDataSchema),
	"call.unparked": defineEvent("call", "call.unparked", callUnparkedDataSchema),
	"call.transferred": defineEvent("call", "call.transferred", callTransferredDataSchema),
	"call.picked-up": defineEvent("call", "call.picked-up", callPickedUpDataSchema),
	"call.emergency.dialed": defineEvent(
		"call",
		"call.emergency.dialed",
		callEmergencyDialedDataSchema,
	),
	"call.tap.started": defineEvent("call", "call.tap.started", callTapStartedDataSchema),
	"call.tap.ended": defineEvent("call", "call.tap.ended", callTapEndedDataSchema),
	"call.paging.started": defineEvent("call", "call.paging.started", callPagingStartedDataSchema),
	"call.paging.ended": defineEvent("call", "call.paging.ended", callPagingEndedDataSchema),
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
	CALL_EVENT_DEFINITIONS["conference.participant.updated"].envelope,
	CALL_EVENT_DEFINITIONS["conference.locked"].envelope,
	CALL_EVENT_DEFINITIONS["conference.unlocked"].envelope,
	CALL_EVENT_DEFINITIONS["call.parked"].envelope,
	CALL_EVENT_DEFINITIONS["call.unparked"].envelope,
	CALL_EVENT_DEFINITIONS["call.transferred"].envelope,
	CALL_EVENT_DEFINITIONS["call.picked-up"].envelope,
	CALL_EVENT_DEFINITIONS["call.emergency.dialed"].envelope,
	CALL_EVENT_DEFINITIONS["call.tap.started"].envelope,
	CALL_EVENT_DEFINITIONS["call.tap.ended"].envelope,
	CALL_EVENT_DEFINITIONS["call.paging.started"].envelope,
	CALL_EVENT_DEFINITIONS["call.paging.ended"].envelope,
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
