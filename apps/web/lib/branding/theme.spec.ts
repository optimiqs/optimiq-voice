import { describe, expect, it } from "bun:test";
import { DEFAULT_BRANDING, type Branding } from "./contracts";
import { brandThemeCss, deriveBrandRoles, hexToOklch, isHexColor, oklchCss } from "./theme";

/**
 * The theme-token derivation — the pure heart of white-label.
 *
 * A brand colour becomes `--role-*` overrides, and these assertions pin the two things that would
 * silently break a tenant's theme: a wrong colour-space conversion (a blue that comes out green),
 * and an override that leaks where it should not (a `.dark` block emitted when nothing was set, or a
 * null colour producing a variable at all).
 */

function brand(overrides: Partial<Branding> = {}): Branding {
	return { ...DEFAULT_BRANDING, ...overrides };
}

describe("isHexColor", () => {
	it("accepts #rgb and #rrggbb and rejects everything else", () => {
		expect(isHexColor("#2f6fed")).toBe(true);
		expect(isHexColor("  #FFFFFF ")).toBe(true);
		expect(isHexColor("#abc")).toBe(true);
		expect(isHexColor("#ff")).toBe(false);
		expect(isHexColor("blue")).toBe(false);
		expect(isHexColor("2f6fed")).toBe(false);
	});
});

describe("hexToOklch", () => {
	it("converts white to L≈1, C≈0", () => {
		const white = hexToOklch("#ffffff");
		expect(white).not.toBeNull();
		expect(white?.l).toBeCloseTo(1, 2);
		expect(white?.c).toBeCloseTo(0, 2);
	});

	it("converts black to L≈0", () => {
		expect(hexToOklch("#000000")?.l).toBeCloseTo(0, 2);
	});

	it("converts pure red to its known OKLCH", () => {
		// Björn Ottosson's reference: #ff0000 ≈ oklch(0.6279 0.2577 29.23).
		const red = hexToOklch("#ff0000");
		expect(red?.l).toBeCloseTo(0.628, 2);
		expect(red?.c).toBeCloseTo(0.258, 2);
		expect(red?.h).toBeCloseTo(29.23, 0);
	});

	it("expands a three-digit hex like the API accepts", () => {
		// #fff is white, same as #ffffff.
		expect(hexToOklch("#fff")?.l).toBeCloseTo(1, 2);
	});

	it("returns null for a malformed colour", () => {
		expect(hexToOklch("#ff")).toBeNull();
		expect(hexToOklch("nope")).toBeNull();
	});
});

describe("oklchCss", () => {
	it("renders opaque and alpha forms", () => {
		expect(oklchCss({ l: 0.52, c: 0.17, h: 250 })).toBe("oklch(0.52 0.17 250)");
		expect(oklchCss({ l: 0.58, c: 0.17, h: 250, alpha: 0.22 })).toBe("oklch(0.58 0.17 250 / 0.22)");
	});
});

describe("deriveBrandRoles", () => {
	it("emits no overrides for the default (all-null) brand", () => {
		const { light, dark } = deriveBrandRoles(DEFAULT_BRANDING);
		expect(Object.keys(light)).toHaveLength(0);
		expect(Object.keys(dark)).toHaveLength(0);
	});

	it("sets primary, hover, foreground and ring for a primary colour", () => {
		const { light, dark } = deriveBrandRoles(brand({ primaryColor: "#2f6fed" }));
		expect(light["--role-primary"]).toMatch(/^oklch\(/u);
		expect(light["--role-primary-hover"]).toBeDefined();
		expect(light["--role-primary-foreground"]).toBeDefined();
		expect(light["--role-ring"]).toBeDefined();
		// Dark primary is a step lighter than light primary — the palette's own convention.
		expect(dark["--role-primary"]).toBeDefined();
	});

	it("chooses a white foreground on a dark primary and a dark one on a light primary", () => {
		const dark = deriveBrandRoles(brand({ primaryColor: "#12213f" })); // very dark blue
		expect(dark.light["--role-primary-foreground"]).toBe("oklch(1 0 0)");

		const light = deriveBrandRoles(brand({ primaryColor: "#e8f0ff" })); // very light blue
		expect(light.light["--role-primary-foreground"]).not.toBe("oklch(1 0 0)");
	});

	it("derives the accent from the primary hue when no accent is set", () => {
		const { light } = deriveBrandRoles(brand({ primaryColor: "#2f6fed" }));
		expect(light["--role-accent"]).toBeDefined();
		expect(light["--role-accent-foreground"]).toBeDefined();
	});

	it("uses an explicit accent colour when given", () => {
		const withAccent = deriveBrandRoles(brand({ primaryColor: "#2f6fed", accentColor: "#e11d48" }));
		const primaryOnly = deriveBrandRoles(brand({ primaryColor: "#2f6fed" }));
		expect(withAccent.light["--role-accent"]).not.toBe(primaryOnly.light["--role-accent"]);
	});

	it("emits a translucent accent wash in dark mode", () => {
		const { dark } = deriveBrandRoles(brand({ accentColor: "#2f6fed" }));
		expect(dark["--role-accent"]).toMatch(/ \/ 0\.22\)$/u);
	});
});

describe("brandThemeCss", () => {
	it("is empty for the default brand, so the default deployment injects nothing", () => {
		expect(brandThemeCss(DEFAULT_BRANDING)).toBe("");
	});

	it("emits a :root block and a .dark block for a branded org", () => {
		const css = brandThemeCss(brand({ primaryColor: "#2f6fed" }));
		expect(css).toContain(":root {");
		expect(css).toContain(".dark {");
		expect(css).toContain("--role-primary:");
	});
});
