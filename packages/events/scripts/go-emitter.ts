import type { NamedEnum } from "./registry";

/**
 * A deterministic JSON Schema → Go struct emitter.
 *
 * ## Why hand-rolled rather than `go-jsonschema` / `quicktype`
 *
 * The TODO in `src/schemas/index.ts` named `go-jsonschema` as a candidate. It was evaluated and
 * rejected for this contract, on four grounds:
 *
 * 1. **Optionality is the whole game here.** Half the contract is `z.optional()` / `z.nullish()`,
 *    and the Go representation must be `*T` + `omitempty` so that "absent" round-trips as absent.
 *    `go-jsonschema` emits value types with `omitempty` for optional scalars, which silently turns
 *    `expiresInSeconds: 0` and `refreshed: false` into "field not sent" — a wire-format bug in a
 *    contract package.
 * 2. **`z.looseObject` passthrough.** `cdr.leg.write` deliberately passes unknown keys THROUGH to
 *    the CDR writer (`cdr-events.ts` header). No off-the-shelf generator emits the
 *    `Extra map[string]json.RawMessage` + `MarshalJSON`/`UnmarshalJSON` pair that preserves them,
 *    so the generated Go would be lossy exactly where the TS contract promises it is not.
 * 3. **Named vocabularies.** The nine telephony enums must become ONE Go type each, shared across
 *    families, not a fresh anonymous type per field. That needs the value-set matching in
 *    {@link namedEnumFor}, which is registry knowledge a generic tool does not have.
 * 4. **Toolchain weight.** `go-jsonschema` is a Go binary that CI would have to install and pin;
 *    the drift gate would then be sensitive to ITS version, not just to our schemas. The emitter
 *    below is ~400 lines of TypeScript in the same package as the schemas it reads, versioned with
 *    them, and needs nothing beyond `gofmt` (which any machine that can build `apps/sipd` has).
 *
 * The schemas are flat by design (`envelope.ts`: additive-only, no inheritance, no `$ref` graphs),
 * so the surface a generator must cover is small and fully enumerated by {@link goTypeFor}. Any
 * construct outside it throws rather than guessing.
 */

/** The JSON Schema subset zod 4 emits for this contract. Anything else is a hard error. */
export interface JsonSchema {
	readonly $schema?: string;
	readonly type?: string;
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean | JsonSchema;
	readonly propertyNames?: JsonSchema;
	readonly items?: JsonSchema;
	readonly enum?: readonly string[];
	readonly const?: string;
	readonly anyOf?: readonly JsonSchema[];
	readonly oneOf?: readonly JsonSchema[];
	readonly format?: string;
	readonly pattern?: string;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly description?: string;
}

/** Word fragments that are capitalised wholesale, Go style (`golint` initialisms + ours). */
const INITIALISMS = new Map<string, string>([
	["acd", "ACD"],
	["aor", "AOR"],
	["api", "API"],
	["cdr", "CDR"],
	["dtmf", "DTMF"],
	["http", "HTTP"],
	["id", "ID"],
	["ids", "IDs"],
	["ip", "IP"],
	["json", "JSON"],
	["kv", "KV"],
	["mac", "MAC"],
	["moh", "MOH"],
	["mwi", "MWI"],
	["nat", "NAT"],
	["rfc2833", "RFC2833"],
	["rpc", "RPC"],
	["sdp", "SDP"],
	["sip", "SIP"],
	["tcp", "TCP"],
	["tls", "TLS"],
	["ttl", "TTL"],
	["udp", "UDP"],
	["uri", "URI"],
	["url", "URL"],
	["uuid", "UUID"],
	["ws", "WS"],
	["wss", "WSS"],
]);

/** Splits `camelCase`, `kebab-case` and `snake_case` into lower-cased words. */
export function splitWords(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[\s_.-]+/)
		.filter((word) => word.length > 0);
}

/** `aorHash` → `AORHash`, `api-key` → `APIKey`, `channel.record.started` → `ChannelRecordStarted`. */
export function pascal(name: string): string {
	return splitWords(name)
		.map((word) => {
			const lower = word.toLowerCase();
			return INITIALISMS.get(lower) ?? lower.charAt(0).toUpperCase() + lower.slice(1);
		})
		.join("");
}

/** The prefix nested/inline types hang off: the parent type name minus a trailing `Data`. */
function nestedBase(parentName: string): string {
	return parentName.endsWith("Data") ? parentName.slice(0, -"Data".length) : parentName;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Unwraps `anyOf: [X, {type: "null"}]` — zod's shape for `.nullable()` / `.nullish()`. */
function unwrapNullable(schema: JsonSchema): { readonly inner: JsonSchema; readonly nullable: boolean } {
	const branches = schema.anyOf;
	if (branches === undefined || branches.length !== 2) {
		return { inner: schema, nullable: false };
	}
	const nullIndex = branches.findIndex((branch) => branch.type === "null");
	if (nullIndex === -1) {
		return { inner: schema, nullable: false };
	}
	return { inner: branches[nullIndex === 0 ? 1 : 0] as JsonSchema, nullable: true };
}

/** A schema with no constraints at all — zod's `z.unknown()`. */
function isUnconstrained(schema: JsonSchema): boolean {
	return Object.keys(schema).filter((key) => key !== "$schema").length === 0;
}

/** Go's zero value is indistinguishable from "absent" for these, so absence needs a pointer. */
function needsPointer(goType: string): boolean {
	return !(
		goType.startsWith("[]") ||
		goType.startsWith("map[") ||
		goType === "json.RawMessage"
	);
}

/** One emitted Go declaration, in file order. */
interface Declaration {
	readonly name: string;
	source: string;
}

export interface EmitOptions {
	/** Telephony vocabularies that get a shared named type instead of a per-field one. */
	readonly namedEnums: readonly NamedEnum[];
}

/**
 * Accumulates Go declarations across a whole file. One emitter per generated file so that type
 * names collide loudly within a file and are checked against the shared enum table across files.
 */
export class GoFileEmitter {
	private readonly declarations: Declaration[] = [];
	private readonly byName = new Map<string, Declaration>();
	readonly imports = new Set<string>();

	constructor(private readonly options: EmitOptions) {}

	/** Emits a top-level struct (or map/alias) for a payload schema. Returns its Go type name. */
	declareStruct(name: string, doc: readonly string[], schema: JsonSchema): string {
		const resolved = this.goTypeFor(name, schema, { topLevelName: name, doc });
		if (resolved !== name) {
			throw new Error(
				`Schema for ${name} is not an object (resolved to ${resolved}); the registry expects ` +
					"every event payload and RPC message to be a JSON object.",
			);
		}
		return name;
	}

	/** Emits a named enum type shared across files (idempotent for the same value set). */
	declareNamedEnum(entry: NamedEnum): void {
		this.pushEnum(entry.goName, [entry.doc, "", `Source: packages/events/src/schemas/${entry.source}.`], entry.values);
	}

	/** Emits a free-standing const block, verbatim. */
	declareRaw(name: string, source: string): void {
		this.push({ name, source });
	}

	/** The finished file body, declarations in emit order. */
	render(packageDoc: readonly string[], packageName: string): string {
		const lines: string[] = [
			"// Code generated by packages/events/scripts/generate-go.ts. DO NOT EDIT.",
			"//",
			"// Source of truth: packages/events/src (Zod) -> packages/events/schema (JSON Schema) -> here.",
			"// Regenerate with `pnpm --filter @optimiq-voice/events codegen`.",
			"",
		];
		for (const line of packageDoc) {
			lines.push(line.length === 0 ? "//" : `// ${line}`);
		}
		// Blank line before the clause: the package doc comment lives in doc.go, and a comment
		// glued to `package` here would make every generated file claim to be it.
		lines.push("", `package ${packageName}`, "");
		if (this.imports.size > 0) {
			const sorted = [...this.imports].sort();
			if (sorted.length === 1) {
				lines.push(`import ${JSON.stringify(sorted[0])}`, "");
			} else {
				lines.push("import (");
				for (const path of sorted) {
					lines.push(`\t${JSON.stringify(path)}`);
				}
				lines.push(")", "");
			}
		}
		lines.push(...this.declarations.map((declaration) => declaration.source));
		return `${lines.join("\n").trimEnd()}\n`;
	}

	private push(declaration: Declaration): void {
		const existing = this.byName.get(declaration.name);
		if (existing !== undefined) {
			if (existing.source === declaration.source) {
				return;
			}
			throw new Error(
				`Go type name collision: ${declaration.name} is generated twice with different ` +
					"definitions. Give one of them an explicit name in scripts/registry.ts.",
			);
		}
		this.byName.set(declaration.name, declaration);
		this.declarations.push(declaration);
	}

	private namedEnumFor(values: readonly string[]): NamedEnum | undefined {
		return this.options.namedEnums.find((candidate) => sameValues(candidate.values, values));
	}

	private pushEnum(name: string, doc: readonly string[], values: readonly string[]): void {
		const lines: string[] = [];
		lines.push(...docComment(name, doc));
		lines.push(`type ${name} string`, "");
		lines.push("const (");
		for (const value of values) {
			lines.push(`\t${name}${pascal(value)} ${name} = ${JSON.stringify(value)}`);
		}
		lines.push(")", "");
		lines.push(`// ${name}Values lists every member of the vocabulary, in contract order.`);
		lines.push(`var ${name}Values = []${name}{`);
		for (const value of values) {
			lines.push(`\t${name}${pascal(value)},`);
		}
		lines.push("}", "");
		lines.push(`// Valid reports whether v is a member of the ${name} vocabulary.`);
		lines.push(`func (v ${name}) Valid() bool {`);
		lines.push(`\tfor _, candidate := range ${name}Values {`);
		lines.push("\t\tif v == candidate {");
		lines.push("\t\t\treturn true");
		lines.push("\t\t}");
		lines.push("\t}");
		lines.push("\treturn false");
		lines.push("}", "");
		lines.push(`func (v ${name}) String() string { return string(v) }`, "");
		this.push({ name, source: lines.join("\n") });
	}

	/**
	 * Resolves a schema to a Go type, emitting any named types it needs on the way.
	 *
	 * `owner` is the type name nested/inline types hang off; `topLevelName` forces the name of the
	 * struct for the schema itself (used for the payload roots).
	 */
	private goTypeFor(
		owner: string,
		schema: JsonSchema,
		context: { readonly topLevelName?: string; readonly doc?: readonly string[]; readonly field?: string },
	): string {
		if (isUnconstrained(schema)) {
			this.imports.add("encoding/json");
			return "json.RawMessage";
		}

		if (schema.enum !== undefined) {
			if (schema.type !== "string") {
				throw new Error(`Only string enums are supported; ${owner} has a ${schema.type} enum.`);
			}
			const named = this.namedEnumFor(schema.enum);
			if (named !== undefined) {
				return named.goName;
			}
			const name = context.topLevelName ?? `${nestedBase(owner)}${pascal(context.field ?? "value")}`;
			this.pushEnum(
				name,
				context.doc ?? [`the closed vocabulary of ${owner}.${context.field ?? ""}.`],
				schema.enum,
			);
			return name;
		}

		switch (schema.type) {
			case "string":
				// `z.iso.datetime()` — decoded as an instant rather than a string so Go consumers get
				// a time.Time and Go producers re-emit the exact millisecond-precision shape
				// `Date.prototype.toISOString()` writes (see EventTime in envelope.go).
				return schema.format === "date-time" ? "EventTime" : "string";
			case "integer":
				return "int";
			case "number":
				return "float64";
			case "boolean":
				return "bool";
			case "array": {
				if (schema.items === undefined) {
					throw new Error(`Array schema for ${owner} has no items.`);
				}
				const element = this.goTypeFor(owner, schema.items, { field: context.field });
				return `[]${element}`;
			}
			case "object":
				break;
			default:
				throw new Error(`Unsupported JSON Schema type ${String(schema.type)} in ${owner}.`);
		}

		// A record (`z.record`): no declared properties, but an additionalProperties value schema.
		if (schema.properties === undefined) {
			const value = schema.additionalProperties;
			if (typeof value !== "object") {
				throw new Error(`Object schema for ${owner} has neither properties nor a value schema.`);
			}
			const entryName = `${nestedBase(owner)}${pascal(context.field ?? "entry")}Entry`;
			const valueType = this.goTypeFor(entryName, value, { topLevelName: entryName });
			return `map[string]${valueType}`;
		}

		const name = context.topLevelName ?? `${nestedBase(owner)}${pascal(context.field ?? "value")}`;
		// Reserve the slot before recursing so nested types are emitted after their parent.
		const declaration: Declaration = { name, source: "" };
		this.push(declaration);

		const required = new Set(schema.required ?? []);
		const loose = typeof schema.additionalProperties === "object";
		const lines: string[] = [];
		lines.push(...docComment(name, context.doc ?? ["a payload fragment of the contract."]));
		lines.push(`type ${name} struct {`);

		const knownKeys: string[] = [];
		for (const [jsonName, propertySchema] of Object.entries(schema.properties)) {
			knownKeys.push(jsonName);
			const { inner, nullable } = unwrapNullable(propertySchema);
			const optional = nullable || !required.has(jsonName);
			const goType = this.goTypeFor(name, inner, { field: jsonName });
			const pointer = optional && needsPointer(goType);
			const tag = optional ? `${jsonName},omitempty` : jsonName;
			lines.push(`\t${pascal(jsonName)} ${pointer ? "*" : ""}${goType} \`json:${JSON.stringify(tag)}\``);
		}

		if (loose) {
			this.imports.add("encoding/json");
			lines.push("");
			lines.push("\t// Extra carries every key outside the pinned contract, verbatim. The TS schema is a");
			lines.push("\t// z.looseObject (see cdr-events.ts) precisely so a producer running ahead of the");
			lines.push("\t// consumer is not silently truncated; dropping these on the Go side would reintroduce");
			lines.push("\t// the loss the loose schema exists to prevent.");
			lines.push("\tExtra map[string]json.RawMessage `json:\"-\"`");
		}

		lines.push("}", "");

		if (loose) {
			const keysVar = `knownKeys${name}`;
			lines.push(`// MarshalJSON merges Extra back into the object, pinned fields winning on conflict.`);
			lines.push(`func (v ${name}) MarshalJSON() ([]byte, error) {`);
			lines.push(`\ttype alias ${name}`);
			lines.push("\treturn marshalWithExtras(alias(v), v.Extra)");
			lines.push("}", "");
			lines.push(`// UnmarshalJSON captures unknown keys into Extra instead of discarding them.`);
			lines.push(`func (v *${name}) UnmarshalJSON(data []byte) error {`);
			lines.push(`\ttype alias ${name}`);
			lines.push("\tvar inner alias");
			lines.push(`\textra, err := unmarshalWithExtras(data, &inner, ${keysVar})`);
			lines.push("\tif err != nil {");
			lines.push("\t\treturn err");
			lines.push("\t}");
			lines.push(`\t*v = ${name}(inner)`);
			lines.push("\tv.Extra = extra");
			lines.push("\treturn nil");
			lines.push("}", "");
			lines.push(`var ${keysVar} = map[string]struct{}{`);
			for (const key of knownKeys) {
				lines.push(`\t${JSON.stringify(key)}: {},`);
			}
			lines.push("}", "");
		}

		declaration.source = lines.join("\n");
		this.byName.set(name, declaration);
		return name;
	}
}

/**
 * Go doc comments start with the declared name. A `doc` head that starts lower-case is a sentence
 * FRAGMENT and gets an `is`; one that starts upper-case is already a sentence and gets an em dash.
 */
function docComment(name: string, doc: readonly string[]): string[] {
	const [first, ...rest] = doc;
	const head = first === undefined || first.length === 0 ? "is part of the event contract." : first;
	const joiner = head.charAt(0) === head.charAt(0).toUpperCase() ? "—" : "is";
	const lines = [`// ${name} ${joiner} ${head}`];
	for (const line of rest) {
		lines.push(line.length === 0 ? "//" : `// ${line}`);
	}
	return lines;
}
