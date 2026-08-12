CREATE TABLE "cdr_export_job" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"requested_by" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"filters" jsonb DEFAULT '{}' NOT NULL,
	"range_from" timestamp with time zone NOT NULL,
	"range_to" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"object_key" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"failure_detail" text,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cdr_export_job_status_check" CHECK ("status" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "cdr_export_job_failure_check" CHECK ("failure_reason" is null or "failure_reason" in ('too-many-rows', 'storage', 'internal')),
	CONSTRAINT "cdr_export_job_range_check" CHECK ("range_to" > "range_from"),
	CONSTRAINT "cdr_export_job_size_check" CHECK ("row_count" >= 0 and "size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "cdr_export_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "cdr_export_job_pending_idx" ON "cdr_export_job" ("created_at") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "cdr_export_job_organization_created_idx" ON "cdr_export_job" ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cdr_export_job_expiry_idx" ON "cdr_export_job" ("expires_at") WHERE object_key is not null and expires_at is not null;--> statement-breakpoint
CREATE POLICY "cdr_export_job_tenant_isolation" ON "cdr_export_job" AS PERMISSIVE FOR ALL TO "cdr_tenant_tls" USING (organization_id = nullif(current_setting('cdr_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('cdr_tenant_tls.organization_id', true), '')::uuid);