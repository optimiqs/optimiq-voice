/**
 * The query vocabulary the PBX tables are built with.
 *
 * `pnpm` resolves `drizzle-orm` once per distinct **peer set**, and `apps/api` does not share this
 * package's peers (it pins `zod@3` while every package here is on the catalog's `zod@4`). The two
 * importers therefore receive separate — structurally identical, nominally incompatible — copies of
 * the same `1.0.0-rc.4` build, and an `eq()` imported from one cannot be applied to a column object
 * built by the other: `SQL<unknown>` from instance A is not assignable to `SQL<unknown>` from
 * instance B. `apps/api/src/auth/legacy-access-key.repository.ts` documents the same collision and
 * works around it by dropping to raw SQL, which is fine for a two-column lookup table and is not
 * fine for thirty-five.
 *
 * Re-exporting the operators here binds them to the same instance as the tables, so a consumer that
 * imports both from `@optimiq-voice/pbx-db` gets a coherent pair. This is the only supported way to
 * build queries against this schema from outside the package.
 *
 * This is a re-export and nothing else: no wrapper, no divergence, no second implementation. When
 * the peer sets converge (`apps/api` moving to `zod@4`) the module becomes redundant, and deleting
 * it is a one-line change at each call site.
 */

export {
	and,
	asc,
	between,
	count,
	desc,
	eq,
	getTableName,
	gt,
	gte,
	ilike,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	ne,
	not,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
export type { SQL } from "drizzle-orm";
/**
 * The table/column types, for the same reason and with the same caveat as the operators above: a
 * consumer that declares `readonly table: PgTable` has to mean *this* instance's `PgTable`, or the
 * declaration will not accept the table objects this package exports.
 */
export type { AnyPgColumn, PgColumn, PgTable } from "drizzle-orm/pg-core";
/**
 * Table introspection, re-exported for the same instance-binding reason as everything above.
 *
 * `apps/api` reads the unique-index definitions off a table so a `23505` can name the column the
 * form should attach the message to, rather than guessing it from the index name. A
 * `getTableConfig` imported from the consumer's own drizzle copy would be handed a table object
 * built by this one and would not recognise it.
 */
export { getTableConfig } from "drizzle-orm/pg-core";
