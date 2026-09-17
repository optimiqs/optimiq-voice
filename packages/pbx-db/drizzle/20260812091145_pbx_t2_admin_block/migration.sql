CREATE TABLE "destination_alias" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"destination_type" text NOT NULL,
	"destination_ref" uuid,
	"destination_data" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "destination_alias_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "destination_alias" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "call_flow" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"extension_number" text,
	"feature_code" text,
	"destination_type" text NOT NULL,
	"destination_ref" uuid,
	"destination_data" jsonb,
	"night_destination_type" text,
	"night_destination_ref" uuid,
	"night_destination_data" jsonb,
	"mode" text DEFAULT 'day' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_flow_mode_check" CHECK (mode in ('day', 'night')),
	CONSTRAINT "call_flow_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null)),
	CONSTRAINT "call_flow_night_destination_shape_check" CHECK ((night_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and night_destination_ref is not null) or (night_destination_type in ('external', 'application') and night_destination_ref is null and night_destination_data is not null) or (night_destination_type = 'hangup' and night_destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "call_flow" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "dial_by_name_directory" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"extension_number" text,
	"search_field" text DEFAULT 'last-name' NOT NULL,
	"min_digits" integer DEFAULT 3 NOT NULL,
	"greeting_prompt_id" uuid,
	"invalid_prompt_id" uuid,
	"max_failures" integer DEFAULT 3 NOT NULL,
	"timeout_destination_type" text,
	"timeout_destination_ref" uuid,
	"timeout_destination_data" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dial_by_name_directory_search_field_check" CHECK (search_field in ('last-name', 'first-name', 'full-name')),
	CONSTRAINT "dial_by_name_directory_timeout_destination_shape_check" CHECK ((timeout_destination_type is null and timeout_destination_ref is null and timeout_destination_data is null) or (timeout_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and timeout_destination_ref is not null) or (timeout_destination_type in ('external', 'application') and timeout_destination_ref is null and timeout_destination_data is not null) or (timeout_destination_type = 'hangup' and timeout_destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "dial_by_name_directory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_limit" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"max_extensions" integer,
	"max_trunks" integer,
	"max_concurrent_calls" integer,
	"max_storage_mb" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_limit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "phrase_step" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"phrase_id" uuid NOT NULL,
	"prompt_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "phrase_step" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pin_set" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"prompt_id" uuid,
	"failure_prompt_id" uuid,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"digit_timeout_ms" integer DEFAULT 8000 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pin_set" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pin_set_entry" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"pin_set_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"label" text,
	"pin_hash" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pin_set_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "speed_dial" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"destination_type" text NOT NULL,
	"destination_ref" uuid,
	"destination_data" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "speed_dial_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "speed_dial" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audio_stream" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"answer_first" boolean DEFAULT true NOT NULL,
	"max_seconds" integer DEFAULT 0 NOT NULL,
	"fallback_destination_type" text,
	"fallback_destination_ref" uuid,
	"fallback_destination_data" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audio_stream_fallback_destination_shape_check" CHECK ((fallback_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and fallback_destination_ref is not null) or (fallback_destination_type in ('external', 'application') and fallback_destination_ref is null and fallback_destination_data is not null) or (fallback_destination_type = 'hangup' and fallback_destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "audio_stream" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "translation_rule" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"translation_ruleset_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"label" text,
	"match_pattern" text NOT NULL,
	"replacement" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "translation_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "translation_ruleset" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "translation_ruleset" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbound_route" ADD COLUMN "pin_set_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_route" ADD COLUMN "translation_ruleset_id" uuid;--> statement-breakpoint
ALTER TABLE "time_condition" ADD COLUMN "override" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "time_condition" ADD COLUMN "override_feature_code" text;--> statement-breakpoint
ALTER TABLE "trunk" ADD COLUMN "inbound_translation_ruleset_id" uuid;--> statement-breakpoint
ALTER TABLE "prompt" ALTER COLUMN "object_key" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "destination_alias_organization_name_key" ON "destination_alias" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "destination_alias_organization_enabled_idx" ON "destination_alias" ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "call_flow_organization_name_key" ON "call_flow" ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "call_flow_organization_extension_number_key" ON "call_flow" ("organization_id","extension_number") WHERE extension_number is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "call_flow_organization_feature_code_key" ON "call_flow" ("organization_id","feature_code") WHERE feature_code is not null;--> statement-breakpoint
CREATE INDEX "call_flow_organization_enabled_idx" ON "call_flow" ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "dial_by_name_directory_organization_name_key" ON "dial_by_name_directory" ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "dial_by_name_directory_organization_extension_number_key" ON "dial_by_name_directory" ("organization_id","extension_number") WHERE extension_number is not null;--> statement-breakpoint
CREATE INDEX "dial_by_name_directory_organization_enabled_idx" ON "dial_by_name_directory" ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "org_limit_organization_key" ON "org_limit" ("organization_id");--> statement-breakpoint
CREATE INDEX "org_limit_organization_idx" ON "org_limit" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "phrase_step_phrase_ordinal_key" ON "phrase_step" ("organization_id","phrase_id","ordinal");--> statement-breakpoint
CREATE INDEX "phrase_step_organization_phrase_idx" ON "phrase_step" ("organization_id","phrase_id");--> statement-breakpoint
CREATE INDEX "phrase_step_organization_prompt_idx" ON "phrase_step" ("organization_id","prompt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pin_set_organization_name_key" ON "pin_set" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "pin_set_organization_enabled_idx" ON "pin_set" ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "pin_set_entry_set_ordinal_key" ON "pin_set_entry" ("organization_id","pin_set_id","ordinal");--> statement-breakpoint
CREATE INDEX "pin_set_entry_organization_set_idx" ON "pin_set_entry" ("organization_id","pin_set_id");--> statement-breakpoint
CREATE INDEX "outbound_route_organization_pin_set_idx" ON "outbound_route" ("organization_id","pin_set_id");--> statement-breakpoint
CREATE INDEX "outbound_route_organization_translation_idx" ON "outbound_route" ("organization_id","translation_ruleset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "speed_dial_organization_code_key" ON "speed_dial" ("organization_id","code");--> statement-breakpoint
CREATE INDEX "speed_dial_organization_enabled_idx" ON "speed_dial" ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_stream_organization_name_key" ON "audio_stream" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "audio_stream_organization_enabled_idx" ON "audio_stream" ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "time_condition_organization_override_feature_code_key" ON "time_condition" ("organization_id","override_feature_code") WHERE override_feature_code is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "translation_rule_ruleset_ordinal_key" ON "translation_rule" ("organization_id","translation_ruleset_id","ordinal");--> statement-breakpoint
CREATE INDEX "translation_rule_organization_ruleset_idx" ON "translation_rule" ("organization_id","translation_ruleset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "translation_ruleset_organization_name_key" ON "translation_ruleset" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "translation_ruleset_organization_enabled_idx" ON "translation_ruleset" ("organization_id","enabled");--> statement-breakpoint
CREATE INDEX "trunk_organization_inbound_translation_idx" ON "trunk" ("organization_id","inbound_translation_ruleset_id");--> statement-breakpoint
ALTER TABLE "phrase_step" ADD CONSTRAINT "phrase_step_phrase_id_prompt_id_fkey" FOREIGN KEY ("phrase_id") REFERENCES "prompt"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "phrase_step" ADD CONSTRAINT "phrase_step_prompt_id_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompt"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "pin_set_entry" ADD CONSTRAINT "pin_set_entry_pin_set_id_pin_set_id_fkey" FOREIGN KEY ("pin_set_id") REFERENCES "pin_set"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outbound_route" ADD CONSTRAINT "outbound_route_pin_set_id_pin_set_id_fkey" FOREIGN KEY ("pin_set_id") REFERENCES "pin_set"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "outbound_route" ADD CONSTRAINT "outbound_route_z3xCIVpBdI1U_fkey" FOREIGN KEY ("translation_ruleset_id") REFERENCES "translation_ruleset"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "translation_rule" ADD CONSTRAINT "translation_rule_WdknuWySDQMe_fkey" FOREIGN KEY ("translation_ruleset_id") REFERENCES "translation_ruleset"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "trunk" ADD CONSTRAINT "trunk_GNcnP110QjrI_fkey" FOREIGN KEY ("inbound_translation_ruleset_id") REFERENCES "translation_ruleset"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "prompt" ADD CONSTRAINT "prompt_object_key_kind_check" CHECK ((kind = 'phrase' and object_key is null) or (kind <> 'phrase' and object_key is not null));--> statement-breakpoint
ALTER TABLE "time_condition" ADD CONSTRAINT "time_condition_override_check" CHECK (override in ('auto', 'forced-match', 'forced-no-match'));--> statement-breakpoint
ALTER TABLE "park_lot" DROP CONSTRAINT "park_lot_timeout_destination_shape_check", ADD CONSTRAINT "park_lot_timeout_destination_shape_check" CHECK ((timeout_destination_type is null and timeout_destination_ref is null and timeout_destination_data is null) or (timeout_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and timeout_destination_ref is not null) or (timeout_destination_type in ('external', 'application') and timeout_destination_ref is null and timeout_destination_data is not null) or (timeout_destination_type = 'hangup' and timeout_destination_ref is null));--> statement-breakpoint
ALTER TABLE "ivr_menu" DROP CONSTRAINT "ivr_menu_timeout_destination_shape_check", ADD CONSTRAINT "ivr_menu_timeout_destination_shape_check" CHECK ((timeout_destination_type is null and timeout_destination_ref is null and timeout_destination_data is null) or (timeout_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and timeout_destination_ref is not null) or (timeout_destination_type in ('external', 'application') and timeout_destination_ref is null and timeout_destination_data is not null) or (timeout_destination_type = 'hangup' and timeout_destination_ref is null));--> statement-breakpoint
ALTER TABLE "ivr_menu" DROP CONSTRAINT "ivr_menu_invalid_destination_shape_check", ADD CONSTRAINT "ivr_menu_invalid_destination_shape_check" CHECK ((invalid_destination_type is null and invalid_destination_ref is null and invalid_destination_data is null) or (invalid_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and invalid_destination_ref is not null) or (invalid_destination_type in ('external', 'application') and invalid_destination_ref is null and invalid_destination_data is not null) or (invalid_destination_type = 'hangup' and invalid_destination_ref is null));--> statement-breakpoint
ALTER TABLE "ivr_menu_option" DROP CONSTRAINT "ivr_menu_option_destination_shape_check", ADD CONSTRAINT "ivr_menu_option_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null));--> statement-breakpoint
ALTER TABLE "phone_number" DROP CONSTRAINT "phone_number_destination_shape_check", ADD CONSTRAINT "phone_number_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null));--> statement-breakpoint
ALTER TABLE "queue" DROP CONSTRAINT "queue_timeout_destination_shape_check", ADD CONSTRAINT "queue_timeout_destination_shape_check" CHECK ((timeout_destination_type is null and timeout_destination_ref is null and timeout_destination_data is null) or (timeout_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and timeout_destination_ref is not null) or (timeout_destination_type in ('external', 'application') and timeout_destination_ref is null and timeout_destination_data is not null) or (timeout_destination_type = 'hangup' and timeout_destination_ref is null));--> statement-breakpoint
ALTER TABLE "ring_group" DROP CONSTRAINT "ring_group_timeout_destination_shape_check", ADD CONSTRAINT "ring_group_timeout_destination_shape_check" CHECK ((timeout_destination_type is null and timeout_destination_ref is null and timeout_destination_data is null) or (timeout_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and timeout_destination_ref is not null) or (timeout_destination_type in ('external', 'application') and timeout_destination_ref is null and timeout_destination_data is not null) or (timeout_destination_type = 'hangup' and timeout_destination_ref is null));--> statement-breakpoint
ALTER TABLE "ring_group_destination" DROP CONSTRAINT "ring_group_destination_destination_shape_check", ADD CONSTRAINT "ring_group_destination_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null));--> statement-breakpoint
ALTER TABLE "inbound_route" DROP CONSTRAINT "inbound_route_destination_shape_check", ADD CONSTRAINT "inbound_route_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null));--> statement-breakpoint
ALTER TABLE "inbound_route" DROP CONSTRAINT "inbound_route_failover_destination_shape_check", ADD CONSTRAINT "inbound_route_failover_destination_shape_check" CHECK ((failover_destination_type is null and failover_destination_ref is null and failover_destination_data is null) or (failover_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and failover_destination_ref is not null) or (failover_destination_type in ('external', 'application') and failover_destination_ref is null and failover_destination_data is not null) or (failover_destination_type = 'hangup' and failover_destination_ref is null));--> statement-breakpoint
ALTER TABLE "outbound_route" DROP CONSTRAINT "outbound_route_failover_destination_shape_check", ADD CONSTRAINT "outbound_route_failover_destination_shape_check" CHECK ((failover_destination_type is null and failover_destination_ref is null and failover_destination_data is null) or (failover_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and failover_destination_ref is not null) or (failover_destination_type in ('external', 'application') and failover_destination_ref is null and failover_destination_data is not null) or (failover_destination_type = 'hangup' and failover_destination_ref is null));--> statement-breakpoint
ALTER TABLE "time_condition" DROP CONSTRAINT "time_condition_destination_shape_check", ADD CONSTRAINT "time_condition_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null));--> statement-breakpoint
ALTER TABLE "time_condition" DROP CONSTRAINT "time_condition_nomatch_destination_shape_check", ADD CONSTRAINT "time_condition_nomatch_destination_shape_check" CHECK ((nomatch_destination_type is null and nomatch_destination_ref is null and nomatch_destination_data is null) or (nomatch_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and nomatch_destination_ref is not null) or (nomatch_destination_type in ('external', 'application') and nomatch_destination_ref is null and nomatch_destination_data is not null) or (nomatch_destination_type = 'hangup' and nomatch_destination_ref is null));--> statement-breakpoint
ALTER TABLE "voicemail_option" DROP CONSTRAINT "voicemail_option_destination_shape_check", ADD CONSTRAINT "voicemail_option_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null));--> statement-breakpoint
CREATE POLICY "destination_alias_tenant_isolation" ON "destination_alias" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "call_flow_tenant_isolation" ON "call_flow" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "dial_by_name_directory_tenant_isolation" ON "dial_by_name_directory" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "org_limit_tenant_isolation" ON "org_limit" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "phrase_step_tenant_isolation" ON "phrase_step" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pin_set_tenant_isolation" ON "pin_set" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "pin_set_entry_tenant_isolation" ON "pin_set_entry" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "speed_dial_tenant_isolation" ON "speed_dial" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audio_stream_tenant_isolation" ON "audio_stream" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "translation_rule_tenant_isolation" ON "translation_rule" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "translation_ruleset_tenant_isolation" ON "translation_ruleset" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);