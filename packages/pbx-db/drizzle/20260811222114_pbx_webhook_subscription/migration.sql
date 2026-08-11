CREATE TABLE "webhook_subscription" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"event_selectors" jsonb DEFAULT '[]' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone,
	"last_failure_reason" text,
	"last_success_at" timestamp with time zone,
	"auto_disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_subscription" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "webhook_subscription_organization_enabled_idx" ON "webhook_subscription" ("organization_id","enabled");--> statement-breakpoint
CREATE POLICY "webhook_subscription_tenant_isolation" ON "webhook_subscription" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);