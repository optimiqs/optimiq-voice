CREATE TABLE "queue_agent_skill" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"queue_agent_id" uuid NOT NULL,
	"skill" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_agent_skill_shape_check" CHECK (skill ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
	CONSTRAINT "queue_agent_skill_level_range_check" CHECK (level between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "queue_agent_skill" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "queue_call_disposition" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"queue_agent_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"code_id" uuid,
	"code" text NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "queue_call_disposition" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "queue_disposition_code" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_disposition_code_reserved_check" CHECK (code <> 'unset'),
	CONSTRAINT "queue_disposition_code_shape_check" CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,62}$')
);
--> statement-breakpoint
ALTER TABLE "queue_disposition_code" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "queue_skill_requirement" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"skill" text NOT NULL,
	"min_level" integer DEFAULT 1 NOT NULL,
	"relax_after_seconds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_skill_requirement_shape_check" CHECK (skill ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
	CONSTRAINT "queue_skill_requirement_level_range_check" CHECK (min_level between 1 and 5),
	CONSTRAINT "queue_skill_requirement_relax_range_check" CHECK (relax_after_seconds between 0 and 3600)
);
--> statement-breakpoint
ALTER TABLE "queue_skill_requirement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "queue_survey_question" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"prompt_id" uuid,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_survey_question_position_range_check" CHECK (position between 1 and 3)
);
--> statement-breakpoint
ALTER TABLE "queue_survey_question" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "queue_survey_response" (
	"id" uuid PRIMARY KEY,
	"organization_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"queue_agent_id" uuid,
	"answer" integer NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_survey_response_answer_range_check" CHECK (answer between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "queue_survey_response" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "disposition_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "rona_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "survey_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "survey_intro_prompt_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "queue_agent_skill_agent_skill_key" ON "queue_agent_skill" ("organization_id","queue_agent_id","skill");--> statement-breakpoint
CREATE INDEX "queue_agent_skill_organization_skill_idx" ON "queue_agent_skill" ("organization_id","skill");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_call_disposition_call_agent_key" ON "queue_call_disposition" ("organization_id","call_id","queue_agent_id");--> statement-breakpoint
CREATE INDEX "queue_call_disposition_organization_queue_idx" ON "queue_call_disposition" ("organization_id","queue_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "queue_call_disposition_organization_agent_idx" ON "queue_call_disposition" ("organization_id","queue_agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "queue_disposition_code_queue_code_key" ON "queue_disposition_code" ("organization_id","queue_id","code");--> statement-breakpoint
CREATE INDEX "queue_disposition_code_organization_queue_idx" ON "queue_disposition_code" ("organization_id","queue_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_skill_requirement_queue_skill_key" ON "queue_skill_requirement" ("organization_id","queue_id","skill");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_survey_question_queue_position_key" ON "queue_survey_question" ("organization_id","queue_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "queue_survey_response_call_question_key" ON "queue_survey_response" ("organization_id","call_id","question_id");--> statement-breakpoint
CREATE INDEX "queue_survey_response_organization_queue_idx" ON "queue_survey_response" ("organization_id","queue_id","answered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "queue_survey_response_organization_agent_idx" ON "queue_survey_response" ("organization_id","queue_agent_id","answered_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_survey_intro_prompt_id_prompt_id_fkey" FOREIGN KEY ("survey_intro_prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "queue_agent_skill" ADD CONSTRAINT "queue_agent_skill_queue_agent_id_queue_agent_id_fkey" FOREIGN KEY ("queue_agent_id") REFERENCES "queue_agent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "queue_call_disposition" ADD CONSTRAINT "queue_call_disposition_queue_id_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queue"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "queue_call_disposition" ADD CONSTRAINT "queue_call_disposition_queue_agent_id_queue_agent_id_fkey" FOREIGN KEY ("queue_agent_id") REFERENCES "queue_agent"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "queue_call_disposition" ADD CONSTRAINT "queue_call_disposition_code_id_queue_disposition_code_id_fkey" FOREIGN KEY ("code_id") REFERENCES "queue_disposition_code"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "queue_disposition_code" ADD CONSTRAINT "queue_disposition_code_queue_id_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queue"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "queue_skill_requirement" ADD CONSTRAINT "queue_skill_requirement_queue_id_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queue"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "queue_survey_question" ADD CONSTRAINT "queue_survey_question_queue_id_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queue"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "queue_survey_question" ADD CONSTRAINT "queue_survey_question_prompt_id_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompt"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "queue_survey_response" ADD CONSTRAINT "queue_survey_response_queue_id_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queue"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "queue_survey_response" ADD CONSTRAINT "queue_survey_response_question_id_queue_survey_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "queue_survey_question"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "queue_survey_response" ADD CONSTRAINT "queue_survey_response_queue_agent_id_queue_agent_id_fkey" FOREIGN KEY ("queue_agent_id") REFERENCES "queue_agent"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "queue_agent_skill_tenant_isolation" ON "queue_agent_skill" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "queue_call_disposition_tenant_isolation" ON "queue_call_disposition" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "queue_disposition_code_tenant_isolation" ON "queue_disposition_code" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "queue_skill_requirement_tenant_isolation" ON "queue_skill_requirement" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "queue_survey_question_tenant_isolation" ON "queue_survey_question" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "queue_survey_response_tenant_isolation" ON "queue_survey_response" AS PERMISSIVE FOR ALL TO "pbx_tenant_tls" USING (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('pbx_tenant_tls.organization_id', true), '')::uuid);