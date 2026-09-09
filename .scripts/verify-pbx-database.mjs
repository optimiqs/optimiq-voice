import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Applies the complete PBX migration history and runs tenant integration tests in a fresh container.
const directory = fileURLToPath(new URL("../packages/pbx-db/", import.meta.url));
const require = createRequire(`${directory}package.json`);
const postgres = require("postgres");
const container = `voice-pbx-verification-${process.pid}`;
const password = randomBytes(24).toString("hex");
let database;
try {
	execFileSync("docker", ["run", "--rm", "-d", "--name", container, "-p", "127.0.0.1::5432", "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=voice_test", "postgres:16.10-alpine3.22"], { stdio: "pipe" });
	const port = execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).trim().split(":").at(-1);
	const url = `postgresql://postgres:${password}@127.0.0.1:${port}/voice_test`;
	database = postgres(url, { max: 1, connect_timeout: 2 });
	for (let attempt = 0; attempt < 60; attempt++) {
		try { await database`select 1`; break; }
		catch (error) { if (attempt === 59) throw error; await new Promise((resolve) => setTimeout(resolve, 250)); }
	}
	const env = { ...process.env, NODE_ENV: "test", DATABASE_DEPLOYMENT_STAGE: "test", PBX_DATABASE_MIGRATION_URL: url, PBX_DATABASE_URL: url, RUN_DB_INTEGRATION_TESTS: "true" };
	execFileSync("pnpm", ["run", "db:migrate:test"], { cwd: directory, env, stdio: "inherit" });
	execFileSync("pnpm", ["run", "test:integration"], { cwd: directory, env, stdio: "inherit" });
	console.log("PASS: complete PBX migration history and database integration suite on disposable PostgreSQL.");
} finally {
	if (database) await database.end({ timeout: 1 });
	try { execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" }); } catch {}
}
