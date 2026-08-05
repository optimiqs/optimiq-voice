/**
 * Domain errors raised by the routing compiler.
 *
 * Per the oikos naming convention (`plans/reference/oikos-conventions.md` §3) packages raise
 * `…Error`; the API translates them into Effect `…Failure` / HTTP `…Exception` at its own seam.
 * Nothing here knows about NestJS, Effect or HTTP.
 */

import { formatDiagnostics } from "./diagnostics";
import type { Diagnostic } from "./diagnostics";

/** Base class so a consumer can catch every routing invariant violation with one `instanceof`. */
export class RoutingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/**
 * A compile produced at least one `error` diagnostic.
 *
 * The diagnostics are the payload: the API turns them into per-field validation errors, so this
 * must never be flattened into a string on the way up.
 */
export class RoutingCompileError extends RoutingError {
	readonly organizationId: string;
	readonly diagnostics: readonly Diagnostic[];

	constructor(organizationId: string, diagnostics: readonly Diagnostic[]) {
		const errors = diagnostics.filter((entry) => entry.severity === "error");
		super(
			`Routing compile failed for organization ${organizationId} with ${errors.length} error(s):\n${formatDiagnostics(errors)}`,
		);
		this.organizationId = organizationId;
		this.diagnostics = diagnostics;
	}
}

/**
 * The compiler was handed a snapshot it cannot even begin to read — a missing organization id, a
 * row belonging to another tenant, a `compiledAt` that is not an instant.
 *
 * This is distinct from {@link RoutingCompileError}: that one means "the tenant's configuration is
 * wrong", this one means "the caller assembled the snapshot wrong", which is always a bug.
 */
export class RoutingSnapshotError extends RoutingError {
	readonly field: string;

	constructor(field: string, message: string) {
		super(`Invalid routing snapshot (${field}): ${message}`);
		this.field = field;
	}
}

/**
 * An artifact read back from the cache was produced by a different schema version.
 *
 * Walking it anyway is how a PBX starts routing calls with half-understood nodes, so this is a
 * hard failure: the reader must drop the cache entry and recompile.
 */
export class RoutingArtifactVersionError extends RoutingError {
	readonly expected: number;
	readonly received: unknown;

	constructor(expected: number, received: unknown) {
		super(
			`Routing artifact version mismatch: expected ${expected}, received ${JSON.stringify(received)}. Discard the cache entry and recompile.`,
		);
		this.expected = expected;
		this.received = received;
	}
}

/** An artifact read back from the cache is not shaped like an artifact at all. */
export class RoutingArtifactShapeError extends RoutingError {
	readonly field: string;

	constructor(field: string, message: string) {
		super(`Malformed routing artifact (${field}): ${message}`);
		this.field = field;
	}
}

/**
 * A plan node referenced an id that is not in the artifact's node table.
 *
 * The compiler guarantees the table is closed under reference, so reaching this means the artifact
 * was hand-edited or corrupted in transit. Fail loudly rather than silently hanging up.
 */
export class PlanNodeNotFoundError extends RoutingError {
	readonly nodeId: string;

	constructor(nodeId: string) {
		super(`Plan node "${nodeId}" is not present in the artifact node table.`);
		this.nodeId = nodeId;
	}
}
