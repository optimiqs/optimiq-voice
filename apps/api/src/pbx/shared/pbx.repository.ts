import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createEntityId } from "@optimiq-voice/identifiers";
import {
	and,
	asc,
	eq,
	ilike,
	or,
	type PbxDatabaseClient,
	type PbxDatabaseTransaction,
	sql,
} from "@optimiq-voice/pbx-db";
import { compileOnWrite, requiresRecompile } from "../routing/compile-on-write";
import {
	assertDestinations,
	findDestinationReferences,
	findScalarReferences,
	findTrunkReferences,
	readRows,
} from "./destinations";
import { normalizePagination, paged } from "./pagination";
import {
	PbxEntityNotFoundFailure,
	PbxEntityReferencedFailure,
	type PbxFailure,
	toPbxFailure,
} from "./pbx.errors";
import type { CompiledWrite } from "../routing/compile-on-write";
import type { ListQuery, PagedResult, Pagination } from "./pagination";
import type { PbxChildResource, PbxResource } from "./pbx-resource";
import type { SQL } from "@optimiq-voice/pbx-db";
import type { Diagnostic } from "@optimiq-voice/routing";

/**
 * The PBX area's repository: the one place in `apps/api` that builds Drizzle against
 * `@optimiq-voice/pbx-db`.
 *
 * Every method is an `Effect.fn`, every method is org-scoped with `organizationId` as its FIRST
 * parameter (oikos §4 — the service passes it from the session; the repository never infers it),
 * and every method runs inside `withTenantScope`, so RLS is the filter and no query here carries
 * an `organization_id` predicate. That absence is deliberate: duplicating the policy in the
 * `where` clause would make a policy that failed to apply invisible.
 *
 * ## Effect and the transaction boundary
 *
 * A Postgres transaction is a promise-scoped resource — `withTenantScope` hands out a handle that
 * is only valid until its callback resolves — so the unit of work is a `Promise` body wrapped once
 * in `Effect.tryPromise`, rather than an Effect that could be forked, interrupted or raced out of
 * the transaction's lifetime. Guards inside the body signal by throwing a `…Failure`, and
 * `toPbxFailure` turns whatever came out back into a typed failure (a defect stays a defect and
 * `runEffect` renders it as an opaque `err_…` 500).
 *
 * The write methods are therefore *one* `Effect.tryPromise` each, not a composition of several:
 * splitting them would put the guard and the write in different transactions, which is the bug
 * the guard exists to prevent.
 */

/** A mutation's result: the row, plus whatever the recompile had to say about it. */
export interface MutationResult<T> {
	readonly row: T;
	readonly warnings: readonly Diagnostic[];
	/** Present when the mutation touched a routing table and the recompile succeeded. */
	readonly compiled?: CompiledWrite;
}

export interface PbxRepositoryInterface {
	readonly list: (
		organizationId: string,
		resource: PbxResource,
		query: ListQuery,
	) => Effect.Effect<PagedResult<Record<string, unknown>>, PbxFailure>;

	readonly get: (
		organizationId: string,
		resource: PbxResource,
		id: string,
	) => Effect.Effect<Record<string, unknown>, PbxFailure>;

	readonly create: (
		organizationId: string,
		resource: PbxResource,
		values: Record<string, unknown>,
	) => Effect.Effect<MutationResult<Record<string, unknown>>, PbxFailure>;

	readonly update: (
		organizationId: string,
		resource: PbxResource,
		id: string,
		values: Record<string, unknown>,
	) => Effect.Effect<MutationResult<Record<string, unknown>>, PbxFailure>;

	readonly remove: (
		organizationId: string,
		resource: PbxResource,
		id: string,
	) => Effect.Effect<MutationResult<{ readonly id: string }>, PbxFailure>;

	readonly listChildren: (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
	) => Effect.Effect<readonly Record<string, unknown>[], PbxFailure>;

	readonly createChild: (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
		values: Record<string, unknown>,
	) => Effect.Effect<MutationResult<Record<string, unknown>>, PbxFailure>;

	readonly updateChild: (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
		id: string,
		values: Record<string, unknown>,
	) => Effect.Effect<MutationResult<Record<string, unknown>>, PbxFailure>;

	readonly removeChild: (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
		id: string,
	) => Effect.Effect<MutationResult<{ readonly id: string }>, PbxFailure>;

	/** Compiles the organization's configuration without mutating anything. */
	readonly compile: (organizationId: string) => Effect.Effect<CompiledWrite, PbxFailure>;
}

export class PbxRepository extends Context.Service<PbxRepository, PbxRepositoryInterface>()(
	"@optimiq-voice/api/PbxRepository",
) {}

// ---------------------------------------------------------------------------------------------
// Query fragments
// ---------------------------------------------------------------------------------------------

/**
 * `count(*) over ()` — the page's total, taken from the same scan as the page.
 *
 * A second `select count(*)` would be a second snapshot, so a row inserted between the two would
 * make `total` and `data.length` disagree in a way a paginating table renders as a phantom page.
 */
const windowTotal = sql<number>`count(*) over ()`.mapWith(Number);

function searchPredicate(resource: PbxResource, search: string | undefined): SQL | undefined {
	const term = search?.trim();
	if (term === undefined || term.length === 0 || resource.searchColumns.length === 0) {
		return undefined;
	}
	// `%` and `_` are `ilike` wildcards; a user searching for "100_" means the literal.
	const escaped = term.replace(/[\\%_]/gu, (match) => `\\${match}`);
	const clauses = resource.searchColumns.map((column) => ilike(column, `%${escaped}%`));
	return clauses.length === 1 ? clauses[0] : or(...clauses);
}

function listPredicate(resource: PbxResource, query: ListQuery): SQL | undefined {
	const clauses: SQL[] = [];
	const search = searchPredicate(resource, query.search);
	if (search !== undefined) {
		clauses.push(search);
	}
	if (query.enabled !== undefined && resource.enabledColumn !== undefined) {
		clauses.push(eq(resource.enabledColumn, query.enabled));
	}
	if (clauses.length === 0) {
		return undefined;
	}
	return clauses.length === 1 ? clauses[0] : and(...clauses);
}

// ---------------------------------------------------------------------------------------------
// Promise-level primitives — everything below runs inside an open tenant transaction
// ---------------------------------------------------------------------------------------------

async function selectById(
	transaction: PbxDatabaseTransaction,
	resource: PbxResource,
	id: string,
): Promise<Record<string, unknown> | undefined> {
	const rows = await transaction
		.select()
		.from(resource.table)
		.where(eq(rowId(resource), id))
		.limit(1);
	return rows[0] as Record<string, unknown> | undefined;
}

/**
 * The `id` column object.
 *
 * Reached through the table's column map rather than declared on every descriptor: `id` is
 * `uuidV7PrimaryKey()` on all thirty-five tables, so making each slice restate it would be
 * ceremony that can only ever be wrong.
 */
function rowId(resource: PbxResource): PgColumnLike {
	const columns = resource.table as unknown as Record<string, PgColumnLike>;
	return columns.id;
}

/** Structural stand-in so this file does not have to name Drizzle's column generics. */
type PgColumnLike = Parameters<typeof eq>[0];

async function requireRow(
	transaction: PbxDatabaseTransaction,
	resource: PbxResource,
	id: string,
): Promise<Record<string, unknown>> {
	const row = await selectById(transaction, resource, id);
	if (row === undefined) {
		// RLS makes "another tenant's row" and "no such row" the same answer, which is the correct
		// behaviour: a 404 leaks nothing, a 403 would confirm the id exists somewhere.
		throw new PbxEntityNotFoundFailure({ kind: resource.kind, id });
	}
	return row;
}

/**
 * Refuses a delete that would leave a dangling pointer.
 *
 * `destination_ref` has no `REFERENCES` clause (its target table varies by row), so the database
 * cannot do this and the CRUD layer must. Trunks are scanned separately because an outbound
 * route's trunk list lives inside a JSONB array, where no foreign key can reach.
 */
async function assertNotReferenced(
	transaction: PbxDatabaseTransaction,
	resource: PbxResource,
	id: string,
): Promise<void> {
	const references = [
		...(resource.destinationType === null
			? []
			: await findDestinationReferences(transaction, resource.destinationType, id, {
					// A row's own trios cannot keep it alive: they die with it.
					excludeTable: resource.tableName,
				})),
		...(resource.scalarReferences === undefined
			? []
			: await findScalarReferences(transaction, resource.scalarReferences, id)),
		...(resource.tableName === "trunk" ? await findTrunkReferences(transaction, id) : []),
	];

	if (references.length > 0) {
		throw new PbxEntityReferencedFailure({ kind: resource.kind, id, references });
	}
}

/** Runs compile-on-write when the table is a routing input; otherwise reports no warnings. */
async function recompileIfNeeded(
	transaction: PbxDatabaseTransaction,
	organizationId: string,
	tableName: string,
): Promise<CompiledWrite | undefined> {
	if (!requiresRecompile(tableName)) {
		return undefined;
	}
	return await compileOnWrite(transaction, organizationId);
}

// ---------------------------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------------------------

export interface PbxRepositoryDependencies {
	readonly database: PbxDatabaseClient;
	/**
	 * Called after a write commits, with the artifact the recompile produced. Injected rather than
	 * imported so the repository has no opinion about NATS and a spec can assert the publish
	 * without a broker.
	 */
	readonly onArtifactCompiled?: (compiled: CompiledWrite) => void;
	/** Injected so a spec can pin generated ids. */
	readonly newId?: () => string;
}

export function makePbxRepository(deps: PbxRepositoryDependencies): PbxRepositoryInterface {
	const newId = deps.newId ?? createEntityId;

	/** The single Effect↔transaction seam. Read the class doc above before changing this. */
	const scoped = <A>(
		kind: string,
		operation: string,
		organizationId: string,
		work: (transaction: PbxDatabaseTransaction) => Promise<A>,
	): Effect.Effect<A, PbxFailure> =>
		Effect.tryPromise({
			try: async () => await deps.database.withTenantScope(organizationId, work),
			catch: (cause) => toPbxFailure(kind, operation, cause),
		});

	/** Publishes after the commit, never inside it — see `routing-cache.publisher.ts`. */
	const announce = <T>(result: MutationResult<T>): MutationResult<T> => {
		if (result.compiled !== undefined && deps.onArtifactCompiled !== undefined) {
			deps.onArtifactCompiled(result.compiled);
		}
		return result;
	};

	const list = Effect.fn("PbxRepository.list")(function* (
		organizationId: string,
		resource: PbxResource,
		query: ListQuery,
	) {
		const pagination: Pagination = normalizePagination(query);
		const rows = yield* scoped(resource.kind, "list", organizationId, async (transaction) => {
			const predicate = listPredicate(resource, query);
			const base = transaction
				.select({ row: resource.table, total: windowTotal })
				.from(resource.table);
			const filtered = predicate === undefined ? base : base.where(predicate);
			return await filtered
				.orderBy(...resource.orderBy.map((column) => asc(column)))
				.limit(pagination.limit)
				.offset(pagination.offset);
		});

		const total = rows[0]?.total ?? 0;
		return paged(
			rows.map((entry) => entry.row as Record<string, unknown>),
			total,
			pagination,
		);
	});

	const get = Effect.fn("PbxRepository.get")(function* (
		organizationId: string,
		resource: PbxResource,
		id: string,
	) {
		return yield* scoped(
			resource.kind,
			"get",
			organizationId,
			async (transaction) => await requireRow(transaction, resource, id),
		);
	});

	const create = Effect.fn("PbxRepository.create")(function* (
		organizationId: string,
		resource: PbxResource,
		values: Record<string, unknown>,
	) {
		const result = yield* scoped(
			resource.kind,
			"create",
			organizationId,
			async (transaction): Promise<MutationResult<Record<string, unknown>>> => {
				const row = { ...values, id: newId(), organizationId };
				// Guard-then-execute: nothing is written until every destination on the row has been
				// shape-checked AND proven to resolve, in this transaction.
				await assertDestinations(transaction, row, resource.destinations);
				const inserted = await transaction
					.insert(resource.table)
					.values(row as never)
					.returning();
				const created = inserted[0] as Record<string, unknown>;
				const compiled = await recompileIfNeeded(transaction, organizationId, resource.tableName);
				return {
					row: created,
					warnings: compiled?.warnings ?? [],
					...(compiled === undefined ? {} : { compiled }),
				};
			},
		);
		return announce(result);
	});

	const update = Effect.fn("PbxRepository.update")(function* (
		organizationId: string,
		resource: PbxResource,
		id: string,
		values: Record<string, unknown>,
	) {
		const result = yield* scoped(
			resource.kind,
			"update",
			organizationId,
			async (transaction): Promise<MutationResult<Record<string, unknown>>> => {
				const existing = await requireRow(transaction, resource, id);
				// Destinations are validated against the MERGED row: a PATCH that changes only
				// `destinationRef` still has to satisfy the trio's existing `destinationType`.
				await assertDestinations(transaction, { ...existing, ...values }, resource.destinations);
				const updated = await transaction
					.update(resource.table)
					.set(values as never)
					.where(eq(rowId(resource), id))
					.returning();
				const row = (updated[0] ?? existing) as Record<string, unknown>;
				const compiled = await recompileIfNeeded(transaction, organizationId, resource.tableName);
				return {
					row,
					warnings: compiled?.warnings ?? [],
					...(compiled === undefined ? {} : { compiled }),
				};
			},
		);
		return announce(result);
	});

	const remove = Effect.fn("PbxRepository.remove")(function* (
		organizationId: string,
		resource: PbxResource,
		id: string,
	) {
		const result = yield* scoped(
			resource.kind,
			"remove",
			organizationId,
			async (transaction): Promise<MutationResult<{ readonly id: string }>> => {
				await requireRow(transaction, resource, id);
				await assertNotReferenced(transaction, resource, id);
				await transaction.delete(resource.table).where(eq(rowId(resource), id));
				const compiled = await recompileIfNeeded(transaction, organizationId, resource.tableName);
				return {
					row: { id },
					warnings: compiled?.warnings ?? [],
					...(compiled === undefined ? {} : { compiled }),
				};
			},
		);
		return announce(result);
	});

	const listChildren = Effect.fn("PbxRepository.listChildren")(function* (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
	) {
		return yield* scoped(resource.kind, "listChildren", organizationId, async (transaction) => {
			await requireParent(transaction, resource, parentId);
			return (await transaction
				.select()
				.from(resource.table)
				.where(eq(resource.parentColumn, parentId))
				.orderBy(...resource.orderBy.map((column) => asc(column)))) as Record<string, unknown>[];
		});
	});

	const createChild = Effect.fn("PbxRepository.createChild")(function* (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
		values: Record<string, unknown>,
	) {
		const result = yield* scoped(
			resource.kind,
			"createChild",
			organizationId,
			async (transaction): Promise<MutationResult<Record<string, unknown>>> => {
				await requireParent(transaction, resource, parentId);
				const row = {
					...values,
					id: newId(),
					organizationId,
					[parentKey(resource)]: parentId,
				};
				await assertDestinations(transaction, row, resource.destinations);
				const inserted = await transaction
					.insert(resource.table)
					.values(row as never)
					.returning();
				const compiled = await recompileIfNeeded(transaction, organizationId, resource.tableName);
				return {
					row: inserted[0] as Record<string, unknown>,
					warnings: compiled?.warnings ?? [],
					...(compiled === undefined ? {} : { compiled }),
				};
			},
		);
		return announce(result);
	});

	const updateChild = Effect.fn("PbxRepository.updateChild")(function* (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
		id: string,
		values: Record<string, unknown>,
	) {
		const result = yield* scoped(
			resource.kind,
			"updateChild",
			organizationId,
			async (transaction): Promise<MutationResult<Record<string, unknown>>> => {
				const existing = await requireChild(transaction, resource, parentId, id);
				await assertDestinations(transaction, { ...existing, ...values }, resource.destinations);
				const updated = await transaction
					.update(resource.table)
					.set(values as never)
					.where(and(eq(rowId(resource), id), eq(resource.parentColumn, parentId)))
					.returning();
				const compiled = await recompileIfNeeded(transaction, organizationId, resource.tableName);
				return {
					row: (updated[0] ?? existing) as Record<string, unknown>,
					warnings: compiled?.warnings ?? [],
					...(compiled === undefined ? {} : { compiled }),
				};
			},
		);
		return announce(result);
	});

	const removeChild = Effect.fn("PbxRepository.removeChild")(function* (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
		id: string,
	) {
		const result = yield* scoped(
			resource.kind,
			"removeChild",
			organizationId,
			async (transaction): Promise<MutationResult<{ readonly id: string }>> => {
				await requireChild(transaction, resource, parentId, id);
				await assertNotReferenced(transaction, resource, id);
				await transaction
					.delete(resource.table)
					.where(and(eq(rowId(resource), id), eq(resource.parentColumn, parentId)));
				const compiled = await recompileIfNeeded(transaction, organizationId, resource.tableName);
				return {
					row: { id },
					warnings: compiled?.warnings ?? [],
					...(compiled === undefined ? {} : { compiled }),
				};
			},
		);
		return announce(result);
	});

	const compile = Effect.fn("PbxRepository.compile")(function* (organizationId: string) {
		return yield* scoped(
			"routing",
			"compile",
			organizationId,
			async (transaction) => await compileOnWrite(transaction, organizationId),
		);
	});

	/** The parent must exist in this tenant before a child may name it. */
	async function requireParent(
		transaction: PbxDatabaseTransaction,
		resource: PbxChildResource,
		parentId: string,
	): Promise<void> {
		const rows = await transaction.execute(
			sql`select 1 from ${resource.parentTable} where id = ${parentId}::uuid limit 1`,
		);
		if (readRows(rows).length === 0) {
			throw new PbxEntityNotFoundFailure({ kind: resource.parentKind, id: parentId });
		}
	}

	async function requireChild(
		transaction: PbxDatabaseTransaction,
		resource: PbxChildResource,
		parentId: string,
		id: string,
	): Promise<Record<string, unknown>> {
		const rows = await transaction
			.select()
			.from(resource.table)
			.where(and(eq(rowId(resource), id), eq(resource.parentColumn, parentId)))
			.limit(1);
		const row = rows[0] as Record<string, unknown> | undefined;
		if (row === undefined) {
			throw new PbxEntityNotFoundFailure({ kind: resource.kind, id });
		}
		return row;
	}

	/** The camelCase property the parent id is written to, derived from the column's name. */
	function parentKey(resource: PbxChildResource): string {
		const name = (resource.parentColumn as unknown as { name: string }).name;
		return name.replace(/_([a-z])/gu, (_full, letter: string) => letter.toUpperCase());
	}

	return {
		list,
		get,
		create,
		update,
		remove,
		listChildren,
		createChild,
		updateChild,
		removeChild,
		compile,
	};
}

export function pbxRepositoryLayer(
	deps: PbxRepositoryDependencies,
): Layer.Layer<PbxRepository, never> {
	return Layer.effect(PbxRepository)(Effect.sync(() => PbxRepository.of(makePbxRepository(deps))));
}
