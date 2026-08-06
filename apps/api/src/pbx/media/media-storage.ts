import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath, sep as pathSeparator } from "node:path";

/**
 * Where uploaded media lands on disk, and what its key looks like.
 *
 * ## One object root, three writers, one reader
 *
 * The deployment has exactly one object store. `apps/engine` writes call recordings and voicemail
 * messages into it; this module writes the media LIBRARY into it (MOH files, prompts, voicemail
 * greetings); and the media server reads all of it through a mount it knows as
 * `ENGINE_MEDIA_OBJECT_ROOT`. That is why `PBX_MEDIA_OBJECT_ROOT` defaults to
 * `PBX_VOICEMAIL_MEDIA_ROOT`, which itself defaults to `CDR_RECORDING_ROOT` — see `pbx-env.ts`.
 * A deployment that configured a second, separate root for uploads would produce a library whose
 * files exist, whose rows are correct, and whose audio the media server cannot find.
 *
 * ## The key layout, and why the ids rather than the names
 *
 * ```text
 * prompts/<organizationId>/<promptId>.<ext>
 * moh/<organizationId>/<mohClassId>/<promptId>.<ext>
 * greetings/<organizationId>/<voicemailBoxId>/<greetingId>.<ext>
 * ```
 *
 * Every segment is a UUID this server minted. Not the class's NAME, not the uploader's file name,
 * and not the prompt's label — three reasons, in order of how much they cost when ignored:
 *
 * 1. **A rename must not move files.** `moh_class.name` is editable and renaming a class
 *    recompiles the tenant's artifact (`moh_class` is a routing input). If the key carried the
 *    name, a rename would have to relocate every file under it inside the same transaction, and a
 *    failure halfway would leave a class whose audio is split across two directories.
 * 2. **A user-supplied name is user-supplied input on a filesystem path.** `../../etc/passwd`,
 *    NUL bytes, a 4000-character name, a name that differs from another only by Unicode
 *    normalisation on a case-insensitive volume. {@link buildObjectKey} would have to sanitise all
 *    of it correctly, forever. A UUID has none of those properties.
 * 3. **The tenant segment makes containment auditable.** Every key begins with the organization
 *    that owns it, so a stray file is attributable by looking at it, and a listing per tenant is a
 *    directory read rather than a database join.
 *
 * The uploader's original file name is not lost: it is kept on the row (`prompt.name`,
 * `voicemail_greeting.label`) where it is data rather than a path.
 *
 * ## The extension is kept even though the engine strips it
 *
 * `apps/engine/src/routing/media-refs.ts` renders `object://<key>` as
 * `sound:<root>/<key-without-extension>` on purpose: Asterisk resolves a stem and picks the best
 * format sitting beside it, and pinning `.wav` on a box that also has a `.g722` forces a transcode
 * on every play. The extension is still written here because the file has to have one for the API's
 * own media route to serve a sensible `content-type`, and for an operator looking at the directory
 * to know what they are looking at. The two uses do not conflict: one reads the stem, one reads the
 * whole key.
 */

/** The prefixes, so "what is under the root" is answerable by grep rather than by convention. */
export const MEDIA_KEY_PREFIXES = {
	prompt: "prompts",
	moh: "moh",
	greeting: "greetings",
} as const;

export type MediaKeyKind = keyof typeof MEDIA_KEY_PREFIXES;

/**
 * The object key for one uploaded file.
 *
 * `segments` are the ids between the prefix and the file: none for a prompt, the MOH class for an
 * MOH file, the mailbox for a greeting. Every one of them is a UUID this server minted, so no
 * escaping is needed and none is performed — {@link resolveMediaObjectPath} is the check that
 * proves it, and it runs on every read and every write regardless.
 */
export function buildObjectKey(
	kind: MediaKeyKind,
	organizationId: string,
	segments: readonly string[],
	fileId: string,
	extension: string,
): string {
	return [MEDIA_KEY_PREFIXES[kind], organizationId, ...segments, `${fileId}.${extension}`].join(
		"/",
	);
}

/**
 * The absolute path for a key under `root`, proved to stay inside it.
 *
 * The same containment check the recordings and voicemail routes apply, and it is here for the
 * WRITE side as well as the read side. On the read side it answers "did a key out of the database
 * address a file outside the root"; on the write side it answers "is the key this process just
 * built one it is allowed to create" — which is a weaker question today, because every segment is
 * a minted UUID, and is exactly the check that keeps it weak if that ever stops being true.
 *
 * Returns `undefined` rather than throwing, so the caller decides whether the answer is a 403
 * (a token named a bad key) or a 500 (this process built one).
 */
export function resolveMediaObjectPath(root: string, objectKey: string): string | undefined {
	const normalizedRoot = resolvePath(root);
	const candidate = resolvePath(normalizedRoot, objectKey);
	if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${pathSeparator}`)) {
		return undefined;
	}
	return candidate;
}

/**
 * Writes an object, creating its directory.
 *
 * `writeFile` rather than a stream because the bytes are already buffered: the size cap is enforced
 * before anything is written (see `media-upload.ts`), which means the whole file is in memory by
 * the time we know it is acceptable, and a stream would buy nothing but a partially-written object
 * on a mid-write failure.
 *
 * @throws when the key escapes the root — a defect, not a client error.
 */
export async function writeMediaObject(
	root: string,
	objectKey: string,
	bytes: Buffer,
): Promise<string> {
	const path = resolveMediaObjectPath(root, objectKey);
	if (path === undefined) {
		throw new Error(`refusing to write a media object outside the object root: ${objectKey}`);
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, bytes);
	return path;
}

/**
 * Deletes an object, tolerating its absence.
 *
 * Absence is not an error here and the difference from the CDR area is deliberate.
 * `voicemail-messages.service.ts` does NOT unlink audio when a message row is purged, because
 * retention owns a RECORDING's lifecycle and a control plane deleting files behind it produces
 * rows whose media vanished for a reason nothing recorded. A media-library object has no retention
 * policy and no second owner: the row IS the reason the file exists, and leaving orphans under the
 * mount would grow the store forever with files nothing can name. So the library unlinks, and a
 * file already gone is the state we wanted.
 */
export async function deleteMediaObject(root: string, objectKey: string): Promise<void> {
	const path = resolveMediaObjectPath(root, objectKey);
	if (path === undefined) {
		return;
	}
	await rm(path, { force: true });
}

/** The object's size, or `undefined` when it is missing or is not a regular file. */
export async function mediaObjectSize(path: string): Promise<number | undefined> {
	try {
		const info = await stat(path);
		return info.isFile() ? info.size : undefined;
	} catch {
		return undefined;
	}
}
