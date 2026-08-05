import { redirect } from "react-router";
import {
  destroySession,
  getSessionCookie
} from "~/auth/services/sessions/session.server";
import type { Route } from "./+types/logout.page";

/**
 * Logout action.
 * Handles user logout by:
 *  - Retrieving the current session cookie
 *  - Destroying the session on the server
 *  - Redirecting the user to the login page
 *
 * @param request - The incoming request object from Remix.
 * @returns A redirect response to the login page with the session cookie cleared.
 */
export async function action({ request }: Route.ActionArgs) {
  /** Extract the cookie header from the incoming request. */
  const headers = request.headers.get("Cookie");

  /** Retrieve the current session cookie using the cookie header. */
  const sessionCookie = await getSessionCookie(headers);

  /** Destroy the session on the server and return a redirect to the login page. */
  return redirect("/auth/login", {
    headers: {
      "Set-Cookie": await destroySession(sessionCookie)
    }
  });
}
