CREATE TABLE "fax_message" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"fax_server_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"from_e164" text NOT NULL,
	"to_e164" text NOT NULL,
	"pages" integer,
	"object_key" text,
	"source_media_url" text,
	"telnyx_fax_id" text,
	"error_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fax_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "fax_server" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"extension_number" text,
	"phone_number_id" uuid,
	"header_text" text,
	"email_to_address" text,
	"email_from_address" text,
	"retry_attempts" integer DEFAULT 3 NOT NULL,
	"retry_backoff_seconds" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fax_server" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "fax_message_server_created_idx" ON "fax_message" ("organization_id","fax_server_id","created_at");--> statement-breakpoint
CREATE INDEX "fax_message_organization_status_idx" ON "fax_message" ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fax_message_organization_telnyx_fax_id_key" ON "fax_message" ("organization_id","telnyx_fax_id") WHERE telnyx_fax_id is not null;--> statement-breakpoint
CREATE INDEX "fax_message_send_queue_idx" ON "fax_message" ("status","claimed_at") WHERE direction = 'outbound' and status in ('queued', 'sending');--> statement-breakpoint
CREATE UNIQUE INDEX "fax_server_organization_name_key" ON "fax_server" ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "fax_server_organization_extension_number_key" ON "fax_server" ("organization_id","extension_number") WHERE extension_number is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "fax_server_organization_phone_number_key" ON "fax_server" ("organization_id","phone_number_id") WHERE phone_number_id is not null;--> statement-breakpoint
CREATE INDEX "fax_server_organization_enabled_idx" ON "fax_server" ("organization_id","enabled");--> statement-breakpoint
ALTER TABLE "fax_message" ADD CONSTRAINT "fax_message_fax_server_id_fax_server_id_fkey" FOREIGN KEY ("fax_server_id") REFERENCES "fax_server"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "fax_server" ADD CONSTRAINT "fax_server_phone_number_id_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_number"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "fax_message_tenant_isolation" ON "fax_message" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "fax_server_tenant_isolation" ON "fax_server" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);