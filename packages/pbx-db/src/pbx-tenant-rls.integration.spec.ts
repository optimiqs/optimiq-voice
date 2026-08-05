import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { runTenantRlsPreflight } from "@optimiq-voice/db";
import { createEntityId } from "@optimiq-voice/identifiers";
import { createPbxDatabaseClient, type PbxDatabaseClient } from "./client";
import { createPbxTenantRlsIntrospector, PBX_TENANT_RLS_PLAN } from "./rls-preflight-plan";
import { extension } from "./schema/extensions-schema";
import { ivrMenu } from "./schema/ivr-schema";
import { phoneNumber } from "./schema/numbers-schema";
import { auditLog } from "./schema/security-schema";

/**
 * Proves tenant isolation against a live PostgreSQL, which is the only place it can be proven:
 * every guarantee here is enforced by the server (policies, grants), not by application code.
 *
 * Gated on RUN_DB_INTEGRATION_TESTS and run with `--max-concurrency 1` — it drops into a role and
 * writes real rows.
 */
const databaseUrl = process.env.PBX_DATABASE_MIGRATION_URL ?? process.env.PBX_DATABASE_URL;
const enabled = process.env.RUN_DB_INTEGRATION_TESTS === "true" && Boolean(databaseUrl);

const ORGANIZATION_A = createEntityId();
const ORGANIZATION_B = createEntityId();
const ORGANIZATIONS = [ORGANIZATION_A, ORGANIZATION_B];

/** PostgreSQL SQLSTATE for `permission denied` and for an RLS `WITH CHECK` violation. */
const INSUFFICIENT_PRIVILEGE = "42501";
/** PostgreSQL SQLSTATE for a violated CHECK constraint. */
const CHECK_VIOLATION = "23514";

interface PostgresFailure {
	readonly code?: string;
	readonly constraint_name?: string;
	readonly message?: string;
}

/**
 * Drizzle wraps driver failures in `DrizzleQueryError`, so the SQLSTATE the server actually
 * returned lives on `cause`. Unwrapping it here keeps every assertion about *PostgreSQL's*
 * verdict rather than about Drizzle's wrapper.
 */
async function capturePostgresFailure(work: Promise<unknown>): Promise<PostgresFailure> {
	try {
		await work;
	} catch (error) {
		const cause = (error as { cause?: unknown }).cause ?? error;
		return cause as PostgresFailure;
	}
	throw new Error("Expected the statement to be rejected by PostgreSQL, but it succeeded.");
}

function seedFor(organizationId: string, suffix: string) {
	return {
		extension: {
			organizationId,
			number: `10${suffix}`,
			label: `Extension ${suffix}`,
			sipSecretRef: `secret/${suffix}`,
		},
		ivrMenu: { organizationId, name: `Main menu ${suffix}` },
		phoneNumber: {
			organizationId,
			e164: `+1555000${suffix}`,
			destinationType: "hangup" as const,
		},
		auditLog: {
			organizationId,
			action: "extension.create",
			resourceType: "extension",
		},
	};
}

describe.skipIf(!enabled)("pbx tenant row-level security", () => {
	let client: PbxDatabaseClient;

	beforeAll(async () => {
		client = createPbxDatabaseClient({
			url: databaseUrl ?? "",
			applicationName: "optimiq-voice-pbx-rls-spec",
			maxConnections: 4,
		});
		const seedA = seedFor(ORGANIZATION_A, "01");
		const seedB = seedFor(ORGANIZATION_B, "02");
		await client.adminDb.insert(extension).values([seedA.extension, seedB.extension]);
		await client.adminDb.insert(ivrMenu).values([seedA.ivrMenu, seedB.ivrMenu]);
		await client.adminDb.insert(phoneNumber).values([seedA.phoneNumber, seedB.phoneNumber]);
		await client.adminDb.insert(auditLog).values([seedA.auditLog, seedB.auditLog]);
	});

	afterAll(async () => {
		if (!client) {
			return;
		}
		for (const table of [extension, ivrMenu, phoneNumber, auditLog]) {
			await client.adminDb.delete(table).where(inArray(table.organizationId, ORGANIZATIONS));
		}
		await client.close();
	});

	it("passes the boot-time preflight against the live database", async () => {
		const preflight = await runTenantRlsPreflight(
			PBX_TENANT_RLS_PLAN,
			createPbxTenantRlsIntrospector(databaseUrl ?? ""),
		);
		expect(preflight.errors).toEqual([]);
		expect(preflight.ok).toBe(true);
		expect(preflight.tables).toHaveLength(PBX_TENANT_RLS_PLAN.expectations.length);
	});

	it("drops into the tenant role for the duration of the transaction only", async () => {
		const inside = await client.withTenantScope(ORGANIZATION_A, async (transaction) => {
			const rows = await transaction.execute<{ role: string; organization: string }>(
				sql`select current_user as role, current_setting('pbx_tenant_tls.organization_id', true) as organization`,
			);
			return rows[0];
		});
		expect(inside?.role).toBe("pbx_tenant_tls");
		expect(inside?.organization).toBe(ORGANIZATION_A);

		const outside = await client.adminDb.execute<{ role: string }>(
			sql`select current_user as role`,
		);
		expect(outside[0]?.role).not.toBe("pbx_tenant_tls");
	});

	// (a) cross-tenant reads are impossible on representative tables from three domains:
	// inventory (extension), numbering (phone_number) and call features (ivr_menu).
	it("hides other organizations' rows from the tenant role", async () => {
		const visible = await client.withTenantScope(ORGANIZATION_A, async (transaction) => ({
			extensions: await transaction.select().from(extension),
			phoneNumbers: await transaction.select().from(phoneNumber),
			ivrMenus: await transaction.select().from(ivrMenu),
			auditLogs: await transaction.select().from(auditLog),
		}));

		for (const [name, rows] of Object.entries(visible)) {
			expect(rows.length, `${name} should be visible`).toBeGreaterThan(0);
			for (const row of rows) {
				expect(row.organizationId, `${name} leaked a row`).toBe(ORGANIZATION_A);
			}
		}
	});

	it("cannot reach another organization's row even by primary key", async () => {
		const [foreign] = await client.adminDb
			.select()
			.from(extension)
			.where(eq(extension.organizationId, ORGANIZATION_B));
		expect(foreign).toBeDefined();

		const rows = await client.withTenantScope(
			ORGANIZATION_A,
			async (transaction) =>
				await transaction
					.select()
					.from(extension)
					.where(eq(extension.id, foreign?.id ?? "")),
		);
		expect(rows).toEqual([]);
	});

	it("cannot update or delete another organization's row", async () => {
		const [foreign] = await client.adminDb
			.select()
			.from(phoneNumber)
			.where(eq(phoneNumber.organizationId, ORGANIZATION_B));

		const result = await client.withTenantScope(ORGANIZATION_A, async (transaction) => ({
			updated: await transaction
				.update(phoneNumber)
				.set({ label: "hijacked" })
				.where(eq(phoneNumber.id, foreign?.id ?? ""))
				.returning(),
			deleted: await transaction
				.delete(ivrMenu)
				.where(eq(ivrMenu.organizationId, ORGANIZATION_B))
				.returning(),
		}));
		expect(result.updated).toEqual([]);
		expect(result.deleted).toEqual([]);

		const survivors = await client.adminDb
			.select()
			.from(ivrMenu)
			.where(eq(ivrMenu.organizationId, ORGANIZATION_B));
		expect(survivors).toHaveLength(1);
	});

	it("refuses to insert a row belonging to another organization", async () => {
		const failure = await capturePostgresFailure(
			client.withTenantScope(
				ORGANIZATION_A,
				async (transaction) =>
					await transaction.insert(extension).values({
						organizationId: ORGANIZATION_B,
						number: "1099",
						label: "Smuggled",
						sipSecretRef: "secret/1099",
					}),
			),
		);
		expect(failure.code).toBe(INSUFFICIENT_PRIVILEGE);
		expect(failure.message).toContain("row-level security policy");
	});

	// (c) the audit ledger is append-only: the tenant role holds SELECT + INSERT and nothing else,
	// so UPDATE and DELETE fail on privileges before RLS is even consulted.
	it("accepts inserts into the audit ledger", async () => {
		const inserted = await client.withTenantScope(
			ORGANIZATION_A,
			async (transaction) =>
				await transaction
					.insert(auditLog)
					.values({
						organizationId: ORGANIZATION_A,
						action: "extension.update",
						resourceType: "extension",
						after: { label: "changed" },
					})
					.returning(),
		);
		expect(inserted).toHaveLength(1);
	});

	it("rejects UPDATE on the audit ledger under the tenant role", async () => {
		const failure = await capturePostgresFailure(
			client.withTenantScope(
				ORGANIZATION_A,
				async (transaction) =>
					await transaction
						.update(auditLog)
						.set({ action: "rewritten" })
						.where(eq(auditLog.organizationId, ORGANIZATION_A)),
			),
		);
		expect(failure.code).toBe(INSUFFICIENT_PRIVILEGE);
		expect(failure.message).toContain("audit_log");
	});

	it("rejects DELETE on the audit ledger under the tenant role", async () => {
		const failure = await capturePostgresFailure(
			client.withTenantScope(
				ORGANIZATION_A,
				async (transaction) =>
					await transaction
						.delete(auditLog)
						.where(
							and(
								eq(auditLog.organizationId, ORGANIZATION_A),
								eq(auditLog.resourceType, "extension"),
							),
						),
			),
		);
		expect(failure.code).toBe(INSUFFICIENT_PRIVILEGE);
		expect(failure.message).toContain("audit_log");
	});

	it("rejects an empty organization id before it reaches the database", async () => {
		const attempt = client.withTenantScope("   ", async () => "unreachable");
		await expect(attempt).rejects.toMatchObject({ _tag: "TenantDatabaseScopeError" });
	});

	it("enforces the destination shape check inside a tenant transaction", async () => {
		const failure = await capturePostgresFailure(
			client.withTenantScope(
				ORGANIZATION_A,
				async (transaction) =>
					await transaction.insert(phoneNumber).values({
						organizationId: ORGANIZATION_A,
						e164: "+15550009999",
						// `ivr` is entity-backed and requires destination_ref.
						destinationType: "ivr",
					}),
			),
		);
		expect(failure.code).toBe(CHECK_VIOLATION);
		expect(failure.constraint_name).toBe("phone_number_destination_shape_check");
	});
});
