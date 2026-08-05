/**
 * Every route the app links to, in one place.
 *
 * `typedRoutes` is on in `next.config.ts`, so a path that does not exist fails the build — but
 * only if it is written as a literal. Centralizing them means a rename is one edit, and the
 * middleware and the client guard cannot disagree about what "public" means.
 */

export const routes = {
	signIn: "/sign-in",
	signUp: "/sign-up",
	forgotPassword: "/forgot-password",
	resetPassword: "/reset-password",
	verifyEmail: "/verify-email",
	twoFactor: "/two-factor",
	acceptInvitation: (invitationId: string) => `/accept-invitation/${invitationId}`,

	overview: "/",
	extensions: "/extensions",
	devices: "/devices",
	numbers: "/numbers",
	trunks: "/trunks",
	routing: "/routing",
	ivr: "/ivr",
	ringGroups: "/ring-groups",
	queues: "/queues",
	voicemail: "/voicemail",
	conferences: "/conferences",
	recordings: "/recordings",
	cdr: "/cdr",
	settings: "/settings",
	members: "/settings/members",
	apiKeys: "/settings/api-keys",
} as const;

/**
 * Prefixes reachable without a session.
 *
 * `/accept-invitation` is here on purpose: the invitation email is opened by someone who may have
 * no account at all, so the page must render and route them to sign-up rather than bounce them to
 * a sign-in screen that loses the invitation id.
 */
export const PUBLIC_ROUTE_PREFIXES: readonly string[] = [
	routes.signIn,
	routes.signUp,
	routes.forgotPassword,
	routes.resetPassword,
	routes.verifyEmail,
	routes.twoFactor,
	"/accept-invitation",
];

export function isPublicRoute(pathname: string): boolean {
	return PUBLIC_ROUTE_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

/** Builds a sign-in URL that returns the user to where they were headed. */
export function signInWithRedirect(pathname: string): string {
	if (pathname === routes.overview || isPublicRoute(pathname)) {
		return routes.signIn;
	}
	return `${routes.signIn}?redirectTo=${encodeURIComponent(pathname)}`;
}

/**
 * Only same-origin absolute paths may be followed after sign-in. Anything else — a protocol,
 * a `//host` shorthand, a backslash Windows treats as a separator — is an open-redirect vector
 * handed to us straight from the query string.
 */
export function safeRedirectTarget(value: string | null | undefined): string {
	if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
		return routes.overview;
	}
	return value;
}
