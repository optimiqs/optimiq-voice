CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"messaging_number_id" uuid NOT NULL,
	"remote_e164" text NOT NULL,
	"display_name" text,
	"last_message_at" timestamp with time zone,
	"last_message_preview" text,
	"last_message_direction" text,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"messaging_number_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"kind" text DEFAULT 'SMS' NOT NULL,
	"from_e164" text NOT NULL,
	"to_e164" text NOT NULL,
	"body" text,
	"media_keys" jsonb DEFAULT '[]' NOT NULL,
	"carrier_message_id" text,
	"segments" integer,
	"error_reason" text,
	"sent_by_user_id" text,
	"compliance_keyword" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"retention_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_direction_check" CHECK (direction in ('inbound', 'outbound')),
	CONSTRAINT "message_status_check" CHECK (status in ('queued', 'sending', 'sent', 'delivered', 'failed', 'received')),
	CONSTRAINT "message_kind_check" CHECK (kind in ('SMS', 'MMS'))
);
--> statement-breakpoint
ALTER TABLE "message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messaging_brand" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"carrier_brand_id" text,
	"display_name" text NOT NULL,
	"company_name" text NOT NULL,
	"entity_type" text NOT NULL,
	"ein" text,
	"vertical" text,
	"email" text NOT NULL,
	"phone" text,
	"website" text,
	"street" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text DEFAULT 'US' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"otp_reference" text,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messaging_brand_status_check" CHECK (status in ('pending', 'self-declared', 'verified', 'vetted-verified', 'unverified', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "messaging_brand" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messaging_campaign" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"carrier_campaign_id" text,
	"name" text NOT NULL,
	"use_case" text NOT NULL,
	"description" text NOT NULL,
	"sample_messages" jsonb DEFAULT '[]' NOT NULL,
	"message_flow" text NOT NULL,
	"help_message" text NOT NULL,
	"opt_out_message" text DEFAULT 'You have been unsubscribed and will receive no further messages. Reply START to resubscribe.' NOT NULL,
	"opt_in_keywords" text DEFAULT 'START,UNSTOP,YES' NOT NULL,
	"opt_out_keywords" text DEFAULT 'STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT' NOT NULL,
	"help_keywords" text DEFAULT 'HELP,INFO' NOT NULL,
	"embedded_link" boolean DEFAULT false NOT NULL,
	"age_gated" boolean DEFAULT false NOT NULL,
	"quiet_hours_start_minute" integer,
	"quiet_hours_end_minute" integer,
	"quiet_hours_time_zone" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"status_reason" text,
	"throughput_per_second" integer,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messaging_campaign_status_check" CHECK (status in ('draft', 'pending', 'active', 'expired', 'rejected', 'suspended')),
	CONSTRAINT "messaging_campaign_quiet_hours_shape_check" CHECK ((quiet_hours_start_minute is null and quiet_hours_end_minute is null and quiet_hours_time_zone is null)
			    or (quiet_hours_start_minute is not null and quiet_hours_end_minute is not null and quiet_hours_time_zone is not null)),
	CONSTRAINT "messaging_campaign_quiet_hours_range_check" CHECK ((quiet_hours_start_minute is null or (quiet_hours_start_minute between 0 and 1439))
			    and (quiet_hours_end_minute is null or (quiet_hours_end_minute between 0 and 1439)))
);
--> statement-breakpoint
ALTER TABLE "messaging_campaign" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messaging_number" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"phone_number_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"number_class" text DEFAULT 'local' NOT NULL,
	"carrier_messaging_profile_id" text,
	"campaign_id" uuid,
	"registration_status" text DEFAULT 'unregistered' NOT NULL,
	"registration_reason" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"retention_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messaging_number_class_check" CHECK (number_class in ('local', 'toll-free', 'short-code')),
	CONSTRAINT "messaging_number_registration_status_check" CHECK (registration_status in ('unregistered', 'pending', 'registered', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "messaging_number" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messaging_opt_out" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"messaging_number_id" uuid NOT NULL,
	"remote_e164" text NOT NULL,
	"source" text DEFAULT 'keyword' NOT NULL,
	"keyword" text,
	"recorded_by_user_id" text,
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messaging_opt_out_source_check" CHECK (source in ('keyword', 'manual', 'carrier'))
);
--> statement-breakpoint
ALTER TABLE "messaging_opt_out" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messaging_toll_free_verification" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"messaging_number_id" uuid NOT NULL,
	"carrier_verification_id" text,
	"business_name" text NOT NULL,
	"corporate_website" text NOT NULL,
	"business_addr1" text NOT NULL,
	"business_addr2" text,
	"business_city" text NOT NULL,
	"business_state" text NOT NULL,
	"business_zip" text NOT NULL,
	"business_contact_first_name" text NOT NULL,
	"business_contact_last_name" text NOT NULL,
	"business_contact_email" text NOT NULL,
	"business_contact_phone" text NOT NULL,
	"business_registration_number" text NOT NULL,
	"business_registration_type" text NOT NULL,
	"business_registration_country" text NOT NULL,
	"use_case" text NOT NULL,
	"use_case_summary" text NOT NULL,
	"production_message_content" text NOT NULL,
	"opt_in_workflow" text NOT NULL,
	"opt_in_workflow_image_urls" jsonb DEFAULT '[]' NOT NULL,
	"message_volume" text NOT NULL,
	"privacy_policy_url" text NOT NULL,
	"terms_and_conditions_url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messaging_toll_free_verification_status_check" CHECK (status in ('pending', 'in-review', 'verified', 'rejected')),
	CONSTRAINT "messaging_toll_free_verification_country_check" CHECK (business_registration_country ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "messaging_toll_free_verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_number_remote_key" ON "conversation" ("organization_id","messaging_number_id","remote_e164");--> statement-breakpoint
CREATE INDEX "conversation_organization_last_message_idx" ON "conversation" ("organization_id","archived","last_message_at");--> statement-breakpoint
CREATE INDEX "message_conversation_created_idx" ON "message" ("organization_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "message_organization_status_idx" ON "message" ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "message_organization_carrier_message_id_key" ON "message" ("organization_id","carrier_message_id") WHERE carrier_message_id is not null;--> statement-breakpoint
CREATE INDEX "message_send_queue_idx" ON "message" ("status","claimed_at") WHERE direction = 'outbound' and status in ('queued', 'sending');--> statement-breakpoint
CREATE INDEX "message_retention_idx" ON "message" ("retention_until") WHERE retention_until is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_brand_carrier_brand_id_key" ON "messaging_brand" ("carrier_brand_id") WHERE carrier_brand_id is not null;--> statement-breakpoint
CREATE INDEX "messaging_brand_organization_status_idx" ON "messaging_brand" ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_campaign_carrier_campaign_id_key" ON "messaging_campaign" ("carrier_campaign_id") WHERE carrier_campaign_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_campaign_organization_name_key" ON "messaging_campaign" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "messaging_campaign_organization_status_idx" ON "messaging_campaign" ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_number_organization_phone_number_key" ON "messaging_number" ("organization_id","phone_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_number_e164_global_key" ON "messaging_number" ("e164");--> statement-breakpoint
CREATE INDEX "messaging_number_organization_enabled_idx" ON "messaging_number" ("organization_id","enabled");--> statement-breakpoint
CREATE INDEX "messaging_number_organization_campaign_idx" ON "messaging_number" ("organization_id","campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_opt_out_number_remote_key" ON "messaging_opt_out" ("organization_id","messaging_number_id","remote_e164");--> statement-breakpoint
CREATE UNIQUE INDEX "messaging_toll_free_verification_carrier_id_key" ON "messaging_toll_free_verification" ("carrier_verification_id") WHERE carrier_verification_id is not null;--> statement-breakpoint
CREATE INDEX "messaging_tfv_organization_status_idx" ON "messaging_toll_free_verification" ("organization_id","status");--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_messaging_number_id_messaging_number_id_fkey" FOREIGN KEY ("messaging_number_id") REFERENCES "messaging_number"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_messaging_number_id_messaging_number_id_fkey" FOREIGN KEY ("messaging_number_id") REFERENCES "messaging_number"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "messaging_campaign" ADD CONSTRAINT "messaging_campaign_brand_id_messaging_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "messaging_brand"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "messaging_number" ADD CONSTRAINT "messaging_number_phone_number_id_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_number"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "messaging_number" ADD CONSTRAINT "messaging_number_campaign_id_messaging_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "messaging_campaign"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "messaging_opt_out" ADD CONSTRAINT "messaging_opt_out_messaging_number_id_messaging_number_id_fkey" FOREIGN KEY ("messaging_number_id") REFERENCES "messaging_number"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "conversation_tenant_isolation" ON "conversation" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_tenant_isolation" ON "message" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "messaging_brand_tenant_isolation" ON "messaging_brand" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "messaging_campaign_tenant_isolation" ON "messaging_campaign" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "messaging_number_tenant_isolation" ON "messaging_number" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "messaging_opt_out_tenant_isolation" ON "messaging_opt_out" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "messaging_toll_free_verification_tenant_isolation" ON "messaging_toll_free_verification" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);