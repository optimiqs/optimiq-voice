CREATE TABLE "legacy_user_account" (
	"access_key_id" text PRIMARY KEY,
	"user_ref" text NOT NULL,
	"user_id" uuid NOT NULL,
	"password_migrated" boolean DEFAULT true NOT NULL,
	"migrated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legacy_workspace_organization" (
	"access_key_id" text PRIMARY KEY,
	"workspace_ref" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"migrated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_user_account_user_ref_key" ON "legacy_user_account" ("user_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_user_account_user_key" ON "legacy_user_account" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_workspace_organization_workspace_ref_key" ON "legacy_workspace_organization" ("workspace_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_workspace_organization_organization_key" ON "legacy_workspace_organization" ("organization_id");--> statement-breakpoint
CREATE INDEX "legacy_workspace_organization_migrated_idx" ON "legacy_workspace_organization" ("migrated_at");--> statement-breakpoint
ALTER TABLE "legacy_user_account" ADD CONSTRAINT "legacy_user_account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legacy_workspace_organization" ADD CONSTRAINT "legacy_workspace_organization_DclEyXdcvHot_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;