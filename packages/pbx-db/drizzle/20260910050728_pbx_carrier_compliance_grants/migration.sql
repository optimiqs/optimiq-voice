-- Privileges for the carrier-compliance tables.
--
-- Separate from the CREATE TABLE for the reason the baseline's grants migration gives: privileges
-- cannot be expressed in the Drizzle schema, so drizzle-kit will never generate them, and
-- `tenant-grants.spec.ts` fails the build when a table in the plan has no GRANT.
--
-- Both take the full CRUD set rather than the append-only pair a ledger takes. A KYC file is
-- amended — a tenant corrects an address, a reviewer writes a decision onto the same row — and a
-- verified caller id is revoked by deleting the evidence row, which is what makes the number stop
-- attesting B on the next compile. The record of what changed is the audit log's job, not this
-- table's; that is exactly the division `webhook_subscription` already uses.
GRANT SELECT, INSERT, UPDATE, DELETE ON
	"organization_kyc",
	"verified_caller_id"
TO "pbx_tenant_tls";
