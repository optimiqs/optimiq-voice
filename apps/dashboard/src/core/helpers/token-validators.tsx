import { jwtDecode } from "jwt-decode";
import { Logger } from "../shared/logger";
import type { SDK } from "../sdk/client/optimiq-voice.client";
import type { CookieSession, Session } from "~/auth/services/sessions/session.interfaces";

/**
 * Checks whether a given JWT token has expired.
 *
 * @param token - A JWT string (access or refresh token).
 * @returns `true` if the token is expired or invalid; otherwise `false`.
 */
export function isTokenExpired(token: string): boolean {
	if (!token) return true;

	const decodedToken = jwtDecode(token) as { exp: number };
	const currentTime = Date.now() / 1000;

	Logger.debug("[Optimiq Voice Token Validator] Checking token expiration", {
		token: token.substring(0, 20) + "...",
		exp: decodedToken.exp,
		currentTime,
	});

	return decodedToken.exp < currentTime;
}

/**
 * Attempts to refresh the session using the provided tokens.
 *
 * If the access token is expired but the refresh token is still valid,
 * it performs a refresh using the Optimiq Voice client and returns an updated session.
 * If the refresh token is expired, an error is thrown.
 *
 * @param session - The current user session containing access and refresh tokens.
 * @param client - The Optimiq Voice client instance used to refresh the tokens.
 * @returns A new `Session` object with updated tokens if the access token was expired.
 *          Otherwise, returns the original session.
 * @throws An error if the refresh token is expired.
 */
export async function refreshSession(session: CookieSession, client: SDK.Client) {
	const { refreshToken } = session;

	if (isTokenExpired(refreshToken)) {
		Logger.debug("[Optimiq Voice Refresh Session] Refresh token expired. Refreshing...");
		throw new Error("Oops! Your session has expired.");
	}

	Logger.debug("[Optimiq Voice Refresh Session] Refreshing session with existing refresh token");
	await client.loginWithRefreshToken(refreshToken);

	return client.getRefreshToken();
}

/**
 * Forces a session refresh using the refresh token, regardless of access token status.
 *
 * This function assumes the access token needs to be renewed and attempts to refresh it
 * using the provided refresh token. If the refresh token is expired, an error is thrown.
 *
 * @param session - The current session containing a refresh token.
 * @param client - The Optimiq Voice client instance used for the token refresh.
 * @returns A new `Session` object containing updated access, refresh, and ID tokens.
 * @throws An error if the refresh token is expired.
 */
export async function refreshClientSession(
	session: CookieSession,
	client: SDK.WebClient,
): Promise<Session> {
	const { refreshToken } = session;

	if (isTokenExpired(refreshToken)) {
		Logger.debug("[Optimiq Voice Refresh Client Session] Refresh token expired. Refreshing...");
		throw new Error("Oops! Your session has expired.");
	}

	Logger.debug(
		"[Optimiq Voice Refresh Client Session] Refreshing client session with existing refresh token",
	);
	await client.loginWithRefreshToken(refreshToken);

	return {
		accessToken: client.getAccessToken(),
		refreshToken: client.getRefreshToken(),
		idToken: client.getIdToken(),
	};
}
