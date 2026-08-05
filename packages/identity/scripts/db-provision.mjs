import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const { Pool } = pg;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const legacyMigrationsFolder = join(root, "migrations");
const drizzleMigrationsFolder = join(root, "drizzle");
const configIndex = process.argv.indexOf("--config");
const databaseUrl =
	configIndex >= 0
		? JSON.parse(await readFile(resolve(process.cwd(), process.argv[configIndex + 1]), "utf8"))
				.database.url
		: process.env.API_IDENTITY_DATABASE_URL;

if (!databaseUrl) {
	throw new Error("API_IDENTITY_DATABASE_URL or --config is required to provision the database");
}

const parsedDatabaseUrl = new URL(databaseUrl);
const databaseSchema = parsedDatabaseUrl.searchParams.get("schema") ?? "public";
if (!/^[a-z_][a-z0-9_]*$/.test(databaseSchema)) {
	throw new Error(`Invalid PostgreSQL schema: ${databaseSchema}`);
}
parsedDatabaseUrl.searchParams.delete("schema");
const pool = new Pool({
	connectionString: parsedDatabaseUrl.toString(),
	options: `-c search_path=${databaseSchema},public`,
});

async function tableExists(client, table) {
	const { rows } = await client.query("SELECT to_regclass($1) AS name", [
		`${databaseSchema}.${table}`,
	]);
	return rows[0]?.name !== null;
}

async function getAppliedLegacyMigrations(client) {
	const applied = new Set();

	if (await tableExists(client, "_prisma_migrations")) {
		const { rows } = await client.query(`
      SELECT migration_name
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `);
		rows.forEach(({ migration_name }) => applied.add(migration_name));
	}

	await client.query(`
    CREATE TABLE IF NOT EXISTS "optimiq_voice_legacy_migrations" (
      "name" text PRIMARY KEY,
      "applied_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
	const { rows } = await client.query('SELECT "name" FROM "optimiq_voice_legacy_migrations"');
	rows.forEach(({ name }) => applied.add(name));

	return applied;
}

async function applyLegacyMigrations(client) {
	const migrations = (
		await readdir(legacyMigrationsFolder, {
			withFileTypes: true,
		})
	)
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const applied = await getAppliedLegacyMigrations(client);

	if (
		migrations.length > 0 &&
		!applied.has(migrations[0]) &&
		(await tableExists(client, "users"))
	) {
		throw new Error(
			"The Identity schema exists without migration history; baseline it before provisioning",
		);
	}

	for (const name of migrations) {
		if (applied.has(name)) continue;

		const sql = await readFile(join(legacyMigrationsFolder, name, "migration.sql"), "utf8");
		await client.query("BEGIN");
		try {
			await client.query(sql);
			await client.query('INSERT INTO "optimiq_voice_legacy_migrations" ("name") VALUES ($1)', [
				name,
			]);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		}
	}
}

const client = await pool.connect();
let locked = false;
try {
	await client.query(`CREATE SCHEMA IF NOT EXISTS "${databaseSchema}"`);
	await client.query("SELECT pg_advisory_lock(hashtext($1), hashtext($2))", [
		"optimiq-voice-identity-migrations",
		databaseSchema,
	]);
	locked = true;
	await applyLegacyMigrations(client);
	await migrate(drizzle(client), {
		migrationsFolder: drizzleMigrationsFolder,
		migrationsSchema: databaseSchema,
		migrationsTable: "__drizzle_migrations_identity",
	});
} finally {
	if (locked) {
		await client.query("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", [
			"optimiq-voice-identity-migrations",
			databaseSchema,
		]);
	}
	client.release();
	await pool.end();
}
