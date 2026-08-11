CREATE TABLE "sip_auth_event" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"scope" text NOT NULL,
	"source_ip" inet,
	"account_ref" text,
	"transport" text,
	"user_agent" text,
	"detail" jsonb,
	"request_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sip_auth_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "sip_auth_event_organization_occurred_idx" ON "sip_auth_event" ("organization_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "sip_auth_event_organization_source_idx" ON "sip_auth_event" ("organization_id","source_ip","occurred_at");--> statement-breakpoint
CREATE INDEX "sip_auth_event_organization_type_idx" ON "sip_auth_event" ("organization_id","event_type","occurred_at");--> statement-breakpoint
CREATE POLICY "sip_auth_event_tenant_select" ON "sip_auth_event" AS PERMISSIVE FOR SELECT TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sip_auth_event_tenant_insert" ON "sip_auth_event" AS PERMISSIVE FOR INSERT TO "pbx_tenant_tls" WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);