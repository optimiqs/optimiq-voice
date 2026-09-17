CREATE TABLE "organization_branding" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"product_name" text,
	"logo_object_key" text,
	"primary_color" text,
	"accent_color" text,
	"support_email" text,
	"custom_domain" text,
	"default_language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_hierarchy" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"parent_organization_id" uuid,
	"is_reseller" boolean DEFAULT false NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_branding_organization_key" ON "organization_branding" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_branding_custom_domain_key" ON "organization_branding" ("custom_domain");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_hierarchy_organization_key" ON "organization_hierarchy" ("organization_id");--> statement-breakpoint
CREATE INDEX "organization_hierarchy_parent_idx" ON "organization_hierarchy" ("parent_organization_id");--> statement-breakpoint
ALTER TABLE "organization_branding" ADD CONSTRAINT "organization_branding_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_hierarchy" ADD CONSTRAINT "organization_hierarchy_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_hierarchy" ADD CONSTRAINT "organization_hierarchy_y4vbzNO6FcAe_fkey" FOREIGN KEY ("parent_organization_id") REFERENCES "organization"("id") ON DELETE SET NULL;