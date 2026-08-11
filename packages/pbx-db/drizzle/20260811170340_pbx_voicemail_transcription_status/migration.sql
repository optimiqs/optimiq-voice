ALTER TABLE "voicemail_message" ADD COLUMN "transcription_status" text DEFAULT 'disabled' NOT NULL;--> statement-breakpoint
ALTER TABLE "voicemail_message" ADD COLUMN "transcribed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "voicemail_message_transcription_pending_idx" ON "voicemail_message" ("organization_id","received_at") WHERE transcription_status = 'pending';