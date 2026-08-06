import {
	cdrTenantRlsPreflightPlan,
	createCdrTenantRlsIntrospector,
	resolveCdrDatabaseUrl,
} from "@optimiq-voice/cdr-db";
import { assertTenantRlsPreflight } from "@optimiq-voice/db";
import { getLogger } from "@optimiq-voice/logger";
import { isCdrSliceConfigured } from "./shared/cdr-env";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

export { isCdrSliceConfigured as isCdrAreaEnabled };

/**
 * Asserts the CDR database's tenant contract before the process accepts traffic.
 *
 * The same gate `main.ts` already runs for the auth database, pointed at the third bounded context.
 * It matters more here, not less: `call_legs` is append-only BY PRIVILEGE — the tenant role holds
 * no UPDATE or DELETE at all — and that is the property that makes "a compromised reporting path
 * cannot rewrite billing history" a fact rather than an intention. A grant that silently drifted
 * looks exactly like one that is correct until the day it does not, and boot is the last moment a
 * misconfiguration can be turned into a refusal to start rather than into a liability.
 *
 * Returns false without throwing when the area is not configured, so an environment with no
 * `CDR_DATABASE_URL` boots everything that came before it untouched.
 */
export async function assertCdrPreflight(): Promise<boolean> {
	if (!isCdrSliceConfigured()) {
		return false;
	}
	const url = resolveCdrDatabaseUrl();
	if (url === undefined) {
		return false;
	}
	const preflight = await assertTenantRlsPreflight(
		cdrTenantRlsPreflightPlan,
		createCdrTenantRlsIntrospector(url),
	);
	logger.info("CDR tenant RLS preflight passed", {
		role: cdrTenantRlsPreflightPlan.roleName,
		tables: preflight.tables.length,
	});
	return true;
}
