ALTER TABLE "conference" ADD COLUMN "record_policy" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "conference" ADD COLUMN "entry_tone_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "conference" ADD COLUMN "exit_tone_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Carry the boolean forward before it goes. `record_enabled = true` meant "record this room", and
-- the member of RECORD_POLICIES that says exactly that is `all`: every leg in a conference is
-- inbound TO the room, so `inbound` and `all` behave identically here and `all` is the one that
-- keeps meaning the same thing if a room ever originates a leg of its own.
--
-- Ordered before the DROP on purpose: a backfill that ran afterwards would be reading a column that
-- no longer exists, and this is the only statement in the file whose position matters. The same
-- shape, and the same reason, as 20260812103654's `queue` conversion.
UPDATE "conference" SET "record_policy" = 'all' WHERE "record_enabled" = true;--> statement-breakpoint
ALTER TABLE "conference" DROP COLUMN "record_enabled";
