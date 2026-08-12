-- Privileges for the T2 admin block: call flows, PIN sets, translation rulesets, destination
-- aliases, audio streams, phrase steps, the dial-by-name directory, speed dials and org limits.
--
-- Separate from the CREATE TABLE for the reason the baseline's grants migration gives: privileges
-- cannot be expressed in the Drizzle schema, so drizzle-kit will never generate them, and
-- `tenant-grants.spec.ts` fails the build when a table in the plan has no GRANT.
--
-- The full set on all eleven. Every one of them is CONFIGURATION an administrator creates, renames
-- and deletes — the two append-only tables in this database are the LEDGERS (`audit_log`,
-- `sip_auth_event`), and none of these is a record of something that happened.
--
-- `org_limit` is the one worth pausing over, because it is the row a tenant is not supposed to be
-- able to raise. The answer is that the GRANT is not where that is decided: the tenant role needs
-- UPDATE for the platform-operator surface to write through the same RLS-scoped connection every
-- other write uses, and the control is the `org-limits.write` permission held by `owner` alone.
-- `limits-schema.ts` states plainly that this is an interim arrangement W14's reseller hierarchy
-- replaces; withholding the privilege here would only mean a second connection with a second set of
-- rules, which is more surface rather than less.

GRANT SELECT, INSERT, UPDATE, DELETE ON
	"audio_stream",
	"call_flow",
	"destination_alias",
	"dial_by_name_directory",
	"org_limit",
	"phrase_step",
	"pin_set",
	"pin_set_entry",
	"speed_dial",
	"translation_rule",
	"translation_ruleset"
TO "pbx_tenant_tls";
