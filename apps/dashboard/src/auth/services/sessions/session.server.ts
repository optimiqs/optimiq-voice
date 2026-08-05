import { createCookieSessionStorage, redirect } from "react-router";
import type {
  CookieSession,
  RequiredSessionRequest,
  SessionFlashData,
  SessionRequest
} from "./session.interfaces";

/**
 * Environment variable for securing the session, required for cookie signing.
 */
const SESSION_SECRET = process.env.SERVER_DASHBOARD_SESSION_SECRET as string;

/**
 * Environment variable to determine if the session is secure.
 * In production, this should be set to true to ensure cookies are sent over HTTPS.
 */
const SESSION_IS_SECURE = Boolean(process.env.NODE_ENV === "production");

const {
  getSession: getSessionCookie,
  commitSession,
  destroySession
} = createCookieSessionStorage<CookieSession, SessionFlashData>({
  cookie: {
    name: SESSION_IS_SECURE ? "__Secure-Session" : "__Session",
    /**
     * Prevent client-side JavaScript from accessing the cookie.
     */
    httpOnly: true,
    /**
     * Cookie is available for the entire application.
     */
    path: "/",
    /**
     * Helps prevent CSRF while allowing navigation from external sites.
     *
     */
    sameSite: "lax",
    /**
     * Used to sign and verify the integrity of the cookie.
     * example: "openssl rand -base64 32"
     */
    secrets: [SESSION_SECRET],
    /**
     * Ensures cookies are sent only over HTTPS in production.
     */
    secure: SESSION_IS_SECURE
  }
});

/**
 * Retrieves the session from request headers and determines authentication status.
 *
 * @param headers - Cookie header from the HTTP request
 * @returns An object containing session data (if present) and authentication status
 */
export const getSession = async (
  headers: string | null
): Promise<SessionRequest> => {
  const session = await getSessionCookie(headers);

  const isAuthenticated = Boolean(session.get("refreshToken"));

  if (!isAuthenticated) {
    return { session: null, isAuthenticated };
  }

  const sessionData: CookieSession = {
    refreshToken: String(session.get("refreshToken"))
  };

  return { session: sessionData, isAuthenticated };
};

/**
 * Ensures that a session is present. If not, redirects to the login page.
 *
 * @param headers - Cookie header from the HTTP request
 * @throws Redirects to the login page if no valid session is found
 * @returns A strongly typed session and auth status
 */
export const getRequiredSession = async (
  headers: string | null
): Promise<RequiredSessionRequest> => {
  const { session, ...rest } = await getSession(headers);

  /**
   * Retrieve raw session for cookie destruction in case of redirection.
   */
  const sessionCookie = await getSessionCookie(headers);

  /**
   * If session is missing, redirect to login and clear existing cookie.
   * This is important to prevent unauthorized access to protected routes.
   * The session is destroyed to ensure that the user cannot access any
   * protected resources without re-authenticating.
   */
  if (!session) {
    throw redirect("/auth/login", {
      headers: {
        "Set-Cookie": await destroySession(sessionCookie)
      }
    });
  }

  return { session, ...rest };
};

/**
 * Retrieves the session for unauthenticated users.
 *
 * This function checks if the user is authenticated and redirects them
 * to the home page if they are. It is typically used on login or registration pages
 * to ensure that authenticated users do not access these pages.
 *
 * @param headers - Cookie header from the HTTP request
 * @returns null if the user is unauthenticated
 * @throws Redirects to the home page if the user is authenticated
 */
export const getUnauthenticatedSession = async (
  headers: string | null
): Promise<null> => {
  const { isAuthenticated } = await getSession(headers);

  /**
   * Redirect authenticated users away from login/registration pages.
   */
  if (isAuthenticated) {
    throw redirect("/");
  }

  return null;
};

/**
 * Exports the session management functions for use in other parts of the application.
 *
 * - getSession: Retrieves the session and authentication status.
 * - getRequiredSession: Ensures a valid session is present, redirecting if not.
 * - commitSession: Commits the session to storage.
 * - destroySession: Destroys the session and clears cookies.
 */
export { getSessionCookie, commitSession, destroySession };
