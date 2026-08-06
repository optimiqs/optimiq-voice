import type { DestinationField, ScalarReferenceSite } from "./destinations";
import type { DestinationType, PgColumn, PgTable } from "@optimiq-voice/pbx-db";

/**
 * A PBX resource, declared.
 *
 * ## Why the slices share one repository
 *
 * The oikos convention is one repository per feature slice, and the reason it exists is that a
 * slice's data access should be co-located and reviewable in one place. Ten of the eleven T1
 * entities are structurally identical CRUD over one database — same tenant wrapper, same paging,
 * same search, same destination guards, same compile-on-write — so ten hand-written repositories
 * would be ten copies of the same forty lines, and a fix to the paging window would have to be
 * applied ten times or, more likely, nine.
 *
 * So the declaration is per slice and the mechanism is shared: each slice owns a
 * `<feature>.resource.ts` that states its table, its searchable columns, its destination trios and
 * what other rows may point at it, and `pbx.repository.ts` is the single `Context.Service` that
 * turns any such declaration into Drizzle. The slice's data access is still one greppable file;
 * it is a declaration rather than a query builder. Anything a slice needs that this shape cannot
 * express (child collections, the routing resolvers) is a named method on the repository rather
 * than a widening of the descriptor.
 */
export interface PbxResource {
	/** Singular kebab-case entity name. Appears in 404/409 bodies and in diagnostics subjects. */
	readonly kind: string;
	/** Physical table name — what `affectsRouting()` is asked about. */
	readonly tableName: string;
	readonly table: PgTable;
	/** Columns free-text search runs over. All must be text-typed. */
	readonly searchColumns: readonly PgColumn[];
	/** Deterministic list order. Always ends in a unique column so paging cannot repeat a row. */
	readonly orderBy: readonly PgColumn[];
	/** The `enabled` flag, when the table has one, so `?enabled=` can narrow. */
	readonly enabledColumn?: PgColumn;
	/** Every destination trio on the row, and whether it may be absent. */
	readonly destinations: readonly DestinationField[];
	/**
	 * How other rows name this entity in a `destination_type`, or `null` when nothing can point at
	 * it as a destination. Drives the reverse scan that turns a delete into a 409.
	 */
	readonly destinationType: DestinationType | null;
	/** Foreign keys pointing here that we refuse to orphan even though no destination trio does. */
	readonly scalarReferences?: readonly ScalarReferenceSite[];
}

/** A child collection owned by a parent resource (IVR options, ring-group members, time rules). */
export interface PbxChildResource extends PbxResource {
	/** The column carrying the parent's id. */
	readonly parentColumn: PgColumn;
	readonly parentKind: string;
	/** The parent's table, so the child write can prove the parent exists in this tenant. */
	readonly parentTable: PgTable;
}
