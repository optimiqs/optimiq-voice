ALTER TABLE "call_legs" ADD COLUMN "recording_consent" text;--> statement-breakpoint
ALTER TABLE "call_legs" ADD COLUMN "recording_consent_method" text;--> statement-breakpoint
ALTER TABLE "call_legs" ADD COLUMN "recording_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call_legs" ADD COLUMN "recording_consent_regions" jsonb;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "consent" jsonb;