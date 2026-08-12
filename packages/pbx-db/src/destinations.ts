/**
 * # The destination contract
 *
 * Almost every PBX feature ends by handing a call somewhere else: a DID points at an IVR, an IVR
 * option points at a ring group, a ring group's timeout points at voicemail. Modelling each of
 * those as its own nullable foreign key would mean one column per feature per pointer and a new
 * migration every time a feature is added, so a destination is stored as a **column trio**:
 *
 * | column               | type | meaning                                                       |
 * | -------------------- | ---- | ------------------------------------------------------------- |
 * | `<p>destination_type` | text | one of {@link DESTINATION_TYPES}                              |
 * | `<p>destination_ref`  | uuid | the target row's id — entity-backed types only                |
 * | `<p>destination_data` | jsonb| the target's literal payload — value-backed types only        |
 *
 * `<p>` is empty for a table's primary destination and `"<name>_"` for secondary ones
 * (`timeout_destination_type`, `failover_destination_type`, …).
 *
 * ## Why no foreign key
 *
 * `destination_ref` deliberately has no `REFERENCES` clause: its target table varies by row.
 * Referential integrity is therefore an application concern — a CRUD layer MUST resolve and
 * validate the target before writing, and MUST re-point or refuse deletion of a row that other
 * rows still target. The database only enforces the *shape* of the trio, via the check constraint
 * built by {@link destinationConsistencySql}.
 *
 * ## Kinds
 *
 * - `entity` — the destination is a row in this database. `ref` is required, `data` is optional
 *   (extra dial-time options such as `{ "confirm": true }`).
 * - `value` — the destination is a literal (an E.164 number, an engine application name). `data`
 *   is required and carries `{ value, … }`; `ref` MUST be null.
 * - `terminal` — the call ends here (`hangup`). Both `ref` and `data` are optional; `data` may
 *   carry `{ "cause": "USER_BUSY" }`.
 */

/**
 * Every destination a compiled route may point at.
 *
 * `park`, `time-condition` and `hangup` are additions to the Phase-0 sketch: an inbound route
 * must be able to enter a time condition, a ring group must be able to park an unanswered call,
 * and every chain needs an explicit terminal so "no destination" is never expressed as NULL.
 *
 * `paging-group` is entity-backed like the rest, but it is the one destination that never continues:
 * a DID or an IVR option may point at a paging group ("press 4 for the warehouse tannoy"), and the
 * call ends when the pager hangs up. That is a property of the target, not of the trio, so it needs
 * nothing special here.
 *
 * # The T2 admin block's four additions
 *
 * `call-flow`, `stream` and `dial-by-name` are destinations in the ordinary sense: a call arrives,
 * the entity decides what happens next, and every one of them compiles to a plan node of its own.
 *
 * `alias` is the odd one and is deliberately here anyway. It is FusionPBX's "bridge" — a named
 * shortcut an administrator points twenty routes at so that moving the target is one edit — with
 * the part this platform refuses removed: upstream a bridge is a raw FreeSWITCH dial STRING, which
 * is an escape hatch straight past the toll gate (`sofia/gateway/…` reaches a carrier with no route,
 * no toll class and no call-block screen). Ours names a destination trio instead, and the compiler
 * expands it FLAT — an `alias` produces no plan node of its own, it resolves to whatever its target
 * resolved to. So it is a macro that happens to be spelled as a destination type, which is the only
 * way to make it usable everywhere a destination is without teaching every pointer a second column.
 */
export const DESTINATION_TYPES = [
	"extension",
	"ivr",
	"ring-group",
	"queue",
	"voicemail",
	"conference",
	"park",
	"paging-group",
	"time-condition",
	"call-flow",
	"stream",
	"dial-by-name",
	"alias",
	"external",
	"application",
	"hangup",
] as const;

export type DestinationType = (typeof DESTINATION_TYPES)[number];

export type DestinationKind = "entity" | "value" | "terminal";

/** Which half of the trio a destination type populates. */
export const DESTINATION_TYPE_KINDS: Readonly<Record<DestinationType, DestinationKind>> = {
	extension: "entity",
	ivr: "entity",
	"ring-group": "entity",
	queue: "entity",
	voicemail: "entity",
	conference: "entity",
	park: "entity",
	"paging-group": "entity",
	"time-condition": "entity",
	"call-flow": "entity",
	stream: "entity",
	"dial-by-name": "entity",
	alias: "entity",
	external: "value",
	application: "value",
	hangup: "terminal",
} as const;

/**
 * Which table an entity-backed `destination_ref` points at. The CRUD layer uses this to resolve
 * and to reverse-index references; `value`/`terminal` types have no target table.
 */
export const DESTINATION_TARGET_TABLES: Readonly<Record<DestinationType, string | null>> = {
	extension: "extension",
	ivr: "ivr_menu",
	"ring-group": "ring_group",
	queue: "queue",
	voicemail: "voicemail_box",
	conference: "conference",
	park: "park_lot",
	"paging-group": "paging_group",
	"time-condition": "time_condition",
	"call-flow": "call_flow",
	stream: "audio_stream",
	"dial-by-name": "dial_by_name_directory",
	alias: "destination_alias",
	external: null,
	application: null,
	hangup: null,
} as const;

/** Payload stored in `<p>destination_data`. `value` is required for value-backed types. */
export interface DestinationData {
	/** E.164 number for `external`; engine application name for `application`. */
	readonly value?: string;
	/** Free-form arguments handed to the engine application. */
	readonly args?: Readonly<Record<string, string | number | boolean>>;
	/** Q.850/FreeSWITCH-extended cause for `hangup`. */
	readonly cause?: string;
}

/** A destination as the application sees it, before it is split into columns. */
export interface Destination {
	readonly destinationType: DestinationType;
	readonly destinationRef?: string | null;
	readonly destinationData?: DestinationData | null;
}

export type DestinationIssueCode =
	| "unknown-type"
	| "missing-ref"
	| "unexpected-ref"
	| "missing-data"
	| "unexpected-data"
	| "invalid-ref";

export interface DestinationIssue {
	readonly code: DestinationIssueCode;
	readonly message: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isDestinationType(value: string): value is DestinationType {
	return DESTINATION_TYPES.some((type) => type === value);
}

export function destinationKind(type: DestinationType): DestinationKind {
	return DESTINATION_TYPE_KINDS[type];
}

export function destinationTargetTable(type: DestinationType): string | null {
	return DESTINATION_TARGET_TABLES[type];
}

/**
 * Validates one destination against the contract documented at the top of this module.
 * Returns every issue rather than the first so a CRUD layer can report a complete field error.
 */
export function validateDestination(destination: Destination): readonly DestinationIssue[] {
	const issues: DestinationIssue[] = [];
	const type = destination.destinationType;

	if (!isDestinationType(type)) {
		return [
			{
				code: "unknown-type",
				message: `Unknown destination type "${String(type)}"; expected one of ${DESTINATION_TYPES.join(", ")}.`,
			},
		];
	}

	const ref = destination.destinationRef ?? null;
	const data = destination.destinationData ?? null;
	const kind = destinationKind(type);

	if (ref !== null && !UUID_PATTERN.test(ref)) {
		issues.push({
			code: "invalid-ref",
			message: `Destination ref "${ref}" is not a UUID.`,
		});
	}

	switch (kind) {
		case "entity": {
			if (ref === null) {
				issues.push({
					code: "missing-ref",
					message: `Destination type "${type}" is entity-backed and requires destinationRef.`,
				});
			}
			break;
		}
		case "value": {
			if (ref !== null) {
				issues.push({
					code: "unexpected-ref",
					message: `Destination type "${type}" is value-backed and must not carry destinationRef.`,
				});
			}
			if (data === null || data.value === undefined || data.value.trim().length === 0) {
				issues.push({
					code: "missing-data",
					message: `Destination type "${type}" requires destinationData.value.`,
				});
			}
			break;
		}
		default: {
			if (ref !== null) {
				issues.push({
					code: "unexpected-ref",
					message: `Destination type "${type}" is terminal and must not carry destinationRef.`,
				});
			}
			if (data !== null && data.value !== undefined) {
				issues.push({
					code: "unexpected-data",
					message: `Destination type "${type}" is terminal and must not carry destinationData.value.`,
				});
			}
			break;
		}
	}

	return issues;
}

export function isValidDestination(destination: Destination): boolean {
	return validateDestination(destination).length === 0;
}

/** Raised by {@link assertDestination}; packages use `…Error`, never a framework exception. */
export class DestinationContractError extends Error {
	readonly _tag = "DestinationContractError" as const;
	readonly issues: readonly DestinationIssue[];

	constructor(issues: readonly DestinationIssue[]) {
		super(`Invalid destination: ${issues.map((issue) => issue.message).join(" ")}`);
		this.name = "DestinationContractError";
		this.issues = issues;
	}
}

export function assertDestination(destination: Destination): void {
	const issues = validateDestination(destination);
	if (issues.length > 0) {
		throw new DestinationContractError(issues);
	}
}

const COLUMN_PREFIX_PATTERN = /^(?:[a-z][a-z0-9_]{0,30}_)?$/u;

/** Raised when a destination trio would be built from an unsafe column prefix. */
export class DestinationColumnPrefixError extends Error {
	readonly _tag = "DestinationColumnPrefixError" as const;

	constructor(prefix: string) {
		super(
			`Destination column prefix "${prefix}" must match ${String(COLUMN_PREFIX_PATTERN)} so it is safe to inline into DDL.`,
		);
		this.name = "DestinationColumnPrefixError";
	}
}

export interface DestinationColumnNames {
	readonly type: string;
	readonly ref: string;
	readonly data: string;
}

/** Physical column names of one destination trio, e.g. `timeout_destination_type`. */
export function destinationColumnNames(prefix = ""): DestinationColumnNames {
	if (!COLUMN_PREFIX_PATTERN.test(prefix)) {
		throw new DestinationColumnPrefixError(prefix);
	}
	return {
		type: `${prefix}destination_type`,
		ref: `${prefix}destination_ref`,
		data: `${prefix}destination_data`,
	};
}

const ENTITY_DESTINATION_TYPES = DESTINATION_TYPES.filter(
	(type) => DESTINATION_TYPE_KINDS[type] === "entity",
);

const VALUE_DESTINATION_TYPES = DESTINATION_TYPES.filter(
	(type) => DESTINATION_TYPE_KINDS[type] === "value",
);

function quotedTypeList(types: readonly DestinationType[]): string {
	return types.map((type) => `'${type}'`).join(", ");
}

/**
 * The database half of the contract: entity types must carry a ref, value types must carry data
 * and no ref, terminal types carry neither. Optional trios (`type` nullable) pass when the whole
 * trio is NULL. This is deliberately weaker than {@link validateDestination} — the database
 * cannot check that a ref resolves — but it makes the invalid shapes unrepresentable.
 */
export function destinationConsistencySql(prefix = "", optional = false): string {
	const names = destinationColumnNames(prefix);
	const clauses = [
		`(${names.type} in (${quotedTypeList(ENTITY_DESTINATION_TYPES)}) and ${names.ref} is not null)`,
		`(${names.type} in (${quotedTypeList(VALUE_DESTINATION_TYPES)}) and ${names.ref} is null and ${names.data} is not null)`,
		`(${names.type} = 'hangup' and ${names.ref} is null)`,
	];
	if (optional) {
		clauses.unshift(`(${names.type} is null and ${names.ref} is null and ${names.data} is null)`);
	}
	return clauses.join(" or ");
}
