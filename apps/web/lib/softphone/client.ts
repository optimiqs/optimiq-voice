/**
 * The softphone credential client.
 *
 * ## The wire-up seam
 *
 * `GET /api/v1/me/softphone` is a DOCUMENTED-but-not-yet-committed endpoint (see
 * `contracts.ts`'s header for the pieces it composes). It is the self-service home for a browser
 * softphone's credentials: it reads the caller's own extension via `extension_user`, derives the
 * plaintext SIP password the way `provision.service.ts` already does, and adds the sipd WSS URL —
 * the one fact no committed contract exposes today.
 *
 * When the W14 backend lands this route, nothing here changes. Until then, a caller gets a clean
 * `ApiError` (404 / 501) that the softphone surfaces as "not available on this deployment yet"
 * rather than a broken UA — the honest state for a seam whose server half is still being built.
 */

import { apiFetch } from "../api-client";
import type { SoftphoneCredentialsResponse } from "./contracts";

/** The path is a constant so the seam is greppable and the test and the caller cannot disagree. */
export const SOFTPHONE_CREDENTIALS_PATH = "/me/softphone";

/**
 * Fetch the current user's own softphone credentials.
 *
 * Same-origin, cookie-authenticated, no token — the session identifies the user and the endpoint
 * resolves THEIR extension. A user with no extension gets a 404, which the caller reads as "you do
 * not hold an extension" (the gate this whole feature sits behind).
 */
export async function fetchMySoftphoneCredentials(): Promise<SoftphoneCredentialsResponse> {
	return await apiFetch<SoftphoneCredentialsResponse>(SOFTPHONE_CREDENTIALS_PATH);
}
