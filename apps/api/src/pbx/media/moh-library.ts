import { MEDIA_KEY_PREFIXES } from "./media-storage";
import { DEFAULT_MOH_CLASS } from "./system-media";
import type { MohClassRow } from "./musiconhold-conf";

/**
 * Music-on-hold classes, as `mediad` can actually reach them.
 *
 * ## The mismatch this exists to bridge
 *
 * Two planes address a hold-music class in two different ways, and only one of them was served.
 *
 * - **Asterisk** takes a class by NAME (`channels.startMoh("jazz")`) and looks it up in
 *   `musiconhold.conf`, whose `directory=` line points at
 *   `<root>/moh/<organizationId>/<mohClassId>/`. `musiconhold-conf.ts` generates that file, so
 *   Asterisk resolves the name correctly.
 * - **`mediad`** takes a class by name too — the engine sends `moh:jazz`, because the compiler
 *   resolves `mohClassId` to the class's name for exactly this reason — but its library has no
 *   configuration file to consult. `internal/audio/library.go` resolves the class as ONE PATH
 *   ELEMENT under `<root>/moh/`, i.e. `<root>/moh/jazz.wav`.
 *
 * Nothing ever put a file there. So on the live stack a queue whose class resolved perfectly, whose
 * files were uploaded and whose rows were correct produced `no such prompt: sound:moh/RT-Hold` and
 * thirty seconds of silence — the same defect as the missing default class, one layer up.
 *
 * ## The fix, and why it is a published FILE rather than a protocol change
 *
 * The class's audio is published a second time, under the name the media plane asks for. That is
 * the delivery `generate-musiconhold.ts` already argues for at length and for the same reasons:
 * this API cannot reach the media plane's control port, the mount is the interface the two share,
 * and a file the media server picks up is the one channel that exists.
 *
 * The alternative — teaching the engine to send an object key and `mediad` to loop it — is a change
 * to the plan schema, the `MediaPort` signature and the `moh:` grammar, in three packages, to move
 * a decision that Asterisk's global class namespace already forces on the platform anyway. It is
 * the right eventual shape and it is recorded as such; it is not the shape of a fix for silence on
 * a call.
 *
 * ## The namespace is global, and that is inherited rather than chosen
 *
 * A class is addressed by bare name on both planes, so two organizations that both call a class
 * "Hold" are one name. `renderMusicOnHoldConf` already decides this — it declares neither, and
 * reports the collision so an admin can rename — and {@link mohLibraryPlan} takes ITS answer rather
 * than inventing a second rule, so the two planes never disagree about which class a name means.
 */

/** One class whose audio should be published under its name, and where to copy it from. */
export interface MohLibraryEntry {
	readonly name: string;
	readonly organizationId: string;
	readonly mohClassId: string;
	/** The `prompt.object_key` whose bytes become `moh/<name>.wav`. */
	readonly sourceObjectKey: string;
}

/** Why a class the deployment has is not published under its name. */
export interface MohLibrarySkip {
	readonly name: string;
	readonly organizationId: string;
	readonly reason: "name-conflict" | "disabled" | "no-files" | "stream";
}

export interface MohLibraryPlan {
	readonly entries: readonly MohLibraryEntry[];
	readonly skipped: readonly MohLibrarySkip[];
}

/** The object key a class's audio is published at, for the media plane's `moh:<name>`. */
export function mohLibraryObjectKey(name: string): string {
	return `${MEDIA_KEY_PREFIXES.moh}/${name}.wav`;
}

/**
 * Which classes get published, and from which file.
 *
 * `declared` from {@link import("./musiconhold-conf").renderMusicOnHoldConf} is the gate, so a
 * class Asterisk refuses to declare is a class `mediad` refuses to resolve. A `stream` class is
 * dropped here even though Asterisk declares it: `mediad` plays files, and a shell command that
 * fetches a stream is not something the media plane runs.
 *
 * The source file is the lowest `prompt.id` under the class — deterministic, so two runs over an
 * unchanged database publish the same bytes, which is what lets the seeder skip the write. Shuffle
 * and multi-file classes are therefore ONE of their files on this plane; `library.go`'s own header
 * records the directory-of-clips form as the additive step that removes that limit.
 */
export function mohLibraryPlan(
	classes: readonly MohClassRow[],
	declared: readonly string[],
	filesByClass: ReadonlyMap<string, readonly { readonly id: string; readonly objectKey: string }[]>,
): MohLibraryPlan {
	const declaredNames = new Set(declared);
	const entries: MohLibraryEntry[] = [];
	const skipped: MohLibrarySkip[] = [];

	for (const row of [...classes].sort((left, right) => left.name.localeCompare(right.name))) {
		const shared = { name: row.name, organizationId: row.organizationId };
		if (!row.enabled) {
			skipped.push({ ...shared, reason: "disabled" });
			continue;
		}
		if (row.source === "stream") {
			skipped.push({ ...shared, reason: "stream" });
			continue;
		}
		const files = [...(filesByClass.get(row.id) ?? [])].sort((left, right) =>
			left.id.localeCompare(right.id),
		);
		const source = files.find((file) => file.objectKey.trim().length > 0);
		if (source === undefined) {
			// Ahead of the `declared` gate so the reason an admin reads is the one they can act on: an
			// empty class is undeclared too, and "name-conflict" would send them renaming for nothing.
			skipped.push({ ...shared, reason: "no-files" });
			continue;
		}
		// `default` is the platform's own asset (`system-media.ts`), which every caller with no class
		// configured falls back to; a tenant class of that name is the same collision Asterisk has and
		// `renderMusicOnHoldConf` already refuses to declare it. Reading `declared` rather than
		// re-deciding is what keeps the two planes agreeing about which class a name means.
		if (row.name === DEFAULT_MOH_CLASS || !declaredNames.has(row.name)) {
			skipped.push({ ...shared, reason: "name-conflict" });
			continue;
		}
		entries.push({
			name: row.name,
			organizationId: row.organizationId,
			mohClassId: row.id,
			sourceObjectKey: source.objectKey,
		});
	}

	return { entries, skipped };
}
