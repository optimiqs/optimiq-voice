-- Identity-removal Step 5 item 1, phase 3 of 3: enforce the tenant column.
--
-- Phase 1 (`…_tenancy_organization_id`) added `organization_id` as NULLABLE. Phase 2 is
-- `scripts/backfill-tenancy-organization-id.ts`, which joins the Step 2 mapping ledger — a table
-- in a DIFFERENT database, which is why it cannot be a migration. Only then may this run.
--
-- The guard below is the mechanical form of sequencing rule 2 ("data before enforcement; a bad
-- backfill is recoverable rather than a lockout"). On a fresh install there are no rows, so it is
-- trivially satisfied and the constraint lands through the ordinary deploy path. On an existing
-- install with un-backfilled rows the deploy FAILS HERE, loudly and with the command to run, and
-- phase 1 stays committed so the backfill can proceed and the deploy can be retried. It never
-- silently skips: a no-op guard would ship an unenforced tenant column, which is the outcome this
-- whole sequence exists to prevent.
--
-- `ALTER … SET NOT NULL` is idempotent, so a database the backfill already finalised with
-- `--finalize` passes through unchanged and only records the migration.

DO $$
DECLARE
	unattributed bigint;
	report text := '';
	target text;
BEGIN
	FOREACH target IN ARRAY ARRAY[
		'applications', 'secrets', 'tts_services', 'stt_services', 'intelligence_services'
	] LOOP
		EXECUTE format('SELECT count(*) FROM %I WHERE organization_id IS NULL', target)
			INTO unattributed;
		IF unattributed > 0 THEN
			report := report || format(E'\n  - %s: %s row(s)', target, unattributed);
		END IF;
	END LOOP;

	IF report <> '' THEN
		RAISE EXCEPTION 'organization_id is not backfilled yet:%', report
			USING HINT =
				'Run `pnpm --filter @optimiq-voice/api backfill:tenancy` (identity-removal Step 5 '
				'item 1) against this database, then re-run the migration. Phase 1 of the sequence '
				'is already committed, so nothing is lost.';
	END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "applications" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "intelligence_services" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "stt_services" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tts_services" ALTER COLUMN "organization_id" SET NOT NULL;
