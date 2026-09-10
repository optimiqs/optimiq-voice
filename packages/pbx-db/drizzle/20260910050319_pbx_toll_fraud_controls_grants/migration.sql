-- Privileges for the toll-fraud control tables and the shared rate window.
--
-- Separate from the CREATE TABLE for the reason the baseline's grants migration gives: privileges
-- cannot be expressed in the Drizzle schema, so drizzle-kit will never generate them, and
-- `tenant-grants.spec.ts` fails the build when a table in the plan has no GRANT.
--
-- All four take the full CRUD set. `shared_rate_window` is the one worth justifying, because it
-- looks like a ledger and is not: a counter is UPDATEd on every increment (that is the whole point
-- of the upsert), and the expiry sweep DELETEs, so the two privileges an append-only ledger
-- withholds are exactly the two this table cannot work without.
GRANT SELECT, INSERT, UPDATE, DELETE ON
	"toll_fraud_policy",
	"extension_toll_fraud_override",
	"toll_fraud_country_seen",
	"shared_rate_window"
TO "pbx_tenant_tls";
