ALTER TABLE "device_line" ADD COLUMN "home_extension_id" uuid;--> statement-breakpoint
ALTER TABLE "device_line" ADD COLUMN "hot_desk_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "device_line" ADD COLUMN "hot_desk_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extension" ADD COLUMN "hot_desk_pin_set_id" uuid;--> statement-breakpoint
CREATE INDEX "device_line_organization_hot_desk_expires_idx" ON "device_line" ("organization_id","hot_desk_expires_at");--> statement-breakpoint
CREATE INDEX "extension_organization_hot_desk_pin_set_idx" ON "extension" ("organization_id","hot_desk_pin_set_id");--> statement-breakpoint
ALTER TABLE "device_line" ADD CONSTRAINT "device_line_home_extension_id_extension_id_fkey" FOREIGN KEY ("home_extension_id") REFERENCES "extension"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "extension" ADD CONSTRAINT "extension_hot_desk_pin_set_id_pin_set_id_fkey" FOREIGN KEY ("hot_desk_pin_set_id") REFERENCES "pin_set"("id") ON DELETE SET NULL;