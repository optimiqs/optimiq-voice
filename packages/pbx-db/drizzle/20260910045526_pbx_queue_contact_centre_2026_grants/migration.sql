-- Privileges for the 2026 contact-centre tables.
--
-- Separate from the CREATE TABLE for the reason the baseline's grants migration gives: privileges
-- cannot be expressed in the Drizzle schema, so drizzle-kit will never generate them, and
-- `tenant-grants.spec.ts` fails the build when a table in the plan has no GRANT.
--
-- All six get the full CRUD set rather than the SELECT/INSERT of an append-only ledger, and the two
-- that look like ledgers are the ones worth justifying. `queue_call_disposition` is UPSERTed: an
-- agent who picks a code and then corrects it inside their wrap-up window writes the same
-- (call, agent) row twice, which is an UPDATE. `queue_survey_response` is DELETEd, not by the
-- engine but by the erasure path — a caller who asks for their data to be removed takes their
-- keypresses with them, and a table the tenant role cannot delete from is a table that outlives
-- the request.
GRANT SELECT, INSERT, UPDATE, DELETE ON
	"queue_disposition_code",
	"queue_call_disposition",
	"queue_agent_skill",
	"queue_skill_requirement",
	"queue_survey_question",
	"queue_survey_response"
TO "pbx_tenant_tls";
