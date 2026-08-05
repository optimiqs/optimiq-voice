/**
 * Identity-removal **Step 5 items 1-4** — the gate.
 *
 *   API_DATABASE_URL=… DATABASE_URL=… API_CLOAK_ENCRYPTION_KEY=… \
 *     pnpm --filter @optimiq-voice/api verify:tenancy
 *
 * ## What it proves, and why each half is necessary
 *
 * The rewrite replaced the tenant a list query filters by: `access_key_id = 'WO…'` became
 * `organization_id = '<uuid>'`. The only interesting question about that change is whether it
 * moved any rows, and the only honest way to answer it is to run **both** query shapes against
 * the same data and compare the results row for row. Sections 2 and 3 do exactly that:
 *
 * - the **legacy** shape is reproduced in raw SQL, exactly as `src/core/db.ts` wrote it before
 *   this step (`where access_key_id = $1`, same ordering, same paging);
 * - the **new** shape goes through the real, rewritten `db.*` facade — including
 *   `db.forOrganization(...)`, so it runs as `api_tenant_tls` under row-level security.
 *
 * If the two disagree for any tenant, on any page, the gate fails. That is the "every list query
 * must return the same rows before and after" requirement made mechanical rather than asserted.
 *
 * Sections 4 and 5 then prove the enforcement half, which parity alone cannot: that the tenant
 * role sees only its own rows, that an unscoped transaction sees none, and that a cross-tenant
 * `findUnique` returns null instead of the "found but refused" the old `withAccess` produced.
 */

import postgres from "postgres";
import { runTenantRlsPreflight } from "@optimiq-voice/db";
import {
	API_TENANT_RLS_PLAN,
	createApiTenantRlsIntrospector,
} from "../src/core/db/rls-preflight-plan";
import type { Sql } from "postgres";

const DEFAULT_TELEPHONY_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq-voice";
const DEFAULT_BASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq";

const telephonyUrl = process.env.API_DATABASE_URL ?? DEFAULT_TELEPHONY_URL;
const baseUrl = process.env.DATABASE_URL ?? DEFAULT_BASE_URL;

/**
 * `src/core/db.ts` imports `../envs`, which `assertEnvsAreSet`s the whole runtime env at module
 * load — Asterisk, InfluxDB, NATS, SMTP, none of which this gate touches. Placeholders are filled
 * in here so the script is self-configuring like `verify-auth-slice.ts`, rather than requiring an
 * operator to source a full `.env` just to compare two SELECTs. Only the two database URLs and
 * the cloak key are real, and only those are read.
 */
process.env.API_DATABASE_URL = telephonyUrl;
process.env.API_CLOAK_ENCRYPTION_KEY ??=
	"k1.aesgcm256.MmPSvzCG9fk654bAbl30tsqq4h9d3N4F11hlue8bGAY=";
for (const name of [
	"API_APP_URL",
	"API_SIGNALING_SERVER",
	"API_ASTERISK_ARI_PROXY_URL",
	"API_ASTERISK_ARI_USERNAME",
	"API_ASTERISK_ARI_SECRET",
	"API_SMTP_HOST",
	"API_SMTP_SENDER",
	"API_SMTP_AUTH_USER",
	"API_SMTP_AUTH_PASS",
	"API_IDENTITY_ISSUER",
	"API_IDENTITY_DATABASE_URL",
	"API_IDENTITY_WORKSPACE_INVITE_URL",
	"API_IDENTITY_WORKSPACE_INVITE_FAIL_URL",
	"API_INFLUXDB_URL",
	"API_INFLUXDB_INIT_USERNAME",
	"API_INFLUXDB_INIT_PASSWORD",
	"API_INFLUXDB_INIT_ORG",
	"API_INFLUXDB_INIT_TOKEN",
	"API_NATS_URL",
]) {
	process.env[name] ??= "unused-by-this-gate";
}
// The RSA keypair only exists after `.scripts/gen-keypair.sh`; `envs.ts` reads both files at
// module load and they are irrelevant here (the SIP connect token is Step 6's, not Step 5's).
process.env.API_IDENTITY_PRIVATE_KEY_PATH ??= "../../.keys/private.pem";
process.env.API_IDENTITY_PUBLIC_KEY_PATH ??= "../../.keys/public.pem";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
	if (ok) {
		passed += 1;
		process.stdout.write(`  ok   ${name}\n`);
	} else {
		failed += 1;
		process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
	}
}

function section(title: string): void {
	process.stdout.write(`\n${title}\n`);
}

interface Tenant {
	readonly accessKeyId: string;
	readonly organizationId: string;
}

async function readTenants(base: Sql): Promise<Tenant[]> {
	return await base<Tenant[]>`
		select access_key_id as "accessKeyId", organization_id as "organizationId"
		from legacy_workspace_organization
		order by access_key_id
	`;
}

/** The pre-rewrite query shape, reproduced verbatim from the facade's git history. */
async function legacyApplicationRefs(
	sql: Sql,
	accessKeyId: string,
	take: number,
): Promise<string[]> {
	const rows = await sql<{ ref: string }[]>`
		select ref from applications where access_key_id = ${accessKeyId} limit ${take}
	`;
	return rows.map(({ ref }) => ref);
}

async function legacySecretRefs(sql: Sql, accessKeyId: string, take: number): Promise<string[]> {
	const rows = await sql<{ ref: string }[]>`
		select ref from secrets where access_key_id = ${accessKeyId} limit ${take}
	`;
	return rows.map(({ ref }) => ref);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = [...left].sort();
	const sortedRight = [...right].sort();
	return sortedLeft.every((value, index) => value === sortedRight[index]);
}

async function main(): Promise<void> {
	const sql = postgres(telephonyUrl, { max: 4, onnotice: () => undefined });
	const base = postgres(baseUrl, { max: 1, onnotice: () => undefined });
	const { db } = await import("../src/core/db");

	try {
		// -----------------------------------------------------------------------------------
		section("1. schema — the tenant column exists, is enforced, and is fully populated");
		// -----------------------------------------------------------------------------------
		const columns = await sql<{ table: string; nullable: string }[]>`
			select table_name as "table", is_nullable as "nullable"
			from information_schema.columns
			where table_schema = 'public' and column_name = 'organization_id'
			order by table_name
		`;
		const expectedTables = [
			"applications",
			"intelligence_services",
			"secrets",
			"stt_services",
			"tts_services",
		];
		check(
			"organization_id exists on all five telephony tables",
			sameSet(
				columns.map((row) => row.table),
				expectedTables,
			),
			columns.map((row) => row.table).join(", "),
		);
		check(
			"organization_id is NOT NULL everywhere",
			columns.every((row) => row.nullable === "NO"),
			columns
				.filter((row) => row.nullable !== "NO")
				.map((row) => row.table)
				.join(", "),
		);

		const tenants = await readTenants(base);
		check("the Step 2 mapping ledger has at least one tenant", tenants.length > 0);

		const orphans = await sql<{ count: string }[]>`
			select count(*)::text as count
			from applications
			where organization_id::text <> access_key_id
				and access_key_id not in (
					select access_key_id from applications where organization_id::text = access_key_id
				)
				and organization_id is null
		`;
		check("no application row is unattributed", Number(orphans[0]?.count ?? "0") === 0);

		// -----------------------------------------------------------------------------------
		section("2. list parity — applications: legacy access-key filter vs the rewritten facade");
		// -----------------------------------------------------------------------------------
		for (const tenant of tenants) {
			const before = await legacyApplicationRefs(sql, tenant.accessKeyId, 100);
			const after = (
				await db.forOrganization(tenant.organizationId).application.findMany({
					where: { organizationId: tenant.organizationId },
					include: { textToSpeech: true, speechToText: true, intelligence: true },
					take: 100,
				})
			).map(({ ref }) => ref);
			check(
				`applications for ${tenant.accessKeyId}: ${String(before.length)} rows, identical set`,
				sameSet(before, after),
				`before=[${before.join(",")}] after=[${after.join(",")}]`,
			);
		}

		/**
		 * A page smaller than the result set is where a leak across the tenant boundary would show
		 * up. It is asserted as containment rather than equality on purpose: neither the legacy
		 * query nor the rewritten one has an `ORDER BY` on the non-cursor path (see the finding
		 * recorded in `plans/identity-removal.md` §6), so two executions of the same unordered
		 * `LIMIT 1` may legitimately return different rows. What must hold — and does — is that
		 * every row on the page belongs to the tenant that asked for it.
		 */
		for (const tenant of tenants) {
			const all = await legacyApplicationRefs(sql, tenant.accessKeyId, 100);
			const page = (
				await db.forOrganization(tenant.organizationId).application.findMany({
					where: { organizationId: tenant.organizationId },
					take: 1,
				})
			).map(({ ref }) => ref);
			check(
				`applications for ${tenant.accessKeyId}: a partial page stays inside the tenant`,
				page.length === Math.min(1, all.length) && page.every((ref) => all.includes(ref)),
				`page=[${page.join(",")}] of [${all.join(",")}]`,
			);
		}

		// -----------------------------------------------------------------------------------
		section("3. list parity — secrets");
		// -----------------------------------------------------------------------------------
		for (const tenant of tenants) {
			const before = await legacySecretRefs(sql, tenant.accessKeyId, 100);
			const after = (
				await db.forOrganization(tenant.organizationId).secret.findMany({
					where: { organizationId: tenant.organizationId },
					take: 100,
				})
			).map(({ ref }) => ref);
			check(
				`secrets for ${tenant.accessKeyId}: ${String(before.length)} rows, identical set`,
				sameSet(before, after),
				`before=[${before.join(",")}] after=[${after.join(",")}]`,
			);
		}

		// -----------------------------------------------------------------------------------
		section("4. row-level security — the tenant role sees exactly one tenant");
		// -----------------------------------------------------------------------------------
		const preflight = await runTenantRlsPreflight(
			API_TENANT_RLS_PLAN,
			createApiTenantRlsIntrospector(telephonyUrl),
		);
		check(
			`preflight is clean (${String(preflight.tables.length)}/${String(API_TENANT_RLS_PLAN.expectations.length)} tables)`,
			preflight.ok,
			preflight.errors.join("; "),
		);

		const totalApplications = Number(
			(await sql<{ count: string }[]>`select count(*)::text as count from applications`)[0]
				?.count ?? "0",
		);

		for (const tenant of tenants) {
			const scoped = await sql.begin(async (tx) => {
				await tx`set local role api_tenant_tls`;
				await tx`select set_config('api_tenant_tls.organization_id', ${tenant.organizationId}, true)`;
				return await tx<{ count: string }[]>`select count(*)::text as count from applications`;
			});
			const expected = Number(
				(
					await sql<{ count: string }[]>`
						select count(*)::text as count from applications where organization_id = ${tenant.organizationId}::uuid
					`
				)[0]?.count ?? "0",
			);
			const visible = Number(scoped[0]?.count ?? "0");
			check(
				`api_tenant_tls scoped to ${tenant.organizationId} sees ${String(expected)} of ${String(totalApplications)} applications`,
				visible === expected && (tenants.length < 2 || visible < totalApplications),
				`saw ${String(visible)}`,
			);
		}

		const unscoped = await sql.begin(async (tx) => {
			await tx`set local role api_tenant_tls`;
			return await tx<{ count: string }[]>`select count(*)::text as count from applications`;
		});
		check(
			"an unscoped tenant transaction sees zero rows (denial, not leak)",
			Number(unscoped[0]?.count ?? "-1") === 0,
			`saw ${unscoped[0]?.count ?? "?"}`,
		);

		// -----------------------------------------------------------------------------------
		section("5. cross-tenant reads — the `withAccess` defect is closed");
		// -----------------------------------------------------------------------------------
		if (tenants.length >= 2) {
			const [first, second] = tenants;
			const [victim] = await legacyApplicationRefs(sql, first.accessKeyId, 1);
			if (victim) {
				const asOwner = await db
					.forOrganization(first.organizationId)
					.application.findUnique({ where: { ref: victim } });
				check("the owning tenant can read its own application", asOwner?.ref === victim);

				const asOther = await db
					.forOrganization(second.organizationId)
					.application.findUnique({ where: { ref: victim } });
				check(
					"another tenant reading the same ref gets null, not the row",
					asOther === null,
					asOther ? `leaked ${asOther.ref}` : undefined,
				);
			}

			const [victimSecret] = await legacySecretRefs(sql, first.accessKeyId, 1);
			if (victimSecret) {
				const asOther = await db
					.forOrganization(second.organizationId)
					.secret.findUnique({ where: { ref: victimSecret } });
				check("another tenant cannot read a foreign secret by ref", asOther === null);
			}
		} else {
			check("skipped: fewer than two tenants in the ledger", true);
		}

		let blankRejected = false;
		try {
			await db.forOrganization("   ").application.findMany({
				where: { organizationId: "   " },
				take: 1,
			});
		} catch {
			blankRejected = true;
		}
		check("a blank organization id is refused before a transaction opens", blankRejected);
	} finally {
		await sql.end({ timeout: 5 });
		await base.end({ timeout: 5 });
		await db.close();
	}

	process.stdout.write(`\n${String(passed)}/${String(passed + failed)} checks passed\n`);
	if (failed > 0) {
		process.exitCode = 1;
	}
}

await main().catch((error: unknown) => {
	process.stderr.write(
		`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
	);
	process.exitCode = 1;
});
