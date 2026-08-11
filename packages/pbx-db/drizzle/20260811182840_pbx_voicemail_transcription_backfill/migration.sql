ALTER TABLE "voicemail_message" ADD COLUMN "transcription_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "voicemail_message" ADD COLUMN "transcription_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voicemail_message" ADD COLUMN "email_sent_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "voicemail_message_transcription_sweep_idx" ON "voicemail_message" ("transcription_status","transcription_claimed_at") WHERE transcription_status in ('pending', 'failed');