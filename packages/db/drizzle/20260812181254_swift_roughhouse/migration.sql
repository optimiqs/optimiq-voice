CREATE TABLE "organization_mail_template" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"subject" text,
	"body_intro" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_sso_provider" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"protocol" text DEFAULT 'oidc' NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"discovery_url" text,
	"scopes" text,
	"email_domain" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "organization_mail_template_key" ON "organization_mail_template" ("organization_id","template_key","language");--> statement-breakpoint
CREATE INDEX "organization_mail_template_org_idx" ON "organization_mail_template" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_sso_provider_provider_key" ON "organization_sso_provider" ("provider_id");--> statement-breakpoint
CREATE INDEX "organization_sso_provider_org_idx" ON "organization_sso_provider" ("organization_id");--> statement-breakpoint
CREATE INDEX "organization_sso_provider_email_domain_idx" ON "organization_sso_provider" ("email_domain");--> statement-breakpoint
ALTER TABLE "organization_mail_template" ADD CONSTRAINT "organization_mail_template_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "organization_sso_provider" ADD CONSTRAINT "organization_sso_provider_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;