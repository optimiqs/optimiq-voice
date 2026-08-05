import { describe, expect, it } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { CDR_PARTITION_KEYS, PARTITIONED_CDR_TABLES } from "../partitions";
import { callEvents } from "./call-event-schema";
import { callLegs } from "./call-leg-schema";
import { cdrSchema } from "./index";
import { recordings } from "./recording-schema";
import type { PgTable } from "drizzle-orm/pg-core";

/**
 * `drizzle-kit generate` diffs the Drizzle schema against the snapshot, and `drizzle-kit check`
 * validates the journal — neither knows the live tables are partitioned. These specs are the
 * missing half of that contract: they pin the shape the hand-written `PARTITION BY` DDL depends
 * on, so a schema edit that would silently break partitioning fails here instead of in migration.
 */
type PartitionedTableName = (typeof PARTITIONED_CDR_TABLES)[number];

const partitionedTables: Record<PartitionedTableName, PgTable> = {
	call_legs: callLegs,
	call_events: callEvents,
};

/** `it.each` needs a mutable array of argument tuples to infer the callback parameter. */
const partitionedTableCases = PARTITIONED_CDR_TABLES.map(
	(tableName) => [tableName] as [PartitionedTableName],
);

describe("partitioned CDR tables", () => {
	it.each(partitionedTableCases)(
		"%s declares a composite primary key containing its partition key",
		(tableName) => {
			const config = getTableConfig(partitionedTables[tableName]);
			const partitionKey = CDR_PARTITION_KEYS[tableName];
			const primaryKey = config.primaryKeys[0];

			// PostgreSQL rejects any unique constraint on a partitioned table that omits the
			// partition key, so the composite PK is a requirement, not a preference.
			expect(config.primaryKeys).toHaveLength(1);
			expect(primaryKey?.getName()).toBe(`${tableName}_pkey`);
			expect(primaryKey?.columns.map((column) => column.name)).toEqual(["id", partitionKey]);
		},
	);

	it.each(partitionedTableCases)("%s keeps its partition key NOT NULL", (tableName) => {
		const config = getTableConfig(partitionedTables[tableName]);
		const partitionKey = config.columns.find(
			(column) => column.name === CDR_PARTITION_KEYS[tableName],
		);

		expect(partitionKey?.notNull).toBe(true);
	});

	it.each(partitionedTableCases)("%s declares no unique index", (tableName) => {
		const config = getTableConfig(partitionedTables[tableName]);

		// A unique index would have to include the partition key; none is needed, so none exists.
		expect(config.indexes.filter((entry) => entry.config.unique)).toHaveLength(0);
		expect(config.uniqueConstraints).toHaveLength(0);
	});

	it.each(partitionedTableCases)("%s declares no foreign key", (tableName) => {
		const config = getTableConfig(partitionedTables[tableName]);

		// A FK into a partitioned table must target a unique constraint holding the partition key.
		expect(config.foreignKeys).toHaveLength(0);
	});
});

describe("call_legs", () => {
	const config = getTableConfig(callLegs);

	it("is the ~40-column trim of the FusionPBX 90-column CDR plus a jsonb tail", () => {
		expect(config.columns.length).toBeGreaterThanOrEqual(35);
		expect(config.columns.length).toBeLessThanOrEqual(45);
		expect(config.columns.find((column) => column.name === "raw")?.notNull).toBe(true);
	});

	it("carries the reporting indexes the CDR explorer queries by", () => {
		expect(config.indexes.map((entry) => entry.config.name).sort()).toEqual([
			"call_legs_call_idx",
			"call_legs_organization_from_idx",
			"call_legs_organization_started_idx",
			"call_legs_organization_to_idx",
			"call_legs_recording_idx",
		]);
	});

	it("indexes recordings partially so the retention sweep never scans answered-only legs", () => {
		const recordingIndex = config.indexes.find(
			(entry) => entry.config.name === "call_legs_recording_idx",
		);

		expect(recordingIndex?.config.where).toBeDefined();
	});

	it("orders the primary reporting index newest-first", () => {
		const reportingIndex = config.indexes.find(
			(entry) => entry.config.name === "call_legs_organization_started_idx",
		);
		const columns = reportingIndex?.config.columns ?? [];

		expect(columns).toHaveLength(2);
		expect((columns[1] as { indexConfig?: { order?: string } }).indexConfig?.order).toBe("desc");
	});

	it("constrains every value domain with a check, including the hangup taxonomy", () => {
		expect(config.checks.map((entry) => entry.name).sort()).toEqual([
			"call_legs_destination_type_check",
			"call_legs_direction_check",
			"call_legs_disposition_check",
			"call_legs_duration_check",
			"call_legs_hangup_cause_check",
			"call_legs_hangup_side_check",
			"call_legs_leg_check",
			"call_legs_transcription_status_check",
		]);
	});
});

describe("tenant policies", () => {
	it("gives the append-only ledgers exactly a select and an insert policy", () => {
		for (const table of [callLegs, callEvents]) {
			const config = getTableConfig(table);

			expect(config.enableRLS).toBe(true);
			expect(
				config.policies.map((policy) => `${policy.name}:${String(policy.for)}`).sort(),
			).toEqual([`${config.name}_tenant_insert:insert`, `${config.name}_tenant_select:select`]);
			// An INSERT policy has no USING clause and a SELECT policy has no WITH CHECK; the
			// preflight introspector asserts exactly that shape against the live catalogue.
			expect(config.policies.find((policy) => policy.for === "insert")?.using).toBeUndefined();
			expect(config.policies.find((policy) => policy.for === "select")?.withCheck).toBeUndefined();
		}
	});

	it("gives recordings a single read-write policy", () => {
		const config = getTableConfig(recordings);

		expect(config.enableRLS).toBe(true);
		expect(config.policies).toHaveLength(1);
		expect(config.policies[0]?.name).toBe("recordings_tenant_isolation");
		expect(config.policies[0]?.for).toBe("all");
		expect(config.policies[0]?.using).toBeDefined();
		expect(config.policies[0]?.withCheck).toBeDefined();
	});

	it("scopes every policy to the cdr tenant role and the organization column", () => {
		for (const table of Object.values(cdrSchema)) {
			for (const policy of getTableConfig(table).policies) {
				expect(JSON.stringify(policy.to)).toContain("cdr_tenant_tls");
				const predicate = JSON.stringify(policy.using ?? policy.withCheck);
				expect(predicate).toContain("organization_id");
				expect(predicate).toContain("cdr_tenant_tls.organization_id");
			}
		}
	});

	it("puts an organization_id column on every table in the journal", () => {
		for (const table of Object.values(cdrSchema)) {
			const config = getTableConfig(table);
			const organizationId = config.columns.find((column) => column.name === "organization_id");

			expect(organizationId?.notNull).toBe(true);
		}
	});
});

describe("recordings", () => {
	const config = getTableConfig(recordings);

	it("keeps the object key globally unique", () => {
		const unique = config.indexes.find(
			(entry) => entry.config.name === "recordings_object_key_key",
		);

		expect(unique?.config.unique).toBe(true);
	});

	it("is not partitioned, so it keeps a single-column primary key", () => {
		expect(config.columns.find((column) => column.name === "id")?.primary).toBe(true);
		expect(config.primaryKeys).toHaveLength(0);
	});

	it("tracks the retention lifecycle", () => {
		const names = config.columns.map((column) => column.name);

		expect(names).toContain("retention_until");
		expect(names).toContain("deleted_at");
		expect(names).toContain("updated_at");
	});
});
