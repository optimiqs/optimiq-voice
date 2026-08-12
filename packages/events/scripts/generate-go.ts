#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
	EXTENDED_HANGUP_CAUSES,
	HANGUP_CAUSE_CODES,
	type HangupCause,
	Q850_HANGUP_CAUSES,
} from "@optimiq-voice/telephony";
import { makeAuditEvent } from "../src/schemas/audit-events";
import { makeCallEvent } from "../src/schemas/call-events";
import { makeCdrLegWriteEvent } from "../src/schemas/cdr-events";
import { makeMediaEvent } from "../src/schemas/media-events";
import { makeProvisionEvent } from "../src/schemas/provision-events";
import { makeQueueEvent } from "../src/schemas/queue-events";
import { makeRegistrationEvent } from "../src/schemas/registration-events";
import { makeTrunkEvent } from "../src/schemas/trunk-events";
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
	instanceSubjectToken,
	matchesSubject,
	MEDIA_SESSION_EVENTS,
	parseSubject,
	QUEUE_EVENTS,
	QUEUE_SCOPE_ALL,
	REGISTRATION_EVENTS,
	RPC_SUBJECTS,
	SUBJECT_ROOTS,
	SUBJECT_VERSION,
	subjectFilterFor,
	subjectFor,
	TRUNK_EVENTS,
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

/**
 * `SCREAMING_SNAKE` → `PascalCase`, for a Go identifier built from a cause name.
 *
 * Deliberately naive: it upper-cases the first rune of each underscore-separated run and lower-cases
 * the rest, so `BEARERCAPABILITY_NOTAUTH` becomes `BearercapabilityNotauth` rather than anything
 * cleverer. A table of special cases here would be a second opinion about a name whose authority is
 * `packages/telephony`, and the generated identifier only has to be stable and unambiguous — it is
 * never the value on the wire, which stays the SCREAMING_SNAKE string.
 */
function goCauseIdentifier(cause: string): string {
	return cause
		.split("_")
		.map((part) => part.charAt(0) + part.slice(1).toLowerCase())
		.join("");
}

/**
 * The Q.850 table, in Go — generated from `@optimiq-voice/telephony`, which is the authority.
 *
 * ## The direction, stated once, because it was the open question
 *
 * TypeScript already HAD the canonical table (`packages/telephony/src/hangup-causes.ts`, pinned by
 * its own spec against the frozen reference §6), and `apps/sipd/internal/dialog/cause.go` had grown
 * a hand-written subset of the same numbers. Two hand-written copies of a table whose values end up
 * on billed CDR rows is the drift this repository already spends a codegen step avoiding everywhere
 * else, so the Go side becomes a GENERATED COPY and the TypeScript side stays the source. The
 * alternative — moving the table into Go and generating TypeScript — would put a domain vocabulary
 * that the routing executor, the session protocol and the CDR writer all key off behind a Go build.
 *
 * `sipd` keeps its `Cause*` constants (they read well at a SIP call site and the SIP→Q.850 mapping
 * is genuinely the edge's own knowledge); their VALUES now come from here, so a re-coded cause is a
 * one-line change in one file rather than a silent disagreement between two.
 *
 * ## Why this is in `events-go` rather than a `telephony-go` module
 *
 * `apps/sipd` and `apps/mediad` already depend on `packages/events-go` and on nothing else shared.
 * A second Go module for one table would be a `go.work` entry, a `replace` directive in two `go.mod`
 * files and a release step, bought for tidiness alone.
 *
 * ## Not the schema's business
 *
 * `hangupCauseSchema` still validates the SHAPE and not the membership, for the reason its own
 * JSDoc gives: carriers keep inventing causes, and an unrecognised one must reach the CDR writer
 * rather than being terminated at the broker edge. Generating this table does not close that door —
 * nothing here is used to reject a payload.
 */
function emitHangupCauses(): void {
	const emitter = new GoFileEmitter({ namedEnums: [] });
	const all = [...Q850_HANGUP_CAUSES, ...EXTENDED_HANGUP_CAUSES] as readonly HangupCause[];

	emitter.declareRaw(
		"type:HangupCause",
		[
			"// HangupCause is a hangup-cause NAME — the value stored on `call_legs.hangup_cause` and",
			"// carried by `cdr.leg.v1` and the `dialog.terminated` event.",
			"//",
			"// A plain string type rather than a closed enum, deliberately: a cause this build does not",
			"// know must still reach the CDR writer, which stores the numeric code verbatim and falls back",
			"// to NORMAL_UNSPECIFIED.",
			"type HangupCause string",
		].join("\n"),
	);

	emitter.declareRaw(
		"consts:HangupCause",
		[
			"// The named causes. Q.850 1-127 first, then the FreeSWITCH extensions.",
			"const (",
			...all.map(
				(cause) =>
					`\tHangupCause${goCauseIdentifier(cause)} HangupCause = ${JSON.stringify(cause)}`,
			),
			")",
		].join("\n"),
	);

	emitter.declareRaw(
		"consts:HangupCode",
		[
			"// The numeric code for each named cause, as untyped constants.",
			"//",
			"// Constants rather than only the map below, because a Go caller that wants a compile-time",
			"// constant cannot get one out of a map — `apps/sipd/internal/dialog/cause.go` defines its",
			"// whole Cause* set in terms of these.",
			"const (",
			...all.map(
				(cause) => `\tHangupCode${goCauseIdentifier(cause)} = ${HANGUP_CAUSE_CODES[cause]}`,
			),
			")",
		].join("\n"),
	);

	emitter.declareRaw(
		"var:Q850HangupCauses",
		[
			"// Q850HangupCauses lists the Q.850 members, in contract order.",
			"var Q850HangupCauses = []HangupCause{",
			...Q850_HANGUP_CAUSES.map((cause) => `\tHangupCause${goCauseIdentifier(cause)},`),
			"}",
			"",
			"// ExtendedHangupCauses lists the FreeSWITCH extensions, in contract order.",
			"var ExtendedHangupCauses = []HangupCause{",
			...EXTENDED_HANGUP_CAUSES.map((cause) => `\tHangupCause${goCauseIdentifier(cause)},`),
			"}",
			"",
			"// HangupCauses lists every named cause, Q.850 first. Contract order, matching",
			"// HANGUP_CAUSES in packages/telephony.",
			"var HangupCauses = append(append([]HangupCause{}, Q850HangupCauses...), ExtendedHangupCauses...)",
		].join("\n"),
	);

	emitter.declareRaw(
		"var:HangupCauseCodes",
		[
			"// HangupCauseCodes maps a cause name onto its numeric code.",
			"var HangupCauseCodes = map[HangupCause]int{",
			...all.map(
				(cause) =>
					`\tHangupCause${goCauseIdentifier(cause)}: HangupCode${goCauseIdentifier(cause)},`,
			),
			"}",
			"",
			"// HangupCauseNames maps a numeric code back onto its name.",
			"//",
			"// Built from the same generated pairs as HangupCauseCodes, so the two cannot diverge — the",
			"// property HANGUP_CAUSE_NAMES gets in TypeScript by construction.",
			"var HangupCauseNames = func() map[int]HangupCause {",
			"\tnames := make(map[int]HangupCause, len(HangupCauseCodes))",
			"\tfor cause, code := range HangupCauseCodes {",
			"\t\tnames[code] = cause",
			"\t}",
			"\treturn names",
			"}()",
		].join("\n"),
	);

	emitter.declareRaw(
		"func:HangupCauseHelpers",
		[
			"// HangupCauseCodeOf returns the numeric code for a cause name, and whether it is a name this",
			'// contract knows. An unknown name yields 0, which is NONE — the "no cause recorded" sentinel',
			"// and never a real outcome, so a caller that ignores the boolean cannot bill from it.",
			"func HangupCauseCodeOf(cause HangupCause) (int, bool) {",
			"\tcode, found := HangupCauseCodes[cause]",
			"\treturn code, found",
			"}",
			"",
			"// HangupCauseFromCode returns the name for a numeric code.",
			"//",
			"// Only the ~65 points a softswitch actually emits are named; anything else a carrier sends is",
			"// stored as its raw code with NORMAL_UNSPECIFIED, which is why this reports absence rather",
			"// than inventing a name.",
			"func HangupCauseFromCode(code int) (HangupCause, bool) {",
			"\tcause, found := HangupCauseNames[code]",
			"\treturn cause, found",
			"}",
			"",
			"// IsHangupCause reports whether a string arriving from the wire is a name this contract knows.",
			"func IsHangupCause(value string) bool {",
			"\t_, found := HangupCauseCodes[HangupCause(value)]",
			"\treturn found",
			"}",
		].join("\n"),
	);

	writeText(
		join(GO_DIR, "hangup_causes_gen.go"),
		emitter.render(
			[
				"The Q.850 hangup-cause taxonomy, plus the FreeSWITCH extensions.",
				"",
				"Authority: packages/telephony/src/hangup-causes.ts, itself pinned against the frozen",
				"reference §6 by its own spec. This is a GENERATED COPY so that Go and TypeScript read one",
				"table: renaming a member is a breaking change for every stored CDR row, and re-coding one",
				"silently changes outbound failover, so neither may be decided twice.",
				"",
				"apps/sipd/internal/dialog/cause.go defines its Cause* constants in terms of the HangupCode*",
				"constants here. The SIP status -> Q.850 mapping stays in sipd: that one IS the edge's own",
				"knowledge (RFC 3398), and nothing outside the SIP stack has an opinion about it.",
			],
			"events",
		),
	);
}

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

	emitHangupCauses();

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
				"Contracts only: transport is the application's business.",
				"",
				"rpc.media.v1.* is the exception that proves the rule: apps/mediad is the RESPONDER for",
				"those four, so the request/response structs below are the wire, not documentation. Both",
				"ends must be raw NATS — a NestJS ClientProxy would wrap the payload in its own framing",
				"and mediad would reject it. See packages/events/src/schemas/rpc.ts.",
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
const SESSION_A = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b53";
/** The supervisor's own leg and call, for the tap samples: a tap names two calls, never one. */
const SUPERVISOR_LEG_A = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b54";
const SUPERVISOR_CALL_A = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b55";
const PAGING_GROUP_A = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b56";
const TRUNK_A = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b57";
const MEDIAD_INSTANCE = "mediad-7c9f2a1b";
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

// Instance ids that exercise both branches of instanceSubjectToken: verbatim when the id is already
// one subject token, SHA-256/32-hex when it carries a dot or punctuation. The engine builds
// rpc.sip.v1.<verb>.<tok> from these and apps/sipd subscribes with them, so a Go/TS disagreement is a
// command addressed at a subject nobody is listening on.
const INSTANCE_ID_CASES = [
	"sipd",
	"sipd-2",
	"engine-7d9f4c-xk2lp",
	"  sipd  ",
	"sipd.eu-west.internal",
	"host name with spaces",
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
		name: "call.tap.started",
		goType: "CallTapStartedData",
		envelope: makeCallEvent("call.tap.started", {
			...next(),
			orgId: ORG_A,
			// The subject is the MONITORED call, not the supervisor's — see the schema's own note.
			callId: CALL_A,
			data: {
				legId: SUPERVISOR_LEG_A,
				mode: "whisper",
				supervisorExtension: "1900",
				targetExtension: "1001",
				targetLegId: LEG_A,
				previousMode: "eavesdrop",
				supervisorCallId: SUPERVISOR_CALL_A,
			},
		}),
	});
	samples.push({
		name: "call.tap.ended",
		goType: "CallTapEndedData",
		envelope: makeCallEvent("call.tap.ended", {
			...next(),
			orgId: ORG_A,
			callId: CALL_A,
			data: {
				legId: SUPERVISOR_LEG_A,
				mode: "whisper",
				supervisorExtension: "1900",
				targetExtension: "1001",
				reason: "target-ended",
				durationMs: 42_000,
			},
		}),
	});
	samples.push({
		name: "call.paging.started",
		goType: "CallPagingStartedData",
		envelope: makeCallEvent("call.paging.started", {
			...next(),
			orgId: ORG_A,
			callId: CALL_A,
			data: {
				legId: LEG_A,
				pagingGroupId: PAGING_GROUP_A,
				pagingGroupName: "Warehouse",
				dialed: "*81300",
				pagerExtension: "1001",
				memberCount: 12,
				// Two handsets were unregistered. The whole point of carrying both numbers.
				answeredCount: 10,
				oneWay: true,
			},
		}),
	});
	samples.push({
		name: "call.paging.ended",
		goType: "CallPagingEndedData",
		envelope: makeCallEvent("call.paging.ended", {
			...next(),
			orgId: ORG_A,
			callId: CALL_A,
			data: {
				legId: LEG_A,
				pagingGroupId: PAGING_GROUP_A,
				pagingGroupName: "Warehouse",
				durationMs: 9_500,
				answeredCount: 10,
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
		name: "media.session.ended",
		goType: "MediaSessionEndedData",
		envelope: makeMediaEvent("session.ended", {
			...next(),
			source: "mediad",
			orgId: ORG_A,
			data: {
				sessionId: SESSION_A,
				instanceId: MEDIAD_INSTANCE,
				callId: CALL_A,
				legId: LEG_A,
				rtpPort: 30_004,
				packetsReceived: 2_100,
				packetsSent: 2_098,
				reason: "released",
				durationMs: 42_000,
			},
		}),
	});
	samples.push({
		name: "media.session.rtp-timeout",
		goType: "MediaSessionRTPTimeoutData",
		envelope: makeMediaEvent("session.rtp-timeout", {
			...next(),
			source: "mediad",
			orgId: ORG_A,
			data: {
				sessionId: SESSION_A,
				instanceId: MEDIAD_INSTANCE,
				callId: CALL_A,
				rtpPort: 30_004,
				packetsReceived: 640,
				packetsSent: 640,
				silentForMs: 30_000,
				remoteAddress: "203.0.113.9:41000",
			},
		}),
	});

	samples.push({
		name: "trunk.status.changed",
		goType: "TrunkStatusChangedData",
		envelope: makeTrunkEvent("status.changed", {
			...next(),
			source: "engine",
			orgId: ORG_A,
			trunkId: TRUNK_A,
			data: {
				status: "down",
				reason: "Unreachable",
				latencyMs: 1_240,
				endpoint: "carrier-a",
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
			builder: "sipDialog",
			args: [ORG_A, LEG_A, "dialog.answered"],
			subject: subjectFor.sipDialog(ORG_A, LEG_A, "dialog.answered"),
		},
		{
			// A dotted event on the second root that begins `sip.`, so a Go builder that confused
			// `sip.evt` with `sip.reg` fails here rather than at three in the morning.
			builder: "sipDialog",
			args: [ORG_B, LEG_A, "dialog.terminated"],
			subject: subjectFor.sipDialog(ORG_B, LEG_A, "dialog.terminated"),
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
		{
			builder: "media",
			args: [ORG_A, SESSION_A, "session.ended"],
			subject: subjectFor.media(ORG_A, SESSION_A, "session.ended"),
		},
		{
			builder: "media",
			args: [ORG_A, SESSION_A, "session.rtp-timeout"],
			subject: subjectFor.media(ORG_A, SESSION_A, "session.rtp-timeout"),
		},
		{
			builder: "trunk",
			args: [ORG_A, TRUNK_A, "status.changed"],
			subject: subjectFor.trunk(ORG_A, TRUNK_A, "status.changed"),
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
		{ filter: "allSipDialogs", args: [], result: subjectFilterFor.allSipDialogs() },
		{
			filter: "sipDialogsInOrg",
			args: [ORG_A],
			result: subjectFilterFor.sipDialogsInOrg(ORG_A),
		},
		{
			filter: "sipDialog",
			args: [ORG_A, LEG_A],
			result: subjectFilterFor.sipDialog(ORG_A, LEG_A),
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
		{ filter: "allMedia", args: [], result: subjectFilterFor.allMedia() },
		{ filter: "mediaInOrg", args: [ORG_A], result: subjectFilterFor.mediaInOrg(ORG_A) },
		{
			filter: "mediaSession",
			args: [ORG_A, SESSION_A],
			result: subjectFilterFor.mediaSession(ORG_A, SESSION_A),
		},
		{
			filter: "mediaEventInOrg",
			args: [ORG_A, "session.ended"],
			result: subjectFilterFor.mediaEventInOrg(ORG_A, "session.ended"),
		},
		{ filter: "allTrunks", args: [], result: subjectFilterFor.allTrunks() },
		{ filter: "trunksInOrg", args: [ORG_A], result: subjectFilterFor.trunksInOrg(ORG_A) },
		{
			filter: "trunkStatusInOrg",
			args: [ORG_A],
			result: subjectFilterFor.trunkStatusInOrg(ORG_A),
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
		subjectFor.media(ORG_A, SESSION_A, "session.rtp-timeout"),
		subjectFor.trunk(ORG_A, TRUNK_A, "status.changed"),
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
		instanceSubjectTokens: INSTANCE_ID_CASES.map((instanceId) => ({
			instanceId,
			token: instanceSubjectToken(instanceId),
		})),
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
			{
				builder: "queueMembership",
				args: [ORG_A, QUEUE_A],
				key: kvKeyFor.queueMembership(ORG_A, QUEUE_A),
			},
			{
				builder: "queueWaiting",
				args: [ORG_A, QUEUE_A],
				key: kvKeyFor.queueWaiting(ORG_A, QUEUE_A),
			},
			{ builder: "mediaSession", args: [SESSION_A], key: kvKeyFor.mediaSession(SESSION_A) },
			{ builder: "sipDialog", args: [LEG_A], key: kvKeyFor.sipDialog(LEG_A) },
			{ builder: "trunk", args: [ORG_A, TRUNK_A], key: kvKeyFor.trunk(ORG_A, TRUNK_A) },
			// The one key in this file that TRANSFORMS its argument. Both writers and the reader go
			// through one function; these vectors are what makes "both" true across the language
			// border, and a Go folder that dropped the slash would produce a key nobody else writes.
			{ builder: "sipAcl", args: ["203.0.113.0/24"], key: kvKeyFor.sipAcl("203.0.113.0/24") },
			{ builder: "sipAcl", args: ["2001:db8::/32"], key: kvKeyFor.sipAcl("2001:db8::/32") },
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
			media: [...MEDIA_SESSION_EVENTS],
			trunk: [...TRUNK_EVENTS],
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

function oxfmtJson(): void {
	const targets = written
		.filter((path) => path.endsWith(".json"))
		.map((path) => join(REPO_ROOT, path));
	if (targets.length === 0) {
		return;
	}
	try {
		execFileSync(join(REPO_ROOT, "node_modules", ".bin", "oxfmt"), targets, { stdio: "pipe" });
	} catch (error) {
		throw new Error(
			"oxfmt failed. Codegen always formats its output so that the drift gate compares the " +
				"same canonical JSON the commit hook produces; re-run after `pnpm install`.\n" +
				String((error as { stderr?: Buffer }).stderr ?? error),
		);
	}
}

function main(): void {
	const { eventSchemas, rpcSchemas } = emitJsonSchemas();
	emitGo(eventSchemas, rpcSchemas);
	writeJson(join(GO_DIR, "testdata", "parity.json"), parityGolden());
	gofmt();
	oxfmtJson();

	process.stdout.write(`events codegen: wrote ${written.length} files\n`);
	for (const path of written) {
		process.stdout.write(`  ${path}\n`);
	}
}

main();
