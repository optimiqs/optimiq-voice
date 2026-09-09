CREATE UNIQUE INDEX "org_setting_sip_realm_global_key" ON "org_setting" (lower(btrim("value" #>> '{}'))) WHERE "category" = 'sip' AND "name" = 'realm' AND "enabled";--> statement-breakpoint
ALTER TABLE "org_setting" ADD CONSTRAINT "org_setting_sip_realm_value_check" CHECK (
			"category" <> 'sip' OR "name" <> 'realm'
			OR "value" IS NULL OR "value" = 'null'::jsonb OR (
				jsonb_typeof("value") = 'string'
				AND length(btrim("value" #>> '{}')) BETWEEN 1 AND 253
			));