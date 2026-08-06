CREATE TABLE "pbx_projection_outbox" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"projection" text NOT NULL,
	"payload" jsonb,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pbx_projection_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "pbx_projection_outbox_pending_idx" ON "pbx_projection_outbox" ("created_at") WHERE "published_at" is null;--> statement-breakpoint
CREATE INDEX "pbx_projection_outbox_published_idx" ON "pbx_projection_outbox" ("published_at");--> statement-breakpoint
CREATE POLICY "pbx_projection_outbox_tenant_isolation" ON "pbx_projection_outbox" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);