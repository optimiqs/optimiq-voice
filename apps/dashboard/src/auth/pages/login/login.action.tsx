import { redirect } from "react-router";
import { parseLoginError } from "~/auth/helpers/parse-login-error";
import { commitSession, getSessionCookie } from "~/auth/services/sessions/session.server";
import { getClient } from "~/core/sdk/client/optimiq-voice.server";
import type { Route } from "./+types/login.page";

/**
 * Action handler for processing the login form submission.
 *
 * Handles form data extraction, validation, client authentication,
 * session cookie management, and redirects accordingly.
 *
 * @param request - The incoming request object from Remix.
 * @returns A redirect response, either to the home page on success,
 * or back to the login page with an error message on failure.
 */
export async function action({ request }: Route.ActionArgs) {
	/** Initialize the API client for Optimiq Voice authentication. */
	const client = getClient();

	/** Retrieve the session cookie from the incoming request headers. */
	const cookie = await getSessionCookie(request.headers.get("Cookie"));

	try {
		/** Parse the submitted form data. */
		const form = await request.formData();
		const email = form.get("email");
		const password = form.get("password");

		/** Basic validation: ensure both email and password are provided. */
		if (!email || !password) {
			throw new Error("Oops! Missing email or password for login. Please try again.");
		}

		/** Attempt to authenticate using the Optimiq Voice client. */
		await client.login(email.toString(), password.toString());

		/** Store tokens in the session cookie for future authenticated requests. */
		cookie.set("refreshToken", client.getRefreshToken());

		/** Redirect to the home page after successful login, with updated cookies. */
		return redirect("/", {
			headers: {
				"Set-Cookie": await commitSession(cookie),
			},
		});
	} catch (error: any) {
		/** Parse a user-friendly error message from the caught exception. */
		const message = parseLoginError(error);

		/** Redirect back to the login page with an error message in the query string. */
		return redirect(`/auth/login?error=${encodeURIComponent(message)}`, {
			headers: {
				"Set-Cookie": await commitSession(cookie),
			},
		});
	}
}
