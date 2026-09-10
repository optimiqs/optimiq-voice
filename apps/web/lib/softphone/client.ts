/**
 * The softphone credential client.
 *
 * `GET /api/v1/me/softphone` is the self-service home for a browser softphone's credentials: it
 * reads the caller's own extension via `extension_user`, derives the plaintext SIP password the way
 * `provision.service.ts` does, and adds the sipd WSS URL.
 *
 * It answers **200 in every arm** — see `SoftphoneCredentialsResponse`. "You hold no extension" is
 * an ordinary fact about most users, not a failure, so it arrives as `{ configured: false, reason }`
 * rather than a 404 the browser logs as an error on every screen. A rejected promise from here is
 * therefore a real failure (401, 500, offline) and nothing else.
 */

import { apiFetch } from "../api-client";
import type { SoftphoneCredentialsResponse } from "./contracts";

/** The path is a constant so the seam is greppable and the test and the caller cannot disagree. */
export const SOFTPHONE_CREDENTIALS_PATH = "/me/softphone";

/**
 * Fetch the current user's own softphone credentials.
 *
 * Same-origin, cookie-authenticated, no token — the session identifies the user and the endpoint
 * resolves THEIR extension. A user with no extension gets `{ configured: false, reason:
 * "no-extension" }` — a 200, and the gate this whole feature sits behind.
 */
export async function fetchMySoftphoneCredentials(): Promise<SoftphoneCredentialsResponse> {
	return await apiFetch<SoftphoneCredentialsResponse>(SOFTPHONE_CREDENTIALS_PATH);
}
