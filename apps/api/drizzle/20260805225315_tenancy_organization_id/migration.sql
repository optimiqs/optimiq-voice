ALTER TABLE "applications" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "intelligence_services" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "stt_services" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "tts_services" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
CREATE INDEX "applications_organization_id_idx" ON "applications" ("organization_id");--> statement-breakpoint
CREATE INDEX "intelligence_services_organization_id_idx" ON "intelligence_services" ("organization_id");--> statement-breakpoint
CREATE INDEX "secrets_organization_id_idx" ON "secrets" ("organization_id");--> statement-breakpoint
CREATE INDEX "stt_services_organization_id_idx" ON "stt_services" ("organization_id");--> statement-breakpoint
CREATE INDEX "tts_services_organization_id_idx" ON "tts_services" ("organization_id");