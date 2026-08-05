import { describe, expect, it } from "bun:test";
import { SESSION_COOKIE_CACHE_VERSION as SERVER_VERSION } from "@optimiq-voice/auth";
import { SESSION_COOKIE_PREFIX, SESSION_COOKIE_CACHE_VERSION } from "./auth-constants";

/**
 * `proxy.ts` looks for the session cookie by prefix. If the server renames it, the proxy stops
 * finding a cookie that is right there and redirects every signed-in user to sign-in — a total
 * outage from a one-word change. This test is the tripwire.
 *
 * The import is test-only: `@optimiq-voice/auth`'s entrypoint pulls in better-auth's server
 * build, which must never reach a browser or proxy bundle.
 */
describe("session cookie constants", () => {
	it("tracks the server's cache version", () => {
		expect(SESSION_COOKIE_CACHE_VERSION).toBe(SERVER_VERSION);
	});

	it("builds the prefix the server configures as advanced.cookiePrefix", () => {
		expect(SESSION_COOKIE_PREFIX).toBe(`optimiq_voice_${SERVER_VERSION}`);
	});
});
