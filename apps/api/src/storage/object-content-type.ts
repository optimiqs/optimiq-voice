/**
 * The content type of a stored object, from its key's extension.
 *
 * Everything this platform stores is audio the engine or a tenant upload produced, so the map is
 * short and WAV is the default rather than `application/octet-stream` — that is what the engine
 * writes, and guessing it correctly is the difference between a browser playing an archived
 * recording and offering to download it.
 *
 * It lives in `src/storage` because both a reader (`cdr/recordings`) and a writer
 * (`MirroredObjectStore.archiveObject`) need the same answer, and the two are in different areas.
 */
export function objectContentType(objectKey: string): string {
	const lower = objectKey.toLowerCase();
	if (lower.endsWith(".mp3")) {
		return "audio/mpeg";
	}
	if (lower.endsWith(".ogg") || lower.endsWith(".opus")) {
		return "audio/ogg";
	}
	return "audio/wav";
}
