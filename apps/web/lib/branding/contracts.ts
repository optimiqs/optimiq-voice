/**
 * The white-label branding contract — mirrored, never imported.
 *
 * ## Aligned to the committed backend
 *
 * `apps/api/src/auth/branding/*` is in the tree, so this mirrors its shapes exactly rather than a
 * guessed one:
 *   - `EffectiveBranding` (the resolved READ) → {@link Branding} below.
 *   - `updateBrandingDto` (the partial WRITE) → the fields `formToBrandingPatch` sends.
 *   - Endpoints: `GET /api/v1/branding`, public `GET /api/v1/branding/by-host?host=`, `PATCH …`.
 *
 * Two things the backend's read shape decides, and this honours:
 *   - The logo is a `logoObjectKey` (object-storage key), NOT a URL. The backend serves the bytes
 *     behind that key at the public, host-keyed `GET /api/v1/branding/logo?host=`, so {@link brandLogoSrc}
 *     turns a bare key into that route (given the host it was resolved for). A value that is already a
 *     usable `https:`/`data:` string is passed through unchanged, and an absent key falls back to the
 *     initial.
 *   - `customDomain` is deliberately NOT in the resolved read (a host maps to exactly one org and is
 *     never inherited), so it is write-only here — see `schemas.ts`.
 *
 * ## Colours are nullable on the web side, on purpose
 *
 * The backend's resolved read always sends a concrete hex (its cascade bottoms out at a code
 * default). The web keeps `BrandColor = string | null` all the same, because the OFFLINE fallback —
 * when the endpoint is unreachable — is `DEFAULT_BRANDING` with `null` colours, which emits no
 * `--role-*` override and leaves the built-in `globals.css` theme exactly as it ships. A brand is an
 * override; the absence of one is the default app, never a blank one.
 */

/** A hex colour like `#2f6fed` (or `#abc`), or `null` to use the built-in theme token. */
export type BrandColor = string | null;

export interface Branding {
	/** The product name shown in the shell, the login lockup and the document title. */
	readonly productName: string;
	/** The object-storage key of the logo, or `null`. See {@link brandLogoSrc} for how it is rendered. */
	readonly logoObjectKey: string | null;
	/** The brand primary — buttons, links, focus ring. */
	readonly primaryColor: BrandColor;
	/** The brand accent — selected states, subtle highlights. */
	readonly accentColor: BrandColor;
	/** Where "contact support" links point, or `null` for the platform default. */
	readonly supportEmail: string | null;
	/** The BCP-47 default language tag (e.g. `en`, `en-GB`). */
	readonly defaultLanguage: string;
	/**
	 * The organization's own login host. Write-only: the resolved read omits it, so this is `null`
	 * except in a form the user is actively editing.
	 */
	readonly customDomain: string | null;
}

/**
 * The unbranded baseline — the app exactly as `globals.css` and the hard-coded lockup ship it.
 *
 * Colours are `null` (NOT the backend's `#111111`/`#2563eb` code defaults) so an unreachable backend
 * degrades to the untouched built-in theme rather than restyling the app from an offline guess. When
 * the backend IS reachable, its resolved colours replace these.
 */
export const DEFAULT_BRANDING: Branding = {
	productName: "Optimiq Voice",
	logoObjectKey: null,
	primaryColor: null,
	accentColor: null,
	supportEmail: null,
	defaultLanguage: "en",
	customDomain: null,
};

/**
 * Narrow an untyped payload (or a partial one) to {@link Branding}, falling back to the baseline
 * field by field. A missing or malformed branding read degrades to the default app.
 */
export function toBranding(data: unknown): Branding {
	if (typeof data !== "object" || data === null) {
		return DEFAULT_BRANDING;
	}
	const record = data as Record<string, unknown>;
	const str = (value: unknown): string | null =>
		typeof value === "string" && value.trim().length > 0 ? value : null;

	return {
		productName: str(record.productName) ?? DEFAULT_BRANDING.productName,
		logoObjectKey: str(record.logoObjectKey),
		primaryColor: str(record.primaryColor),
		accentColor: str(record.accentColor),
		supportEmail: str(record.supportEmail),
		defaultLanguage: str(record.defaultLanguage) ?? DEFAULT_BRANDING.defaultLanguage,
		customDomain: str(record.customDomain),
	};
}

/**
 * The logo source a component can render, or `null` to fall back to the initial.
 *
 * The backend stores a `logoObjectKey` and serves its bytes at the public, host-keyed
 * `GET /api/v1/branding/logo?host=` route. So:
 *   - a value that is ALREADY a usable `https:` URL or a `data:` URI is returned unchanged;
 *   - a bare object key becomes the logo route for the `host` it was resolved by — the same host the
 *     pre-auth `by-host` branding read used, threaded in so the route resolves the SAME tenant's row
 *     server-side (a public caller never names an object, only its host);
 *   - an absent key, or a bare key with no host to resolve it, returns `null` and the caller shows
 *     the product initial.
 *
 * The route is same-origin — `next.config.mjs` rewrites `/api/*` to the API server — so a relative
 * path is correct and needs no origin. A bare key with no host is not turned into a route, because
 * the route would then have no tenant to resolve and would 404; the initial is the honest fallback.
 */
export function brandLogoSrc(brand: Branding, host?: string | null): string | null {
	const key = brand.logoObjectKey;
	if (!key) {
		return null;
	}
	if (key.startsWith("https:") || key.startsWith("data:")) {
		return key;
	}
	const trimmedHost = host?.trim();
	if (!trimmedHost) {
		return null;
	}
	return `/api/v1/branding/logo?host=${encodeURIComponent(trimmedHost)}`;
}
