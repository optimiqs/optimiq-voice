-- HAND-EDITED (comment only). `call_legs` is partitioned, so each statement here recurses into
-- every partition. The three ADD COLUMNs are metadata-only (nullable, no default) and are cheap on
-- any history; the two CHECKs take an ACCESS EXCLUSIVE lock per partition while they validate, and
-- both are trivially satisfiable by every existing row because the columns they constrain were NULL
-- a statement ago. The index is created per partition too — see the note in
-- 20260812070434_cdr_paging_destination_type for why partitioned DDL is worth being explicit about.
--
-- Nothing is backfilled. A queue call that ended before this migration has no recorded outcome and
-- never will: the facts were published on `queue.evt.v1.*` and were never written to a row, so
-- inventing them from `destination_type = 'queue'` would produce a service level for a period the
-- platform did not measure. Reports over a window that predates this deploy will show fewer offered
-- calls, which is the honest shape of "we started measuring on this date".
ALTER TABLE "call_legs" ADD COLUMN "queue_wait_ms" integer;--> statement-breakpoint
ALTER TABLE "call_legs" ADD COLUMN "queue_outcome" text;--> statement-breakpoint
ALTER TABLE "call_legs" ADD COLUMN "queue_agent_ref" uuid;--> statement-breakpoint
CREATE INDEX "call_legs_queue_idx" ON "call_legs" ("organization_id","queue_ref","started_at" DESC NULLS LAST) WHERE queue_outcome is not null;--> statement-breakpoint
ALTER TABLE "call_legs" ADD CONSTRAINT "call_legs_queue_outcome_check" CHECK ("queue_outcome" in ('answered', 'caller-hangup', 'timeout', 'overflow', 'no-agents', 'exit-key'));--> statement-breakpoint
ALTER TABLE "call_legs" ADD CONSTRAINT "call_legs_queue_wait_check" CHECK ("queue_wait_ms" is null or "queue_wait_ms" >= 0);