-- Privileges for the telephony tenant role.
--
-- `pbx_tenant_tls` itself is created by the baseline migration (drizzle-kit manages roles for
-- this database), but privileges cannot be expressed in the Drizzle schema, so they live here.
--
-- The role is NOINHERIT: `set local role pbx_tenant_tls` drops every privilege the connecting
-- principal holds, so the grants below are the COMPLETE list of what a tenant transaction can do.
-- Row-level-security policies then narrow each grant to a single organization.
--
-- Adding a table to the schema therefore requires a new grants migration as well; the
-- `tenant-grants.spec.ts` unit test fails the build when one is missing.

GRANT USAGE ON SCHEMA "public" TO "pbx_tenant_tls";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON
	"call_block_rule",
	"conference",
	"device",
	"device_key",
	"device_line",
	"device_profile",
	"device_profile_key",
	"emergency_address",
	"extension",
	"extension_user",
	"feature_code",
	"inbound_route",
	"ivr_menu",
	"ivr_menu_option",
	"moh_class",
	"org_setting",
	"outbound_route",
	"park_lot",
	"phone_number",
	"prompt",
	"queue",
	"queue_agent",
	"queue_tier",
	"ring_group",
	"ring_group_destination",
	"sip_acl_entry",
	"time_condition",
	"time_condition_rule",
	"trunk",
	"user_setting",
	"voicemail_box",
	"voicemail_greeting",
	"voicemail_message",
	"voicemail_option"
TO "pbx_tenant_tls";
--> statement-breakpoint
-- Append-only ledgers: SELECT and INSERT only. No UPDATE/DELETE privilege exists to revoke.
GRANT SELECT, INSERT ON
	"audit_log"
TO "pbx_tenant_tls";
--> statement-breakpoint
-- Let the migration principal assume the role so preflight and integration tests can
-- `set role`. Every runtime principal needs its own `GRANT "pbx_tenant_tls" TO <role>`.
DO $$
BEGIN
	EXECUTE format('GRANT %I TO %I', 'pbx_tenant_tls', current_user);
END
$$;
