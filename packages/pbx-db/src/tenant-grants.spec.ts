import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PBX_APPEND_ONLY_TABLES, PBX_TENANT_TABLES } from "./rls-preflight-plan";

/**
 * The tenant role's privileges cannot be expressed in the Drizzle schema, so drizzle-kit cannot
 * notice when a new table ships without a GRANT. This spec closes that gap: it reads the applied
 * migration SQL and asserts every table in the plan is granted at the privilege level its mode
 * requires. Adding a table without a grants migration fails the build, not production.
 */
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

function readMigrationSql(): string {
	return readdirSync(migrationsFolder, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => readFileSync(path.join(migrationsFolder, entry.name, "migration.sql"), "utf8"))
		.join("\n");
}

/** Grant statements, split so a table name can be attributed to the privilege list above it. */
function grantBlocks(sql: string): { privileges: string; tables: readonly string[] }[] {
	const blocks: { privileges: string; tables: readonly string[] }[] = [];
	const pattern = /GRANT\s+([A-Z,\s]+?)\s+ON\s+((?:\s*"[a-z_]+"\s*,?)+)\s*TO\s+"pbx_tenant_tls"/gu;
	for (const match of sql.matchAll(pattern)) {
		const [, privileges = "", tableList = ""] = match;
		blocks.push({
			privileges: privileges.replaceAll(/\s+/gu, " ").trim(),
			tables: [...tableList.matchAll(/"([a-z_]+)"/gu)].map(([, name]) => name ?? ""),
		});
	}
	return blocks;
}

/**
 * Tables a later migration dropped.
 *
 * A `DROP TABLE` takes its grants with it, so a table that was granted and then dropped is not a
 * privilege anybody holds — but the GRANT statement is still sitting in the migration history this
 * spec reads, and without this it would look like one. Subtracting the drops is what lets a table
 * be REMOVED from the schema without the spec demanding a revoke migration that Postgres does not
 * need.
 */
function droppedTables(sql: string): ReadonlySet<string> {
	return new Set(
		[...sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"([a-z_]+)"/gu)].map(
			([, name]) => name ?? "",
		),
	);
}

const sql = readMigrationSql();
const blocks = grantBlocks(sql);
const dropped = droppedTables(sql);
const grantedPrivileges = new Map<string, string>(
	blocks
		.flatMap((block) => block.tables.map((table) => [table, block.privileges] as const))
		.filter(([table]) => !dropped.has(table)),
);

describe("tenant role grants", () => {
	it("grants schema usage exactly once", () => {
		expect(sql).toContain('GRANT USAGE ON SCHEMA "public" TO "pbx_tenant_tls"');
	});

	it("grants full CRUD on every read-write tenant table", () => {
		for (const table of PBX_TENANT_TABLES) {
			if (PBX_APPEND_ONLY_TABLES.includes(table)) {
				continue;
			}
			expect(grantedPrivileges.get(table), `${table} is not granted to the tenant role`).toBe(
				"SELECT, INSERT, UPDATE, DELETE",
			);
		}
	});

	it("grants only SELECT and INSERT on append-only ledgers", () => {
		for (const table of PBX_APPEND_ONLY_TABLES) {
			expect(grantedPrivileges.get(table), `${table} grant`).toBe("SELECT, INSERT");
		}
	});

	it("grants nothing to a table that is not part of the plan", () => {
		for (const table of grantedPrivileges.keys()) {
			expect(PBX_TENANT_TABLES, `${table} is granted but not in the plan`).toContain(table);
		}
	});
});
