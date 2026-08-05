import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { createEntityId } from "@optimiq-voice/identifiers";
import {
	CDR_DROP_PARTITIONS_FUNCTION,
	CDR_ENSURE_PARTITION_FUNCTION,
	CDR_PARTITION_KEYS,
	createMonthlyPartition,
	defaultPartitionName,
	ensureMonthlyPartitions,
	monthlyPartitionName,
	PARTITIONED_CDR_TABLES,
} from "./partitions";
import {
	dropPartitionsBefore,
	expiredRecordingsSelectQuery,
	expiredRecordingsUpdateQuery,
	purgedRecordingTombstoneDeleteQuery,
} from "./retention";
import {
	captureDatabaseError,
	CDR_INTEGRATION_TESTS_ENABLED,
	createCdrIntegrationDatabase,
	deleteOrganizationRowsQuery,
	insertCallLegQuery,
	makeCallLegFixture,
	type CdrIntegrationDatabase,
} from "./testing/cdr-integration-database";

/**
 * The partitioning contract lives in hand-written migration SQL that drizzle-kit cannot see, so
 * this spec is its drift check: it asserts the live catalogue, not a snapshot.
 *
 *   RUN_DB_INTEGRATION_TESTS=true CDR_DATABASE_URL=... bun test src --max-concurrency 1
 *
 * `--max-concurrency 1` is mandatory — these tests create and drop real partitions.
 */
describe.skipIf(!CDR_INTEGRATION_TESTS_ENABLED)("cdr partitioning", () => {
	const organizationId = createEntityId();
	// Far outside any horizon the migration or retention sweep touches.
	const archiveMonth = new Date("2019-03-14T00:00:00Z");
	const futureMonth = new Date("2031-07-09T00:00:00Z");
	let database: CdrIntegrationDatabase;

	beforeAll(async () => {
		database = createCdrIntegrationDatabase();
	});

	afterAll(async () => {
		await database.db.execute(deleteOrganizationRowsQuery([organizationId]));
		for (const table of PARTITIONED_CDR_TABLES) {
			for (const month of [archiveMonth, futureMonth]) {
				await database.db.execute(
					sql.raw(`drop table if exists "${monthlyPartitionName(table, month)}"`),
				);
			}
		}
		await database.close();
	});

	it("declares both ledgers as range-partitioned parents on their partition key", async () => {
		const rows = (await database.db.execute(sql`
			select class.relname as table_name, class.relkind, partitioned.partstrat,
				attribute.attname as partition_key
			from pg_class as class
			join pg_partitioned_table as partitioned on partitioned.partrelid = class.oid
			join pg_attribute as attribute
				-- int2vector subscripts start at 0, so [0] is the first (and only) partition column.
				on attribute.attrelid = class.oid and attribute.attnum = partitioned.partattrs[0]
			where class.relname in ('call_legs', 'call_events')
			order by class.relname
		`)) as { table_name: string; relkind: string; partstrat: string; partition_key: string }[];

		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.relkind).toBe("p");
			// 'r' = RANGE.
			expect(row.partstrat).toBe("r");
			expect(row.partition_key).toBe(
				CDR_PARTITION_KEYS[row.table_name as (typeof PARTITIONED_CDR_TABLES)[number]],
			);
		}
	});

	it("keeps a default partition on each ledger so an out-of-horizon insert cannot fail", async () => {
		const rows = (await database.db.execute(sql`
			select child.relname as name
			from pg_inherits
			join pg_class as parent on parent.oid = pg_inherits.inhparent
			join pg_class as child on child.oid = pg_inherits.inhrelid
			where parent.relname in ('call_legs', 'call_events')
				and pg_get_expr(child.relpartbound, child.oid) = 'DEFAULT'
			order by child.relname
		`)) as { name: string }[];

		expect(rows.map((row) => row.name).sort()).toEqual(
			[defaultPartitionName("call_events"), defaultPartitionName("call_legs")].sort(),
		);
	});

	it("routes rows of different months into different partitions", async () => {
		const august = makeCallLegFixture(organizationId, new Date("2031-08-15T12:00:00Z"));
		const september = makeCallLegFixture(organizationId, new Date("2031-09-15T12:00:00Z"));
		await ensureMonthlyPartitions(database.db, {
			from: new Date("2031-08-01T00:00:00Z"),
			monthCount: 2,
		});

		await database.db.execute(insertCallLegQuery(august));
		await database.db.execute(insertCallLegQuery(september));

		const rows = (await database.db.execute(sql`
			select "id", tableoid::regclass::text as partition
			from "call_legs"
			where "organization_id" = ${organizationId}::uuid
				and "id" in (${august.id}::uuid, ${september.id}::uuid)
		`)) as { id: string; partition: string }[];
		const byId = new Map(rows.map((row) => [row.id, row.partition]));

		expect(byId.get(august.id)).toBe("call_legs_2031_08");
		expect(byId.get(september.id)).toBe("call_legs_2031_09");

		await database.db.execute(sql`drop table if exists "call_legs_2031_08"`);
		await database.db.execute(sql`drop table if exists "call_legs_2031_09"`);
		await database.db.execute(sql`drop table if exists "call_events_2031_08"`);
		await database.db.execute(sql`drop table if exists "call_events_2031_09"`);
	});

	it("sends a row with no matching partition to the default partition", async () => {
		const orphan = makeCallLegFixture(organizationId, new Date("1999-12-31T23:00:00Z"));

		await database.db.execute(insertCallLegQuery(orphan));

		const rows = (await database.db.execute(sql`
			select tableoid::regclass::text as partition from "call_legs" where "id" = ${orphan.id}::uuid
		`)) as { partition: string }[];

		expect(rows[0]?.partition).toBe("call_legs_default");
	});

	it("creates a missing partition on demand and is idempotent on a second call", async () => {
		const first = await createMonthlyPartition(database.db, "call_legs", futureMonth);
		const second = await createMonthlyPartition(database.db, "call_legs", futureMonth);

		expect(first).toBe("call_legs_2031_07");
		expect(second).toBe(first);

		const bounds = (await database.db.execute(sql`
			select pg_get_expr(child.relpartbound, child.oid) as bound
			from pg_class as child
			where child.relname = ${first}
		`)) as { bound: string }[];

		expect(bounds[0]?.bound).toContain("2031-07-01");
		expect(bounds[0]?.bound).toContain("2031-08-01");
	});

	it("ensures a horizon across both ledgers in one call", async () => {
		const created = await ensureMonthlyPartitions(database.db, {
			from: new Date("2031-07-01T00:00:00Z"),
			monthCount: 2,
		});

		expect(created).toEqual([
			"call_legs_2031_07",
			"call_legs_2031_08",
			"call_events_2031_07",
			"call_events_2031_08",
		]);

		await database.db.execute(sql`drop table if exists "call_legs_2031_08"`);
		await database.db.execute(sql`drop table if exists "call_events_2031_07"`);
		await database.db.execute(sql`drop table if exists "call_events_2031_08"`);
	});

	it("refuses to build a partition for a table outside the allow-list", async () => {
		const failure = await captureDatabaseError(() =>
			database.db.execute(
				sql`select ${sql.raw(CDR_ENSURE_PARTITION_FUNCTION)}('recordings', '2031-01-01'::date)`,
			),
		);

		expect(failure).toMatch(/not a partitioned CDR table/i);
	});

	it("refuses to drop partitions of a table outside the allow-list", async () => {
		const failure = await captureDatabaseError(() =>
			database.db.execute(
				sql`select ${sql.raw(CDR_DROP_PARTITIONS_FUNCTION)}('pg_class', '2031-01-01'::date)`,
			),
		);

		expect(failure).toMatch(/not a partitioned CDR table/i);
	});
});

describe.skipIf(!CDR_INTEGRATION_TESTS_ENABLED)("cdr retention", () => {
	const organizationId = createEntityId();
	const archiveMonth = new Date("2019-03-14T00:00:00Z");
	const expiringRecordingId = createEntityId();
	const keptRecordingId = createEntityId();
	let database: CdrIntegrationDatabase;

	beforeAll(async () => {
		database = createCdrIntegrationDatabase();
		await createMonthlyPartition(database.db, "call_legs", archiveMonth);
		await database.db.execute(
			insertCallLegQuery(makeCallLegFixture(organizationId, archiveMonth), {
				recordingKey: `${organizationId}/archive.wav`,
			}),
		);
	});

	afterAll(async () => {
		await database.db.execute(deleteOrganizationRowsQuery([organizationId]));
		await database.db.execute(sql`drop table if exists "call_legs_2019_03"`);
		await database.close();
	});

	it("drops only fully-expired partitions and never the default one", async () => {
		const dropped = await dropPartitionsBefore(
			database.db,
			"call_legs",
			new Date("2020-01-01T00:00:00Z"),
		);

		expect(dropped).toContain("call_legs_2019_03");

		const survivors = (await database.db.execute(sql`
			select child.relname as name
			from pg_inherits
			join pg_class as parent on parent.oid = pg_inherits.inhparent
			join pg_class as child on child.oid = pg_inherits.inhrelid
			where parent.relname = 'call_legs'
		`)) as { name: string }[];
		const names = survivors.map((row) => row.name);

		expect(names).toContain("call_legs_default");
		expect(names).not.toContain("call_legs_2019_03");
		// The current month must survive a retention sweep of an older cutoff.
		expect(names).toContain(monthlyPartitionName("call_legs", new Date()));
	});

	it("is a no-op when nothing has expired", async () => {
		const dropped = await dropPartitionsBefore(
			database.db,
			"call_legs",
			new Date("2020-01-01T00:00:00Z"),
		);

		expect(dropped).toEqual([]);
	});

	it("expires recordings past their retention date and leaves the rest alone", async () => {
		const expiring = expiringRecordingId;
		const keeping = keptRecordingId;
		await database.db.execute(sql`
			insert into "recordings" ("id", "organization_id", "kind", "object_key", "retention_until")
			values
				(${expiring}::uuid, ${organizationId}::uuid, 'call', ${`${organizationId}/expiring.wav`},
					now() - interval '1 day'),
				(${keeping}::uuid, ${organizationId}::uuid, 'voicemail', ${`${organizationId}/keeping.wav`},
					now() + interval '365 days')
		`);

		const worklist = (await database.db.execute(expiredRecordingsSelectQuery(new Date(), 10))) as {
			id: string;
		}[];
		expect(worklist.map((row) => row.id)).toContain(expiring);
		expect(worklist.map((row) => row.id)).not.toContain(keeping);

		const expired = (await database.db.execute(expiredRecordingsUpdateQuery(new Date()))) as {
			id: string;
			object_key: string;
		}[];
		expect(expired.map((row) => row.id)).toContain(expiring);

		const rows = (await database.db.execute(sql`
			select "id", "deleted_at" from "recordings" where "organization_id" = ${organizationId}::uuid
			order by "id"
		`)) as { id: string; deleted_at: Date | null }[];
		const tombstoned = rows.find((row) => row.id === expiring);
		const survivor = rows.find((row) => row.id === keeping);

		expect(tombstoned?.deleted_at).not.toBeNull();
		expect(survivor?.deleted_at).toBeNull();
	});

	it("removes tombstones only once the object purge window has passed", async () => {
		const stillFresh = (await database.db.execute(
			purgedRecordingTombstoneDeleteQuery(new Date("2000-01-01T00:00:00Z")),
		)) as { id: string }[];
		expect(stillFresh).toHaveLength(0);

		const removed = (await database.db.execute(
			purgedRecordingTombstoneDeleteQuery(new Date(Date.now() + 60_000)),
		)) as { id: string }[];
		expect(removed.map((row) => row.id)).toContain(expiringRecordingId);
	});
});
