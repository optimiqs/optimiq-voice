ALTER TABLE "device" ADD COLUMN "provisioning_token_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "device_provisioning_token_hash_key" ON "device" ("provisioning_token_hash");