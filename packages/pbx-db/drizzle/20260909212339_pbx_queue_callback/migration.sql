ALTER TABLE "queue" ADD COLUMN "callback_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "callback_key" text;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "callback_offer_after_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "callback_offer_prompt_id" uuid;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "callback_confirm_prompt_id" uuid;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "callback_max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "callback_retry_delay_seconds" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "callback_expires_after_seconds" integer DEFAULT 3600 NOT NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_callback_offer_prompt_id_prompt_id_fkey" FOREIGN KEY ("callback_offer_prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_callback_confirm_prompt_id_prompt_id_fkey" FOREIGN KEY ("callback_confirm_prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_callback_key_shape_check" CHECK (callback_key is null or callback_key ~ '^[0-9*#A-D]$');