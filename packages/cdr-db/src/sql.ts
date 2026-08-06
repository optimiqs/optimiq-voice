/**
 * The query vocabulary the CDR tables are built with.
 *
 * Verbatim the reason `@optimiq-voice/pbx-db`'s `src/sql.ts` exists, and it applies here for the
 * same consumer: `pnpm` resolves `drizzle-orm` once per distinct **peer set**, and `apps/api` does
 * not share this package's peers (it pins `zod@3` while every package here is on the catalog's
 * `zod@4`). The two importers therefore receive separate — structurally identical, nominally
 * incompatible — copies of the same `1.0.0-rc.4` build, and an `eq()` imported from one cannot be
 * applied to a column object built by the other.
 *
 * Re-exporting the operators here binds them to the same instance as `callLegs` / `recordings`, so
 * the CDR reporting repository in `apps/api` can build a real Drizzle query instead of hand-writing
 * a partition-pruned `where` clause as a string. That matters more here than in `pbx-db`: the
 * reporting query carries the partition key, a cursor comparison and up to seven optional filters,
 * and string concatenation is where a tenant predicate goes missing.
 *
 * This is a re-export and nothing else: no wrapper, no divergence, no second implementation. When
 * the peer sets converge (`apps/api` moving to `zod@4`) the module becomes redundant.
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
 * consumer that declares `readonly table: PgTable` has to mean *this* instance's `PgTable`.
 */
export type { AnyPgColumn, PgColumn, PgTable } from "drizzle-orm/pg-core";
export { getTableConfig } from "drizzle-orm/pg-core";
