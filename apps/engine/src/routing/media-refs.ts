/**
 * Domain `MediaRef` → media-server media URI.
 *
 * `packages/telephony` defines a `MediaRef` as a URI whose SCHEME selects the source
 * (`prompt://`, `file://`, `tone://`, `stream://`, `tts://`), and a plan node carries either a
 * `promptId` (a row in the tenant's prompt library) or a raw `media` ref. Asterisk speaks a
 * different, flatter vocabulary: `sound:`, `tone:`, `recording:`, `digits:`, `number:`.
 *
 * The translation lives here rather than in the ARI adapter for one reason: `promptId → URI` is a
 * PRODUCT decision (where does a tenant's audio live?) and `URI → sound:` is a PROTOCOL detail.
 * Putting the first one below the media seam would make the prompt library an Asterisk concept.
 *
 * ## What this slice does NOT do
 *
 * It does not fetch, cache or render anything. `tts://` and `https://` have no ARI equivalent that
 * does not involve downloading the audio first, so they resolve to `undefined` and the caller
 * falls back to its configured announcement rather than playing silence at a caller. The prompt
 * library and the TTS renderer are the next wave; this is the seam they will land behind.
 */

/** Everything the resolver needs to know about where a tenant's prompts live. */
export interface MediaRefSettings {
	/**
	 * Prefix a bare `promptId` is rendered under, e.g. `sound:prompts/`. The default resolves to
	 * the media server's own sound set, which is what a development image actually has on disk.
	 */
	readonly promptPrefix: string;
	/** Played when a node names audio this slice cannot resolve. */
	readonly fallbackMedia: string;
}

export const DEFAULT_MEDIA_REF_SETTINGS: MediaRefSettings = {
	promptPrefix: "sound:",
	fallbackMedia: "sound:unavailable",
};

/** Media URI schemes Asterisk understands directly; anything already in one is passed through. */
const NATIVE_SCHEMES = ["sound:", "recording:", "number:", "digits:", "characters:", "tone:"];

/**
 * Resolves a node's audio to something the media server can play.
 *
 * Returns `undefined` when neither field is set OR the ref names a source this slice cannot serve,
 * so a caller can decide between "play the fallback" and "play nothing at all" — an IVR greeting
 * that silently does not play is the defect that makes an IVR unusable, whereas a `playback` node
 * with no audio is a legitimate "just continue".
 */
export function resolveMediaRef(
	node: { readonly promptId?: string; readonly media?: string },
	settings: MediaRefSettings = DEFAULT_MEDIA_REF_SETTINGS,
): string | undefined {
	const media = node.media?.trim();
	if (media !== undefined && media !== "") {
		return translateMediaRef(media, settings);
	}
	const promptId = node.promptId?.trim();
	if (promptId !== undefined && promptId !== "") {
		return `${settings.promptPrefix}${promptId}`;
	}
	return undefined;
}

/** {@link resolveMediaRef}, but never `undefined`: the configured fallback fills the gap. */
export function resolveMediaRefOr(
	node: { readonly promptId?: string; readonly media?: string },
	settings: MediaRefSettings = DEFAULT_MEDIA_REF_SETTINGS,
): string {
	return resolveMediaRef(node, settings) ?? settings.fallbackMedia;
}

/** One `MediaRef` in the media server's vocabulary, or `undefined` when it has no equivalent. */
export function translateMediaRef(
	ref: string,
	settings: MediaRefSettings = DEFAULT_MEDIA_REF_SETTINGS,
): string | undefined {
	const trimmed = ref.trim();
	if (trimmed === "") {
		return undefined;
	}
	// The domain schemes are checked FIRST, and the test is `://` rather than the scheme name:
	// `tone://ring` also starts with ARI's `tone:`, and passing it through unchanged would hand the
	// media server a URI with two stray slashes in it.
	if (!trimmed.includes("://") && NATIVE_SCHEMES.some((scheme) => trimmed.startsWith(scheme))) {
		return trimmed;
	}
	if (trimmed.startsWith("prompt://")) {
		return `${settings.promptPrefix}${trimmed.slice("prompt://".length)}`;
	}
	if (trimmed.startsWith("tone://")) {
		return `tone:${trimmed.slice("tone://".length)}`;
	}
	if (trimmed.startsWith("file://")) {
		// ARI's `sound:` accepts an absolute path without an extension. Stripping one the caller
		// supplied is deliberate: Asterisk picks the best available format itself, and pinning
		// `.wav` on a box that also has `.g722` forces a transcode on every play.
		return `sound:${stripExtension(trimmed.slice("file://".length))}`;
	}
	// `stream://`, `tts://`, `https://` — real sources with no direct ARI equivalent. See the
	// header: reporting the gap beats playing silence.
	return undefined;
}

function stripExtension(path: string): string {
	const lastSlash = path.lastIndexOf("/");
	const lastDot = path.lastIndexOf(".");
	return lastDot > lastSlash ? path.slice(0, lastDot) : path;
}
