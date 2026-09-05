import { describe, expect, it } from "bun:test";
import { brandLogoSrc, DEFAULT_BRANDING, type Branding } from "./contracts";

/**
 * `brandLogoSrc` — turning a resolved brand's logo key into something an element can render.
 *
 * The login lockup resolves branding by host and hands both the brand and that host here, so a bare
 * object key becomes the public host-keyed logo route while an already-usable URL is passed through.
 */

function brand(overrides: Partial<Branding> = {}): Branding {
	return { ...DEFAULT_BRANDING, ...overrides };
}

describe("brandLogoSrc", () => {
	it("returns null when there is no logo key", () => {
		expect(brandLogoSrc(brand({ logoObjectKey: null }), "acme.example")).toBe(null);
	});

	it("passes an https URL through unchanged", () => {
		const url = "https://cdn.example/logo.png";
		expect(brandLogoSrc(brand({ logoObjectKey: url }), "acme.example")).toBe(url);
	});

	it("passes a data URI through unchanged", () => {
		const uri = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
		expect(brandLogoSrc(brand({ logoObjectKey: uri }), "acme.example")).toBe(uri);
	});

	it("turns a bare object key into the host-keyed logo route", () => {
		expect(brandLogoSrc(brand({ logoObjectKey: "branding/org/abc.png" }), "acme.example")).toBe(
			"/api/v1/branding/logo?host=acme.example",
		);
	});

	it("url-encodes the host (a port colon and any reserved characters)", () => {
		expect(
			brandLogoSrc(brand({ logoObjectKey: "branding/org/abc.png" }), "acme.example:3000"),
		).toBe("/api/v1/branding/logo?host=acme.example%3A3000");
	});

	it("returns null for a bare key with no host to resolve it (no broken image)", () => {
		expect(brandLogoSrc(brand({ logoObjectKey: "branding/org/abc.png" }))).toBe(null);
		expect(brandLogoSrc(brand({ logoObjectKey: "branding/org/abc.png" }), "  ")).toBe(null);
	});
});
