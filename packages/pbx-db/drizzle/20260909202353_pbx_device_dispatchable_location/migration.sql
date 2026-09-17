ALTER TABLE "device" ADD COLUMN "emergency_address_id" uuid;--> statement-breakpoint
ALTER TABLE "device" ADD COLUMN "emergency_location_detail" text;--> statement-breakpoint
CREATE INDEX "device_organization_emergency_address_idx" ON "device" ("organization_id","emergency_address_id");--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_emergency_address_id_emergency_address_id_fkey" FOREIGN KEY ("emergency_address_id") REFERENCES "emergency_address"("id") ON DELETE SET NULL;