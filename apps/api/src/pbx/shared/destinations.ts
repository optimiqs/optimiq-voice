import {
	type Destination,
	DESTINATION_TARGET_TABLES,
	type DestinationType,
	destinationColumnNames,
	type PbxDatabaseTransaction,
	sql,
	validateDestination,
} from "@optimiq-voice/pbx-db";
import { type EntityReference, PbxInvalidDestinationFailure } from "./pbx.errors";
import type { DestinationIssueWire } from "./pbx.errors";

/**
 * Destination handling for the CRUD layer.
 *
 * `packages/pbx-db` states the contract and enforces the *shape* of the column trio with a check
 * constraint. It cannot enforce that `destination_ref` resolves, because the target table varies
 * by row — so this module does the two things the database delegated:
 *
 * 1. **A real existence check**, `select 1 from <target table> where id = $1`, inside the same
 *    transaction as the write. Doing it outside would be a time-of-check/time-of-use gap: the
 *    target could be deleted between the check and the insert, and the row that lands would be
 *    dangling. `packages/routing`'s author recorded this as a constraint on the API.
 * 2. **A reverse scan** before a delete, so a row that other rows still point at is refused with
 *    the referrers named rather than silently leaving them dangling.
 *
 * Both run under the tenant transaction, so RLS scopes them: a ref that names another tenant's row
 * is indistinguishable from one that names nothing, and both are refused. That is the correct
 * behaviour and it is free.
 */

/**
 * Column-name prefixes for a secondary trio. The physical columns are
 * `<prefix>_destination_type` / `_ref` / `_data`; the Drizzle keys are
 * `<prefix>DestinationType` etc.
 */
export type DestinationPrefix = "" | "failover" | "nomatch" | "timeout" | "invalid";

/** Where one destination trio lives, and whether the row is allowed not to have one. */
export interface DestinationField {
	readonly prefix: DestinationPrefix;
	readonly required: boolean;
}

/** The camelCase Drizzle keys of one trio. */
export function destinationKeys(prefix: DestinationPrefix): {
	readonly type: string;
	readonly ref: string;
	readonly data: string;
} {
	return prefix === ""
		? { type: "destinationType", ref: "destinationRef", data: "destinationData" }
		: {
				type: `${prefix}DestinationType`,
				ref: `${prefix}DestinationRef`,
				data: `${prefix}DestinationData`,
			};
}

/** The form field a destination issue belongs to, e.g. `timeoutDestinationRef`. */
function fieldName(prefix: DestinationPrefix, part: "type" | "ref" | "data"): string {
	return destinationKeys(prefix)[part];
}

// ---------------------------------------------------------------------------------------------
// Existence
// ---------------------------------------------------------------------------------------------

/**
 * Whether an entity-backed destination's target row exists in this tenant.
 *
 * The table name comes from `DESTINATION_TARGET_TABLES`, a closed const map in `pbx-db` — never
 * from user input — so inlining it into the statement is safe.
 */
export async function destinationTargetExists(
	transaction: PbxDatabaseTransaction,
	type: DestinationType,
	ref: string,
): Promise<boolean> {
	const table = DESTINATION_TARGET_TABLES[type];
	if (table === null) {
		return true;
	}
	const rows = await transaction.execute(
		sql`select 1 as present from ${sql.identifier(table)} where id = ${ref}::uuid limit 1`,
	);
	return readRows(rows).length > 0;
}

/**
 * Validates every destination trio on a row about to be written.
 *
 * Shape first (`validateDestination` from `pbx-db`), then existence — in that order, because an
 * entity type with a missing ref has nothing to look up and reporting both would be noise. Every
 * trio is checked before anything is reported, so a form with three bad destinations gets three
 * errors rather than three round trips (oikos §4, guard-then-execute with complete field errors).
 */
export async function assertDestinations(
	transaction: PbxDatabaseTransaction,
	row: Readonly<Record<string, unknown>>,
	fields: readonly DestinationField[],
): Promise<void> {
	const issues: DestinationIssueWire[] = [];

	for (const field of fields) {
		const keys = destinationKeys(field.prefix);
		const type = row[keys.type] as DestinationType | null | undefined;
		const ref = (row[keys.ref] ?? null) as string | null;
		const data = (row[keys.data] ?? null) as Destination["destinationData"];

		if (type === null || type === undefined) {
			if (field.required) {
				issues.push({
					field: fieldName(field.prefix, "type"),
					code: "missing-type",
					message: "A destination is required.",
				});
			}
			continue;
		}

		const shapeIssues = validateDestination({
			destinationType: type,
			destinationRef: ref,
			destinationData: data,
		});
		if (shapeIssues.length > 0) {
			for (const issue of shapeIssues) {
				issues.push({
					field: fieldName(
						field.prefix,
						issue.code === "missing-data" || issue.code === "unexpected-data" ? "data" : "ref",
					),
					code: issue.code,
					message: issue.message,
				});
			}
			continue;
		}

		if (ref !== null && !(await destinationTargetExists(transaction, type, ref))) {
			issues.push({
				field: fieldName(field.prefix, "ref"),
				code: "dangling",
				message: `No ${type} with id ${ref} exists in this organization.`,
			});
		}
	}

	if (issues.length > 0) {
		throw new PbxInvalidDestinationFailure({ issues });
	}
}

// ---------------------------------------------------------------------------------------------
// The reverse scan
// ---------------------------------------------------------------------------------------------

/** One place a destination trio is stored: physical table, trio prefix, and a display column. */
interface DestinationSite {
	readonly table: string;
	readonly kind: string;
	readonly prefix: string;
	/** Column used as the human label in the 409 body. `null` when the table has none. */
	readonly nameColumn: string | null;
}

/**
 * Every destination trio in the schema.
 *
 * Hand-maintained rather than derived, because deriving it would mean reflecting over Drizzle
 * table objects at runtime to find columns whose names end in `destination_ref` — which is more
 * machinery, is not type-checked either, and hides the one thing a reviewer wants to see: the
 * list. `pbx.spec.ts` asserts every entry names a real table and column.
 */
export const DESTINATION_SITES: readonly DestinationSite[] = [
	{ table: "phone_number", kind: "phone-number", prefix: "", nameColumn: "e164" },
	{ table: "inbound_route", kind: "inbound-route", prefix: "", nameColumn: "name" },
	{ table: "inbound_route", kind: "inbound-route", prefix: "failover_", nameColumn: "name" },
	{ table: "outbound_route", kind: "outbound-route", prefix: "failover_", nameColumn: "name" },
	{ table: "time_condition", kind: "time-condition", prefix: "", nameColumn: "name" },
	{ table: "time_condition", kind: "time-condition", prefix: "nomatch_", nameColumn: "name" },
	{ table: "ivr_menu", kind: "ivr-menu", prefix: "timeout_", nameColumn: "name" },
	{ table: "ivr_menu", kind: "ivr-menu", prefix: "invalid_", nameColumn: "name" },
	{ table: "ivr_menu_option", kind: "ivr-menu-option", prefix: "", nameColumn: "label" },
	{ table: "ring_group", kind: "ring-group", prefix: "timeout_", nameColumn: "name" },
	{
		table: "ring_group_destination",
		kind: "ring-group-destination",
		prefix: "",
		nameColumn: null,
	},
	{ table: "queue", kind: "queue", prefix: "timeout_", nameColumn: "name" },
	{ table: "park_lot", kind: "park-lot", prefix: "timeout_", nameColumn: "name" },
	{ table: "voicemail_option", kind: "voicemail-option", prefix: "", nameColumn: "label" },
];

/**
 * Every row that points at `id` as a destination of type `type`.
 *
 * One statement per site rather than a hand-rolled `union all`: fourteen small index-backed reads
 * inside an open transaction cost less than the readability of the alternative, and a `union` over
 * tables with different column sets needs the same per-site casting anyway. The scan runs only on
 * delete.
 */
export async function findDestinationReferences(
	transaction: PbxDatabaseTransaction,
	type: DestinationType,
	id: string,
	options: { readonly excludeTable?: string } = {},
): Promise<readonly EntityReference[]> {
	const references: EntityReference[] = [];

	for (const site of DESTINATION_SITES) {
		if (site.table === options.excludeTable) {
			continue;
		}
		const names = destinationColumnNames(site.prefix);
		const nameExpression =
			site.nameColumn === null ? sql`null` : sql`${sql.identifier(site.nameColumn)}::text`;
		const rows = await transaction.execute(sql`
			select id::text as id, ${nameExpression} as name
			from ${sql.identifier(site.table)}
			where ${sql.identifier(names.type)} = ${type}
			  and ${sql.identifier(names.ref)} = ${id}::uuid
			limit 25
		`);
		for (const row of readRows(rows)) {
			references.push({
				kind: site.kind,
				id: String(row.id),
				name: row.name === null || row.name === undefined ? null : String(row.name),
				field: names.ref,
			});
		}
	}

	return references;
}

/** Non-destination foreign keys the CRUD layer also refuses to orphan. */
export interface ScalarReferenceSite {
	readonly table: string;
	readonly kind: string;
	readonly column: string;
	readonly nameColumn: string | null;
}

export async function findScalarReferences(
	transaction: PbxDatabaseTransaction,
	sites: readonly ScalarReferenceSite[],
	id: string,
): Promise<readonly EntityReference[]> {
	const references: EntityReference[] = [];
	for (const site of sites) {
		const nameExpression =
			site.nameColumn === null ? sql`null` : sql`${sql.identifier(site.nameColumn)}::text`;
		const rows = await transaction.execute(sql`
			select id::text as id, ${nameExpression} as name
			from ${sql.identifier(site.table)}
			where ${sql.identifier(site.column)} = ${id}::uuid
			limit 25
		`);
		for (const row of readRows(rows)) {
			references.push({
				kind: site.kind,
				id: String(row.id),
				name: row.name === null || row.name === undefined ? null : String(row.name),
				field: site.column,
			});
		}
	}
	return references;
}

/**
 * Rows referencing a trunk, which lives inside `outbound_route.trunk_priority` (JSONB) rather than
 * in a column, so no foreign key can express it and the generic scan cannot find it.
 */
export async function findTrunkReferences(
	transaction: PbxDatabaseTransaction,
	trunkId: string,
): Promise<readonly EntityReference[]> {
	const rows = await transaction.execute(sql`
		select id::text as id, name::text as name
		from outbound_route
		where exists (
			select 1
			from jsonb_array_elements(trunk_priority) as entry
			where entry ->> 'trunkId' = ${trunkId}
		)
		limit 25
	`);
	return readRows(rows).map((row) => ({
		kind: "outbound-route",
		id: String(row.id),
		name: row.name === null || row.name === undefined ? null : String(row.name),
		field: "trunk_priority",
	}));
}

/**
 * Normalizes what `transaction.execute` hands back.
 *
 * drizzle-orm's postgres-js driver returns the driver's own result object, which is array-like but
 * has also carried a `.rows` property across releases. Accepting both is two lines here versus a
 * runtime break on a patch bump.
 */
export function readRows(result: unknown): readonly Record<string, unknown>[] {
	if (Array.isArray(result)) {
		return result as Record<string, unknown>[];
	}
	if (typeof result === "object" && result !== null && "rows" in result) {
		const rows = (result as { rows: unknown }).rows;
		if (Array.isArray(rows)) {
			return rows as Record<string, unknown>[];
		}
	}
	return [];
}
