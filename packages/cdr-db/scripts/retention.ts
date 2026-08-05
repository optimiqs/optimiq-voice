import { drizzle } from "drizzle-orm/postgres-js";
import { createPostgresClient, MigrationTargetError } from "@optimiq-voice/db";
import { DEFAULT_CDR_RETENTION_MONTHS, planCdrRetention, runCdrRetention } from "../src/retention";

/**
 * CDR retention sweep: drops expired monthly partitions and expires recording rows.
 *
 * Deliberately a script, not a cron. Phase 2 wires the schedule.
 *
 *   bun run scripts/retention.ts --retain-months 13 [--dry-run]
 *
 * `--dry-run` prints the plan (cutoff month, tables, tombstone cutoff) and exits without touching
 * anything. Always run it first in production: a partition drop is not recoverable.
 */
function parseNumberFlag(argv: readonly string[], flag: string, fallback: number): number {
	const index = argv.indexOf(flag);
	if (index === -1) {
		return fallback;
	}
	const value = Number(argv[index + 1]);
	if (!Number.isInteger(value) || value < 1) {
		throw new RangeError(`${flag} must be a positive whole number.`);
	}
	return value;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const retentionMonths = parseNumberFlag(argv, "--retain-months", DEFAULT_CDR_RETENTION_MONTHS);
	const plan = planCdrRetention({ retentionMonths });

	if (argv.includes("--dry-run")) {
		process.stdout.write(
			`${JSON.stringify({ event: "cdr_retention_plan", dryRun: true, plan })}\n`,
		);
		return;
	}

	const url = process.env.CDR_DATABASE_MIGRATION_URL ?? process.env.CDR_DATABASE_URL;
	if (!url) {
		throw new MigrationTargetError(
			"CDR_DATABASE_MIGRATION_URL (preferred) or CDR_DATABASE_URL must be set.",
		);
	}
	const client = createPostgresClient({
		url,
		applicationName: "optimiq-voice-cdr-retention",
		poolMaxConnectionsOverride: 1,
	});
	try {
		const outcome = await runCdrRetention(drizzle({ client }), { retentionMonths });
		process.stdout.write(`${JSON.stringify({ event: "cdr_retention_complete", outcome })}\n`);
	} finally {
		await client.end({ timeout: 5 });
	}
}

await main();
