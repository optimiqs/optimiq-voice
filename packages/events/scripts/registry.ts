import { z } from "zod";
import { AUDIT_EVENT_DEFINITIONS } from "../src/schemas/audit-events";
import { CALL_EVENT_DEFINITIONS } from "../src/schemas/call-events";
import { CDR_EVENT_DEFINITIONS } from "../src/schemas/cdr-events";
import { baseEventEnvelopeSchema } from "../src/schemas/envelope";
import { MEDIA_EVENT_DEFINITIONS } from "../src/schemas/media-events";
import { PROVISION_EVENT_DEFINITIONS } from "../src/schemas/provision-events";
import { QUEUE_EVENT_DEFINITIONS } from "../src/schemas/queue-events";
import { REGISTRATION_EVENT_DEFINITIONS } from "../src/schemas/registration-events";
import { RPC_CONTRACTS } from "../src/schemas/rpc";
import {
	agentStatusSchema,
	bridgeModeSchema,
	callDirectionSchema,
	dtmfSourceSchema,
	hangupSideSchema,
	legSideSchema,
	recordingKindSchema,
	recordingStopReasonSchema,
	sipTransportSchema,
	tapEndReasonSchema,
	tapModeSchema,
} from "../src/schemas/telephony";
import { VOICEMAIL_EVENT_DEFINITIONS } from "../src/schemas/voicemail-events";
import type { EventFamily } from "../src/subjects";

/**
 * The CODEGEN REGISTRY: the explicit, hand-maintained list of what crosses the language border
 * and what each artefact is called on the Go side.
 *
 * Everything here is a pointer into `src/` — this file adds no contract, it only names things.
 * Go names are declared rather than derived because a derived name silently changes when a Zod
 * export is renamed, and a silently renamed public Go symbol is a broken build in `apps/sipd`
 * that the drift gate would happily wave through.
 *
 * Adding an event: add one entry to `EVENT_ENTRIES`. Adding a closed vocabulary that deserves a
 * named Go type instead of an inline one: add one entry to `NAMED_ENUMS`.
 */

/** A closed string vocabulary that gets its own Go named type + constants. */
export interface NamedEnum {
	/** Go type name. Idiomatic Go initialisms, so it does not always match the TS type name. */
	readonly goName: string;
	/** Source file the values come from, for the generated doc comment. */
	readonly source: string;
	readonly doc: string;
	readonly values: readonly string[];
}

function enumValues(schema: z.ZodEnum<Record<string, string>>): readonly string[] {
	return Object.values(schema.def.entries);
}

/**
 * Vocabularies from `src/schemas/telephony.ts`. Matched against inline `{type,enum}` subschemas
 * by exact value-set equality, so a payload field that uses one of them gets the named Go type
 * instead of a per-field duplicate.
 */
export const NAMED_ENUMS: readonly NamedEnum[] = [
	{
		goName: "LegSide",
		source: "telephony.ts LEG_SIDES",
		doc: "A-leg is the originating/inbound side; B-leg is every leg the engine originated for it.",
		values: enumValues(legSideSchema),
	},
	{
		goName: "CallDirection",
		source: "telephony.ts CALL_DIRECTIONS",
		doc: "Direction as the organization sees it, not as the switch sees it.",
		values: enumValues(callDirectionSchema),
	},
	{
		goName: "HangupSide",
		source: "telephony.ts HANGUP_SIDES",
		doc: "Which side tore the call down; system covers engine/media timeouts and admin hangups.",
		values: enumValues(hangupSideSchema),
	},
	{
		goName: "BridgeMode",
		source: "telephony.ts BRIDGE_MODES",
		doc: "Bridge modes, from plans/reference/freeswitch-capabilities.md §1.",
		values: enumValues(bridgeModeSchema),
	},
	{
		goName: "DTMFSource",
		source: "telephony.ts DTMF_SOURCES",
		doc: "DTMF transports, from the frozen reference §4.",
		values: enumValues(dtmfSourceSchema),
	},
	{
		goName: "RecordingKind",
		source: "telephony.ts RECORDING_KINDS",
		doc: "What produced a stored media object.",
		values: enumValues(recordingKindSchema),
	},
	{
		goName: "RecordingStopReason",
		source: "telephony.ts RECORDING_STOP_REASONS",
		doc: "How a recording ended.",
		values: enumValues(recordingStopReasonSchema),
	},
	{
		goName: "SIPTransport",
		source: "telephony.ts SIP_TRANSPORTS",
		doc: "SIP transports the edge accepts.",
		values: enumValues(sipTransportSchema),
	},
	{
		goName: "AgentStatus",
		source: "telephony.ts AGENT_STATUSES",
		doc: "ACD agent status. Drives queue distribution and the wallboard.",
		values: enumValues(agentStatusSchema),
	},
	{
		goName: "TapMode",
		source: "telephony.ts TAP_MODES",
		doc: "What a supervisor is doing to a call they did not place: eavesdrop, whisper or barge.",
		values: enumValues(tapModeSchema),
	},
	{
		goName: "TapEndReason",
		source: "telephony.ts TAP_END_REASONS",
		doc: "How a supervisor's tap ended. Distinguishes the monitored call ending from the supervisor leaving.",
		values: enumValues(tapEndReasonSchema),
	},
];

/** One event type's contract: subject family, envelope `type`, payload schema, Go names. */
export interface EventEntry {
	readonly family: EventFamily;
	/** Envelope `type` discriminator. Unique within its family only. */
	readonly type: string;
	/** Go struct name for the PAYLOAD. The envelope is the hand-written generic `Envelope[T]`. */
	readonly goName: string;
	/** Go constant name for the `type` string. */
	readonly goConst: string;
	/** The payload schema. */
	readonly data: z.ZodType;
	/** Subject template with `<…>` placeholders, for the manifest and the generated doc comment. */
	readonly subjectTemplate: string;
}

function callEntry(type: keyof typeof CALL_EVENT_DEFINITIONS, goName: string): EventEntry {
	return {
		family: "call",
		type,
		goName: `${goName}Data`,
		goConst: `EventType${goName}`,
		data: CALL_EVENT_DEFINITIONS[type].data,
		subjectTemplate: `calls.evt.v1.<orgId>.<callId>.${type}`,
	};
}

function registrationEntry(
	type: keyof typeof REGISTRATION_EVENT_DEFINITIONS,
	goName: string,
): EventEntry {
	return {
		family: "registration",
		type,
		goName: `${goName}Data`,
		goConst: `EventType${goName}`,
		data: REGISTRATION_EVENT_DEFINITIONS[type].data,
		subjectTemplate: `sip.reg.v1.<orgId>.<aorHash>.${type}`,
	};
}

function queueEntry(type: keyof typeof QUEUE_EVENT_DEFINITIONS, goName: string): EventEntry {
	return {
		family: "queue",
		type,
		goName: `${goName}Data`,
		goConst: `EventType${goName}`,
		data: QUEUE_EVENT_DEFINITIONS[type].data,
		subjectTemplate: `queue.evt.v1.<orgId>.<queueId>.${type}`,
	};
}

function voicemailEntry(
	type: keyof typeof VOICEMAIL_EVENT_DEFINITIONS,
	goName: string,
): EventEntry {
	return {
		family: "voicemail",
		type,
		goName: `${goName}Data`,
		goConst: `EventType${goName}`,
		data: VOICEMAIL_EVENT_DEFINITIONS[type].data,
		subjectTemplate: `voicemail.evt.v1.<orgId>.<mailboxId>.${type}`,
	};
}

function mediaEntry(type: keyof typeof MEDIA_EVENT_DEFINITIONS, goName: string): EventEntry {
	return {
		family: "media",
		type,
		goName: `${goName}Data`,
		goConst: `EventType${goName}`,
		data: MEDIA_EVENT_DEFINITIONS[type].data,
		subjectTemplate: `media.evt.v1.<orgId>.<sessionId>.${type}`,
	};
}

function provisionEntry(
	type: keyof typeof PROVISION_EVENT_DEFINITIONS,
	goName: string,
): EventEntry {
	return {
		family: "provision",
		type,
		goName: `${goName}Data`,
		goConst: `EventType${goName}`,
		data: PROVISION_EVENT_DEFINITIONS[type].data,
		subjectTemplate: "provision.evt.v1.<orgId>",
	};
}

/**
 * Every event that crosses the language border, in emit order. Order is part of the contract:
 * it is the order fields appear in the generated files, so a stable order keeps diffs readable.
 */
export const EVENT_ENTRIES: readonly EventEntry[] = [
	callEntry("channel.created", "ChannelCreated"),
	callEntry("channel.ringing", "ChannelRinging"),
	callEntry("channel.early-media", "ChannelEarlyMedia"),
	callEntry("channel.answered", "ChannelAnswered"),
	callEntry("channel.bridged", "ChannelBridged"),
	callEntry("channel.unbridged", "ChannelUnbridged"),
	callEntry("channel.held", "ChannelHeld"),
	callEntry("channel.unheld", "ChannelUnheld"),
	callEntry("channel.dtmf", "ChannelDTMF"),
	callEntry("channel.record.started", "ChannelRecordStarted"),
	callEntry("channel.record.stopped", "ChannelRecordStopped"),
	callEntry("channel.hangup", "ChannelHangup"),
	callEntry("channel.destroyed", "ChannelDestroyed"),
	callEntry("conference.joined", "ConferenceJoined"),
	callEntry("conference.left", "ConferenceLeft"),
	callEntry("call.parked", "CallParked"),
	callEntry("call.unparked", "CallUnparked"),
	callEntry("call.transferred", "CallTransferred"),
	callEntry("call.picked-up", "CallPickedUp"),
	callEntry("call.emergency.dialed", "CallEmergencyDialed"),
	callEntry("call.tap.started", "CallTapStarted"),
	callEntry("call.tap.ended", "CallTapEnded"),
	callEntry("call.paging.started", "CallPagingStarted"),
	callEntry("call.paging.ended", "CallPagingEnded"),

	registrationEntry("registered", "RegistrationRegistered"),
	registrationEntry("unregistered", "RegistrationUnregistered"),
	registrationEntry("expired", "RegistrationExpired"),

	queueEntry("caller.joined", "QueueCallerJoined"),
	queueEntry("caller.answered", "QueueCallerAnswered"),
	queueEntry("caller.abandoned", "QueueCallerAbandoned"),
	queueEntry("agent.state", "QueueAgentState"),

	voicemailEntry("message.left", "VoicemailMessageLeft"),
	voicemailEntry("mwi.updated", "VoicemailMWIUpdated"),

	mediaEntry("session.ended", "MediaSessionEnded"),
	mediaEntry("session.rtp-timeout", "MediaSessionRTPTimeout"),
	mediaEntry("playback.finished", "MediaPlaybackFinished"),
	mediaEntry("recording.finished", "MediaRecordingFinished"),
	mediaEntry("dtmf.received", "MediaDtmfReceived"),

	{
		family: "cdr",
		type: "cdr.leg.write",
		goName: "CDRLegWriteData",
		goConst: "EventTypeCDRLegWrite",
		data: CDR_EVENT_DEFINITIONS["cdr.leg.write"].data,
		subjectTemplate: "cdr.leg.v1.<orgId>",
	},
	{
		family: "audit",
		type: "audit.recorded",
		goName: "AuditRecordedData",
		goConst: "EventTypeAuditRecorded",
		data: AUDIT_EVENT_DEFINITIONS["audit.recorded"].data,
		subjectTemplate: "audit.evt.v1.<orgId>",
	},

	provisionEntry("device.requested", "ProvisionDeviceRequested"),
	provisionEntry("device.rendered", "ProvisionDeviceRendered"),
	provisionEntry("device.rejected", "ProvisionDeviceRejected"),
];

/** One request-reply contract: the subject plus its request/response pair. */
export interface RpcEntry {
	readonly subject: string;
	readonly goName: string;
	readonly timeoutMs: number;
	readonly request: z.ZodType;
	readonly response: z.ZodType;
}

export const RPC_ENTRIES: readonly RpcEntry[] = [
	{
		subject: "rpc.routing.v1.resolve",
		goName: "RoutingResolve",
		timeoutMs: RPC_CONTRACTS["rpc.routing.v1.resolve"].timeoutMs,
		request: RPC_CONTRACTS["rpc.routing.v1.resolve"].request,
		response: RPC_CONTRACTS["rpc.routing.v1.resolve"].response,
	},
	{
		subject: "rpc.authz.v1.check",
		goName: "AuthzCheck",
		timeoutMs: RPC_CONTRACTS["rpc.authz.v1.check"].timeoutMs,
		request: RPC_CONTRACTS["rpc.authz.v1.check"].request,
		response: RPC_CONTRACTS["rpc.authz.v1.check"].response,
	},
	{
		subject: "rpc.voicemail.v1.list",
		goName: "VoicemailList",
		timeoutMs: RPC_CONTRACTS["rpc.voicemail.v1.list"].timeoutMs,
		request: RPC_CONTRACTS["rpc.voicemail.v1.list"].request,
		response: RPC_CONTRACTS["rpc.voicemail.v1.list"].response,
	},
	// The handset's own feature state, and the `*69` lookup behind it. Both are TypeScript on both
	// ends today, so these structs are documentation rather than a wire contract — emitted anyway,
	// because the emitter's rule is "every RPC subject", and a subject that quietly opted out would
	// be the one nobody notices is missing when a Go caller for it appears.
	{
		subject: "rpc.pbx.v1.extension-feature",
		goName: "ExtensionFeature",
		timeoutMs: RPC_CONTRACTS["rpc.pbx.v1.extension-feature"].timeoutMs,
		request: RPC_CONTRACTS["rpc.pbx.v1.extension-feature"].request,
		response: RPC_CONTRACTS["rpc.pbx.v1.extension-feature"].response,
	},
	{
		subject: "rpc.pbx.v1.last-caller",
		goName: "LastCaller",
		timeoutMs: RPC_CONTRACTS["rpc.pbx.v1.last-caller"].timeoutMs,
		request: RPC_CONTRACTS["rpc.pbx.v1.last-caller"].request,
		response: RPC_CONTRACTS["rpc.pbx.v1.last-caller"].response,
	},
	{
		subject: "rpc.pbx.v1.file-greeting",
		goName: "FileGreeting",
		timeoutMs: RPC_CONTRACTS["rpc.pbx.v1.file-greeting"].timeoutMs,
		request: RPC_CONTRACTS["rpc.pbx.v1.file-greeting"].request,
		response: RPC_CONTRACTS["rpc.pbx.v1.file-greeting"].response,
	},
	{
		subject: "rpc.sip.v1.credential",
		goName: "SipCredential",
		timeoutMs: RPC_CONTRACTS["rpc.sip.v1.credential"].timeoutMs,
		request: RPC_CONTRACTS["rpc.sip.v1.credential"].request,
		response: RPC_CONTRACTS["rpc.sip.v1.credential"].response,
	},
	// The SIP edge's transfer command. The mirror image of the entry above it: same Go caller
	// (apps/sipd), but the request is a phone's REFER and the responder is the ENGINE rather than
	// the API. Emitted for the same reason the credential pair is — the Go side speaks the payload
	// and nothing else, so these structs are the wire.
	{
		subject: "rpc.sip.v1.transfer",
		goName: "SipTransfer",
		timeoutMs: RPC_CONTRACTS["rpc.sip.v1.transfer"].timeoutMs,
		request: RPC_CONTRACTS["rpc.sip.v1.transfer"].request,
		response: RPC_CONTRACTS["rpc.sip.v1.transfer"].response,
	},
	// The media plane. Unlike every entry above, the RESPONDER for these is Go: apps/mediad
	// unmarshals the generated request structs and marshals the generated response ones, which is
	// what makes the emitted code a contract rather than documentation.
	{
		subject: "rpc.media.v1.allocate-session",
		goName: "MediaAllocateSession",
		timeoutMs: RPC_CONTRACTS["rpc.media.v1.allocate-session"].timeoutMs,
		request: RPC_CONTRACTS["rpc.media.v1.allocate-session"].request,
		response: RPC_CONTRACTS["rpc.media.v1.allocate-session"].response,
	},
	{
		subject: "rpc.media.v1.bridge-sessions",
		goName: "MediaBridgeSessions",
		timeoutMs: RPC_CONTRACTS["rpc.media.v1.bridge-sessions"].timeoutMs,
		request: RPC_CONTRACTS["rpc.media.v1.bridge-sessions"].request,
		response: RPC_CONTRACTS["rpc.media.v1.bridge-sessions"].response,
	},
	{
		subject: "rpc.media.v1.unbridge-sessions",
		goName: "MediaUnbridgeSessions",
		timeoutMs: RPC_CONTRACTS["rpc.media.v1.unbridge-sessions"].timeoutMs,
		request: RPC_CONTRACTS["rpc.media.v1.unbridge-sessions"].request,
		response: RPC_CONTRACTS["rpc.media.v1.unbridge-sessions"].response,
	},
	{
		subject: "rpc.media.v1.release-session",
		goName: "MediaReleaseSession",
		timeoutMs: RPC_CONTRACTS["rpc.media.v1.release-session"].timeoutMs,
		request: RPC_CONTRACTS["rpc.media.v1.release-session"].request,
		response: RPC_CONTRACTS["rpc.media.v1.release-session"].response,
	},
	{
		subject: "rpc.media.v1.start-playback",
		goName: "MediaStartPlayback",
		timeoutMs: RPC_CONTRACTS["rpc.media.v1.start-playback"].timeoutMs,
		request: RPC_CONTRACTS["rpc.media.v1.start-playback"].request,
		response: RPC_CONTRACTS["rpc.media.v1.start-playback"].response,
	},
	{
		subject: "rpc.media.v1.stop-playback",
		goName: "MediaStopPlayback",
		timeoutMs: RPC_CONTRACTS["rpc.media.v1.stop-playback"].timeoutMs,
		request: RPC_CONTRACTS["rpc.media.v1.stop-playback"].request,
		response: RPC_CONTRACTS["rpc.media.v1.stop-playback"].response,
	},
	{
		subject: "rpc.media.v1.send-dtmf",
		goName: "MediaSendDtmf",
		timeoutMs: RPC_CONTRACTS["rpc.media.v1.send-dtmf"].timeoutMs,
		request: RPC_CONTRACTS["rpc.media.v1.send-dtmf"].request,
		response: RPC_CONTRACTS["rpc.media.v1.send-dtmf"].response,
	},
	{
		subject: "rpc.media.v1.start-recording",
		goName: "MediaStartRecording",
		timeoutMs: RPC_CONTRACTS["rpc.media.v1.start-recording"].timeoutMs,
		request: RPC_CONTRACTS["rpc.media.v1.start-recording"].request,
		response: RPC_CONTRACTS["rpc.media.v1.start-recording"].response,
	},
	{
		subject: "rpc.media.v1.stop-recording",
		goName: "MediaStopRecording",
		timeoutMs: RPC_CONTRACTS["rpc.media.v1.stop-recording"].timeoutMs,
		request: RPC_CONTRACTS["rpc.media.v1.stop-recording"].request,
		response: RPC_CONTRACTS["rpc.media.v1.stop-recording"].response,
	},
	// Supervision. The one media pair emitted BEFORE its responder exists: `mediad` refuses the
	// operation today (asymmetric routing is a mix, which is rung 6) and the Go structs are emitted
	// anyway, because the whole argument for declaring the full shape now — see
	// `plans/mediad-design.md` §10 question 4 — is that the rung-6 mixer must be able to satisfy
	// this contract by arriving rather than by renegotiating it.
	{
		subject: "rpc.media.v1.tap-session",
		goName: "MediaTapSession",
		timeoutMs: RPC_CONTRACTS["rpc.media.v1.tap-session"].timeoutMs,
		request: RPC_CONTRACTS["rpc.media.v1.tap-session"].request,
		response: RPC_CONTRACTS["rpc.media.v1.tap-session"].response,
	},
	{
		subject: "rpc.media.v1.untap-session",
		goName: "MediaUntapSession",
		timeoutMs: RPC_CONTRACTS["rpc.media.v1.untap-session"].timeoutMs,
		request: RPC_CONTRACTS["rpc.media.v1.untap-session"].request,
		response: RPC_CONTRACTS["rpc.media.v1.untap-session"].response,
	},
	// Control plane to engine: click-to-call. No Go participant today either, and emitted for the
	// same reason the entry below it is — the Go side reads the same taxonomy, and a subject the
	// generated package does not name reads as a subject that does not exist.
	{
		subject: "rpc.engine.v1.originate",
		goName: "Originate",
		timeoutMs: RPC_CONTRACTS["rpc.engine.v1.originate"].timeoutMs,
		request: RPC_CONTRACTS["rpc.engine.v1.originate"].request,
		response: RPC_CONTRACTS["rpc.engine.v1.originate"].response,
	},
	// Engine to engine, and the only subject here whose emitted constant is a PREFIX: the wire
	// subject appends the owning instance's token. Emitted anyway, because the Go side reads the
	// same taxonomy and a missing entry reads as "this subject does not exist".
	{
		subject: "rpc.engine.v1.park-handoff",
		goName: "ParkHandoff",
		timeoutMs: RPC_CONTRACTS["rpc.engine.v1.park-handoff"].timeoutMs,
		request: RPC_CONTRACTS["rpc.engine.v1.park-handoff"].request,
		response: RPC_CONTRACTS["rpc.engine.v1.park-handoff"].response,
	},
];

/** The base envelope, emitted as JSON Schema only — its Go form is hand-written `Envelope[T]`. */
export const ENVELOPE_SCHEMA = baseEventEnvelopeSchema;

/** Every family that has at least one entry, in emit order. */
export const FAMILY_ORDER: readonly EventFamily[] = [
	"call",
	"registration",
	"queue",
	"voicemail",
	"media",
	"cdr",
	"audit",
	"provision",
];

/** Go file basename per family (without the `_gen.go` suffix). */
export const FAMILY_FILE: Readonly<Record<EventFamily, string>> = {
	call: "call_events",
	registration: "registration_events",
	queue: "queue_events",
	voicemail: "voicemail_events",
	media: "media_events",
	cdr: "cdr_events",
	audit: "audit_events",
	provision: "provision_events",
};
