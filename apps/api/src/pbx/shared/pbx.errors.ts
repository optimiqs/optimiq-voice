import {
	BadRequestException,
	ConflictException,
	HttpException,
	HttpStatus,
	NotFoundException,
	ServiceUnavailableException,
} from "@nestjs/common";
import * as Schema from "effect/Schema";
import { getTableConfig } from "@optimiq-voice/pbx-db";
import type { PgTable } from "@optimiq-voice/pbx-db";
import type { Diagnostic } from "@optimiq-voice/routing";

/**
 * The PBX area's failure taxonomy.
 *
 * `Schema.TaggedErrorClass` per the oikos seam (§3): every failure carries a `_tag` and knows its
 * own HTTP representation via `toHttpException()`, which is the duck-typed hook `runEffect` looks
 * for. Nothing below the service boundary ever throws a Nest exception.
 *
 * Naming per the convention: `…Failure` inside the app's Effect code, `…Exception` at the HTTP
 * boundary. The `toHttpException()` bodies are the only place the two meet.
 *
 * ## The response bodies are a contract
 *
 * `apps/web` (P4) renders these, so their shape is deliberate and stable:
 *
 * ```jsonc
 * // 404
 * { "statusCode": 404, "code": "PBX_NOT_FOUND",   "message": "…", "kind": "extension", "id": "…" }
 * // 409 — delete refused because other rows point here
 * { "statusCode": 409, "code": "PBX_REFERENCED",  "message": "…", "kind": "…", "id": "…",
 *   "references": [{ "kind": "inbound-route", "id": "…", "name": "…", "field": "destination" }] }
 * // 409 — unique constraint
 * { "statusCode": 409, "code": "PBX_CONFLICT",    "message": "…", "kind": "…", "field": "number" }
 * // 422 — destination trio invalid or dangling
 * { "statusCode": 422, "code": "PBX_INVALID_DESTINATION", "message": "…",
 *   "issues": [{ "field": "destinationRef", "code": "dangling", "message": "…" }] }
 * // 422 — compile-on-write refused the save (the mutation was rolled back)
 * { "statusCode": 422, "code": "ROUTING_COMPILE_FAILED", "message": "…",
 *   "diagnostics": [{ "severity": "error", "code": "dangling-destination", "message": "…",
 *                     "subject": { "kind": "inbound-route", "id": "…", "name": "…" },
 *                     "path": "inboundRoutes[0].destinationRef", "field": "destinationRef" }] }
 * ```
 *
 * Every body carries `code`, so the client switches on a string rather than on a status.
 */

/** The field name a compiler diagnostic's `path` points at, for form-level error placement. */
export function diagnosticField(path: string | undefined): string | undefined {
	if (path === undefined) {
		return undefined;
	}
	// `inboundRoutes[3].destinationRef` -> `destinationRef`; `ringGroups[0]` -> undefined.
	const last = path.split(".").at(-1);
	return last === undefined || last.endsWith("]") ? undefined : last;
}

/** A compiler diagnostic, flattened for the wire with the form field it belongs to. */
export interface WireDiagnostic {
	readonly severity: Diagnostic["severity"];
	readonly code: string;
	readonly message: string;
	readonly subject?: Diagnostic["subject"];
	readonly path?: string;
	readonly field?: string;
}

export function toWireDiagnostic(diagnostic: Diagnostic): WireDiagnostic {
	const field = diagnosticField(diagnostic.path);
	return {
		severity: diagnostic.severity,
		code: diagnostic.code,
		message: diagnostic.message,
		...(diagnostic.subject === undefined ? {} : { subject: diagnostic.subject }),
		...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
		...(field === undefined ? {} : { field }),
	};
}

/** A row that points at the entity a delete was refused for. */
export interface EntityReference {
	readonly kind: string;
	readonly id: string;
	readonly name: string | null;
	/** Which column of the referring row points here, e.g. `timeout_destination_ref`. */
	readonly field: string;
}

/** One problem with a destination trio, addressed at the form field that owns it. */
export interface DestinationIssueWire {
	readonly field: string;
	readonly code: string;
	readonly message: string;
}

// ---------------------------------------------------------------------------------------------

/** The requested row does not exist in this organization (or RLS hid it, which is the same thing). */
export class PbxEntityNotFoundFailure extends Schema.TaggedErrorClass<PbxEntityNotFoundFailure>()(
	"PbxEntityNotFoundFailure",
	{ kind: Schema.String, id: Schema.String },
) {
	toHttpException(): HttpException {
		return new NotFoundException({
			statusCode: HttpStatus.NOT_FOUND,
			code: "PBX_NOT_FOUND",
			message: `No ${this.kind} with id ${this.id} in this organization.`,
			kind: this.kind,
			id: this.id,
		});
	}
}

/** A unique index refused the write. */
export class PbxConflictFailure extends Schema.TaggedErrorClass<PbxConflictFailure>()(
	"PbxConflictFailure",
	{ kind: Schema.String, field: Schema.String, detail: Schema.String },
) {
	toHttpException(): HttpException {
		return new ConflictException({
			statusCode: HttpStatus.CONFLICT,
			code: "PBX_CONFLICT",
			message: this.detail,
			kind: this.kind,
			field: this.field,
		});
	}
}

/**
 * A delete was refused because other rows still point at this one.
 *
 * This exists because `destination_ref` has no `REFERENCES` clause — its target table varies by
 * row, so referential integrity is an application concern (`packages/pbx-db/src/destinations.ts`).
 * Deleting a ring group that three IVR options target would otherwise leave three dangling
 * destinations, which the next compile would reject — turning an unrelated later save into the
 * failure. Refusing here names the referrers while the user still has the context to fix them.
 */
export class PbxEntityReferencedFailure extends Schema.TaggedErrorClass<PbxEntityReferencedFailure>()(
	"PbxEntityReferencedFailure",
	{ kind: Schema.String, id: Schema.String, references: Schema.Any },
) {
	get referenceList(): readonly EntityReference[] {
		return this.references as readonly EntityReference[];
	}

	toHttpException(): HttpException {
		const references = this.referenceList;
		return new ConflictException({
			statusCode: HttpStatus.CONFLICT,
			code: "PBX_REFERENCED",
			message:
				`This ${this.kind} is still referenced by ${references.length} ` +
				`row(s): ${references.map((entry) => `${entry.kind} ${entry.name ?? entry.id}`).join(", ")}. ` +
				"Re-point or delete them first.",
			kind: this.kind,
			id: this.id,
			references,
		});
	}
}

/**
 * A destination trio is malformed, or points at a row that does not exist.
 *
 * The shape half comes from `validateDestination` in `packages/pbx-db`; the existence half is a
 * real `select 1 from <target table> where id = $1` inside the same transaction as the write,
 * which is the check `packages/routing`'s author recorded as a constraint on this layer.
 */
export class PbxInvalidDestinationFailure extends Schema.TaggedErrorClass<PbxInvalidDestinationFailure>()(
	"PbxInvalidDestinationFailure",
	{ issues: Schema.Any },
) {
	get issueList(): readonly DestinationIssueWire[] {
		return this.issues as readonly DestinationIssueWire[];
	}

	toHttpException(): HttpException {
		const issues = this.issueList;
		return new HttpException(
			{
				statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
				code: "PBX_INVALID_DESTINATION",
				message: issues.map((issue) => `${issue.field}: ${issue.message}`).join(" "),
				issues,
			},
			HttpStatus.UNPROCESSABLE_ENTITY,
		);
	}
}

/**
 * Compile-on-write refused the save.
 *
 * **The mutation has been rolled back.** An artifact that is not sound must never be persisted,
 * and a row that would produce one must never be committed — otherwise the tenant's saved state
 * and the state the engine can execute diverge, and the next unrelated save inherits the failure.
 */
export class RoutingCompileFailure extends Schema.TaggedErrorClass<RoutingCompileFailure>()(
	"RoutingCompileFailure",
	{ organizationId: Schema.String, diagnostics: Schema.Any },
) {
	get diagnosticList(): readonly Diagnostic[] {
		return this.diagnostics as readonly Diagnostic[];
	}

	toHttpException(): HttpException {
		const wire = this.diagnosticList
			.filter((diagnostic) => diagnostic.severity === "error")
			.map(toWireDiagnostic);
		return new HttpException(
			{
				statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
				code: "ROUTING_COMPILE_FAILED",
				message:
					`The change was rolled back: it would produce ${wire.length} routing error(s). ` +
					wire.map((diagnostic) => diagnostic.message).join(" "),
				diagnostics: wire,
			},
			HttpStatus.UNPROCESSABLE_ENTITY,
		);
	}
}

/** The request was well-formed but the values are not usable. */
export class PbxValidationFailure extends Schema.TaggedErrorClass<PbxValidationFailure>()(
	"PbxValidationFailure",
	{ field: Schema.String, detail: Schema.String },
) {
	toHttpException(): HttpException {
		return new BadRequestException({
			statusCode: HttpStatus.BAD_REQUEST,
			code: "PBX_VALIDATION_FAILED",
			message: this.detail,
			field: this.field,
		});
	}
}

/** The database refused the statement for a reason we do not have a domain failure for. */
export class PbxDatabaseFailure extends Schema.TaggedErrorClass<PbxDatabaseFailure>()(
	"PbxDatabaseFailure",
	{ operation: Schema.String, detail: Schema.String },
) {
	toHttpException(): HttpException {
		return new ServiceUnavailableException({
			statusCode: HttpStatus.SERVICE_UNAVAILABLE,
			code: "PBX_DATABASE_UNAVAILABLE",
			message: `The telephony database refused "${this.operation}": ${this.detail}`,
		});
	}
}

/** Every failure the PBX repositories can produce. */
export type PbxFailure =
	| PbxEntityNotFoundFailure
	| PbxConflictFailure
	| PbxEntityReferencedFailure
	| PbxInvalidDestinationFailure
	| RoutingCompileFailure
	| PbxValidationFailure
	| PbxDatabaseFailure;

const DOMAIN_FAILURE_TAGS: ReadonlySet<string> = new Set([
	"PbxEntityNotFoundFailure",
	"PbxConflictFailure",
	"PbxEntityReferencedFailure",
	"PbxInvalidDestinationFailure",
	"RoutingCompileFailure",
	"PbxValidationFailure",
	"PbxDatabaseFailure",
]);

/**
 * Whether a value thrown out of a transaction body is one of ours.
 *
 * The unit of work is a `Promise` callback (a Postgres transaction is a promise-scoped resource;
 * see `unit-of-work.ts`), so a guard inside it signals by throwing. This is what turns that throw
 * back into a typed Effect failure rather than a defect.
 */
export function isPbxFailure(value: unknown): value is PbxFailure {
	return (
		typeof value === "object" &&
		value !== null &&
		"_tag" in value &&
		typeof (value as { _tag: unknown })._tag === "string" &&
		DOMAIN_FAILURE_TAGS.has((value as { _tag: string })._tag)
	);
}

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";
/** Postgres `check_violation` — a table-level invariant the row broke. */
const CHECK_VIOLATION = "23514";

interface PostgresErrorish {
	readonly code?: string;
	readonly constraint_name?: string;
	readonly detail?: string;
	readonly message?: string;
	readonly cause?: unknown;
}

/**
 * Finds the driver error inside whatever wrapped it.
 *
 * drizzle-orm 1.0 wraps a driver rejection in a `DrizzleQueryError` carrying the original as
 * `cause`, so the SQLSTATE that turns "extension 200 already exists" into a 409 rather than a 500
 * is one level down — and a future release could add another. Walking the chain (bounded, so a
 * cyclic `cause` cannot hang a request) is what keeps the mapping working across that.
 */
function asPostgresError(value: unknown): PostgresErrorish | undefined {
	let current = value;
	for (let depth = 0; depth < 5; depth += 1) {
		if (typeof current !== "object" || current === null) {
			return undefined;
		}
		const candidate = current as PostgresErrorish;
		if (typeof candidate.code === "string") {
			return candidate;
		}
		if (candidate.cause === undefined || candidate.cause === current) {
			return candidate;
		}
		current = candidate.cause;
	}
	return undefined;
}

/**
 * Turns whatever came out of a transaction into a typed failure.
 *
 * Unique violations become a 409 naming the offending index, because "extension 200 already
 * exists" is a form error the user can act on and a 500 is not.
 *
 * `table` is the Drizzle table the statement was aimed at. It is optional only so the mapping can
 * still be exercised without one; every repository call site passes it, and passing it is what
 * turns the offending column from a guess into a lookup — see {@link constraintField}.
 */
export function toPbxFailure(
	kind: string,
	operation: string,
	cause: unknown,
	table?: PgTable,
): PbxFailure {
	if (isPbxFailure(cause)) {
		return cause;
	}
	const error = asPostgresError(cause);
	if (error?.code === UNIQUE_VIOLATION) {
		const constraint = error.constraint_name ?? "unique index";
		return new PbxConflictFailure({
			kind,
			field: constraintField(constraint, table),
			detail: `Another ${kind} in this organization already uses that value (${constraint}).`,
		});
	}
	if (error?.code === CHECK_VIOLATION) {
		// A check constraint is an invariant about the row the caller sent, not an outage. Reporting
		// it as a 503 would tell a user whose park lot ends before it starts that the database is
		// down, and would have them retry the same body until it did not.
		const constraint = error.constraint_name ?? "a table constraint";
		return new PbxValidationFailure({
			field: "",
			detail: `The values are not a valid ${kind}: they break ${constraint}.`,
		});
	}
	return new PbxDatabaseFailure({
		operation: `${kind}.${operation}`,
		detail: error?.message ?? String(cause),
	});
}

/**
 * The form field a unique violation belongs to.
 *
 * Postgres hands back only the **constraint name**, so something has to turn
 * `queue_organization_extension_number_key` into `extensionNumber`. Parsing the name was the first
 * answer and it is not a reliable one: it only works for indexes that happen to follow
 * `<table>_organization_<column>_key`, it cannot tell a compound index from a single-column one,
 * and it silently returns "" — a 409 the form can attach to nothing — for every index that
 * deviates (`park_lot_slot_range_check`, `queue_tier_organization_queue_agent_key`).
 *
 * So the name is used as a **key into the schema** instead. `getTableConfig` gives the indexes the
 * table actually declares, with their real columns; the tenant discriminator is dropped (every
 * unique index here is `(organization_id, …)`, and "organizationId" is not a field any form
 * renders) and the first remaining column is the one the user typed into. A compound index reports
 * its first non-tenant column, which is the one the message reads best against.
 *
 * The name parse survives as the fallback for anything the schema does not describe — a constraint
 * created by a migration and never modelled in Drizzle, say.
 */
function constraintField(constraint: string, table: PgTable | undefined): string {
	const column = table === undefined ? undefined : uniqueIndexColumn(table, constraint);
	if (column !== undefined) {
		return toCamelCase(column);
	}
	const match = /^[a-z_]+?_organization_(?<column>[a-z_]+)_key$/u.exec(constraint);
	const parsed = match?.groups?.column;
	return parsed === undefined ? "" : toCamelCase(parsed);
}

/** The first non-tenant column of the named unique index on `table`, or `undefined`. */
function uniqueIndexColumn(table: PgTable, constraint: string): string | undefined {
	let config: ReturnType<typeof getTableConfig>;
	try {
		config = getTableConfig(table);
	} catch {
		return undefined;
	}

	const indexed = config.indexes.find(
		(index) => index.config.unique && index.config.name === constraint,
	);
	const columns =
		indexed === undefined
			? config.uniqueConstraints.find((unique) => unique.name === constraint)?.columns
			: indexed.config.columns;
	if (columns === undefined) {
		return undefined;
	}

	const names = columns
		.map((column) => (column as { name?: unknown }).name)
		.filter((name): name is string => typeof name === "string" && name.length > 0)
		.filter((name) => name !== "organization_id");
	return names[0];
}

function toCamelCase(column: string): string {
	return column.replace(/_([a-z])/gu, (_full, letter: string) => letter.toUpperCase());
}
