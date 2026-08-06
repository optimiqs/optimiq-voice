-- Privileges for the projection outbox.
--
-- Separate from the CREATE TABLE for the reason the baseline's grants migration gives: privileges
-- cannot be expressed in the Drizzle schema, so drizzle-kit will never generate them, and
-- `tenant-grants.spec.ts` fails the build when a table in the plan has no GRANT.
--
-- Full CRUD rather than SELECT/INSERT: a tenant transaction inserts the obligation with the write,
-- and the fast-path publish immediately UPDATEs `published_at` on the row it just made. DELETE is
-- the retention sweep, which runs on the untenanted handle but is granted here so a tenant-scoped
-- repair can prune its own rows without a privilege escalation.

GRANT SELECT, INSERT, UPDATE, DELETE ON
	"pbx_projection_outbox"
TO "pbx_tenant_tls";
