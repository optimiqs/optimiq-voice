-- Privileges for the outbound webhook subscriptions.
--
-- Separate from the CREATE TABLE for the reason the baseline's grants migration gives: privileges
-- cannot be expressed in the Drizzle schema, so drizzle-kit will never generate them, and
-- `tenant-grants.spec.ts` fails the build when a table in the plan has no GRANT.
--
-- The full set, unlike `audit_log` and `sip_auth_event`: a subscription is CONFIGURATION that an
-- administrator creates, edits and deletes through `/api/v1/webhooks`, and the delivery worker
-- writes the health columns back on the same runtime principal. There is nothing append-only about
-- it — the append-only tables in this database are the two LEDGERS, and a webhook endpoint is not a
-- record of anything that happened.

GRANT SELECT, INSERT, UPDATE, DELETE ON
	"webhook_subscription"
TO "pbx_tenant_tls";
