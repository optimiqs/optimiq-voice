-- Privileges for the telephony tenant role — identity-removal Step 5 item 2.
--
-- `api_tenant_tls` and its policies are created by `…_api_tenant_rls` (drizzle-kit manages roles
-- and policies for this database from `src/core/db/schema.ts`), but privileges cannot be
-- expressed in a Drizzle schema, so they live here — the same split `packages/pbx-db` uses.
--
-- The role is NOINHERIT: `set local role api_tenant_tls` drops every privilege the connecting
-- principal holds, so the grants below are the COMPLETE list of what a tenant transaction can do.
-- The row-level-security policies then narrow each grant to a single organization.
--
-- `products` is deliberately absent. It is a platform-global catalogue seeded at boot by the
-- owning principal and carries no `organization_id`; a tenant transaction never reads it (the
-- application read path joins services, not products), so it gets no grant and no policy.
--
-- Adding a tenant-scoped table to the schema therefore requires a new grants migration as well;
-- `API_TENANT_RLS_PLAN` and the boot preflight fail when one is missing.

GRANT USAGE ON SCHEMA "public" TO "api_tenant_tls";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
	"applications",
	"intelligence_services",
	"secrets",
	"stt_services",
	"tts_services"
TO "api_tenant_tls";
--> statement-breakpoint
-- Let the migration principal assume the role so preflight, the verification script and the
-- runtime pool can `set local role`. Every runtime principal needs its own
-- `GRANT "api_tenant_tls" TO <role>` when it is not the migration principal.
DO $$
BEGIN
	EXECUTE format('GRANT %I TO %I', 'api_tenant_tls', current_user);
END
$$;
