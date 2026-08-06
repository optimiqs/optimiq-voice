CREATE TABLE "cdr_write_quarantine" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid,
	"stream" text NOT NULL,
	"subject" text NOT NULL,
	"stream_sequence" bigint,
	"delivery_count" integer DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"detail" text NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cdr_write_quarantine_reason_check" CHECK ("reason" in ('unreadable', 'foreign-subject', 'rejected', 'exhausted')),
	CONSTRAINT "cdr_write_quarantine_delivery_check" CHECK ("delivery_count" >= 1)
);
--> statement-breakpoint
CREATE INDEX "cdr_write_quarantine_at_idx" ON "cdr_write_quarantine" ("quarantined_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cdr_write_quarantine_organization_idx" ON "cdr_write_quarantine" ("organization_id");