CREATE TABLE "shared_rate_window" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_ms" integer NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shared_rate_window" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "extension_toll_fraud_override" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"extension_id" uuid NOT NULL,
	"enabled" boolean,
	"max_concurrent_international_calls" integer,
	"max_international_minutes_per_hour" integer,
	"max_international_minutes_per_day" integer,
	"allowed_countries" jsonb,
	"denied_countries" jsonb,
	"hold_first_call_to_new_country" boolean,
	"off_hours_international_lock" boolean,
	"outbound_suspended" boolean DEFAULT false NOT NULL,
	"suspended_reason" text,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extension_toll_fraud_override" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "toll_fraud_country_seen" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"country" char(2) NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "toll_fraud_country_seen" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "toll_fraud_policy" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_concurrent_international_calls" integer,
	"max_international_minutes_per_hour" integer,
	"max_international_minutes_per_day" integer,
	"allowed_countries" jsonb,
	"denied_countries" jsonb,
	"hold_first_call_to_new_country" boolean DEFAULT false NOT NULL,
	"off_hours_international_lock" boolean DEFAULT false NOT NULL,
	"off_hours_start_minute" integer DEFAULT 1200 NOT NULL,
	"off_hours_end_minute" integer DEFAULT 420 NOT NULL,
	"off_hours_timezone" text,
	"auto_suspend_on_signal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "toll_fraud_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "device_line" ADD COLUMN "sip_secret_ref_previous" text;--> statement-breakpoint
ALTER TABLE "device_line" ADD COLUMN "sip_secret_grace_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extension" ADD COLUMN "sip_secret_ref_previous" text;--> statement-breakpoint
ALTER TABLE "extension" ADD COLUMN "sip_secret_grace_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trunk" ADD COLUMN "srtp_policy" text;--> statement-breakpoint
CREATE UNIQUE INDEX "shared_rate_window_key" ON "shared_rate_window" ("organization_id","scope","key","window_start");--> statement-breakpoint
CREATE INDEX "shared_rate_window_organization_expires_idx" ON "shared_rate_window" ("organization_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "extension_toll_fraud_override_extension_key" ON "extension_toll_fraud_override" ("organization_id","extension_id");--> statement-breakpoint
CREATE INDEX "extension_toll_fraud_override_organization_idx" ON "extension_toll_fraud_override" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "toll_fraud_country_seen_key" ON "toll_fraud_country_seen" ("organization_id","country");--> statement-breakpoint
CREATE INDEX "toll_fraud_country_seen_organization_idx" ON "toll_fraud_country_seen" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "toll_fraud_policy_organization_key" ON "toll_fraud_policy" ("organization_id");--> statement-breakpoint
CREATE INDEX "toll_fraud_policy_organization_idx" ON "toll_fraud_policy" ("organization_id");--> statement-breakpoint
ALTER TABLE "extension_toll_fraud_override" ADD CONSTRAINT "extension_toll_fraud_override_extension_fk" FOREIGN KEY ("organization_id","extension_id") REFERENCES "extension"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "shared_rate_window_tenant_isolation" ON "shared_rate_window" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "extension_toll_fraud_override_tenant_isolation" ON "extension_toll_fraud_override" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "toll_fraud_country_seen_tenant_isolation" ON "toll_fraud_country_seen" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "toll_fraud_policy_tenant_isolation" ON "toll_fraud_policy" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);