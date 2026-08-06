import { MEDIA_KEY_PREFIXES } from "./media-storage";

/**
 * Renders `musiconhold.conf` from the `moh_class` table.
 *
 * ## The gap this closes, stated exactly
 *
 * `apps/api` writes an uploaded hold-music file to
 * `<PBX_MEDIA_OBJECT_ROOT>/moh/<organizationId>/<mohClassId>/<fileId>.wav`. `packages/routing`
 * resolves `mohClassId` to the class's NAME and puts that in the plan. `apps/engine` hands the name
 * to `POST /channels/{id}/moh?mohClass=<name>`. Asterisk then resolves that name against
 * `musiconhold.conf` — **not against a path** — so a deployment can have the audio on disk, the row
 * in the database, a working preview in the admin UI, and still play silence, because nothing ever
 * told the media server the class exists. `apps/asterisk/README.md` has said so since the media
 * wave; this is the thing that makes it stop being true.
 *
 * ## Pure, and deliberately so
 *
 * A function from rows to a string, with no database and no filesystem, on the same terms as
 * `src/provisioning/catalog/` — which renders phone configuration from `device` rows and states the
 * rule: a TypeScript function per output is the same amount of code as a string template with the
 * compiler switched on, and it keeps a golden assertion meaningful. The caller
 * (`scripts/generate-musiconhold.ts`) does the reading and the writing.
 *
 * ## The two roots, and why both are parameters
 *
 * The API and the media server see the same directory at two different paths. The API writes under
 * `PBX_MEDIA_OBJECT_ROOT`; Asterisk sees the mount at whatever `ENGINE_MEDIA_OBJECT_ROOT` names.
 * The `directory=` line has to be the CONTAINER's path, because Asterisk is the process that opens
 * it — writing the API's path there produces a file that is syntactically perfect and resolves to
 * nothing. So this function takes the container root and never the API's, which makes it impossible
 * to pass the wrong one by having only one to pass.
 *
 * ## The name collision, which is real and is not papered over
 *
 * `moh_class.name` is unique per ORGANIZATION (`moh_class_organization_name_key`), and Asterisk's
 * class namespace is GLOBAL — one file, one set of sections, no tenant dimension. Two tenants that
 * both name a class `default` therefore both compile to `mohClass: "default"` and collide.
 *
 * This renderer refuses that rather than resolving it. A collided name gets NO section and is
 * reported in {@link MusicOnHoldRender.conflicts}, so the class fails to resolve exactly as it does
 * today — a caller hears the media server's built-in default. The alternative, picking a winner,
 * would play one tenant's hold music to another tenant's callers, which is a cross-tenant media
 * leak dressed up as a convenience. The alternative of prefixing the section with the organization
 * id would be safe and would not work: the engine asks for the bare name, because the compiler put
 * the bare name in the plan, and that is `packages/routing`'s decision to change, not this file's.
 *
 * Recorded as a follow-up on the compiler's side: qualifying the class name at compile time
 * (`<orgId>-<name>`, or a per-tenant `musiconhold.conf` include) is what makes multi-tenant hold
 * music work without a naming convention imposed on admins.
 */

/** One row of `moh_class`, plus how many files are under it. Only what the file needs. */
export interface MohClassRow {
	readonly id: string;
	readonly organizationId: string;
	readonly name: string;
	readonly source: "library" | "stream";
	readonly streamUri: string | null;
	readonly shuffle: boolean;
	readonly sampleRateHz: number;
	readonly enabled: boolean;
	/** How many `prompt` rows with `kind = "moh"` point at this class. */
	readonly fileCount: number;
}

export interface MusicOnHoldRenderOptions {
	/**
	 * Where the object store is mounted INSIDE the media server — the same value
	 * `ENGINE_MEDIA_OBJECT_ROOT` carries. Never the API's `PBX_MEDIA_OBJECT_ROOT`.
	 */
	readonly containerObjectRoot: string;
	/** Stamped into the banner. Injected so a golden assertion is not a clock race. */
	readonly generatedAt?: string;
	/** Stamped into the banner so a file on a box can be traced to the run that made it. */
	readonly source?: string;
}

export interface MusicOnHoldConflict {
	readonly name: string;
	readonly organizationIds: readonly string[];
}

export interface MusicOnHoldSkip {
	readonly id: string;
	readonly organizationId: string;
	readonly name: string;
	readonly reason: "disabled" | "no-files" | "stream-without-uri" | "name-conflict";
}

export interface MusicOnHoldRender {
	readonly body: string;
	/** Class names that reached the file. */
	readonly declared: readonly string[];
	/** Names claimed by more than one organization. None of them are declared. */
	readonly conflicts: readonly MusicOnHoldConflict[];
	/** Every class that did not produce a section, with the reason. */
	readonly skipped: readonly MusicOnHoldSkip[];
}

/**
 * The class Asterisk falls back to when a channel asks for one that does not exist, and the class
 * `res_musiconhold` itself looks for on load.
 *
 * Declared unconditionally and first, pointing at the sounds baked into the image, because the
 * failure mode without it is the worst one available: `res_musiconhold` with zero classes logs
 * nothing useful and every hold is silence. A tenant class named `default` collides with it, and is
 * reported as a conflict for exactly that reason.
 */
const RESERVED_NAMES = new Set(["default"]);

export function renderMusicOnHoldConf(
	classes: readonly MohClassRow[],
	options: MusicOnHoldRenderOptions,
): MusicOnHoldRender {
	const byName = new Map<string, MohClassRow[]>();
	for (const row of classes) {
		const bucket = byName.get(row.name);
		if (bucket === undefined) {
			byName.set(row.name, [row]);
		} else {
			bucket.push(row);
		}
	}

	const conflicts: MusicOnHoldConflict[] = [];
	const skipped: MusicOnHoldSkip[] = [];
	const declared: string[] = [];
	const sections: string[] = [];

	// Sorted by name so two runs over an unchanged database produce a byte-identical file — which is
	// what lets a deployment diff the generated conf, and what makes "did anything change?" a
	// question the generator can answer without a checksum of the database.
	for (const name of [...byName.keys()].sort((left, right) => left.localeCompare(right))) {
		const rows = byName.get(name) ?? [];
		const owners = [...new Set(rows.map((row) => row.organizationId))].sort();

		if (owners.length > 1 || RESERVED_NAMES.has(name)) {
			conflicts.push({ name, organizationIds: owners });
			for (const row of rows) {
				skipped.push({ ...pick(row), reason: "name-conflict" });
			}
			continue;
		}

		const row = rows[0];
		if (row === undefined) {
			continue;
		}
		if (!row.enabled) {
			// The compiler already warns that a disabled class falls back to the media server's own,
			// so declaring it here would make the two disagree: the warning would say "callers hear the
			// default" while the file made them hear the class.
			skipped.push({ ...pick(row), reason: "disabled" });
			continue;
		}
		if (row.source === "stream") {
			const uri = row.streamUri?.trim() ?? "";
			if (uri.length === 0) {
				// The DTO refuses this on write, so a row in this state predates the constraint or was
				// written around the API. Reported rather than emitted: `application=` with no URI is a
				// section Asterisk accepts and a class that hangs the channel.
				skipped.push({ ...pick(row), reason: "stream-without-uri" });
				continue;
			}
			sections.push(streamSection(row, uri));
			declared.push(name);
			continue;
		}
		if (row.fileCount === 0) {
			// `mode=files` over an empty directory is the one failure Asterisk handles badly: it logs
			// "cannot open dir" once at load and then serves silence for the life of the process.
			// Leaving the class undeclared makes the caller fall back to `default`, which at least has
			// audio in it.
			skipped.push({ ...pick(row), reason: "no-files" });
			continue;
		}
		sections.push(filesSection(row, options.containerObjectRoot));
		declared.push(name);
	}

	const body = [
		banner(options, declared.length, conflicts),
		defaultSection(),
		...sections,
		"",
	].join("\n");

	return { body, declared, conflicts, skipped };
}

function pick(row: MohClassRow): Omit<MusicOnHoldSkip, "reason"> {
	return { id: row.id, organizationId: row.organizationId, name: row.name };
}

/**
 * `<containerRoot>/moh/<organizationId>/<mohClassId>` — the directory the API's uploads land in,
 * spelled the way the media server sees it.
 *
 * Built from {@link MEDIA_KEY_PREFIXES} and the same id segments `buildObjectKey` uses, rather than
 * from a second hard-coded `"moh"`, so a change to the storage layout is a compile-time
 * relationship instead of a convention two files have to remember.
 */
export function mohClassDirectory(containerObjectRoot: string, row: MohClassRow): string {
	const root = containerObjectRoot.replace(/\/+$/u, "");
	return [root, MEDIA_KEY_PREFIXES.moh, row.organizationId, row.id].join("/");
}

function filesSection(row: MohClassRow, containerObjectRoot: string): string {
	return [
		`[${row.name}]`,
		`; ${row.fileCount} file(s), organization ${row.organizationId}, class ${row.id}`,
		"mode=files",
		`directory=${mohClassDirectory(containerObjectRoot, row)}`,
		// `sort=random` is Asterisk's spelling of shuffle. `alpha` rather than the default `nothing`
		// for the non-shuffled case, so the play order is the one the admin UI lists the files in
		// rather than whatever order the filesystem happens to return them.
		`sort=${row.shuffle ? "random" : "alpha"}`,
		// Asterisk transcodes whatever it finds, so this is a hint about what to prefer rather than a
		// constraint. Stated anyway: a class an admin declared as wideband should not be silently
		// served as narrowband because nothing said otherwise.
		`; declared sample rate ${row.sampleRateHz} Hz`,
		"",
	].join("\n");
}

function streamSection(row: MohClassRow, uri: string): string {
	return [
		`[${row.name}]`,
		`; stream class, organization ${row.organizationId}, class ${row.id}`,
		"mode=custom",
		// `-quiet -` is what makes mpg123 write raw audio to stdout, which is the only shape
		// `mode=custom` can consume. The rate is the class's, because a stream decoded at the wrong
		// rate plays at the wrong speed rather than failing.
		`application=/usr/bin/mpg123 -q -s --rate ${row.sampleRateHz} --mono -`,
		`; source ${uri}`,
		"",
	].join("\n");
}

/**
 * The fallback class, pointing at the sounds directory every Asterisk image already has.
 *
 * `mode=files` over `/usr/share/asterisk/moh` is the stock layout; the package ships nothing there
 * on Alpine, which is why `apps/asterisk/Dockerfile` copies a loop into it. A class that resolves
 * to an empty directory is still better than no `default` section at all: with no section,
 * `res_musiconhold` has nothing to fall back to and a `Hold` with an unknown class is silence with
 * no log line.
 */
function defaultSection(): string {
	return [
		"[default]",
		"; The media server's fallback. Never generated from a tenant row — see the header's note on",
		"; the global class namespace. A tenant class named `default` is reported as a conflict.",
		"mode=files",
		"directory=/usr/share/asterisk/moh",
		"sort=alpha",
		"",
	].join("\n");
}

function banner(
	options: MusicOnHoldRenderOptions,
	declaredCount: number,
	conflicts: readonly MusicOnHoldConflict[],
): string {
	const lines = [
		"; GENERATED FILE — every edit here is lost on the next generation.",
		";",
		"; Rendered from the `moh_class` table by",
		"; `pnpm --filter @optimiq-voice/api generate:musiconhold`. Change hold music in the admin UI",
		"; under Media, then regenerate and reload the media server:",
		";",
		";   asterisk -rx 'module reload res_musiconhold.so'",
		";",
		`; ${declaredCount} class(es) declared beyond [default].`,
	];
	if (options.source !== undefined) {
		lines.push(`; source: ${options.source}`);
	}
	if (options.generatedAt !== undefined) {
		lines.push(`; generated: ${options.generatedAt}`);
	}
	if (conflicts.length > 0) {
		lines.push(
			";",
			"; NOT DECLARED — these names are claimed by more than one organization, and Asterisk's",
			"; class namespace is global. Declaring one would play one tenant's hold music to another",
			"; tenant's callers. Rename the class in the admin UI:",
		);
		for (const conflict of conflicts) {
			lines.push(`;   ${conflict.name} — ${conflict.organizationIds.join(", ")}`);
		}
	}
	lines.push("");
	return lines.join("\n");
}
