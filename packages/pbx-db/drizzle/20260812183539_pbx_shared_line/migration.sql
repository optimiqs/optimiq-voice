CREATE TABLE "shared_line" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"extension_number" text,
	"strategy" text DEFAULT 'simultaneous' NOT NULL,
	"ring_timeout_seconds" integer DEFAULT 30 NOT NULL,
	"hold_recall_timeout_seconds" integer DEFAULT 60 NOT NULL,
	"barge_in_enabled" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shared_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shared_line_appearance" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"shared_line_id" uuid NOT NULL,
	"extension_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shared_line_appearance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "shared_line_organization_name_key" ON "shared_line" ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_line_organization_extension_number_key" ON "shared_line" ("organization_id","extension_number") WHERE extension_number is not null;--> statement-breakpoint
CREATE INDEX "shared_line_organization_enabled_idx" ON "shared_line" ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_line_appearance_line_extension_key" ON "shared_line_appearance" ("organization_id","shared_line_id","extension_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_line_appearance_line_ordinal_key" ON "shared_line_appearance" ("organization_id","shared_line_id","ordinal");--> statement-breakpoint
CREATE INDEX "shared_line_appearance_organization_line_idx" ON "shared_line_appearance" ("organization_id","shared_line_id");--> statement-breakpoint
ALTER TABLE "shared_line_appearance" ADD CONSTRAINT "shared_line_appearance_shared_line_id_shared_line_id_fkey" FOREIGN KEY ("shared_line_id") REFERENCES "shared_line"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "shared_line_appearance" ADD CONSTRAINT "shared_line_appearance_extension_id_extension_id_fkey" FOREIGN KEY ("extension_id") REFERENCES "extension"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "shared_line_tenant_isolation" ON "shared_line" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "shared_line_appearance_tenant_isolation" ON "shared_line_appearance" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);