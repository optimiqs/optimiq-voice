import { drizzle } from "drizzle-orm/postgres-js";
import { createPostgresClient, MigrationTargetError } from "@optimiq-voice/db";
import { ensureMonthlyPartitions } from "../src/partitions";

/**
 * Extends the rolling monthly-partition horizon for the CDR ledgers.
 *
 * Deliberately a script, not a scheduled job: Phase 2's engine (or a platform CronJob) decides
 * the cadence. Running it more often than necessary is free — every statement is idempotent.
 *
 *   bun run scripts/ensure-partitions.ts --months 3
 */
function parseMonths(argv: readonly string[]): number {
	const index = argv.indexOf("--months");
	if (index === -1) {
		return 2;
	}
	const value = Number(argv[index + 1]);
	if (!Number.isInteger(value) || value < 1) {
		throw new RangeError("--months must be a positive whole number.");
	}
	return value;
}

async function main(): Promise<void> {
	const url = process.env.CDR_DATABASE_MIGRATION_URL ?? process.env.CDR_DATABASE_URL;
	if (!url) {
		throw new MigrationTargetError(
			"CDR_DATABASE_MIGRATION_URL (preferred) or CDR_DATABASE_URL must be set.",
		);
	}
	const monthCount = parseMonths(process.argv.slice(2));
	const client = createPostgresClient({
		url,
		applicationName: "optimiq-voice-cdr-partitions",
		poolMaxConnectionsOverride: 1,
	});
	try {
		const partitions = await ensureMonthlyPartitions(drizzle({ client }), { monthCount });
		process.stdout.write(
			`${JSON.stringify({ event: "cdr_partitions_ensured", monthCount, partitions })}\n`,
		);
	} finally {
		await client.end({ timeout: 5 });
	}
}

await main();
