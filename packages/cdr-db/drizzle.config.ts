import { defineConfig } from "drizzle-kit";

/**
 * The CDR bounded context owns its own database and its own journal; it never shares a
 * connection string with @optimiq-voice/db or @optimiq-voice/pbx-db.
 *
 * Migrations run as the schema OWNER, which is a different principal from the RLS-bound runtime
 * role, so `CDR_DATABASE_MIGRATION_URL` takes precedence and `CDR_DATABASE_URL` is only a
 * development convenience.
 *
 * `drizzle-kit generate` needs no live database; the placeholder keeps generation working in CI.
 */
const migrationUrl =
	process.env.CDR_DATABASE_MIGRATION_URL ??
	process.env.CDR_DATABASE_URL ??
	"postgresql://localhost:5432/optimiq_cdr";

export default defineConfig({
	schema: "./src/schema/drizzle-kit.ts",
	out: "./drizzle",
	dialect: "postgresql",
	strict: true,
	verbose: true,
	dbCredentials: { url: migrationUrl },
});
