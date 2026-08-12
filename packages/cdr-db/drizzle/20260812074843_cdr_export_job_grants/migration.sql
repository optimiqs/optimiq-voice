-- Privileges for the asynchronous CDR export jobs.
--
-- Separate from the CREATE TABLE for the reason the baseline's grants give: privileges cannot be
-- expressed in the Drizzle schema, so drizzle-kit will never generate them, and the boot preflight
-- (`cdrTenantRlsPreflightPlan`) refuses to start a process whose live catalogue disagrees with the
-- plan. A table added without its grant is a table the tenant role can see the policy on and not
-- the rows.
--
-- The FULL set, unlike `call_legs` and `call_events`. Those two are the LEDGERS of this database
-- and the tenant role deliberately holds no UPDATE or DELETE on them at all — that is the whole
-- append-only guarantee, and it is a privilege fact rather than a policy one so that no future
-- policy edit can undo it. An export job is not a record of something that happened; it is a
-- lifecycle. It is claimed (`status`, `claimed_at`), advanced (`attempts`), completed
-- (`object_key`, `row_count`, `size_bytes`, `completed_at`) and eventually purged, and every one
-- of those is an UPDATE somebody has to be able to make. `recordings` is the existing table with
-- the same shape and the same grant.
--
-- DELETE is included and it is the one worth naming. A tenant may remove an export they asked for
-- — a CSV of the organization's call history is a liability sitting outside the ledger's own access
-- controls, and "I have finished with this, take it away" is a request the product should be able
-- to honour without waiting for `expires_at`. The row and the object are removed together by the
-- API; the privilege is what makes the row half possible.

GRANT SELECT, INSERT, UPDATE, DELETE ON
	"cdr_export_job"
TO "cdr_tenant_tls";
