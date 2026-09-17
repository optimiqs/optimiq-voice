ALTER TABLE "queue" ADD COLUMN "record_policy" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "exit_key" text;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "exit_destination_type" text;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "exit_destination_ref" uuid;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "exit_destination_data" jsonb;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "default_priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "queue_tier" ADD COLUMN "announce_prompt_id" uuid;--> statement-breakpoint
-- Carry the boolean forward before it goes. `record_enabled = true` meant "record this queue's
-- calls", and the member of RECORD_POLICIES that says exactly that is `all`; the queue's calls are
-- all inbound to the queue, so `inbound` and `all` would behave identically here and `all` is the
-- one that keeps meaning the same thing if an agent callback is ever attributed to the queue.
--
-- Ordered before the DROP on purpose: a backfill that ran afterwards would be reading a column that
-- no longer exists, and this is the only statement in the file whose position matters.
UPDATE "queue" SET "record_policy" = 'all' WHERE "record_enabled" = true;--> statement-breakpoint
ALTER TABLE "queue" DROP COLUMN "record_enabled";--> statement-breakpoint
ALTER TABLE "queue_tier" ADD CONSTRAINT "queue_tier_announce_prompt_id_prompt_id_fkey" FOREIGN KEY ("announce_prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_exit_destination_shape_check" CHECK ((exit_destination_type is null and exit_destination_ref is null and exit_destination_data is null) or (exit_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'paging-group', 'time-condition', 'call-flow', 'stream', 'dial-by-name', 'alias') and exit_destination_ref is not null) or (exit_destination_type in ('external', 'application') and exit_destination_ref is null and exit_destination_data is not null) or (exit_destination_type = 'hangup' and exit_destination_ref is null));--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_exit_key_shape_check" CHECK (exit_key is null or exit_key ~ '^[0-9*#A-D]$');--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_default_priority_range_check" CHECK (default_priority between 0 and 1000);
