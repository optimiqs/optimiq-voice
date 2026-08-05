import { defineConfig } from "drizzle-kit";

/**
 * Migrations run as the schema OWNER, which is a different principal from the RLS-bound runtime
 * role. `DATABASE_MIGRATION_URL` therefore takes precedence and `DATABASE_URL` is only a
 * development convenience.
 *
 * `drizzle-kit generate` needs no live database; the placeholder keeps generation working in CI.
 */
const migrationUrl =
	process.env.DATABASE_MIGRATION_URL ??
	process.env.DATABASE_URL ??
	"postgresql://localhost:5432/optimiq_voice";

export default defineConfig({
	schema: "./src/schema/drizzle-kit.ts",
	out: "./drizzle",
	dialect: "postgresql",
	strict: true,
	verbose: true,
	dbCredentials: { url: migrationUrl },
});
