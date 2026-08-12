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
 * ## `object://` and the mount it needs
 *
 * The compiler embeds a voicemail greeting as `object://<objectKey>` — a key into the deployment's
 * object store, because that is what `voicemail_greeting.object_key` is and rendering it as a path
 * at compile time would bake one deployment's layout into every artifact.
 *
 * Turning that key into audio is where an honest limitation lives. **ARI has no HTTP media
 * scheme.** `POST /channels/{id}/play` accepts `sound:`, `recording:`, `number:`, `digits:`,
 * `characters:` and `tone:` and nothing else, so there is no URL the engine can hand Asterisk that
 * makes it fetch an object. The only way audio in the object store becomes playable is for the
 * store to be *visible to the media server as a filesystem*, at which point `sound:<absolute
 * path>` works (ARI resolves an absolute path without an extension and picks the best format
 * itself).
 *
 * So {@link MediaRefSettings.objectMediaRoot} is the deployment's answer to "where is the object
 * store mounted inside the media server". Set it and greetings play; leave it unset and
 * `object://` resolves to `undefined`, which every caller reads as "use the configured
 * announcement". Reporting the gap beats playing silence, and inventing a fetch-and-stage step
 * inside the engine would put a download on the call path.
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
	/**
	 * Absolute path, INSIDE the media server, at which the object store is mounted.
	 *
	 * Empty means "it is not mounted", which is the default and the state of the compose stack in
	 * this repo: no service mounts one, so `object://` refs resolve to nothing and every caller
	 * falls back. See the header for why there is no HTTP alternative.
	 */
	readonly objectMediaRoot: string;
}

export const DEFAULT_MEDIA_REF_SETTINGS: MediaRefSettings = {
	promptPrefix: "sound:",
	fallbackMedia: "sound:unavailable",
	objectMediaRoot: "",
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

/**
 * What a media server can be asked to do with one `MediaRef`.
 *
 * The typed half of {@link translateMediaRef}, added because one caller needs the REASON and not
 * just the absence. `StreamPlanNode` compiles a mandatory `fallbackNodeId` precisely so that a
 * source no driver can open produces a routed call rather than silence — and the note the walker
 * leaves on that fallback is the only place an operator will ever learn WHY the stream did not
 * play. "`translateMediaRef` returned undefined" is not that sentence; "no media server this
 * platform ships can open an http(s) source" is.
 */
export type MediaRefResolution =
	| { readonly kind: "playable"; readonly media: string }
	| { readonly kind: "unplayable"; readonly reason: string };

/**
 * One `MediaRef` in the media server's vocabulary, or a refusal that says why.
 *
 * ## Remote sources, and why neither driver takes one
 *
 * This was checked rather than assumed, because the obvious hope is that ARI passes an `https://`
 * URI through to Asterisk. It does — `AriMediaAdapter.play` puts whatever it is handed straight into
 * `POST /channels/{id}/play` — but Asterisk's media vocabulary is `sound:`, `recording:`, `number:`,
 * `digits:`, `characters:` and `tone:`, so the request comes back a 4xx and the caller hears the
 * silence between issuing a verb and having it fail. Passing it through would move the failure from
 * a place that can take a fallback branch to a place that cannot.
 *
 * `mediad` refuses by name and says so on the wire: `apps/mediad/internal/audio/library.go` resolves
 * `sound:`, `tone:` and `moh:` out of a mounted directory and answers `ErrUnsupportedScheme` for
 * anything else, deliberately — a fetch-and-stage rung would put a download on the call path.
 *
 * So the honest answer for both drivers is the same refusal, and the remote-fetch rung is still the
 * seam this file's header describes. What changed is that the gap now has a NAME the walker can read
 * out into a note.
 */
export function resolveMediaRefOrExplain(
	ref: string,
	settings: MediaRefSettings = DEFAULT_MEDIA_REF_SETTINGS,
): MediaRefResolution {
	const media = translateMediaRef(ref, settings);
	if (media !== undefined) {
		return { kind: "playable", media };
	}
	const trimmed = ref.trim();
	if (trimmed === "") {
		return { kind: "unplayable", reason: "the media reference is empty" };
	}
	if (REMOTE_SCHEMES.some((scheme) => trimmed.startsWith(scheme))) {
		return {
			kind: "unplayable",
			reason:
				"no media server this platform ships can open a remote source: Asterisk's media vocabulary " +
				"has no http(s) scheme, and mediad plays only what is mounted. See media-refs.ts.",
		};
	}
	if (trimmed.startsWith("tts://")) {
		return { kind: "unplayable", reason: "there is no text-to-speech renderer on this platform" };
	}
	if (trimmed.startsWith("object://")) {
		return {
			kind: "unplayable",
			reason:
				"the object store is not mounted for the media server (set ENGINE_MEDIA_OBJECT_ROOT), or " +
				"the key escapes it",
		};
	}
	return {
		kind: "unplayable",
		reason: `"${trimmed}" is not a media reference this release renders`,
	};
}

/** The schemes that name audio somewhere else on the network. Neither driver can open one. */
const REMOTE_SCHEMES = ["http://", "https://", "stream://"] as const;

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
	if (trimmed.startsWith("object://")) {
		return objectMedia(trimmed.slice("object://".length), settings);
	}
	// `stream://`, `tts://`, `http(s)://` — real sources with no direct ARI equivalent. See the
	// header: reporting the gap beats playing silence, and {@link resolveMediaRefOrExplain} is what
	// turns the gap into a sentence an operator can act on.
	return undefined;
}

/**
 * An object key under the configured mount, as a `sound:` path.
 *
 * `..` is rejected rather than normalised. The key comes out of an artifact, which comes out of a
 * database row, which comes out of an upload — three hops from something a tenant controls. A key
 * of `../../etc/asterisk/whatever` that this function helpfully resolved would be a tenant reading
 * a file off the media server by leaving themselves a voicemail greeting.
 */
function objectMedia(objectKey: string, settings: MediaRefSettings): string | undefined {
	const root = settings.objectMediaRoot.trim().replace(/\/+$/, "");
	const key = objectKey.trim().replace(/^\/+/, "");
	if (root === "" || key === "") {
		return undefined;
	}
	if (key.split("/").includes("..")) {
		return undefined;
	}
	return `sound:${stripExtension(`${root}/${key}`)}`;
}

function stripExtension(path: string): string {
	const lastSlash = path.lastIndexOf("/");
	const lastDot = path.lastIndexOf(".");
	return lastDot > lastSlash ? path.slice(0, lastDot) : path;
}
