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
	parkLots: "/park-lots",
	recordings: "/recordings",
	cdr: "/cdr",
	settings: "/settings",
	members: "/settings/members",
	apiKeys: "/settings/api-keys",

	/**
	 * Detail views, for the four entities that own a child collection.
	 *
	 * Everything else is edited in a dialog over its list, because everything else is one flat row
	 * — a route for a form with no sub-resource is a page load the user pays for and a back button
	 * that leaves the list. An IVR menu's options, a ring group's members, a time condition's rules
	 * and a queue's tiers are collections with their own targets, which a dialog inside a dialog
	 * cannot hold.
	 *
	 * They are nested under their list's path so `getPagePermissions` inherits the parent's
	 * requirement by ancestry — `/ivr/<id>` needs `ivr.read` without `PAGE_PERMISSIONS` naming it.
	 */
	ivrMenu: (id: string) => `/ivr/${id}`,
	ringGroup: (id: string) => `/ring-groups/${id}`,
	queue: (id: string) => `/queues/${id}`,
	timeCondition: (id: string) => `/routing/time-conditions/${id}`,
} as const;

/**
 * The Queues page's two sections.
 *
 * Agents are a TOP-LEVEL resource (`/api/v1/queue-agents`) because `queue_agent` carries no queue —
 * one agent serves several queues through a tier. So they cannot live on a queue's own page, and a
 * second sidebar entry called "Queue agents" would be a second way to say "queues". One page with
 * the section in the URL keeps both views linkable, and both are gated by `queues.read`.
 */
export const QUEUE_TABS = ["queues", "agents"] as const;

export type QueueTab = (typeof QUEUE_TABS)[number];

export function queueTabHref(tab: QueueTab): string {
	return tab === "queues" ? routes.queues : `${routes.queues}?tab=${tab}`;
}

/**
 * The Routing page's sections, as query state.
 *
 * Inbound routes, outbound routes, time conditions and feature codes are four views of ONE
 * subject — how a call is routed — and all four are gated by `routes.*`. Four sidebar entries
 * would be four ways to say "routing"; four tabs on one page with the section in the URL keeps
 * every view linkable without inventing four routes and four permission entries that would all
 * have to say the same thing.
 */
export const ROUTING_TABS = [
	"inbound",
	"outbound",
	"time-conditions",
	"feature-codes",
	"tools",
] as const;

export type RoutingTab = (typeof ROUTING_TABS)[number];

export function routingTabHref(tab: RoutingTab): string {
	return tab === "inbound" ? routes.routing : `${routes.routing}?tab=${tab}`;
}

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
