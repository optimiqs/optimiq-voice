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
	findParkLotFeatureCodeReferences,
	findScalarReferences,
	findTrunkReferences,
	readRows,
} from "./destinations";
import { normalizePagination, paged } from "./pagination";
import {
	PbxEntityNotFoundFailure,
	PbxEntityReferencedFailure,
	type PbxFailure,
	PbxValidationFailure,
	toPbxFailure,
} from "./pbx.errors";
import { enqueueProjections, payloadOf, projectionsOwedBy } from "./projection-outbox";
import type { CompiledWrite } from "../routing/compile-on-write";
import type { AuditAction, AuditActor } from "./audit-log";
import type { AuditMutationInput } from "./audit-log.service";
import type { ListQuery, PagedResult, Pagination } from "./pagination";
import type { PbxChildResource, PbxResource } from "./pbx-resource";
import type { PgTable, SQL } from "@optimiq-voice/pbx-db";
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

/**
 * What committed, for the projections that are not the routing artifact.
 *
 * `onArtifactCompiled` only fires for tables `affectsRouting()` returns true for, which is correct
 * and is exactly why this exists alongside it: `queue_agent` and `queue_tier` are deliberately NOT
 * routing inputs — `packages/routing` calls agent membership live state the engine reads at dial
 * time, so logging an agent in must not evict a tenant's compiled artifact — and yet a write to
 * either of them changes the roster the ACD distributes against. A seam that fired only on
 * recompiles would leave the `queue-membership` bucket stale for exactly the writes that change it
 * most often.
 *
 * The event names the physical TABLE rather than the resource kind, because the subscribers are
 * projections of tables and the child resources (`queue-tier`) do not map one-to-one onto kinds.
 */
export interface PbxMutationEvent {
	readonly organizationId: string;
	readonly tableName: string;
	readonly kind: string;
	readonly operation: "create" | "update" | "remove" | "reorder";
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
		actor?: AuditActor,
	) => Effect.Effect<MutationResult<Record<string, unknown>>, PbxFailure>;

	readonly update: (
		organizationId: string,
		resource: PbxResource,
		id: string,
		values: Record<string, unknown>,
		actor?: AuditActor,
	) => Effect.Effect<MutationResult<Record<string, unknown>>, PbxFailure>;

	readonly remove: (
		organizationId: string,
		resource: PbxResource,
		id: string,
		actor?: AuditActor,
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
		actor?: AuditActor,
	) => Effect.Effect<MutationResult<Record<string, unknown>>, PbxFailure>;

	readonly updateChild: (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
		id: string,
		values: Record<string, unknown>,
		actor?: AuditActor,
	) => Effect.Effect<MutationResult<Record<string, unknown>>, PbxFailure>;

	readonly removeChild: (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
		id: string,
		actor?: AuditActor,
	) => Effect.Effect<MutationResult<{ readonly id: string }>, PbxFailure>;

	readonly reorderChildren: (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
		ids: readonly string[],
		actor?: AuditActor,
	) => Effect.Effect<MutationResult<readonly Record<string, unknown>[]>, PbxFailure>;

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
// `null` means "reset"
// ---------------------------------------------------------------------------------------------

/**
 * What an explicit `null` means for a column the database says can never be null.
 *
 * The PATCH contract is: an absent key is "leave it alone", a present `null` is "clear it". For a
 * nullable column that is unambiguous. For the ~40 tuning knobs that are `notNull().default(n)` —
 * `ringTimeoutSeconds`, `maxWaitSeconds`, `wrapUpSeconds`, `maxMessages` — "clear it" cannot mean
 * NULL, because the column refuses NULL and the write would come back as a 503 the user cannot act
 * on. It can only mean **put it back to what the server picked**, which is the reset a form's
 * "Use default" control needs and the only reading of `null` those columns have.
 *
 * So the two paths are translated rather than refused:
 *
 * - **insert** — the key is dropped, and Drizzle emits the column's `DEFAULT`.
 * - **update** — the key becomes a literal `default`, which is the only way SQL says "put this
 *   column back" in an `UPDATE … SET`.
 *
 * A `null` for a genuinely nullable column (`callerIdName`, `mohClassId`, a destination trio) is
 * untouched and still clears to NULL, which is what it has always meant. The distinction is read
 * off the column, not off a hand-maintained list, so a column that gains a default gains the
 * behaviour with it. The DTOs mark these fields `.nullish()` so `null` is even expressible; see
 * `shared/dto.ts`.
 */
function columnResetsToDefault(table: PgTable, key: string): boolean {
	const column = (table as unknown as Record<string, ColumnLike | undefined>)[key];
	return column?.notNull === true && column.hasDefault === true;
}

interface ColumnLike {
	readonly notNull?: boolean;
	readonly hasDefault?: boolean;
}

/** Insert values with every "reset me" null removed, so the column's own DEFAULT applies. */
function withInsertDefaults(
	table: PgTable,
	values: Record<string, unknown>,
): Record<string, unknown> {
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		if (value === null && columnResetsToDefault(table, key)) {
			continue;
		}
		next[key] = value;
	}
	return next;
}

/** Update values with every "reset me" null rewritten to the SQL keyword `default`. */
function withUpdateDefaults(
	table: PgTable,
	values: Record<string, unknown>,
): Record<string, unknown> {
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		next[key] = value === null && columnResetsToDefault(table, key) ? sql`default` : value;
	}
	return next;
}

/**
 * The merged row a guard sees, with the resets resolved back to the value they will land on.
 *
 * `sql\`default\`` is not a value a destination check can read, and neither is the `null` it came
 * from, so the merge that feeds `assertDestinations` drops resettable nulls instead of carrying
 * them: what the row will hold after the write is the column's default, not NULL.
 */
function mergedForGuards(
	table: PgTable,
	existing: Record<string, unknown>,
	values: Record<string, unknown>,
): Record<string, unknown> {
	return { ...existing, ...withInsertDefaults(table, values) };
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
		// Two references live inside `jsonb` where no column — and therefore no generic scan — can
		// reach them: an outbound route's trunk list, and a `call-park` code's pinned lot.
		...(resource.tableName === "trunk" ? await findTrunkReferences(transaction, id) : []),
		...(resource.tableName === "park_lot"
			? await findParkLotFeatureCodeReferences(transaction, id)
			: []),
	];

	if (references.length > 0) {
		throw new PbxEntityReferencedFailure({ kind: resource.kind, id, references });
	}
}

/** The camelCase Drizzle key of a column, derived from its physical name. */
function columnKey(column: PgColumnLike): string {
	const name = (column as unknown as { name: string }).name;
	return name.replace(/_([a-z])/gu, (_full, letter: string) => letter.toUpperCase());
}

/**
 * Refuses a reorder whose id list is not exactly the collection's membership.
 *
 * Reported as a 400 with the field the client sent rather than a 404 on the first unknown id: the
 * list as a whole is what was wrong, and a form that just lost a race with another editor needs to
 * be told to reload, not to hunt for one id.
 */
function assertPermutation(
	kind: string,
	present: readonly string[],
	requested: readonly string[],
): void {
	const unique = new Set(requested);
	if (unique.size !== requested.length) {
		throw new PbxValidationFailure({
			field: "ids",
			detail: "The same id appears twice in the requested order.",
		});
	}
	const current = new Set(present);
	const missing = present.filter((id) => !unique.has(id));
	const unknown = requested.filter((id) => !current.has(id));
	if (missing.length > 0 || unknown.length > 0) {
		throw new PbxValidationFailure({
			field: "ids",
			detail:
				`The order must list every ${kind} in this collection exactly once ` +
				`(${present.length} expected, ${requested.length} sent). ` +
				"Reload the list and try again.",
		});
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
	/**
	 * Called after EVERY write commits, whether or not it recompiled. Injected on the same terms as
	 * `onArtifactCompiled` — a plain callback, so the repository keeps no knowledge of NATS and a
	 * spec can assert the seam without a broker.
	 */
	readonly onMutation?: (event: PbxMutationEvent) => void;
	/**
	 * Whether a write also records what it owes in `pbx_projection_outbox`.
	 *
	 * Off means the two seams above are the only publish path, which is what the area did before the
	 * outbox existed. The module turns it on exactly when there is a broker to publish to: with no
	 * `NATS_URL` there is no bucket for a projection to be stale in, and enqueueing anyway would
	 * accumulate obligations on every developer machine that nothing could ever discharge.
	 */
	readonly outboxEnabled?: boolean;
	/**
	 * Appends the change ledger row, INSIDE the mutation's transaction.
	 *
	 * Injected on the same terms as the two callbacks above — a plain function, so the repository
	 * keeps no knowledge of `audit_log` and a spec can assert the ledger seam without a database.
	 * Unlike them it is AWAITED and it is inside the unit of work: a rolled-back write must leave
	 * no ledger row and a committed one must leave exactly one. See `audit-log.service.ts` for the
	 * argument, including the cost.
	 */
	readonly recordAudit?: (
		transaction: PbxDatabaseTransaction,
		input: AuditMutationInput,
	) => Promise<void>;
	/** Injected so a spec can pin generated ids. */
	readonly newId?: () => string;
}

export function makePbxRepository(deps: PbxRepositoryDependencies): PbxRepositoryInterface {
	const newId = deps.newId ?? createEntityId;

	/**
	 * The ledger append, still inside the write's transaction.
	 *
	 * Called by every mutation immediately after the row has been written and BEFORE {@link settle}
	 * recompiles: the recompile is what turns an unsound configuration into a 422 and a rollback,
	 * and being on the same side of it means the ledger and the database agree by construction
	 * rather than by a rule somebody has to remember.
	 */
	const audit = async (
		transaction: PbxDatabaseTransaction,
		organizationId: string,
		resource: PbxResource | PbxChildResource,
		action: AuditAction,
		resourceRef: string | null,
		rows: {
			readonly before?: Record<string, unknown> | undefined;
			readonly after?: Record<string, unknown> | undefined;
		},
		actor: AuditActor | undefined,
	): Promise<void> => {
		if (deps.recordAudit === undefined) {
			return;
		}
		await deps.recordAudit(transaction, {
			organizationId,
			resource,
			action,
			resourceRef,
			...(rows.before === undefined ? {} : { before: rows.before }),
			...(rows.after === undefined ? {} : { after: rows.after }),
			actor,
		});
	};

	/**
	 * The last thing every write does, still inside its transaction: recompile if the table is a
	 * routing input, then record what the commit will owe the KV buckets.
	 *
	 * The outbox insert is here rather than after the commit for the whole reason the table exists —
	 * see `shared/projection-outbox.ts`. Being in the transaction means there is no interleaving in
	 * which the row is durable and the obligation is not, and it means a failure to record the
	 * obligation fails the write, which is the honest outcome: a caller told "saved" about a change
	 * whose projection can be silently lost is worse off than a caller told to retry.
	 *
	 * `projectionsOwedBy` deliberately uses the SAME predicate the fast path uses — an unchanged
	 * `snapshotHash` owes nothing, because the bucket already holds the right value. If the two ever
	 * disagreed, the sweeper would spend forever republishing states the fast path had correctly
	 * decided were already there.
	 */
	const settle = async (
		transaction: PbxDatabaseTransaction,
		organizationId: string,
		resource: PbxResource | PbxChildResource,
		operation: PbxMutationEvent["operation"],
	): Promise<CompiledWrite | undefined> => {
		const compiled = await recompileIfNeeded(transaction, organizationId, resource.tableName);
		if (deps.outboxEnabled === true) {
			await enqueueProjections(
				transaction,
				organizationId,
				projectionsOwedBy(resource.tableName, compiled?.changed ?? false),
				payloadOf({
					organizationId,
					tableName: resource.tableName,
					kind: resource.kind,
					operation,
				}),
				newId,
			);
		}
		return compiled;
	};

	/**
	 * The single Effect↔transaction seam. Read the class doc above before changing this.
	 *
	 * `table` travels with the failure mapping so a `23505` can be answered with the column the
	 * index is actually on rather than with a parse of the index's name.
	 */
	const scoped = <A>(
		kind: string,
		operation: string,
		organizationId: string,
		table: PgTable | undefined,
		work: (transaction: PbxDatabaseTransaction) => Promise<A>,
	): Effect.Effect<A, PbxFailure> =>
		Effect.tryPromise({
			try: async () => await deps.database.withTenantScope(organizationId, work),
			catch: (cause) => toPbxFailure(kind, operation, cause, table),
		});

	/**
	 * Publishes after the commit, never inside it — see `routing-cache.publisher.ts`.
	 *
	 * Both seams fire here and in this order: the artifact first, because a reader that sees a new
	 * roster for a queue whose routing node does not exist yet has nothing to do with it, and the
	 * reverse leaves a live queue pointing at a roster from before the change for as long as the
	 * second publish takes.
	 */
	const announce = <T>(
		resource: PbxResource | PbxChildResource,
		operation: PbxMutationEvent["operation"],
		organizationId: string,
		result: MutationResult<T>,
	): MutationResult<T> => {
		if (result.compiled !== undefined && deps.onArtifactCompiled !== undefined) {
			deps.onArtifactCompiled(result.compiled);
		}
		deps.onMutation?.({
			organizationId,
			tableName: resource.tableName,
			kind: resource.kind,
			operation,
		});
		return result;
	};

	const list = Effect.fn("PbxRepository.list")(function* (
		organizationId: string,
		resource: PbxResource,
		query: ListQuery,
	) {
		const pagination: Pagination = normalizePagination(query);
		const rows = yield* scoped(
			resource.kind,
			"list",
			organizationId,
			resource.table,
			async (transaction) => {
				const predicate = listPredicate(resource, query);
				const base = transaction
					.select({ row: resource.table, total: windowTotal })
					.from(resource.table);
				const filtered = predicate === undefined ? base : base.where(predicate);
				return await filtered
					.orderBy(...resource.orderBy.map((column) => asc(column)))
					.limit(pagination.limit)
					.offset(pagination.offset);
			},
		);

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
			resource.table,
			async (transaction) => await requireRow(transaction, resource, id),
		);
	});

	const create = Effect.fn("PbxRepository.create")(function* (
		organizationId: string,
		resource: PbxResource,
		values: Record<string, unknown>,
		actor?: AuditActor,
	) {
		const result = yield* scoped(
			resource.kind,
			"create",
			organizationId,
			resource.table,
			async (transaction): Promise<MutationResult<Record<string, unknown>>> => {
				// A `null` on a `notNull().default()` column means "use the server default"; dropping the
				// key is how an INSERT says that. See `withInsertDefaults`.
				const row = {
					...withInsertDefaults(resource.table, values),
					id: newId(),
					organizationId,
				};
				// Guard-then-execute: nothing is written until every destination on the row has been
				// shape-checked AND proven to resolve, in this transaction.
				await assertDestinations(transaction, row, resource.destinations);
				const inserted = await transaction
					.insert(resource.table)
					.values(row as never)
					.returning();
				const created = inserted[0] as Record<string, unknown>;
				await audit(
					transaction,
					organizationId,
					resource,
					"create",
					String(created.id ?? row.id),
					{ after: created },
					actor,
				);
				const compiled = await settle(transaction, organizationId, resource, "create");
				return {
					row: created,
					warnings: compiled?.warnings ?? [],
					...(compiled === undefined ? {} : { compiled }),
				};
			},
		);
		return announce(resource, "create", organizationId, result);
	});

	const update = Effect.fn("PbxRepository.update")(function* (
		organizationId: string,
		resource: PbxResource,
		id: string,
		values: Record<string, unknown>,
		actor?: AuditActor,
	) {
		const result = yield* scoped(
			resource.kind,
			"update",
			organizationId,
			resource.table,
			async (transaction): Promise<MutationResult<Record<string, unknown>>> => {
				const existing = await requireRow(transaction, resource, id);
				// Destinations are validated against the MERGED row: a PATCH that changes only
				// `destinationRef` still has to satisfy the trio's existing `destinationType`.
				await assertDestinations(
					transaction,
					mergedForGuards(resource.table, existing, values),
					resource.destinations,
				);
				const updated = await transaction
					.update(resource.table)
					.set(withUpdateDefaults(resource.table, values) as never)
					.where(eq(rowId(resource), id))
					.returning();
				const row = (updated[0] ?? existing) as Record<string, unknown>;
				await audit(
					transaction,
					organizationId,
					resource,
					"update",
					id,
					{ before: existing, after: row },
					actor,
				);
				const compiled = await settle(transaction, organizationId, resource, "update");
				return {
					row,
					warnings: compiled?.warnings ?? [],
					...(compiled === undefined ? {} : { compiled }),
				};
			},
		);
		return announce(resource, "update", organizationId, result);
	});

	const remove = Effect.fn("PbxRepository.remove")(function* (
		organizationId: string,
		resource: PbxResource,
		id: string,
		actor?: AuditActor,
	) {
		const result = yield* scoped(
			resource.kind,
			"remove",
			organizationId,
			resource.table,
			async (transaction): Promise<MutationResult<{ readonly id: string }>> => {
				const existing = await requireRow(transaction, resource, id);
				await assertNotReferenced(transaction, resource, id);
				await transaction.delete(resource.table).where(eq(rowId(resource), id));
				await audit(
					transaction,
					organizationId,
					resource,
					"delete",
					id,
					{ before: existing },
					actor,
				);
				const compiled = await settle(transaction, organizationId, resource, "remove");
				return {
					row: { id },
					warnings: compiled?.warnings ?? [],
					...(compiled === undefined ? {} : { compiled }),
				};
			},
		);
		return announce(resource, "remove", organizationId, result);
	});

	const listChildren = Effect.fn("PbxRepository.listChildren")(function* (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
	) {
		return yield* scoped(
			resource.kind,
			"listChildren",
			organizationId,
			resource.table,
			async (transaction) => {
				await requireParent(transaction, resource, parentId);
				return (await transaction
					.select()
					.from(resource.table)
					.where(eq(resource.parentColumn, parentId))
					.orderBy(...resource.orderBy.map((column) => asc(column)))) as Record<string, unknown>[];
			},
		);
	});

	const createChild = Effect.fn("PbxRepository.createChild")(function* (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
		values: Record<string, unknown>,
		actor?: AuditActor,
	) {
		const result = yield* scoped(
			resource.kind,
			"createChild",
			organizationId,
			resource.table,
			async (transaction): Promise<MutationResult<Record<string, unknown>>> => {
				await requireParent(transaction, resource, parentId);
				const row = {
					...withInsertDefaults(resource.table, values),
					id: newId(),
					organizationId,
					[parentKey(resource)]: parentId,
				};
				await assertDestinations(transaction, row, resource.destinations);
				const inserted = await transaction
					.insert(resource.table)
					.values(row as never)
					.returning();
				const created = inserted[0] as Record<string, unknown>;
				await audit(
					transaction,
					organizationId,
					resource,
					"create",
					String(created.id ?? row.id),
					{ after: created },
					actor,
				);
				const compiled = await settle(transaction, organizationId, resource, "create");
				return {
					row: inserted[0] as Record<string, unknown>,
					warnings: compiled?.warnings ?? [],
					...(compiled === undefined ? {} : { compiled }),
				};
			},
		);
		return announce(resource, "create", organizationId, result);
	});

	const updateChild = Effect.fn("PbxRepository.updateChild")(function* (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
		id: string,
		values: Record<string, unknown>,
		actor?: AuditActor,
	) {
		const result = yield* scoped(
			resource.kind,
			"updateChild",
			organizationId,
			resource.table,
			async (transaction): Promise<MutationResult<Record<string, unknown>>> => {
				const existing = await requireChild(transaction, resource, parentId, id);
				await assertDestinations(
					transaction,
					mergedForGuards(resource.table, existing, values),
					resource.destinations,
				);
				const updated = await transaction
					.update(resource.table)
					.set(withUpdateDefaults(resource.table, values) as never)
					.where(and(eq(rowId(resource), id), eq(resource.parentColumn, parentId)))
					.returning();
				await audit(
					transaction,
					organizationId,
					resource,
					"update",
					id,
					{ before: existing, after: (updated[0] ?? existing) as Record<string, unknown> },
					actor,
				);
				const compiled = await settle(transaction, organizationId, resource, "update");
				return {
					row: (updated[0] ?? existing) as Record<string, unknown>,
					warnings: compiled?.warnings ?? [],
					...(compiled === undefined ? {} : { compiled }),
				};
			},
		);
		return announce(resource, "update", organizationId, result);
	});

	const removeChild = Effect.fn("PbxRepository.removeChild")(function* (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
		id: string,
		actor?: AuditActor,
	) {
		const result = yield* scoped(
			resource.kind,
			"removeChild",
			organizationId,
			resource.table,
			async (transaction): Promise<MutationResult<{ readonly id: string }>> => {
				const existing = await requireChild(transaction, resource, parentId, id);
				await assertNotReferenced(transaction, resource, id);
				await transaction
					.delete(resource.table)
					.where(and(eq(rowId(resource), id), eq(resource.parentColumn, parentId)));
				await audit(
					transaction,
					organizationId,
					resource,
					"delete",
					id,
					{ before: existing },
					actor,
				);
				const compiled = await settle(transaction, organizationId, resource, "remove");
				return {
					row: { id },
					warnings: compiled?.warnings ?? [],
					...(compiled === undefined ? {} : { compiled }),
				};
			},
		);
		return announce(resource, "remove", organizationId, result);
	});

	/**
	 * Rewrites a child collection's ordinals to the order the caller listed its ids in.
	 *
	 * Ordinal is **semantics, not decoration** in all three collections that have one: the first
	 * time-condition rule whose predicates match wins, IVR options are offered in ordinal order, and
	 * a sequential ring group dials its members in it. So reordering a list of six by PATCHing six
	 * rows one at a time is not a convenience problem, it is a correctness one — each PATCH
	 * recompiles, so the five intermediate states are compiled, published to the routing cache, and
	 * briefly executable, and a client that dies halfway leaves the collection in an order nobody
	 * chose. Worse, the natural "swap two ordinals" sequence transiently duplicates one.
	 *
	 * One statement per row, one transaction, one recompile at the end: the collection is only ever
	 * observed in the order it started in or the order it was asked for.
	 *
	 * The `ids` must be exactly the collection's current membership — a permutation, no more and no
	 * less. Accepting a subset would mean inventing a rule for where the omitted rows go, and every
	 * such rule is a silent reordering of rows the caller never mentioned.
	 */
	const reorderChildren = Effect.fn("PbxRepository.reorderChildren")(function* (
		organizationId: string,
		resource: PbxChildResource,
		parentId: string,
		ids: readonly string[],
		actor?: AuditActor,
	) {
		const result = yield* scoped(
			resource.kind,
			"reorderChildren",
			organizationId,
			resource.table,
			async (transaction): Promise<MutationResult<readonly Record<string, unknown>[]>> => {
				const ordinalColumn = resource.ordinalColumn;
				if (ordinalColumn === undefined) {
					throw new PbxValidationFailure({
						field: "ids",
						detail: `${resource.kind} rows have no order to rewrite.`,
					});
				}

				await requireParent(transaction, resource, parentId);
				const existing = (await transaction
					.select()
					.from(resource.table)
					.where(eq(resource.parentColumn, parentId))) as Record<string, unknown>[];

				assertPermutation(
					resource.kind,
					existing.map((row) => String(row.id)),
					ids,
				);

				// Ordinals are rewritten to 0…n-1 rather than preserving whatever the rows happened to
				// hold: the point of the endpoint is that the stored order is exactly the sent order,
				// and reusing the old values would leave gaps that the next insert has to guess around.
				for (const [index, id] of ids.entries()) {
					await transaction
						.update(resource.table)
						.set({ [columnKey(ordinalColumn)]: index } as never)
						.where(and(eq(rowId(resource), id), eq(resource.parentColumn, parentId)));
				}

				const reordered = (await transaction
					.select()
					.from(resource.table)
					.where(eq(resource.parentColumn, parentId))
					.orderBy(...resource.orderBy.map((column) => asc(column)))) as Record<string, unknown>[];
				// The collection, not a row: a reorder's `resource_ref` is the PARENT, and the change is
				// the ordering itself — recording N per-row ordinal diffs would say the same thing N
				// times and still not say what the new order is. Only `after` is stored, because the
				// order the rows were READ back in is the only one that was ever observable; `existing`
				// above is deliberately unordered (the permutation check does not need an order).
				await audit(
					transaction,
					organizationId,
					resource,
					"reorder",
					parentId,
					{ after: { order: reordered.map((row) => String(row.id)) } },
					actor,
				);
				const compiled = await settle(transaction, organizationId, resource, "reorder");
				return {
					row: reordered,
					warnings: compiled?.warnings ?? [],
					...(compiled === undefined ? {} : { compiled }),
				};
			},
		);
		return announce(resource, "reorder", organizationId, result);
	});

	const compile = Effect.fn("PbxRepository.compile")(function* (organizationId: string) {
		return yield* scoped(
			"routing",
			"compile",
			organizationId,
			undefined,
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
		return columnKey(resource.parentColumn);
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
		reorderChildren,
		compile,
	};
}

export function pbxRepositoryLayer(
	deps: PbxRepositoryDependencies,
): Layer.Layer<PbxRepository, never> {
	return Layer.effect(PbxRepository)(Effect.sync(() => PbxRepository.of(makePbxRepository(deps))));
}
