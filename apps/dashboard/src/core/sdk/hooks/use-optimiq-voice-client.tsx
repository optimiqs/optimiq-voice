import { useState, useCallback, useMemo, useEffect } from "react";
import { Logger } from "~/core/shared/logger";
import { getClient, SDK } from "../client/optimiq-voice.client";
import type { OptimiqVoiceModules } from "../stores/optimiq-voice.interfaces";
import type { Session } from "~/auth/services/sessions/session.interfaces";

/**
 * Custom React hook to initialize and manage the Optimiq Voice client, session state,
 * SDK modules, and related authentication logic.
 *
 * This hook ensures that the client is initialized properly on mount, and
 * allows updates to the session or client in a centralized and controlled way.
 *
 * @returns An object with the client instance, session data, SDK modules, and helper functions.
 */
export const useClient = () => {
  /**
   * State holding the current user session.
   * Includes authentication tokens and user-related metadata.
   */
  const [session, setSession] = useState<Session | null>(null);

  /**
   * State holding the current Optimiq Voice WebClient instance.
   * This client is used to authenticate and interact with the Optimiq Voice API.
   */
  const [client, setClient] = useState<SDK.WebClient | null>(null);

  /**
   * State holding the initialized SDK modules that wrap the Optimiq Voice API.
   * Each module is scoped to the current client and allows domain-specific operations.
   */
  const [sdk, setSdk] = useState<OptimiqVoiceModules | null>(null);

  /**
   * Updates the session with new tokens while preserving other session properties.
   * Avoids unnecessary updates if the session hasn't changed.
   *
   * @param tokens - The new session tokens (e.g. after token refresh).
   */
  const updateSessionTokens = useCallback((tokens: Session) => {
    Logger.debug("[useClient] Updating session tokens...");

    setSession((prev) => {
      const next = { ...prev, ...tokens };
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    });
  }, []);

  /**
   * Replaces the current client instance and reinitializes all SDK modules.
   * This is useful when re-authenticating or refreshing the client with new credentials.
   *
   * @param newClient - A new instance of the Optimiq Voice WebClient.
   */
  const updateClient = useCallback((newClient: SDK.WebClient) => {
    Logger.debug("[useClient] Updating Optimiq Voice client instance...");

    setClient(newClient);

    // Recreate all SDK modules with the new client
    setSdk({
      applications: new SDK.Applications(newClient),
      agents: new SDK.Agents(newClient),
      acls: new SDK.Acls(newClient),
      apiKeys: new SDK.ApiKeys(newClient),
      calls: new SDK.Calls(newClient),
      credentials: new SDK.Credentials(newClient),
      domains: new SDK.Domains(newClient),
      numbers: new SDK.Numbers(newClient),
      secrets: new SDK.Secrets(newClient),
      trunks: new SDK.Trunks(newClient),
      users: new SDK.Users(newClient),
      workspaces: new SDK.Workspaces(newClient)
    });
  }, []);

  /**
   * Determines if the current session is authenticated.
   * Returns true if the session contains a `refreshToken`, which is required for maintaining authentication.
   */
  const isAuthenticated = useMemo(
    () => Boolean(session && "refreshToken" in session),
    [session]
  );

  /**
   * Logs the user out by:
   * - Calling the client's `logout()` method (if available).
   * - Clearing the current session state.
   */
  const logout = useCallback(() => {
    Logger.debug("[useClient] Logging out user...");

    client?.logout();
    setSession(null);
  }, [client]);

  /**
   * Initializes the Optimiq Voice client when the component mounts.
   * Ensures that `client` and `sdk` states are populated early in the app lifecycle.
   */
  useEffect(() => {
    Logger.debug("[useClient] Initializing Optimiq Voice client on mount...");
    const instance = getClient(); // Factory function to get a configured WebClient instance
    updateClient(instance);
  }, [updateClient]);

  /**
   * Exposes the current client, SDK modules, session state, and utility functions
   * for use in application components or providers.
   */
  return {
    client,
    sdk,
    session,
    setSession,
    isAuthenticated,
    updateSessionTokens,
    updateClient,
    logout
  };
};
