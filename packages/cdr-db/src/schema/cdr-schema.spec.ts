import { describe, expect, it } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { CDR_PARTITION_KEYS, PARTITIONED_CDR_TABLES } from "../partitions";
import { cdrTenantRlsPreflightPlan } from "../rls-preflight-plan";
import { callEvents } from "./call-event-schema";
import { callLegs } from "./call-leg-schema";
import { CALL_DISPOSITIONS, QUEUE_OUTCOMES } from "./enums";
import { cdrSchema } from "./index";
import { cdrWriteQuarantine } from "./quarantine-schema";
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

/**
 * The tables the tenant role can reach, taken from the preflight plan rather than restated.
 *
 * The plan is what boot asserts against the live catalogue, so deriving the list from it is what
 * keeps "which tables are tenant-scoped?" answerable in one place — and makes a table added to the
 * journal without a decision about its tenancy fail one of the two specs below.
 */
const CDR_TENANT_TABLE_NAMES: readonly string[] = cdrTenantRlsPreflightPlan.expectations.map(
	(expectation) => expectation.table,
);

const tenantTables: readonly PgTable[] = Object.values(cdrSchema).filter((table) =>
	CDR_TENANT_TABLE_NAMES.includes(getTableConfig(table).name),
);

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

	it("is the ~45-column trim of the FusionPBX 90-column CDR plus a jsonb tail", () => {
		// The ceiling moves only when a column is added deliberately; the point of the band is that
		// the 90-column original was never copied wholesale, not that the number is frozen.
		expect(config.columns.length).toBeGreaterThanOrEqual(35);
		expect(config.columns.length).toBeLessThanOrEqual(60);
		expect(config.columns.find((column) => column.name === "raw")?.notNull).toBe(true);
	});

	it("carries the reporting indexes the CDR explorer queries by", () => {
		expect(config.indexes.map((entry) => entry.config.name).sort()).toEqual(
			[
				"call_legs_call_idx",
				"call_legs_organization_from_idx",
				"call_legs_organization_started_idx",
				"call_legs_organization_to_idx",
				"call_legs_queue_agent_idx",
				"call_legs_queue_idx",
				"call_legs_recording_idx",
				"call_legs_related_call_idx",
				// The three that deliberately do not lead with `organization_id`: a traceback is asked by
				// a platform operator about a number, across every tenant at once. See the schema.
				"call_legs_traceback_from_idx",
				"call_legs_traceback_to_idx",
				"call_legs_trunk_idx",
			].sort(),
		);
	});

	/**
	 * Sparse on purpose. The column is null on every leg but a virtual-hold callback, so the index
	 * is the size of the feature rather than of the ledger.
	 */
	it("indexes the cross-call link partially, because almost no leg carries one", () => {
		const related = config.indexes.find(
			(entry) => entry.config.name === "call_legs_related_call_idx",
		);

		expect(related?.config.where).toBeDefined();
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
			"call_legs_queue_outcome_check",
			"call_legs_queue_wait_check",
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

	it("puts a non-null organization_id column on every TENANT table in the journal", () => {
		for (const table of tenantTables) {
			const config = getTableConfig(table);
			const organizationId = config.columns.find((column) => column.name === "organization_id");

			expect(organizationId?.notNull).toBe(true);
		}
	});

	/**
	 * The one table in the journal that is deliberately NOT tenant-scoped, asserted as a decision
	 * rather than left as an omission.
	 *
	 * `cdr_write_quarantine` holds messages the writer could not turn into rows, and a large share
	 * of them are there precisely because their organization could not be established — an
	 * `organization_id NOT NULL` column under an RLS policy could not hold the rows it exists for.
	 * It carries no policies, no RLS and no tenant grants, and it is absent from
	 * `cdrTenantRlsPreflightPlan` for the same reason. If a future edit makes it look like a tenant
	 * table, this fails and the decision gets re-made on purpose.
	 */
	it("keeps the quarantine table off the tenant surface entirely", () => {
		const config = getTableConfig(cdrWriteQuarantine);

		expect(config.enableRLS).toBe(false);
		expect(config.policies).toHaveLength(0);
		expect(config.columns.find((column) => column.name === "organization_id")?.notNull).toBe(false);
		expect(CDR_TENANT_TABLE_NAMES).not.toContain(config.name);
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

/**
 * The queue leg.
 *
 * `queue_ref` has existed since the baseline and was never written by anything; the three columns
 * beside it are what turn "this call went to a queue" into a service level. What is asserted here is
 * the half a report would get silently wrong: that every column is NULLABLE (a `queue_wait_ms` of 0
 * on a direct extension call is a zero every average would then include), and that the index the
 * stats query runs on is PARTIAL, so the rows it serves are not paid for on every insert by the
 * majority of calls that never went near a queue.
 */
describe("the queue leg", () => {
	const config = getTableConfig(callLegs);
	const columns = new Map(config.columns.map((column) => [column.name, column]));

	it("keeps every queue column nullable, because most legs never touched a queue", () => {
		for (const name of ["queue_ref", "queue_wait_ms", "queue_outcome", "queue_agent_ref"]) {
			expect(columns.get(name)?.notNull, name).toBe(false);
			expect(columns.get(name)?.hasDefault, name).toBe(false);
		}
	});

	it("indexes the queue reporting path partially, so an unqueued call pays nothing for it", () => {
		const index = config.indexes.find((entry) => entry.config.name === "call_legs_queue_idx");
		expect(index).toBeDefined();
		expect(index?.config.where).toBeDefined();
		expect(index?.config.columns.map((column) => (column as { name?: string }).name)).toEqual([
			"organization_id",
			"queue_ref",
			"started_at",
		]);
	});

	/**
	 * A queue verdict is not a leg disposition. A caller the queue timed out into a voicemail box has
	 * a leg that ends `answered`, and an SLA built on the disposition would report a queue nobody
	 * staffs as fully served.
	 */
	it("keeps the queue outcome vocabulary separate from the leg disposition", () => {
		expect(QUEUE_OUTCOMES).toContain("exit-key");
		expect(QUEUE_OUTCOMES).toContain("no-agents");
		for (const outcome of QUEUE_OUTCOMES) {
			if (outcome === "answered") {
				continue;
			}
			expect(CALL_DISPOSITIONS as readonly string[]).not.toContain(outcome);
		}
	});
});

/**
 * Recording consent.
 *
 * Two tables carry it and they carry it differently, which is the thing worth pinning: `recordings`
 * takes the whole record as one `jsonb` because it is read with the object it describes, and
 * `call_legs` takes four flat columns because it is aggregated over. The second half is the sharper
 * assertion — that those four columns have NO check constraints. `call_legs` is append-only and
 * partitioned, so a rejected write is a call record that never existed; an outcome a newer engine
 * knows and this schema does not must land on the row rather than fail it.
 */
describe("recording consent", () => {
	const legConfig = getTableConfig(callLegs);
	const legColumns = new Map(legConfig.columns.map((column) => [column.name, column]));
	const recordingColumns = new Map(
		getTableConfig(recordings).columns.map((column) => [column.name, column]),
	);

	const LEG_CONSENT_COLUMNS = [
		"recording_consent",
		"recording_consent_method",
		"recording_consent_at",
		"recording_consent_regions",
	] as const;

	it("keeps the recording's consent one nullable jsonb, the way `pauses` is", () => {
		expect(recordingColumns.get("consent")?.notNull).toBe(false);
		expect(recordingColumns.get("consent")?.hasDefault).toBe(false);
		expect(recordingColumns.get("consent")?.getSQLType()).toBe("jsonb");
	});

	it("flattens the leg's consent into four nullable columns, because legs are aggregated", () => {
		for (const name of LEG_CONSENT_COLUMNS) {
			expect(legColumns.get(name), name).toBeDefined();
			expect(legColumns.get(name)?.notNull, name).toBe(false);
			expect(legColumns.get(name)?.hasDefault, name).toBe(false);
		}
		expect(legColumns.get("recording_consent_regions")?.getSQLType()).toBe("jsonb");
	});

	it("puts NO check on any of them, so an unknown future outcome reaches the row", () => {
		const names = legConfig.checks.map((entry) => entry.name);

		for (const column of LEG_CONSENT_COLUMNS) {
			expect(
				names.some((name) => name.includes(column)),
				column,
			).toBe(false);
		}
	});
});
