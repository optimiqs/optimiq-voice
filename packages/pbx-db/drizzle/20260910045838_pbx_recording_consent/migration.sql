ALTER TABLE "extension" ADD COLUMN "record_auto_pause_on_dtmf" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "recording_consent_policy" text;--> statement-breakpoint
ALTER TABLE "phone_number" ADD COLUMN "recording_consent_prompt_id" uuid;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "record_auto_pause_on_dtmf" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_route" ADD COLUMN "recording_consent_policy" text;--> statement-breakpoint
ALTER TABLE "inbound_route" ADD COLUMN "recording_consent_prompt_id" uuid;--> statement-breakpoint
ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_recording_consent_prompt_id_prompt_id_fkey" FOREIGN KEY ("recording_consent_prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "inbound_route" ADD CONSTRAINT "inbound_route_recording_consent_prompt_id_prompt_id_fkey" FOREIGN KEY ("recording_consent_prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_recording_consent_policy_check" CHECK (recording_consent_policy is null or recording_consent_policy in ('none', 'announce', 'announce-and-require-keypress'));--> statement-breakpoint
ALTER TABLE "inbound_route" ADD CONSTRAINT "inbound_route_recording_consent_policy_check" CHECK (recording_consent_policy is null or recording_consent_policy in ('none', 'announce', 'announce-and-require-keypress'));