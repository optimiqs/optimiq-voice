CREATE TABLE "organization_kyc" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"legal_entity_name" text NOT NULL,
	"entity_type" text NOT NULL,
	"tax_id" text,
	"tax_id_last4" text,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"address_city" text NOT NULL,
	"address_region" text,
	"address_postal_code" text,
	"address_country" text NOT NULL,
	"contact_name" text NOT NULL,
	"contact_email" text NOT NULL,
	"contact_phone" text,
	"website_url" text,
	"expected_traffic_profile" text,
	"expected_monthly_minutes" integer,
	"decision" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_kyc_decision_check" CHECK ("decision" in ('pending', 'approved', 'rejected', 'needs-info')),
	CONSTRAINT "organization_kyc_entity_type_check" CHECK ("entity_type" in ('sole-proprietor', 'partnership', 'private-company', 'public-company', 'non-profit', 'government')),
	CONSTRAINT "organization_kyc_expected_minutes_check" CHECK (expected_monthly_minutes is null or expected_monthly_minutes >= 0)
);
--> statement-breakpoint
ALTER TABLE "organization_kyc" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "verified_caller_id" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"label" text,
	"verification_method" text NOT NULL,
	"verification_reference" text,
	"evidence_object_key" text,
	"verified_by" uuid,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verified_caller_id_method_check" CHECK ("verification_method" in ('document', 'call-back', 'carrier-loa'))
);
--> statement-breakpoint
ALTER TABLE "verified_caller_id" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_kyc_organization_key" ON "organization_kyc" ("organization_id");--> statement-breakpoint
CREATE INDEX "organization_kyc_decision_idx" ON "organization_kyc" ("decision","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verified_caller_id_organization_e164_key" ON "verified_caller_id" ("organization_id","e164");--> statement-breakpoint
CREATE POLICY "organization_kyc_tenant_isolation" ON "organization_kyc" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "verified_caller_id_tenant_isolation" ON "verified_caller_id" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);