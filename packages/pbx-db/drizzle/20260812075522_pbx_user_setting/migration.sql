CREATE TABLE "user_setting" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"value" jsonb,
	"value_type" text DEFAULT 'string' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "user_setting_organization_user_category_name_key" ON "user_setting" ("organization_id","user_id","category","name");--> statement-breakpoint
CREATE INDEX "user_setting_organization_user_idx" ON "user_setting" ("organization_id","user_id");--> statement-breakpoint
CREATE POLICY "user_setting_tenant_isolation" ON "user_setting" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);