ALTER TABLE "device_profile_key" DROP CONSTRAINT "device_profile_key_device_profile_id_device_profile_id_fkey";--> statement-breakpoint
ALTER TABLE "extension_user" DROP CONSTRAINT "extension_user_extension_id_extension_id_fkey";--> statement-breakpoint
ALTER TABLE "paging_group_member" DROP CONSTRAINT "paging_group_member_paging_group_id_paging_group_id_fkey";--> statement-breakpoint
ALTER TABLE "paging_group_member" DROP CONSTRAINT "paging_group_member_extension_id_extension_id_fkey";--> statement-breakpoint
ALTER TABLE "pin_set_entry" DROP CONSTRAINT "pin_set_entry_pin_set_id_pin_set_id_fkey";--> statement-breakpoint
ALTER TABLE "sip_acl_entry" DROP CONSTRAINT "sip_acl_entry_trunk_id_trunk_id_fkey";--> statement-breakpoint
ALTER TABLE "shared_line_appearance" DROP CONSTRAINT "shared_line_appearance_shared_line_id_shared_line_id_fkey";--> statement-breakpoint
ALTER TABLE "shared_line_appearance" DROP CONSTRAINT "shared_line_appearance_extension_id_extension_id_fkey";--> statement-breakpoint
CREATE UNIQUE INDEX "device_profile_organization_id_key" ON "device_profile" ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "extension_organization_id_key" ON "extension" ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "paging_group_organization_id_key" ON "paging_group" ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pin_set_organization_id_key" ON "pin_set" ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_line_organization_id_key" ON "shared_line" ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "trunk_organization_id_key" ON "trunk" ("organization_id","id");--> statement-breakpoint
ALTER TABLE "device_profile_key" ADD CONSTRAINT "device_profile_key_device_profile_fk" FOREIGN KEY ("organization_id","device_profile_id") REFERENCES "device_profile"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "extension_user" ADD CONSTRAINT "extension_user_extension_fk" FOREIGN KEY ("organization_id","extension_id") REFERENCES "extension"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "paging_group_member" ADD CONSTRAINT "paging_group_member_paging_group_fk" FOREIGN KEY ("organization_id","paging_group_id") REFERENCES "paging_group"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "paging_group_member" ADD CONSTRAINT "paging_group_member_extension_fk" FOREIGN KEY ("organization_id","extension_id") REFERENCES "extension"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pin_set_entry" ADD CONSTRAINT "pin_set_entry_pin_set_fk" FOREIGN KEY ("organization_id","pin_set_id") REFERENCES "pin_set"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sip_acl_entry" ADD CONSTRAINT "sip_acl_entry_trunk_fk" FOREIGN KEY ("organization_id","trunk_id") REFERENCES "trunk"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "shared_line_appearance" ADD CONSTRAINT "shared_line_appearance_shared_line_fk" FOREIGN KEY ("organization_id","shared_line_id") REFERENCES "shared_line"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "shared_line_appearance" ADD CONSTRAINT "shared_line_appearance_extension_fk" FOREIGN KEY ("organization_id","extension_id") REFERENCES "extension"("organization_id","id") ON DELETE CASCADE;