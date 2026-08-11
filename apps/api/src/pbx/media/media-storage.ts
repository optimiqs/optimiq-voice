import { resolveObjectPath } from "../../storage";

/**
 * What an uploaded media object's key looks like, and where it lands.
 *
 * ## The bytes moved out of this file; the KEYS did not
 *
 * `writeMediaObject`, `deleteMediaObject` and `mediaObjectSize` used to live here as three thin
 * wrappers over `node:fs`. They are now `ObjectStore.put` / `.delete` / `.head` — see
 * `src/storage/object-store.ts` for the seam and `local-object-store.ts` for the driver that
 * reproduces exactly what they did, against exactly these paths. What stayed is the part that was
 * never about the filesystem: the KEY LAYOUT below, and the containment check that proves a key
 * addresses something inside its root.
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
 * The area's name for `resolveObjectPath`, which is now one implementation shared by every
 * filesystem-backed root in this API (`src/storage/object-path.ts`). There were three identical
 * copies of this check — this one, the CDR area's `resolveRecordingObjectPath`, and the alias the
 * voicemail token module re-exported — which is three places for a future edit to get it right in
 * two. The name stays so no import moved.
 *
 * Still used directly, and not only by the store: `musiconhold-conf.ts` and the engine-facing
 * vocabulary need to know WHERE a key would land on the shared volume, which is a different
 * question from "open it for me".
 */
export const resolveMediaObjectPath = resolveObjectPath;
