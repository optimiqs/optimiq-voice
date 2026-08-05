import { createTenantDatabaseContext, type TenantDatabaseContext } from "@optimiq-voice/db";

/** Bounded-context name; drives the role `cdr_tenant_tls` and its `organization_id` setting. */
export const CDR_CONTEXT_NAME = "cdr";

/**
 * The CDR tenant role. Non-inheriting, so a runtime principal that `SET ROLE`s into it drops
 * every privilege it would otherwise carry and can only see rows the policies admit.
 *
 * Reporting reads and the engine's leg inserts both run under this role. Enrichment updates
 * (transcription, MOS, recording key) do NOT — see `withCdrWriterScope` in `writer.ts` for why.
 */
export const cdrTenantContext: TenantDatabaseContext =
	createTenantDatabaseContext(CDR_CONTEXT_NAME);

/**
 * Transaction-local marker the CDR writer publishes so owner-principal enrichment writes are
 * attributable in audit triggers and `pg_stat_activity`. It is NOT a security boundary — the
 * boundary is the mandatory `organization_id` predicate in `buildCallLegEnrichmentQuery`.
 */
export const CDR_WRITER_SETTING_NAME = "cdr_writer.organization_id";
