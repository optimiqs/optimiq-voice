import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { assertTenantRlsPreflight } from "@optimiq-voice/db";
import { createEntityId } from "@optimiq-voice/identifiers";
import { createCdrTenantRlsIntrospector } from "./rls-introspector";
import { cdrTenantRlsPreflightPlan } from "./rls-preflight-plan";
import {
	captureDatabaseError,
	CDR_INTEGRATION_TESTS_ENABLED,
	cdrIntegrationDatabaseUrl,
	createCdrIntegrationDatabase,
	deleteOrganizationRowsQuery,
	insertCallLegQuery,
	makeCallLegFixture,
	type CdrIntegrationDatabase,
} from "./testing/cdr-integration-database";
import { buildCallLegEnrichmentQuery, withCdrWriterScope } from "./writer";

/**
 * Live proof of the isolation and append-only contracts.
 *
 *   RUN_DB_INTEGRATION_TESTS=true CDR_DATABASE_URL=... bun test src --max-concurrency 1
 *
 * Requires the CDR journal to be applied (`pnpm --filter @optimiq-voice/cdr-db db:migrate`).
 */
describe.skipIf(!CDR_INTEGRATION_TESTS_ENABLED)("cdr tenant row-level security", () => {
	const organizationA = createEntityId();
	const organizationB = createEntityId();
	const startedAt = new Date();
	const legA = makeCallLegFixture(organizationA, startedAt);
	const legB = makeCallLegFixture(organizationB, startedAt);
	let database: CdrIntegrationDatabase;

	beforeAll(async () => {
		database = createCdrIntegrationDatabase();
		await database.db.execute(deleteOrganizationRowsQuery([organizationA, organizationB]));
		await database.db.execute(insertCallLegQuery(legA, { recordingKey: `${organizationA}/a.wav` }));
		await database.db.execute(insertCallLegQuery(legB));
	});

	afterAll(async () => {
		await database.db.execute(deleteOrganizationRowsQuery([organizationA, organizationB]));
		await database.close();
	});

	it("passes the boot-time preflight assertion", async () => {
		const preflight = await assertTenantRlsPreflight(
			cdrTenantRlsPreflightPlan,
			createCdrTenantRlsIntrospector(cdrIntegrationDatabaseUrl()),
		);

		expect(preflight.ok).toBe(true);
		expect(preflight.tables.map((table) => table.table)).toEqual([
			"call_events",
			"call_legs",
			"recordings",
		]);
	});

	it("shows a tenant only its own legs, through the partitioned parent", async () => {
		const rows = await database.asTenant(organizationA, async (execute) =>
			execute(sql`select "id", "organization_id" from "call_legs"`),
		);

		const ids = (rows as { id: string }[]).map((row) => row.id);
		expect(ids).toContain(legA.id);
		expect(ids).not.toContain(legB.id);
	});

	it("shows nothing at all when the transaction never published an organization", async () => {
		const rows = await database.asUnscopedTenant(async (execute) =>
			execute(sql`select "id" from "call_legs"`),
		);

		// The policy compares against NULL, so an unscoped transaction denies rather than leaks.
		expect(rows as unknown[]).toHaveLength(0);
	});

	it("refuses an insert that would write another organization's row", async () => {
		const rogue = makeCallLegFixture(organizationB, startedAt);

		const failure = await captureDatabaseError(() =>
			database.asTenant(organizationA, async (execute) => execute(insertCallLegQuery(rogue))),
		);

		expect(failure).toMatch(/row-level security/i);
	});

	it("accepts an insert scoped to the tenant's own organization", async () => {
		const own = makeCallLegFixture(organizationA, startedAt);

		await database.asTenant(organizationA, async (execute) => execute(insertCallLegQuery(own)));

		const rows = await database.asTenant(organizationA, async (execute) =>
			execute(sql`select "id" from "call_legs" where "id" = ${own.id}::uuid`),
		);
		expect(rows as unknown[]).toHaveLength(1);
	});

	it.each([
		["update", sql`update "call_legs" set "transcription_status" = 'completed'`],
		["delete", sql`delete from "call_legs"`],
	])("denies %s on call_legs by privilege, not merely by policy", async (_label, statement) => {
		const failure = await captureDatabaseError(() =>
			database.asTenant(organizationA, async (execute) => execute(statement)),
		);

		expect(failure).toMatch(/permission denied/i);
	});

	it.each([
		["update", sql`update "call_events" set "event" = 'hangup'`],
		["delete", sql`delete from "call_events"`],
	])("denies %s on call_events too", async (_label, statement) => {
		const failure = await captureDatabaseError(() =>
			database.asTenant(organizationA, async (execute) => execute(statement)),
		);

		expect(failure).toMatch(/permission denied/i);
	});

	it("blocks direct access to a partition, so the parent's policies cannot be bypassed", async () => {
		const failure = await captureDatabaseError(() =>
			database.asTenant(organizationA, async (execute) =>
				execute(sql`select count(*) from "call_legs_default"`),
			),
		);

		expect(failure).toMatch(/permission denied/i);
	});

	it("lets a tenant append and read its own call events", async () => {
		const eventId = createEntityId();

		await database.asTenant(organizationA, async (execute) =>
			execute(sql`
				insert into "call_events" ("id", "organization_id", "call_id", "leg_id", "event", "at")
				values (${eventId}::uuid, ${organizationA}::uuid, ${legA.callId}::uuid, ${legA.id}::uuid,
					'answered', ${startedAt.toISOString()}::timestamptz)
			`),
		);

		const mine = await database.asTenant(organizationA, async (execute) =>
			execute(sql`select "id" from "call_events" where "id" = ${eventId}::uuid`),
		);
		const theirs = await database.asTenant(organizationB, async (execute) =>
			execute(sql`select "id" from "call_events" where "id" = ${eventId}::uuid`),
		);

		expect(mine as unknown[]).toHaveLength(1);
		expect(theirs as unknown[]).toHaveLength(0);
	});

	it("gives recordings the full read-write lifecycle inside the tenant scope", async () => {
		const recordingId = createEntityId();
		const objectKey = `${organizationA}/${recordingId}.wav`;

		await database.asTenant(organizationA, async (execute) => {
			await execute(sql`
				insert into "recordings" ("id", "organization_id", "call_id", "kind", "object_key",
					"duration_ms", "size_bytes", "retention_until")
				values (${recordingId}::uuid, ${organizationA}::uuid, ${legA.callId}::uuid, 'call',
					${objectKey}, 12000, 96000, now() + interval '30 days')
			`);
			await execute(
				sql`update "recordings" set "duration_ms" = 13000 where "id" = ${recordingId}::uuid`,
			);
		});

		const theirs = await database.asTenant(organizationB, async (execute) =>
			execute(sql`select "id" from "recordings" where "id" = ${recordingId}::uuid`),
		);
		expect(theirs as unknown[]).toHaveLength(0);

		await database.asTenant(organizationA, async (execute) =>
			execute(sql`delete from "recordings" where "id" = ${recordingId}::uuid`),
		);
	});

	it("refuses to write a recording into another organization", async () => {
		const failure = await captureDatabaseError(() =>
			database.asTenant(organizationA, async (execute) =>
				execute(sql`
					insert into "recordings" ("id", "organization_id", "kind", "object_key")
					values (${createEntityId()}::uuid, ${organizationB}::uuid, 'call', ${createEntityId()})
				`),
			),
		);

		expect(failure).toMatch(/row-level security/i);
	});
});

describe.skipIf(!CDR_INTEGRATION_TESTS_ENABLED)("cdr writer enrichment path", () => {
	const organizationA = createEntityId();
	const organizationB = createEntityId();
	const startedAt = new Date();
	const legA = makeCallLegFixture(organizationA, startedAt);
	let database: CdrIntegrationDatabase;

	beforeAll(async () => {
		database = createCdrIntegrationDatabase();
		await database.db.execute(insertCallLegQuery(legA));
	});

	afterAll(async () => {
		await database.db.execute(deleteOrganizationRowsQuery([organizationA, organizationB]));
		await database.close();
	});

	it("lands late-arriving fields on the owning organization's leg", async () => {
		const updated = await withCdrWriterScope(
			{ transaction: async (work) => await database.db.transaction(work) },
			organizationA,
			async (transaction) =>
				await transaction.execute(
					buildCallLegEnrichmentQuery(
						{ organizationId: organizationA, callLegId: legA.id, startedAt },
						{ transcriptionStatus: "completed", mos: 4.31, recordingKey: "org/leg.wav" },
					),
				),
		);

		expect(updated as unknown[]).toHaveLength(1);

		const rows = await database.asTenant(organizationA, async (execute) =>
			execute(
				sql`select "transcription_status", "mos", "recording_key" from "call_legs" where "id" = ${legA.id}::uuid`,
			),
		);
		const row = (rows as { transcription_status: string; mos: string; recording_key: string }[])[0];
		expect(row?.transcription_status).toBe("completed");
		expect(Number(row?.mos)).toBeCloseTo(4.31, 2);
		expect(row?.recording_key).toBe("org/leg.wav");
	});

	it("updates nothing when the organization does not own the leg", async () => {
		const updated = await withCdrWriterScope(
			{ transaction: async (work) => await database.db.transaction(work) },
			organizationB,
			async (transaction) =>
				await transaction.execute(
					buildCallLegEnrichmentQuery(
						{ organizationId: organizationB, callLegId: legA.id, startedAt },
						{ transcriptionStatus: "failed" },
					),
				),
		);

		expect(updated as unknown[]).toHaveLength(0);
	});
});
