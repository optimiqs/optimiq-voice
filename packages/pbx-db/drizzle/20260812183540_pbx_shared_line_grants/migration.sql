-- Privileges for the shared lines and their appearances.
--
-- Separate from the CREATE TABLE for the reason the baseline's grants migration gives: privileges
-- cannot be expressed in the Drizzle schema, so drizzle-kit will never generate them, and
-- `tenant-grants.spec.ts` fails the build when a table in the plan has no GRANT. Both tables are
-- read-write configuration (an administrator edits a line's members and its recall timeout), so the
-- tenant role gets the full CRUD set — not the SELECT/INSERT of an append-only ledger.
GRANT SELECT, INSERT, UPDATE, DELETE ON
	"shared_line",
	"shared_line_appearance"
TO "pbx_tenant_tls";
