-- Privileges for the authentication-failure ledger.
--
-- Separate from the CREATE TABLE for the reason the baseline's grants migration gives: privileges
-- cannot be expressed in the Drizzle schema, so drizzle-kit will never generate them, and
-- `tenant-grants.spec.ts` fails the build when a table in the plan has no GRANT.
--
-- SELECT and INSERT only, alongside `audit_log`. The table is append-only in the database itself:
-- there is no UPDATE or DELETE privilege to revoke, so no bug and no compromised runtime principal
-- can rewrite the record of who was refused and from where. That is the whole value of a security
-- log, and it is why the retention sweep this table will eventually need must run on the OWNER
-- handle rather than being bought with a DELETE grant here.

GRANT SELECT, INSERT ON
	"sip_auth_event"
TO "pbx_tenant_tls";
