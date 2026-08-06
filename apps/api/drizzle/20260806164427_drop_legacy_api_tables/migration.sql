DROP POLICY "applications_tenant_isolation" ON "applications";--> statement-breakpoint
DROP POLICY "intelligence_services_tenant_isolation" ON "intelligence_services";--> statement-breakpoint
DROP POLICY "secrets_tenant_isolation" ON "secrets";--> statement-breakpoint
DROP POLICY "stt_services_tenant_isolation" ON "stt_services";--> statement-breakpoint
DROP POLICY "tts_services_tenant_isolation" ON "tts_services";--> statement-breakpoint
ALTER TABLE "intelligence_services" DROP CONSTRAINT "intelligence_services_application_ref_fkey";--> statement-breakpoint
ALTER TABLE "intelligence_services" DROP CONSTRAINT "intelligence_services_product_ref_fkey";--> statement-breakpoint
ALTER TABLE "stt_services" DROP CONSTRAINT "stt_services_application_ref_fkey";--> statement-breakpoint
ALTER TABLE "stt_services" DROP CONSTRAINT "stt_services_product_ref_fkey";--> statement-breakpoint
ALTER TABLE "tts_services" DROP CONSTRAINT "tts_services_application_ref_fkey";--> statement-breakpoint
ALTER TABLE "tts_services" DROP CONSTRAINT "tts_services_product_ref_fkey";--> statement-breakpoint
DROP TABLE "applications";--> statement-breakpoint
DROP TABLE "intelligence_services";--> statement-breakpoint
DROP TABLE "products";--> statement-breakpoint
DROP TABLE "secrets";--> statement-breakpoint
DROP TABLE "stt_services";--> statement-breakpoint
DROP TABLE "tts_services";--> statement-breakpoint
DROP TYPE "application_types";--> statement-breakpoint
DROP TYPE "product_types";--> statement-breakpoint
DROP TYPE "product_vendors";