ALTER TABLE "call_legs" ADD COLUMN "expected_attestation" text;--> statement-breakpoint
ALTER TABLE "call_legs" ADD COLUMN "caller_id_right_to_use" text;--> statement-breakpoint
ALTER TABLE "call_legs" ADD COLUMN "trunk_ref" uuid;--> statement-breakpoint
ALTER TABLE "call_legs" ADD COLUMN "signaling_address" text;--> statement-breakpoint
CREATE INDEX "call_legs_traceback_to_idx" ON "call_legs" ("to_number","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "call_legs_traceback_from_idx" ON "call_legs" ("from_number","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "call_legs_trunk_idx" ON "call_legs" ("trunk_ref","started_at" DESC NULLS LAST) WHERE trunk_ref is not null;