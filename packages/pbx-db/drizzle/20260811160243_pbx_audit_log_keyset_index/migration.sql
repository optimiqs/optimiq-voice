DROP INDEX "audit_log_organization_occurred_idx";--> statement-breakpoint
CREATE INDEX "audit_log_organization_occurred_idx" ON "audit_log" ("organization_id","occurred_at","id");