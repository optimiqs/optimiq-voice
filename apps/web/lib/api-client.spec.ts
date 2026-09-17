import { describe, expect, it } from "bun:test";
import { API_ORIGIN, resolveApiOrigin } from "./api-client";

/**
 * The one place this app is allowed to leave its own origin.
 *
 * Same-origin is the default and the shape every other request uses; the live socket is the single
 * exception, because Next's `rewrites` cannot carry a WebSocket upgrade. These assertions pin the
 * two deployment shapes and the failure mode in between (a mistyped origin).
 */
describe("resolveApiOrigin", () => {
	it("stays on the page's own origin when nothing is configured", () => {
		// The reverse-proxied shape: one origin serves the app and forwards /api/* upgrades included.
		expect(API_ORIGIN).toBe("");
		expect(resolveApiOrigin("http://127.0.0.1:3300", "")).toBe("http://127.0.0.1:3300");
	});

	it("uses the configured API origin when the app and the API are served apart", () => {
		expect(resolveApiOrigin("http://127.0.0.1:3300", "http://127.0.0.1:3200")).toBe(
			"http://127.0.0.1:3200",
		);
	});

	it("drops any path or trailing slash on the configured value", () => {
		expect(resolveApiOrigin("https://app.acme.com", "https://api.acme.com/api/")).toBe(
			"https://api.acme.com",
		);
	});

	it("falls back to same-origin rather than throwing on a value that is not a URL", () => {
		// A typo in an environment variable should degrade to the working default, not blow up inside
		// a socket constructor where the only symptom is a live feed that never connects.
		expect(resolveApiOrigin("https://app.acme.com", "api.acme.com")).toBe("https://app.acme.com");
	});
});
