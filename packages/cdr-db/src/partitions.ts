import { sql, type SQL } from "drizzle-orm";

/**
 * Monthly range partitioning for the CDR tables.
 *
 * Drizzle 1.0-rc.4 cannot declare `PARTITION BY`, so the parent tables are created partitioned by
 * the baseline migration and the partitions themselves are managed here. Two SQL functions do the
 * privileged work (they are created by the same migration, `security definer`, owned by the
 * schema owner):
 *
 * - `cdr_ensure_monthly_partition(table_name text, month_start date) returns text`
 * - `cdr_drop_partitions_before(table_name text, cutoff date) returns setof text`
 *
 * Both validate `table_name` against a hard-coded allow-list, so no caller can steer them at an
 * arbitrary relation. The TypeScript helpers below are thin, testable wrappers: nothing here
 * interpolates a caller-supplied identifier into SQL.
 *
 * Nothing in this module schedules anything. Phase 2's engine (or a platform cron) calls
 * `ensureMonthlyPartitions` on a horizon and `dropPartitionsBefore` on a retention window.
 */

/** Tables the ensure/drop functions accept. Must match the allow-list inside the SQL functions. */
export const PARTITIONED_CDR_TABLES = ["call_legs", "call_events"] as const;
export type PartitionedCdrTable = (typeof PARTITIONED_CDR_TABLES)[number];

/** Column each table is range-partitioned on. */
export const CDR_PARTITION_KEYS: Readonly<Record<PartitionedCdrTable, string>> = {
	call_legs: "started_at",
	call_events: "at",
} as const;

export const CDR_ENSURE_PARTITION_FUNCTION = "cdr_ensure_monthly_partition";
export const CDR_DROP_PARTITIONS_FUNCTION = "cdr_drop_partitions_before";

/** Raised when a caller asks for a table the partition functions do not manage. */
export class PartitionedTableError extends Error {
	readonly _tag = "PartitionedTableError" as const;
	readonly tableName: string;

	constructor(tableName: string) {
		super(
			`"${tableName}" is not a partitioned CDR table; expected one of ${PARTITIONED_CDR_TABLES.join(", ")}.`,
		);
		this.name = "PartitionedTableError";
		this.tableName = tableName;
	}
}

export function assertPartitionedCdrTable(tableName: string): PartitionedCdrTable {
	const match = PARTITIONED_CDR_TABLES.find((candidate) => candidate === tableName);
	if (!match) {
		throw new PartitionedTableError(tableName);
	}
	return match;
}

/** UTC start of the month containing `date`. Partition bounds are always UTC midnight. */
export function monthStart(date: Date): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** UTC start of the month `offset` months after the month containing `date`. */
export function addMonths(date: Date, offset: number): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
}

/** `YYYY-MM-DD`, the literal form PostgreSQL range bounds are written in. */
export function toDateLiteral(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** `call_legs_2026_08` — the partition holding the month containing `date`. */
export function monthlyPartitionName(table: PartitionedCdrTable, date: Date): string {
	const start = monthStart(date);
	const month = String(start.getUTCMonth() + 1).padStart(2, "0");
	return `${table}_${String(start.getUTCFullYear())}_${month}`;
}

/** `<table>_default` — the catch-all partition that keeps an out-of-range insert from failing. */
export function defaultPartitionName(table: PartitionedCdrTable): string {
	return `${table}_default`;
}

export interface MonthlyPartitionRange {
	readonly name: string;
	/** Inclusive lower bound. */
	readonly from: Date;
	/** Exclusive upper bound. */
	readonly to: Date;
}

export function monthlyPartitionRange(
	table: PartitionedCdrTable,
	date: Date,
): MonthlyPartitionRange {
	const from = monthStart(date);
	return { name: monthlyPartitionName(table, date), from, to: addMonths(from, 1) };
}

/**
 * The months a horizon covers, starting with the month containing `from`.
 * `ensureMonthlyPartitions` runs one statement per entry.
 */
export function monthsInHorizon(from: Date, monthCount: number): readonly Date[] {
	if (!Number.isInteger(monthCount) || monthCount < 1) {
		throw new RangeError("Partition horizon must be a positive whole number of months.");
	}
	const start = monthStart(from);
	return Array.from({ length: monthCount }, (_unused, offset) => addMonths(start, offset));
}

/**
 * Idempotent `CREATE TABLE ... PARTITION OF ... FOR VALUES FROM ... TO ...`.
 *
 * Emitted as literal DDL (not a function call) for the baseline migration, where the functions
 * do not exist yet. Identifiers come from {@link monthlyPartitionName}, never from user input.
 */
export function buildCreateMonthlyPartitionSql(
	table: PartitionedCdrTable,
	date: Date,
	options: { readonly ifNotExists?: boolean } = {},
): string {
	const range = monthlyPartitionRange(table, date);
	const guard = options.ifNotExists === false ? "" : "if not exists ";
	return `create table ${guard}"${range.name}" partition of "${table}" for values from ('${toDateLiteral(range.from)}') to ('${toDateLiteral(range.to)}');`;
}

/** Idempotent DDL for the catch-all partition. */
export function buildCreateDefaultPartitionSql(
	table: PartitionedCdrTable,
	options: { readonly ifNotExists?: boolean } = {},
): string {
	const guard = options.ifNotExists === false ? "" : "if not exists ";
	return `create table ${guard}"${defaultPartitionName(table)}" partition of "${table}" default;`;
}

/** `select cdr_ensure_monthly_partition('call_legs', '2026-08-01')` as a bound Drizzle fragment. */
export function ensureMonthlyPartitionQuery(table: PartitionedCdrTable, date: Date): SQL {
	return sql`select ${sql.raw(CDR_ENSURE_PARTITION_FUNCTION)}(${table}, ${toDateLiteral(monthStart(date))}::date) as partition_name`;
}

/** `select * from cdr_drop_partitions_before('call_legs', '2025-07-01')` as a bound fragment. */
export function dropPartitionsBeforeQuery(table: PartitionedCdrTable, cutoff: Date): SQL {
	return sql`select ${sql.raw(CDR_DROP_PARTITIONS_FUNCTION)}(${table}, ${toDateLiteral(monthStart(cutoff))}::date) as dropped_partition`;
}

/** Minimal execution surface: any Drizzle handle or transaction satisfies it. */
export interface PartitionExecutor {
	readonly execute: (query: SQL) => PromiseLike<unknown>;
}

/**
 * Creates the partition for one month if it is missing and returns its name.
 * Safe to call concurrently: the SQL function swallows `duplicate_table`.
 */
export async function createMonthlyPartition(
	executor: PartitionExecutor,
	table: PartitionedCdrTable,
	date: Date,
): Promise<string> {
	assertPartitionedCdrTable(table);
	await executor.execute(ensureMonthlyPartitionQuery(table, date));
	return monthlyPartitionName(table, date);
}

/**
 * Ensures a rolling horizon exists for every partitioned CDR table. The default horizon of 2
 * months (current + next) is the minimum that keeps an insert at 23:59 on the last day of a
 * month off the default partition.
 */
export async function ensureMonthlyPartitions(
	executor: PartitionExecutor,
	options: { readonly from?: Date; readonly monthCount?: number } = {},
): Promise<readonly string[]> {
	const months = monthsInHorizon(options.from ?? new Date(), options.monthCount ?? 2);
	const created: string[] = [];
	for (const table of PARTITIONED_CDR_TABLES) {
		for (const month of months) {
			created.push(await createMonthlyPartition(executor, table, month));
		}
	}
	return created;
}
