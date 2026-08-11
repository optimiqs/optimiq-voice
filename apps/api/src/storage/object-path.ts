import { resolve as resolvePath, sep as pathSeparator } from "node:path";

/**
 * One containment check, for every filesystem-backed object root in this API.
 *
 * There were three copies of this function — `media-storage.ts`'s `resolveMediaObjectPath`,
 * `recording-token.ts`'s `resolveRecordingObjectPath`, and the alias
 * `voicemail-media-token.ts` re-exported from the second — all identical, all correct, and all
 * three of them a place a future edit could get it wrong in one and not the others. Both original
 * names still exist and now delegate here, so no import in the codebase moved and no test had to be
 * rewritten.
 */

/**
 * The absolute path for `objectKey` under `root`, proved to stay inside it.
 *
 * `path.resolve` normalises `..`, so `../../etc/passwd` becomes an absolute path that is compared
 * against the root rather than a string that looks suspicious. The comparison appends the platform
 * separator deliberately: without it `/opt/recordings-evil/x` passes a bare `startsWith`
 * ("/opt/recordings"), which is the classic off-by-one in this check.
 *
 * Returns `undefined` rather than throwing so the caller decides whether the answer is a 403 (a
 * token named a bad key), a 500 (this process built one), or a refusal to write.
 */
export function resolveObjectPath(root: string, objectKey: string): string | undefined {
	const normalizedRoot = resolvePath(root);
	const candidate = resolvePath(normalizedRoot, objectKey);
	if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${pathSeparator}`)) {
		return undefined;
	}
	return candidate;
}
