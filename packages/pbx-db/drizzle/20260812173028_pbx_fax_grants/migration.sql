-- Privileges for the fax servers and their message inbox/outbox.
--
-- Separate from the CREATE TABLE for the reason the baseline's grants migration gives: privileges
-- cannot be expressed in the Drizzle schema, so drizzle-kit will never generate them, and
-- `tenant-grants.spec.ts` fails the build when a table in the plan has no GRANT. Both tables are
-- read-write (the outbox is mutated as a fax walks queued -> sending -> delivered/failed, and inbox
-- rows are read and deleted by the tenant), so the tenant role gets the full CRUD set — not the
-- SELECT/INSERT of an append-only ledger.
GRANT SELECT, INSERT, UPDATE, DELETE ON
	"fax_server",
	"fax_message"
TO "pbx_tenant_tls";
