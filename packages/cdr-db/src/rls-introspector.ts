import { createPostgresTenantRlsIntrospector, type TenantRlsIntrospector } from "@optimiq-voice/db";

/**
 * PostgreSQL-backed introspector for the CDR database. Thin delegation to the shared
 * @optimiq-voice/db introspector (its empty-mode-bucket sentinel bug is fixed upstream), kept as
 * a named export so boot wiring stays stable if this context ever needs plan-specific
 * introspection again.
 */
export function createCdrTenantRlsIntrospector(databaseUrl: string): TenantRlsIntrospector {
	return createPostgresTenantRlsIntrospector(databaseUrl);
}
