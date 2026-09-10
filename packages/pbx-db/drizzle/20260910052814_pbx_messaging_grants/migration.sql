-- Privileges for the messaging tables.
--
-- Separate from the CREATE TABLE for the reason the baseline's grants migration gives: privileges
-- cannot be expressed in the Drizzle schema, so drizzle-kit will never generate them, and
-- `tenant-grants.spec.ts` fails the build when a table in the RLS plan has no GRANT.
--
-- Six of the seven take the full CRUD set. A conversation is renamed and archived; a message's
-- status is written by the delivery receipt and the row is removed by the retention sweeper; a
-- brand, a campaign and a verification are amended in place after a rejection rather than
-- re-created. None of them is an append-only ledger, so none takes the SELECT/INSERT pair.
--
-- `messaging_opt_out` gets DELETE too, and it is the one worth pausing on, because a suppression
-- row is the most consent-sensitive thing in this schema and DELETE is how a re-subscribe is
-- recorded. Withholding it here would not make the platform safer — it would only push the
-- re-subscribe into an `active` flag, which is a row a query with a forgotten predicate turns back
-- into permission to send. The defence is elsewhere and is deliberate: the grant that reaches this
-- path is `messaging.manage` (never the agent-level `messaging.read`), the service logs the actor
-- at warn, and the consumer's own STOP and START messages stay in `message` as the evidence of
-- both acts. See `messaging-schema.ts` for the full argument.
GRANT SELECT, INSERT, UPDATE, DELETE ON
	"conversation",
	"message",
	"messaging_brand",
	"messaging_campaign",
	"messaging_number",
	"messaging_opt_out",
	"messaging_toll_free_verification"
TO "pbx_tenant_tls";
