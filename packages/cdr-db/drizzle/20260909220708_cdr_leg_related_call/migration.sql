ALTER TABLE "call_legs" ADD COLUMN "related_call_id" uuid;--> statement-breakpoint
CREATE INDEX "call_legs_related_call_idx" ON "call_legs" ("related_call_id") WHERE "related_call_id" is not null;