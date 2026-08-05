import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useNavigate } from "react-router";
import { Splash } from "~/core/components/general/splash/splash";
import { refreshClientSession } from "~/core/helpers/token-validators";
import { Logger } from "~/core/shared/logger";
import { useClient } from "../hooks/use-optimiq-voice-client";
import type {
  OptimiqVoiceContextValue,
  OptimiqVoiceProviderProps
} from "./optimiq-voice.interfaces";
import type { CookieSession } from "~/auth/services/sessions/session.interfaces";

/**
 * React context used to provide access to the Optimiq Voice client, session,
 * authentication state, and SDK modules throughout the application.
 */
export const OptimiqVoiceContext =
  createContext<OptimiqVoiceContextValue | null>(null);

/**
 * Provider component that initializes the Optimiq Voice client, handles
 * authentication state, and exposes SDK functionality to children components.
 *
 * This component should wrap your application (or parts of it) that require
 * access to Optimiq Voice services.
 *
 * @param children - React children to render inside the context provider.
 * @param initialSession - Initial session passed in from persistent state or server.
 */
export const OptimiqVoiceProvider = ({
  children,
  initialSession
}: OptimiqVoiceProviderProps) => {
  /**
   * Tracks whether the provider has already attempted to authenticate
   * the session. This prevents multiple authentication attempts
   * on initial load.
   */
  const hasAuthenticated = useRef(false);

  /**
   * Tracks whether the provider has completed initialization
   * (e.g. validating the session or setting up the client).
   */
  const [isInitialized, setIsInitialized] = useState(false);

  /**
   * Hook that encapsulates all Optimiq Voice-related logic, such as client setup,
   * SDK initialization, session management, and authentication helpers.
   */
  const {
    sdk,
    client,
    session,
    setSession,
    isAuthenticated,
    logout,
    updateSessionTokens
  } = useClient();

  /**
   * React Router hook used for programmatic navigation (e.g. on session expiry).
   */
  const navigate = useNavigate();

  /**
   * Authenticates the current session by refreshing the access token.
   * If the refresh is successful, updates the internal session state.
   *
   * @param sessionToAuth - The session object to authenticate.
   */
  const authenticate = useCallback(
    async (sessionToAuth: CookieSession) => {
      if (!client) return;

      Logger.debug("[<OptimiqVoiceProvider />] Authenticating session...");
      const updatedSession = await refreshClientSession(sessionToAuth, client);
      Logger.debug(
        "[<OptimiqVoiceProvider />] Session authenticated successfully."
      );
      updateSessionTokens(updatedSession);
    },
    [client, updateSessionTokens]
  );

  /**
   * On initial load or when client/session changes, attempts to validate
   * and refresh the session. If session is missing or invalid, redirects to logout.
   */
  useEffect(() => {
    if (!client || hasAuthenticated.current) return;

    Logger.debug(
      "[<OptimiqVoiceProvider />] Initializing Optimiq Voice client..."
    );

    hasAuthenticated.current = true;

    if (!initialSession) {
      Logger.debug(
        "[<OptimiqVoiceProvider />] No initial session found, initializing without session."
      );
      setIsInitialized(true);
      return;
    }

    authenticate(initialSession)
      .catch(() => navigate("/auth/logout?auto_logout=true"))
      .finally(() => setIsInitialized(true));
  }, [client, session, authenticate]);

  /**
   * Memoized context value to avoid unnecessary re-renders in consuming components.
   */
  const value = useMemo(
    () => ({
      client,
      session,
      setSession,
      logout,
      isAuthenticated,
      sdk,
      authenticate
    }),
    [client, session, logout, isAuthenticated, sdk]
  );

  /**
   * Displays a splash screen while the provider is initializing.
   */
  if (!isInitialized) {
    return <Splash message="Initializing Optimiq Voice services..." />;
  }

  /**
   * Renders the provider and makes Optimiq Voice services available to descendants.
   */
  return (
    <OptimiqVoiceContext.Provider value={value}>
      {children}
    </OptimiqVoiceContext.Provider>
  );
};
