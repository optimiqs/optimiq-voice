ALTER TABLE "phone_number" ADD COLUMN "carrier_provider" text;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "carrier_ref" text;--> statement-breakpoint
ALTER TABLE "trunk" ADD COLUMN "carrier_provider" text;--> statement-breakpoint
ALTER TABLE "trunk" ADD COLUMN "carrier_ref" text;--> statement-breakpoint
ALTER TABLE "trunk" ADD COLUMN "carrier_profile_ref" text;--> statement-breakpoint
CREATE INDEX "phone_number_organization_carrier_idx" ON "phone_number" ("organization_id","carrier_provider","carrier_ref");--> statement-breakpoint
CREATE INDEX "trunk_organization_carrier_idx" ON "trunk" ("organization_id","carrier_provider","carrier_ref");--> statement-breakpoint
ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_carrier_shape_check" CHECK ((carrier_provider is null and carrier_ref is null) or (carrier_provider is not null and carrier_ref is not null));--> statement-breakpoint
ALTER TABLE "trunk" ADD CONSTRAINT "trunk_carrier_shape_check" CHECK ((carrier_provider is null and carrier_ref is null) or (carrier_provider is not null and carrier_ref is not null));