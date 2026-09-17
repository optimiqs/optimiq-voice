import { describe, expect, it } from "bun:test";
import { DEFAULT_BRANDING, type Branding } from "./contracts";
import {
	brandingLogoPreviewSrc,
	BRANDING_LOGO_MAX_UPLOAD_BYTES,
	validateLogoFile,
	type LogoFileFacts,
} from "./logo";

/**
 * The logo upload's client-side rules.
 *
 * These are a courtesy, not a gate — the server sniffs magic bytes — so the tests assert the two
 * things the courtesy has to get right: it never refuses a file the server would accept, and it
 * refuses the two the browser CAN know about (wrong format, over the cap) before the bytes go up.
 */

function brand(overrides: Partial<Branding> = {}): Branding {
	return { ...DEFAULT_BRANDING, ...overrides };
}

function file(overrides: Partial<LogoFileFacts> = {}): LogoFileFacts {
	return { name: "logo.png", size: 1024, type: "image/png", ...overrides };
}

describe("validateLogoFile", () => {
	it("accepts every format the server stores", () => {
		for (const [name, type] of [
			["logo.png", "image/png"],
			["logo.jpg", "image/jpeg"],
			["logo.jpeg", "image/jpeg"],
			["logo.webp", "image/webp"],
			["logo.svg", "image/svg+xml"],
		] as const) {
			expect(validateLogoFile(file({ name, type }))).toBeUndefined();
		}
	});

	it("accepts a file the browser gave no type for, on the extension alone", () => {
		expect(validateLogoFile(file({ name: "mark.svg", type: "" }))).toBeUndefined();
	});

	it("accepts a file with no extension whose declared type is an accepted image", () => {
		expect(validateLogoFile(file({ name: "mark", type: "image/png" }))).toBeUndefined();
	});

	it("refuses a format the server does not store", () => {
		expect(validateLogoFile(file({ name: "mark.gif", type: "image/gif" }))).toBe(
			"Choose a PNG, JPEG, WebP or SVG image.",
		);
	});

	it("refuses a non-image outright", () => {
		expect(validateLogoFile(file({ name: "payload.exe", type: "application/octet-stream" }))).toBe(
			"Choose a PNG, JPEG, WebP or SVG image.",
		);
	});

	it("refuses an empty file", () => {
		expect(validateLogoFile(file({ size: 0 }))).toBe("That file is empty.");
	});

	it("refuses a file over the 2 MiB cap and names both sizes", () => {
		const message = validateLogoFile(file({ size: BRANDING_LOGO_MAX_UPLOAD_BYTES + 1 }));
		expect(message).toContain("2 MB");
		expect(message).toContain("The limit is 2 MB");
	});

	it("accepts a file exactly at the cap", () => {
		expect(validateLogoFile(file({ size: BRANDING_LOGO_MAX_UPLOAD_BYTES }))).toBeUndefined();
	});
});

describe("brandingLogoPreviewSrc", () => {
	it("returns null when no logo is configured", () => {
		expect(brandingLogoPreviewSrc(brand(), "anything")).toBe(null);
	});

	it("versions the session-resolved logo route with the object key", () => {
		expect(
			brandingLogoPreviewSrc(
				brand({ logoObjectKey: "branding/org/abc.png" }),
				"branding/org/abc.png",
			),
		).toBe("/api/v1/branding/logo?v=branding%2Forg%2Fabc.png");
	});

	it("changes the URL when the key changes, so a replaced logo is not served from cache", () => {
		const first = brandingLogoPreviewSrc(brand({ logoObjectKey: "branding/org/a.png" }), "a");
		const second = brandingLogoPreviewSrc(brand({ logoObjectKey: "branding/org/b.png" }), "b");
		expect(first).not.toBe(second);
	});

	it("leaves the route untouched when there is no version token", () => {
		expect(brandingLogoPreviewSrc(brand({ logoObjectKey: "branding/org/abc.png" }), null)).toBe(
			"/api/v1/branding/logo",
		);
	});

	it("never appends a token to a URL somebody else owns", () => {
		const url = "https://cdn.example/logo.png";
		expect(brandingLogoPreviewSrc(brand({ logoObjectKey: url }), "v2")).toBe(url);
	});
});
