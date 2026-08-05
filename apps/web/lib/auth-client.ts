import { apiKeyClient } from "@better-auth/api-key/client";
import { adminClient, organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * The better-auth browser client.
 *
 * The plugin list mirrors `packages/auth/src/auth.ts` exactly — a client plugin only adds typed
 * methods for endpoints the server already exposes, so a missing one silently removes a feature
 * and an extra one produces calls that 404:
 *
 * | server plugin        | client plugin        |
 * | -------------------- | -------------------- |
 * | `organization`       | `organizationClient` |
 * | `apiKey`             | `apiKeyClient`       |
 * | `admin`              | `adminClient`        |
 * | `twoFactor`          | `twoFactorClient`    |
 * | `jwt` / `bearer`     | — (no browser surface: the session cookie is the browser's credential) |
 *
 * `organizationClient` is deliberately constructed WITHOUT `ac`/`roles`. Passing them would mean
 * importing `@optimiq-voice/auth`'s access-control builder into the bundle; instead every
 * client-side authorization decision goes through `./permissions`, which is generated from the
 * same registry the server's guard reads. One source of truth, no server code in the browser.
 *
 * `baseURL` is deliberately omitted unless configured: with no origin the client resolves against
 * the page's own, and `next.config.ts` rewrites `/api/*` to `apps/api`. The session cookie is
 * therefore first-party — no CORS preflight, no `SameSite=None`, nothing for a browser to block.
 * (A relative `baseURL` is not an option; better-auth rejects one outright.) Set
 * `NEXT_PUBLIC_AUTH_BASE_URL` only when the frontend is deployed apart from the API, which then
 * also needs that origin in the server's `trustedOrigins` and cross-subdomain cookies configured.
 */
const configuredBaseUrl = process.env.NEXT_PUBLIC_AUTH_BASE_URL;

export const authClient = createAuthClient({
	...(configuredBaseUrl ? { baseURL: configuredBaseUrl } : {}),
	basePath: "/api/auth",
	plugins: [organizationClient(), apiKeyClient(), adminClient(), twoFactorClient()],
});

export const {
	signIn,
	signUp,
	signOut,
	requestPasswordReset,
	resetPassword,
	sendVerificationEmail,
	useSession,
	organization,
	apiKey,
	twoFactor,
} = authClient;

export type AuthSession = typeof authClient.$Infer.Session;
export type AuthUser = AuthSession["user"];
export type ActiveOrganization = typeof authClient.$Infer.ActiveOrganization;
export type OrganizationSummary = typeof authClient.$Infer.Organization;
export type Invitation = typeof authClient.$Infer.Invitation;

/**
 * Normalizes a better-auth failure into a message safe to render.
 *
 * The client resolves rather than throws, so every call site has an `error` branch; funnelling it
 * through one function keeps `undefined` from reaching a toast as "undefined".
 */
export function authErrorMessage(error: { message?: string; code?: string } | null): string {
	if (!error) {
		return "Something went wrong. Try again.";
	}
	return error.message?.trim() || "Something went wrong. Try again.";
}
