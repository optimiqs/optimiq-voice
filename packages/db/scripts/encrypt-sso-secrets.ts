import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import {
	createPostgresClient,
	encryptSecret,
	isEncryptedSecret,
	MigrationTargetError,
	organizationSsoProvider,
	requireSecretKey,
} from "../src/index";

/**
 * One-shot re-encryption of `organization_sso_provider.client_secret`.
 *
 * ## Why this exists when the read path already migrates lazily
 *
 * `listEnabledSsoProvidersWithSecrets` seals any plaintext row it reads, so a running deployment
 * converges on its own. It converges over the rows the auth boot ACTUALLY READS, though, and that
 * is only the enabled ones — a provider an admin disabled while investigating something stays
 * plaintext for as long as it stays disabled, which is exactly the row nobody is watching. This
 * script closes that set: every row, enabled or not, in one pass.
 *
 * ## Why it is a script and not a `drizzle` migration
 *
 * A SQL migration cannot do this. The ciphertext is produced by application code holding a key that
 * lives in the environment rather than in the database, and a migration that could reach that key
 * would have put it somewhere a `psql` session can read. It is also not a schema change: the column
 * is `text` before and after, which is what lets the two formats coexist during the rollout.
 *
 * ## It is idempotent, and that is load-bearing
 *
 * A row that is already sealed is skipped by `isEncryptedSecret` rather than double-wrapped. Run it
 * as many times as you like; run it again after a partial failure.
 *
 * Usage: `PLATFORM_SECRET_ENCRYPTION_KEY=<64 hex chars> DATABASE_MIGRATION_URL=... bun run
 * scripts/encrypt-sso-secrets.ts [--dry-run]`
 */

function requireMigrationUrl(): string {
	const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
	if (!url) {
		throw new MigrationTargetError(
			"DATABASE_MIGRATION_URL (preferred) or DATABASE_URL must be set.",
		);
	}
	return url;
}

async function main(): Promise<void> {
	const dryRun = process.argv.includes("--dry-run");
	// Before opening a connection: a missing key here is a typo in the command line, and finding it
	// out after the first UPDATE would leave the table half-converted.
	const key = requireSecretKey();

	const client = createPostgresClient({
		url: requireMigrationUrl(),
		applicationName: "optimiq-voice-sso-secret-migrator",
		poolMaxConnectionsOverride: 1,
		statementTimeoutMs: 0,
		idleInTransactionSessionTimeoutMs: 0,
	});
	try {
		const db = drizzle({ client });
		const rows = await db
			.select({
				id: organizationSsoProvider.id,
				organizationId: organizationSsoProvider.organizationId,
				providerId: organizationSsoProvider.providerId,
				clientSecret: organizationSsoProvider.clientSecret,
			})
			.from(organizationSsoProvider);

		let sealed = 0;
		let skipped = 0;
		for (const row of rows) {
			if (isEncryptedSecret(row.clientSecret)) {
				skipped += 1;
				continue;
			}
			if (!dryRun) {
				await db
					.update(organizationSsoProvider)
					.set({ clientSecret: encryptSecret(row.clientSecret, key) })
					.where(eq(organizationSsoProvider.id, row.id));
			}
			sealed += 1;
			// The provider slug and its org, never the secret and never its length.
			process.stdout.write(
				`${JSON.stringify({
					event: "sso_secret_sealed",
					dryRun,
					id: row.id,
					organizationId: row.organizationId,
					providerId: row.providerId,
				})}\n`,
			);
		}

		process.stdout.write(
			`${JSON.stringify({
				event: "sso_secret_migration_complete",
				dryRun,
				total: rows.length,
				sealed,
				alreadySealed: skipped,
			})}\n`,
		);
	} finally {
		await client.end({ timeout: 5 });
	}
}

await main();
