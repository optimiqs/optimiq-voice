import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Run from the migration image or a built workspace. Runtime services need no owner credentials.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(resolve(root, "apps/api/package.json"));
const { parseExpectedMigrationStage, resolveDatabaseDeploymentStage, assertMigrationStage } =
	await import(pathToFileURL(require.resolve("@optimiq-voice/db")).href);
const stage = parseExpectedMigrationStage(process.argv.slice(2));
assertMigrationStage({
	expectedStage: stage,
	actualStage: resolveDatabaseDeploymentStage({ configuredStage: process.env.DATABASE_DEPLOYMENT_STAGE, nodeEnvironment: process.env.NODE_ENV ?? "development" }),
	productionConfirmation: process.env.DATABASE_MIGRATION_CONFIRM_PRODUCTION,
});
const environment = {
	...process.env,
	DATABASE_MIGRATION_URL: process.env.DATABASE_MIGRATION_URL ?? process.env.API_DATABASE_URL,
};
for (const [owner, runtime] of [["DATABASE_MIGRATION_URL", "API_DATABASE_URL"], ["PBX_DATABASE_MIGRATION_URL", "PBX_DATABASE_URL"], ["CDR_DATABASE_MIGRATION_URL", "CDR_DATABASE_URL"]]) {
	if (!environment[owner] && !environment[runtime]) throw Error(`${owner} is required`);
}
function run(command, args, env = environment) {
	const child = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
	if (child.error) throw child.error;
	if (child.status !== 0) throw Error(`Migration command failed: ${command} (exit ${child.status})`);
}
for (const name of ["db", "pbx-db", "cdr-db"]) {
	run("pnpm", ["exec", "tsx", `packages/${name}/scripts/migrate.ts`, "--expected-stage", stage]);
}
run(process.execPath, ["apps/api/scripts/db-provision.mjs"], { ...environment, API_DATABASE_URL: environment.DATABASE_MIGRATION_URL });
console.log("All platform migration journals are current.");
