/**
 * The branding client.
 *
 * ## The wire-up seam
 *
 * Three DOCUMENTED-but-not-yet-committed endpoints, the shape the W14 backend is building toward:
 *   - `GET  /api/v1/branding`          — the active organization's resolved branding (authenticated).
 *   - `PATCH /api/v1/branding`         — update it (gated by the backend's branding grant).
 *   - `GET  /api/v1/branding/by-host`  — the PUBLIC, pre-auth read the login page uses, keyed on the
 *     host the request arrived on, so a white-labelled login shows the tenant's brand with no session.
 *
 * Until the backend lands, an authenticated read simply errors and the app falls back to the
 * built-in brand (`toBranding` + `DEFAULT_BRANDING`), and the public read is called server-side from
 * the auth layout with a try/catch that degrades the same way. Nothing here fabricates data — the
 * fallback is the honest default app, not a fake tenant.
 */

import { apiFetch } from "../api-client";
import { toBranding, type Branding } from "./contracts";

export const BRANDING_PATH = "/branding";
export const BRANDING_BY_HOST_PATH = "/branding/by-host";

interface BrandingEnvelope {
	readonly data: unknown;
}

/** The active organization's branding, resolved through the cascade. */
export async function fetchBranding(): Promise<Branding> {
	const { data } = await apiFetch<BrandingEnvelope>(BRANDING_PATH);
	return toBranding(data);
}

/** Update the active organization's branding with a partial patch. Returns the resolved result. */
export async function updateBranding(patch: Partial<Branding>): Promise<Branding> {
	const { data } = await apiFetch<BrandingEnvelope>(BRANDING_PATH, {
		method: "PATCH",
		body: JSON.stringify(patch),
	});
	return toBranding(data);
}

/**
 * The PUBLIC by-host read, for the pre-auth login page.
 *
 * Called from the server (the auth layout) with an absolute `apiBaseUrl`, because a Next server
 * component has no same-origin relative fetch. No credentials — this is the anonymous surface. Any
 * failure (including the endpoint not existing yet) throws, and the caller degrades to the default
 * brand rather than blocking the login page on branding it may never get.
 */
export async function fetchBrandingByHost(host: string, apiBaseUrl: string): Promise<Branding> {
	const url = new URL(`/api/v1${BRANDING_BY_HOST_PATH}`, apiBaseUrl);
	url.searchParams.set("host", host);
	const response = await fetch(url, { headers: { accept: "application/json" } });
	if (!response.ok) {
		throw new Error(`branding by-host failed: ${response.status}`);
	}
	const payload = (await response.json()) as BrandingEnvelope;
	return toBranding(payload.data);
}
