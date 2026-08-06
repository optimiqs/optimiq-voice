/**
 * Renders `musiconhold.conf` from the `moh_class` table.
 *
 *   PBX_DATABASE_URL=postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx \
 *   PBX_MEDIA_OBJECT_ROOT=/opt/optimiq-voice/recordings \
 *     pnpm --filter @optimiq-voice/api generate:musiconhold
 *
 * ## Why this exists, and why it is a script rather than a request handler
 *
 * A hold-music class is a row in PostgreSQL and a section in a file on the media server's
 * filesystem. Nothing bridged the two: `apps/asterisk/README.md` has recorded since the media wave
 * that uploading files under `moh/<org>/<class>/` puts audio where the container can see it and does
 * not make the class exist. `src/pbx/media/musiconhold-conf.ts` is the renderer; this is the one
 * thing that reads the database and writes the file.
 *
 * **The delivery decision, made honestly.** The obvious design is for `apps/api` to write the file
 * and then reload the module over ARI. It was rejected on evidence, not taste:
 *
 * - `apps/api` has no ARI client at all. `packages/media-ari` is `apps/engine`'s dependency, its
 *   `AriAsterisk` resource wraps only `GET /asterisk/info`, and ARI's module endpoints are not
 *   modelled. Wiring a broker-grade HTTP client and a second set of ARI credentials into the control
 *   plane to set one file is a large coupling for a small effect.
 * - Asterisk's ARI port is not reachable from the API in the shipped stack: `compose.yaml` gives the
 *   asterisk service `expose: 6060` and nothing else — 8088 is published only by
 *   `compose.dev.yaml`, for a developer's browser.
 * - There is no AMI client in the repository and port 5038 is not exposed either.
 *
 * So the delivery is the other one the plan allows: **a file the API generates and the container
 * picks up**, with the reload stated as an operator step rather than pretended away. `run.sh` copies
 * it into `/etc/asterisk` at start, so a restart is always sufficient; `asterisk -rx 'module reload
 * res_musiconhold.so'` is the no-restart path, and the Dockerfile's healthcheck already proves
 * `asterisk -rx` works at that privilege level. Both are in `apps/asterisk/README.md`.
 *
 * ## Where it writes, and the two roots
 *
 * Into the object root the API already writes MOH audio into — `<PBX_MEDIA_OBJECT_ROOT>/moh/` —
 * because that directory is by construction the one a deployment has already mounted into the media
 * server. A separate config volume would be a second mount that exists only for this file and that
 * a deployment can forget.
 *
 * The `directory=` lines inside the file are the CONTAINER's paths, from
 * `PBX_MEDIA_CONTAINER_ROOT` (default `/var/lib/optimiq/objects`, the path `apps/asterisk`'s README
 * prescribes and `ENGINE_MEDIA_OBJECT_ROOT` names). Getting this wrong produces a file that parses
 * perfectly and resolves to nothing, which is why the renderer takes only the container root.
 *
 * ## Flags
 *
 * `--dry-run` prints the file and writes nothing. `--out <path>` overrides the destination.
 * `--stdout` writes the file to standard output and nothing to disk, for a pipeline that wants to
 * place it itself.
 *
 * ## Exit code
 *
 * Non-zero when any class was left undeclared for a reason an admin can act on — a name two
 * organizations claim, a `stream` class with no URI. A class with no files yet is NOT one of those:
 * it is the normal state of a class somebody just created, and failing a pipeline for it would make
 * the generator unusable on a fresh install.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createPbxDatabaseClient, eq, mohClass, prompt } from "@optimiq-voice/pbx-db";
import { MEDIA_KEY_PREFIXES } from "../src/pbx/media/media-storage";
import { renderMusicOnHoldConf } from "../src/pbx/media/musiconhold-conf";
import type { MohClassRow } from "../src/pbx/media/musiconhold-conf";

const DEFAULT_PBX_DATABASE_URL = "postgresql://optimiq:optimiq@localhost:5433/optimiq_pbx";
const DEFAULT_OBJECT_ROOT = "/opt/optimiq-voice/recordings";
/** Where `apps/asterisk`'s README tells an operator to mount the object store. */
const DEFAULT_CONTAINER_ROOT = "/var/lib/optimiq/objects";

const dryRun = process.argv.includes("--dry-run");
const toStdout = process.argv.includes("--stdout");
const outIndex = process.argv.indexOf("--out");
const outOverride = outIndex === -1 ? undefined : process.argv[outIndex + 1];

function log(message: string, detail?: Record<string, unknown>): void {
	console.error(detail === undefined ? message : `${message} ${JSON.stringify(detail)}`);
}

/**
 * Every class on the platform with its file count, read as the OWNER principal.
 *
 * `withTenantScope` is deliberately not used: it sets one organization id, and the media server has
 * one configuration file for the whole box. `scripts/rebuild-queue-membership.ts` reaches for
 * `adminDb` on the same grounds and records the same reason. The cross-tenant read is also what
 * makes the name-collision check possible at all — a per-tenant read could never see the collision.
 *
 * Two unjoined selects and an in-memory count, following the loader convention `snapshot-loader.ts`
 * sets and `readRosterRows` follows. A correlated subquery would be one round trip fewer and would
 * be the wrong shape here for a concrete reason: Drizzle renders a column interpolated into a raw
 * `sql` fragment UNQUALIFIED, so `where <moh_class_id> = <id>` inside a subquery over `prompt`
 * binds BOTH names to `prompt` and silently counts zero. The join is in TypeScript where it is
 * visible and testable.
 */
async function readClasses(
	database: ReturnType<typeof createPbxDatabaseClient>,
): Promise<readonly MohClassRow[]> {
	const [classes, files] = await Promise.all([
		database.adminDb.select().from(mohClass),
		database.adminDb
			.select({ mohClassId: prompt.mohClassId })
			.from(prompt)
			.where(eq(prompt.kind, "moh")),
	]);

	const fileCounts = new Map<string, number>();
	for (const file of files) {
		if (file.mohClassId === null) {
			continue;
		}
		fileCounts.set(file.mohClassId, (fileCounts.get(file.mohClassId) ?? 0) + 1);
	}

	return classes.map((row) => ({
		id: row.id,
		organizationId: row.organizationId,
		name: row.name,
		source: row.source,
		streamUri: row.streamUri,
		shuffle: row.shuffle,
		sampleRateHz: row.sampleRateHz,
		enabled: row.enabled,
		fileCount: fileCounts.get(row.id) ?? 0,
	}));
}

async function main(): Promise<void> {
	const pbxDatabaseUrl = process.env.PBX_DATABASE_URL ?? DEFAULT_PBX_DATABASE_URL;
	const objectRoot =
		process.env.PBX_MEDIA_OBJECT_ROOT ??
		process.env.PBX_VOICEMAIL_MEDIA_ROOT ??
		process.env.CDR_RECORDING_ROOT ??
		DEFAULT_OBJECT_ROOT;
	const containerRoot = process.env.PBX_MEDIA_CONTAINER_ROOT ?? DEFAULT_CONTAINER_ROOT;
	const destination =
		outOverride ?? resolve(objectRoot, MEDIA_KEY_PREFIXES.moh, "musiconhold.conf");

	log("rendering musiconhold.conf", {
		database: pbxDatabaseUrl.replace(/\/\/[^@]*@/u, "//***@"),
		objectRoot,
		containerRoot,
		destination: toStdout ? "(stdout)" : destination,
		dryRun,
	});

	const database = createPbxDatabaseClient({
		url: pbxDatabaseUrl,
		applicationName: "optimiq-musiconhold-generator",
		// 2 is the client's floor; a single-shot generator has no use for more.
		maxConnections: 2,
	});

	let exitCode = 0;
	try {
		const classes = await readClasses(database);
		const render = renderMusicOnHoldConf(classes, {
			containerObjectRoot: containerRoot,
			generatedAt: new Date().toISOString(),
			source: `${classes.length} moh_class row(s)`,
		});

		if (toStdout || dryRun) {
			process.stdout.write(render.body);
		}
		if (!toStdout && !dryRun) {
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, render.body, "utf8");
			log("wrote musiconhold.conf", { destination, bytes: render.body.length });
		}

		log("declared", { classes: render.declared });
		for (const skip of render.skipped) {
			log(`class "${skip.name}" was not declared`, {
				reason: skip.reason,
				organizationId: skip.organizationId,
				mohClassId: skip.id,
			});
			if (skip.reason === "name-conflict" || skip.reason === "stream-without-uri") {
				exitCode = 1;
			}
		}
		for (const conflict of render.conflicts) {
			log(
				`the class name "${conflict.name}" is claimed by ${conflict.organizationIds.length} ` +
					"organization(s) and by the media server's own fallback; Asterisk's class namespace " +
					"is global, so none of them were declared — rename the class in the admin UI",
				{ organizationIds: conflict.organizationIds },
			);
		}
		if (!dryRun && !toStdout) {
			log(
				"the media server picks this up on restart; to apply it now, run " +
					"`asterisk -rx 'module reload res_musiconhold.so'` in the asterisk container",
			);
		}
	} finally {
		await database.close();
	}

	process.exitCode = exitCode;
}

await main();
