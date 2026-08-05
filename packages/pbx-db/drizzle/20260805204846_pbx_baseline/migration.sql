CREATE ROLE "pbx_tenant_tls" WITH NOINHERIT;--> statement-breakpoint
CREATE TABLE "conference" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"room_number" text NOT NULL,
	"pin_hash" text,
	"moderator_pin_hash" text,
	"max_members" integer DEFAULT 50 NOT NULL,
	"record_enabled" boolean DEFAULT false NOT NULL,
	"moh_class_id" uuid,
	"announce_join_leave" boolean DEFAULT true NOT NULL,
	"wait_for_moderator" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "park_lot" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slot_start" integer NOT NULL,
	"slot_end" integer NOT NULL,
	"timeout_seconds" integer DEFAULT 120 NOT NULL,
	"timeout_destination_type" text,
	"timeout_destination_ref" uuid,
	"timeout_destination_data" jsonb,
	"moh_class_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "park_lot_slot_range_check" CHECK (slot_end >= slot_start),
	CONSTRAINT "park_lot_timeout_destination_shape_check" CHECK ((timeout_destination_type is null and timeout_destination_ref is null and timeout_destination_data is null) or (timeout_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'time-condition') and timeout_destination_ref is not null) or (timeout_destination_type in ('external', 'application') and timeout_destination_ref is null and timeout_destination_data is not null) or (timeout_destination_type = 'hangup' and timeout_destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "park_lot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "device" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"mac_address" text NOT NULL,
	"vendor" text DEFAULT 'generic' NOT NULL,
	"model" text,
	"label" text,
	"device_profile_id" uuid,
	"provisioning_token" text NOT NULL,
	"provisioning_token_expires_at" timestamp with time zone,
	"last_provisioned_at" timestamp with time zone,
	"last_provisioned_ip" text,
	"settings" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "device_key" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"category" text DEFAULT 'memory' NOT NULL,
	"key_index" integer NOT NULL,
	"key_type" text DEFAULT 'none' NOT NULL,
	"value" text,
	"label" text,
	"line_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "device_line" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"extension_id" uuid,
	"auth_user" text,
	"sip_secret_ref" text,
	"server_address" text,
	"server_port" integer DEFAULT 5060 NOT NULL,
	"transport" text DEFAULT 'udp' NOT NULL,
	"register_expires_seconds" integer DEFAULT 120 NOT NULL,
	"shared_line" boolean DEFAULT false NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "device_profile" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"vendor" text DEFAULT 'generic' NOT NULL,
	"model" text,
	"settings" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "device_profile_key" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"device_profile_id" uuid NOT NULL,
	"category" text DEFAULT 'memory' NOT NULL,
	"key_index" integer NOT NULL,
	"key_type" text DEFAULT 'none' NOT NULL,
	"value" text,
	"label" text,
	"line_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_profile_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "emergency_address" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"label" text NOT NULL,
	"street_line1" text NOT NULL,
	"street_line2" text,
	"location_detail" text,
	"locality" text NOT NULL,
	"administrative_area" text NOT NULL,
	"postal_code" text NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"validated" boolean DEFAULT false NOT NULL,
	"validated_at" timestamp with time zone,
	"validation_provider" text,
	"validation_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "emergency_address" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "extension" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"label" text NOT NULL,
	"sip_secret_ref" text NOT NULL,
	"sip_password_ha1" text,
	"caller_id_name" text,
	"caller_id_number" text,
	"outbound_caller_id_name" text,
	"outbound_caller_id_number" text,
	"emergency_caller_id_name" text,
	"emergency_caller_id_number" text,
	"voicemail_enabled" boolean DEFAULT true NOT NULL,
	"do_not_disturb" boolean DEFAULT false NOT NULL,
	"forward_all_enabled" boolean DEFAULT false NOT NULL,
	"forward_all_destination" text,
	"forward_busy_enabled" boolean DEFAULT false NOT NULL,
	"forward_busy_destination" text,
	"forward_no_answer_enabled" boolean DEFAULT false NOT NULL,
	"forward_no_answer_destination" text,
	"forward_unregistered_enabled" boolean DEFAULT false NOT NULL,
	"forward_unregistered_destination" text,
	"follow_me" jsonb,
	"record_policy" text DEFAULT 'none' NOT NULL,
	"moh_class_id" uuid,
	"toll_class" text DEFAULT 'national' NOT NULL,
	"call_timeout_seconds" integer DEFAULT 30 NOT NULL,
	"max_registrations" integer DEFAULT 3 NOT NULL,
	"codec_override" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extension" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "extension_user" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"extension_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'primary' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extension_user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "call_block_rule" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"match_kind" text DEFAULT 'exact' NOT NULL,
	"direction" text DEFAULT 'inbound' NOT NULL,
	"action" text DEFAULT 'block' NOT NULL,
	"label" text,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_block_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "feature_code" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"action" text NOT NULL,
	"params" jsonb,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feature_code" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ivr_menu" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"extension_number" text,
	"parent_id" uuid,
	"greeting_prompt_id" uuid,
	"short_greeting_prompt_id" uuid,
	"invalid_prompt_id" uuid,
	"timeout_prompt_id" uuid,
	"digit_timeout_ms" integer DEFAULT 5000 NOT NULL,
	"inter_digit_timeout_ms" integer DEFAULT 2000 NOT NULL,
	"max_digits" integer DEFAULT 1 NOT NULL,
	"max_failures" integer DEFAULT 3 NOT NULL,
	"max_timeouts" integer DEFAULT 3 NOT NULL,
	"direct_dial_enabled" boolean DEFAULT false NOT NULL,
	"timeout_destination_type" text,
	"timeout_destination_ref" uuid,
	"timeout_destination_data" jsonb,
	"invalid_destination_type" text,
	"invalid_destination_ref" uuid,
	"invalid_destination_data" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ivr_menu_timeout_destination_shape_check" CHECK ((timeout_destination_type is null and timeout_destination_ref is null and timeout_destination_data is null) or (timeout_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'time-condition') and timeout_destination_ref is not null) or (timeout_destination_type in ('external', 'application') and timeout_destination_ref is null and timeout_destination_data is not null) or (timeout_destination_type = 'hangup' and timeout_destination_ref is null)),
	CONSTRAINT "ivr_menu_invalid_destination_shape_check" CHECK ((invalid_destination_type is null and invalid_destination_ref is null and invalid_destination_data is null) or (invalid_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'time-condition') and invalid_destination_ref is not null) or (invalid_destination_type in ('external', 'application') and invalid_destination_ref is null and invalid_destination_data is not null) or (invalid_destination_type = 'hangup' and invalid_destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "ivr_menu" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ivr_menu_option" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"ivr_menu_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"match_kind" text DEFAULT 'digit' NOT NULL,
	"match_value" text NOT NULL,
	"label" text,
	"destination_type" text NOT NULL,
	"destination_ref" uuid,
	"destination_data" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ivr_menu_option_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'time-condition') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "ivr_menu_option" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "moh_class" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source" text DEFAULT 'library' NOT NULL,
	"stream_uri" text,
	"shuffle" boolean DEFAULT true NOT NULL,
	"sample_rate_hz" integer DEFAULT 8000 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "moh_class" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "prompt" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'prompt' NOT NULL,
	"moh_class_id" uuid,
	"object_key" text NOT NULL,
	"content_type" text DEFAULT 'audio/wav' NOT NULL,
	"duration_ms" integer,
	"size_bytes" integer,
	"checksum" text,
	"language" text DEFAULT 'en-US' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prompt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "phone_number" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"label" text,
	"destination_type" text NOT NULL,
	"destination_ref" uuid,
	"destination_data" jsonb,
	"caller_id_name_prefix" text,
	"record_enabled" boolean DEFAULT false NOT NULL,
	"emergency_address_id" uuid,
	"voice_enabled" boolean DEFAULT true NOT NULL,
	"fax_enabled" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_number_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'time-condition') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "phone_number" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "queue" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"extension_number" text,
	"strategy" text DEFAULT 'longest-idle' NOT NULL,
	"moh_class_id" uuid,
	"greeting_prompt_id" uuid,
	"announce_prompt_id" uuid,
	"max_wait_seconds" integer DEFAULT 0 NOT NULL,
	"max_wait_no_agent_seconds" integer DEFAULT 0 NOT NULL,
	"wrap_up_seconds" integer DEFAULT 10 NOT NULL,
	"announce_position_enabled" boolean DEFAULT false NOT NULL,
	"announce_frequency_seconds" integer DEFAULT 60 NOT NULL,
	"abandoned_resume_allowed" boolean DEFAULT false NOT NULL,
	"discard_abandoned_after_seconds" integer DEFAULT 60 NOT NULL,
	"tier_rules_apply" boolean DEFAULT true NOT NULL,
	"tier_rule_wait_seconds" integer DEFAULT 30 NOT NULL,
	"tier_rule_no_agent_no_wait" boolean DEFAULT false NOT NULL,
	"record_enabled" boolean DEFAULT false NOT NULL,
	"timeout_destination_type" text,
	"timeout_destination_ref" uuid,
	"timeout_destination_data" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_timeout_destination_shape_check" CHECK ((timeout_destination_type is null and timeout_destination_ref is null and timeout_destination_data is null) or (timeout_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'time-condition') and timeout_destination_ref is not null) or (timeout_destination_type in ('external', 'application') and timeout_destination_ref is null and timeout_destination_data is not null) or (timeout_destination_type = 'hangup' and timeout_destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "queue_agent" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"user_id" uuid,
	"contact_kind" text DEFAULT 'extension' NOT NULL,
	"extension_id" uuid,
	"contact" text,
	"status" text DEFAULT 'logged-out' NOT NULL,
	"status_changed_at" timestamp with time zone,
	"wrap_up_seconds" integer DEFAULT 10 NOT NULL,
	"max_no_answer" integer DEFAULT 3 NOT NULL,
	"no_answer_delay_seconds" integer DEFAULT 30 NOT NULL,
	"busy_delay_seconds" integer DEFAULT 60 NOT NULL,
	"reject_delay_seconds" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "queue_agent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "queue_tier" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"queue_agent_id" uuid NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "queue_tier" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ring_group" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"extension_number" text,
	"strategy" text DEFAULT 'simultaneous' NOT NULL,
	"ring_timeout_seconds" integer DEFAULT 30 NOT NULL,
	"caller_id_name_prefix" text,
	"ignore_busy" boolean DEFAULT true NOT NULL,
	"confirm_enabled" boolean DEFAULT false NOT NULL,
	"confirm_prompt_id" uuid,
	"moh_class_id" uuid,
	"ringback_prompt_id" uuid,
	"timeout_destination_type" text,
	"timeout_destination_ref" uuid,
	"timeout_destination_data" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ring_group_timeout_destination_shape_check" CHECK ((timeout_destination_type is null and timeout_destination_ref is null and timeout_destination_data is null) or (timeout_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'time-condition') and timeout_destination_ref is not null) or (timeout_destination_type in ('external', 'application') and timeout_destination_ref is null and timeout_destination_data is not null) or (timeout_destination_type = 'hangup' and timeout_destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "ring_group" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ring_group_destination" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"ring_group_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"destination_type" text NOT NULL,
	"destination_ref" uuid,
	"destination_data" jsonb,
	"delay_seconds" integer DEFAULT 0 NOT NULL,
	"timeout_seconds" integer DEFAULT 30 NOT NULL,
	"confirm_required" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ring_group_destination_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'time-condition') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "ring_group_destination" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inbound_route" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"match_kind" text DEFAULT 'exact' NOT NULL,
	"match_pattern" text,
	"phone_number_id" uuid,
	"caller_id_pattern" text,
	"destination_type" text NOT NULL,
	"destination_ref" uuid,
	"destination_data" jsonb,
	"failover_destination_type" text,
	"failover_destination_ref" uuid,
	"failover_destination_data" jsonb,
	"time_condition_id" uuid,
	"record_enabled" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_route_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'time-condition') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null)),
	CONSTRAINT "inbound_route_failover_destination_shape_check" CHECK ((failover_destination_type is null and failover_destination_ref is null and failover_destination_data is null) or (failover_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'time-condition') and failover_destination_ref is not null) or (failover_destination_type in ('external', 'application') and failover_destination_ref is null and failover_destination_data is not null) or (failover_destination_type = 'hangup' and failover_destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "inbound_route" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outbound_route" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"match_kind" text DEFAULT 'prefix' NOT NULL,
	"dial_patterns" text[] NOT NULL,
	"strip_digits" integer DEFAULT 0 NOT NULL,
	"prepend_digits" text,
	"toll_class" text NOT NULL,
	"trunk_priority" jsonb NOT NULL,
	"time_condition_id" uuid,
	"failover_destination_type" text,
	"failover_destination_ref" uuid,
	"failover_destination_data" jsonb,
	"caller_id_number_override" text,
	"record_enabled" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_route_failover_destination_shape_check" CHECK ((failover_destination_type is null and failover_destination_ref is null and failover_destination_data is null) or (failover_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'time-condition') and failover_destination_ref is not null) or (failover_destination_type in ('external', 'application') and failover_destination_ref is null and failover_destination_data is not null) or (failover_destination_type = 'hangup' and failover_destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "outbound_route" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"actor_user_id" uuid,
	"actor_ref" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_ref" uuid,
	"before" jsonb,
	"after" jsonb,
	"ip_address" inet,
	"user_agent" text,
	"request_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sip_acl_entry" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text,
	"network" cidr NOT NULL,
	"action" text DEFAULT 'allow' NOT NULL,
	"scope" text DEFAULT 'registration' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sip_acl_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_setting" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"value" jsonb,
	"value_type" text DEFAULT 'string' NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_setting" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"value" jsonb,
	"value_type" text DEFAULT 'string' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "time_condition" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"destination_type" text NOT NULL,
	"destination_ref" uuid,
	"destination_data" jsonb,
	"nomatch_destination_type" text,
	"nomatch_destination_ref" uuid,
	"nomatch_destination_data" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_condition_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'time-condition') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null)),
	CONSTRAINT "time_condition_nomatch_destination_shape_check" CHECK ((nomatch_destination_type is null and nomatch_destination_ref is null and nomatch_destination_data is null) or (nomatch_destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'time-condition') and nomatch_destination_ref is not null) or (nomatch_destination_type in ('external', 'application') and nomatch_destination_ref is null and nomatch_destination_data is not null) or (nomatch_destination_type = 'hangup' and nomatch_destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "time_condition" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "time_condition_rule" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"time_condition_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"label" text,
	"predicates" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "time_condition_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "trunk" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'register' NOT NULL,
	"sip_domain" text NOT NULL,
	"sip_proxy" text NOT NULL,
	"outbound_proxy" text,
	"auth_user" text,
	"sip_secret_ref" text,
	"register_expires_seconds" integer DEFAULT 300 NOT NULL,
	"transport" text DEFAULT 'udp' NOT NULL,
	"codec_prefs" text,
	"max_channels" integer,
	"caller_id_number_override" text,
	"status" text DEFAULT 'unknown' NOT NULL,
	"status_changed_at" timestamp with time zone,
	"status_reason" text,
	"status_latency_ms" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trunk" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "voicemail_box" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"mailbox_number" text NOT NULL,
	"label" text,
	"extension_id" uuid,
	"pin_hash" text,
	"email_address" text,
	"email_mode" text DEFAULT 'none' NOT NULL,
	"delete_after_delivery" boolean DEFAULT false NOT NULL,
	"transcription_enabled" boolean DEFAULT false NOT NULL,
	"mwi_enabled" boolean DEFAULT true NOT NULL,
	"max_messages" integer DEFAULT 100 NOT NULL,
	"max_message_seconds" integer DEFAULT 300 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voicemail_box" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "voicemail_greeting" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"voicemail_box_id" uuid NOT NULL,
	"kind" text DEFAULT 'unavailable' NOT NULL,
	"label" text,
	"object_key" text NOT NULL,
	"duration_ms" integer,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voicemail_greeting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "voicemail_message" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"voicemail_box_id" uuid NOT NULL,
	"folder" text DEFAULT 'new' NOT NULL,
	"caller_id_name" text,
	"caller_id_number" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"object_key" text NOT NULL,
	"size_bytes" integer,
	"transcription" text,
	"call_leg_ref" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voicemail_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "voicemail_option" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"voicemail_box_id" uuid NOT NULL,
	"digit" text NOT NULL,
	"ordinal" integer DEFAULT 1 NOT NULL,
	"label" text,
	"destination_type" text NOT NULL,
	"destination_ref" uuid,
	"destination_data" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voicemail_option_destination_shape_check" CHECK ((destination_type in ('extension', 'ivr', 'ring-group', 'queue', 'voicemail', 'conference', 'park', 'time-condition') and destination_ref is not null) or (destination_type in ('external', 'application') and destination_ref is null and destination_data is not null) or (destination_type = 'hangup' and destination_ref is null))
);
--> statement-breakpoint
ALTER TABLE "voicemail_option" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "conference_organization_room_number_key" ON "conference" ("organization_id","room_number");--> statement-breakpoint
CREATE UNIQUE INDEX "conference_organization_name_key" ON "conference" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "conference_organization_enabled_idx" ON "conference" ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "park_lot_organization_name_key" ON "park_lot" ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "device_organization_mac_address_key" ON "device" ("organization_id","mac_address");--> statement-breakpoint
CREATE UNIQUE INDEX "device_provisioning_token_key" ON "device" ("provisioning_token");--> statement-breakpoint
CREATE INDEX "device_organization_enabled_idx" ON "device" ("organization_id","enabled");--> statement-breakpoint
CREATE INDEX "device_organization_profile_idx" ON "device" ("organization_id","device_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_key_organization_device_category_index_key" ON "device_key" ("organization_id","device_id","category","key_index");--> statement-breakpoint
CREATE UNIQUE INDEX "device_line_organization_device_line_key" ON "device_line" ("organization_id","device_id","line_number");--> statement-breakpoint
CREATE INDEX "device_line_organization_extension_idx" ON "device_line" ("organization_id","extension_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_profile_organization_name_key" ON "device_profile" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "device_profile_organization_vendor_idx" ON "device_profile" ("organization_id","vendor");--> statement-breakpoint
CREATE UNIQUE INDEX "device_profile_key_profile_category_index_key" ON "device_profile_key" ("organization_id","device_profile_id","category","key_index");--> statement-breakpoint
CREATE UNIQUE INDEX "emergency_address_organization_label_key" ON "emergency_address" ("organization_id","label");--> statement-breakpoint
CREATE INDEX "emergency_address_organization_validated_idx" ON "emergency_address" ("organization_id","validated");--> statement-breakpoint
CREATE UNIQUE INDEX "extension_organization_number_key" ON "extension" ("organization_id","number");--> statement-breakpoint
CREATE INDEX "extension_organization_enabled_idx" ON "extension" ("organization_id","enabled");--> statement-breakpoint
CREATE INDEX "extension_organization_label_idx" ON "extension" ("organization_id","label");--> statement-breakpoint
CREATE INDEX "extension_organization_toll_class_idx" ON "extension" ("organization_id","toll_class");--> statement-breakpoint
CREATE INDEX "extension_organization_moh_class_idx" ON "extension" ("organization_id","moh_class_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extension_user_organization_extension_user_key" ON "extension_user" ("organization_id","extension_id","user_id");--> statement-breakpoint
CREATE INDEX "extension_user_organization_user_idx" ON "extension_user" ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "extension_user_organization_extension_idx" ON "extension_user" ("organization_id","extension_id");--> statement-breakpoint
CREATE UNIQUE INDEX "call_block_rule_organization_direction_pattern_key" ON "call_block_rule" ("organization_id","direction","pattern");--> statement-breakpoint
CREATE INDEX "call_block_rule_organization_enabled_idx" ON "call_block_rule" ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_code_organization_code_key" ON "feature_code" ("organization_id","code");--> statement-breakpoint
CREATE INDEX "feature_code_organization_action_idx" ON "feature_code" ("organization_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX "ivr_menu_organization_name_key" ON "ivr_menu" ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "ivr_menu_organization_extension_number_key" ON "ivr_menu" ("organization_id","extension_number") WHERE extension_number is not null;--> statement-breakpoint
CREATE INDEX "ivr_menu_organization_parent_idx" ON "ivr_menu" ("organization_id","parent_id");--> statement-breakpoint
CREATE INDEX "ivr_menu_organization_enabled_idx" ON "ivr_menu" ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "ivr_menu_option_menu_match_key" ON "ivr_menu_option" ("organization_id","ivr_menu_id","match_value");--> statement-breakpoint
CREATE INDEX "ivr_menu_option_menu_ordinal_idx" ON "ivr_menu_option" ("organization_id","ivr_menu_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "moh_class_organization_name_key" ON "moh_class" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "moh_class_organization_enabled_idx" ON "moh_class" ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_organization_name_key" ON "prompt" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "prompt_organization_kind_idx" ON "prompt" ("organization_id","kind");--> statement-breakpoint
CREATE INDEX "prompt_organization_moh_class_idx" ON "prompt" ("organization_id","moh_class_id");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_number_organization_e164_key" ON "phone_number" ("organization_id","e164");--> statement-breakpoint
CREATE INDEX "phone_number_organization_enabled_idx" ON "phone_number" ("organization_id","enabled");--> statement-breakpoint
CREATE INDEX "phone_number_organization_destination_idx" ON "phone_number" ("organization_id","destination_type","destination_ref");--> statement-breakpoint
CREATE INDEX "phone_number_organization_emergency_address_idx" ON "phone_number" ("organization_id","emergency_address_id");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_organization_name_key" ON "queue" ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_organization_extension_number_key" ON "queue" ("organization_id","extension_number") WHERE extension_number is not null;--> statement-breakpoint
CREATE INDEX "queue_organization_enabled_idx" ON "queue" ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_agent_organization_name_key" ON "queue_agent" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "queue_agent_organization_status_idx" ON "queue_agent" ("organization_id","status");--> statement-breakpoint
CREATE INDEX "queue_agent_organization_user_idx" ON "queue_agent" ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "queue_agent_organization_extension_idx" ON "queue_agent" ("organization_id","extension_id");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_tier_organization_queue_agent_key" ON "queue_tier" ("organization_id","queue_id","queue_agent_id");--> statement-breakpoint
CREATE INDEX "queue_tier_organization_queue_level_idx" ON "queue_tier" ("organization_id","queue_id","level","position");--> statement-breakpoint
CREATE INDEX "queue_tier_organization_agent_idx" ON "queue_tier" ("organization_id","queue_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ring_group_organization_name_key" ON "ring_group" ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "ring_group_organization_extension_number_key" ON "ring_group" ("organization_id","extension_number") WHERE extension_number is not null;--> statement-breakpoint
CREATE INDEX "ring_group_organization_enabled_idx" ON "ring_group" ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "ring_group_destination_group_ordinal_key" ON "ring_group_destination" ("organization_id","ring_group_id","ordinal");--> statement-breakpoint
CREATE INDEX "ring_group_destination_organization_group_idx" ON "ring_group_destination" ("organization_id","ring_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_route_organization_name_key" ON "inbound_route" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "inbound_route_organization_enabled_priority_idx" ON "inbound_route" ("organization_id","enabled","priority");--> statement-breakpoint
CREATE INDEX "inbound_route_organization_phone_number_idx" ON "inbound_route" ("organization_id","phone_number_id");--> statement-breakpoint
CREATE INDEX "inbound_route_organization_time_condition_idx" ON "inbound_route" ("organization_id","time_condition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_route_organization_name_key" ON "outbound_route" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "outbound_route_organization_enabled_priority_idx" ON "outbound_route" ("organization_id","enabled","priority");--> statement-breakpoint
CREATE INDEX "outbound_route_organization_toll_class_idx" ON "outbound_route" ("organization_id","toll_class");--> statement-breakpoint
CREATE INDEX "outbound_route_organization_time_condition_idx" ON "outbound_route" ("organization_id","time_condition_id");--> statement-breakpoint
CREATE INDEX "audit_log_organization_occurred_idx" ON "audit_log" ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_organization_resource_idx" ON "audit_log" ("organization_id","resource_type","resource_ref");--> statement-breakpoint
CREATE INDEX "audit_log_organization_actor_idx" ON "audit_log" ("organization_id","actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_organization_action_idx" ON "audit_log" ("organization_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX "sip_acl_entry_organization_scope_network_key" ON "sip_acl_entry" ("organization_id","scope","network");--> statement-breakpoint
CREATE INDEX "sip_acl_entry_organization_enabled_priority_idx" ON "sip_acl_entry" ("organization_id","enabled","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "org_setting_organization_category_name_key" ON "org_setting" ("organization_id","category","name");--> statement-breakpoint
CREATE INDEX "org_setting_organization_category_idx" ON "org_setting" ("organization_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "user_setting_organization_user_category_name_key" ON "user_setting" ("organization_id","user_id","category","name");--> statement-breakpoint
CREATE INDEX "user_setting_organization_user_idx" ON "user_setting" ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "time_condition_organization_name_key" ON "time_condition" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "time_condition_organization_enabled_idx" ON "time_condition" ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "time_condition_rule_condition_ordinal_key" ON "time_condition_rule" ("organization_id","time_condition_id","ordinal");--> statement-breakpoint
CREATE INDEX "time_condition_rule_organization_condition_idx" ON "time_condition_rule" ("organization_id","time_condition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trunk_organization_name_key" ON "trunk" ("organization_id","name");--> statement-breakpoint
CREATE INDEX "trunk_organization_enabled_idx" ON "trunk" ("organization_id","enabled");--> statement-breakpoint
CREATE INDEX "trunk_organization_status_idx" ON "trunk" ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "voicemail_box_organization_mailbox_number_key" ON "voicemail_box" ("organization_id","mailbox_number");--> statement-breakpoint
CREATE INDEX "voicemail_box_organization_extension_idx" ON "voicemail_box" ("organization_id","extension_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voicemail_greeting_box_kind_active_key" ON "voicemail_greeting" ("organization_id","voicemail_box_id","kind") WHERE active;--> statement-breakpoint
CREATE INDEX "voicemail_greeting_organization_box_idx" ON "voicemail_greeting" ("organization_id","voicemail_box_id");--> statement-breakpoint
CREATE INDEX "voicemail_message_box_folder_received_idx" ON "voicemail_message" ("organization_id","voicemail_box_id","folder","received_at");--> statement-breakpoint
CREATE INDEX "voicemail_message_organization_received_idx" ON "voicemail_message" ("organization_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "voicemail_option_box_digit_key" ON "voicemail_option" ("organization_id","voicemail_box_id","digit");--> statement-breakpoint
ALTER TABLE "conference" ADD CONSTRAINT "conference_moh_class_id_moh_class_id_fkey" FOREIGN KEY ("moh_class_id") REFERENCES "moh_class"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "park_lot" ADD CONSTRAINT "park_lot_moh_class_id_moh_class_id_fkey" FOREIGN KEY ("moh_class_id") REFERENCES "moh_class"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_device_profile_id_device_profile_id_fkey" FOREIGN KEY ("device_profile_id") REFERENCES "device_profile"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "device_key" ADD CONSTRAINT "device_key_device_id_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "device"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "device_line" ADD CONSTRAINT "device_line_device_id_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "device"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "device_line" ADD CONSTRAINT "device_line_extension_id_extension_id_fkey" FOREIGN KEY ("extension_id") REFERENCES "extension"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "device_profile_key" ADD CONSTRAINT "device_profile_key_device_profile_id_device_profile_id_fkey" FOREIGN KEY ("device_profile_id") REFERENCES "device_profile"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "extension" ADD CONSTRAINT "extension_moh_class_id_moh_class_id_fkey" FOREIGN KEY ("moh_class_id") REFERENCES "moh_class"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "extension_user" ADD CONSTRAINT "extension_user_extension_id_extension_id_fkey" FOREIGN KEY ("extension_id") REFERENCES "extension"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ivr_menu" ADD CONSTRAINT "ivr_menu_parent_id_ivr_menu_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "ivr_menu"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ivr_menu" ADD CONSTRAINT "ivr_menu_greeting_prompt_id_prompt_id_fkey" FOREIGN KEY ("greeting_prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ivr_menu" ADD CONSTRAINT "ivr_menu_short_greeting_prompt_id_prompt_id_fkey" FOREIGN KEY ("short_greeting_prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ivr_menu" ADD CONSTRAINT "ivr_menu_invalid_prompt_id_prompt_id_fkey" FOREIGN KEY ("invalid_prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ivr_menu" ADD CONSTRAINT "ivr_menu_timeout_prompt_id_prompt_id_fkey" FOREIGN KEY ("timeout_prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ivr_menu_option" ADD CONSTRAINT "ivr_menu_option_ivr_menu_id_ivr_menu_id_fkey" FOREIGN KEY ("ivr_menu_id") REFERENCES "ivr_menu"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "prompt" ADD CONSTRAINT "prompt_moh_class_id_moh_class_id_fkey" FOREIGN KEY ("moh_class_id") REFERENCES "moh_class"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "phone_number" ADD CONSTRAINT "phone_number_emergency_address_id_emergency_address_id_fkey" FOREIGN KEY ("emergency_address_id") REFERENCES "emergency_address"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_moh_class_id_moh_class_id_fkey" FOREIGN KEY ("moh_class_id") REFERENCES "moh_class"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_greeting_prompt_id_prompt_id_fkey" FOREIGN KEY ("greeting_prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_announce_prompt_id_prompt_id_fkey" FOREIGN KEY ("announce_prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "queue_agent" ADD CONSTRAINT "queue_agent_extension_id_extension_id_fkey" FOREIGN KEY ("extension_id") REFERENCES "extension"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "queue_tier" ADD CONSTRAINT "queue_tier_queue_id_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queue"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "queue_tier" ADD CONSTRAINT "queue_tier_queue_agent_id_queue_agent_id_fkey" FOREIGN KEY ("queue_agent_id") REFERENCES "queue_agent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ring_group" ADD CONSTRAINT "ring_group_confirm_prompt_id_prompt_id_fkey" FOREIGN KEY ("confirm_prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ring_group" ADD CONSTRAINT "ring_group_moh_class_id_moh_class_id_fkey" FOREIGN KEY ("moh_class_id") REFERENCES "moh_class"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ring_group" ADD CONSTRAINT "ring_group_ringback_prompt_id_prompt_id_fkey" FOREIGN KEY ("ringback_prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "ring_group_destination" ADD CONSTRAINT "ring_group_destination_ring_group_id_ring_group_id_fkey" FOREIGN KEY ("ring_group_id") REFERENCES "ring_group"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inbound_route" ADD CONSTRAINT "inbound_route_phone_number_id_phone_number_id_fkey" FOREIGN KEY ("phone_number_id") REFERENCES "phone_number"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "inbound_route" ADD CONSTRAINT "inbound_route_time_condition_id_time_condition_id_fkey" FOREIGN KEY ("time_condition_id") REFERENCES "time_condition"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "outbound_route" ADD CONSTRAINT "outbound_route_time_condition_id_time_condition_id_fkey" FOREIGN KEY ("time_condition_id") REFERENCES "time_condition"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "time_condition_rule" ADD CONSTRAINT "time_condition_rule_time_condition_id_time_condition_id_fkey" FOREIGN KEY ("time_condition_id") REFERENCES "time_condition"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "voicemail_box" ADD CONSTRAINT "voicemail_box_extension_id_extension_id_fkey" FOREIGN KEY ("extension_id") REFERENCES "extension"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "voicemail_greeting" ADD CONSTRAINT "voicemail_greeting_voicemail_box_id_voicemail_box_id_fkey" FOREIGN KEY ("voicemail_box_id") REFERENCES "voicemail_box"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "voicemail_message" ADD CONSTRAINT "voicemail_message_voicemail_box_id_voicemail_box_id_fkey" FOREIGN KEY ("voicemail_box_id") REFERENCES "voicemail_box"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "voicemail_option" ADD CONSTRAINT "voicemail_option_voicemail_box_id_voicemail_box_id_fkey" FOREIGN KEY ("voicemail_box_id") REFERENCES "voicemail_box"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "conference_tenant_isolation" ON "conference" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "park_lot_tenant_isolation" ON "park_lot" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "device_tenant_isolation" ON "device" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "device_key_tenant_isolation" ON "device_key" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "device_line_tenant_isolation" ON "device_line" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "device_profile_tenant_isolation" ON "device_profile" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "device_profile_key_tenant_isolation" ON "device_profile_key" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "emergency_address_tenant_isolation" ON "emergency_address" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "extension_tenant_isolation" ON "extension" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "extension_user_tenant_isolation" ON "extension_user" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "call_block_rule_tenant_isolation" ON "call_block_rule" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "feature_code_tenant_isolation" ON "feature_code" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ivr_menu_tenant_isolation" ON "ivr_menu" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ivr_menu_option_tenant_isolation" ON "ivr_menu_option" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "moh_class_tenant_isolation" ON "moh_class" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "prompt_tenant_isolation" ON "prompt" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "phone_number_tenant_isolation" ON "phone_number" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "queue_tenant_isolation" ON "queue" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "queue_agent_tenant_isolation" ON "queue_agent" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "queue_tier_tenant_isolation" ON "queue_tier" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ring_group_tenant_isolation" ON "ring_group" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ring_group_destination_tenant_isolation" ON "ring_group_destination" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "inbound_route_tenant_isolation" ON "inbound_route" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "outbound_route_tenant_isolation" ON "outbound_route" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_log_tenant_select" ON "audit_log" AS PERMISSIVE FOR SELECT TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_log_tenant_insert" ON "audit_log" AS PERMISSIVE FOR INSERT TO "pbx_tenant_tls" WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sip_acl_entry_tenant_isolation" ON "sip_acl_entry" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "org_setting_tenant_isolation" ON "org_setting" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "user_setting_tenant_isolation" ON "user_setting" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "time_condition_tenant_isolation" ON "time_condition" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "time_condition_rule_tenant_isolation" ON "time_condition_rule" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "trunk_tenant_isolation" ON "trunk" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "voicemail_box_tenant_isolation" ON "voicemail_box" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "voicemail_greeting_tenant_isolation" ON "voicemail_greeting" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "voicemail_message_tenant_isolation" ON "voicemail_message" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "voicemail_option_tenant_isolation" ON "voicemail_option" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);