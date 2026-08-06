#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { makeAuditEvent } from "../src/schemas/audit-events";
import { makeCallEvent } from "../src/schemas/call-events";
import { makeCdrLegWriteEvent } from "../src/schemas/cdr-events";
import { makeProvisionEvent } from "../src/schemas/provision-events";
import { makeQueueEvent } from "../src/schemas/queue-events";
import { makeRegistrationEvent } from "../src/schemas/registration-events";
import { makeVoicemailEvent } from "../src/schemas/voicemail-events";
import {
	EVENT_STREAMS,
	KV_BUCKETS,
	kvKeyFor,
	type KvBucketDefinition,
	type StreamDefinition,
} from "../src/streams";
import {
	aorSubjectToken,
	CALL_EVENTS,
	didIndexToken,
	matchesSubject,
	parseSubject,
	QUEUE_EVENTS,
	QUEUE_SCOPE_ALL,
	REGISTRATION_EVENTS,
	RPC_SUBJECTS,
	SUBJECT_ROOTS,
	SUBJECT_VERSION,
	subjectFilterFor,
	subjectFor,
	VOICEMAIL_EVENTS,
} from "../src/subjects";
import { GoFileEmitter, pascal, type JsonSchema } from "./go-emitter";
import {
	ENVELOPE_SCHEMA,
	EVENT_ENTRIES,
	FAMILY_FILE,
	FAMILY_ORDER,
	NAMED_ENUMS,
	RPC_ENTRIES,
	type EventEntry,
} from "./registry";

/**
 * TS → Go contract codegen (plan §3.5: "generated Go structs; single source: JSON Schema emitted
 * from Zod; CI checks cross-language drift").
 *
 * ## Pipeline
 *
 * ```text
 *   packages/events/src/**.ts          Zod — the ONLY hand-edited contract
 *          │ z.toJSONSchema(draft-2020-12, io: "output")
 *          ▼
 *   packages/events/schema/**.json     committed artefact; readable without a TS toolchain
 *          │ scripts/go-emitter.ts
 *          ▼
 *   packages/events-go/*_gen.go        committed Go structs consumed by apps/sipd (and mediad)
 *          +
 *   packages/events-go/testdata/parity.json   golden values produced BY THE TS IMPLEMENTATION,
 *                                             asserted by Go tests over the hand-written half
 *                                             (subject builders, KV keys, stream definitions)
 * ```
 *
 * Everything this script writes is a pure function of `src/`: no timestamps, no host names, no
 * random ids, no map iteration order. Re-running it on an unchanged `src/` produces a byte-identical
 * tree, which is what makes `codegen:check` a meaningful gate.
 *
 * Usage: `pnpm --filter @optimiq-voice/events codegen`
 * Gate:  `pnpm --filter @optimiq-voice/events codegen:check`
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const EVENTS_PKG = join(HERE, "..");
const REPO_ROOT = join(EVENTS_PKG, "..", "..");
const SCHEMA_DIR = join(EVENTS_PKG, "schema");
const GO_DIR = join(REPO_ROOT, "packages", "events-go");

const TO_JSON_SCHEMA_OPTIONS = {
	target: "draft-2020-12",
	io: "output",
	// `data: z.unknown()` on the base envelope is genuinely unconstrained, not an error.
	unrepresentable: "any",
} as const;

// ------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------

function writeText(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, "utf8");
	written.push(relative(REPO_ROOT, path));
}

const written: string[] = [];

/** Tab-indented JSON with a trailing newline — matches the repo's oxfmt/editorconfig style. */
function writeJson(path: string, value: unknown): void {
	writeText(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function toJsonSchema(schema: z.ZodType): JsonSchema {
	return z.toJSONSchema(schema, TO_JSON_SCHEMA_OPTIONS) as JsonSchema;
}

/** Strips `$schema` so a payload schema can be embedded without a nested dialect declaration. */
function withoutDialect(schema: JsonSchema): JsonSchema {
	const { $schema, ...rest } = schema as JsonSchema & { $schema?: string };
	void $schema;
	return rest;
}

function schemaFileName(entry: EventEntry): string {
	return `events/${entry.family}.${entry.type}.schema.json`;
}

// ------------------------------------------------------------------------------------------------
// 1 — JSON Schema artefacts
// ------------------------------------------------------------------------------------------------

interface ManifestEvent {
	readonly family: string;
	readonly type: string;
	readonly subject: string;
	readonly dataSchema: string;
	readonly goType: string;
}

interface ManifestRpc {
	readonly subject: string;
	readonly timeoutMs: number;
	readonly requestSchema: string;
	readonly responseSchema: string;
	readonly goRequestType: string;
	readonly goResponseType: string;
}

function emitJsonSchemas(): {
	readonly eventSchemas: Map<string, JsonSchema>;
	readonly rpcSchemas: Map<string, { request: JsonSchema; response: JsonSchema }>;
} {
	rmSync(SCHEMA_DIR, { recursive: true, force: true });

	writeJson(join(SCHEMA_DIR, "envelope.schema.json"), toJsonSchema(ENVELOPE_SCHEMA));

	// The named telephony vocabularies as one `$defs` document. Payload schemas inline their
	// values (zod has no `$ref` for enums); this file is what tells a reader those inline enums
	// are ONE vocabulary, and it is what the Go emitter's value-set matching mirrors.
	writeJson(join(SCHEMA_DIR, "telephony.schema.json"), {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		title: "Optimiq Voice telephony vocabularies",
		description:
			"Closed string vocabularies shared across event families. Authority: " +
			"packages/events/src/schemas/telephony.ts.",
		$defs: Object.fromEntries(
			NAMED_ENUMS.map((entry) => [
				entry.goName,
				{ description: entry.doc, type: "string", enum: [...entry.values] },
			]),
		),
	});

	const eventSchemas = new Map<string, JsonSchema>();
	const events: ManifestEvent[] = [];
	for (const entry of EVENT_ENTRIES) {
		const schema = toJsonSchema(entry.data);
		eventSchemas.set(`${entry.family}.${entry.type}`, schema);
		const file = schemaFileName(entry);
		writeJson(join(SCHEMA_DIR, file), schema);
		events.push({
			family: entry.family,
			type: entry.type,
			subject: entry.subjectTemplate,
			dataSchema: file,
			goType: entry.goName,
		});
	}

	const rpcSchemas = new Map<string, { request: JsonSchema; response: JsonSchema }>();
	const rpc: ManifestRpc[] = [];
	for (const entry of RPC_ENTRIES) {
		const request = toJsonSchema(entry.request);
		const response = toJsonSchema(entry.response);
		rpcSchemas.set(entry.subject, { request, response });
		const requestFile = `rpc/${entry.subject}.request.schema.json`;
		const responseFile = `rpc/${entry.subject}.response.schema.json`;
		writeJson(join(SCHEMA_DIR, requestFile), request);
		writeJson(join(SCHEMA_DIR, responseFile), response);
		rpc.push({
			subject: entry.subject,
			timeoutMs: entry.timeoutMs,
			requestSchema: requestFile,
			responseSchema: responseFile,
			goRequestType: `${entry.goName}Request`,
			goResponseType: `${entry.goName}Response`,
		});
	}

	writeJson(join(SCHEMA_DIR, "index.json"), {
		description:
			"Manifest of the Optimiq Voice NATS contract. Generated from packages/events/src by " +
			"scripts/generate-go.ts; do not edit. Every message on the backbone is the envelope " +
			"(envelope.schema.json) with `data` replaced by the referenced payload schema.",
		subjectVersion: SUBJECT_VERSION,
		envelopeSchema: "envelope.schema.json",
		vocabulariesSchema: "telephony.schema.json",
		subjectRoots: SUBJECT_ROOTS,
		events,
		rpc,
	});

	return { eventSchemas, rpcSchemas };
}

// ------------------------------------------------------------------------------------------------
// 2 — Go structs
// ------------------------------------------------------------------------------------------------

function emitGo(
	eventSchemas: Map<string, JsonSchema>,
	rpcSchemas: Map<string, { request: JsonSchema; response: JsonSchema }>,
): void {
	mkdirSync(GO_DIR, { recursive: true });
	for (const name of readdirSync(GO_DIR, { withFileTypes: true })) {
		if (name.isFile() && name.name.endsWith("_gen.go")) {
			rmSync(join(GO_DIR, name.name));
		}
	}

	// -- telephony vocabularies -------------------------------------------------------------------
	const telephony = new GoFileEmitter({ namedEnums: [] });
	for (const entry of NAMED_ENUMS) {
		telephony.declareNamedEnum(entry);
	}
	writeText(
		join(GO_DIR, "telephony_gen.go"),
		telephony.render(
			[
				"Closed telephony vocabularies shared by every event family.",
				"",
				"Authority: packages/events/src/schemas/telephony.ts. Large, still-growing domains",
				"(hangup causes, destination types, dispositions) are deliberately plain strings there",
				"and here — see that file's header for why.",
			],
			"events",
		),
	);

	// -- one file per family ----------------------------------------------------------------------
	for (const family of FAMILY_ORDER) {
		const entries = EVENT_ENTRIES.filter((entry) => entry.family === family);
		const emitter = new GoFileEmitter({ namedEnums: NAMED_ENUMS });

		const constLines = [
			`// Event types carried on the ${family} family's subjects. The value is the envelope's`,
			"// `type` discriminator, which is unique WITHIN the family only.",
			"const (",
			...entries.map((entry) => `\t${entry.goConst} = ${JSON.stringify(entry.type)}`),
			")",
			"",
		];
		emitter.declareRaw(`consts:${family}`, constLines.join("\n"));

		for (const entry of entries) {
			const schema = eventSchemas.get(`${entry.family}.${entry.type}`);
			if (schema === undefined) {
				throw new Error(`Missing schema for ${entry.family}.${entry.type}.`);
			}
			emitter.declareStruct(
				entry.goName,
				[
					`the payload of the ${JSON.stringify(entry.type)} event.`,
					"",
					`Subject: ${entry.subjectTemplate}`,
					"Envelope: Envelope[" + entry.goName + "]",
				],
				withoutDialect(schema),
			);
		}

		writeText(
			join(GO_DIR, `${FAMILY_FILE[family]}_gen.go`),
			emitter.render([`Payloads for the ${family} event family.`], "events"),
		);
	}

	// -- rpc --------------------------------------------------------------------------------------
	const rpcEmitter = new GoFileEmitter({ namedEnums: NAMED_ENUMS });
	const rpcConsts: string[] = [
		"// Request-reply subjects and their suggested client deadlines. These are on the call path,",
		"// so a slow reply is the same as a broken one.",
		"const (",
	];
	for (const entry of RPC_ENTRIES) {
		rpcConsts.push(`\tSubject${entry.goName}RPC = ${JSON.stringify(entry.subject)}`);
	}
	rpcConsts.push(")", "");
	rpcConsts.push("const (");
	for (const entry of RPC_ENTRIES) {
		rpcConsts.push(`\tTimeout${entry.goName}RPC = ${entry.timeoutMs} * time.Millisecond`);
	}
	rpcConsts.push(")", "");
	rpcEmitter.imports.add("time");
	rpcEmitter.declareRaw("consts:rpc", rpcConsts.join("\n"));

	for (const entry of RPC_ENTRIES) {
		const pair = rpcSchemas.get(entry.subject);
		if (pair === undefined) {
			throw new Error(`Missing RPC schemas for ${entry.subject}.`);
		}
		rpcEmitter.declareStruct(
			`${entry.goName}Request`,
			[`the request body of ${entry.subject}.`],
			withoutDialect(pair.request),
		);
		rpcEmitter.declareStruct(
			`${entry.goName}Response`,
			[`the reply body of ${entry.subject}.`],
			withoutDialect(pair.response),
		);
	}
	writeText(
		join(GO_DIR, "rpc_gen.go"),
		rpcEmitter.render(
			[
				"Request-reply contracts for the rpc.* subjects (plan §3.5).",
				"",
				"Contracts only: transport is the application's business. rpc.media.* arrives with",
				"apps/mediad and is deliberately absent until that service exists.",
			],
			"events",
		),
	);

	// -- registry ---------------------------------------------------------------------------------
	const registry: string[] = [];
	registry.push("// EventTypeInfo describes one event type in the contract.");
	registry.push("type EventTypeInfo struct {");
	registry.push("\t// Family is the subject family the type belongs to.");
	registry.push("\tFamily EventFamily");
	registry.push("\t// Type is the envelope's `type` discriminator.");
	registry.push("\tType string");
	registry.push("\t// SubjectTemplate documents the subject shape, with <> placeholders.");
	registry.push("\tSubjectTemplate string");
	registry.push("}", "");
	registry.push("// EventTypes lists every event type in the contract, in declaration order.");
	registry.push("var EventTypes = []EventTypeInfo{");
	for (const entry of EVENT_ENTRIES) {
		registry.push(
			`\t{Family: Family${pascal(entry.family)}, Type: ${entry.goConst}, SubjectTemplate: ${JSON.stringify(entry.subjectTemplate)}},`,
		);
	}
	registry.push("}", "");
	registry.push(
		"// NewDataFor returns a pointer to a zero payload struct for eventType, or nil when the",
	);
	registry.push("// type is not part of this contract version.");
	registry.push("//");
	registry.push(
		"// A v1.n producer may emit a type a v1.0 consumer has never heard of (envelope.ts:",
	);
	registry.push("// additive-only evolution), so a nil result is a normal outcome, not an error.");
	registry.push("func NewDataFor(eventType string) any {");
	registry.push("\tswitch eventType {");
	for (const entry of EVENT_ENTRIES) {
		registry.push(`\tcase ${entry.goConst}:`);
		registry.push(`\t\treturn new(${entry.goName})`);
	}
	registry.push("\t}");
	registry.push("\treturn nil");
	registry.push("}", "");

	const registryEmitter = new GoFileEmitter({ namedEnums: [] });
	registryEmitter.declareRaw("registry", registry.join("\n"));
	writeText(
		join(GO_DIR, "registry_gen.go"),
		registryEmitter.render(
			[
				"The contract's event-type registry: everything a generic consumer needs to route a message.",
			],
			"events",
		),
	);
}

// ------------------------------------------------------------------------------------------------
// 3 — parity golden, produced BY the TS implementation
// ------------------------------------------------------------------------------------------------

const ORG_A = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293";
const ORG_B = "01930a11-2233-7445-8899-aabbccddeeff";
const CALL_A = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b4c";
const LEG_A = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b4d";
const QUEUE_A = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b4e";
const AGENT_A = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b4f";
const DEVICE_A = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b50";
const MAILBOX_A = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b51";
const MESSAGE_A = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b52";
/** DIDs in the two shapes the index has to reconcile: as stored, and as a carrier delivers it. */
const DID_STORED = "+441632960111";
const DID_DIALLED = "441632960111";
const AT = "2026-08-05T10:00:00.000Z";

/** Deterministic event ids: no `createEntityId()` anywhere in the golden. */
function eventId(index: number): string {
	return `0192c7a1-4b8e-7f21-8b3c-9d0e1f2a${index.toString(16).padStart(4, "0")}`;
}

/** The shapes one DID arrives in: stored, dialled, punctuated, and a national-format near-miss. */
const DID_CASES = [
	"+441632960111",
	"441632960111",
	"+1 (212) 555-0100",
	"+1-212-555-0100",
	"0044 1632 960111",
];

const AOR_CASES = [
	"sip:1001@acme.example.com",
	"1001@acme.example.com",
	"SIP:1001@ACME.EXAMPLE.COM",
	"  sip:1001@acme.example.com  ",
	"sip:+441632960123@trunk.example.net",
	"sip:ünïcödé@example.com",
	"sip:a@b",
];

function eventSamples(): readonly {
	readonly name: string;
	readonly goType: string;
	readonly envelope: unknown;
}[] {
	const samples: { name: string; goType: string; envelope: unknown }[] = [];
	let index = 0;
	const next = (): { id: string; at: string; source: string } => ({
		id: eventId(index++),
		at: AT,
		source: "sipd",
	});

	samples.push({
		name: "call.channel.created",
		goType: "ChannelCreatedData",
		envelope: makeCallEvent("channel.created", {
			...next(),
			orgId: ORG_A,
			callId: CALL_A,
			traceId: "0af7651916cd43dd8448eb211c80319c",
			correlationId: "job-1",
			data: {
				legId: LEG_A,
				leg: "a",
				direction: "inbound",
				from: { number: "+441632960111", name: "Ada Lovelace" },
				to: { number: "1001" },
				sipCallId: "3c26700c1adf-6qgy0fkn7cvb",
				routingContext: "public",
				remoteAddress: "203.0.113.9:5060",
			},
		}),
	});
	samples.push({
		name: "call.channel.dtmf",
		goType: "ChannelDTMFData",
		envelope: makeCallEvent("channel.dtmf", {
			...next(),
			orgId: ORG_A,
			callId: CALL_A,
			data: { legId: LEG_A, digit: "#", durationMs: 120, source: "rfc2833" },
		}),
	});
	samples.push({
		name: "call.channel.hangup",
		goType: "ChannelHangupData",
		envelope: makeCallEvent("channel.hangup", {
			...next(),
			orgId: ORG_A,
			callId: CALL_A,
			data: { legId: LEG_A, cause: "NORMAL_CLEARING", causeCode: 16, side: "caller" },
		}),
	});
	samples.push({
		name: "call.channel.record.started",
		goType: "ChannelRecordStartedData",
		envelope: makeCallEvent("channel.record.started", {
			...next(),
			orgId: ORG_A,
			callId: CALL_A,
			data: {
				legId: LEG_A,
				recordingId: DEVICE_A,
				objectKey: "recordings/2026/08/05/leg-a.wav",
				kind: "call",
				stereo: false,
			},
		}),
	});

	samples.push({
		name: "registration.registered",
		goType: "RegistrationRegisteredData",
		envelope: makeRegistrationEvent("registered", {
			...next(),
			orgId: ORG_A,
			data: {
				aor: "sip:1001@acme.example.com",
				aorHash: "ignored-derived-from-aor".padEnd(32, "0").slice(0, 32),
				contact: "sip:1001@203.0.113.9:5060;transport=udp",
				transport: "udp",
				userAgent: "Yealink SIP-T46U 108.86.0.40",
				sourceAddress: "203.0.113.9:5060",
				deviceId: DEVICE_A,
				expiresInSeconds: 300,
				refreshed: false,
			},
		}),
	});
	samples.push({
		name: "registration.unregistered",
		goType: "RegistrationUnregisteredData",
		envelope: makeRegistrationEvent("unregistered", {
			...next(),
			orgId: ORG_A,
			data: {
				aor: "sip:1001@acme.example.com",
				aorHash: "0".repeat(32),
				contact: "sip:1001@203.0.113.9:5060;transport=udp",
				transport: "udp",
				reason: "client",
			},
		}),
	});
	samples.push({
		name: "registration.expired",
		goType: "RegistrationExpiredData",
		envelope: makeRegistrationEvent("expired", {
			...next(),
			orgId: ORG_B,
			data: {
				aor: "sip:2002@beta.example.com",
				aorHash: "0".repeat(32),
				contact: "sip:2002@198.51.100.4:5060;transport=tcp",
				transport: "tcp",
				registeredForSeconds: 3_600,
			},
		}),
	});

	samples.push({
		name: "queue.caller.joined",
		goType: "QueueCallerJoinedData",
		envelope: makeQueueEvent("caller.joined", {
			...next(),
			orgId: ORG_A,
			queueId: QUEUE_A,
			data: {
				callId: CALL_A,
				legId: LEG_A,
				position: 3,
				priority: 10,
				callerNumber: "+441632960111",
			},
		}),
	});
	samples.push({
		name: "queue.agent.state",
		goType: "QueueAgentStateData",
		envelope: makeQueueEvent("agent.state", {
			...next(),
			orgId: ORG_A,
			queueId: QUEUE_SCOPE_ALL,
			data: {
				agentId: AGENT_A,
				status: "wrap-up",
				previousStatus: "on-call",
				queueIds: [QUEUE_A],
				reason: "after-call work",
			},
		}),
	});

	samples.push({
		name: "voicemail.message.left",
		goType: "VoicemailMessageLeftData",
		envelope: makeVoicemailEvent("message.left", {
			...next(),
			orgId: ORG_A,
			mailboxId: MAILBOX_A,
			data: {
				messageId: MESSAGE_A,
				mailboxNumber: "1001",
				callId: CALL_A,
				legId: LEG_A,
				recordingId: DEVICE_A,
				objectKey: "voicemail/2026/08/05/message-a.wav",
				durationMs: 12_400,
				sizeBytes: 198_400,
				callerIdNumber: "+441632960111",
				callerIdName: "Ada Lovelace",
				receivedAt: AT,
				transcriptionRequested: false,
			},
		}),
	});
	samples.push({
		name: "voicemail.mwi.updated",
		goType: "VoicemailMWIUpdatedData",
		envelope: makeVoicemailEvent("mwi.updated", {
			...next(),
			orgId: ORG_A,
			mailboxId: MAILBOX_A,
			source: "api",
			data: {
				mailboxNumber: "1001",
				extensionNumber: "1001",
				newCount: 3,
				savedCount: 12,
				reason: "message-left",
			},
		}),
	});

	samples.push({
		name: "cdr.leg.write",
		goType: "CDRLegWriteData",
		envelope: makeCdrLegWriteEvent({
			...next(),
			orgId: ORG_A,
			data: {
				id: CALL_A,
				callId: CALL_A,
				leg: "a",
				originatingLegId: null,
				bridgeLegId: null,
				direction: "inbound",
				fromNumber: "+441632960111",
				fromName: "Ada Lovelace",
				toNumber: "1001",
				destinationType: "extension",
				destinationRef: DEVICE_A,
				startedAt: AT,
				answeredAt: AT,
				endedAt: AT,
				durationMs: 42_000,
				billsecMs: 40_000,
				hangupCause: "NORMAL_CLEARING",
				hangupCauseCode: 16,
				hangupSide: "caller",
				disposition: "answered",
				// Passthrough: NOT in the pinned contract. Proves the Go `Extra` round-trip.
				queueId: QUEUE_A,
				mediaStats: { mos: 4.31, jitterMs: 7 },
			},
		}),
	});

	samples.push({
		name: "audit.recorded",
		goType: "AuditRecordedData",
		envelope: makeAuditEvent({
			...next(),
			orgId: ORG_A,
			source: "api",
			data: {
				actor: { type: "user", id: "usr_1", label: "ada@acme.example.com", ip: "203.0.113.9" },
				action: "extension.update",
				resource: { type: "extension", id: DEVICE_A, label: "1001" },
				outcome: "allowed",
				requestId: "req_1",
				changes: { displayName: { from: "Ada", to: "Ada L." } },
			},
		}),
	});

	samples.push({
		name: "provision.device.rejected",
		goType: "ProvisionDeviceRejectedData",
		envelope: makeProvisionEvent("device.rejected", {
			...next(),
			orgId: ORG_A,
			source: "api",
			data: {
				sourceAddress: "203.0.113.9:41234",
				path: "/provision/805ec0000044.cfg",
				macAddress: "805ec0000044",
				reason: "invalid-token",
				detail: "token mismatch",
			},
		}),
	});

	return samples;
}

function parityGolden(): unknown {
	const subjectBuilders = [
		{
			builder: "call",
			args: [ORG_A, CALL_A, "channel.created"],
			subject: subjectFor.call(ORG_A, CALL_A, "channel.created"),
		},
		{
			builder: "call",
			args: [ORG_B, CALL_A, "channel.record.started"],
			subject: subjectFor.call(ORG_B, CALL_A, "channel.record.started"),
		},
		{
			builder: "registration",
			args: [ORG_A, aorSubjectToken(AOR_CASES[0] as string), "registered"],
			subject: subjectFor.registration(
				ORG_A,
				aorSubjectToken(AOR_CASES[0] as string),
				"registered",
			),
		},
		{
			builder: "registration",
			args: [ORG_A, aorSubjectToken(AOR_CASES[4] as string), "expired"],
			subject: subjectFor.registration(ORG_A, aorSubjectToken(AOR_CASES[4] as string), "expired"),
		},
		{
			builder: "queue",
			args: [ORG_A, QUEUE_A, "caller.joined"],
			subject: subjectFor.queue(ORG_A, QUEUE_A, "caller.joined"),
		},
		{
			builder: "queue",
			args: [ORG_A, QUEUE_SCOPE_ALL, "agent.state"],
			subject: subjectFor.queue(ORG_A, QUEUE_SCOPE_ALL, "agent.state"),
		},
		{
			builder: "voicemail",
			args: [ORG_A, MAILBOX_A, "message.left"],
			subject: subjectFor.voicemail(ORG_A, MAILBOX_A, "message.left"),
		},
		{
			builder: "voicemail",
			args: [ORG_A, MAILBOX_A, "mwi.updated"],
			subject: subjectFor.voicemail(ORG_A, MAILBOX_A, "mwi.updated"),
		},
		{ builder: "cdrLeg", args: [ORG_A], subject: subjectFor.cdrLeg(ORG_A) },
		{ builder: "audit", args: [ORG_A], subject: subjectFor.audit(ORG_A) },
		{ builder: "provision", args: [ORG_A], subject: subjectFor.provision(ORG_A) },
	];

	const subjectFilters = [
		{ filter: "allCalls", args: [], result: subjectFilterFor.allCalls() },
		{ filter: "callsInOrg", args: [ORG_A], result: subjectFilterFor.callsInOrg(ORG_A) },
		{ filter: "call", args: [ORG_A, CALL_A], result: subjectFilterFor.call(ORG_A, CALL_A) },
		{
			filter: "callEventInOrg",
			args: [ORG_A, "channel.hangup"],
			result: subjectFilterFor.callEventInOrg(ORG_A, "channel.hangup"),
		},
		{
			filter: "callEvent",
			args: ["channel.hangup"],
			result: subjectFilterFor.callEvent("channel.hangup"),
		},
		{ filter: "allRegistrations", args: [], result: subjectFilterFor.allRegistrations() },
		{
			filter: "registrationsInOrg",
			args: [ORG_A],
			result: subjectFilterFor.registrationsInOrg(ORG_A),
		},
		{
			filter: "registrationsForAor",
			args: [ORG_A, aorSubjectToken(AOR_CASES[0] as string)],
			result: subjectFilterFor.registrationsForAor(ORG_A, aorSubjectToken(AOR_CASES[0] as string)),
		},
		{
			filter: "registrationEventInOrg",
			args: [ORG_A, "expired"],
			result: subjectFilterFor.registrationEventInOrg(ORG_A, "expired"),
		},
		{ filter: "allQueues", args: [], result: subjectFilterFor.allQueues() },
		{ filter: "queuesInOrg", args: [ORG_A], result: subjectFilterFor.queuesInOrg(ORG_A) },
		{ filter: "queue", args: [ORG_A, QUEUE_A], result: subjectFilterFor.queue(ORG_A, QUEUE_A) },
		{
			filter: "queueEventInOrg",
			args: [ORG_A, "agent.state"],
			result: subjectFilterFor.queueEventInOrg(ORG_A, "agent.state"),
		},
		{ filter: "allVoicemail", args: [], result: subjectFilterFor.allVoicemail() },
		{ filter: "voicemailInOrg", args: [ORG_A], result: subjectFilterFor.voicemailInOrg(ORG_A) },
		{
			filter: "voicemailBox",
			args: [ORG_A, MAILBOX_A],
			result: subjectFilterFor.voicemailBox(ORG_A, MAILBOX_A),
		},
		{
			filter: "voicemailEventInOrg",
			args: [ORG_A, "mwi.updated"],
			result: subjectFilterFor.voicemailEventInOrg(ORG_A, "mwi.updated"),
		},
		{ filter: "allCdrLegs", args: [], result: subjectFilterFor.allCdrLegs() },
		{ filter: "cdrLegsInOrg", args: [ORG_A], result: subjectFilterFor.cdrLegsInOrg(ORG_A) },
		{ filter: "allAudit", args: [], result: subjectFilterFor.allAudit() },
		{ filter: "auditInOrg", args: [ORG_A], result: subjectFilterFor.auditInOrg(ORG_A) },
		{ filter: "allProvision", args: [], result: subjectFilterFor.allProvision() },
		{ filter: "provisionInOrg", args: [ORG_A], result: subjectFilterFor.provisionInOrg(ORG_A) },
	];

	const parseCases = [
		subjectFor.call(ORG_A, CALL_A, "channel.record.started"),
		subjectFor.registration(ORG_A, aorSubjectToken(AOR_CASES[0] as string), "registered"),
		subjectFor.queue(ORG_A, QUEUE_A, "caller.joined"),
		subjectFor.voicemail(ORG_A, MAILBOX_A, "message.left"),
		subjectFor.cdrLeg(ORG_A),
		subjectFor.audit(ORG_A),
		subjectFor.provision(ORG_A),
		RPC_SUBJECTS.routingResolve,
		RPC_SUBJECTS.authzCheck,
		"calls.evt.v2.org.call.channel.created",
		"calls.evt.v1.org.call",
		"nonsense",
		"calls.evt.v1.org.*.channel.created",
		"sip.reg.v1.org.abc.>",
	].map((subject) => ({ subject, parsed: parseSubject(subject) ?? null }));

	const matchCases: readonly (readonly [string, string])[] = [
		[subjectFilterFor.allCalls(), subjectFor.call(ORG_A, CALL_A, "channel.created")],
		[subjectFilterFor.callsInOrg(ORG_A), subjectFor.call(ORG_B, CALL_A, "channel.created")],
		[
			subjectFilterFor.callEvent("channel.hangup"),
			subjectFor.call(ORG_A, CALL_A, "channel.hangup"),
		],
		[
			subjectFilterFor.callEvent("channel.hangup"),
			subjectFor.call(ORG_A, CALL_A, "channel.record.started"),
		],
		[
			subjectFilterFor.callEventInOrg(ORG_A, "channel.record.started"),
			subjectFor.call(ORG_A, CALL_A, "channel.record.started"),
		],
		[subjectFilterFor.allCdrLegs(), subjectFor.cdrLeg(ORG_A)],
		[subjectFilterFor.allCdrLegs(), subjectFor.call(ORG_A, CALL_A, "channel.created")],
		["a.b", "a.b"],
		["a.b", "a.b.c"],
		["a.>", "a"],
		["a.*", "a.b"],
		["a.*", "a.b.c"],
	];

	return {
		description:
			"Golden values emitted by the TypeScript implementation in packages/events/src. " +
			"packages/events-go asserts its hand-written half against these, so the two languages " +
			"cannot drift silently. Generated by scripts/generate-go.ts; do not edit.",
		subjectVersion: SUBJECT_VERSION,
		subjectRoots: SUBJECT_ROOTS,
		rpcSubjects: RPC_SUBJECTS,
		queueScopeAll: QUEUE_SCOPE_ALL,
		aorSubjectTokens: AOR_CASES.map((aor) => ({ aor, token: aorSubjectToken(aor) })),
		didIndexTokens: DID_CASES.map((did) => ({ did, token: didIndexToken(did) })),
		subjectBuilders,
		subjectFilters,
		parseSubject: parseCases,
		matchesSubject: matchCases.map(([filter, subject]) => ({
			filter,
			subject,
			matches: matchesSubject(filter, subject),
		})),
		kvKeys: [
			{
				builder: "registration",
				args: [ORG_A, aorSubjectToken(AOR_CASES[0] as string)],
				key: kvKeyFor.registration(ORG_A, aorSubjectToken(AOR_CASES[0] as string)),
			},
			{
				builder: "channel",
				args: [ORG_A, CALL_A, LEG_A],
				key: kvKeyFor.channel(ORG_A, CALL_A, LEG_A),
			},
			{ builder: "presence", args: [ORG_A, DEVICE_A], key: kvKeyFor.presence(ORG_A, DEVICE_A) },
			{ builder: "agentState", args: [ORG_A, AGENT_A], key: kvKeyFor.agentState(ORG_A, AGENT_A) },
			{
				builder: "routingCache",
				args: [ORG_A, "inbound"],
				key: kvKeyFor.routingCache(ORG_A, "inbound"),
			},
			{
				builder: "routingCache",
				args: [ORG_A, "inbound", "441632960111"],
				key: kvKeyFor.routingCache(ORG_A, "inbound", "441632960111"),
			},
			{ builder: "didIndex", args: [DID_STORED], key: kvKeyFor.didIndex(DID_STORED) },
			{ builder: "didIndex", args: [DID_DIALLED], key: kvKeyFor.didIndex(DID_DIALLED) },
			{
				builder: "didIndex",
				args: ["+1 (212) 555-0100"],
				key: kvKeyFor.didIndex("+1 (212) 555-0100"),
			},
		],
		streams: EVENT_STREAMS.map((definition: StreamDefinition) => ({ ...definition })),
		kvBuckets: KV_BUCKETS.map((definition: KvBucketDefinition) => ({ ...definition })),
		vocabularies: Object.fromEntries(NAMED_ENUMS.map((entry) => [entry.goName, [...entry.values]])),
		// The per-family `type` vocabularies from subjects.ts. Go derives these from the generated
		// registry, so this is what proves the two lists have not diverged.
		eventVocabularies: {
			call: [...CALL_EVENTS],
			registration: [...REGISTRATION_EVENTS],
			queue: [...QUEUE_EVENTS],
			voicemail: [...VOICEMAIL_EVENTS],
		},
		eventTypes: EVENT_ENTRIES.map((entry) => ({
			family: entry.family,
			type: entry.type,
			goType: entry.goName,
		})),
		eventSamples: eventSamples(),
	};
}

// ------------------------------------------------------------------------------------------------
// main
// ------------------------------------------------------------------------------------------------

function gofmt(): void {
	const targets = written
		.filter((path) => path.endsWith(".go"))
		.map((path) => join(REPO_ROOT, path));
	if (targets.length === 0) {
		return;
	}
	try {
		execFileSync("gofmt", ["-w", ...targets], { stdio: "pipe" });
	} catch (error) {
		throw new Error(
			"gofmt failed or is not on PATH. Codegen always formats its output so that the drift " +
				"gate compares canonical Go; install Go (or add it to PATH) and re-run.\n" +
				String((error as { stderr?: Buffer }).stderr ?? error),
		);
	}
}

function main(): void {
	const { eventSchemas, rpcSchemas } = emitJsonSchemas();
	emitGo(eventSchemas, rpcSchemas);
	writeJson(join(GO_DIR, "testdata", "parity.json"), parityGolden());
	gofmt();

	process.stdout.write(`events codegen: wrote ${written.length} files\n`);
	for (const path of written) {
		process.stdout.write(`  ${path}\n`);
	}
}

main();
