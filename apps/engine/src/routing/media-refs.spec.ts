import { describe, expect, it } from "bun:test";
import {
	DEFAULT_MEDIA_REF_SETTINGS,
	resolveMediaRef,
	resolveMediaRefOr,
	translateMediaRef,
} from "./media-refs";

const SETTINGS = { promptPrefix: "sound:prompts/", fallbackMedia: "sound:unavailable" };

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
