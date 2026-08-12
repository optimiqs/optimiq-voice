import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createEntityId } from "@optimiq-voice/identifiers";
import { EventValidationError } from "../errors";
import { parseSubjectOrThrow, QUEUE_SCOPE_ALL, subjectFor } from "../subjects";
import { makeAuditEvent } from "./audit-events";
import { CALL_EVENT_DEFINITIONS, callEventSchema, makeCallEvent } from "./call-events";
import { cdrEventSchema, makeCdrLegWriteEvent } from "./cdr-events";
import { baseEventEnvelopeSchema, defineEvent, makeEvent } from "./envelope";
import { contactsOf, registrationBindingSchema } from "./live-state";
import { makeProvisionEvent, provisionEventSchema } from "./provision-events";
import { makeQueueEvent, queueEventSchema } from "./queue-events";
import { makeRegistrationEvent, registrationEventSchema } from "./registration-events";
import {
	AUTHZ_CHECK_RPC,
	SESSION_ANNOUNCE_RPC,
	SESSION_VERB_RPC,
	SESSION_VERBS,
	FILE_GREETING_RPC,
	ORIGINATE_REFUSAL_REASONS,
	ORIGINATE_RPC,
	ROUTING_RESOLVE_RPC,
	SIP_ANSWER_RPC,
	SIP_DIALOG_REFUSAL_REASONS,
	SIP_HANGUP_RPC,
	SIP_INVITE_REFUSAL_REASONS,
	SIP_INVITE_RPC,
	SIP_ORIGINATE_RPC,
	SIP_RING_RPC,
	SIP_TRANSFER_REFUSAL_REASONS,
	SIP_TRANSFER_RPC,
	sipDialTargetSchema,
	VOICEMAIL_LIST_RPC,
} from "./rpc";
import {
	makeSipDialogEvent,
	SIP_TERMINATION_REASONS,
	sipDialogEventSchema,
} from "./sip-dialog-events";

const ORG = createEntityId();
const CALL = createEntityId();
const LEG = createEntityId();
const QUEUE = createEntityId();
const AT = "2026-08-05T10:00:00.000Z";

describe("base envelope", () => {
	const definition = defineEvent("call", "channel.ringing", z.object({ legId: z.uuid() }));

	it("fills id and at when omitted", () => {
		const before = Date.now();
		const event = makeEvent(definition, {
			orgId: ORG,
			subject: subjectFor.call(ORG, CALL, "channel.ringing"),
			source: "engine",
			data: { legId: LEG },
		});
		expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(Date.parse(event.at)).toBeGreaterThanOrEqual(before - 1000);
		expect(event.type).toBe("channel.ringing");
	});

	it("keeps a supplied id so a retry stays idempotent", () => {
		const id = createEntityId();
		const event = makeEvent(definition, {
			id,
			at: new Date(AT),
			orgId: ORG,
			subject: subjectFor.call(ORG, CALL, "channel.ringing"),
			source: "engine",
			data: { legId: LEG },
		});
		expect(event.id).toBe(id);
		expect(event.at).toBe(AT);
	});

	it.each([
		["a non-v7 id", { id: "6f9619ff-8b86-d011-b42d-00c04fc964ff" }],
		["a non-uuid org", { orgId: "acme" }],
		["a local timestamp", { at: "2026-08-05T10:00:00+02:00" }],
		["an empty source", { source: "" }],
		["a shouty source", { source: "Engine" }],
	])("rejects %s", (_label, override) => {
		expect(() =>
			makeEvent(definition, {
				orgId: ORG,
				subject: subjectFor.call(ORG, CALL, "channel.ringing"),
				source: "engine",
				data: { legId: LEG },
				...override,
			}),
		).toThrow(EventValidationError);
	});

	it("strips unknown top-level keys instead of failing (forward compatibility)", () => {
		const parsed = baseEventEnvelopeSchema.parse({
			id: createEntityId(),
			at: AT,
			orgId: ORG,
			subject: subjectFor.audit(ORG),
			type: "audit.recorded",
			source: "api",
			data: {},
			regionHint: "eu-west-1",
		});
		expect("regionHint" in parsed).toBe(false);
	});

	it("carries optional trace and correlation ids", () => {
		const event = makeEvent(definition, {
			orgId: ORG,
			subject: subjectFor.call(ORG, CALL, "channel.ringing"),
			source: "engine",
			data: { legId: LEG },
			traceId: "0af7651916cd43dd8448eb211c80319c",
			correlationId: CALL,
		});
		expect(event.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
		expect(event.correlationId).toBe(CALL);
	});
});

describe("call events", () => {
	it("derives the subject from org, call and type", () => {
		const event = makeCallEvent("channel.hangup", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: { legId: LEG, cause: "LOSE_RACE", causeCode: 702, side: "system" },
		});
		expect(event.subject).toBe(`calls.evt.v1.${ORG}.${CALL}.channel.hangup`);
		const parsed = parseSubjectOrThrow(event.subject);
		if (parsed.kind !== "call") throw new Error("unreachable");
		expect(parsed.callId).toBe(CALL);
	});

	it("defines one contract per event in the vocabulary", () => {
		for (const [type, definition] of Object.entries(CALL_EVENT_DEFINITIONS)) {
			expect(definition.type).toBe(type as never);
			expect(definition.family).toBe("call");
		}
	});

	it("validates a created event end to end", () => {
		const event = makeCallEvent("channel.created", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: {
				legId: LEG,
				leg: "a",
				direction: "inbound",
				from: { number: "+15551230000", name: "ACME" },
				to: { number: "1001" },
				routingContext: "public",
				sipCallId: "abc@1.2.3.4",
			},
		});
		expect(callEventSchema.parse(event)).toEqual(event);
	});

	it("round-trips through JSON unchanged", () => {
		const event = makeCallEvent("channel.bridged", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: { legId: LEG, peerLegId: createEntityId(), bridgeId: createEntityId(), mode: "media" },
		});
		expect(callEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
	});

	it("bounds a park with the slot somebody dials to collect it", () => {
		const lot = createEntityId();
		const parked = makeCallEvent("call.parked", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: { legId: LEG, parkLotId: lot, slot: "401", timeoutMs: 120_000, mohClass: "default" },
		});
		const unparked = makeCallEvent("call.unparked", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: {
				legId: LEG,
				parkLotId: lot,
				slot: "401",
				reason: "retrieved",
				retrievedByLegId: createEntityId(),
				durationMs: 8_000,
			},
		});
		expect(callEventSchema.parse(parked)).toEqual(parked);
		expect(callEventSchema.parse(unparked)).toEqual(unparked);
	});

	it("names the transferee as the transfer's own leg, and both other parties beside it", () => {
		const event = makeCallEvent("call.transferred", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: {
				legId: LEG,
				kind: "attended",
				destination: "1002",
				routingContext: "internal",
				transferorLegId: createEntityId(),
				targetLegId: createEntityId(),
			},
		});
		expect(callEventSchema.parse(event)).toEqual(event);
	});

	it("records a pickup as the picker, the caller taken over, and the phone left ringing", () => {
		const event = makeCallEvent("call.picked-up", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: {
				legId: LEG,
				pickedUpLegId: createEntityId(),
				kind: "directed",
				extension: "200",
				abandonedLegId: createEntityId(),
			},
		});
		expect(callEventSchema.parse(event)).toEqual(event);
	});

	it.each([
		[
			"an unknown bridge mode",
			"channel.bridged",
			{ legId: LEG, peerLegId: LEG, bridgeId: LEG, mode: "telepathy" },
		],
		[
			"a park that ended for a reason the vocabulary does not have",
			"call.unparked",
			{ legId: LEG, parkLotId: LEG, slot: "401", reason: "forgotten" },
		],
		["a transfer of an unknown kind", "call.transferred", { legId: LEG, kind: "warm" }],
		[
			"a pickup with no extension",
			"call.picked-up",
			{ legId: LEG, pickedUpLegId: LEG, kind: "group" },
		],
		[
			"a two-character DTMF digit",
			"channel.dtmf",
			{ legId: LEG, digit: "12", durationMs: 100, source: "rfc2833" },
		],
		[
			"a negative DTMF duration",
			"channel.dtmf",
			{ legId: LEG, digit: "1", durationMs: -1, source: "rfc2833" },
		],
		[
			"a lower-case hangup cause",
			"channel.hangup",
			{ legId: LEG, cause: "normal_clearing", causeCode: 16, side: "caller" },
		],
		[
			"an out-of-range cause code",
			"channel.hangup",
			{ legId: LEG, cause: "NORMAL_CLEARING", causeCode: 99_999, side: "caller" },
		],
		[
			"an unknown hangup side",
			"channel.hangup",
			{ legId: LEG, cause: "NORMAL_CLEARING", causeCode: 16, side: "network" },
		],
		["a missing legId", "channel.answered", {}],
		["a non-uuid legId", "channel.answered", { legId: "leg-1" }],
	])("rejects %s", (_label, type, data) => {
		expect(() =>
			// biome-ignore lint: the point of the case is that the payload is wrong.
			makeCallEvent(type as never, {
				orgId: ORG,
				callId: CALL,
				source: "engine",
				data: data as never,
			}),
		).toThrow(EventValidationError);
	});

	it("accepts a hangup cause this package has never heard of", () => {
		// The authority is cdr-db; events validates shape only, so a new carrier cause still flows.
		const event = makeCallEvent("channel.hangup", {
			orgId: ORG,
			callId: CALL,
			source: "engine",
			data: { legId: LEG, cause: "SOME_NEW_CARRIER_CAUSE", causeCode: 127, side: "callee" },
		});
		expect(event.data.cause).toBe("SOME_NEW_CARRIER_CAUSE");
	});

	it("discriminates the union on type", () => {
		const event = callEventSchema.parse(
			makeCallEvent("channel.dtmf", {
				orgId: ORG,
				callId: CALL,
				source: "engine",
				data: { legId: LEG, digit: "#", durationMs: 80, source: "rfc2833" },
			}),
		);
		if (event.type !== "channel.dtmf") throw new Error("unreachable");
		expect(event.data.digit).toBe("#");
	});
});

describe("registration events", () => {
	it("derives both the subject token and data.aorHash from the AOR", () => {
		const event = makeRegistrationEvent("registered", {
			orgId: ORG,
			source: "sipd",
			data: {
				aor: "sip:1001@acme.example.com",
				aorHash: "will-be-overwritten",
				contact: "sip:1001@10.0.0.5:5060;transport=udp",
				transport: "udp",
				expiresInSeconds: 3600,
				userAgent: "Yealink T46S",
			},
		});
		const parsed = parseSubjectOrThrow(event.subject);
		if (parsed.kind !== "registration") throw new Error("unreachable");
		expect(event.data.aorHash).toBe(parsed.aorHash);
		expect(registrationEventSchema.parse(event)).toEqual(event);
	});

	it.each([
		["an unknown transport", { transport: "carrier-pigeon" }],
		["a zero expiry", { expiresInSeconds: 0 }],
		["a missing contact", { contact: undefined }],
	])("rejects %s", (_label, override) => {
		expect(() =>
			makeRegistrationEvent("registered", {
				orgId: ORG,
				source: "sipd",
				data: {
					aor: "sip:1001@acme.example.com",
					aorHash: "x",
					contact: "sip:1001@10.0.0.5",
					transport: "udp",
					expiresInSeconds: 3600,
					...override,
				} as never,
			}),
		).toThrow(EventValidationError);
	});
});

describe("queue events", () => {
	it("builds a per-queue caller event", () => {
		const event = makeQueueEvent("caller.joined", {
			orgId: ORG,
			queueId: QUEUE,
			source: "engine",
			data: { callId: CALL, legId: LEG, position: 3, priority: 10 },
		});
		expect(event.subject).toBe(`queue.evt.v1.${ORG}.${QUEUE}.caller.joined`);
		expect(queueEventSchema.parse(event)).toEqual(event);
	});

	it("builds an org-wide agent-state event on the reserved scope", () => {
		const event = makeQueueEvent("agent.state", {
			orgId: ORG,
			queueId: QUEUE_SCOPE_ALL,
			source: "engine",
			data: { agentId: createEntityId(), status: "wrap-up", previousStatus: "on-call" },
		});
		expect(event.subject).toBe(`queue.evt.v1.${ORG}._all.agent.state`);
	});

	it("rejects an unknown agent status and a zero position", () => {
		expect(() =>
			makeQueueEvent("agent.state", {
				orgId: ORG,
				queueId: QUEUE,
				source: "engine",
				data: { agentId: createEntityId(), status: "vibing" } as never,
			}),
		).toThrow(EventValidationError);
		expect(() =>
			makeQueueEvent("caller.joined", {
				orgId: ORG,
				queueId: QUEUE,
				source: "engine",
				data: { callId: CALL, legId: LEG, position: 0, priority: 0 },
			}),
		).toThrow(EventValidationError);
	});
});

describe("cdr.leg.write", () => {
	const core = {
		id: createEntityId(),
		callId: CALL,
		leg: "a" as const,
		direction: "inbound" as const,
		fromNumber: "+15551230000",
		toNumber: "1001",
		destinationType: "extension",
		startedAt: AT,
		durationMs: 12_000,
		billsecMs: 9_000,
		hangupCause: "NORMAL_CLEARING",
		hangupCauseCode: 16,
		disposition: "answered",
	};

	it("mirrors the call_legs core and derives the org subject", () => {
		const event = makeCdrLegWriteEvent({ orgId: ORG, source: "engine", data: core });
		expect(event.subject).toBe(`cdr.leg.v1.${ORG}`);
		expect(cdrEventSchema.parse(event)).toEqual(event);
	});

	it("passes unknown columns through untouched", () => {
		const event = makeCdrLegWriteEvent({
			orgId: ORG,
			source: "engine",
			data: { ...core, mos: 4.31, raw: { sipDisposition: "200" }, someFutureColumn: "keep me" },
		});
		expect(event.data.someFutureColumn).toBe("keep me");
		expect(event.data.raw).toEqual({ sipDisposition: "200" });
	});

	it("accepts nullable late-arriving fields", () => {
		const event = makeCdrLegWriteEvent({
			orgId: ORG,
			source: "engine",
			data: { ...core, answeredAt: null, endedAt: AT, hangupSide: null, fromName: null },
		});
		expect(event.data.answeredAt).toBeNull();
	});

	it.each([
		["a non-v7 leg id", { id: "6f9619ff-8b86-d011-b42d-00c04fc964ff" }],
		["a missing partition key", { startedAt: undefined }],
		["a negative billsec", { billsecMs: -1 }],
		["an upper-case destination type", { destinationType: "EXTENSION" }],
		["an unknown direction", { direction: "sideways" }],
	])("rejects %s", (_label, override) => {
		expect(() =>
			makeCdrLegWriteEvent({
				orgId: ORG,
				source: "engine",
				data: { ...core, ...override } as never,
			}),
		).toThrow(EventValidationError);
	});
});

describe("audit events", () => {
	it("records a denied attempt", () => {
		const event = makeAuditEvent({
			orgId: ORG,
			source: "api",
			data: {
				actor: { type: "user", id: createEntityId(), ip: "203.0.113.7" },
				action: "extension.delete",
				resource: { type: "extension", id: createEntityId() },
				outcome: "denied",
				reason: "missing extension.delete permission",
			},
		});
		expect(event.subject).toBe(`audit.evt.v1.${ORG}`);
		expect(event.data.outcome).toBe("denied");
	});

	it("rejects an undotted action and an unknown outcome", () => {
		expect(() =>
			makeAuditEvent({
				orgId: ORG,
				source: "api",
				data: {
					actor: { type: "system" },
					action: "delete",
					resource: { type: "extension" },
					outcome: "allowed",
				},
			}),
		).toThrow(EventValidationError);
		expect(() =>
			makeAuditEvent({
				orgId: ORG,
				source: "api",
				data: {
					actor: { type: "system" },
					action: "extension.delete",
					resource: { type: "extension" },
					outcome: "maybe" as never,
				},
			}),
		).toThrow(EventValidationError);
	});
});

describe("provision events", () => {
	it("keeps the event name in the envelope, not the subject", () => {
		const event = makeProvisionEvent("device.rejected", {
			orgId: ORG,
			source: "api",
			data: { sourceAddress: "198.51.100.4:41234", reason: "invalid-token" },
		});
		expect(event.subject).toBe(`provision.evt.v1.${ORG}`);
		expect(event.type).toBe("device.rejected");
		expect(provisionEventSchema.parse(event)).toEqual(event);
	});

	it("normalises nothing — a separator-laden MAC is rejected", () => {
		expect(() =>
			makeProvisionEvent("device.requested", {
				orgId: ORG,
				source: "api",
				data: { sourceAddress: "198.51.100.4:41234", macAddress: "80:5e:c0:11:22:33" },
			}),
		).toThrow(EventValidationError);
	});

	it("accepts a normalised MAC", () => {
		const event = makeProvisionEvent("device.requested", {
			orgId: ORG,
			source: "api",
			data: { sourceAddress: "198.51.100.4:41234", macAddress: "805ec0112233", vendor: "yealink" },
		});
		expect(event.data.macAddress).toBe("805ec0112233");
	});
});

describe("rpc contracts", () => {
	it("pins the routing resolve contract to its subject", () => {
		expect(ROUTING_RESOLVE_RPC.subject).toBe("rpc.routing.v1.resolve");
		const request = ROUTING_RESOLVE_RPC.request.parse({
			orgId: ORG,
			direction: "inbound",
			destinationNumber: "+15551230000",
			routingContext: "public",
		});
		expect(request.routingContext).toBe("public");
		expect(ROUTING_RESOLVE_RPC.response.parse({ matched: false, reason: "no route" }).matched).toBe(
			false,
		);
	});

	it("requires a routing context (the toll-fraud boundary)", () => {
		expect(
			ROUTING_RESOLVE_RPC.request.safeParse({
				orgId: ORG,
				direction: "inbound",
				destinationNumber: "+15551230000",
			}).success,
		).toBe(false);
	});

	it("validates an authz check both ways", () => {
		expect(AUTHZ_CHECK_RPC.subject).toBe("rpc.authz.v1.check");
		expect(
			AUTHZ_CHECK_RPC.request.safeParse({
				orgId: ORG,
				subject: { type: "user", id: createEntityId() },
				permissions: ["extension.read"],
			}).success,
		).toBe(true);
		expect(
			AUTHZ_CHECK_RPC.request.safeParse({
				orgId: ORG,
				subject: { type: "user", id: createEntityId() },
				permissions: [],
			}).success,
		).toBe(false);
		expect(
			AUTHZ_CHECK_RPC.response.parse({ allowed: false, granted: [], missing: ["extension.read"] })
				.allowed,
		).toBe(false);
	});

	/**
	 * The session protocol's two contracts. Both subjects are PREFIXES on the wire, so what is
	 * pinned here is the prefix — the token that follows it is `subjects.spec.ts`'s business.
	 */
	it("pins the session announce contract, and its accept carries a session id", () => {
		expect(SESSION_ANNOUNCE_RPC.subject).toBe("rpc.session.v1.announce");
		const request = SESSION_ANNOUNCE_RPC.request.parse({
			orgId: ORG,
			application: "autopilot",
			callId: createEntityId(),
			legId: createEntityId(),
			instanceId: "engine-1",
			direction: "inbound",
			answered: false,
			at: new Date().toISOString(),
		});
		expect(request.answered).toBe(false);
		expect(
			SESSION_ANNOUNCE_RPC.response.parse({ accepted: false, reason: "no-application" }).accepted,
		).toBe(false);
	});

	/**
	 * The wire refuses a verb the executor does not implement, rather than accepting it and failing
	 * one hop later on a call that is already up.
	 */
	it("carries only the verbs the engine implements", () => {
		expect(SESSION_VERBS).toContain("dial");
		expect(SESSION_VERBS).toContain("bridge");
		expect(SESSION_VERBS).toContain("unbridge");
		for (const absent of ["say", "earlyMedia", "stream", "playbackControl"]) {
			expect(SESSION_VERBS).not.toContain(absent as never);
		}
		expect(
			SESSION_VERB_RPC.request.safeParse({
				orgId: ORG,
				sessionId: "s-1",
				callId: createEntityId(),
				legId: createEntityId(),
				verb: "say",
			}).success,
		).toBe(false);
	});

	it("validates a session verb both ways", () => {
		expect(SESSION_VERB_RPC.subject).toBe("rpc.engine.v1.session-verb");
		const request = SESSION_VERB_RPC.request.parse({
			orgId: ORG,
			sessionId: "s-1",
			callId: createEntityId(),
			legId: createEntityId(),
			verb: "gather",
			arguments: { maxDigits: 4, timeoutMs: 5_000, interDigitTimeoutMs: 2_000, terminators: ["#"] },
		});
		expect(request.arguments?.maxDigits).toBe(4);
		expect(
			SESSION_VERB_RPC.response.parse({
				ok: true,
				verb: "gather",
				instanceId: "engine-1",
				endReason: "completed",
				digits: ["1", "2"],
			}).digits,
		).toEqual(["1", "2"]);
	});

	it("refuses a DTMF terminator that is not one digit", () => {
		expect(
			SESSION_VERB_RPC.request.safeParse({
				orgId: ORG,
				sessionId: "s-1",
				callId: createEntityId(),
				legId: createEntityId(),
				verb: "gather",
				arguments: { terminators: ["##"] },
			}).success,
		).toBe(false);
	});

	it("pins the voicemail list contract to its subject", () => {
		expect(VOICEMAIL_LIST_RPC.subject).toBe("rpc.voicemail.v1.list");
	});

	it("defaults a voicemail list request to the new folder", () => {
		const request = VOICEMAIL_LIST_RPC.request.parse({
			orgId: ORG,
			voicemailBoxId: createEntityId(),
			mailboxNumber: "1001",
		});
		expect(request.folder).toBe("new");
		expect(request.limit).toBe(20);
	});

	it("caps a voicemail list so one mailbox cannot produce an unbounded reply", () => {
		expect(
			VOICEMAIL_LIST_RPC.request.safeParse({
				orgId: ORG,
				voicemailBoxId: createEntityId(),
				mailboxNumber: "1001",
				limit: 1_000,
			}).success,
		).toBe(false);
	});

	it("distinguishes an unreadable mailbox from an empty one", () => {
		// The whole reason `found` exists. "You have no messages" told to somebody who has nine is a
		// worse outcome than any error message, so the two states are separate fields rather than an
		// empty array standing for both.
		const unreadable = VOICEMAIL_LIST_RPC.response.parse({ found: false, reason: "no responder" });
		expect(unreadable.messages).toEqual([]);
		expect(unreadable.found).toBe(false);

		const empty = VOICEMAIL_LIST_RPC.response.parse({ found: true, messages: [], total: 0 });
		expect(empty.found).toBe(true);
	});

	it("validates a message summary the engine can actually play", () => {
		const response = VOICEMAIL_LIST_RPC.response.parse({
			found: true,
			total: 1,
			newCount: 1,
			messages: [
				{
					messageId: createEntityId(),
					folder: "new",
					objectKey: "org/vm-1/msg.wav",
					durationMs: 4_200,
					receivedAt: "2026-08-05T12:00:00.000Z",
					callerIdNumber: "+15551230000",
				},
			],
		});
		expect(response.messages[0]?.objectKey).toBe("org/vm-1/msg.wav");
	});

	it("refuses a message with no object key — there would be nothing to play", () => {
		expect(
			VOICEMAIL_LIST_RPC.response.safeParse({
				found: true,
				messages: [
					{
						messageId: createEntityId(),
						folder: "new",
						objectKey: "",
						durationMs: 1,
						receivedAt: "2026-08-05T12:00:00.000Z",
					},
				],
			}).success,
		).toBe(false);
	});

	it("pins the greeting-filing contract to its subject and defaults its slot", () => {
		expect(FILE_GREETING_RPC.subject).toBe("rpc.pbx.v1.file-greeting");
		const request = FILE_GREETING_RPC.request.parse({
			orgId: ORG,
			voicemailBoxId: createEntityId(),
			mailboxNumber: "1001",
			greetingId: createEntityId(),
			objectKey: `${ORG}/${CALL}/rec.wav`,
			durationMs: 4_200,
		});
		// `*99` is one code and the catalogue gives it no argument, so the slot it fills is a default
		// rather than something every caller has to remember to send.
		expect(request.kind).toBe("unavailable");
	});

	it("refuses a greeting with no audio in it", () => {
		// The floor is the rule the walk already applies: an ACTIVE greeting containing silence stops
		// a mailbox announcing itself and says nothing about why, so an empty recording is discarded
		// rather than filed. A zero arriving here is a caller that skipped that, and the schema is the
		// second place it cannot get through.
		expect(
			FILE_GREETING_RPC.request.safeParse({
				orgId: ORG,
				voicemailBoxId: createEntityId(),
				mailboxNumber: "1001",
				greetingId: createEntityId(),
				objectKey: `${ORG}/${CALL}/rec.wav`,
				durationMs: 0,
			}).success,
		).toBe(false);
	});

	it("separates a greeting that was stored from one that is being heard", () => {
		// `applied` and `active` are two fields for the same reason `applied` and `enabled` are on the
		// feature subject: a greeting that was filed and not activated is a different fact from one
		// that was not filed, and a runtime reading only the first would confirm a recording nobody
		// will ever hear.
		const refused = FILE_GREETING_RPC.response.parse({
			applied: false,
			kind: "unavailable",
			reason: "no such mailbox",
		});
		expect(refused.active).toBe(false);
	});
});

/** Drops keys from a fixture, so "this field is required" is asserted without an unused binding. */
function without<T extends object>(value: T, ...keys: readonly (keyof T)[]): Partial<T> {
	const copy: Partial<T> = { ...value };
	for (const key of keys) {
		delete copy[key];
	}
	return copy;
}

describe("the sip transfer contract", () => {
	const blind = () => ({
		orgId: ORG,
		sipCallId: "3c26700c1adf-6qgy0fkn7cvb",
		fromTag: "as58c1f2b3",
		toTag: "9f2a11",
		referredBy: { aor: "sip:1001@acme.example.com", username: "1001" },
		target: { user: "1002", host: "acme.example.com" },
		kind: "blind" as const,
		referCSeq: 3,
	});

	it("pins the subject and the deadline", () => {
		expect(SIP_TRANSFER_RPC.subject).toBe("rpc.sip.v1.transfer");
		// Longer than the credential RPC because it sits after the 202, not inside a transaction.
		expect(SIP_TRANSFER_RPC.timeoutMs).toBe(2_000);
	});

	it("accepts a blind transfer carrying only what the edge can actually know", () => {
		const request = SIP_TRANSFER_RPC.request.parse(blind());
		expect(request.kind).toBe("blind");
		expect(request.target.user).toBe("1002");
		expect(request.replaces).toBeUndefined();
	});

	it("keeps the dialog identifier optional beyond the Call-ID", () => {
		const rest = without(blind(), "fromTag", "toTag");
		expect(SIP_TRANSFER_RPC.request.safeParse(rest).success).toBe(true);
	});

	it("carries a parsed Replaces for an attended transfer, and defaults early-only to false", () => {
		const request = SIP_TRANSFER_RPC.request.parse({
			...blind(),
			kind: "attended",
			replaces: { callId: "aa11@1.2.3.4", toTag: "b2", fromTag: "c3" },
		});
		expect(request.replaces?.earlyOnly).toBe(false);
	});

	it("refuses a request with no Call-ID — there would be nothing to resolve", () => {
		expect(SIP_TRANSFER_RPC.request.safeParse({ ...blind(), sipCallId: "" }).success).toBe(false);
	});

	it("refuses a request with no dialable target", () => {
		expect(SIP_TRANSFER_RPC.request.safeParse({ ...blind(), target: { user: "" } }).success).toBe(
			false,
		);
	});

	it("refuses a referrer the edge could not have authenticated", () => {
		expect(SIP_TRANSFER_RPC.request.safeParse(without(blind(), "referredBy")).success).toBe(false);
	});

	it("refuses a transfer kind outside the closed vocabulary", () => {
		expect(SIP_TRANSFER_RPC.request.safeParse({ ...blind(), kind: "semi-attended" }).success).toBe(
			false,
		);
	});

	it("echoes the Call-ID on a refusal so a reply needs no per-request state to attribute", () => {
		const response = SIP_TRANSFER_RPC.response.parse({
			ok: false,
			sipCallId: "3c26700c1adf-6qgy0fkn7cvb",
			instanceId: "engine-1",
			reason: "correlation_unavailable",
			error: "this engine does not index SIP Call-IDs",
		});
		expect(response.ok).toBe(false);
		expect(response.reason).toBe("correlation_unavailable");
	});

	it("names every refusal the responder may send, in contract order", () => {
		expect([...SIP_TRANSFER_REFUSAL_REASONS]).toEqual([
			"bad_request",
			"unknown_dialog",
			"correlation_unavailable",
			"not_permitted",
			"wrong_instance",
			"unknown_target",
			"attended_unsupported",
			"channel_gone",
			"transfer_failed",
			"shutting_down",
			"internal",
		]);
	});

	it("refuses a reason outside that vocabulary", () => {
		expect(
			SIP_TRANSFER_RPC.response.safeParse({ ok: false, sipCallId: "a", reason: "computer_says_no" })
				.success,
		).toBe(false);
	});
});

describe("the originate contract", () => {
	const request = () => ({
		orgId: ORG,
		originateId: createEntityId(),
		fromExtension: "1001",
		to: "+15551230000",
	});

	it("pins the subject and the deadline", () => {
		expect(ORIGINATE_RPC.subject).toBe("rpc.engine.v1.originate");
		// The longest in the file: an extension resolve plus a channel creation, on a person's click.
		expect(ORIGINATE_RPC.timeoutMs).toBe(5_000);
	});

	it("accepts the two fields a dial button actually has", () => {
		const parsed = ORIGINATE_RPC.request.parse(request());
		expect(parsed.fromExtension).toBe("1001");
		expect(parsed.to).toBe("+15551230000");
		expect(parsed.ringTimeoutSeconds).toBeUndefined();
	});

	it("refuses a request with no dialable target", () => {
		expect(ORIGINATE_RPC.request.safeParse({ ...request(), to: "" }).success).toBe(false);
	});

	it("refuses an origination handle that is not a uuid — it becomes a channel id", () => {
		expect(ORIGINATE_RPC.request.safeParse({ ...request(), originateId: "call-1" }).success).toBe(
			false,
		);
	});

	it("refuses a ring timeout outside the bounds a held channel is worth", () => {
		expect(ORIGINATE_RPC.request.safeParse({ ...request(), ringTimeoutSeconds: 1 }).success).toBe(
			false,
		);
		expect(ORIGINATE_RPC.request.safeParse({ ...request(), ringTimeoutSeconds: 600 }).success).toBe(
			false,
		);
	});

	it("carries the engine's own call and leg ids on success, never the caller's", () => {
		const response = ORIGINATE_RPC.response.parse({
			ok: true,
			originateId: "019fd3c2-1111-76be-a6b3-b0f1914e39b6",
			instanceId: "engine-1",
			callId: "019fd3c2-2222-76be-a6b3-b0f1914e39b6",
			legId: "019fd3c2-3333-76be-a6b3-b0f1914e39b6",
			endpoint: "PJSIP/1001",
		});
		expect(response.callId).not.toBe(response.originateId);
		expect(response.endpoint).toBe("PJSIP/1001");
	});

	it("names every refusal the responder may send, in contract order", () => {
		expect([...ORIGINATE_REFUSAL_REASONS]).toEqual([
			"bad_request",
			"unknown_extension",
			"extension_offline",
			"invalid_target",
			"capacity",
			"not_supported",
			"shutting_down",
			"internal",
		]);
	});

	it("refuses a reason outside that vocabulary", () => {
		expect(
			ORIGINATE_RPC.response.safeParse({ ok: false, originateId: "a", reason: "no_dialtone" })
				.success,
		).toBe(false);
	});
});

describe("the sip invite contract", () => {
	const intent = {
		legId: LEG,
		sipdInstanceId: "sipd-7c9f",
		authentication: "trunk-acl" as const,
		routingContext: "inbound-untrusted",
		from: { number: "+441632960111" },
		to: { number: "+441632960100" },
		sipCallId: "a84b4c76e66710@pc33",
		hasOffer: true,
		sdpOffer: "v=0\r\no=- 1 1 IN IP4 203.0.113.7\r\n",
	};

	it("accepts a trunk INVITE with no tenant, because the engine resolves it", () => {
		const parsed = SIP_INVITE_RPC.request.parse(intent);
		expect(parsed.orgId).toBeUndefined();
		expect(parsed.hasOffer).toBe(true);
	});

	it("accepts a digest INVITE that names its tenant and its caller's canonical AOR", () => {
		const parsed = SIP_INVITE_RPC.request.parse({
			...intent,
			orgId: ORG,
			authentication: "digest",
			routingContext: "internal",
			from: { number: "1001", aor: "sip:1001@acme.example.com", name: "Ada Lovelace" },
			trunkId: undefined,
		});
		expect(parsed.orgId).toBe(ORG);
		expect(parsed.from.aor).toBe("sip:1001@acme.example.com");
	});

	it("carries the media hint, so a NAT latch is an expectation rather than a surprise", () => {
		const parsed = SIP_INVITE_RPC.request.parse({
			...intent,
			mediaHint: { signallingSource: "203.0.113.7:5060", advertisedMedia: "10.0.0.5" },
		});
		// Both booleans default rather than being optional: a hint that omitted them would make
		// "we did not look" and "they agree" the same value.
		expect(parsed.mediaHint?.mismatch).toBe(false);
		expect(parsed.mediaHint?.private).toBe(false);
	});

	it("carries a Replaces alongside the leg it already resolved", () => {
		const parsed = SIP_INVITE_RPC.request.parse({
			...intent,
			replaces: { callId: "other@pc33", toTag: "9f2a", fromTag: "31c8" },
			replacesLegId: CALL,
		});
		expect(parsed.replaces?.earlyOnly).toBe(false);
		expect(parsed.replacesLegId).toBe(CALL);
	});

	it("names every refusal the engine may send, in contract order", () => {
		// Each of these becomes a SIP status a STRANGER sees, and the table that maps them lives in
		// apps/sipd. Adding one here without adding a row there is a 500 on somebody's handset.
		expect([...SIP_INVITE_REFUSAL_REASONS]).toEqual([
			"unattributed",
			"unknown_target",
			"not_permitted",
			"congestion",
			"shutting_down",
			"bad_request",
			"internal",
		]);
	});

	it("refuses a reason outside that vocabulary", () => {
		expect(
			SIP_INVITE_RPC.response.safeParse({ ok: false, legId: LEG, reason: "no_dialtone" }).success,
		).toBe(false);
	});

	it("stays inside the deadline every RPC on this backbone is bounded by", () => {
		expect(SIP_INVITE_RPC.timeoutMs).toBeLessThanOrEqual(2_000);
	});
});

describe("the sipd command contracts", () => {
	it("answers a leg with a body, because a 200 with no answer is silence", () => {
		expect(SIP_ANSWER_RPC.request.safeParse({ legId: LEG }).success).toBe(false);
		expect(SIP_ANSWER_RPC.request.parse({ legId: LEG, sdpAnswer: "v=0\r\n" }).sdpAnswer).toBe(
			"v=0\r\n",
		);
	});

	it("rings without a body by default", () => {
		expect(SIP_RING_RPC.request.parse({ legId: LEG }).status).toBe(180);
	});

	it("takes a cause on hangup and never a method — the edge owns that choice", () => {
		const parsed = SIP_HANGUP_RPC.request.parse({ legId: LEG, cause: 16 });
		expect(parsed.cause).toBe(16);
		expect(parsed).not.toHaveProperty("method");
		// The REPLY reports what was actually sent, including the two RFC 3261 deferrals.
		expect(SIP_HANGUP_RPC.response.parse({ ok: true, legId: LEG, method: "deferred" }).method).toBe(
			"deferred",
		);
	});

	it("pairs a dial target's kind with the fields that kind requires", () => {
		expect(
			sipDialTargetSchema.safeParse({ kind: "aor", aor: "sip:1002@acme.example.com" }).success,
		).toBe(true);
		expect(
			sipDialTargetSchema.safeParse({ kind: "trunk", trunkId: ORG, number: "+44163" }).success,
		).toBe(true);
		// A kind whose fields are missing is the failure this refinement exists to catch: Go has no
		// sum type, so nothing above the wire would have caught it.
		expect(sipDialTargetSchema.safeParse({ kind: "trunk", trunkId: ORG }).success).toBe(false);
		expect(sipDialTargetSchema.safeParse({ kind: "aor", uri: "sip:x@y" }).success).toBe(false);
	});

	it("names every dialog refusal, in contract order", () => {
		expect([...SIP_DIALOG_REFUSAL_REASONS]).toEqual([
			"bad_request",
			"unknown_dialog",
			"wrong_instance",
			"dialog_gone",
			"invalid_state",
			"unregistered_target",
			"unknown_trunk",
			"no_route",
			"capacity",
			"shutting_down",
			"not_supported",
			"internal",
		]);
	});

	it("replies inside a second on every command, because a caller hears the wait", () => {
		for (const contract of [SIP_RING_RPC, SIP_ANSWER_RPC, SIP_HANGUP_RPC, SIP_ORIGINATE_RPC]) {
			expect(contract.timeoutMs).toBeLessThanOrEqual(1_000);
		}
	});
});

describe("sip dialog events", () => {
	const base = {
		legId: LEG,
		callId: CALL,
		instanceId: "sipd-7c9f",
		role: "uas" as const,
		identity: { sipCallId: "a84b4c76e66710@pc33", localTag: "9f2a" },
	};

	it("derives the subject from the payload's leg, so the two cannot disagree", () => {
		const event = makeSipDialogEvent("dialog.answered", {
			orgId: ORG,
			source: "sipd",
			data: base,
		});
		expect(event.subject).toBe(`sip.evt.v1.${ORG}.${LEG}.dialog.answered`);
		const parsed = parseSubjectOrThrow(event.subject);
		if (parsed.kind !== "sip-dialog") throw new Error("unreachable");
		expect(parsed.legId).toBe(event.data.legId);
	});

	it("carries a real Q.850 cause and says whether a Reason header supplied it", () => {
		const event = makeSipDialogEvent("dialog.terminated", {
			orgId: ORG,
			source: "sipd",
			data: {
				...base,
				reason: "rejected",
				cause: 17,
				status: 486,
				causeFromReasonHeader: true,
				initiator: "remote",
			},
		});
		expect(event.data.cause).toBe(17);
		// The far end's own switch told us; the status table would have said the same thing here and
		// will not always, which is the whole reason the flag exists.
		expect(event.data.causeFromReasonHeader).toBe(true);
	});

	it("separates a cancel from a reject, which share a cause", () => {
		expect([...SIP_TERMINATION_REASONS]).toContain("cancelled");
		expect([...SIP_TERMINATION_REASONS]).toContain("rejected");
		expect([...SIP_TERMINATION_REASONS]).toContain("instance-lost");
	});

	it("distinguishes ringback from early media on a progressed event", () => {
		const ringing = makeSipDialogEvent("dialog.progressed", {
			orgId: ORG,
			source: "sipd",
			data: { ...base, status: 180, hasEarlyMedia: false },
		});
		expect(ringing.data.hasEarlyMedia).toBe(false);
		const early = makeSipDialogEvent("dialog.progressed", {
			orgId: ORG,
			source: "sipd",
			data: { ...base, status: 183, hasEarlyMedia: true, sdpAnswer: "v=0\r\n" },
		});
		expect(early.data.hasEarlyMedia).toBe(true);
	});

	it("validates through the family union", () => {
		const event = makeSipDialogEvent("dialog.dtmf", {
			orgId: ORG,
			source: "sipd",
			data: { ...base, digit: "5" },
		});
		expect(sipDialogEventSchema.safeParse(JSON.parse(JSON.stringify(event))).success).toBe(true);
	});
});

describe("multi-contact registration bindings", () => {
	const binding = {
		orgId: ORG,
		aor: "sip:1001@acme.example.com",
		aorHash: "abc",
		contact: "sip:1001@10.0.0.5:5060",
		transport: "udp" as const,
		registeredAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 300_000).toISOString(),
		expiresInSeconds: 300,
	};

	it("reads a binding written before the array existed", () => {
		const parsed = registrationBindingSchema.parse(binding);
		expect(parsed.contacts).toBeUndefined();
		// The whole point of keeping the flat fields: a reader that never heard of `contacts` still
		// gets a routable answer, and one that has heard of it gets the same answer through one call.
		expect(contactsOf(parsed).map((c) => c.contact)).toEqual([binding.contact]);
	});

	it("reads every contact when the registrar tracked more than one", () => {
		const parsed = registrationBindingSchema.parse({
			...binding,
			contacts: [
				{
					contact: binding.contact,
					transport: "udp",
					registeredAt: binding.registeredAt,
					expiresAt: binding.expiresAt,
				},
				{
					contact: "sip:1001@10.0.0.9:5061",
					transport: "tcp",
					registeredAt: binding.registeredAt,
					expiresAt: binding.expiresAt,
				},
			],
		});
		expect(contactsOf(parsed)).toHaveLength(2);
		// contacts[0] IS the primary, and the flat fields are its copy. A value where they disagree
		// is a bug in the writer.
		expect(contactsOf(parsed)[0]?.contact).toBe(parsed.contact);
	});

	it("refuses a roster nobody asked for", () => {
		const many = Array.from({ length: 11 }, (_unused, index) => ({
			contact: `sip:1001@10.0.0.${index}:5060`,
			transport: "udp" as const,
			registeredAt: binding.registeredAt,
			expiresAt: binding.expiresAt,
		}));
		expect(registrationBindingSchema.safeParse({ ...binding, contacts: many }).success).toBe(false);
	});
});
