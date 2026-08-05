import { runTenantRlsPreflight } from "@optimiq-voice/db";
import { createPbxTenantRlsIntrospector, PBX_TENANT_RLS_PLAN } from "../src/rls-preflight-plan";

/**
 * Standalone preflight so CI (and a human debugging a deployment) can assert the live telephony
 * database matches the RLS contract without booting the API. `apps/api` runs the same plan through
 * `assertTenantRlsPreflight` before `NestFactory.create`.
 */
const url = process.env.PBX_DATABASE_MIGRATION_URL ?? process.env.PBX_DATABASE_URL;
if (!url) {
	process.stderr.write("PBX_DATABASE_MIGRATION_URL or PBX_DATABASE_URL must be set.\n");
	process.exit(1);
}

const preflight = await runTenantRlsPreflight(
	PBX_TENANT_RLS_PLAN,
	createPbxTenantRlsIntrospector(url),
);

process.stdout.write(
	`${JSON.stringify({
		event: "pbx_tenant_rls_preflight",
		ok: preflight.ok,
		role: PBX_TENANT_RLS_PLAN.roleName,
		tables: preflight.tables.length,
		errors: preflight.errors,
	})}\n`,
);

if (!preflight.ok) {
	process.exit(1);
}
