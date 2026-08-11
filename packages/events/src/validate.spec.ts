import { describe, expect, it } from "bun:test";
import { createEntityId } from "@optimiq-voice/identifiers";
import { EventValidationError, UnknownEventSubjectError } from "./errors";
import { makeAuditEvent } from "./schemas/audit-events";
import { makeCallEvent } from "./schemas/call-events";
import { makeCdrLegWriteEvent } from "./schemas/cdr-events";
import { makeMediaEvent } from "./schemas/media-events";
import { makeProvisionEvent } from "./schemas/provision-events";
import { makeQueueEvent } from "./schemas/queue-events";
import { makeRegistrationEvent } from "./schemas/registration-events";
import { makeVoicemailEvent } from "./schemas/voicemail-events";
import { EVENT_FAMILIES, RPC_SUBJECTS, subjectFor } from "./subjects";
import {
	anyEventSchema,
	EVENT_SCHEMAS_BY_FAMILY,
	eventSchemaForSubject,
	safeValidateEvent,
	validateEvent,
	validateEventOfFamily,
} from "./validate";

const ORG = createEntityId();
const OTHER_ORG = createEntityId();
const CALL = createEntityId();
const LEG = createEntityId();
const QUEUE = createEntityId();
const MAILBOX = createEntityId();
const SESSION = createEntityId();

const callEvent = makeCallEvent("channel.answered", {
	orgId: ORG,
	callId: CALL,
	source: "engine",
	data: { legId: LEG },
});

/** One valid event per family, as it would arrive over the wire (JSON round-tripped). */
const samples = {
	call: callEvent,
	registration: makeRegistrationEvent("registered", {
		orgId: ORG,
		source: "sipd",
		data: {
			aor: "sip:1001@acme.example.com",
			aorHash: "x",
			contact: "sip:1001@10.0.0.5",
			transport: "udp",
			expiresInSeconds: 300,
		},
	}),
	queue: makeQueueEvent("caller.abandoned", {
		orgId: ORG,
		queueId: QUEUE,
		source: "engine",
		data: { callId: CALL, legId: LEG, waitMs: 41_000, reason: "caller-hangup" },
	}),
	voicemail: makeVoicemailEvent("message.left", {
		orgId: ORG,
		mailboxId: MAILBOX,
		source: "engine",
		data: {
			messageId: createEntityId(),
			mailboxNumber: "1001",
			callId: CALL,
			legId: LEG,
			recordingId: createEntityId(),
			objectKey: "voicemail/2026/08/05/message.wav",
			durationMs: 8_200,
			receivedAt: "2026-08-05T10:00:00.000Z",
		},
	}),
	media: makeMediaEvent("session.ended", {
		orgId: ORG,
		source: "mediad",
		data: {
			sessionId: SESSION,
			instanceId: "mediad-1",
			callId: CALL,
			legId: LEG,
			rtpPort: 30_002,
			packetsReceived: 1_500,
			packetsSent: 1_500,
			reason: "released",
			durationMs: 30_000,
		},
	}),
	cdr: makeCdrLegWriteEvent({
		orgId: ORG,
		source: "engine",
		data: {
			id: createEntityId(),
			callId: CALL,
			leg: "a",
			direction: "inbound",
			fromNumber: "+15551230000",
			toNumber: "1001",
			destinationType: "extension",
			startedAt: "2026-08-05T10:00:00.000Z",
			durationMs: 1,
			billsecMs: 0,
			hangupCause: "NORMAL_CLEARING",
			hangupCauseCode: 16,
			disposition: "answered",
		},
	}),
	audit: makeAuditEvent({
		orgId: ORG,
		source: "api",
		data: {
			actor: { type: "system" },
			action: "extension.create",
			resource: { type: "extension" },
			outcome: "allowed",
		},
	}),
	provision: makeProvisionEvent("device.rendered", {
		orgId: ORG,
		source: "api",
		data: {
			sourceAddress: "198.51.100.4:41234",
			macAddress: "805ec0112233",
			vendor: "yealink",
			model: "t46s",
			deviceId: createEntityId(),
			templateId: createEntityId(),
			bytes: 2048,
		},
	}),
} as const;

/** What a consumer actually receives: the envelope after a JSON serialise/deserialise hop. */
function overTheWire(value: unknown): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

describe("schema resolution", () => {
	it("registers a schema for every family", () => {
		expect(Object.keys(EVENT_SCHEMAS_BY_FAMILY).sort()).toEqual([...EVENT_FAMILIES].sort());
	});

	it("selects the right schema from a subject", () => {
		for (const family of EVENT_FAMILIES) {
			const sample = samples[family];
			expect(eventSchemaForSubject(sample.subject)).toBe(EVENT_SCHEMAS_BY_FAMILY[family]);
		}
	});

	it("has no schema for rpc or unknown subjects", () => {
		expect(eventSchemaForSubject(RPC_SUBJECTS.routingResolve)).toBeUndefined();
		expect(eventSchemaForSubject("acme.telemetry.v1.thing")).toBeUndefined();
	});
});

describe("validateEvent", () => {
	it("validates one event of every family after a JSON round trip", () => {
		for (const family of EVENT_FAMILIES) {
			const sample = samples[family];
			expect(validateEvent(sample.subject, overTheWire(sample))).toEqual(sample);
		}
	});

	it("accepts every sample against the catch-all union too", () => {
		for (const family of EVENT_FAMILIES) {
			expect(anyEventSchema.safeParse(overTheWire(samples[family])).success).toBe(true);
		}
	});

	it("throws UnknownEventSubjectError for a subject outside the taxonomy", () => {
		expect(() => validateEvent("acme.telemetry.v1.thing", {})).toThrow(UnknownEventSubjectError);
		expect(() => validateEvent(RPC_SUBJECTS.authzCheck, {})).toThrow(UnknownEventSubjectError);
	});

	it("throws EventValidationError with a readable summary for a bad payload", () => {
		const broken = { ...overTheWire(callEvent), data: {} };
		try {
			validateEvent(callEvent.subject, broken);
			throw new Error("expected a validation failure");
		} catch (error) {
			expect(error).toBeInstanceOf(EventValidationError);
			const validation = error as EventValidationError;
			expect(validation.subject).toBe(callEvent.subject);
			expect(validation.eventType).toBe("channel.answered");
			expect(validation.summary).toContain("data.legId");
		}
	});

	it("rejects an event whose type does not belong to its subject's family", () => {
		const wrongFamily = { ...overTheWire(samples.audit), subject: callEvent.subject };
		expect(() => validateEvent(callEvent.subject, wrongFamily)).toThrow(EventValidationError);
	});
});

describe("subject cross-check", () => {
	it("rejects an envelope published on a different subject", () => {
		const moved = {
			...overTheWire(callEvent),
			subject: subjectFor.call(ORG, CALL, "channel.held"),
		};
		const result = safeValidateEvent(subjectFor.call(ORG, CALL, "channel.answered"), moved);
		expect(result.success).toBe(false);
		if (result.success) throw new Error("unreachable");
		expect(result.error.message).toContain("does not match the delivery subject");
	});

	it("rejects an envelope whose orgId is not the subject's tenant", () => {
		const crossTenant = { ...overTheWire(samples.audit), orgId: OTHER_ORG };
		const result = safeValidateEvent(samples.audit.subject, crossTenant);
		expect(result.success).toBe(false);
		if (result.success) throw new Error("unreachable");
		expect(result.error.message).toContain("does not match the subject's org token");
	});

	it("can be disabled for a replay from a file", () => {
		const crossTenant = { ...overTheWire(samples.audit), orgId: OTHER_ORG };
		expect(
			safeValidateEvent(samples.audit.subject, crossTenant, { crossCheckSubject: false }).success,
		).toBe(true);
	});
});

describe("safeValidateEvent", () => {
	it("returns a result rather than throwing on a poison message", () => {
		const result = safeValidateEvent(callEvent.subject, "not an object");
		expect(result.success).toBe(false);
		if (result.success) throw new Error("unreachable");
		expect(result.error).toBeInstanceOf(EventValidationError);
	});

	it("returns the parsed envelope on success", () => {
		const result = safeValidateEvent(callEvent.subject, overTheWire(callEvent));
		expect(result.success).toBe(true);
		if (!result.success) throw new Error("unreachable");
		expect(result.data.type).toBe("channel.answered");
	});
});

describe("validateEventOfFamily", () => {
	it("narrows to the requested family", () => {
		const event = validateEventOfFamily("call", callEvent.subject, overTheWire(callEvent));
		if (event.type !== "channel.answered") throw new Error("unreachable");
		expect(event.data.legId).toBe(LEG);
	});

	it("refuses a subject from another family", () => {
		expect(() =>
			validateEventOfFamily("call", samples.audit.subject, overTheWire(samples.audit)),
		).toThrow(UnknownEventSubjectError);
	});
});

describe("forward compatibility", () => {
	it("tolerates an unknown optional field added by a newer producer", () => {
		const fromTheFuture = {
			...overTheWire(callEvent),
			data: { legId: LEG, sdpFingerprint: "sha-256 AA:BB" },
			regionHint: "eu-west-1",
		};
		const validated = validateEvent(callEvent.subject, fromTheFuture);
		expect(validated.data).toEqual({ legId: LEG });
		expect("regionHint" in validated).toBe(false);
	});

	it("refuses an unknown event type on a known family (needs a release, not a guess)", () => {
		const unknownType = { ...overTheWire(callEvent), type: "channel.teleported" };
		expect(() =>
			validateEvent(subjectFor.call(ORG, CALL, "channel.teleported"), unknownType),
		).toThrow(EventValidationError);
	});
});
