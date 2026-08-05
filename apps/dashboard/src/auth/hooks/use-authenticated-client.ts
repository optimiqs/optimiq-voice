import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useOptimiqVoice } from "~/core/sdk/hooks/use-optimiq-voice";
import { Logger } from "~/core/shared/logger";
import type { CookieSession } from "../services/sessions/session.interfaces";

/**
 * Custom hook to authenticate the Optimiq Voice client using a provided session.
 *
 * If an initial session is available and no ID token is present in the client,
 * the hook attempts to authenticate the client using the session.
 *
 * @param {CookieSession} [initialSession] - Optional session containing authentication credentials.
 * @returns {OptimiqVoiceClient} - The authenticated Optimiq Voice client instance.
 */
export const useAuthenticatedClient = (initialSession?: CookieSession) => {
	/** Retrieves the Optimiq Voice client and the authenticate method from the hook. */
	const { client, authenticate } = useOptimiqVoice();

	/** Navigation hook to redirect the user if authentication fails. */
	const navigate = useNavigate();

	/**
	 * Attempts to authenticate the client using the initial session if no ID token is present.
	 *
	 * This runs only when the initial session or client changes, ensuring that
	 * the client is authenticated when a valid session is provided.
	 */
	useEffect(() => {
		if (initialSession && !client.getIdToken()) {
			authenticate(initialSession)
				.then(() => {
					Logger.debug(
						"[useAuthenticatedClient()] Client authenticated successfully with initial session.",
					);
				})
				.catch((error) => {
					Logger.error(
						"[useAuthenticatedClient()] Failed to authenticate client with initial session:",
						error,
					);

					navigate("/auth/logout?auto_logout=true");
				});
		}
	}, [client, initialSession, authenticate]);

	/** Returns the authenticated (or unauthenticated) Optimiq Voice client instance. */
	return client;
};
