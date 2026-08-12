-- Privileges for the returned user settings level.
--
-- Separate from the CREATE TABLE for the reason the baseline's grants migration gives: privileges
-- cannot be expressed in the Drizzle schema, so drizzle-kit will never generate them, and
-- `tenant-grants.spec.ts` fails the build when a table in the plan has no GRANT.
--
-- The full set, and each verb earns its place. A preference is CONFIGURATION a person creates,
-- changes and clears through `/api/v1/org-settings/me` on the tenant runtime principal: SELECT is
-- the preferences screen, INSERT is the first override, UPDATE is changing or re-enabling one, and
-- DELETE is "back to the organization's answer" — which for a preference destroys nothing, exactly
-- the argument `org-settings.controller.ts` makes for `org_setting` rows. This table is NOT one of
-- the append-only ledgers (`audit_log`, `sip_auth_event`): a preference is not a record of
-- anything that happened, and freezing a person's old choices in place would turn every change of
-- mind into a new row nothing reads.

GRANT SELECT, INSERT, UPDATE, DELETE ON
	"user_setting"
TO "pbx_tenant_tls";
