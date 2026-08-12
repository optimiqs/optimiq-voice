/**
 * Turning a brand colour into theme tokens — the pure, unit-tested seam.
 *
 * `globals.css` is a two-layer token system: a raw OKLCH palette, then semantic `--role-*` roles,
 * then Tailwind `--color-*` aliases. Components only ever touch the roles. So a tenant brand is
 * applied at exactly ONE layer — the `--role-*` variables — and every `bg-primary`, `text-accent`
 * and focus ring downstream picks it up for free, in both light and dark, with no component change.
 *
 * This module converts a hex colour to OKLCH (the space the whole palette is authored in, so a
 * derived value sits in the same perceptual world as the built-ins) and derives the small set of
 * roles a brand governs. It is pure and deterministic: same brand in, same CSS out, which is what
 * makes the derivation testable without a browser.
 */

import type { BrandColor } from "./contracts";

/** Just the fields the theme layer reads — so a full `Branding` OR a partial patch both fit. */
export interface BrandColors {
	readonly primaryColor?: BrandColor;
	readonly accentColor?: BrandColor;
}

export interface Oklch {
	/** Perceptual lightness, 0–1. */
	readonly l: number;
	/** Chroma, 0–~0.4. */
	readonly c: number;
	/** Hue in degrees, 0–360. */
	readonly h: number;
	/** Alpha 0–1; omitted renders as fully opaque. */
	readonly alpha?: number;
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u;

/**
 * True for a `#rgb` or `#rrggbb` string. Exported so the form schema and the theme agree on what is
 * valid, and matched to `apps/api`'s `updateBrandingDto`, which accepts both spellings.
 */
export function isHexColor(value: string): boolean {
	return HEX.test(value.trim());
}

/** `#abc` -> `aabbcc`; `#aabbcc` -> `aabbcc`. Returns null for anything else. */
function normalizeHex(value: string): string | null {
	const match = HEX.exec(value.trim());
	if (!match?.[1]) {
		return null;
	}
	const digits = match[1];
	return digits.length === 3
		? digits
				.split("")
				.map((d) => d + d)
				.join("")
		: digits;
}

function srgbToLinear(channel: number): number {
	return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function round(value: number, places: number): number {
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
}

/**
 * sRGB hex → OKLCH, using Björn Ottosson's OKLab matrices.
 *
 * Returns `null` for anything that is not a `#rrggbb` string, so a malformed stored value produces
 * no override rather than a broken one.
 */
export function hexToOklch(hex: string): Oklch | null {
	const digits = normalizeHex(hex);
	if (!digits) {
		return null;
	}
	const int = Number.parseInt(digits, 16);
	const r = srgbToLinear(((int >> 16) & 0xff) / 255);
	const g = srgbToLinear(((int >> 8) & 0xff) / 255);
	const b = srgbToLinear((int & 0xff) / 255);

	const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
	const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
	const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

	const l_ = Math.cbrt(l);
	const m_ = Math.cbrt(m);
	const s_ = Math.cbrt(s);

	const okL = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
	const okA = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
	const okB = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

	const c = Math.hypot(okA, okB);
	let h = (Math.atan2(okB, okA) * 180) / Math.PI;
	if (h < 0) {
		h += 360;
	}

	return { l: round(okL, 4), c: round(c, 4), h: round(h, 2) };
}

/** `{l,c,h,alpha?}` → the CSS `oklch(...)` string the token stack expects. */
export function oklchCss(color: Oklch): string {
	const base = `oklch(${round(color.l, 4)} ${round(color.c, 4)} ${round(color.h, 2)}`;
	return color.alpha === undefined ? `${base})` : `${base} / ${round(color.alpha, 3)})`;
}

/** Lighter/darker while holding hue and chroma — the palette's own way of making a hover or a ring. */
function shiftL(color: Oklch, delta: number): Oklch {
	return { ...color, l: clamp(color.l + delta, 0, 1) };
}

/**
 * A readable foreground on a solid brand fill.
 *
 * OKLCH lightness is perceptual, so a single threshold is a fair contrast heuristic: a fill lighter
 * than ~0.62 reads better with near-black text, darker with white. Matches how the built-in
 * `--role-primary-foreground` is white on the default blue.
 */
function foregroundFor(color: Oklch): Oklch {
	return color.l > 0.62 ? { l: 0.2, c: 0.016, h: color.h } : { l: 1, c: 0, h: 0 };
}

/** The `--role-*` overrides for one theme, as `{ variable: value }`. */
export type RoleOverrides = Readonly<Record<string, string>>;

export interface BrandRoleTokens {
	readonly light: RoleOverrides;
	readonly dark: RoleOverrides;
}

/**
 * Derive the primary/accent/ring roles from a brand.
 *
 * Only the colours an organization actually set produce overrides; a `null` colour yields none, so
 * the built-in token stands. The accent, when not set explicitly, derives from the primary hue so a
 * one-colour brand still looks coherent rather than pairing a custom primary with the stock accent.
 *
 * The light/dark split mirrors `globals.css`: primary is a touch lighter in dark, the accent is a
 * pale tint in light and a translucent wash in dark, and the ring tracks the primary.
 */
export function deriveBrandRoles(brand: BrandColors): BrandRoleTokens {
	const light: Record<string, string> = {};
	const dark: Record<string, string> = {};

	const primary = brand.primaryColor ? hexToOklch(brand.primaryColor) : null;
	if (primary) {
		const primaryFg = foregroundFor(primary);
		// Light: the picked colour is the fill; hover a step darker; ring a step lighter.
		light["--role-primary"] = oklchCss(primary);
		light["--role-primary-hover"] = oklchCss(shiftL(primary, -0.07));
		light["--role-primary-foreground"] = oklchCss(primaryFg);
		light["--role-ring"] = oklchCss(shiftL(primary, 0.06));
		// Dark: a step lighter so it holds up on the dark canvas, hover back at the base.
		dark["--role-primary"] = oklchCss(shiftL(primary, 0.06));
		dark["--role-primary-hover"] = oklchCss(primary);
		dark["--role-primary-foreground"] = oklchCss(primaryFg);
		dark["--role-ring"] = oklchCss(shiftL(primary, 0.06));
	}

	// Accent source: the explicit accent, else the primary hue, else nothing.
	const accentSource = brand.accentColor ? hexToOklch(brand.accentColor) : primary;
	if (accentSource) {
		const hue = accentSource.h;
		// Light: a pale tint and a dark, readable foreground on it — mirrors brand-100 / brand-700.
		light["--role-accent"] = oklchCss({ l: 0.93, c: Math.min(accentSource.c, 0.05), h: hue });
		light["--role-accent-foreground"] = oklchCss({
			l: 0.45,
			c: Math.min(accentSource.c, 0.15),
			h: hue,
		});
		// Dark: a translucent wash of the accent, and a light foreground — mirrors globals.css.
		dark["--role-accent"] = oklchCss({
			l: 0.58,
			c: Math.min(accentSource.c, 0.17),
			h: hue,
			alpha: 0.22,
		});
		dark["--role-accent-foreground"] = oklchCss({
			l: 0.78,
			c: Math.min(accentSource.c, 0.11),
			h: hue,
		});
	}

	return { light, dark };
}

function block(selector: string, overrides: RoleOverrides): string {
	const entries = Object.entries(overrides);
	if (entries.length === 0) {
		return "";
	}
	const body = entries.map(([name, value]) => `${name}: ${value};`).join(" ");
	return `${selector} { ${body} }`;
}

/**
 * The complete CSS a branded organization injects — a `:root` block for light and a `.dark` block
 * for dark, each overriding only the roles the brand set. Empty string when the brand overrides
 * nothing, so the default deployment injects no style at all.
 *
 * The `.dark` selector matches `next-themes`' class on `<html>`, exactly like `globals.css`.
 */
export function brandThemeCss(brand: BrandColors): string {
	const { light, dark } = deriveBrandRoles(brand);
	return [block(":root", light), block(".dark", dark)].filter(Boolean).join("\n");
}
