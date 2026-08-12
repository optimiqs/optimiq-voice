-- Privileges for the paging groups and their membership.
--
-- Separate from the CREATE TABLE for the reason the baseline's grants migration gives: privileges
-- cannot be expressed in the Drizzle schema, so drizzle-kit will never generate them, and
-- `tenant-grants.spec.ts` fails the build when a table in the plan has no GRANT.
--
-- The full set on both tables. A paging group is CONFIGURATION an administrator creates, renames
-- and deletes, and its membership is edited every time somebody changes desk — the two append-only
-- tables in this database are the LEDGERS (`audit_log`, `sip_auth_event`), and neither of these is
-- a record of something that happened.

GRANT SELECT, INSERT, UPDATE, DELETE ON
	"paging_group",
	"paging_group_member"
TO "pbx_tenant_tls";
