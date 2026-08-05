-- HAND-EDITED: roles are cluster-wide, and the CDR database shares a cluster with the PBX
-- database in every environment, so creation must tolerate a role that already exists.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cdr_tenant_tls') THEN
		CREATE ROLE "cdr_tenant_tls" WITH NOINHERIT;
	END IF;
END
$$;--> statement-breakpoint
CREATE TABLE "call_legs" (
	"id" uuid,
	"organization_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"leg" text NOT NULL,
	"originating_leg_id" uuid,
	"bridge_leg_id" uuid,
	"direction" text NOT NULL,
	"sip_call_id" text,
	"from_number" text NOT NULL,
	"from_name" text,
	"to_number" text NOT NULL,
	"destination_type" text NOT NULL,
	"destination_ref" uuid,
	"routing_context" text,
	"application_ref" uuid,
	"queue_ref" uuid,
	"ivr_ref" uuid,
	"ring_group_ref" uuid,
	"account_code" text,
	"started_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"billsec_ms" integer DEFAULT 0 NOT NULL,
	"pdd_ms" integer,
	"hangup_cause" text DEFAULT 'NONE' NOT NULL,
	"hangup_cause_code" smallint DEFAULT 0 NOT NULL,
	"hangup_side" text,
	"disposition" text NOT NULL,
	"read_codec" text,
	"write_codec" text,
	"remote_media_address" text,
	"mos" numeric(4,2),
	"jitter_ms" numeric(8,2),
	"packet_loss_pct" numeric(5,2),
	"recording_key" text,
	"transcription_status" text DEFAULT 'none' NOT NULL,
	"raw" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_legs_pkey" PRIMARY KEY("id","started_at"),
	CONSTRAINT "call_legs_leg_check" CHECK ("leg" in ('a', 'b')),
	CONSTRAINT "call_legs_direction_check" CHECK ("direction" in ('inbound', 'outbound', 'internal')),
	CONSTRAINT "call_legs_destination_type_check" CHECK ("destination_type" in ('extension', 'queue', 'ivr', 'ring_group', 'voicemail', 'conference', 'trunk', 'external', 'application', 'time_condition', 'park', 'unknown')),
	CONSTRAINT "call_legs_hangup_cause_check" CHECK ("hangup_cause" in ('NONE', 'UNALLOCATED_NUMBER', 'NO_ROUTE_TRANSIT_NET', 'NO_ROUTE_DESTINATION', 'CHANNEL_UNACCEPTABLE', 'CALL_AWARDED_DELIVERED', 'NORMAL_CLEARING', 'USER_BUSY', 'NO_USER_RESPONSE', 'NO_ANSWER', 'SUBSCRIBER_ABSENT', 'CALL_REJECTED', 'NUMBER_CHANGED', 'REDIRECTION_TO_NEW_DESTINATION', 'EXCHANGE_ROUTING_ERROR', 'DESTINATION_OUT_OF_ORDER', 'INVALID_NUMBER_FORMAT', 'FACILITY_REJECTED', 'RESPONSE_TO_STATUS_ENQUIRY', 'NORMAL_UNSPECIFIED', 'NORMAL_CIRCUIT_CONGESTION', 'NETWORK_OUT_OF_ORDER', 'NORMAL_TEMPORARY_FAILURE', 'SWITCH_CONGESTION', 'ACCESS_INFO_DISCARDED', 'REQUESTED_CHAN_UNAVAIL', 'PRE_EMPTED', 'FACILITY_NOT_SUBSCRIBED', 'OUTGOING_CALL_BARRED', 'INCOMING_CALL_BARRED', 'BEARERCAPABILITY_NOTAUTH', 'BEARERCAPABILITY_NOTAVAIL', 'SERVICE_UNAVAILABLE', 'BEARERCAPABILITY_NOTIMPL', 'CHAN_NOT_IMPLEMENTED', 'FACILITY_NOT_IMPLEMENTED', 'SERVICE_NOT_IMPLEMENTED', 'INVALID_CALL_REFERENCE', 'INCOMPATIBLE_DESTINATION', 'INVALID_MSG_UNSPECIFIED', 'MANDATORY_IE_MISSING', 'MESSAGE_TYPE_NONEXIST', 'WRONG_MESSAGE', 'IE_NONEXIST', 'INVALID_IE_CONTENTS', 'WRONG_CALL_STATE', 'RECOVERY_ON_TIMER_EXPIRE', 'MANDATORY_IE_LENGTH_ERROR', 'PROTOCOL_ERROR', 'INTERWORKING', 'ORIGINATOR_CANCEL', 'LOSE_RACE', 'BLIND_TRANSFER', 'ATTENDED_TRANSFER', 'ALLOTTED_TIMEOUT', 'USER_CHALLENGE', 'MEDIA_TIMEOUT', 'PICKED_OFF', 'USER_NOT_REGISTERED', 'PROGRESS_TIMEOUT', 'INVALID_GATEWAY', 'GATEWAY_DOWN', 'INVALID_URL', 'INVALID_PROFILE', 'NO_PICKUP', 'SRTP_READ_ERROR')),
	CONSTRAINT "call_legs_hangup_side_check" CHECK ("hangup_side" in ('caller', 'callee', 'system')),
	CONSTRAINT "call_legs_disposition_check" CHECK ("disposition" in ('answered', 'no-answer', 'busy', 'failed', 'voicemail')),
	CONSTRAINT "call_legs_transcription_status_check" CHECK ("transcription_status" in ('none', 'pending', 'processing', 'completed', 'failed')),
	CONSTRAINT "call_legs_duration_check" CHECK ("duration_ms" >= 0 and "billsec_ms" >= 0)
) PARTITION BY RANGE ("started_at");
--> statement-breakpoint
ALTER TABLE "call_legs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "call_events" (
	"id" uuid,
	"organization_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"leg_id" uuid NOT NULL,
	"event" text NOT NULL,
	"at" timestamp with time zone,
	"data" jsonb DEFAULT '{}' NOT NULL,
	CONSTRAINT "call_events_pkey" PRIMARY KEY("id","at"),
	CONSTRAINT "call_events_event_check" CHECK ("event" in ('created', 'routing', 'progress', 'early-media', 'answered', 'bridged', 'unbridged', 'held', 'unheld', 'parked', 'unparked', 'dtmf', 'transfer', 'record-started', 'record-stopped', 'playback-started', 'playback-stopped', 'queue-joined', 'queue-answered', 'queue-abandoned', 'voicemail-left', 'hangup'))
) PARTITION BY RANGE ("at");
--> statement-breakpoint
ALTER TABLE "call_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"call_id" uuid,
	"leg_id" uuid,
	"kind" text NOT NULL,
	"object_key" text NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"retention_until" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recordings_kind_check" CHECK ("kind" in ('call', 'voicemail', 'conference')),
	CONSTRAINT "recordings_size_check" CHECK ("duration_ms" >= 0 and "size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "recordings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "call_legs_organization_started_idx" ON "call_legs" ("organization_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "call_legs_call_idx" ON "call_legs" ("call_id");--> statement-breakpoint
CREATE INDEX "call_legs_organization_from_idx" ON "call_legs" ("organization_id","from_number");--> statement-breakpoint
CREATE INDEX "call_legs_organization_to_idx" ON "call_legs" ("organization_id","to_number");--> statement-breakpoint
CREATE INDEX "call_legs_recording_idx" ON "call_legs" ("organization_id","started_at" DESC NULLS LAST) WHERE recording_key is not null;--> statement-breakpoint
CREATE INDEX "call_events_organization_at_idx" ON "call_events" ("organization_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "call_events_leg_idx" ON "call_events" ("leg_id","at");--> statement-breakpoint
CREATE INDEX "call_events_call_idx" ON "call_events" ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_object_key_key" ON "recordings" ("object_key");--> statement-breakpoint
CREATE INDEX "recordings_organization_created_idx" ON "recordings" ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recordings_call_idx" ON "recordings" ("call_id");--> statement-breakpoint
CREATE INDEX "recordings_leg_idx" ON "recordings" ("leg_id");--> statement-breakpoint
CREATE INDEX "recordings_retention_idx" ON "recordings" ("retention_until") WHERE deleted_at is null and retention_until is not null;--> statement-breakpoint
CREATE POLICY "call_legs_tenant_select" ON "call_legs" AS PERMISSIVE FOR SELECT TO "cdr_tenant_tls" USING (organization_id = nullif(current_setting('cdr_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "call_legs_tenant_insert" ON "call_legs" AS PERMISSIVE FOR INSERT TO "cdr_tenant_tls" WITH CHECK (organization_id = nullif(current_setting('cdr_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "call_events_tenant_select" ON "call_events" AS PERMISSIVE FOR SELECT TO "cdr_tenant_tls" USING (organization_id = nullif(current_setting('cdr_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "call_events_tenant_insert" ON "call_events" AS PERMISSIVE FOR INSERT TO "cdr_tenant_tls" WITH CHECK (organization_id = nullif(current_setting('cdr_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "recordings_tenant_isolation" ON "recordings" AS PERMISSIVE FOR ALL TO "cdr_tenant_tls" USING (organization_id = nullif(current_setting('cdr_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('cdr_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
-- ============================================================================================
-- HAND-WRITTEN BLOCK — everything below this line is invisible to drizzle-kit.
--
-- drizzle-orm 1.0.0-rc.4 cannot declare `PARTITION BY`, partitions, functions or grants, so the
-- statements below are maintained by hand and pinned by specs instead of by the snapshot:
--   · src/partitions.spec.ts             — partition naming/range/DDL text
--   · src/cdr-partitioning.integration.spec.ts — live relkind, bounds, routing, functions
--   · src/cdr-tenant-rls.integration.spec.ts   — grants, policies, append-only enforcement
--
-- When regenerating this journal, re-apply: (1) the `PARTITION BY RANGE` clauses on `call_legs`
-- and `call_events`, (2) the idempotent role guard, (3) this whole block.
-- ============================================================================================

-- Idempotent monthly-partition factory. `table_name` is checked against a hard-coded allow-list
-- so the function can never be steered at an arbitrary relation.
CREATE OR REPLACE FUNCTION cdr_ensure_monthly_partition(table_name text, month_start date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	partition_name text;
	range_start date;
	range_end date;
BEGIN
	IF table_name NOT IN ('call_legs', 'call_events') THEN
		RAISE EXCEPTION 'cdr_ensure_monthly_partition: % is not a partitioned CDR table', table_name
			USING ERRCODE = 'invalid_parameter_value';
	END IF;

	range_start := date_trunc('month', month_start)::date;
	range_end := (range_start + interval '1 month')::date;
	partition_name := format('%s_%s', table_name, to_char(range_start, 'YYYY_MM'));

	IF to_regclass(format('public.%I', partition_name)) IS NOT NULL THEN
		RETURN partition_name;
	END IF;

	BEGIN
		EXECUTE format(
			'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
			partition_name, table_name, range_start, range_end
		);
	EXCEPTION
		-- Two writers can race here; losing the race is success.
		WHEN duplicate_table THEN NULL;
	END;

	RETURN partition_name;
END;
$$;--> statement-breakpoint

-- Drops every monthly partition whose upper bound is at or below `cutoff`. The DEFAULT partition
-- is never dropped: without it an out-of-horizon insert would fail instead of landing somewhere.
CREATE OR REPLACE FUNCTION cdr_drop_partitions_before(table_name text, cutoff date)
RETURNS SETOF text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
	partition record;
	upper_bound date;
	boundary date;
BEGIN
	IF table_name NOT IN ('call_legs', 'call_events') THEN
		RAISE EXCEPTION 'cdr_drop_partitions_before: % is not a partitioned CDR table', table_name
			USING ERRCODE = 'invalid_parameter_value';
	END IF;

	boundary := date_trunc('month', cutoff)::date;

	FOR partition IN
		SELECT child.relname AS name, pg_get_expr(child.relpartbound, child.oid) AS bound
		FROM pg_inherits
		JOIN pg_class AS parent ON parent.oid = pg_inherits.inhparent
		JOIN pg_class AS child ON child.oid = pg_inherits.inhrelid
		JOIN pg_namespace AS ns ON ns.oid = parent.relnamespace
		WHERE ns.nspname = 'public' AND parent.relname = table_name
		ORDER BY child.relname
	LOOP
		CONTINUE WHEN partition.bound IS NULL OR partition.bound = 'DEFAULT';
		upper_bound := (regexp_match(partition.bound, 'TO \(''([^'']+)''\)'))[1]::date;
		CONTINUE WHEN upper_bound IS NULL OR upper_bound > boundary;
		EXECUTE format('DROP TABLE %I', partition.name);
		RETURN NEXT partition.name;
	END LOOP;
END;
$$;--> statement-breakpoint

-- The functions do privileged DDL; only the schema owner may call them.
REVOKE ALL ON FUNCTION cdr_ensure_monthly_partition(text, date) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION cdr_drop_partitions_before(text, date) FROM PUBLIC;--> statement-breakpoint

-- Catch-all partitions: an insert outside the ensured horizon must never fail. The retention
-- sweep skips them, so anything that lands here is visible as an operational signal.
CREATE TABLE IF NOT EXISTS "call_legs_default" PARTITION OF "call_legs" DEFAULT;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "call_events_default" PARTITION OF "call_events" DEFAULT;--> statement-breakpoint

-- Current and next month, so a call spanning midnight on the last day of a month never lands in
-- the default partition. The rolling horizon is extended by `scripts/ensure-partitions.ts`.
SELECT cdr_ensure_monthly_partition('call_legs', date_trunc('month', current_date)::date);--> statement-breakpoint
SELECT cdr_ensure_monthly_partition('call_legs', (date_trunc('month', current_date) + interval '1 month')::date);--> statement-breakpoint
SELECT cdr_ensure_monthly_partition('call_events', date_trunc('month', current_date)::date);--> statement-breakpoint
SELECT cdr_ensure_monthly_partition('call_events', (date_trunc('month', current_date) + interval '1 month')::date);--> statement-breakpoint

-- Tenant privileges. Partitions get no grants at all: the tenant role can only reach rows through
-- the parent table, where the parent's policies apply. `call_legs` / `call_events` are append-only
-- by privilege, not merely by policy — there is no UPDATE or DELETE to revoke later.
GRANT USAGE ON SCHEMA "public" TO "cdr_tenant_tls";--> statement-breakpoint
GRANT SELECT, INSERT ON "call_legs" TO "cdr_tenant_tls";--> statement-breakpoint
GRANT SELECT, INSERT ON "call_events" TO "cdr_tenant_tls";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "recordings" TO "cdr_tenant_tls";
