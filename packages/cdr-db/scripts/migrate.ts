import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
	assertMigrationStage,
	createPostgresClient,
	describeDatabaseMigrationTarget,
	MigrationTargetError,
	parseExpectedMigrationStage,
	resolveDatabaseDeploymentStage,
	type NodeEnvironment,
} from "@optimiq-voice/db";

/**
 * CDR schema migration entry point.
 *
 * Reads `process.env` directly rather than @optimiq-voice/config: this is a bootstrap script that
 * must run in release images where the full application env is not present, and the only settings
 * it needs are the owner connection string and the stage guards. The stage guard, target
 * description and production confirmation all come from @optimiq-voice/db — this script only
 * points them at a different journal.
 */
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

function requireMigrationUrl(): string {
	const url = process.env.CDR_DATABASE_MIGRATION_URL ?? process.env.CDR_DATABASE_URL;
	if (!url) {
		throw new MigrationTargetError(
			"CDR_DATABASE_MIGRATION_URL (preferred) or CDR_DATABASE_URL must be set for CDR migrations.",
		);
	}
	return url;
}

function resolveNodeEnvironment(): NodeEnvironment {
	const value = process.env.NODE_ENV ?? "development";
	if (value === "development" || value === "test" || value === "production") {
		return value;
	}
	throw new MigrationTargetError(`Unsupported NODE_ENV "${value}" for migrations.`);
}

async function main(): Promise<void> {
	const expectedStage = parseExpectedMigrationStage(process.argv.slice(2));
	const actualStage = resolveDatabaseDeploymentStage({
		configuredStage: process.env.DATABASE_DEPLOYMENT_STAGE,
		nodeEnvironment: resolveNodeEnvironment(),
	});
	assertMigrationStage({
		actualStage,
		expectedStage,
		productionConfirmation: process.env.DATABASE_MIGRATION_CONFIRM_PRODUCTION,
	});

	const url = requireMigrationUrl();
	const target = describeDatabaseMigrationTarget(url);
	process.stdout.write(
		`${JSON.stringify({ event: "cdr_migration_start", stage: actualStage, target })}\n`,
	);

	const client = createPostgresClient({
		url,
		applicationName: "optimiq-voice-cdr-migrator",
		poolMaxConnectionsOverride: 1,
	});
	try {
		await migrate(drizzle({ client }), { migrationsFolder });
	} finally {
		await client.end({ timeout: 5 });
	}

	process.stdout.write(
		`${JSON.stringify({ event: "cdr_migration_complete", stage: actualStage, target })}\n`,
	);
}

await main();
