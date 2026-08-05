import { describe, expect, it } from "bun:test";
import {
	basicAuthHeader,
	buildEventsUrl,
	buildQuery,
	buildRestUrl,
	normalizeAriBaseUrl,
	redactAriUrl,
} from "./url";

describe("normalizeAriBaseUrl", () => {
	it("appends /ari when the base has no path", () => {
		expect(normalizeAriBaseUrl("http://asterisk:8088")).toBe("http://asterisk:8088/ari");
	});

	it("treats a trailing slash as no path", () => {
		expect(normalizeAriBaseUrl("http://asterisk:8088/")).toBe("http://asterisk:8088/ari");
	});

	it("does not double the /ari suffix", () => {
		expect(normalizeAriBaseUrl("http://asterisk:8088/ari")).toBe("http://asterisk:8088/ari");
		expect(normalizeAriBaseUrl("http://asterisk:8088/ari/")).toBe("http://asterisk:8088/ari");
	});

	it("preserves a reverse-proxy prefix", () => {
		expect(normalizeAriBaseUrl("https://pbx.example.com/media")).toBe(
			"https://pbx.example.com/media/ari",
		);
	});

	it("rejects a non-absolute URL", () => {
		expect(() => normalizeAriBaseUrl("asterisk:8088")).toThrow(TypeError);
	});

	it("rejects a non-http scheme", () => {
		expect(() => normalizeAriBaseUrl("ws://asterisk:8088")).toThrow(TypeError);
	});
});

describe("buildQuery", () => {
	it("returns an empty string when everything is undefined", () => {
		expect(buildQuery({ a: undefined, b: undefined })).toBe("");
	});

	it("omits undefined values but keeps false and zero", () => {
		expect(buildQuery({ a: false, b: 0, c: undefined })).toBe("?a=false&b=0");
	});

	it("repeats an array parameter, which is how ARI expresses a media playlist", () => {
		expect(buildQuery({ media: ["sound:hello", "sound:world"] })).toBe(
			"?media=sound%3Ahello&media=sound%3Aworld",
		);
	});

	it("percent-encodes values", () => {
		expect(buildQuery({ endpoint: "PJSIP/1001@trunk" })).toBe("?endpoint=PJSIP%2F1001%40trunk");
	});
});

describe("buildRestUrl", () => {
	it("joins base, path and query", () => {
		expect(
			buildRestUrl("http://asterisk:8088/ari", "/channels/abc/play", { media: ["sound:hi"] }),
		).toBe("http://asterisk:8088/ari/channels/abc/play?media=sound%3Ahi");
	});

	it("tolerates a path without a leading slash", () => {
		expect(buildRestUrl("http://asterisk:8088/ari", "channels")).toBe(
			"http://asterisk:8088/ari/channels",
		);
	});
});

describe("basicAuthHeader", () => {
	it("encodes username:password", () => {
		expect(basicAuthHeader({ username: "ari", password: "secret" })).toBe(
			`Basic ${Buffer.from("ari:secret").toString("base64")}`,
		);
	});
});

describe("buildEventsUrl", () => {
	it("switches http to ws and keeps the /ari prefix", () => {
		const url = buildEventsUrl({
			normalizedBaseUrl: "http://asterisk:8088/ari",
			app: "optimiq-engine",
			credentials: { username: "ari", password: "secret" },
		});
		expect(url.startsWith("ws://asterisk:8088/ari/events?")).toBe(true);
	});

	it("switches https to wss", () => {
		const url = buildEventsUrl({
			normalizedBaseUrl: "https://pbx.example.com/ari",
			app: "optimiq-engine",
			credentials: { username: "ari", password: "secret" },
		});
		expect(url.startsWith("wss://pbx.example.com/ari/events?")).toBe(true);
	});

	it("defaults subscribeAll to false so one engine does not see every tenant's channels", () => {
		const url = new URL(
			buildEventsUrl({
				normalizedBaseUrl: "http://asterisk:8088/ari",
				app: "optimiq-engine",
				credentials: { username: "ari", password: "secret" },
			}),
		);
		expect(url.searchParams.get("subscribeAll")).toBe("false");
		expect(url.searchParams.get("app")).toBe("optimiq-engine");
		expect(url.searchParams.get("api_key")).toBe("ari:secret");
	});
});

describe("redactAriUrl", () => {
	it("replaces the api_key credential", () => {
		const redacted = redactAriUrl(
			"ws://asterisk:8088/ari/events?app=optimiq-engine&api_key=ari%3Asecret",
		);
		expect(redacted).not.toContain("secret");
		expect(redacted).toContain("api_key=redacted");
		expect(redacted).toContain("app=optimiq-engine");
	});

	it("replaces userinfo credentials", () => {
		expect(redactAriUrl("http://ari:secret@asterisk:8088/ari")).not.toContain("secret");
	});

	it("never throws on an unparseable value", () => {
		expect(redactAriUrl("not a url")).toBe("<invalid-url>");
	});
});
