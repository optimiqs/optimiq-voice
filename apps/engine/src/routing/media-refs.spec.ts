import { describe, expect, it } from "bun:test";
import {
	DEFAULT_MEDIA_REF_SETTINGS,
	resolveMediaRef,
	resolveMediaRefOr,
	translateMediaRef,
} from "./media-refs";

const SETTINGS = {
	promptPrefix: "sound:prompts/",
	fallbackMedia: "sound:unavailable",
	objectMediaRoot: "",
	prompts: {},
};

/** A deployment that HAS mounted its object store inside the media server. */
const MOUNTED = { ...SETTINGS, objectMediaRoot: "/var/lib/optimiq/objects" };

describe("resolveMediaRef", () => {
	it("renders a bare prompt id under the configured prefix", () => {
		expect(resolveMediaRef({ promptId: "greeting" }, SETTINGS)).toBe("sound:prompts/greeting");
	});

	it("prefers an explicit media ref over a prompt id", () => {
		expect(resolveMediaRef({ promptId: "greeting", media: "tone://ring" }, SETTINGS)).toBe(
			"tone:ring",
		);
	});

	it("is undefined when the node names no audio at all", () => {
		expect(resolveMediaRef({}, SETTINGS)).toBeUndefined();
	});

	it("treats an empty string as no audio", () => {
		expect(resolveMediaRef({ promptId: "   ", media: "" }, SETTINGS)).toBeUndefined();
	});

	it("falls back only when asked to", () => {
		expect(resolveMediaRefOr({}, SETTINGS)).toBe("sound:unavailable");
	});
});

describe("translateMediaRef", () => {
	it("passes a native ARI media URI straight through", () => {
		expect(translateMediaRef("sound:hello", SETTINGS)).toBe("sound:hello");
		expect(translateMediaRef("recording:vm-1", SETTINGS)).toBe("recording:vm-1");
		expect(translateMediaRef("digits:1234", SETTINGS)).toBe("digits:1234");
	});

	it("maps `prompt://` onto the prompt library prefix", () => {
		expect(translateMediaRef("prompt://after-hours", SETTINGS)).toBe("sound:prompts/after-hours");
	});

	it("maps `tone://` onto ARI's tone scheme", () => {
		expect(translateMediaRef("tone://ring", SETTINGS)).toBe("tone:ring");
	});

	it("maps `file://` onto an absolute sound path", () => {
		expect(translateMediaRef("file:///srv/audio/welcome", SETTINGS)).toBe(
			"sound:/srv/audio/welcome",
		);
	});

	it("strips the extension from a file path, so the server picks the cheapest format", () => {
		// Pinning `.wav` on a box that also has `.g722` forces a transcode on every play.
		expect(translateMediaRef("file:///srv/audio/welcome.wav", SETTINGS)).toBe(
			"sound:/srv/audio/welcome",
		);
	});

	it("does not mistake a dot in a directory name for an extension", () => {
		expect(translateMediaRef("file:///srv/audio.v2/welcome", SETTINGS)).toBe(
			"sound:/srv/audio.v2/welcome",
		);
	});

	it("reports a source it cannot serve rather than playing silence", () => {
		expect(translateMediaRef("tts://hello there", SETTINGS)).toBeUndefined();
		expect(translateMediaRef("stream://moh/default", SETTINGS)).toBeUndefined();
		expect(translateMediaRef("https://cdn.example/greeting.mp3", SETTINGS)).toBeUndefined();
	});

	it("is undefined for an empty ref", () => {
		expect(translateMediaRef("   ", SETTINGS)).toBeUndefined();
	});

	it("defaults to the media server's own sound set", () => {
		expect(resolveMediaRef({ promptId: "welcome" })).toBe("sound:welcome");
		expect(DEFAULT_MEDIA_REF_SETTINGS.fallbackMedia).toBe("sound:unavailable");
	});
});

/**
 * `object://` is the compiler's way of saying "this audio is a key in the deployment's object
 * store". ARI has no HTTP media scheme, so the only way it becomes playable is for that store to be
 * mounted inside the media server — which is a deployment fact, not a routing one, and therefore
 * lives in settings rather than in the artifact.
 */
describe("translateMediaRef — object keys", () => {
	it("renders a key under the configured mount", () => {
		expect(translateMediaRef("object://org-1/vm/greeting.wav", MOUNTED)).toBe(
			"sound:/var/lib/optimiq/objects/org-1/vm/greeting",
		);
	});

	it("strips the extension so the media server picks its own best format", () => {
		expect(translateMediaRef("object://a/b.g722", MOUNTED)).toBe(
			"sound:/var/lib/optimiq/objects/a/b",
		);
	});

	it("does not double a slash between the mount and the key", () => {
		expect(
			translateMediaRef("object:///org-1/x.wav", { ...MOUNTED, objectMediaRoot: "/root/" }),
		).toBe("sound:/root/org-1/x");
	});

	it("reports the gap when no store is mounted, rather than inventing a path", () => {
		// The default state of this repo's compose stack. A caller reads `undefined` as "play the
		// configured announcement", which is a fallback somebody can hear — a made-up path is silence.
		expect(translateMediaRef("object://org-1/vm/greeting.wav", SETTINGS)).toBeUndefined();
		expect(translateMediaRef("object://org-1/vm/greeting.wav")).toBeUndefined();
	});

	it("is undefined for an empty key", () => {
		expect(translateMediaRef("object://", MOUNTED)).toBeUndefined();
		expect(translateMediaRef("object://   ", MOUNTED)).toBeUndefined();
	});

	it("refuses a traversing key rather than resolving it", () => {
		// The key travels artifact ← database row ← upload, three hops from something a tenant
		// controls. A `..` this helpfully normalised would be a tenant reading files off the media
		// server by recording themselves a voicemail greeting.
		expect(translateMediaRef("object://../../etc/asterisk/secret.conf", MOUNTED)).toBeUndefined();
		expect(translateMediaRef("object://org-1/../../etc/passwd", MOUNTED)).toBeUndefined();
	});

	it("allows a dot inside a path segment, which is not traversal", () => {
		expect(translateMediaRef("object://org-1/..hidden/x.wav", MOUNTED)).toBe(
			"sound:/var/lib/optimiq/objects/org-1/..hidden/x",
		);
	});
});

/**
 * The table that makes a tenant's own audio playable.
 *
 * Before it, a plan node's prompt ROW id was rendered under the deployment prefix and named a file
 * that has never existed — the uploader mints a different id for the object — so every tenant
 * prompt came back `no such prompt` from `mediad`.
 */
describe("resolveMediaRef — the artifact's prompt table", () => {
	const WITH_TABLE = {
		...MOUNTED,
		prompts: { "row-1": "object://prompts/org-1/file-1.wav" },
	};

	it("resolves a prompt id through the table to the mounted object", () => {
		expect(resolveMediaRef({ promptId: "row-1" }, WITH_TABLE)).toBe(
			"sound:/var/lib/optimiq/objects/prompts/org-1/file-1",
		);
	});

	it("resolves a `prompt://` ref through the same table", () => {
		expect(translateMediaRef("prompt://row-1", WITH_TABLE)).toBe(
			"sound:/var/lib/optimiq/objects/prompts/org-1/file-1",
		);
	});

	it("falls back to the prefix for a bare stem, which is never a row", () => {
		expect(resolveMediaRef({ promptId: "unavailable" }, WITH_TABLE)).toBe(
			"sound:prompts/unavailable",
		);
	});

	it("falls back to the prefix when the object store is not mounted", () => {
		// The refusal, and its reason, stay exactly what they were before the table existed.
		const unmounted = { ...SETTINGS, prompts: WITH_TABLE.prompts };
		expect(resolveMediaRef({ promptId: "row-1" }, unmounted)).toBe("sound:prompts/row-1");
	});
});
