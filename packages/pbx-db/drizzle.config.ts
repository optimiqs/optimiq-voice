import { defineConfig } from "drizzle-kit";

/**
 * The telephony bounded context owns its own database and therefore its own journal. It never
 * shares a connection string with the base (auth) database: `PBX_DATABASE_MIGRATION_URL` is the
 * owner principal, `PBX_DATABASE_URL` is the RLS-bound runtime principal used only as a
 * development convenience.
 *
 * `entities.roles` is enabled so `pbx_tenant_tls` is created by the journal rather than by hand;
 * the grants that role needs cannot be expressed in the Drizzle schema and live in the
 * hand-authored `*_pbx_tenant_grants` migration instead.
 */
const migrationUrl =
	process.env.PBX_DATABASE_MIGRATION_URL ??
	process.env.PBX_DATABASE_URL ??
	"postgresql://localhost:5432/optimiq_pbx";

export default defineConfig({
	schema: "./src/schema/drizzle-kit.ts",
	out: "./drizzle",
	dialect: "postgresql",
	strict: true,
	verbose: true,
	entities: { roles: true },
	dbCredentials: { url: migrationUrl },
});
