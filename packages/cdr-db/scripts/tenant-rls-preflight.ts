import { assertTenantRlsPreflight, MigrationTargetError } from "@optimiq-voice/db";
import { createCdrTenantRlsIntrospector } from "../src/rls-introspector";
import { cdrTenantRlsPreflightPlan } from "../src/rls-preflight-plan";

/**
 * Standalone CDR RLS preflight, for CI and for a deploy gate.
 *
 * `apps/api` and `apps/engine` call `assertTenantRlsPreflight(cdrTenantRlsPreflightPlan, …)` from
 * `main.ts` before `NestFactory.create`; this script is the same assertion run on demand against
 * the RUNTIME principal (not the migration owner) so a broken grant is caught before rollout.
 */
async function main(): Promise<void> {
	const url = process.env.CDR_DATABASE_URL ?? process.env.CDR_DATABASE_MIGRATION_URL;
	if (!url) {
		throw new MigrationTargetError(
			"CDR_DATABASE_URL (runtime principal, preferred) or CDR_DATABASE_MIGRATION_URL must be set.",
		);
	}
	const preflight = await assertTenantRlsPreflight(
		cdrTenantRlsPreflightPlan,
		createCdrTenantRlsIntrospector(url),
	);
	process.stdout.write(
		`${JSON.stringify({
			event: "cdr_tenant_rls_preflight_ok",
			role: cdrTenantRlsPreflightPlan.roleName,
			tables: preflight.tables.map((table) => table.table),
		})}\n`,
	);
}

await main();
